/**
 * Equipment instance generation and naming — the pure domain module.
 *
 * A definition describes a *range* of multipliers (`min`…`max` in `step`s of
 * basis points); each owned instance stores the one value it rolled
 * (`player_equipment.rolled_multiplier_bp`) and, optionally, a flavour affix
 * (`affix_key`). The instance's value is the only one combat ever reads.
 *
 * Every source of loot — onboarding today, bosses, expeditions and shops later
 * — goes through {@link rollEquipmentInstance} (via `grantEquipment`), so RNG
 * is never scattered across reward systems, and through
 * {@link validateFixedRoll} when the caller dictates the roll instead.
 *
 * No DB, no Discord. The RNG is injected, so tests are deterministic.
 */
import { EquipmentAffixPoolEmptyError, type EquipmentIssue } from '../../shared/errors';
import type { Rng } from '../../shared/random';
import { affixPoolOf, isEquipmentAffixPool, type EquipmentAffixCatalogue } from './affixCatalogue';
import { EQUIPMENT_MULTIPLIER_BP_MAX, isEquipmentSlot, type EquipmentSlot } from './vocabulary';

/** A definition's configured multiplier range, in basis points. */
export interface MultiplierRange {
  multiplierMinBp: number;
  multiplierMaxBp: number;
  multiplierStepBp: number;
}

/** The rolled properties an instance owns. */
export interface EquipmentRoll {
  rolledMultiplierBp: number;
  affixKey: string | null;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Everything wrong with a range for a definition in `slot`, by field name.
 * Shared by definition validation and the grant path, so a range the grant
 * accepts is exactly a range authoring accepts.
 */
export function multiplierRangeIssues(slot: EquipmentSlot | string, range: MultiplierRange): EquipmentIssue[] {
  const issues: EquipmentIssue[] = [];
  const { multiplierMinBp: min, multiplierMaxBp: max, multiplierStepBp: step } = range;
  if (!isInt(min) || min <= 0) issues.push({ path: 'multiplierMinBp', message: 'must be a positive whole number of basis points' });
  if (!isInt(max) || max <= 0) issues.push({ path: 'multiplierMaxBp', message: 'must be a positive whole number of basis points' });
  if (!isInt(step) || step <= 0) issues.push({ path: 'multiplierStepBp', message: 'must be a positive whole number of basis points' });
  if (issues.length > 0) return issues;
  if (max < min) issues.push({ path: 'multiplierMaxBp', message: `must be at least multiplierMinBp (${min})` });
  else if ((max - min) % step !== 0) {
    issues.push({
      path: 'multiplierStepBp',
      message: `must divide the range evenly (${max} - ${min} = ${max - min} is not a multiple of ${step})`,
    });
  }
  if (isEquipmentSlot(slot) && max > EQUIPMENT_MULTIPLIER_BP_MAX[slot]) {
    const cap = EQUIPMENT_MULTIPLIER_BP_MAX[slot];
    issues.push({ path: 'multiplierMaxBp', message: `must be at most ${cap} (×${cap / 10_000}) for ${slot} gear` });
  }
  return issues;
}

/** Every value a range can roll, ascending. `4000–6000 / 500` → `[4000, 4500, 5000, 5500, 6000]`. */
export function multiplierValues(range: MultiplierRange): number[] {
  const { multiplierMinBp: min, multiplierMaxBp: max, multiplierStepBp: step } = range;
  const values: number[] = [];
  for (let v = min; v <= max; v += step) values.push(v);
  return values;
}

/** Whether `bp` is one of the range's discrete values. */
export function isMultiplierInRange(range: MultiplierRange, bp: number): boolean {
  const { multiplierMinBp: min, multiplierMaxBp: max, multiplierStepBp: step } = range;
  return isInt(bp) && bp >= min && bp <= max && (bp - min) % step === 0;
}

/** What a roll needs to know about a definition. */
export type RollableDefinition = MultiplierRange & { key: string; slot: EquipmentSlot | string; rarity: string };

/**
 * Roll the properties of one new instance: a uniformly chosen discrete
 * multiplier, and — independently — a uniformly chosen **enabled** affix from
 * the definition's own pool (`slot.rarity`). Every random item is affixed;
 * there is no fallback to another rarity, slot or pool.
 *
 * The affix is checked before anything is drawn, so a failed roll consumes no
 * randomness.
 *
 * @throws {EquipmentAffixPoolEmptyError} when the derived pool is not a
 * supported pool, or has no enabled affix — a content error, never papered
 * over with an unaffixed item.
 * @throws {RangeError} for a range that is not valid — a definition that
 * reached the grant path without passing validation is a bug to surface.
 */
export function rollEquipmentInstance(
  definition: RollableDefinition,
  opts: { rng: Rng; affixes: EquipmentAffixCatalogue },
): EquipmentRoll {
  const issues = multiplierRangeIssues(definition.slot, definition);
  if (issues.length > 0) {
    throw new RangeError(`cannot roll an invalid multiplier range: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  }
  const pool = affixPoolOf(definition);
  if (!isEquipmentAffixPool(pool)) throw new EquipmentAffixPoolEmptyError(definition.key, pool, 'unsupported');
  const candidates = opts.affixes.rollable(pool);
  if (candidates.length === 0) throw new EquipmentAffixPoolEmptyError(definition.key, pool, 'empty');

  const steps = (definition.multiplierMaxBp - definition.multiplierMinBp) / definition.multiplierStepBp;
  const rolledMultiplierBp = definition.multiplierMinBp + opts.rng.intInclusive(0, steps) * definition.multiplierStepBp;
  const affixKey = candidates[opts.rng.intInclusive(0, candidates.length - 1)]!.key;
  return { rolledMultiplierBp, affixKey };
}

/**
 * Problems with a caller-dictated roll (onboarding, admin tools,
 * compensation). The multiplier must be one of the definition's own discrete
 * values, and the affix null or a catalogued affix **of the definition's own
 * pool** — the caller names a key, never a pool. Retired (disabled) affixes
 * are allowed, deliberately: restoring a copy someone lost is exactly what a
 * fixed grant is for, and random acquisition never sees them.
 *
 * Checks the runtime shape too: this is the gate a client-influenced value
 * would have to pass, so a string, float or extra field is refused rather
 * than coerced.
 */
export function validateFixedRoll(
  definition: MultiplierRange & { slot: string; rarity: string },
  roll: unknown,
  affixes: EquipmentAffixCatalogue,
): EquipmentIssue[] {
  if (roll == null || typeof roll !== 'object' || Array.isArray(roll)) {
    return [{ path: 'roll', message: 'must be an object with rolledMultiplierBp and affixKey' }];
  }
  const r = roll as Record<string, unknown>;
  const issues: EquipmentIssue[] = [];
  const unknown = Object.keys(r).filter((k) => k !== 'rolledMultiplierBp' && k !== 'affixKey');
  if (unknown.length > 0) issues.push({ path: 'roll', message: `unknown field(s): ${unknown.join(', ')}` });
  if (!isMultiplierInRange(definition, r.rolledMultiplierBp as number)) {
    issues.push({
      path: 'roll.rolledMultiplierBp',
      message:
        `must be one of ${definition.multiplierMinBp}–${definition.multiplierMaxBp} ` +
        `in steps of ${definition.multiplierStepBp}, got ${JSON.stringify(r.rolledMultiplierBp)}`,
    });
  }
  if (r.affixKey !== null) {
    const affix = typeof r.affixKey === 'string' ? affixes.get(r.affixKey) : undefined;
    const pool = affixPoolOf(definition);
    if (!affix) {
      issues.push({ path: 'roll.affixKey', message: `must be null or a catalogued affix key, got ${JSON.stringify(r.affixKey)}` });
    } else if (affix.pool !== pool) {
      issues.push({
        path: 'roll.affixKey',
        message: `affix "${affix.key}" belongs to pool ${affix.pool}; this definition rolls from ${pool}`,
      });
    }
  }
  return issues;
}

/** Shown in place of a suffix whose key the catalogue no longer knows. */
export const UNKNOWN_AFFIX_LABEL = '[Unknown Affix]';

/**
 * The one way an instance's name is shown: `definition.name + ' ' + suffix`
 * (the suffix is complete text — nothing is prepended), or the base name when
 * unaffixed. A retired affix still renders.
 *
 * An affix key the catalogue no longer knows (deleted rather than retired) is
 * a content error: the name carries a visible `[Unknown Affix]` marker so the
 * copy is never silently mistaken for an unaffixed one, and the miss is
 * reported through the catalogue's `onUnknownKey`. The instance itself is
 * never touched.
 */
export function equipmentDisplayName(
  baseName: string,
  affixKey: string | null,
  affixes: EquipmentAffixCatalogue,
): string {
  if (affixKey == null) return baseName;
  const affix = affixes.resolveOwned(affixKey);
  return `${baseName} ${affix ? affix.suffix : UNKNOWN_AFFIX_LABEL}`;
}

/**
 * Roll quality — where a copy's roll sits within its definition's configured
 * range, as a whole percentage. **Display only**: nothing in combat, rewards
 * or ordering of loot reads it, and it never replaces the multiplier itself.
 *
 *   quality = (rolled − min) / (max − min), mapped to 0–100 and rounded
 *
 * A single-value range (`min == max`) is 100%: the copy rolled the best — the
 * only — value there was. Uses the definition's *current* range, so a copy
 * that a later retune left outside it is clamped into 0–100 rather than
 * reported as −20% or 130%.
 *
 * `ROLL_QUALITY_SQL` in `equipmentService.ts` sorts by the same formula.
 */
export function rollQualityPercent(
  range: Pick<MultiplierRange, 'multiplierMinBp' | 'multiplierMaxBp'>,
  rolledMultiplierBp: number,
): number {
  const { multiplierMinBp: min, multiplierMaxBp: max } = range;
  if (max <= min) return 100;
  const ratio = (rolledMultiplierBp - min) / (max - min);
  return Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
}
