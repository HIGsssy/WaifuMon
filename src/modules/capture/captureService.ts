/**
 * CaptureService (Milestone 2B) — the 3-attempt capture state machine.
 *
 * One transaction per attempt with a `SELECT … FOR UPDATE` on the encounter
 * row: it serializes concurrent charm clicks so exactly one attempt consumes
 * an item and mutates state. The inventory service's conditional decrement +
 * CHECK (quantity >= 0) is a second line of defense against double-spend.
 *
 * Capture math (plan §9):
 *   guaranteed  → chance = 1.0 (Mythic Contract bypasses the formula)
 *   otherwise   → chance = clamp(baseCaptureRate × captureModifier, min, max)
 * `baseCaptureRate` uses the species override when set, otherwise the
 * rarity default from content/tables.json. Buddy / event modifiers are
 * reserved and not applied in 2B (the plan gates them on later milestones).
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
import type { InventoryService } from '../inventory/inventoryService';
import type {
  LevelUpEvent,
  ProgressionService,
} from '../progression/progressionService';
import type { ProgressionConfig } from '../content/schemas';

export type CaptureOutcome = 'success' | 'failure' | 'escape';

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
}

export interface CaptureService {
  /**
   * Resolve one charm click. Atomic: item consumption, attempt row, encounter
   * state, and any owned-waifu row all commit together. Public-message
   * side-effects live outside the transaction (see the encounter UI handler).
   */
  attemptCapture(
    playerId: number,
    encounterId: number,
    itemSlug: string,
    now?: Date,
  ): Promise<CaptureAttemptResult>;

  /** Persist the id of the public capture message created by the UI. */
  setPublicMessageId(encounterId: number, messageId: string): Promise<void>;
}

export interface CaptureServiceDeps {
  db: Db;
  inventory: InventoryService;
  progression: ProgressionService;
  progressionConfig: ProgressionConfig;
  captureConfig: CaptureConfig;
  logger: Logger;
  rng?: Rng;
}

export function createCaptureService(deps: CaptureServiceDeps): CaptureService {
  const { db, inventory, progression, progressionConfig, captureConfig, logger } = deps;
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
        const chance = computeCaptureChance({
          guaranteed,
          baseCaptureRate: speciesRow.baseCaptureRate,
          rarity,
          captureModifier: item.captureModifier,
          config: captureConfig,
        });
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
          },
        };
      });

      if (outcome.kind === 'expired') throw new EncounterExpiredError();
      return outcome.value;
    },

    async setPublicMessageId(encounterId, messageId) {
      await db
        .update(encounters)
        .set({ publicMessageId: messageId })
        .where(eq(encounters.id, encounterId));
    },
  };
}

// Re-export types used by callers.
export { InsufficientItemsError };
