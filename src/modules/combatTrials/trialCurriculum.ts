/**
 * The Combat Trials curriculum — the introductory Trials a player must clear
 * before Delve opens, and the one place that decides whether they have.
 *
 * **Equipment onboarding → clear the curriculum → Delve.**
 *
 * The curriculum is a frozen list of Trial keys, not "every Trial in
 * `trials.json`" and not a content tag. A Trial added in a later release —
 * optional, repeatable or advanced — is simply not in it, so it can never
 * block Delve or take away an unlock a player already earned. Do not append
 * to this list: a player's unlock is *derived* from it, so a new required key
 * would re-lock everyone who had not cleared it. A real curriculum change
 * needs a durable per-player unlock (a `player_feature_unlocks` key plus a
 * backfill) first.
 *
 * Completion is read from the authoritative record, never stored twice: a
 * Trial is cleared when its `combat_trial_attempts` row with
 * `first_clear = true` exists. That row is written once, in the same
 * transaction as the first-clear reward, and backed by the partial unique
 * index on `(player_id, trial_key) WHERE first_clear`, so it survives
 * restarts and can never be duplicated.
 *
 * {@link createDelveAccess} combines it with the `equipment` unlock; the
 * dungeon service uses that for both the menu entry and every run start, and
 * the Trial service uses {@link readCurriculumProgress} to retire the
 * curriculum once it is done.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { combatTrialAttempts } from '../../db/schema';
import type { FeatureUnlockService } from '../features/featureUnlockService';

/** The shipped introductory Trials, in order. Frozen: see the file comment. */
export const COMBAT_TRIAL_CURRICULUM: readonly string[] = Object.freeze([
  'trial_scrapyard_drone',
  'trial_alley_bruiser',
  'trial_security_automaton',
]);

export interface TrialCurriculumProgress {
  /** The curriculum's Trial keys. */
  required: readonly string[];
  /** The curriculum Trials this player has first-cleared, in curriculum order. */
  cleared: string[];
  complete: boolean;
  /**
   * The attempt that cleared the last outstanding curriculum Trial — the
   * one that opened Delve. Null while the curriculum is incomplete.
   */
  completedByAttemptId: number | null;
}

/** Read through `tx` when given, so a caller's own uncommitted first clear counts. */
export async function readCurriculumProgress(
  tx: DbOrTx,
  playerId: number,
  curriculum: readonly string[] = COMBAT_TRIAL_CURRICULUM,
): Promise<TrialCurriculumProgress> {
  if (curriculum.length === 0) return { required: curriculum, cleared: [], complete: true, completedByAttemptId: null };
  const rows = await tx
    .select({ id: combatTrialAttempts.id, trialKey: combatTrialAttempts.trialKey })
    .from(combatTrialAttempts)
    .where(
      and(
        eq(combatTrialAttempts.playerId, playerId),
        eq(combatTrialAttempts.firstClear, true),
        inArray(combatTrialAttempts.trialKey, [...curriculum]),
      ),
    )
    .orderBy(desc(combatTrialAttempts.id));
  const clearedKeys = new Set(rows.map((r) => r.trialKey));
  const cleared = curriculum.filter((k) => clearedKeys.has(k));
  const complete = cleared.length === curriculum.length;
  return { required: curriculum, cleared, complete, completedByAttemptId: complete ? (rows[0]?.id ?? null) : null };
}

/** Whether a player may start a Delve: the one progression decision for dungeons. */
export interface DelveAccess {
  /** `equipment` unlocked and the curriculum cleared. Reads through `tx` when given. */
  isUnlocked(playerId: number, tx?: DbOrTx): Promise<boolean>;
}

export function createDelveAccess(deps: {
  db: Db;
  featureUnlocks: Pick<FeatureUnlockService, 'isUnlocked'>;
  curriculum?: readonly string[];
}): DelveAccess {
  return {
    async isUnlocked(playerId, tx = deps.db) {
      if (!(await deps.featureUnlocks.isUnlocked(playerId, 'equipment', tx))) return false;
      return (await readCurriculumProgress(tx, playerId, deps.curriculum)).complete;
    },
  };
}
