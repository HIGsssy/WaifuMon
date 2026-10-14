/**
 * CaptureService (Milestone 2B) — the 3-attempt capture state machine.
 *
 * One transaction per attempt with a `SELECT … FOR UPDATE` on the encounter
 * row: it serializes concurrent charm clicks so exactly one attempt consumes
 * an item and mutates state. The inventory service's conditional decrement +
 * CHECK (quantity >= 0) is a second line of defense against double-spend.
 *
 * Capture math (plan §9 + Milestone 5D + the shop/items expansion):
 *   guaranteed  → chance = 1.0 (Mythic Contract bypasses the formula)
 *   otherwise   → chance = clamp(
 *                   baseCaptureRate × captureModifier
 *                     + buddyAffinityModifier
 *                     + captureBonusModifier
 *                     + itemCaptureBonus,
 *                   min, max)
 * `baseCaptureRate` uses the species override when set, otherwise the
 * rarity default from content/tables.json. The buddy-affinity term is flat,
 * additive, scaled by the *buddy's* rarity, and 0 whenever there is no active
 * buddy or the matchup isn't strong. `captureBonusModifier` is the active
 * consumable buff (Microdose); one charge is spent per *resolved* attempt,
 * inside this same transaction and under the encounter row lock — so a
 * double-clicked charm can never spend two charges for one attempt.
 * `itemCaptureBonus` is the committed item's own flat bonus (Fluffy Cuffs,
 * Shibari Rope) — additive rather than multiplicative, and gated by the
 * item's content-declared `capture_rarities`.
 * Event modifiers remain reserved.
 *
 * Encounter-time item selection (see `encounters.selected_item_id`) rides the
 * same machinery: selecting costs nothing, and the authoritative attempt
 * re-reads the selection *under the encounter row lock* rather than trusting
 * the interaction that triggered it.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  captureAttempts,
  encounters,
  items,
  players,
  playerWaifus,
  species,
  type CaptureAttemptRow,
  type EncounterRow,
  type ItemRow,
  type PlayerWaifuRow,
  type SpeciesRow,
} from '../../db/schema';
import {
  CaptureGrantKeyConflictError,
  CaptureItemNotEligibleError,
  EffectAlreadyAtMaxChargesError,
  EncounterAlreadyResolvedError,
  EncounterExpiredError,
  EncounterNotFoundError,
  EncounterStaleError,
  InsufficientItemsError,
  ItemNotFoundError,
  ItemNotUsableError,
  NoAttemptsRemainingError,
  NoCaptureItemSelectedError,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { defaultRng, type Rng } from '../../shared/random';
import type { CaptureConfig } from './captureMath';
import {
  computeCaptureChance,
  describeCaptureChance,
  type CaptureChanceBreakdown,
} from './captureMath';
import { normalizeAffinity, resolveBuddyAffinity, type AffinityMatchup } from './affinityMath';
import type { InventoryService } from '../inventory/inventoryService';
import type { AppearanceService, AppearanceUnlockRef } from '../appearance/appearanceService';
import type { CollectionService } from '../collection/collectionService';
import type {
  LevelUpEvent,
  ProgressionService,
} from '../progression/progressionService';
import type {
  BuddyAffinityConfig,
  ProgressionConfig,
  SeductivePowerConfig,
} from '../content/schemas';
import { rollBaseSeductivePower } from '../power/seductivePower';
import type { PlayerEffectsService } from '../effects/playerEffectsService';
import {
  speciesRefFromRow,
  type BuddyBonusService,
} from '../buddyBonus/buddyBonusService';
import {
  appliedBuddyBonus,
  buddyBonusPercent as percentOfBuddyBonus,
  type AppliedBuddyBonus,
  type BuddyBonus,
} from '../buddyBonus/buddyBonusEffects';
import type { ItemUseResult, ItemUseService } from '../items/itemUseService';
import {
  encounterItemKind,
  isDirectCaptureItem,
  isEncounterConsumable,
  type EncounterItemKind,
} from '../items/encounterUse';
import { CaptureBonusEffectSchema } from '../content/schemas';
import type { QuestService } from '../quests/questService';
import type { Affinity, Rarity } from '../../db/schema';

export type CaptureOutcome = 'success' | 'failure' | 'escape';

/**
 * Buddy-affinity read for one attempt. Always present so callers (UI, logs)
 * can render a consistent line; `buddyWaifuId` is null when the player had no
 * active buddy, in which case the matchup is neutral and the modifier is 0.
 */
export interface CaptureAffinityInfo {
  buddyWaifuId: number | null;
  buddyAffinity: Affinity | null;
  encounterAffinity: Affinity;
  matchup: AffinityMatchup;
  buddyAffinityModifier: number;
  finalChance: number;
  /**
   * The buddy's *content-authored* bonus, when it applied to this attempt —
   * a separate thing from the affinity matchup above, and `null` whenever the
   * bonus is a different effect or its target did not match this species.
   */
  buddyBonus: AppliedBuddyBonus | null;
}

/**
 * Consumable capture buff applied to one attempt. Present only when a buff was
 * actually active *and* eligible to be spent — guaranteed captures bypass the
 * chance formula entirely, so they deliberately leave charges untouched
 * (spending one would buy the player nothing).
 */
export interface CaptureEffectInfo {
  sourceItemSlug: string;
  captureBonusModifier: number;
  chargesBefore: number;
  chargesRemaining: number;
  /** True when this attempt spent the final charge and the buff ended. */
  cleared: boolean;
}

/**
 * Whether a capture item may be committed against a given encounter rarity.
 *
 * Eligibility lives in `items.capture_rarities` (null = every rarity), so the
 * rule set is content, not code: adding a rarity-restricted item is a JSON
 * edit, and this function is the single place both the selector and the
 * authoritative attempt ask.
 */
export function isCaptureItemEligible(item: ItemRow, rarity: string): boolean {
  const allowed = item.captureRarities;
  if (allowed == null || allowed.length === 0) return true;
  return allowed.includes(rarity);
}

/**
 * A read-only capture-chance quote for one encounter.
 *
 * Exists so the Discord layer never re-implements the formula: the "6% → 21%"
 * line and the number the server actually rolls against come out of the same
 * {@link computeCaptureChance} call with the same inputs. The only difference
 * between this and a real attempt is that nothing is locked and nothing is
 * spent — so a quote can be marginally stale, and the attempt re-derives it.
 */
export interface CaptureQuote {
  encounter: EncounterRow;
  species: SpeciesRow;
  /** The item this quote is for, or null for the no-item baseline. */
  item: ItemRow | null;
  /** True when the item guarantees capture (the formula is bypassed). */
  guaranteed: boolean;
  /** Chance with the item applied. 1 when `guaranteed`. */
  chance: number;
  /**
   * Chance with **no** direct capture item — the charm multiplier neutral at
   * 1, persistent effects still counted. This is the "before" half of the
   * before → after line the encounter screen shows.
   */
  baselineChance: number;
  /** Whether the item may be used against this encounter's rarity. */
  eligible: boolean;
  buddyAffinityModifier: number;
  captureBonusModifier: number;
  /** Active Buddy Bonus percentage folded into `chance`. 0 when none applies. */
  buddyBonusPercent: number;
  /**
   * The bonus behind that percentage, for the encounter screen. `null`
   * whenever none applies — including a targeted bonus this species does not
   * match — so the UI never has to test a target itself.
   */
  buddyBonus: AppliedBuddyBonus | null;
  itemCaptureBonus: number;
}

/**
 * One row of the encounter item selector.
 *
 * Both kinds live in one list because the player is making one decision —
 * "what do I do about her" — and splitting them across two controls would make
 * the cheaper option harder to find. They are labelled apart rather than
 * separated: `direct` is a plan, `consumable` is a purchase.
 */
export interface EncounterItemOption {
  item: ItemRow;
  quantity: number;
  kind: EncounterItemKind;
  /**
   * For a `direct` item, the chance if it were committed. For a `consumable`,
   * the chance as things stand *right now* — the projection of what activating
   * it would do is deliberately not computed here, because the honest
   * before → after is two real quotes taken either side of the activation.
   */
  quote: CaptureQuote;
  /** `consumable` only: charges live right now, and the configured ceiling. */
  charges?: { remaining: number; max: number } | undefined;
}

/** The outcome of activating a persistent consumable during an encounter. */
export interface EncounterConsumableResult {
  /** Unchanged and still active — activation never resolves an encounter. */
  encounter: EncounterRow;
  species: SpeciesRow;
  item: ItemRow;
  /** Verbatim from the authoritative item-use service. */
  use: ItemUseResult;
  /** Chance before activation and after it, both from {@link CaptureQuote}. */
  quoteBefore: CaptureQuote;
  quoteAfter: CaptureQuote;
}

export interface UseEncounterConsumableOptions {
  now?: Date;
  /** Same stale guard the Capture button uses. */
  expectedAttemptCount?: number;
  /**
   * Charges the interaction was rendered against.
   *
   * The attempt count alone cannot guard this action — activating a consumable
   * does not advance it, so two clicks of one button would carry the same
   * guard and both succeed. Charges *do* change (they rise to the configured
   * maximum), so pairing them makes the rendered state a version token: the
   * second click of a stale button no longer matches and is refused.
   */
  expectedCharges?: number;
}

export interface CaptureAttemptResult {
  outcome: CaptureOutcome;
  attempt: CaptureAttemptRow;
  encounter: EncounterRow;
  species: SpeciesRow;
  item: ItemRow;
  attemptsRemaining: number;
  newWaifu: PlayerWaifuRow | null;
  /** True when the player already owned this species before this capture. */
  isDuplicate: boolean;
  /** XP granted for this attempt (2 on fail, rarity value + optional dex bonus on success). */
  xpGranted: number;
  levelUps: LevelUpEvent[];
  /** True when this success was the first time the player caught this species. */
  isNewDex: boolean;
  /** Buddy-affinity read applied to this attempt (Milestone 5D). */
  /** Set only when `player_xp_gain` actually raised `xpGranted`. */
  xpBonus: AppliedBuddyBonus | null;
  affinity: CaptureAffinityInfo;
  /** Consumable capture buff spent on this attempt; null when none applied. */
  effect: CaptureEffectInfo | null;
  /**
   * Flat bonus the committed item itself contributed (0 for charms, which are
   * multiplicative, and for guaranteed captures, which bypass the formula).
   */
  itemCaptureBonus: number;
  /**
   * Cosmetic appearances the new copy starts with, acknowledged so they never
   * re-notify. Presentation only — the default `owned` entry is deliberately
   * filtered out of this list, so it is normally empty and only fills when a
   * species ships artwork a brand-new copy already qualifies for.
   */
  newAppearances: AppearanceUnlockRef[];
}

/** Options for {@link CaptureService.attemptCapture}. */
export interface AttemptCaptureOptions {
  now?: Date;
  /**
   * Optimistic-concurrency guard: the `attempt_count` the interaction was
   * rendered against. When supplied and it no longer matches the locked row,
   * the attempt is refused with `EncounterStaleError` — which is what makes a
   * double-clicked Capture button resolve exactly once instead of burning a
   * second item. Omitted (the pre-existing callers, and tests) means no check.
   */
  expectedAttemptCount?: number;
}

/**
 * A capture-chance quote for a species, with no encounter row behind it.
 * Everything {@link CaptureQuote} carries except the encounter.
 */
export type SpeciesCaptureQuote = Omit<CaptureQuote, 'encounter'>;

/**
 * Which Buddy a quote or attempt reads, when it is not the live one.
 *
 * A dungeon pins its fighter at the start of a run, and that copy's species is
 * what its affinity matchup and Buddy Bonus come from for the whole run — the
 * `players.buddy_waifu_id` pointer is not read, and is not healed. The copy is
 * identified by species: a pinned copy released mid-run still counts, exactly
 * as it still fights.
 *
 * The three states are distinct on purpose: `undefined` is the live Buddy
 * (every hunt), `null` is "no Buddy at all", and a value is the pinned copy.
 */
export interface CaptureBuddyOverride {
  /** The pinned owned copy. Reported back in {@link CaptureAffinityInfo}. */
  waifuId: number;
  speciesSlug: string;
  /**
   * What the run froze about her when it started: her affinity and rarity
   * (the matchup wheel) and her species' whole authored Buddy Bonus (the
   * `capture_chance` and `player_xp_gain` effects). Present, nothing about
   * her is read from current content, so a retune or a reload mid-run changes
   * nothing. Absent — a run started before this was frozen — her species is
   * read from current content by slug instead. Either way the live Buddy
   * pointer is not consulted.
   */
  pinned?: CapturePinnedBuddy | undefined;
}

/** The frozen part of a {@link CaptureBuddyOverride}. JSON-safe: it is stored on the run. */
export interface CapturePinnedBuddy {
  affinity: string;
  rarity: string;
  bonus: BuddyBonus | null;
}

/** Where a granted copy came from, for copies that are not hunted captures. */
export interface CaptureProvenance {
  /** Stored in `player_waifus.acquired_via`. */
  acquiredVia?: string | null | undefined;
  /**
   * Stored in `player_waifus.grant_key`, which is unique when present. A key
   * that already exists is never silently granted a second copy.
   */
  grantKey?: string | null | undefined;
}

/** What an attempt decided, before anything about its outcome is written. */
export interface CaptureAttemptDecision {
  outcome: CaptureOutcome;
  success: boolean;
  guaranteed: boolean;
  chance: number;
  roll: number;
}

export interface ResolveCaptureAttemptInput {
  playerId: number;
  species: SpeciesRow;
  /** The charm being committed. Eligibility is judged here, not trusted. */
  item: ItemRow;
  /** True when a miss ends the encounter (`escape` rather than `failure`). */
  finalAttempt: boolean;
  now?: Date | undefined;
  /**
   * The decided chance roll, uniform in [0, 1). Omitted, one is drawn from
   * {@link rng} — which is what a hunt does. Ignored by a guaranteed capture,
   * which records a roll of 0 as it always has.
   */
  roll?: number | undefined;
  /**
   * Source of the chance roll (when `roll` is omitted) and of the new copy's
   * Base SP. Omitted, the service's own generator: the process RNG in
   * production.
   */
  rng?: Rng | undefined;
  buddyOverride?: CaptureBuddyOverride | null | undefined;
  provenance?: CaptureProvenance | undefined;
  /** Extra fields for the diagnostic log line, placed after `playerId`. */
  logContext?: Record<string, unknown> | undefined;
  /**
   * Called once the outcome is decided and before the copy, XP and quests are
   * written, in the same transaction. The caller records its own attempt here
   * (a hunt: the `capture_attempts` row and the encounter state) and returns
   * the id XP audit rows should reference, or null.
   */
  recordAttempt?:
    | ((decision: CaptureAttemptDecision) => Promise<number | null | undefined | void>)
    | undefined;
}

export interface ResolvedCaptureAttempt extends CaptureAttemptDecision {
  /** The term-by-term chance, as logged. */
  breakdown: CaptureChanceBreakdown;
  newWaifu: PlayerWaifuRow | null;
  isDuplicate: boolean;
  isNewDex: boolean;
  xpGranted: number;
  xpBonus: AppliedBuddyBonus | null;
  levelUps: LevelUpEvent[];
  affinity: CaptureAffinityInfo;
  effect: CaptureEffectInfo | null;
  itemCaptureBonus: number;
  newAppearances: AppearanceUnlockRef[];
}

export interface GrantSpeciesCopyInput {
  playerId: number;
  species: SpeciesRow;
  /** Required: a direct grant is only ever made idempotently. */
  grantKey: string;
  /** Required provenance, e.g. `dungeon_rescue`. */
  acquiredVia: string;
  /** Source of the Base SP roll. Omitted, the service's own generator. */
  rng?: Rng | undefined;
  /**
   * Whose `player_xp_gain` bonus the grant's XP reads. Omitted, the live
   * Buddy; `null`, none; a value, that pinned Buddy.
   */
  buddyOverride?: CaptureBuddyOverride | null | undefined;
  /**
   * Whether the grant pays the capture-success XP for the species' rarity,
   * plus the new-dex bonus. Default true. It is logged as `species_granted`,
   * never as `capture_success`.
   */
  awardXp?: boolean | undefined;
  logContext?: Record<string, unknown> | undefined;
}

export interface SpeciesCopyGrant {
  waifu: PlayerWaifuRow;
  /**
   * True when the key had already been granted: `waifu` is the copy made the
   * first time, and this call wrote nothing — no copy, no XP, no audit row.
   */
  replayed: boolean;
  isDuplicate: boolean;
  isNewDex: boolean;
  xpGranted: number;
  xpBonus: AppliedBuddyBonus | null;
  levelUps: LevelUpEvent[];
  newAppearances: AppearanceUnlockRef[];
}

export interface CaptureService {
  /**
   * A chance quote for a species, in the caller's transaction, with no
   * encounter row. What {@link quoteCapture} computes; nothing is locked and
   * nothing is spent.
   */
  quoteSpecies(
    tx: DbOrTx,
    playerId: number,
    species: SpeciesRow,
    item: ItemRow | null,
    buddyOverride?: CaptureBuddyOverride | null,
  ): Promise<SpeciesCaptureQuote>;

  /**
   * Everything one capture attempt does that is not about an `encounters`
   * row: charm eligibility and consumption, the Microdose charge, the chance
   * and its roll, the owned copy on success, XP, capture quests and appearance
   * bookkeeping. Runs entirely in the caller's transaction and opens none of
   * its own, so a thrown error leaves the caller free to roll everything back.
   */
  resolveCaptureAttempt(tx: DbOrTx, input: ResolveCaptureAttemptInput): Promise<ResolvedCaptureAttempt>;

  /**
   * Grant one owned copy outright — the success branch alone. Spends no charm
   * and no Microdose charge, rolls no chance, writes no capture attempt and
   * advances no capture quest. Idempotent on `grantKey`.
   */
  grantSpeciesCopy(tx: DbOrTx, input: GrantSpeciesCopyInput): Promise<SpeciesCopyGrant>;

  /**
   * Resolve one capture commit. Atomic: item consumption, attempt row,
   * encounter state, and any owned-waifu row all commit together. Discord
   * side-effects (the SR+ rare-capture embed, the Activity Feed line) happen
   * afterwards at the coordinator layer and can never roll this back.
   *
   * `itemSlug` may be null, meaning "use whatever this encounter has
   * selected" — the selection is read back **inside** the transaction, under
   * the encounter row lock, so it is authoritative rather than something the
   * button asserted.
   */
  attemptCapture(
    playerId: number,
    encounterId: number,
    itemSlug?: string | null,
    optionsOrNow?: AttemptCaptureOptions | Date,
  ): Promise<CaptureAttemptResult>;

  /**
   * Choose (or change) the capture item for an active encounter. Consumes
   * nothing — that only happens when Capture is committed — but does validate
   * ownership and rarity eligibility up front so the player is never shown a
   * chance they cannot actually take.
   */
  selectCaptureItem(
    playerId: number,
    encounterId: number,
    itemSlug: string,
    now?: Date,
  ): Promise<CaptureQuote>;

  /**
   * Read-only chance quote. `itemSlug` null quotes the bare baseline;
   * undefined quotes the encounter's current selection (or the baseline when
   * nothing is selected).
   */
  quoteCapture(
    playerId: number,
    encounterId: number,
    itemSlug?: string | null,
    now?: Date,
  ): Promise<CaptureQuote>;

  /**
   * Everything the player owns that is applicable *during this encounter* —
   * eligible direct capture items, plus persistent consumables whose effect
   * changes a capture attempt (Microdose) and that would actually accomplish
   * something right now. Read-only.
   *
   * Availability is decided by `modules/items/encounterUse.ts`, on the item's
   * behaviour rather than its category.
   */
  listEncounterItems(
    playerId: number,
    encounterId: number,
    now?: Date,
  ): Promise<EncounterItemOption[]>;

  /**
   * The direct-capture subset of {@link listEncounterItems} — the items that
   * can occupy the encounter's selected-item slot.
   */
  listEligibleCaptureItems(
    playerId: number,
    encounterId: number,
    now?: Date,
  ): Promise<Array<{ item: ItemRow; quantity: number; quote: CaptureQuote }>>;

  /**
   * Activate a persistent consumable (Microdose) against a live encounter.
   *
   * One transaction: the encounter row is locked and revalidated, then the
   * item is spent through the authoritative {@link ItemUseService} — so the
   * "is this encounter still mine and still live" check and the inventory
   * decrement commit together, and neither can happen without the other.
   *
   * Deliberately leaves the encounter **untouched**: no state change, no
   * attempt, and no effect on the selected direct capture item. Activating a
   * buff is not a move in the encounter, it is a purchase made during one.
   */
  useEncounterConsumable(
    playerId: number,
    encounterId: number,
    itemSlug: string,
    options?: UseEncounterConsumableOptions,
  ): Promise<EncounterConsumableResult>;
}

export interface CaptureServiceDeps {
  db: Db;
  inventory: InventoryService;
  progression: ProgressionService;
  progressionConfig: ProgressionConfig;
  captureConfig: CaptureConfig;
  /** Milestone 5D — buddy affinity wheel and rarity-scaled bonuses. */
  buddyAffinityConfig: BuddyAffinityConfig;
  /**
   * Seductive Power bands. **Optional** so older wirings keep working: absent
   * means the shipped ladder from `DEFAULT_SP_RANGES_BY_RARITY`, which is also
   * what the content schema defaults to — the two can never disagree.
   */
  seductivePowerConfig?: SeductivePowerConfig | undefined;
  /** Used to resolve (and self-heal) the player's active buddy in-transaction. */
  collection: CollectionService;
  quests: QuestService;
  /** Consumable capture buffs (Microdose). Charges are spent per attempt. */
  effects: PlayerEffectsService;
  /**
   * The authoritative "use an inventory item" service.
   *
   * **Optional** so pre-existing wirings keep working; without it the
   * encounter offers direct capture items only and
   * `useEncounterConsumable` refuses. Present in production and in the test
   * fixture, so the encounter-consumable path is the wired default.
   */
  itemUse?: ItemUseService | undefined;
  /**
   * Cosmetic appearance bookkeeping. Optional and strictly downstream: a
   * freshly-captured copy has its default appearance acknowledged so the
   * player is never toasted for artwork she arrived wearing.
   */
  appearance?: AppearanceService | undefined;
  /**
   * Active Buddy Bonus lookup. Optional so existing wiring keeps working: with
   * no service the `capture_chance` term is simply 0 and the formula is exactly
   * what it was before Buddy Bonuses existed.
   */
  buddyBonus?: BuddyBonusService | undefined;
  logger: Logger;
  rng?: Rng;
}

export function createCaptureService(deps: CaptureServiceDeps): CaptureService {
  const {
    db,
    inventory,
    progression,
    progressionConfig,
    captureConfig,
    buddyAffinityConfig,
    collection,
    quests,
    effects,
    logger,
  } = deps;
  const spRanges = deps.seductivePowerConfig?.rangesByRarity;
  const buddyBonus = deps.buddyBonus;
  const itemUse = deps.itemUse;
  const appearance = deps.appearance;
  const rng = deps.rng ?? defaultRng();

  /** The Buddy an affinity matchup is read from, or null for none. */
  interface BuddyAffinityRead {
    buddyWaifuId: number | null;
    resolution: ReturnType<typeof resolveBuddyAffinity> | null;
  }

  /**
   * The affinity matchup against one species.
   *
   * With no override this is the live Buddy through the self-healing
   * resolver, exactly as a hunt has always read it. With one, the pinned
   * species is read instead and the live pointer is left alone.
   */
  async function readBuddyAffinity(
    tx: DbOrTx,
    playerId: number,
    speciesRow: SpeciesRow,
    override: CaptureBuddyOverride | null | undefined,
  ): Promise<BuddyAffinityRead> {
    let source: { waifuId: number; affinity: string; rarity: string } | null = null;
    if (override === undefined) {
      const buddy = await collection.resolveActiveBuddy(tx, playerId);
      if (buddy) {
        source = {
          waifuId: buddy.waifu.id,
          affinity: buddy.species.affinity,
          rarity: buddy.species.rarity,
        };
      }
    } else if (override?.pinned) {
      source = {
        waifuId: override.waifuId,
        affinity: override.pinned.affinity,
        rarity: override.pinned.rarity,
      };
    } else if (override !== null) {
      const [pinned] = await tx
        .select({ affinity: species.affinity, rarity: species.rarity })
        .from(species)
        .where(eq(species.slug, override.speciesSlug));
      if (pinned) {
        source = { waifuId: override.waifuId, ...pinned };
      } else {
        // The seeder never deletes a species, so this should be unreachable.
        // A missing one contributes nothing rather than failing the attempt.
        logger.warn(
          { playerId, speciesSlug: override.speciesSlug },
          'pinned buddy species not found; capture reads no buddy',
        );
      }
    }
    return {
      buddyWaifuId: source?.waifuId ?? null,
      resolution: source
        ? resolveBuddyAffinity(
            {
              buddyAffinity: source.affinity,
              buddyRarity: source.rarity as Rarity,
              encounterAffinity: speciesRow.affinity,
            },
            buddyAffinityConfig,
          )
        : null,
    };
  }

  /**
   * The Buddy Bonus `capture_chance` percentage against one species, and the
   * bonus behind it. `bonus` is null exactly when the percentage is 0 — the
   * percentage is the authority, so a targeted bonus this species does not
   * match reads as no bonus at all.
   */
  async function readBuddyCaptureBonus(
    tx: DbOrTx,
    playerId: number,
    speciesRow: SpeciesRow,
    override: CaptureBuddyOverride | null | undefined,
  ): Promise<{ percent: number; bonus: BuddyBonus | null }> {
    if (override === undefined) {
      const percent =
        (await buddyBonus?.percentForSpecies(
          tx,
          playerId,
          'capture_chance',
          speciesRefFromRow(speciesRow),
        )) ?? 0;
      const active =
        percent !== 0 ? ((await buddyBonus?.getActiveBuddyBonus(tx, playerId)) ?? null) : null;
      return { percent, bonus: active?.bonus ?? null };
    }
    if (override === null || !buddyBonus) return { percent: 0, bonus: null };
    // The pinned species' authored bonus, tested against this species by the
    // same matcher the live path uses. Ownership is still the player's own.
    const pinned = pinnedBuddyBonus(override);
    if (!pinned || pinned.effectId !== 'capture_chance') return { percent: 0, bonus: null };
    const subject = await buddyBonus.subjectFor(tx, playerId, speciesRefFromRow(speciesRow), {
      resolveOwnership: pinned.target?.type === 'ownership',
    });
    const percent = percentOfBuddyBonus(pinned, 'capture_chance', subject);
    return { percent, bonus: percent !== 0 ? pinned : null };
  }

  /** The pinned Buddy's authored bonus: frozen with the run when it was, else current content's. */
  function pinnedBuddyBonus(override: CaptureBuddyOverride): BuddyBonus | null {
    return override.pinned
      ? override.pinned.bonus
      : (buddyBonus?.bonusForSpeciesSlug(override.speciesSlug) ?? null);
  }

  /**
   * Whose `player_xp_gain` an award reads: `undefined` leaves `grantXp` on the
   * live Buddy (every hunt), anything else is the pinned Buddy's bonus or none.
   */
  function xpBuddyBonus(
    override: CaptureBuddyOverride | null | undefined,
  ): BuddyBonus | null | undefined {
    if (override === undefined) return undefined;
    return override === null ? null : pinnedBuddyBonus(override);
  }

  /**
   * The quote: everything the chance formula needs, gathered once and put
   * through the same {@link computeCaptureChance} the attempt rolls against.
   */
  async function quoteSpecies(
    tx: DbOrTx,
    playerId: number,
    speciesRow: SpeciesRow,
    item: ItemRow | null,
    buddyOverride?: CaptureBuddyOverride | null,
  ): Promise<SpeciesCaptureQuote> {
    const rarity = speciesRow.rarity as Rarity;
    const { resolution } = await readBuddyAffinity(tx, playerId, speciesRow, buddyOverride);
    const buddyAffinityModifier = resolution?.modifier ?? 0;
    // Read through the caller's handle: a quote made inside a transaction must
    // see a charge that transaction has already spent.
    const captureBonusModifier =
      (await effects.getCaptureBonus(playerId, undefined, tx))?.modifier ?? 0;
    // The Buddy Bonus is a second, unrelated contribution from the same copy:
    // affinity is the matchup wheel, this is whatever her species authors.
    const { percent: buddyBonusPercent, bonus } = await readBuddyCaptureBonus(
      tx,
      playerId,
      speciesRow,
      buddyOverride,
    );
    const baselineChance = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: speciesRow.baseCaptureRate,
      rarity,
      captureModifier: null,
      config: captureConfig,
      buddyAffinityModifier,
      captureBonusModifier,
      buddyBonusPercent,
    });
    const guaranteed = item?.isGuaranteedCapture ?? false;
    const itemCaptureBonus = guaranteed ? 0 : (item?.captureBonus ?? 0);
    const chance = item
      ? computeCaptureChance({
          guaranteed,
          baseCaptureRate: speciesRow.baseCaptureRate,
          rarity,
          captureModifier: item.captureModifier,
          config: captureConfig,
          buddyAffinityModifier,
          captureBonusModifier,
          buddyBonusPercent,
          itemCaptureBonus,
        })
      : baselineChance;
    return {
      species: speciesRow,
      item,
      guaranteed,
      chance,
      baselineChance,
      eligible: item ? isCaptureItemEligible(item, rarity) : true,
      buddyAffinityModifier,
      captureBonusModifier,
      buddyBonusPercent,
      buddyBonus: bonus ? appliedBuddyBonus(bonus) : null,
      itemCaptureBonus,
    };
  }

  /**
   * The charge ceiling this item grants, read from its own effect config so a
   * retuned Microdose changes both the rule and the label together.
   */
  function configuredCharges(item: ItemRow): number {
    const parsed = CaptureBonusEffectSchema.safeParse(item.effectConfig ?? {});
    return parsed.success ? parsed.data.charges : 0;
  }

  /**
   * Would activating this consumable right now accomplish anything?
   *
   * The refresh behaviour itself is untouched — a grant still resets charges
   * to the configured maximum. What this adds is that the *encounter* will not
   * offer, or accept, a refresh that is already at that maximum: the player
   * would spend an item and receive nothing back. (The inventory screen keeps
   * its existing behaviour, which is where topping a buff back up belongs.)
   *
   * It also closes the double-click hole: because a successful activation
   * always raises charges to the maximum, and activation is only permitted
   * below it, the charge count is guaranteed to change — which is what makes
   * it usable as the stale-interaction token.
   */
  function isConsumableMeaningfulNow(item: ItemRow, chargesNow: number): boolean {
    const max = configuredCharges(item);
    return max > 0 && chargesNow < max;
  }

  /**
   * Take the player's row before anything else a hunted capture locks.
   *
   * A capture attempt ends by writing the player's XP, and on the way there
   * its inserts key-share that same row — so it always needed the player row;
   * it used to reach it last, after the encounter, the charm and the Microdose
   * charge. A hunt takes the player row first and the encounter after it, and
   * a dungeon capture takes the player row first and the charm after it. Met
   * mid-flight, each side held what the other was waiting for, and Postgres
   * had to abort one of them.
   *
   * Taking the row up front makes the order `players → encounter → charm →
   * effect → copy → quests` here, which is a suffix of the hunt's and the
   * dungeon's. The three now queue on the player and cannot deadlock one
   * another. Nothing about what the attempt reads, rolls, spends or grants
   * changes: this is the lock `grantXp` took anyway, taken earlier.
   */
  async function lockPlayerForCapture(tx: DbOrTx, playerId: number): Promise<void> {
    await tx.select({ id: players.id }).from(players).where(eq(players.id, playerId)).for('update');
  }

  /** Active encounter + species, or a thrown domain error. Read-only. */
  async function loadActiveEncounter(
    playerId: number,
    encounterId: number,
    now: Date,
  ): Promise<{ encounter: EncounterRow; species: SpeciesRow }> {
    const [row] = await db
      .select({ encounter: encounters, species })
      .from(encounters)
      .innerJoin(species, eq(encounters.speciesId, species.id))
      .where(and(eq(encounters.id, encounterId), eq(encounters.playerId, playerId)))
      .limit(1);
    if (!row) throw new EncounterNotFoundError();
    if (row.encounter.state !== 'active') throw new EncounterAlreadyResolvedError();
    if (row.encounter.expiresAt.getTime() <= now.getTime()) throw new EncounterExpiredError();
    return row;
  }

  async function buildQuote(
    encounter: EncounterRow,
    speciesRow: SpeciesRow,
    item: ItemRow | null,
    playerId: number,
  ): Promise<CaptureQuote> {
    return { encounter, ...(await quoteSpecies(db, playerId, speciesRow, item)) };
  }

  function assertProvenance(provenance: CaptureProvenance | undefined): void {
    for (const [name, value] of [
      ['grantKey', provenance?.grantKey],
      ['acquiredVia', provenance?.acquiredVia],
    ] as const) {
      if (value != null && value.trim() === '') throw new RangeError(`${name} must not be blank`);
    }
  }

  /**
   * Create one owned copy: the duplicate read, the Base SP roll and the
   * insert, in that order. The only place a copy comes into existence.
   *
   * `waifu` is null only when a grant key was supplied and already exists —
   * the insert then writes nothing, and what that means is the caller's call.
   */
  async function mintCopy(
    tx: DbOrTx,
    playerId: number,
    speciesRow: SpeciesRow,
    draw: Rng,
    provenance?: CaptureProvenance,
  ): Promise<{ waifu: PlayerWaifuRow | null; isDuplicate: boolean; baseSp: number }> {
    const [existing] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(playerWaifus)
      .where(
        and(
          eq(playerWaifus.playerId, playerId),
          eq(playerWaifus.speciesId, speciesRow.id),
          isNull(playerWaifus.releasedAt),
        ),
      );
    const isDuplicate = (existing?.count ?? 0) > 0;

    // Base SP is rolled here — inside the capture transaction, and written in
    // the same INSERT that creates the copy. A retried transaction re-runs
    // the whole block, so it cannot half-apply: either a copy exists with the
    // SP rolled alongside it, or neither does. There is no second write that
    // could leave a copy without a value, and no read path that recomputes
    // one.
    const baseSp = rollBaseSeductivePower(speciesRow.rarity, draw, spRanges);
    const grantKey = provenance?.grantKey ?? null;
    const acquiredVia = provenance?.acquiredVia ?? null;
    const values = {
      playerId,
      speciesId: speciesRow.id,
      baseSp,
      ...(acquiredVia === null ? {} : { acquiredVia }),
      ...(grantKey === null ? {} : { grantKey }),
    };
    const [created] =
      grantKey === null
        ? await tx.insert(playerWaifus).values(values).returning()
        : await tx
            .insert(playerWaifus)
            .values(values)
            .onConflictDoNothing({
              target: playerWaifus.grantKey,
              where: sql`grant_key is not null`,
            })
            .returning();
    return { waifu: created ?? null, isDuplicate, baseSp };
  }

  async function resolveCaptureAttempt(
    tx: DbOrTx,
    input: ResolveCaptureAttemptInput,
  ): Promise<ResolvedCaptureAttempt> {
    const { playerId, species: speciesRow, item } = input;
    const now = input.now ?? new Date();
    const draw = input.rng ?? rng;

    if (!item.enabled) throw new ItemNotFoundError(item.slug);
    if (item.category !== 'capture') throw new ItemNotUsableError(item.slug);
    // Rarity eligibility, revalidated authoritatively: content may have
    // changed since the selection, and the selector is only a convenience.
    if (!isCaptureItemEligible(item, speciesRow.rarity)) {
      throw new CaptureItemNotEligibleError(item.name, speciesRow.rarity);
    }
    if (input.roll !== undefined && !(input.roll >= 0 && input.roll < 1)) {
      throw new RangeError(`Capture roll must be in [0, 1), got ${input.roll}`);
    }
    assertProvenance(input.provenance);

    // Consume the item. InsufficientItemsError bubbles out with the
    // transaction rolled back — no attempt row, no state change.
    await inventory.consumeItem(tx, playerId, item.id, 1);

    const guaranteed = item.isGuaranteedCapture;
    const rarity = speciesRow.rarity as keyof typeof captureConfig.baseRatesByRarity;

    // Buddy affinity (5D). Resolved inside the same transaction so a buddy
    // released mid-encounter can't contribute a bonus; the resolver clears
    // a dangling pointer for us. No buddy → neutral, modifier 0.
    const { buddyWaifuId, resolution } = await readBuddyAffinity(
      tx,
      playerId,
      speciesRow,
      input.buddyOverride,
    );
    const buddyAffinityModifier = resolution?.modifier ?? 0;

    // Consumable capture buff (Microdose). Spent here — after the
    // encounter passed validation and the charm was consumed, so it can
    // only be charged for an attempt that actually resolves. Guaranteed
    // captures skip it: the formula is bypassed, so a charge would buy
    // nothing.
    const consumed = guaranteed ? null : await effects.consumeCaptureCharge(tx, playerId, now);
    const captureBonusModifier = consumed?.modifier ?? 0;
    const effect: CaptureEffectInfo | null = consumed
      ? {
          sourceItemSlug: consumed.sourceItemSlug,
          captureBonusModifier: consumed.modifier,
          chargesBefore: consumed.chargesBefore,
          chargesRemaining: consumed.chargesRemaining,
          cleared: consumed.cleared,
        }
      : null;

    // The item's own flat bonus. Guaranteed captures bypass the formula,
    // so it contributes nothing there (and content forbids the pairing).
    const itemCaptureBonus = guaranteed ? 0 : (item.captureBonus ?? 0);

    // Re-derived under the caller's lock rather than trusted from the
    // quote, exactly like the affinity term above: the player may have
    // swapped Buddy between opening the screen and pressing the button.
    const { percent: buddyBonusPercent, bonus: buddyBonusApplied } = await readBuddyCaptureBonus(
      tx,
      playerId,
      speciesRow,
      input.buddyOverride,
    );

    // One breakdown drives the roll *and* the diagnostic log, so the number
    // the server rolls against is the same number an incident can explain
    // term by term. `buddyBonusIsConditional` only steers how the single
    // percentage is attributed (global vs targeted); it never doubles it.
    const breakdown = describeCaptureChance({
      guaranteed,
      baseCaptureRate: speciesRow.baseCaptureRate,
      rarity,
      captureModifier: item.captureModifier,
      config: captureConfig,
      buddyAffinityModifier,
      captureBonusModifier,
      buddyBonusPercent,
      buddyBonusIsConditional: (buddyBonusApplied?.target ?? null) !== null,
      itemCaptureBonus,
    });
    const chance = breakdown.finalChance;
    const affinity: CaptureAffinityInfo = {
      buddyWaifuId,
      buddyAffinity: resolution?.buddyAffinity ?? null,
      encounterAffinity: normalizeAffinity(speciesRow.affinity),
      matchup: resolution?.matchup ?? 'neutral',
      buddyAffinityModifier,
      finalChance: chance,
      buddyBonus: buddyBonusApplied ? appliedBuddyBonus(buddyBonusApplied) : null,
    };
    const roll = guaranteed ? 0 : (input.roll ?? draw.next());
    const success = guaranteed || roll < chance;
    const outcome: CaptureOutcome = success ? 'success' : input.finalAttempt ? 'escape' : 'failure';

    const refId =
      (await input.recordAttempt?.({ outcome, success, guaranteed, chance, roll })) ?? null;

    let newWaifu: PlayerWaifuRow | null = null;
    let isDuplicate = false;
    let xpDelta = 0;
    let isNewDex = false;

    if (success) {
      const minted = await mintCopy(tx, playerId, speciesRow, draw, input.provenance);
      // A key that already exists means this capture was granted before. The
      // charm is already spent in this transaction, so the only safe answer
      // is to refuse and let the caller roll the whole attempt back.
      if (!minted.waifu) throw new CaptureGrantKeyConflictError(input.provenance?.grantKey ?? '');
      newWaifu = minted.waifu;
      isDuplicate = minted.isDuplicate;
      isNewDex = !isDuplicate;
      xpDelta =
        (progressionConfig.xp.captureSuccessByRarity as Record<string, number>)[
          speciesRow.rarity
        ] ?? 0;
      if (isNewDex) xpDelta += progressionConfig.xp.newDexEntry;
      logger.info(
        {
          playerId,
          ...input.logContext,
          speciesSlug: speciesRow.slug,
          itemSlug: item.slug,
          chance,
          roll,
          guaranteed,
          isDuplicate,
          isNewDex,
          xpDelta,
          baseSp: minted.baseSp,
          affinity,
          effect,
          itemCaptureBonus,
          captureBreakdown: breakdown,
        },
        'capture success',
      );
    } else {
      xpDelta = progressionConfig.xp.captureFailed;
      // Failure/escape diagnostics mirror the success log so an incident can
      // reconstruct a *missed* capture just as precisely as a caught one —
      // the same breakdown, the same roll, so "why did this fail" and "why
      // did this catch" are answered from the same fields.
      logger.info(
        {
          playerId,
          ...input.logContext,
          speciesSlug: speciesRow.slug,
          itemSlug: item.slug,
          outcome,
          chance,
          roll,
          guaranteed,
          affinity,
          effect,
          itemCaptureBonus,
          captureBreakdown: breakdown,
        },
        outcome === 'escape' ? 'capture escaped' : 'capture failed',
      );
    }

    // Grant XP in the same transaction as the capture state change.
    const xpResult = await progression.grantXp(tx, playerId, {
      eventType: success ? 'capture_success' : 'capture_failed',
      xpDelta,
      refId,
      buddyBonus: xpBuddyBonus(input.buddyOverride),
      metadata: {
        outcome,
        rarity: speciesRow.rarity,
        speciesSlug: speciesRow.slug,
        itemSlug: item.slug,
        isNewDex,
        // Buddy-affinity audit trail. `capture_attempts` has no metadata
        // column and 5D doesn't add one, so the per-attempt affinity read
        // rides along on the progression event (which already refs the
        // capture_attempts row via `refId`).
        buddyWaifuId: affinity.buddyWaifuId,
        buddyAffinity: affinity.buddyAffinity,
        encounterAffinity: affinity.encounterAffinity,
        affinityMatchup: affinity.matchup,
        buddyAffinityModifier: affinity.buddyAffinityModifier,
        finalChance: affinity.finalChance,
        // Consumable buff audit trail — mirrors the affinity fields so a
        // single progression-event row explains the whole chance.
        captureBonusModifier: effect?.captureBonusModifier ?? 0,
        captureBonusSource: effect?.sourceItemSlug ?? null,
        captureBonusChargesRemaining: effect?.chargesRemaining ?? null,
        // The committed item's own additive term, so one progression row
        // still explains the whole chance.
        itemCaptureBonus,
        // Present only for a capture that is not a hunted one.
        ...(input.provenance?.acquiredVia != null ? { acquiredVia: input.provenance.acquiredVia } : {}),
        ...(input.provenance?.grantKey != null ? { grantKey: input.provenance.grantKey } : {}),
      },
    });
    // "new dex entry" is logged separately for audit clarity.
    if (isNewDex && progressionConfig.xp.newDexEntry > 0) {
      await progression.grantXp(tx, playerId, {
        eventType: 'new_dex_entry',
        xpDelta: 0, // already included above; this row is bookkeeping-only
        refId,
        metadata: { speciesSlug: speciesRow.slug, rarity: speciesRow.rarity },
      });
    }

    // Daily-quest progress inside the same transaction — every attempt
    // counts, only a success bumps capture_success and its rarity-gated
    // variant. If the outer transaction rolls back, quest progress does
    // too.
    await quests.recordQuestEvent(tx, playerId, 'capture_attempts', 1, {}, now);
    if (success) {
      await quests.recordQuestEvent(tx, playerId, 'capture_success', 1, {}, now);
      await quests.recordQuestEvent(
        tx,
        playerId,
        'capture_success_rarity_at_least',
        1,
        { rarity: speciesRow.rarity as Rarity },
        now,
      );
    }

    // Cosmetic bookkeeping, last and best-effort in spirit: acknowledge the
    // appearances a brand-new copy already qualifies for so she is never
    // toasted for the look she arrived in. Runs after every gameplay write
    // so it can only ever cost a notification, never a capture.
    const newAppearances =
      appearance && newWaifu ? await appearance.syncUnlocks(tx, newWaifu, speciesRow, 'owned') : [];

    return {
      outcome,
      success,
      guaranteed,
      chance,
      roll,
      breakdown,
      newWaifu,
      isDuplicate,
      isNewDex,
      // What the player actually received: `grantXp` may have raised it
      // through a `player_xp_gain` Buddy Bonus, and the result screen
      // prints this number.
      xpGranted: xpResult.xpDelta,
      xpBonus: xpResult.buddyBonus,
      levelUps: xpResult.levelUps,
      affinity,
      effect,
      itemCaptureBonus,
      newAppearances,
    };
  }

  async function grantSpeciesCopy(
    tx: DbOrTx,
    input: GrantSpeciesCopyInput,
  ): Promise<SpeciesCopyGrant> {
    const { playerId, species: speciesRow, grantKey, acquiredVia } = input;
    if (typeof grantKey !== 'string' || grantKey.trim() === '') {
      throw new RangeError('grantKey must not be blank');
    }
    if (typeof acquiredVia !== 'string' || acquiredVia.trim() === '') {
      throw new RangeError('acquiredVia must not be blank');
    }

    // A key names one grant for good. Seen again, it returns the copy it made
    // and writes nothing; seen for someone or something else, it is a bug in
    // the caller's key and is refused rather than papered over.
    const replay = (prior: PlayerWaifuRow): SpeciesCopyGrant => {
      if (prior.playerId !== playerId || prior.speciesId !== speciesRow.id) {
        throw new CaptureGrantKeyConflictError(grantKey);
      }
      return {
        waifu: prior,
        replayed: true,
        isDuplicate: false,
        isNewDex: false,
        xpGranted: 0,
        xpBonus: null,
        levelUps: [],
        newAppearances: [],
      };
    };
    const findByKey = async (): Promise<PlayerWaifuRow | undefined> => {
      const [row] = await tx.select().from(playerWaifus).where(eq(playerWaifus.grantKey, grantKey));
      return row;
    };
    const prior = await findByKey();
    if (prior) return replay(prior);

    const minted = await mintCopy(tx, playerId, speciesRow, input.rng ?? rng, {
      grantKey,
      acquiredVia,
    });
    if (!minted.waifu) {
      // A racing twin committed between the read and the insert.
      const raced = await findByKey();
      if (!raced) throw new CaptureGrantKeyConflictError(grantKey);
      return replay(raced);
    }
    const waifu = minted.waifu;
    const isNewDex = !minted.isDuplicate;

    let xpGranted = 0;
    let xpBonus: AppliedBuddyBonus | null = null;
    let levelUps: LevelUpEvent[] = [];
    if (input.awardXp !== false) {
      let xpDelta =
        (progressionConfig.xp.captureSuccessByRarity as Record<string, number>)[
          speciesRow.rarity
        ] ?? 0;
      if (isNewDex) xpDelta += progressionConfig.xp.newDexEntry;
      // Its own event type: a grant is not a capture, and nothing that counts
      // `capture_success` rows should count this one.
      const xpResult = await progression.grantXp(tx, playerId, {
        eventType: 'species_granted',
        xpDelta,
        buddyBonus: xpBuddyBonus(input.buddyOverride),
        metadata: {
          rarity: speciesRow.rarity,
          speciesSlug: speciesRow.slug,
          isNewDex,
          waifuId: waifu.id,
          acquiredVia,
          grantKey,
        },
      });
      xpGranted = xpResult.xpDelta;
      xpBonus = xpResult.buddyBonus;
      levelUps = xpResult.levelUps;
    }

    const newAppearances = appearance
      ? await appearance.syncUnlocks(tx, waifu, speciesRow, 'owned')
      : [];

    logger.info(
      {
        playerId,
        ...input.logContext,
        speciesSlug: speciesRow.slug,
        waifuId: waifu.id,
        acquiredVia,
        grantKey,
        isDuplicate: minted.isDuplicate,
        isNewDex,
        xpGranted,
        baseSp: minted.baseSp,
      },
      'species copy granted',
    );
    return {
      waifu,
      replayed: false,
      isDuplicate: minted.isDuplicate,
      isNewDex,
      xpGranted,
      xpBonus,
      levelUps,
      newAppearances,
    };
  }

  return {
    quoteSpecies,
    resolveCaptureAttempt,
    grantSpeciesCopy,

    async selectCaptureItem(playerId, encounterId, itemSlug, now = new Date()) {
      const { encounter, species: speciesRow } = await loadActiveEncounter(
        playerId,
        encounterId,
        now,
      );
      const [item] = await db.select().from(items).where(eq(items.slug, itemSlug));
      if (!item || !item.enabled) throw new ItemNotFoundError(itemSlug);
      if (item.category !== 'capture') throw new ItemNotUsableError(itemSlug);
      if (!isCaptureItemEligible(item, speciesRow.rarity)) {
        throw new CaptureItemNotEligibleError(item.name, speciesRow.rarity);
      }
      // Ownership is checked here for the player's benefit, but deliberately
      // *not* trusted: the commit re-checks it while consuming, so an item
      // sold between selection and Capture is caught there too.
      const owned = await inventory.getQuantity(playerId, item.id);
      if (owned <= 0) throw new InsufficientItemsError(item.id, 1);

      // Conditional update: only an encounter that is still this player's and
      // still active can take a selection, so a stale click cannot revive one.
      const [updated] = await db
        .update(encounters)
        .set({ selectedItemId: item.id })
        .where(
          and(
            eq(encounters.id, encounter.id),
            eq(encounters.playerId, playerId),
            eq(encounters.state, 'active'),
          ),
        )
        .returning();
      if (!updated) throw new EncounterAlreadyResolvedError();
      return buildQuote(updated, speciesRow, item, playerId);
    },

    async quoteCapture(playerId, encounterId, itemSlug, now = new Date()) {
      const { encounter, species: speciesRow } = await loadActiveEncounter(
        playerId,
        encounterId,
        now,
      );
      let item: ItemRow | null = null;
      if (itemSlug === undefined) {
        if (encounter.selectedItemId != null) {
          const [row] = await db
            .select()
            .from(items)
            .where(eq(items.id, encounter.selectedItemId));
          item = row ?? null;
        }
      } else if (itemSlug !== null) {
        const [row] = await db.select().from(items).where(eq(items.slug, itemSlug));
        if (!row || !row.enabled) throw new ItemNotFoundError(itemSlug);
        item = row;
      }
      return buildQuote(encounter, speciesRow, item, playerId);
    },

    async listEncounterItems(playerId, encounterId, now = new Date()) {
      const { encounter, species: speciesRow } = await loadActiveEncounter(
        playerId,
        encounterId,
        now,
      );
      const owned = await inventory.getInventory(playerId);
      const activeBonus = await effects.getCaptureBonus(playerId, now);

      const candidates: Array<{ item: ItemRow; quantity: number; kind: EncounterItemKind }> = [];
      for (const entry of owned) {
        if (entry.quantity <= 0) continue;
        const kind = encounterItemKind(entry.item);
        if (kind === null) continue;
        if (kind === 'direct') {
          // Rarity gating stays exactly where it was: content-declared bands,
          // never a slug list.
          if (!isCaptureItemEligible(entry.item, speciesRow.rarity)) continue;
        } else if (!isConsumableMeaningfulNow(entry.item, activeBonus?.chargesRemaining ?? 0)) {
          // Offered only while using one would actually change something —
          // see `isConsumableMeaningfulNow`.
          continue;
        }
        candidates.push({ item: entry.item, quantity: entry.quantity, kind });
      }

      const quotes = await Promise.all(
        candidates.map((entry) =>
          buildQuote(
            encounter,
            speciesRow,
            entry.kind === 'direct' ? entry.item : null,
            playerId,
          ),
        ),
      );

      return candidates
        .map((entry, i): EncounterItemOption => {
          const charges = entry.kind === 'consumable'
            ? {
                remaining: activeBonus?.chargesRemaining ?? 0,
                max: configuredCharges(entry.item),
              }
            : undefined;
          return {
            item: entry.item,
            quantity: entry.quantity,
            kind: entry.kind,
            quote: quotes[i]!,
            ...(charges === undefined ? {} : { charges }),
          };
        })
        .sort((a, b) => {
          // Direct items first — they are the decision the screen is asking
          // for. Guaranteed last within them (the nuclear option), otherwise
          // best odds first. Consumables trail as an aside.
          if (a.kind !== b.kind) return a.kind === 'direct' ? -1 : 1;
          if (a.kind === 'consumable') return a.item.slug.localeCompare(b.item.slug);
          if (a.quote.guaranteed !== b.quote.guaranteed) return a.quote.guaranteed ? 1 : -1;
          if (a.quote.chance !== b.quote.chance) return b.quote.chance - a.quote.chance;
          return a.item.slug.localeCompare(b.item.slug);
        });
    },

    async listEligibleCaptureItems(playerId, encounterId, now = new Date()) {
      const options = await this.listEncounterItems(playerId, encounterId, now);
      return options
        .filter((option) => option.kind === 'direct')
        .map(({ item, quantity, quote }) => ({ item, quantity, quote }));
    },

    async useEncounterConsumable(playerId, encounterId, itemSlug, options = {}) {
      if (!itemUse) throw new ItemNotUsableError(itemSlug);
      const now = options.now ?? new Date();

      // Quoted *before* the transaction, so the "before" half of the
      // before -> after line is a real reading of the pre-activation world
      // rather than an inference from it.
      const quoteBefore = await this.quoteCapture(playerId, encounterId, undefined, now);

      type TxResult =
        | { kind: 'expired' }
        | { kind: 'used'; encounter: EncounterRow; species: SpeciesRow; item: ItemRow; use: ItemUseResult };

      const outcome = await db.transaction(async (tx): Promise<TxResult> => {
        await lockPlayerForCapture(tx, playerId);
        // Same lock the capture commit takes: two clicks serialize here, and
        // the second sees the state the first left behind.
        const [encounter] = await tx
          .select()
          .from(encounters)
          .where(and(eq(encounters.id, encounterId), eq(encounters.playerId, playerId)))
          .for('update');
        if (!encounter) throw new EncounterNotFoundError();
        if (encounter.state !== 'active') throw new EncounterAlreadyResolvedError();
        if (encounter.expiresAt.getTime() <= now.getTime()) {
          await tx
            .update(encounters)
            .set({ state: 'expired', resolvedAt: now })
            .where(eq(encounters.id, encounter.id));
          return { kind: 'expired' };
        }
        if (
          options.expectedAttemptCount !== undefined &&
          options.expectedAttemptCount !== encounter.attemptCount
        ) {
          throw new EncounterStaleError();
        }

        const [speciesRow] = await tx
          .select()
          .from(species)
          .where(eq(species.id, encounter.speciesId));
        if (!speciesRow) throw new EncounterNotFoundError();

        const [item] = await tx.select().from(items).where(eq(items.slug, itemSlug));
        if (!item || !item.enabled) throw new ItemNotFoundError(itemSlug);
        // A direct capture item is *selected*, never "used" — routing one here
        // would spend it outside a capture attempt.
        if (isDirectCaptureItem(item) || !isEncounterConsumable(item)) {
          throw new ItemNotUsableError(itemSlug);
        }

        // Charge state under the lock: both the stale-click guard and the
        // "would this accomplish anything" rule are decided against it.
        const live = await effects.getCaptureBonus(playerId, now);
        const chargesNow = live?.chargesRemaining ?? 0;
        if (
          options.expectedCharges !== undefined &&
          options.expectedCharges !== chargesNow
        ) {
          throw new EncounterStaleError();
        }
        const max = configuredCharges(item);
        if (!isConsumableMeaningfulNow(item, chargesNow)) {
          throw new EffectAlreadyAtMaxChargesError(item.name, max);
        }

        // The authoritative use: one conditional decrement plus the grant or
        // refresh, in this transaction. Nothing about the encounter changes.
        const use = await itemUse.useInTransaction(tx, playerId, itemSlug, now);
        return { kind: 'used', encounter, species: speciesRow, item, use };
      });

      if (outcome.kind === 'expired') throw new EncounterExpiredError();

      const quoteAfter = await this.quoteCapture(playerId, encounterId, undefined, now);
      logger.info(
        {
          playerId,
          encounterId,
          itemSlug,
          chanceBefore: quoteBefore.chance,
          chanceAfter: quoteAfter.chance,
        },
        'encounter consumable activated',
      );
      return {
        encounter: outcome.encounter,
        species: outcome.species,
        item: outcome.item,
        use: outcome.use,
        quoteBefore,
        quoteAfter,
      };
    },

    async attemptCapture(playerId, encounterId, itemSlug = null, optionsOrNow) {
      const options: AttemptCaptureOptions =
        optionsOrNow instanceof Date ? { now: optionsOrNow } : (optionsOrNow ?? {});
      const now = options.now ?? new Date();
      const expectedAttemptCount = options.expectedAttemptCount;
      // Result-or-expiry — throwing inside the transaction would roll back
      // the expiry update, so we signal expiry to the caller instead and
      // throw outside the tx once the state change is committed.
      type TxResult =
        | { kind: 'expired' }
        | { kind: 'result'; value: CaptureAttemptResult };

      const outcome = await db.transaction(async (tx): Promise<TxResult> => {
        await lockPlayerForCapture(tx, playerId);
        const [encounter] = await tx
          .select()
          .from(encounters)
          .where(and(eq(encounters.id, encounterId), eq(encounters.playerId, playerId)))
          .for('update');
        if (!encounter) throw new EncounterNotFoundError();
        if (encounter.state !== 'active') throw new EncounterAlreadyResolvedError();
        if (encounter.expiresAt.getTime() <= now.getTime()) {
          await tx
            .update(encounters)
            .set({ state: 'expired', resolvedAt: now })
            .where(eq(encounters.id, encounter.id));
          return { kind: 'expired' };
        }
        if (encounter.attemptCount >= encounter.maxAttempts) {
          // Should be unreachable (state would already be resolved), but the
          // CHECK constraint on attempt_count catches this as a last line too.
          throw new NoAttemptsRemainingError();
        }
        // Stale-interaction guard. Checked under the lock, so a second click
        // of the *same rendered button* — which is what a double-click is —
        // finds the count already advanced and resolves nothing.
        if (
          expectedAttemptCount !== undefined &&
          expectedAttemptCount !== encounter.attemptCount
        ) {
          throw new EncounterStaleError();
        }

        const [speciesRow] = await tx
          .select()
          .from(species)
          .where(eq(species.id, encounter.speciesId));
        if (!speciesRow) {
          // Species disappearing mid-encounter should be impossible (seeder
          // never deletes rows), but treat it defensively.
          throw new EncounterNotFoundError();
        }

        // Resolve *which* item is being committed. An explicit slug is the
        // legacy/one-click path; otherwise the encounter's own selection is
        // read back here, under the lock, rather than trusted from the button.
        let item: ItemRow | undefined;
        if (itemSlug != null) {
          [item] = await tx.select().from(items).where(eq(items.slug, itemSlug));
          if (!item || !item.enabled) throw new ItemNotFoundError(itemSlug);
        } else {
          if (encounter.selectedItemId == null) throw new NoCaptureItemSelectedError();
          [item] = await tx
            .select()
            .from(items)
            .where(eq(items.id, encounter.selectedItemId));
          if (!item || !item.enabled) {
            // The selected item was disabled underneath the player. Clear the
            // dangling selection so the refreshed screen offers a fresh pick.
            await tx
              .update(encounters)
              .set({ selectedItemId: null })
              .where(eq(encounters.id, encounter.id));
            throw new NoCaptureItemSelectedError();
          }
        }
        // Everything that is not this encounter row — eligibility, the charm,
        // the Microdose charge, the roll, the copy, XP and quests — is the
        // shared attempt. It calls back once the outcome is decided, so the
        // audit row and the encounter state are written exactly where they
        // always were: after the roll, before the copy.
        const attemptNumber = encounter.attemptCount + 1;
        let attempt: CaptureAttemptRow | undefined;
        let updatedEncounter: EncounterRow | undefined;
        const resolved = await resolveCaptureAttempt(tx, {
          playerId,
          species: speciesRow,
          item,
          now,
          finalAttempt: attemptNumber >= encounter.maxAttempts,
          logContext: { encounterId: encounter.id },
          recordAttempt: async (decision) => {
            [attempt] = await tx
              .insert(captureAttempts)
              .values({
                encounterId: encounter.id,
                playerId,
                attemptNumber,
                itemId: item.id,
                computedChance: decision.chance,
                roll: decision.roll,
                success: decision.success,
                guaranteed: decision.guaranteed,
              })
              .returning();
            [updatedEncounter] = await tx
              .update(encounters)
              .set(
                decision.outcome === 'failure'
                  ? // Selection deliberately survives a failed attempt: she is
                    // still there, and re-committing the same item should be
                    // one click.
                    { attemptCount: attemptNumber, selectedItemId: item.id }
                  : {
                      attemptCount: attemptNumber,
                      state: decision.outcome === 'success' ? 'captured' : 'escaped',
                      resolvedAt: now,
                      // A resolved encounter holds no selection — nothing may
                      // be committed against it again.
                      selectedItemId: null,
                    },
              )
              .where(eq(encounters.id, encounter.id))
              .returning();
            return attempt?.id ?? null;
          },
        });

        return {
          kind: 'result',
          value: {
            outcome: resolved.outcome,
            attempt: attempt!,
            encounter: updatedEncounter!,
            species: speciesRow,
            item,
            attemptsRemaining: Math.max(0, encounter.maxAttempts - attemptNumber),
            newWaifu: resolved.newWaifu,
            isDuplicate: resolved.isDuplicate,
            xpGranted: resolved.xpGranted,
            xpBonus: resolved.xpBonus,
            levelUps: resolved.levelUps,
            isNewDex: resolved.isNewDex,
            affinity: resolved.affinity,
            effect: resolved.effect,
            itemCaptureBonus: resolved.itemCaptureBonus,
            newAppearances: resolved.newAppearances,
          },
        };
      });

      if (outcome.kind === 'expired') throw new EncounterExpiredError();
      return outcome.value;
    },
  };
}

// Re-export types used by callers.
export { InsufficientItemsError };
