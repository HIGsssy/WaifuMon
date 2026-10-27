/**
 * Equipment roll rules (Equipment 3.0) — the managed configuration document,
 * pure: schema, bootstrap, the legacy adapter, validation, hashing, diffing and
 * the export/import format. No database; `equipmentRollRulesStore.ts` stores
 * it and `equipmentRollRulesService.ts` manages its lifecycle.
 *
 * ## The document (`waifumon-equipment-roll-config`, version 2)
 *
 *   {
 *     format, version,
 *     legacy:       the shipped `combatBonuses.json`, verbatim — N/R/SR
 *     rarities:     { SSR?, UR?, LR? } — future high-rarity rules
 *     flatSpLimits: { perItemMax, perLoadoutMax }
 *   }
 *
 * **N/R/SR (`legacy`)** are frozen. The block is copied from the shipped file
 * once, at bootstrap, and no managed draft may change it: the unchanged
 * legacy roll (`rollCombatBonuses`) reads it through
 * {@link legacyCombatBonusCatalogue}, so every N/R/SR roll — values and RNG
 * draws — stays exactly what the shipped catalogue produced.
 *
 * **SSR/UR/LR (`rarities`)** use the distribution model the high-rarity engine
 * (E3-C) will execute. Nothing rolls from them yet: random SSR+ rolls still
 * fail closed. No balance values are shipped — a fresh configuration has none.
 *
 * Probabilities are integer basis points (10000 = 100%), as everywhere else in
 * equipment; magnitudes are integers on an integer step. `flat_sp` magnitudes
 * are whole SP, every other family's are basis points.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EquipmentIssue } from '../../shared/errors';
import {
  COMBAT_BONUS_STATS,
  EQUIPMENT_BONUS_STATS,
  EquipmentCombatBonusFileSchema,
  FLAT_SP_BONUS_STAT,
  MAX_COMBAT_BONUSES_PER_ITEM,
  combatBonusCatalogueFromFile,
  maxCombatBonusValueBp,
  type CombatBonusCatalogue,
  type EquipmentBonusStat,
  type EquipmentCombatBonusFile,
} from './combatBonuses';
import {
  EQUIPMENT_FLAT_SP_MAX_PER_ITEM,
  EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT,
  EQUIPMENT_KEY_MAX_LENGTH,
  EQUIPMENT_KEY_PATTERN,
  EQUIPMENT_SLOTS,
  type EquipmentSlot,
} from './vocabulary';

export const ROLL_RULES_FORMAT = 'waifumon-equipment-roll-config' as const;
export const ROLL_RULES_VERSION = 2 as const;

/** Rarities whose rules live in the frozen `legacy` block. */
export const LEGACY_RULE_RARITIES = ['N', 'R', 'SR'] as const;
/** Rarities a managed draft may configure. */
export const MANAGED_RULE_RARITIES = ['SSR', 'UR', 'LR'] as const;
export type ManagedRuleRarity = (typeof MANAGED_RULE_RARITIES)[number];

const BASIS_POINTS = 10_000;
const positiveInt = z.number().int().min(1);

/** One family a high rarity may roll, with its magnitude range for that rarity. */
const ManagedFamilySchema = z
  .object({
    stat: z.enum(EQUIPMENT_BONUS_STATS),
    enabled: z.boolean(),
    /** Slots whose gear of this rarity may roll the family. */
    slots: z.array(z.enum(EQUIPMENT_SLOTS)).min(1).max(EQUIPMENT_SLOTS.length),
    /** Basis points, or whole SP for `flat_sp`. */
    minValue: positiveInt,
    maxValue: positiveInt,
    step: positiveInt,
  })
  .strict();
export type ManagedFamilyRule = z.infer<typeof ManagedFamilySchema>;

const PrimarySpSchema = z
  .object({
    /** Chance a copy rolls primary flat SP at all; 10000 = always. */
    chanceBp: z.number().int().min(0).max(BASIS_POINTS),
    min: positiveInt,
    max: positiveInt,
    step: positiveInt,
  })
  .strict();
export type PrimarySpRule = z.infer<typeof PrimarySpSchema>;

const AffixAssignmentSchema = z.discriminatedUnion('mode', [
  /** Affixless: no suffix, no affix draw. */
  z.object({ mode: z.literal('none') }).strict(),
  /** Draw a suffix from this managed library's published entries. */
  z
    .object({
      mode: z.literal('library'),
      library: z.string().min(1).max(EQUIPMENT_KEY_MAX_LENGTH).regex(EQUIPMENT_KEY_PATTERN, 'library key must be lowercase snake_case'),
    })
    .strict(),
]);
export type AffixAssignment = z.infer<typeof AffixAssignmentSchema>;

const ManagedRaritySchema = z
  .object({
    /**
     * Weight of rolling 0, 1, 2 and 3 additional bonuses, in basis points —
     * index = count. Must total exactly 10000.
     */
    bonusCountWeightsBp: z.array(z.number().int().min(0).max(BASIS_POINTS)).length(MAX_COMBAT_BONUSES_PER_ITEM + 1),
    families: z.array(ManagedFamilySchema).max(EQUIPMENT_BONUS_STATS.length),
    primarySp: PrimarySpSchema.nullable(),
    affixes: AffixAssignmentSchema,
  })
  .strict();
export type ManagedRarityRule = z.infer<typeof ManagedRaritySchema>;

const FlatSpLimitsSchema = z
  .object({
    perItemMax: z.number().int().min(1).max(EQUIPMENT_FLAT_SP_MAX_PER_ITEM),
    perLoadoutMax: z.number().int().min(1).max(EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT),
  })
  .strict();

export const RollRulesSchema = z
  .object({
    format: z.literal(ROLL_RULES_FORMAT),
    version: z.literal(ROLL_RULES_VERSION),
    legacy: EquipmentCombatBonusFileSchema,
    rarities: z
      .object({ SSR: ManagedRaritySchema.optional(), UR: ManagedRaritySchema.optional(), LR: ManagedRaritySchema.optional() })
      .strict(),
    flatSpLimits: FlatSpLimitsSchema,
  })
  .strict();
export type RollRules = z.infer<typeof RollRulesSchema>;

/**
 * The provisional technical SP ceilings E3-A approved, as the bootstrap
 * values. Configuration may lower them, never raise them past the code rails.
 */
export const DEFAULT_FLAT_SP_LIMITS = Object.freeze({
  perItemMax: EQUIPMENT_FLAT_SP_MAX_PER_ITEM,
  perLoadoutMax: EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT,
});

/** The first configuration a server gets: the shipped legacy rules, no high-rarity rules. */
export function bootstrapRollRules(shipped: EquipmentCombatBonusFile): RollRules {
  return {
    format: ROLL_RULES_FORMAT,
    version: ROLL_RULES_VERSION,
    legacy: structuredClone(shipped),
    rarities: {},
    flatSpLimits: { ...DEFAULT_FLAT_SP_LIMITS },
  };
}

/**
 * The adapter the unchanged legacy roll reads: the published `legacy` block as
 * the same `CombatBonusCatalogue` the content loader builds from the shipped
 * file. Identical input → identical N/R/SR rolls and draws.
 */
export function legacyCombatBonusCatalogue(rules: RollRules): CombatBonusCatalogue {
  return combatBonusCatalogueFromFile(rules.legacy);
}

// ── hashing ───────────────────────────────────────────────────────────────

/** Key-sorted JSON, so equal documents hash equally whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

// ── validation ────────────────────────────────────────────────────────────

/** What validation needs to know about a managed affix library. */
export interface AffixLibraryFacts {
  /** Has a published revision. */
  published: boolean;
  /** Slots with at least one enabled entry in the published revision. */
  slotsCovered: ReadonlySet<EquipmentSlot>;
}

export interface RollRulesValidationContext {
  /** The published legacy block a draft must not change. Omit for a first bootstrap. */
  publishedLegacy?: EquipmentCombatBonusFile;
  /** Managed libraries by key. Omit to skip library checks (schema-only validation). */
  libraries?: ReadonlyMap<string, AffixLibraryFacts>;
}

export interface RollRulesValidation {
  ok: boolean;
  value: RollRules | null;
  /** Refusals: a document with any is never published. */
  errors: EquipmentIssue[];
  /** Advisory: published anyway, shown to the author. */
  warnings: EquipmentIssue[];
}

/**
 * Everything wrong with a configuration document. Schema first (a document
 * that does not parse reports only that); then the rules a publishable
 * configuration must satisfy — no configuration that passes can produce an
 * invalid roll:
 *
 *  - the legacy block equals the published one (N/R/SR are immutable);
 *  - each rarity's count weights total exactly 10000;
 *  - every slot has at least as many distinct enabled families as the
 *    largest count with positive weight (rolls draw without replacement);
 *  - no family repeats within a rarity; ranges are min ≤ max on whole steps,
 *    within the family's combat cap (or, for `flat_sp`, the per-copy SP cap);
 *  - primary SP max plus the largest `flat_sp` max fits the per-copy cap, so a
 *    copy can never roll past it; per-copy ≤ per-loadout cap;
 *  - an assigned library exists, is published and covers every slot.
 *
 * Warnings: a loadout of three max rolls (or typical rolls) reaching a
 * family's combat cap, or three max-SP copies reaching the loadout cap. Caps
 * are never raised; values over them are refused, not clamped.
 */
export function validateRollRules(raw: unknown, ctx: RollRulesValidationContext = {}): RollRulesValidation {
  const parsed = RollRulesSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      value: null,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'config', message: i.message })),
      warnings: [],
    };
  }
  const rules = parsed.data;
  const errors: EquipmentIssue[] = [];
  const warnings: EquipmentIssue[] = [];

  if (ctx.publishedLegacy && contentHash(rules.legacy) !== contentHash(ctx.publishedLegacy)) {
    errors.push({ path: 'legacy', message: 'N/R/SR rules are frozen and cannot be changed through managed configuration' });
  }

  const limits = rules.flatSpLimits;
  if (limits.perItemMax > limits.perLoadoutMax) {
    errors.push({ path: 'flatSpLimits.perItemMax', message: `must not exceed perLoadoutMax (${limits.perLoadoutMax})` });
  }

  for (const rarity of MANAGED_RULE_RARITIES) {
    const rule = rules.rarities[rarity];
    if (!rule) continue;
    const at = `rarities.${rarity}`;

    const total = rule.bonusCountWeightsBp.reduce((sum, w) => sum + w, 0);
    if (total !== BASIS_POINTS) {
      errors.push({ path: `${at}.bonusCountWeightsBp`, message: `must total exactly ${BASIS_POINTS} (100%), got ${total}` });
    }
    const maxCount = rule.bonusCountWeightsBp.reduce((max, w, count) => (w > 0 ? count : max), 0);

    const seen = new Set<EquipmentBonusStat>();
    rule.families.forEach((family, i) => {
      const fp = `${at}.families[${i}]`;
      if (seen.has(family.stat)) errors.push({ path: `${fp}.stat`, message: `duplicate family "${family.stat}"` });
      seen.add(family.stat);
      if (new Set(family.slots).size !== family.slots.length) {
        errors.push({ path: `${fp}.slots`, message: 'contains duplicates' });
      }
      errors.push(...rangeIssues(fp, family.minValue, family.maxValue, family.step, ['minValue', 'maxValue', 'step']));
      const cap = family.stat === FLAT_SP_BONUS_STAT ? limits.perItemMax : maxCombatBonusValueBp(family.stat);
      if (family.maxValue > cap) {
        errors.push({
          path: `${fp}.maxValue`,
          message:
            family.stat === FLAT_SP_BONUS_STAT
              ? `must be at most ${cap} SP, the per-copy flat SP cap`
              : `must be at most ${cap}, the combat cap for ${family.stat}`,
        });
      } else if (family.enabled) {
        // The loadout total of a combat family is clamped at its combat cap;
        // of flat SP, at the per-loadout SP cap.
        warnings.push(...capWarnings(fp, family, family.stat === FLAT_SP_BONUS_STAT ? limits.perLoadoutMax : cap));
      }
    });

    for (const slot of EQUIPMENT_SLOTS) {
      const eligible = rule.families.filter((f) => f.enabled && f.slots.includes(slot)).length;
      if (eligible < maxCount) {
        errors.push({
          path: `${at}.families`,
          message: `${slot} gear can roll up to ${maxCount} bonus(es) but only ${eligible} distinct enabled famil${eligible === 1 ? 'y is' : 'ies are'} eligible`,
        });
      }
    }

    if (rule.primarySp) {
      const sp = rule.primarySp;
      errors.push(...rangeIssues(`${at}.primarySp`, sp.min, sp.max, sp.step, ['min', 'max', 'step']));
      const flat = rule.families.find((f) => f.enabled && f.stat === FLAT_SP_BONUS_STAT);
      const worst = sp.max + (flat && maxCount > 0 ? flat.maxValue : 0);
      if (worst > limits.perItemMax) {
        errors.push({
          path: `${at}.primarySp.max`,
          message: `primary SP (${sp.max}) plus the largest flat_sp bonus (${worst - sp.max}) can reach ${worst}; one copy may carry at most ${limits.perItemMax}`,
        });
      } else if (worst * EQUIPMENT_SLOTS.length > limits.perLoadoutMax) {
        warnings.push({
          path: `${at}.primarySp`,
          message: `three max-SP copies (${worst * EQUIPMENT_SLOTS.length}) would reach the loadout cap of ${limits.perLoadoutMax}`,
        });
      }
    }

    if (rule.affixes.mode === 'library' && ctx.libraries) {
      const library = ctx.libraries.get(rule.affixes.library);
      const ap = `${at}.affixes.library`;
      if (!library) errors.push({ path: ap, message: `"${rule.affixes.library}" is not a managed affix library` });
      else if (!library.published) errors.push({ path: ap, message: `"${rule.affixes.library}" has no published revision` });
      else {
        const missing = EQUIPMENT_SLOTS.filter((slot) => !library.slotsCovered.has(slot));
        if (missing.length > 0) {
          errors.push({ path: ap, message: `"${rule.affixes.library}" has no enabled affix for ${missing.join(', ')} gear` });
        }
      }
    }
  }

  return { ok: errors.length === 0, value: rules, errors, warnings };
}

function rangeIssues(at: string, min: number, max: number, step: number, names: [string, string, string]): EquipmentIssue[] {
  if (max < min) return [{ path: `${at}.${names[1]}`, message: `must be at least ${names[0]} (${min})` }];
  if ((max - min) % step !== 0) {
    return [{ path: `${at}.${names[2]}`, message: `must divide the range evenly (${max} - ${min} = ${max - min})` }];
  }
  return [];
}

/** Whether three equipped copies would hit the loadout clamp — typically, or only at max rolls. */
function capWarnings(at: string, family: ManagedFamilyRule, loadoutCap: number): EquipmentIssue[] {
  const loadout = EQUIPMENT_SLOTS.length;
  const unit = family.stat === FLAT_SP_BONUS_STAT ? ' SP' : ' bp';
  const typical = Math.floor((family.minValue + family.maxValue) / 2);
  if (typical * loadout > loadoutCap) {
    return [{ path: at, message: `a full loadout typically reaches the cap: 3 × ${typical}${unit} > ${loadoutCap}${unit} (${family.stat})` }];
  }
  if (family.maxValue * loadout > loadoutCap) {
    return [{ path: at, message: `a full loadout of max rolls reaches the cap: 3 × ${family.maxValue}${unit} > ${loadoutCap}${unit} (${family.stat})` }];
  }
  return [];
}

// ── diff ──────────────────────────────────────────────────────────────────

export interface RollRulesChange {
  /** `flatSpLimits`, `rarities.SSR`, `rarities.SSR.families`, … */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before: unknown;
  after: unknown;
}

/** Field-level changes from `before` to `after`, in a stable order. The legacy block is compared whole. */
export function diffRollRules(before: RollRules, after: RollRules): RollRulesChange[] {
  const changes: RollRulesChange[] = [];
  const cmp = (path: string, a: unknown, b: unknown) => {
    if (a === undefined && b === undefined) return;
    if (a === undefined) changes.push({ path, kind: 'added', before: null, after: b });
    else if (b === undefined) changes.push({ path, kind: 'removed', before: a, after: null });
    else if (canonicalJson(a) !== canonicalJson(b)) changes.push({ path, kind: 'changed', before: a, after: b });
  };
  cmp('legacy', before.legacy, after.legacy);
  cmp('flatSpLimits', before.flatSpLimits, after.flatSpLimits);
  for (const rarity of MANAGED_RULE_RARITIES) {
    const a = before.rarities[rarity];
    const b = after.rarities[rarity];
    if (!a || !b) {
      cmp(`rarities.${rarity}`, a, b);
      continue;
    }
    for (const field of ['bonusCountWeightsBp', 'families', 'primarySp', 'affixes'] as const) {
      cmp(`rarities.${rarity}.${field}`, a[field], b[field]);
    }
  }
  return changes;
}

/** The affix libraries a configuration assigns, by rarity. */
export function assignedLibraries(rules: RollRules): Map<string, ManagedRuleRarity[]> {
  const out = new Map<string, ManagedRuleRarity[]>();
  for (const rarity of MANAGED_RULE_RARITIES) {
    const affixes = rules.rarities[rarity]?.affixes;
    if (affixes?.mode !== 'library') continue;
    out.set(affixes.library, [...(out.get(affixes.library) ?? []), rarity]);
  }
  return out;
}

// ── export / import ───────────────────────────────────────────────────────

export const ROLL_RULES_EXPORT_FORMAT = 'waifumon-equipment-roll-config-export' as const;
export const ROLL_RULES_EXPORT_VERSION = 1 as const;

/**
 * A portable copy of the configuration. `kind` says what was exported — the
 * published revision or the working draft — and `revision` which one. On
 * import both are informational: an import always lands in the draft and is
 * never published by the import itself.
 */
export interface RollRulesExport {
  format: typeof ROLL_RULES_EXPORT_FORMAT;
  version: typeof ROLL_RULES_EXPORT_VERSION;
  kind: 'published' | 'draft';
  /** The published revision number, or the draft revision. */
  revision: number;
  contentHash: string;
  exportedAt: string;
  config: RollRules;
}

const RollRulesExportSchema = z
  .object({
    format: z.literal(ROLL_RULES_EXPORT_FORMAT),
    version: z.literal(ROLL_RULES_EXPORT_VERSION),
    kind: z.enum(['published', 'draft']),
    revision: z.number().int().min(1),
    contentHash: z.string(),
    exportedAt: z.string(),
    config: z.unknown(),
  })
  .strict();

export function buildRollRulesExport(
  rules: RollRules,
  meta: { kind: 'published' | 'draft'; revision: number; exportedAt: string },
): RollRulesExport {
  return {
    format: ROLL_RULES_EXPORT_FORMAT,
    version: ROLL_RULES_EXPORT_VERSION,
    kind: meta.kind,
    revision: meta.revision,
    contentHash: contentHash(rules),
    exportedAt: meta.exportedAt,
    config: rules,
  };
}

/**
 * The configuration inside an export file, unvalidated beyond the envelope —
 * the caller validates it exactly like any draft. A file whose `contentHash`
 * does not match its config was edited by hand; that is allowed (it is just a
 * draft) and reported so the author knows.
 */
export function readRollRulesExport(raw: unknown): { config: unknown; issues: EquipmentIssue[]; handEdited: boolean } {
  const parsed = RollRulesExportSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      config: null,
      handEdited: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'file', message: i.message })),
    };
  }
  return { config: parsed.data.config, issues: [], handEdited: contentHash(parsed.data.config) !== parsed.data.contentHash };
}

/** Exposed for tests and the future rules editor: the families a managed rarity may name. */
export const MANAGED_FAMILY_STATS: readonly EquipmentBonusStat[] = [...COMBAT_BONUS_STATS, FLAT_SP_BONUS_STAT];
