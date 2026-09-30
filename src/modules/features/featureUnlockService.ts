/**
 * Account feature unlocks — the one writer of `player_feature_unlocks`.
 *
 * An unlock is a permanent per-player entitlement, modelled on
 * `player_unlocked_routes`: one row per (player, feature), with where it came
 * from and when. Equipment is the first feature gated this way; its
 * onboarding sequence will call {@link FeatureUnlockService.unlock} inside the
 * same transaction that grants the tutorial gear, so "items granted" and
 * "feature unlocked" commit together or not at all.
 *
 * Idempotent by construction. `unlock` is `INSERT … ON CONFLICT DO NOTHING`
 * against the `(player_id, feature_key)` primary key, so a double-clicked
 * completion, a retried step or two concurrent transactions produce exactly one
 * row — and exactly one caller is told it was the one that unlocked it.
 *
 * `revoke` exists for operators and staging only, and is always audited.
 */
import { and, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { playerFeatureUnlocks, type PlayerFeatureUnlockRow } from '../../db/schema';
import { recordDomainAdminAction } from '../admin/adminActionAudit';
import {
  FEATURE_UNLOCK_SOURCES,
  isFeatureKey,
  type FeatureKey,
  type FeatureUnlockSource,
} from './vocabulary';

export interface UnlockInput {
  playerId: number;
  featureKey: FeatureKey;
  source: FeatureUnlockSource;
  sourceRef?: string | null;
  /** Required for `source: 'admin'`, which is audited. */
  actorDiscordId?: string | null;
}

export interface UnlockResult {
  /** True for exactly the call that created the row. */
  newlyUnlocked: boolean;
  unlock: PlayerFeatureUnlockRow;
}

export interface RevokeInput {
  playerId: number;
  featureKey: FeatureKey;
  actorDiscordId: string;
  reason: string;
}

export interface FeatureUnlockService {
  /** Reads through `tx` when given, so a caller's own uncommitted unlock is visible. */
  isUnlocked(playerId: number, featureKey: FeatureKey, tx?: DbOrTx): Promise<boolean>;
  listUnlocked(playerId: number): Promise<PlayerFeatureUnlockRow[]>;
  unlock(tx: DbOrTx, input: UnlockInput): Promise<UnlockResult>;
  /** Admin/staging only. Returns whether a row was actually removed. */
  revoke(tx: DbOrTx, input: RevokeInput): Promise<{ revoked: boolean }>;
}

function assertFeatureKey(featureKey: unknown): asserts featureKey is FeatureKey {
  if (!isFeatureKey(featureKey)) throw new RangeError(`Unknown feature key "${String(featureKey)}"`);
}

/**
 * Run `fn` as one atomic unit on `tx`: a real transaction when handed the bare
 * `Db` (so the row write and its audit row commit together), a savepoint when
 * already inside one (so the caller's transaction survives a caught failure).
 */
function atomically<T>(tx: DbOrTx, fn: (inner: DbOrTx) => Promise<T>): Promise<T> {
  return (tx as Db).transaction(fn);
}

export function createFeatureUnlockService(db: Db): FeatureUnlockService {
  const methods: FeatureUnlockService = {
    async isUnlocked(playerId, featureKey, tx = db) {
      const [row] = await tx
        .select({ playerId: playerFeatureUnlocks.playerId })
        .from(playerFeatureUnlocks)
        .where(
          and(
            eq(playerFeatureUnlocks.playerId, playerId),
            eq(playerFeatureUnlocks.featureKey, featureKey),
          ),
        );
      return row != null;
    },

    async listUnlocked(playerId) {
      return db
        .select()
        .from(playerFeatureUnlocks)
        .where(eq(playerFeatureUnlocks.playerId, playerId))
        .orderBy(playerFeatureUnlocks.unlockedAt);
    },

    async unlock(tx, input) {
      assertFeatureKey(input.featureKey);
      if (!(FEATURE_UNLOCK_SOURCES as readonly string[]).includes(input.source)) {
        throw new RangeError(`Unknown feature unlock source "${String(input.source)}"`);
      }
      if (input.source === 'admin' && !input.actorDiscordId) {
        throw new RangeError('An admin unlock must name the acting admin');
      }

      const [inserted] = await tx
        .insert(playerFeatureUnlocks)
        .values({
          playerId: input.playerId,
          featureKey: input.featureKey,
          source: input.source,
          sourceRef: input.sourceRef ?? null,
          unlockedBy: input.source === 'admin' ? (input.actorDiscordId ?? null) : null,
        })
        .onConflictDoNothing({
          target: [playerFeatureUnlocks.playerId, playerFeatureUnlocks.featureKey],
        })
        .returning();

      if (input.source === 'admin') {
        await recordDomainAdminAction(tx, {
          playerId: input.playerId,
          action: `unlock_feature_${input.featureKey}`,
          adminDiscordId: input.actorDiscordId ?? null,
          before: inserted ? false : true,
          after: true,
          detail: { featureKey: input.featureKey, changed: inserted != null },
        });
      }

      if (inserted) return { newlyUnlocked: true, unlock: inserted };
      // Lost the race (or already unlocked): read the winner back through the
      // same transaction.
      const [existing] = await tx
        .select()
        .from(playerFeatureUnlocks)
        .where(
          and(
            eq(playerFeatureUnlocks.playerId, input.playerId),
            eq(playerFeatureUnlocks.featureKey, input.featureKey),
          ),
        );
      if (!existing) {
        throw new Error(
          `feature unlock for player ${input.playerId}/${input.featureKey} conflicted but is not readable`,
        );
      }
      return { newlyUnlocked: false, unlock: existing };
    },

    async revoke(tx, input) {
      assertFeatureKey(input.featureKey);
      if (!input.actorDiscordId) throw new RangeError('A revoke must name the acting admin');
      if (!input.reason?.trim()) throw new RangeError('A revoke must give a reason');
      const removed = await tx
        .delete(playerFeatureUnlocks)
        .where(
          and(
            eq(playerFeatureUnlocks.playerId, input.playerId),
            eq(playerFeatureUnlocks.featureKey, input.featureKey),
          ),
        )
        .returning();
      await recordDomainAdminAction(tx, {
        playerId: input.playerId,
        action: `revoke_feature_${input.featureKey}`,
        adminDiscordId: input.actorDiscordId,
        before: removed.length > 0,
        after: false,
        detail: {
          featureKey: input.featureKey,
          reason: input.reason.trim(),
          changed: removed.length > 0,
          ...(removed[0] ? { previousSource: removed[0].source } : {}),
        },
      });
      return { revoked: removed.length > 0 };
    },
  };

  return {
    ...methods,
    unlock: (tx, input) => atomically(tx, (inner) => methods.unlock(inner, input)),
    revoke: (tx, input) => atomically(tx, (inner) => methods.revoke(inner, input)),
  };
}
