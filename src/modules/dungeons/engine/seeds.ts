/**
 * The run's random streams.
 *
 * Every draw a run makes — which enemy a pooled wave fields, a fight's damage
 * rolls, what a reward pays — comes from a stream derived from the run's seed
 * and the *place* the draw is made (room, action, wave), never from a shared
 * running stream. So a draw does not depend on what was drawn before it:
 * the third wave's fight is the same fight whether or not the player rested
 * first, and asking twice gives the same answer. There is no way to reroll.
 *
 * A stream's seed is the first 32 bits of `md5("<run seed>:<parts…>:<salt>")`.
 */
import { createHash } from 'node:crypto';
import { seededRng } from '../../../shared/random';
import type { DungeonRngSource } from './types';

/**
 * Versioned salt. Frozen: changing it would make an unresolved action of a
 * run in progress draw differently than it would have.
 */
export const DUNGEON_SEED_SALT = 'waifumon.dungeon.engine.v1';

export function deriveDungeonSeed(runSeed: number, parts: readonly (string | number)[], salt: string = DUNGEON_SEED_SALT): number {
  const digest = createHash('md5').update([runSeed, ...parts, salt].join(':'), 'utf8').digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16);
}

export function dungeonRngSource(runSeed: number): DungeonRngSource {
  return {
    seedOf: (...parts) => deriveDungeonSeed(runSeed, parts),
    stream: (...parts) => seededRng(deriveDungeonSeed(runSeed, parts)),
  };
}

/** A fresh run seed: unsigned 32-bit, the range `seededRng` uses. */
export function randomDungeonSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0x1_0000_0000) >>> 0;
}
