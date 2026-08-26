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
import { computeCaptureChance } from './captureMath';
import { normalizeAffinity, resolveBuddyAffinity, type AffinityMatchup } from './affinityMath';
import type { InventoryService } from '../inventory/inventoryService';
import type { AppearanceService, AppearanceUnlockRef } from '../appearance/appearanceService';
import type { CollectionService } from '../collection/collectionService';
import type {
  LevelUpEvent,
  ProgressionService,
} from '../progression/progressionService';
import type { BuddyAffinityConfig, ProgressionConfig } from '../content/schemas';
import type { PlayerEffectsService } from '../effects/playerEffectsService';
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
  itemCaptureBonus: number;
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
   * Capture items the player owns that are eligible against this encounter,
   * in the order the selector should offer them. Read-only.
   */
  listEligibleCaptureItems(
    playerId: number,
    encounterId: number,
    now?: Date,
  ): Promise<Array<{ item: ItemRow; quantity: number; quote: CaptureQuote }>>;
}

export interface CaptureServiceDeps {
  db: Db;
  inventory: InventoryService;
  progression: ProgressionService;
  progressionConfig: ProgressionConfig;
  captureConfig: CaptureConfig;
  /** Milestone 5D — buddy affinity wheel and rarity-scaled bonuses. */
  buddyAffinityConfig: BuddyAffinityConfig;
  /** Used to resolve (and self-heal) the player's active buddy in-transaction. */
  collection: CollectionService;
  quests: QuestService;
  /** Consumable capture buffs (Microdose). Charges are spent per attempt. */
  effects: PlayerEffectsService;
  /**
   * Cosmetic appearance bookkeeping. Optional and strictly downstream: a
   * freshly-captured copy has its default appearance acknowledged so the
   * player is never toasted for artwork she arrived wearing.
   */
  appearance?: AppearanceService | undefined;
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
  ): Promise<{ buddyAffinityModifier: number; captureBonusModifier: number }> {
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
    return {
      buddyAffinityModifier: resolution?.modifier ?? 0,
      captureBonusModifier: bonus?.modifier ?? 0,
    };
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
    const { buddyAffinityModifier, captureBonusModifier } = await gatherChanceInputs(
      db,
      playerId,
      speciesRow,
    );
    const baselineChance = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: speciesRow.baseCaptureRate,
      rarity,
      captureModifier: null,
      config: captureConfig,
      buddyAffinityModifier,
      captureBonusModifier,
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

    async listEligibleCaptureItems(playerId, encounterId, now = new Date()) {
      const { encounter, species: speciesRow } = await loadActiveEncounter(
        playerId,
        encounterId,
        now,
      );
      const owned = await inventory.getInventory(playerId);
      const candidates = owned.filter(
        (entry) =>
          entry.item.enabled &&
          entry.item.category === 'capture' &&
          entry.quantity > 0 &&
          isCaptureItemEligible(entry.item, speciesRow.rarity),
      );
      const quotes = await Promise.all(
        candidates.map((entry) => buildQuote(encounter, speciesRow, entry.item, playerId)),
      );
      return candidates
        .map((entry, i) => ({
          item: entry.item,
          quantity: entry.quantity,
          quote: quotes[i]!,
        }))
        // Guaranteed last (it is the nuclear option), otherwise best odds
        // first so the obvious pick is the top of the menu.
        .sort((a, b) => {
          if (a.quote.guaranteed !== b.quote.guaranteed) return a.quote.guaranteed ? 1 : -1;
          if (a.quote.chance !== b.quote.chance) return b.quote.chance - a.quote.chance;
          return a.item.slug.localeCompare(b.item.slug);
        });
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

        const chance = computeCaptureChance({
          guaranteed,
          baseCaptureRate: speciesRow.baseCaptureRate,
          rarity,
          captureModifier: item.captureModifier,
          config: captureConfig,
          buddyAffinityModifier,
          captureBonusModifier,
          itemCaptureBonus,
        });
        const affinity: CaptureAffinityInfo = {
          buddyWaifuId: buddy?.waifu.id ?? null,
          buddyAffinity: resolution?.buddyAffinity ?? null,
          encounterAffinity: normalizeAffinity(speciesRow.affinity),
          matchup: resolution?.matchup ?? 'neutral',
          buddyAffinityModifier,
          finalChance: chance,
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

          const [created] = await tx
            .insert(playerWaifus)
            .values({
              playerId,
              speciesId: speciesRow.id,
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
              affinity,
              effect,
              itemCaptureBonus,
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
            xpGranted: xpDelta,
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
