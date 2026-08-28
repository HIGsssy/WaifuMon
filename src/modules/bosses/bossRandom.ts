/**
 * Deterministic draws for boss encounters.
 *
 * Every random quantity a resolution produces — the performance modifier and
 * every boss reward group's gate and pick — is derived rather than rolled,
 * from identifiers that never change plus a versioned salt. This is the same
 * technique the Seductive Power backfill uses, and it is here for the same
 * reason: **resolution must be retryable**. A process that dies halfway
 * through paying out an encounter has to be able to come back and finish, and
 * "finish" only means anything if the second attempt computes the same
 * numbers as the first.
 *
 * The alternative — rolling once and persisting the result before it is used —
 * would work too, but it makes every retry depend on a write having landed at
 * exactly the right moment. Deriving instead means the numbers are a pure
 * function of `(encounterId, participationId, purpose, salt)`, so a retry
 * cannot diverge even if nothing at all was written.
 *
 * `participationId` is in the key so two players in one encounter draw
 * independently, and `purpose` is in it so the damage roll and every reward
 * draw are independent of each other rather than several views of one number.
 * A reward purpose carries its group id and roll index for the same reason —
 * `reward:rare-bonus:0:gate` and `reward:rare-bonus:0:pick` are two separate
 * quantities about the same group.
 *
 * md5 is a distribution function here, not a security primitive.
 */
import { createHash } from 'node:crypto';

/**
 * Versioned salt for every boss draw.
 *
 * Frozen: changing it re-rolls every not-yet-resolved encounter and would make
 * a mid-flight retry disagree with its first attempt. A future re-model
 * introduces `v2` alongside it rather than editing this string.
 */
export const BOSS_RANDOM_SALT = 'waifumon.boss.roll.v1';

/**
 * What a draw is *for* — keeps independent quantities independent.
 *
 * The reward variants are open-ended because reward groups are authored in
 * content: a table may declare any number of them, and each group's every roll
 * needs its own key or two groups would draw the same number. The template
 * literal keeps the namespace closed at the top level (a bare typo is still a
 * type error) while letting the group id and roll index vary.
 */
export type BossDrawPurpose = 'performance' | `reward:${string}`;

/** Hex digits taken from the digest — 8 = 32 bits. */
const HASH_HEX_DIGITS = 8;
const HASH_SPACE = 2 ** 32;

/**
 * The 32-bit unsigned integer for one draw. Exported so tests can pin the
 * derivation itself rather than only its consequences.
 */
export function bossDrawHash(
  encounterId: number,
  participationId: number,
  purpose: BossDrawPurpose,
  salt: string = BOSS_RANDOM_SALT,
): number {
  const digest = createHash('md5')
    .update(`${encounterId}:${participationId}:${purpose}:${salt}`, 'utf8')
    .digest('hex');
  return Number.parseInt(digest.slice(0, HASH_HEX_DIGITS), 16);
}

/**
 * A uniform integer in `[min, max]`, inclusive at both ends.
 *
 * Used for the performance modifier, which is drawn as an integer 85–115 and
 * *interpreted* as hundredths rather than being drawn as a float. That is what
 * keeps the endpoints exactly reachable: a float draw would make 1.15 a
 * measure-zero event and 0.85 an accident of rounding.
 *
 * Modulo bias over a 31-wide span against 2^32 is ~1 part in 138 million.
 */
export function bossDrawInt(
  encounterId: number,
  participationId: number,
  purpose: BossDrawPurpose,
  min: number,
  max: number,
  salt: string = BOSS_RANDOM_SALT,
): number {
  if (max < min) throw new RangeError(`bossDrawInt: max ${max} < min ${min}`);
  const span = max - min + 1;
  return min + (bossDrawHash(encounterId, participationId, purpose, salt) % span);
}

/**
 * A uniform fraction in `[0, 1)` — the shape `rollWeighted` and a probability
 * check both want. Derived from the same hash space, so it carries the same
 * retry guarantee as the integer draw.
 */
export function bossDrawFraction(
  encounterId: number,
  participationId: number,
  purpose: BossDrawPurpose,
  salt: string = BOSS_RANDOM_SALT,
): number {
  return bossDrawHash(encounterId, participationId, purpose, salt) / HASH_SPACE;
}

/**
 * An {@link import('../../shared/random').Rng} pinned to one draw.
 *
 * Lets a deterministic draw be handed to `rollWeighted`, which is the
 * repository's one weighted-pick utility and the thing every other loot table
 * already goes through. The returned generator yields the *same* value every
 * call rather than a stream: one draw, one purpose, and a caller that needs a
 * second independent value asks for a second purpose instead.
 */
export function bossDrawRng(
  encounterId: number,
  participationId: number,
  purpose: BossDrawPurpose,
  salt: string = BOSS_RANDOM_SALT,
): { next(): number; intInclusive(min: number, max: number): number } {
  return {
    next: () => bossDrawFraction(encounterId, participationId, purpose, salt),
    intInclusive: (min, max) =>
      bossDrawInt(encounterId, participationId, purpose, min, max, salt),
  };
}
