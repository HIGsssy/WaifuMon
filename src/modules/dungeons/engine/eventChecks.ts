/**
 * The SP check of a dungeon event choice. Dungeon-owned and integer-only.
 *
 * The author sets the success chance of an average Buddy; the participating
 * Buddy's **pinned** SP moves it by a bounded amount either way:
 *
 *   spTerm = trunc(maxSpModifier × clamp(SP − 200, −150, +150) / 150)
 *   chance = clamp(baseChance + spTerm, 5%, 95%)
 *
 * all in basis points. The curve — neutral at 200 SP, full effect 150 SP
 * either side, never certain — is the one World Encounters calibrated against
 * the live SP model; the constants are restated here rather than imported so
 * the two systems stay independent (a unit test keeps them equal).
 *
 * The roll comes from a stream keyed by room, action and choice, so the same
 * run gives the same result for the same choice however often it is asked.
 */
import { BASIS_POINTS, type DungeonEventCheck } from '../content/dungeonDefinition';
import type { DungeonEventCheckResult, DungeonRngSource } from './types';

/** The SP at which Buddy strength neither helps nor hurts. */
export const EVENT_SP_NEUTRAL = 200;
/** The SP distance from neutral at which the modifier reaches its full size. */
export const EVENT_SP_SPREAD = 150;
/** A check is never certain. Certainty is a choice with no check. */
export const EVENT_CHECK_MIN_CHANCE_BASIS_POINTS = 500;
export const EVENT_CHECK_MAX_CHANCE_BASIS_POINTS = 9500;

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** The success chance in basis points. A fighter with no pinned SP takes the full negative modifier. */
export function eventCheckChance(check: DungeonEventCheck, currentSp: number | null | undefined): number {
  const distance = currentSp == null ? -EVENT_SP_SPREAD : clamp(currentSp - EVENT_SP_NEUTRAL, -EVENT_SP_SPREAD, EVENT_SP_SPREAD);
  const spTerm = Math.trunc((check.maxSpModifierBasisPoints * distance) / EVENT_SP_SPREAD);
  return clamp(check.baseChanceBasisPoints + spTerm, EVENT_CHECK_MIN_CHANCE_BASIS_POINTS, EVENT_CHECK_MAX_CHANCE_BASIS_POINTS);
}

export function rollEventCheck(
  check: DungeonEventCheck,
  currentSp: number | null | undefined,
  place: { roomId: string; actionId: string; choiceId: string },
  rng: DungeonRngSource,
): DungeonEventCheckResult {
  const chanceBasisPoints = eventCheckChance(check, currentSp);
  const roll = rng.stream('event', place.roomId, place.actionId, 'check', place.choiceId).intInclusive(0, BASIS_POINTS - 1);
  return { sp: currentSp ?? null, chanceBasisPoints, roll, success: roll < chanceBasisPoints };
}
