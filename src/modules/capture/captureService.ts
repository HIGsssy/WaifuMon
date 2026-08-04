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
 *                     + captureBonusModifier,
 *                   min, max)
 * `baseCaptureRate` uses the species override when set, otherwise the
 * rarity default from content/tables.json. The buddy-affinity term is flat,
 * additive, scaled by the *buddy's* rarity, and 0 whenever there is no active
 * buddy or the matchup isn't strong. `captureBonusModifier` is the active
 * consumable buff (Microdose); one charge is spent per *resolved* attempt,
 * inside this same transaction and under the encounter row lock — so a
 * double-clicked charm can never spend two charges for one attempt.
 * Event modifiers remain reserved.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
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
  EncounterAlreadyResolvedError,
  EncounterExpiredError,
  EncounterNotFoundError,
  InsufficientItemsError,
  ItemNotFoundError,
  ItemNotUsableError,
  NoAttemptsRemainingError,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { defaultRng, type Rng } from '../../shared/random';
import type { CaptureConfig } from './captureMath';
import { computeCaptureChance } from './captureMath';
import { normalizeAffinity, resolveBuddyAffinity, type AffinityMatchup } from './affinityMath';
import type { InventoryService } from '../inventory/inventoryService';
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
}

export interface CaptureService {
  /**
   * Resolve one charm click. Atomic: item consumption, attempt row, encounter
   * state, and any owned-waifu row all commit together. Discord side-effects
   * (the SR+ rare-capture embed, the Activity Feed line) happen afterwards at
   * the coordinator layer and can never roll this back.
   */
  attemptCapture(
    playerId: number,
    encounterId: number,
    itemSlug: string,
    now?: Date,
  ): Promise<CaptureAttemptResult>;
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
  const rng = deps.rng ?? defaultRng();

  return {
    async attemptCapture(playerId, encounterId, itemSlug, now = new Date()) {
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

        const [item] = await tx.select().from(items).where(eq(items.slug, itemSlug));
        if (!item || !item.enabled) throw new ItemNotFoundError(itemSlug);
        if (item.category !== 'capture') throw new ItemNotUsableError(itemSlug);

        // Consume the charm. InsufficientItemsError bubbles out with the
        // transaction rolled back — no attempt row, no state change.
        await inventory.consumeItem(tx, playerId, item.id, 1);

        const [speciesRow] = await tx
          .select()
          .from(species)
          .where(eq(species.id, encounter.speciesId));
        if (!speciesRow) {
          // Species disappearing mid-encounter should be impossible (seeder
          // never deletes rows), but treat it defensively.
          throw new EncounterNotFoundError();
        }

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

        const chance = computeCaptureChance({
          guaranteed,
          baseCaptureRate: speciesRow.baseCaptureRate,
          rarity,
          captureModifier: item.captureModifier,
          config: captureConfig,
          buddyAffinityModifier,
          captureBonusModifier,
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
            })
            .where(eq(encounters.id, encounter.id))
            .returning();
          updatedEncounter = row!;
          attemptOutcome = 'escape';
          xpDelta = progressionConfig.xp.captureFailed;
        } else {
          const [row] = await tx
            .update(encounters)
            .set({ attemptCount: attemptNumber })
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
