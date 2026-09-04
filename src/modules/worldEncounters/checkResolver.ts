/**
 * Check resolver — the one place SP-based encounter checks are computed.
 *
 * Centralised so every surface (Discord runtime, admin preview, tests) reads
 * the same formula. The buddy's species SP is never mutated: this reads
 * `currentSp` off the passed-in profile and returns a resolution the caller
 * either applies effects for or discards (preview / simulation).
 *
 * Future equipment will extend this by pushing extra terms into the breakdown
 * (attack, defense, evasion). Today's implementation deliberately touches
 * only fields already present in the domain — nothing here reads a table that
 * does not yet exist.
 */
import type { Rng } from '../../shared/random';
import type { CheckResolution, CheckSpec, EncounterCheckContext } from './types';

/** Base success chance before any modifiers. Deliberately dead-centre. */
const BASE_CHANCE = 0.5;

/** Divisor turning (currentSp - difficulty) into a probability shift. */
const SP_DIVISOR = 200;

/** Divisor turning buddy level (above 1) into a small linear boost. */
const LEVEL_DIVISOR = 100;

/** Additive advantage when buddy affinity matches choice's affinityAdvantage. */
const AFFINITY_ADVANTAGE = 0.15;

/** Additive advantage when any of buddy's race tags match choice's raceAdvantage. */
const RACE_ADVANTAGE = 0.1;

/** Hard clamps — the engine must never claim certainty in either direction. */
const MIN_CHANCE = 0.05;
const MAX_CHANCE = 0.95;

/** Clamp helper. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Resolve a check *without* rolling — used by the admin preview and by
 * simulate endpoints. `roll` is null in the result.
 */
export function computeChance(check: CheckSpec, ctx: EncounterCheckContext): CheckResolution {
  if (check.type === 'none') {
    return {
      chance: 1,
      roll: 0,
      success: true,
      breakdown: {
        base: 1,
        spTerm: 0,
        levelTerm: 0,
        affinityMod: 0,
        raceMod: 0,
        buddyBonusMod: 0,
        baseBias: 0,
      },
    };
  }

  const buddy = ctx.buddy;
  const spTerm = buddy
    ? clamp((buddy.currentSp - check.difficulty) / SP_DIVISOR, -0.4, 0.4)
    : -0.3; // Substantial penalty for facing an SP check with no buddy.
  const levelTerm = buddy ? Math.min(0.2, Math.max(0, (buddy.level - 1) / LEVEL_DIVISOR)) : 0;
  const affinityMod =
    buddy && check.affinityAdvantage && buddy.affinity === check.affinityAdvantage
      ? AFFINITY_ADVANTAGE
      : 0;
  const raceMod =
    buddy &&
    check.raceAdvantage &&
    check.raceAdvantage.some((tag) => buddy.raceTags.includes(tag))
      ? RACE_ADVANTAGE
      : 0;
  const buddyBonusMod = ctx.buddyBonusPercent / 100;
  const baseBias = check.baseBias ?? 0;

  const raw =
    BASE_CHANCE + spTerm + levelTerm + affinityMod + raceMod + buddyBonusMod + baseBias;
  const chance = clamp(raw, MIN_CHANCE, MAX_CHANCE);

  return {
    chance,
    roll: 0,
    success: true, // overwritten by rollCheck; irrelevant here
    breakdown: { base: BASE_CHANCE, spTerm, levelTerm, affinityMod, raceMod, buddyBonusMod, baseBias },
  };
}

/**
 * Roll a check and return the full resolution. Uses the injected RNG so tests
 * drive it deterministically.
 */
export function rollCheck(
  check: CheckSpec,
  ctx: EncounterCheckContext,
  rng: Rng,
): CheckResolution {
  const computed = computeChance(check, ctx);
  if (check.type === 'none') return computed;
  const roll = rng.next();
  return { ...computed, roll, success: roll < computed.chance };
}
