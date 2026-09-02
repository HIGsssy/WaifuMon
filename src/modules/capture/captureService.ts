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
  playerWaifus,
  species,
  type CaptureAttemptRow,
  type EncounterRow,
  type ItemRow,
  type PlayerWaifuRow,
  type SpeciesRow,
} from '../../db/schema';
import {
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
import { computeCaptureChance, describeCaptureChance } from './captureMath';
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
import { appliedBuddyBonus, type AppliedBuddyBonus } from '../buddyBonus/buddyBonusEffects';
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

export interface CaptureService {
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

  /**
   * Everything the chance formula needs, gathered once. Shared by the quote
   * path and the authoritative attempt so the two can never disagree about
   * what a capture is worth — the attempt simply calls it with a locked
   * encounter row and a transaction that is about to spend things.
   */
  async function gatherChanceInputs(
    tx: DbOrTx,
    playerId: number,
    speciesRow: SpeciesRow,
  ): Promise<{
    buddyAffinityModifier: number;
    captureBonusModifier: number;
    buddyBonusPercent: number;
    buddyBonusApplied: AppliedBuddyBonus | null;
  }> {
    const buddy = await collection.resolveActiveBuddy(tx, playerId);
    const resolution = buddy
      ? resolveBuddyAffinity(
          {
            buddyAffinity: buddy.species.affinity,
            buddyRarity: buddy.species.rarity as Rarity,
            encounterAffinity: speciesRow.affinity,
          },
          buddyAffinityConfig,
        )
      : null;
    const bonus = await effects.getCaptureBonus(playerId);
    // The Buddy Bonus is a second, unrelated contribution from the same copy:
    // affinity is the matchup wheel, this is whatever her species authors.
    const buddyBonusPercent =
      (await buddyBonus?.percentForSpecies(
        tx,
        playerId,
        'capture_chance',
        speciesRefFromRow(speciesRow),
      )) ?? 0;
    // The percentage is the authority: it is already 0 for a non-matching
    // target, so the display record exists exactly when the bonus applies.
    const active = buddyBonusPercent !== 0 ? await buddyBonus?.getActiveBuddyBonus(tx, playerId) : null;
    return {
      buddyAffinityModifier: resolution?.modifier ?? 0,
      captureBonusModifier: bonus?.modifier ?? 0,
      buddyBonusPercent,
      buddyBonusApplied: active ? appliedBuddyBonus(active.bonus) : null,
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
    const rarity = speciesRow.rarity as Rarity;
    const { buddyAffinityModifier, captureBonusModifier, buddyBonusPercent, buddyBonusApplied } =
      await gatherChanceInputs(db, playerId, speciesRow);
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
      encounter,
      species: speciesRow,
      item,
      guaranteed,
      chance,
      baselineChance,
      eligible: item ? isCaptureItemEligible(item, rarity) : true,
      buddyAffinityModifier,
      captureBonusModifier,
      buddyBonusPercent,
      buddyBonus: buddyBonusApplied,
      itemCaptureBonus,
    };
  }

  return {
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
        if (item.category !== 'capture') throw new ItemNotUsableError(item.slug);
        // Rarity eligibility, revalidated authoritatively: content may have
        // changed since the selection, and the selector is only a convenience.
        if (!isCaptureItemEligible(item, speciesRow.rarity)) {
          throw new CaptureItemNotEligibleError(item.name, speciesRow.rarity);
        }

        // Consume the item. InsufficientItemsError bubbles out with the
        // transaction rolled back — no attempt row, no state change.
        await inventory.consumeItem(tx, playerId, item.id, 1);

        const guaranteed = item.isGuaranteedCapture;
        const rarity = speciesRow.rarity as keyof typeof captureConfig.baseRatesByRarity;

        // Buddy affinity (5D). Resolved inside the same transaction so a buddy
        // released mid-encounter can't contribute a bonus; the resolver clears
        // a dangling pointer for us. No buddy → neutral, modifier 0.
        const buddy = await collection.resolveActiveBuddy(tx, playerId);
        const resolution = buddy
          ? resolveBuddyAffinity(
              {
                buddyAffinity: buddy.species.affinity,
                buddyRarity: buddy.species.rarity as Rarity,
                encounterAffinity: speciesRow.affinity,
              },
              buddyAffinityConfig,
            )
          : null;
        const buddyAffinityModifier = resolution?.modifier ?? 0;

        // Consumable capture buff (Microdose). Spent here — after the
        // encounter passed validation and the charm was consumed, so it can
        // only be charged for an attempt that actually resolves. Guaranteed
        // captures skip it: the formula is bypassed, so a charge would buy
        // nothing.
        const consumed = guaranteed
          ? null
          : await effects.consumeCaptureCharge(tx, playerId, now);
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

        // Re-derived under the encounter lock rather than trusted from the
        // quote, exactly like the affinity term above: the player may have
        // swapped Buddy between opening the screen and pressing the button.
        const buddyBonusPercent =
          (await buddyBonus?.percentForSpecies(
            tx,
            playerId,
            'capture_chance',
            speciesRefFromRow(speciesRow),
          )) ?? 0;
        const buddyBonusApplied =
          buddyBonusPercent !== 0
            ? ((await buddyBonus?.getActiveBuddyBonus(tx, playerId)) ?? null)
            : null;

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
          buddyBonusIsConditional: (buddyBonusApplied?.bonus.target ?? null) !== null,
          itemCaptureBonus,
        });
        const chance = breakdown.finalChance;
        const affinity: CaptureAffinityInfo = {
          buddyWaifuId: buddy?.waifu.id ?? null,
          buddyAffinity: resolution?.buddyAffinity ?? null,
          encounterAffinity: normalizeAffinity(speciesRow.affinity),
          matchup: resolution?.matchup ?? 'neutral',
          buddyAffinityModifier,
          finalChance: chance,
          buddyBonus: buddyBonusApplied ? appliedBuddyBonus(buddyBonusApplied.bonus) : null,
        };
        const roll = guaranteed ? 0 : rng.next();
        const success = guaranteed || roll < chance;
        const attemptNumber = encounter.attemptCount + 1;

        const [attempt] = await tx
          .insert(captureAttempts)
          .values({
            encounterId: encounter.id,
            playerId,
            attemptNumber,
            itemId: item.id,
            computedChance: chance,
            roll,
            success,
            guaranteed,
          })
          .returning();

        let updatedEncounter: EncounterRow;
        let newWaifu: PlayerWaifuRow | null = null;
        let isDuplicate = false;
        let attemptOutcome: CaptureOutcome;
        let xpDelta = 0;
        let isNewDex = false;

        if (success) {
          const [row] = await tx
            .update(encounters)
            .set({
              attemptCount: attemptNumber,
              state: 'captured',
              resolvedAt: now,
              // A resolved encounter holds no selection — nothing may be
              // committed against it again.
              selectedItemId: null,
            })
            .where(eq(encounters.id, encounter.id))
            .returning();
          updatedEncounter = row!;

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
          isDuplicate = (existing?.count ?? 0) > 0;
          isNewDex = !isDuplicate;

          // Base SP is rolled here — inside the capture transaction, from the
          // same injectable `rng` the chance roll used, and written in the
          // same INSERT that creates the copy. A retried transaction re-runs
          // the whole block, so it cannot half-apply: either a copy exists
          // with the SP rolled alongside it, or neither does. There is no
          // second write that could leave a copy without a value, and no read
          // path that recomputes one.
          const baseSp = rollBaseSeductivePower(speciesRow.rarity, rng, spRanges);
          const [created] = await tx
            .insert(playerWaifus)
            .values({
              playerId,
              speciesId: speciesRow.id,
              baseSp,
            })
            .returning();
          newWaifu = created!;
          attemptOutcome = 'success';
          xpDelta =
            (progressionConfig.xp.captureSuccessByRarity as Record<string, number>)[
              speciesRow.rarity
            ] ?? 0;
          if (isNewDex) xpDelta += progressionConfig.xp.newDexEntry;
          logger.info(
            {
              playerId,
              encounterId: encounter.id,
              speciesSlug: speciesRow.slug,
              itemSlug: item.slug,
              chance,
              roll,
              guaranteed,
              isDuplicate,
              isNewDex,
              xpDelta,
              baseSp,
              affinity,
              effect,
              itemCaptureBonus,
              captureBreakdown: breakdown,
            },
            'capture success',
          );
        } else if (attemptNumber >= encounter.maxAttempts) {
          const [row] = await tx
            .update(encounters)
            .set({
              attemptCount: attemptNumber,
              state: 'escaped',
              resolvedAt: now,
              selectedItemId: null,
            })
            .where(eq(encounters.id, encounter.id))
            .returning();
          updatedEncounter = row!;
          attemptOutcome = 'escape';
          xpDelta = progressionConfig.xp.captureFailed;
        } else {
          const [row] = await tx
            .update(encounters)
            // Selection deliberately survives a failed attempt: she is still
            // there, and re-committing the same item should be one click.
            .set({ attemptCount: attemptNumber, selectedItemId: item.id })
            .where(eq(encounters.id, encounter.id))
            .returning();
          updatedEncounter = row!;
          attemptOutcome = 'failure';
          xpDelta = progressionConfig.xp.captureFailed;
        }

        // Failure/escape diagnostics mirror the success log so an incident can
        // reconstruct a *missed* capture just as precisely as a caught one —
        // the same breakdown, the same roll, so "why did this fail" and "why
        // did this catch" are answered from the same fields.
        if (attemptOutcome !== 'success') {
          logger.info(
            {
              playerId,
              encounterId: encounter.id,
              speciesSlug: speciesRow.slug,
              itemSlug: item.slug,
              outcome: attemptOutcome,
              chance,
              roll,
              guaranteed,
              affinity,
              effect,
              itemCaptureBonus,
              captureBreakdown: breakdown,
            },
            attemptOutcome === 'escape' ? 'capture escaped' : 'capture failed',
          );
        }

        // Grant XP in the same transaction as the capture state change.
        const xpResult = await progression.grantXp(tx, playerId, {
          eventType: attemptOutcome === 'success' ? 'capture_success' : 'capture_failed',
          xpDelta,
          refId: attempt?.id ?? null,
          metadata: {
            outcome: attemptOutcome,
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
          },
        });
        // "new dex entry" is logged separately for audit clarity.
        if (isNewDex && progressionConfig.xp.newDexEntry > 0) {
          await progression.grantXp(tx, playerId, {
            eventType: 'new_dex_entry',
            xpDelta: 0, // already included above; this row is bookkeeping-only
            refId: attempt?.id ?? null,
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
            { rarity: speciesRow.rarity as import('../../db/schema').Rarity },
            now,
          );
        }

        // Cosmetic bookkeeping, last and best-effort in spirit: acknowledge the
        // appearances a brand-new copy already qualifies for so she is never
        // toasted for the look she arrived in. Runs after every gameplay write
        // so it can only ever cost a notification, never a capture.
        const newAppearances =
          appearance && newWaifu
            ? await appearance.syncUnlocks(tx, newWaifu, speciesRow, 'owned')
            : [];

        return {
          kind: 'result',
          value: {
            outcome: attemptOutcome,
            attempt: attempt!,
            encounter: updatedEncounter,
            species: speciesRow,
            item,
            attemptsRemaining: Math.max(0, encounter.maxAttempts - attemptNumber),
            newWaifu,
            isDuplicate,
            // What the player actually received: `grantXp` may have raised it
            // through a `player_xp_gain` Buddy Bonus, and the result screen
            // prints this number.
            xpGranted: xpResult.xpDelta,
            xpBonus: xpResult.buddyBonus,
            levelUps: xpResult.levelUps,
            isNewDex,
            affinity,
            effect,
            itemCaptureBonus,
            newAppearances,
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
