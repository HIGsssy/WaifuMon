/**
 * Combat Trial progress for tests that need a player past (or part-way
 * through) the curriculum without fighting it. Writes the same authoritative
 * record a real first clear writes: one `combat_trial_attempts` row per Trial
 * with `first_clear = true`.
 */
import type { DbOrTx } from '../../src/db/client';
import { combatTrialAttempts } from '../../src/db/schema';
import { COMBAT_TRIAL_CURRICULUM } from '../../src/modules/combatTrials/trialCurriculum';

let seq = 0;

/** First-clear the given Trials (default: the whole shipped curriculum). Returns the attempt ids, in order. */
export async function recordTrialFirstClears(
  db: DbOrTx,
  playerId: number,
  keys: readonly string[] = COMBAT_TRIAL_CURRICULUM,
): Promise<number[]> {
  const ids: number[] = [];
  for (const trialKey of keys) {
    seq += 1;
    const [row] = await db
      .insert(combatTrialAttempts)
      .values({
        playerId,
        trialKey,
        enemyKey: 'fixture_enemy',
        requestKey: `fixture:${seq}`,
        result: 'player_victory',
        endReason: 'defeat',
        rounds: 1,
        actions: 1,
        buddyWaifuId: 0,
        playerName: 'Fixture',
        playerAttack: 1,
        playerDefense: 0,
        playerMaxHp: 1,
        playerRemainingHp: 1,
        enemyName: 'Fixture',
        enemyAttack: 1,
        enemyDefense: 0,
        enemyMaxHp: 1,
        enemyRemainingHp: 0,
        initialState: {},
        events: [],
        firstClear: true,
      })
      .returning({ id: combatTrialAttempts.id });
    ids.push(row!.id);
  }
  return ids;
}
