/**
 * Combat math — the one place damage is calculated and rounded.
 *
 *   rawDamage = ATK × (DEFENSE_SCALING / (DEFENSE_SCALING + DEF))
 *   damage    = max(MIN_DAMAGE, round(rawDamage))
 *
 * DEF has diminishing returns: 100 DEF halves incoming damage, 300 DEF
 * quarters it, and no amount of DEF reaches zero. `round` is `Math.round`
 * (halves round up — all inputs are non-negative). Presenters and controllers
 * never round; they report the integer this module returns.
 *
 * ## Damage variance
 *
 * A landed hit then rolls a factor in the fight's `rules.damageVariance`
 * range (90%–110% by default), in whole basis points, both ends inclusive:
 *
 *   base   = max(MIN_DAMAGE, round(rawDamage))            — exactly as above
 *   roll   = rng.intInclusive(minBasisPoints, maxBasisPoints)
 *   damage = max(MIN_DAMAGE, floor((base × roll + 5000) / 10000))
 *
 * So: base damage is rounded first, the roll multiplies the *rounded* base,
 * the product is rounded half-up in integer arithmetic, and the minimum is
 * applied last. One roll per damage instance, drawn from the injected `Rng`
 * only — the same state, actions and seed give the same fight.
 *
 * No state and no runtime imports; the only randomness is the `Rng` passed in.
 */
import type { Rng } from '../../shared/random';

/** The DEF value at which incoming damage is halved. */
export const DEFENSE_SCALING = 100;

/** Every landed hit does at least this much. */
export const MIN_DAMAGE = 1;

/** The unrounded basic-attack damage. Exposed for tests and tuning tools. */
export function rawBasicAttackDamage(attack: number, defense: number): number {
  return attack * (DEFENSE_SCALING / (DEFENSE_SCALING + defense));
}

/** The single rounding rule for damage. */
export function roundDamage(raw: number): number {
  return Math.max(MIN_DAMAGE, Math.round(raw));
}

/** Integer damage a basic attack from `attack` deals into `defense`. */
export function basicAttackDamage(attack: number, defense: number): number {
  return roundDamage(rawBasicAttackDamage(attack, defense));
}

/** 10,000 basis points = ×1.00. */
export const DAMAGE_BASIS_POINTS = 10_000;

/** The range a hit's damage factor is rolled in, in basis points, inclusive. */
export interface DamageVariance {
  minBasisPoints: number;
  maxBasisPoints: number;
}

/** Initial tuning: every hit lands for 90%–110% of its base damage. */
export const DEFAULT_DAMAGE_VARIANCE: DamageVariance = Object.freeze({
  minBasisPoints: 9_000,
  maxBasisPoints: 11_000,
});

/** Every hit lands for exactly its base damage. For tools and tests that need fixed numbers. */
export const NO_DAMAGE_VARIANCE: DamageVariance = Object.freeze({
  minBasisPoints: DAMAGE_BASIS_POINTS,
  maxBasisPoints: DAMAGE_BASIS_POINTS,
});

/** The widest factor a fight's rules may carry (×3.00). */
export const DAMAGE_VARIANCE_LIMIT_BASIS_POINTS = 30_000;

export function isValidDamageVariance(value: unknown): value is DamageVariance {
  if (typeof value !== 'object' || value === null) return false;
  const { minBasisPoints: min, maxBasisPoints: max } = value as Partial<DamageVariance>;
  return (
    Number.isSafeInteger(min) &&
    Number.isSafeInteger(max) &&
    (min as number) >= 1 &&
    (min as number) <= (max as number) &&
    (max as number) <= DAMAGE_VARIANCE_LIMIT_BASIS_POINTS
  );
}

/** `base × factor`, rounded half-up, never below {@link MIN_DAMAGE}. */
export function applyDamageVariance(baseDamage: number, varianceBasisPoints: number): number {
  return Math.max(MIN_DAMAGE, Math.floor((baseDamage * varianceBasisPoints + DAMAGE_BASIS_POINTS / 2) / DAMAGE_BASIS_POINTS));
}

/** One hit's damage, with the roll that produced it. */
export interface DamageRoll {
  /** {@link basicAttackDamage}: the deterministic damage before variance. */
  base: number;
  /** The factor rolled, in basis points. */
  varianceBasisPoints: number;
  /** What the hit deals. */
  amount: number;
}

/**
 * Roll one basic attack: the deterministic base, one draw from `rng` for the
 * factor, and the result. The only place a damage roll is made.
 */
export function rollBasicAttackDamage(
  attack: number,
  defense: number,
  variance: DamageVariance,
  rng: Rng,
): DamageRoll {
  const base = basicAttackDamage(attack, defense);
  const varianceBasisPoints = rng.intInclusive(variance.minBasisPoints, variance.maxBasisPoints);
  return { base, varianceBasisPoints, amount: applyDamageVariance(base, varianceBasisPoints) };
}

/** HP after taking `damage`, clamped at zero. */
export function hpAfterDamage(currentHp: number, damage: number): number {
  return Math.max(0, currentHp - damage);
}
