/**
 * Equipment combat bonuses — the secondary, mechanical rolls an owned instance
 * may carry beside its primary multiplier ("+4.25% Crit Chance").
 *
 *   Equipment instance
 *   ├── rolled primary multiplier
 *   ├── affix identity            — flavour only, one key, unchanged
 *   └── 0–2 combat bonuses        — this module
 *
 * **An affix is not a bonus.** The affix catalogue stays a list of flavour
 * suffixes; nothing here reads an affix and no affix names a stat. The two
 * roll independently, so an SR copy has one name and two bonuses.
 *
 * ## The catalogue (`content/equipment/combatBonuses.json`)
 *
 * Deployed content, read by the content loader and followed live through
 * `getContent()`, like the affix catalogue and the Workshop config. Three
 * parts, none of them duplicated per affix or per definition:
 *
 *  - `rarityRules` — per rarity, how many bonuses a random copy gets
 *    (`bonusCount`) and the chance it gets them at all (`bonusChanceBp`).
 *    N is the only rarity below 100%.
 *  - `bonuses` — the five families. Each carries one discrete range per
 *    rarity (`minBp`…`maxBp` in `stepBp` steps) — rarity controls magnitude.
 *  - `eligibility` — per slot, which families that slot's gear may roll. A
 *    definition's bonus pool is derived from its slot and rarity, exactly as
 *    its affix pool is; nothing is stored on the definition.
 *
 * Validation guarantees every pool (`<slot>.<rarity>`) can supply
 * `bonusCount` **distinct** families, so an SR copy never needs the same stat
 * twice. The same family on two different equipped items stacks, on purpose.
 *
 * ## The instance owns its rolls
 *
 * `rollCombatBonuses` runs once, at grant, after the multiplier and affix
 * draws. The result is stored on the row (`player_equipment.combat_bonuses`)
 * and never recomputed: retuning a range changes future drops only. Copies
 * that predate the system carry `[]` and stay fully usable.
 *
 * ## Aggregation
 *
 * {@link aggregateCombatBonuses} is the one place equipped bonuses become a
 * combatant's `CombatModifiers`: additive per family, zero by default, then
 * the combat-rule safety caps (`clampCombatModifiers`). Stored rolls are never
 * touched by a cap. Discord, the Portal, Trials, Delve and the simulators all
 * read its result; none of them adds basis points themselves.
 *
 * Kept free of database imports so the content loader can validate the file.
 */
import { z } from 'zod';
import type { EquipmentIssue } from '../../shared/errors';
import type { Rng } from '../../shared/random';
import {
  BASE_CRIT_DAMAGE_BP,
  COMBAT_MODIFIER_CAPS,
  COMBAT_MODIFIER_KEYS,
  ZERO_COMBAT_MODIFIERS,
  clampCombatModifiers,
} from '../combat/combatMath';
import type { CombatModifiers } from '../combat/combatTypes';
import { EQUIPMENT_AFFIX_RARITIES } from './affixCatalogue';
import { EQUIPMENT_SLOTS, type EquipmentSlot } from './vocabulary';

// ── vocabulary ────────────────────────────────────────────────────────────

/**
 * The five bonus families, by stable storage key, in canonical order. Stored
 * on instances forever: a key is never renamed, and player-facing wording
 * lives in {@link COMBAT_BONUS_LABELS}, not here.
 */
export const COMBAT_BONUS_STATS = [
  'crit_chance_bp',
  'crit_damage_bonus_bp',
  'double_attack_chance_bp',
  'armor_penetration_bp',
  'lifesteal_bp',
] as const;
export type CombatBonusStat = (typeof COMBAT_BONUS_STATS)[number];

export function isCombatBonusStat(value: unknown): value is CombatBonusStat {
  return typeof value === 'string' && (COMBAT_BONUS_STATS as readonly string[]).includes(value);
}

/** Which combatant modifier each family feeds. */
export const COMBAT_BONUS_MODIFIER: Readonly<Record<CombatBonusStat, keyof CombatModifiers>> = Object.freeze({
  crit_chance_bp: 'critChanceBp',
  crit_damage_bonus_bp: 'critDamageBonusBp',
  double_attack_chance_bp: 'doubleAttackChanceBp',
  armor_penetration_bp: 'armorPenetrationBp',
  lifesteal_bp: 'lifestealBp',
});

/** How a family reads on one item ("+4.25% Crit Chance"). */
export const COMBAT_BONUS_LABELS: Readonly<Record<CombatBonusStat, string>> = Object.freeze({
  crit_chance_bp: 'Crit Chance',
  crit_damage_bonus_bp: 'Crit Damage',
  double_attack_chance_bp: 'Double Attack',
  armor_penetration_bp: 'Armor Pen',
  lifesteal_bp: 'Lifesteal',
});

/** How a loadout total reads ("Crit: 9.75%"). */
export const COMBAT_MODIFIER_LABELS: Readonly<Record<keyof CombatModifiers, string>> = Object.freeze({
  critChanceBp: 'Crit',
  critDamageBonusBp: 'Crit DMG',
  doubleAttackChanceBp: 'Double',
  armorPenetrationBp: 'Armor Pen',
  lifestealBp: 'Lifesteal',
});

/** Most bonuses one instance may carry, however it was created. */
export const MAX_COMBAT_BONUSES_PER_ITEM = 2;

/**
 * The largest value one stored bonus may hold: its family's combat cap. A
 * single item can never be worth more than the whole loadout is allowed.
 */
export function maxCombatBonusValueBp(stat: CombatBonusStat): number {
  return COMBAT_MODIFIER_CAPS[COMBAT_BONUS_MODIFIER[stat]];
}

/** One rolled bonus, as stored on an instance. Integer basis points: 425 = 4.25%. */
export interface CombatBonus {
  stat: CombatBonusStat;
  valueBp: number;
}

const statRank = (stat: CombatBonusStat) => COMBAT_BONUS_STATS.indexOf(stat);

/**
 * Canonical order (the order of {@link COMBAT_BONUS_STATS}). Bonus order
 * carries no meaning, so every write stores this one: two copies with the
 * same bonuses are then byte-identical JSON and group as identical gear.
 */
export function sortCombatBonuses(bonuses: readonly CombatBonus[]): CombatBonus[] {
  return [...bonuses]
    .map((b) => ({ stat: b.stat, valueBp: b.valueBp }))
    .sort((a, b) => statRank(a.stat) - statRank(b.stat));
}

/**
 * Everything wrong with a bonus list an instance would store: at most
 * {@link MAX_COMBAT_BONUSES_PER_ITEM} entries, known and distinct families,
 * whole positive basis points no larger than the family's combat cap.
 *
 * Deliberately **not** checked against the rarity ranges: a fixed, admin or
 * restore grant states exactly what a copy carries (and SSR+ gear has no
 * ranges yet), so only the shape and the safety ceiling are enforced.
 */
export function combatBonusListIssues(value: unknown, path = 'combatBonuses'): EquipmentIssue[] {
  if (!Array.isArray(value)) return [{ path, message: 'must be an array of { stat, valueBp }' }];
  const issues: EquipmentIssue[] = [];
  if (value.length > MAX_COMBAT_BONUSES_PER_ITEM) {
    issues.push({ path, message: `at most ${MAX_COMBAT_BONUSES_PER_ITEM} combat bonuses per item, got ${value.length}` });
  }
  const seen = new Set<string>();
  value.forEach((entry: unknown, i) => {
    const at = `${path}[${i}]`;
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ path: at, message: 'must be an object with stat and valueBp' });
      return;
    }
    const e = entry as Record<string, unknown>;
    const unknown = Object.keys(e).filter((k) => k !== 'stat' && k !== 'valueBp');
    if (unknown.length > 0) issues.push({ path: at, message: `unknown field(s): ${unknown.join(', ')}` });
    if (!isCombatBonusStat(e.stat)) {
      issues.push({ path: `${at}.stat`, message: `must be one of ${COMBAT_BONUS_STATS.join(', ')}, got ${JSON.stringify(e.stat)}` });
      return;
    }
    if (seen.has(e.stat)) issues.push({ path: `${at}.stat`, message: `duplicate combat bonus "${e.stat}" on one item` });
    seen.add(e.stat);
    const max = maxCombatBonusValueBp(e.stat);
    if (typeof e.valueBp !== 'number' || !Number.isSafeInteger(e.valueBp) || e.valueBp < 1 || e.valueBp > max) {
      issues.push({
        path: `${at}.valueBp`,
        message: `must be whole basis points from 1 to ${max}, got ${JSON.stringify(e.valueBp)}`,
      });
    }
  });
  return issues;
}

/**
 * An instance's stored bonuses, as read from the row. Missing, null or
 * malformed data — a copy that predates the system — reads as **no bonuses**;
 * entries naming a family this build does not know are skipped rather than
 * invented. Never throws: an owned item must always load.
 */
export function readStoredCombatBonuses(value: unknown): CombatBonus[] {
  if (!Array.isArray(value)) return [];
  const out: CombatBonus[] = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object') continue;
    const { stat, valueBp } = entry as Record<string, unknown>;
    if (!isCombatBonusStat(stat) || out.some((b) => b.stat === stat)) continue;
    if (typeof valueBp !== 'number' || !Number.isSafeInteger(valueBp) || valueBp < 1) continue;
    out.push({ stat, valueBp });
  }
  return sortCombatBonuses(out);
}

// ── the catalogue file ────────────────────────────────────────────────────

/** Relative to the content directory. */
export const EQUIPMENT_COMBAT_BONUS_FILE = 'equipment/combatBonuses.json';
export const EQUIPMENT_COMBAT_BONUS_FILE_FORMAT = 'waifumon-equipment-combat-bonuses' as const;
export const EQUIPMENT_COMBAT_BONUS_FILE_VERSION = 1 as const;

/** Rarities random gear can roll bonuses at — exactly those with affix pools. SSR+ has no rules yet. */
export const COMBAT_BONUS_RARITIES = EQUIPMENT_AFFIX_RARITIES;
export type CombatBonusRarity = (typeof COMBAT_BONUS_RARITIES)[number];

export function isCombatBonusRarity(value: unknown): value is CombatBonusRarity {
  return typeof value === 'string' && (COMBAT_BONUS_RARITIES as readonly string[]).includes(value);
}

const BASIS_POINTS = 10_000;

const rarityRecord = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({ N: schema, R: schema, SR: schema }).strict();

const RarityRuleSchema = z
  .object({
    /** Chance a random copy of this rarity gets its bonuses at all. 10000 = always. */
    bonusChanceBp: z.number().int().min(0).max(BASIS_POINTS),
    /** How many bonuses it then gets — distinct families. */
    bonusCount: z.number().int().min(0).max(MAX_COMBAT_BONUSES_PER_ITEM),
  })
  .strict();
export type CombatBonusRarityRule = z.infer<typeof RarityRuleSchema>;

const BonusRangeSchema = z
  .object({ minBp: z.number().int().min(1), maxBp: z.number().int().min(1) })
  .strict();
export type CombatBonusRange = z.infer<typeof BonusRangeSchema>;

const BonusFamilySchema = z
  .object({
    stat: z.enum(COMBAT_BONUS_STATS),
    /** False retires the family from new rolls; owned copies keep what they rolled. */
    enabled: z.boolean(),
    /** The discrete step every range of this family rolls in. */
    stepBp: z.number().int().min(1),
    ranges: rarityRecord(BonusRangeSchema),
  })
  .strict()
  .superRefine((family, ctx) => {
    const cap = maxCombatBonusValueBp(family.stat);
    for (const rarity of COMBAT_BONUS_RARITIES) {
      const { minBp, maxBp } = family.ranges[rarity];
      if (maxBp < minBp) {
        ctx.addIssue({ code: 'custom', path: ['ranges', rarity, 'maxBp'], message: `must be at least minBp (${minBp})` });
      } else if ((maxBp - minBp) % family.stepBp !== 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['ranges', rarity],
          message: `stepBp ${family.stepBp} must divide the range evenly (${maxBp} - ${minBp} = ${maxBp - minBp})`,
        });
      }
      if (maxBp > cap) {
        ctx.addIssue({
          code: 'custom',
          path: ['ranges', rarity, 'maxBp'],
          message: `must be at most ${cap}, the combat cap for ${family.stat}`,
        });
      }
    }
  });
export type CombatBonusFamily = z.infer<typeof BonusFamilySchema>;

const SlotEligibilitySchema = z
  .array(z.enum(COMBAT_BONUS_STATS))
  .max(COMBAT_BONUS_STATS.length)
  .superRefine((stats, ctx) => {
    stats.forEach((stat, i) => {
      if (stats.indexOf(stat) !== i) ctx.addIssue({ code: 'custom', path: [i], message: `duplicate stat "${stat}"` });
    });
  });

export const EquipmentCombatBonusFileSchema = z
  .object({
    format: z.literal(EQUIPMENT_COMBAT_BONUS_FILE_FORMAT),
    version: z.literal(EQUIPMENT_COMBAT_BONUS_FILE_VERSION),
    rarityRules: rarityRecord(RarityRuleSchema),
    bonuses: z.array(BonusFamilySchema).max(COMBAT_BONUS_STATS.length),
    /** Per slot, the families that slot's gear may roll. */
    eligibility: z
      .object({ attack: SlotEligibilitySchema, defense: SlotEligibilitySchema, health: SlotEligibilitySchema })
      .strict(),
  })
  .strict()
  .superRefine((file, ctx) => {
    const families = new Map<string, CombatBonusFamily>();
    file.bonuses.forEach((family, i) => {
      if (families.has(family.stat)) {
        ctx.addIssue({ code: 'custom', path: ['bonuses', i, 'stat'], message: `duplicate bonus family "${family.stat}"` });
      } else families.set(family.stat, family);
    });
    for (const slot of EQUIPMENT_SLOTS) {
      file.eligibility[slot].forEach((stat, i) => {
        if (!families.has(stat)) {
          ctx.addIssue({ code: 'custom', path: ['eligibility', slot, i], message: `"${stat}" is not a defined bonus family` });
        }
      });
      const rollable = file.eligibility[slot].filter((stat) => families.get(stat)?.enabled).length;
      // Every pool must supply its rarity's count in *distinct* families:
      // an SR copy never falls back to the same stat twice, and an R copy is
      // never left without the bonus it is guaranteed.
      for (const rarity of COMBAT_BONUS_RARITIES) {
        const rule = file.rarityRules[rarity];
        if (rule.bonusChanceBp > 0 && rollable < rule.bonusCount) {
          ctx.addIssue({
            code: 'custom',
            path: ['eligibility', slot],
            message:
              `pool ${slot}.${rarity} needs ${rule.bonusCount} distinct enabled bonus families ` +
              `but only ${rollable} are eligible`,
          });
        }
      }
    }
  });
export type EquipmentCombatBonusFile = z.infer<typeof EquipmentCombatBonusFileSchema>;

/** The validated catalogue as the roll reads it. */
export interface CombatBonusCatalogue {
  rarityRules: Readonly<Record<CombatBonusRarity, CombatBonusRarityRule>>;
  bonuses: readonly CombatBonusFamily[];
  eligibility: Readonly<Record<EquipmentSlot, readonly CombatBonusStat[]>>;
}

export function combatBonusCatalogueFromFile(file: EquipmentCombatBonusFile): CombatBonusCatalogue {
  return {
    rarityRules: { ...file.rarityRules },
    bonuses: [...file.bonuses],
    eligibility: {
      attack: [...file.eligibility.attack],
      defense: [...file.eligibility.defense],
      health: [...file.eligibility.health],
    },
  };
}

/**
 * The enabled families a `<slot>.<rarity>` pool may roll, in the slot's
 * authored order. Empty for a slot or rarity the catalogue does not cover.
 */
export function eligibleCombatBonusFamilies(
  catalogue: CombatBonusCatalogue,
  slot: string,
  rarity: string,
): CombatBonusFamily[] {
  if (!isCombatBonusRarity(rarity) || !(EQUIPMENT_SLOTS as readonly string[]).includes(slot)) return [];
  const byStat = new Map(catalogue.bonuses.map((family) => [family.stat, family]));
  return catalogue.eligibility[slot as EquipmentSlot].flatMap((stat) => {
    const family = byStat.get(stat);
    return family?.enabled ? [family] : [];
  });
}

/** Every value a family can roll at `rarity`, ascending. */
export function combatBonusValues(family: CombatBonusFamily, rarity: CombatBonusRarity): number[] {
  const { minBp, maxBp } = family.ranges[rarity];
  const values: number[] = [];
  for (let v = minBp; v <= maxBp; v += family.stepBp) values.push(v);
  return values;
}

// ── rolling ───────────────────────────────────────────────────────────────

/** A random roll asked for bonuses its pool cannot supply. Content error, surfaced loudly. */
export class CombatBonusPoolError extends RangeError {
  constructor(
    readonly pool: string,
    readonly needed: number,
    readonly available: number,
  ) {
    super(`combat bonus pool "${pool}" needs ${needed} distinct bonus families but has ${available}`);
    this.name = 'CombatBonusPoolError';
  }
}

/**
 * Roll the combat bonuses of one new random instance:
 *
 *   1. the rarity's rule — a rarity without one (SSR and above) rolls none;
 *   2. the rarity's bonus chance, drawn only when it is below 100% (N);
 *   3. `bonusCount` distinct families, each uniform among those left;
 *   4. each family's magnitude, uniform over the rarity's discrete values.
 *
 * Returned in canonical order. All randomness comes from `rng`; with `null`
 * for the catalogue (no file deployed) nothing is drawn and nothing rolled.
 *
 * @throws {CombatBonusPoolError} when the pool has fewer distinct families
 * than the rule needs — checked before anything is drawn. Catalogue
 * validation makes this unreachable for a loaded file.
 */
export function rollCombatBonuses(
  definition: { slot: string; rarity: string },
  opts: { rng: Rng; catalogue: CombatBonusCatalogue | null },
): CombatBonus[] {
  const { rng, catalogue } = opts;
  if (!catalogue || !isCombatBonusRarity(definition.rarity)) return [];
  const rule = catalogue.rarityRules[definition.rarity];
  if (rule.bonusCount === 0 || rule.bonusChanceBp <= 0) return [];
  const pool = eligibleCombatBonusFamilies(catalogue, definition.slot, definition.rarity);
  if (pool.length < rule.bonusCount) {
    throw new CombatBonusPoolError(`${definition.slot}.${definition.rarity}`, rule.bonusCount, pool.length);
  }
  if (rule.bonusChanceBp < BASIS_POINTS && rng.intInclusive(1, BASIS_POINTS) > rule.bonusChanceBp) return [];

  const remaining = [...pool];
  const chosen: CombatBonusFamily[] = [];
  for (let i = 0; i < rule.bonusCount; i += 1) {
    chosen.push(remaining.splice(rng.intInclusive(0, remaining.length - 1), 1)[0]!);
  }
  const rarity = definition.rarity;
  return sortCombatBonuses(
    chosen.map((family) => {
      const { minBp, maxBp } = family.ranges[rarity];
      const steps = (maxBp - minBp) / family.stepBp;
      return { stat: family.stat, valueBp: minBp + rng.intInclusive(0, steps) * family.stepBp };
    }),
  );
}

// ── aggregation ───────────────────────────────────────────────────────────

export interface CombatBonusAggregate {
  /** The final modifiers a combatant fights with: summed, then capped. */
  modifiers: CombatModifiers;
  /** The plain sums, before any cap — for explaining a total that hit a ceiling. */
  uncapped: CombatModifiers;
  /** The modifiers a cap reduced. Empty in every sane loadout. */
  capped: (keyof CombatModifiers)[];
}

/**
 * **The** aggregation: every equipped item's bonuses, added per family, then
 * clamped to the combat safety caps. An empty slot, an item with no bonuses
 * and a pre-system item all contribute nothing. Pure — no total is ever
 * stored as player data; snapshots store this function's result.
 */
export function aggregateCombatBonuses(
  items: Iterable<{ combatBonuses?: readonly CombatBonus[] | null | undefined } | null | undefined>,
): CombatBonusAggregate {
  const uncapped: CombatModifiers = { ...ZERO_COMBAT_MODIFIERS };
  for (const item of items) {
    for (const bonus of item?.combatBonuses ?? []) {
      if (!isCombatBonusStat(bonus.stat)) continue;
      if (!Number.isSafeInteger(bonus.valueBp) || bonus.valueBp < 0) {
        throw new RangeError(`combat bonus ${bonus.stat} must be whole non-negative basis points, got ${bonus.valueBp}`);
      }
      uncapped[COMBAT_BONUS_MODIFIER[bonus.stat]] += bonus.valueBp;
    }
  }
  const modifiers = clampCombatModifiers(uncapped);
  return {
    modifiers,
    uncapped,
    capped: COMBAT_MODIFIER_KEYS.filter((key) => modifiers[key] !== uncapped[key]),
  };
}

// ── player-facing formatting ──────────────────────────────────────────────

/** Basis points as a percentage, at most two decimals, no trailing zeros: 425 → `4.25%`, 600 → `6%`. */
export function formatBonusPercent(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = Math.abs(bp % 100);
  if (frac === 0) return `${whole}%`;
  const digits = String(frac).padStart(2, '0').replace(/0$/, '');
  return `${whole}.${digits}%`;
}

/** One item bonus as a line: `+4.25% Crit Chance`. */
export function formatCombatBonus(bonus: CombatBonus): string {
  return `+${formatBonusPercent(bonus.valueBp)} ${COMBAT_BONUS_LABELS[bonus.stat] ?? bonus.stat}`;
}

/** One row of a loadout's totals. */
export interface CombatModifierRow {
  key: keyof CombatModifiers;
  label: string;
  /** Formatted for display. Crit DMG is the **total** multiplier (`167.5%`), not the bonus. */
  value: string;
}

/**
 * A loadout's totals as display rows, zero rows omitted. Crit Damage shows
 * the total Crit multiplier, base included, and only when there is a bonus to
 * show (the ×1.50 base alone is a rule, not something the gear did).
 */
export function combatModifierRows(modifiers: CombatModifiers | null | undefined): CombatModifierRow[] {
  if (!modifiers) return [];
  return COMBAT_MODIFIER_KEYS.flatMap((key) => {
    const bp = modifiers[key] ?? 0;
    if (!(bp > 0)) return [];
    const shown = key === 'critDamageBonusBp' ? BASE_CRIT_DAMAGE_BP + bp : bp;
    return [{ key, label: COMBAT_MODIFIER_LABELS[key], value: formatBonusPercent(shown) }];
  });
}
