/**
 * PlayerEffectsService — charge-based consumable buffs (shop/items expansion).
 *
 * Today there is exactly one effect slot, {@link CAPTURE_BONUS_EFFECT}, granted
 * by Microdose. The design rules that make it safe:
 *
 *   - **Non-stacking by construction.** One row per (player, effect_type),
 *     enforced by a unique index. Granting again *refreshes* charges to the
 *     configured maximum instead of adding a second buff.
 *   - **Charges are spent only by a resolved capture attempt.** The consume
 *     path takes the caller's transaction and locks the row `FOR UPDATE`, so
 *     it inherits the encounter-row serialization CaptureService already has —
 *     a double-clicked charm cannot spend two charges for one attempt.
 *   - **Snapshotted tuning.** `modifier_json` freezes the item's bonus at use
 *     time, so editing content mid-buff can't change what the player bought.
 *   - **Exhausted means gone.** The row is deleted as the last charge is
 *     spent, so "is a buff active?" is just "does a row exist?".
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  CAPTURE_BONUS_EFFECT,
  playerActiveEffects,
  type PlayerActiveEffectRow,
} from '../../db/schema';

/** Read-only view of the player's active capture-bonus buff. */
export interface CaptureBonusState {
  /** Flat additive capture-chance bonus, e.g. 0.03 for +3%. */
  modifier: number;
  chargesRemaining: number;
  sourceItemSlug: string;
}

/** What a single capture attempt consumed. */
export interface CaptureBonusConsumption extends CaptureBonusState {
  chargesBefore: number;
  /** True when this attempt spent the final charge and cleared the buff. */
  cleared: boolean;
}

export interface GrantCaptureBonusInput {
  sourceItemSlug: string;
  modifier: number;
  charges: number;
  /** `refresh` resets charges to `charges`; `ignore` leaves a live buff alone. */
  refreshBehavior?: 'refresh' | 'ignore';
}

export interface GrantCaptureBonusResult extends CaptureBonusState {
  /** True when an active buff was refreshed rather than newly created. */
  refreshed: boolean;
  chargesBefore: number;
}

export interface PlayerEffectsService {
  /** Read-only lookup for UI paints. Null when no buff is active. */
  getCaptureBonus(playerId: number, now?: Date): Promise<CaptureBonusState | null>;

  /**
   * Grant (or refresh) the capture-bonus buff inside the caller's
   * transaction. Never stacks: the unique (player_id, effect_type) index means
   * a second grant lands as an upsert on the same row.
   */
  grantCaptureBonus(
    tx: DbOrTx,
    playerId: number,
    input: GrantCaptureBonusInput,
    now?: Date,
  ): Promise<GrantCaptureBonusResult>;

  /**
   * Lock the buff row and spend exactly one charge. Returns null when no buff
   * is active (or it has expired), in which case nothing is written. Callers
   * must already be inside a transaction — the lock is only meaningful there.
   */
  consumeCaptureCharge(
    tx: DbOrTx,
    playerId: number,
    now?: Date,
  ): Promise<CaptureBonusConsumption | null>;

  /** Diagnostic/test helper: every live effect row for a player. */
  listActive(playerId: number): Promise<PlayerActiveEffectRow[]>;
}

function readModifier(row: PlayerActiveEffectRow): number {
  const raw = (row.modifierJson ?? {}) as Record<string, unknown>;
  const value = raw.captureBonus;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isExpired(row: PlayerActiveEffectRow, now: Date): boolean {
  return row.expiresAt != null && row.expiresAt.getTime() <= now.getTime();
}

export function createPlayerEffectsService(db: Db): PlayerEffectsService {
  return {
    async getCaptureBonus(playerId, now = new Date()) {
      const [row] = await db
        .select()
        .from(playerActiveEffects)
        .where(
          and(
            eq(playerActiveEffects.playerId, playerId),
            eq(playerActiveEffects.effectType, CAPTURE_BONUS_EFFECT),
            gt(playerActiveEffects.chargesRemaining, 0),
          ),
        )
        .limit(1);
      if (!row || isExpired(row, now)) return null;
      return {
        modifier: readModifier(row),
        chargesRemaining: row.chargesRemaining,
        sourceItemSlug: row.sourceItemSlug,
      };
    },

    async grantCaptureBonus(tx, playerId, input, now = new Date()) {
      if (!Number.isInteger(input.charges) || input.charges <= 0) {
        throw new RangeError(`Charges must be a positive integer, got ${input.charges}`);
      }
      // Lock first so `refreshed`/`chargesBefore` reporting is accurate under
      // concurrent uses and `ignore` can genuinely no-op.
      const [existing] = await tx
        .select()
        .from(playerActiveEffects)
        .where(
          and(
            eq(playerActiveEffects.playerId, playerId),
            eq(playerActiveEffects.effectType, CAPTURE_BONUS_EFFECT),
          ),
        )
        .for('update');

      const live = existing != null && existing.chargesRemaining > 0 && !isExpired(existing, now);
      if (live && input.refreshBehavior === 'ignore') {
        return {
          modifier: readModifier(existing!),
          chargesRemaining: existing!.chargesRemaining,
          sourceItemSlug: existing!.sourceItemSlug,
          refreshed: true,
          chargesBefore: existing!.chargesRemaining,
        };
      }

      const values = {
        playerId,
        effectType: CAPTURE_BONUS_EFFECT,
        sourceItemSlug: input.sourceItemSlug,
        modifierJson: { captureBonus: input.modifier } as Record<string, unknown>,
        // Refresh sets charges *to* the configured max — never above it, and
        // never additive, so spamming the item can't bank charges.
        chargesRemaining: input.charges,
        expiresAt: null,
        updatedAt: now,
      };
      const [row] = await tx
        .insert(playerActiveEffects)
        .values({ ...values, createdAt: now })
        .onConflictDoUpdate({
          target: [playerActiveEffects.playerId, playerActiveEffects.effectType],
          set: {
            sourceItemSlug: values.sourceItemSlug,
            modifierJson: values.modifierJson,
            chargesRemaining: values.chargesRemaining,
            expiresAt: values.expiresAt,
            updatedAt: values.updatedAt,
          },
        })
        .returning();

      return {
        modifier: readModifier(row!),
        chargesRemaining: row!.chargesRemaining,
        sourceItemSlug: row!.sourceItemSlug,
        refreshed: live,
        chargesBefore: live ? existing!.chargesRemaining : 0,
      };
    },

    async consumeCaptureCharge(tx, playerId, now = new Date()) {
      const [row] = await tx
        .select()
        .from(playerActiveEffects)
        .where(
          and(
            eq(playerActiveEffects.playerId, playerId),
            eq(playerActiveEffects.effectType, CAPTURE_BONUS_EFFECT),
          ),
        )
        .for('update');
      if (!row) return null;

      // A stale row (0 charges or past its expiry) contributes nothing and is
      // swept here rather than left to accumulate.
      if (row.chargesRemaining <= 0 || isExpired(row, now)) {
        await tx.delete(playerActiveEffects).where(eq(playerActiveEffects.id, row.id));
        return null;
      }

      const chargesBefore = row.chargesRemaining;
      const chargesAfter = chargesBefore - 1;
      if (chargesAfter <= 0) {
        await tx.delete(playerActiveEffects).where(eq(playerActiveEffects.id, row.id));
      } else {
        await tx
          .update(playerActiveEffects)
          .set({ chargesRemaining: chargesAfter, updatedAt: sql`now()` })
          .where(eq(playerActiveEffects.id, row.id));
      }
      return {
        modifier: readModifier(row),
        sourceItemSlug: row.sourceItemSlug,
        chargesBefore,
        chargesRemaining: chargesAfter,
        cleared: chargesAfter <= 0,
      };
    },

    async listActive(playerId) {
      return db
        .select()
        .from(playerActiveEffects)
        .where(eq(playerActiveEffects.playerId, playerId));
    },
  };
}
