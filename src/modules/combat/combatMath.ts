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
 * Pure: no state, no RNG, no imports.
 */

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

/** HP after taking `damage`, clamped at zero. */
export function hpAfterDamage(currentHp: number, damage: number): number {
  return Math.max(0, currentHp - damage);
}
