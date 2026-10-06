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
 * ## Combat modifiers
 *
 * A combatant may carry five secondary modifiers (`CombatModifiers`, basis
 * points). With all five at zero every formula below reduces to the two
 * above, draw for draw. One strike, in order:
 *
 *   effDEF = floor(DEF × (10000 − armorPenetrationBp) / 10000)        — ≥ 0; DEF itself is never changed
 *   base   = max(MIN_DAMAGE, round(ATK × 100 / (100 + effDEF)))
 *   varied = max(MIN_DAMAGE, floor((base × roll + 5000) / 10000))     — the ±10% variance
 *   crit?  = critChanceBp > 0 and rng.intInclusive(1, 10000) <= critChanceBp
 *   damage = crit ? max(MIN_DAMAGE, floor((varied × critMult + 5000) / 10000)) : varied
 *            where critMult = BASE_CRIT_DAMAGE_BP + critDamageBonusBp   (×1.50 base)
 *   dealt  = min(damage, target current HP)                            — the HP actually removed
 *   heal   = min(floor((dealt × lifestealBp + 5000) / 10000), max HP − current HP)
 *
 * Every rounding is half-up in integer arithmetic. The Crit multiplier
 * applies *after* mitigation and variance, to the already-rounded varied
 * damage; Crit Damage bonuses were summed before they got here and are never
 * multiplied one by one. Lifesteal reads the HP actually removed — an 100
 * damage hit into 30 HP heals from 30 — and never overheals.
 *
 * A chance of zero draws nothing, so a combatant without modifiers consumes
 * exactly the one variance draw per strike it always did.
 *
 * {@link COMBAT_MODIFIER_CAPS} are hard safety ceilings, not targets.
 * {@link clampCombatModifiers} is the one place they are applied.
 *
 * No state and no runtime imports; the only randomness is the `Rng` passed in.
 */
import type { Rng } from '../../shared/random';
import type { CombatModifiers } from './combatTypes';

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

// ── combat modifiers ──────────────────────────────────────────────────────

/** A Crit with no Crit Damage bonus deals ×1.50. Combat rules, not Equipment. */
export const BASE_CRIT_DAMAGE_BP = 15_000;

/** The highest total Crit multiplier a combatant may reach (×2.50). */
export const MAX_TOTAL_CRIT_DAMAGE_BP = 25_000;

/**
 * Hard safety ceilings on a combatant's final modifiers. Not tuning targets:
 * gear ranges sit far below them. `critDamageBonusBp` is capped so the total
 * Crit multiplier never exceeds {@link MAX_TOTAL_CRIT_DAMAGE_BP}.
 */
export const COMBAT_MODIFIER_CAPS: Readonly<CombatModifiers> = Object.freeze({
  critChanceBp: 5_000,
  critDamageBonusBp: MAX_TOTAL_CRIT_DAMAGE_BP - BASE_CRIT_DAMAGE_BP,
  doubleAttackChanceBp: 3_500,
  armorPenetrationBp: 5_000,
  lifestealBp: 2_000,
});

/** The five modifier keys, in display order. */
export const COMBAT_MODIFIER_KEYS = [
  'critChanceBp',
  'critDamageBonusBp',
  'doubleAttackChanceBp',
  'armorPenetrationBp',
  'lifestealBp',
] as const satisfies readonly (keyof CombatModifiers)[];

/** No modifiers: the default for every combatant. */
export const ZERO_COMBAT_MODIFIERS: Readonly<CombatModifiers> = Object.freeze({
  critChanceBp: 0,
  critDamageBonusBp: 0,
  doubleAttackChanceBp: 0,
  armorPenetrationBp: 0,
  lifestealBp: 0,
});

/**
 * Whole, non-negative basis points for all five keys, each within its cap.
 * What the engine requires of a combatant's `modifiers`.
 */
export function isValidCombatModifiers(value: unknown): value is CombatModifiers {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return COMBAT_MODIFIER_KEYS.every((key) => {
    const n = v[key];
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= COMBAT_MODIFIER_CAPS[key];
  });
}

/**
 * The one place the safety caps are applied: each key clamped into
 * `0…cap`, a missing key read as 0. The input is never mutated.
 *
 * @throws {RangeError} for a value that is not a whole number — totals are
 * sums of integer basis points, so a fraction is a bug upstream.
 */
export function clampCombatModifiers(raw: Partial<CombatModifiers> | null | undefined): CombatModifiers {
  const out = { ...ZERO_COMBAT_MODIFIERS };
  for (const key of COMBAT_MODIFIER_KEYS) {
    const n = raw?.[key] ?? 0;
    if (!Number.isSafeInteger(n)) throw new RangeError(`${key} must be whole basis points, got ${String(n)}`);
    out[key] = Math.min(Math.max(n, 0), COMBAT_MODIFIER_CAPS[key]);
  }
  return out;
}

/** The total Crit multiplier: the ×1.50 base plus the combatant's bonus. */
export function critMultiplierBp(modifiers: Pick<CombatModifiers, 'critDamageBonusBp'>): number {
  return BASE_CRIT_DAMAGE_BP + modifiers.critDamageBonusBp;
}

/** The DEF the damage formula uses once Armor Penetration is applied. Never below 0. */
export function effectiveDefense(defense: number, armorPenetrationBp: number): number {
  return Math.max(0, Math.floor((defense * (DAMAGE_BASIS_POINTS - armorPenetrationBp)) / DAMAGE_BASIS_POINTS));
}

/** `damage × multiplier`, rounded half-up, never below {@link MIN_DAMAGE}. */
export function applyCritMultiplier(damage: number, multiplierBp: number): number {
  return Math.max(MIN_DAMAGE, Math.floor((damage * multiplierBp + DAMAGE_BASIS_POINTS / 2) / DAMAGE_BASIS_POINTS));
}

/** Whether a `chanceBp` roll succeeds. Zero (or less) draws nothing. */
export function rollChance(chanceBp: number, rng: Rng): boolean {
  if (chanceBp <= 0) return false;
  return rng.intInclusive(1, DAMAGE_BASIS_POINTS) <= chanceBp;
}

/** The lifesteal heal for `damageDealt` HP actually removed, before the max-HP clamp. Half-up. */
export function lifestealAmount(damageDealt: number, lifestealBp: number): number {
  if (lifestealBp <= 0 || damageDealt <= 0) return 0;
  return Math.floor((damageDealt * lifestealBp + DAMAGE_BASIS_POINTS / 2) / DAMAGE_BASIS_POINTS);
}

/** One strike's damage, with everything that produced it. */
export interface StrikeRoll extends DamageRoll {
  targetDefense: number;
  effectiveDefense: number;
  armorPenetrationBp: number;
  /** `base` × the rolled factor — the damage before any Crit. */
  variedAmount: number;
  critical: boolean;
  /** The multiplier applied: the Crit multiplier on a Crit, 10000 otherwise. */
  critMultiplierBp: number;
}

/**
 * Roll one strike under the attacker's modifiers: Armor Penetration, the
 * variance draw, then the Crit draw (only when there is a chance). The only
 * place a strike's damage is decided.
 */
export function rollStrike(
  attack: number,
  defense: number,
  modifiers: CombatModifiers,
  variance: DamageVariance,
  rng: Rng,
): StrikeRoll {
  const effDef = effectiveDefense(defense, modifiers.armorPenetrationBp);
  const { base, varianceBasisPoints, amount: variedAmount } = rollBasicAttackDamage(attack, effDef, variance, rng);
  const critical = rollChance(modifiers.critChanceBp, rng);
  const multiplier = critical ? critMultiplierBp(modifiers) : DAMAGE_BASIS_POINTS;
  return {
    base,
    varianceBasisPoints,
    variedAmount,
    amount: critical ? applyCritMultiplier(variedAmount, multiplier) : variedAmount,
    targetDefense: defense,
    effectiveDefense: effDef,
    armorPenetrationBp: modifiers.armorPenetrationBp,
    critical,
    critMultiplierBp: multiplier,
  };
}

/** HP after taking `damage`, clamped at zero. */
export function hpAfterDamage(currentHp: number, damage: number): number {
  return Math.max(0, currentHp - damage);
}
