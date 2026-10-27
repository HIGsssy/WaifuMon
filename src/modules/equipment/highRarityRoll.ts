/**
 * The SSR/UR/LR distribution roll (Equipment 3.0, E3-C) — pure. Reached only
 * through `rollEquipmentInstance`, and only when the caller supplies the
 * published configuration a grant read ({@link HighRarityRollContext}); N/R/SR
 * never come here and their legacy roll is untouched.
 *
 * ## The RNG contract
 *
 * Every draw comes from the one injected or seeded `rng`, in this order:
 *
 *  1. **Multiplier** — `intInclusive(0, steps)`, exactly as legacy.
 *  2. **Affix** — only for a library assignment: `intInclusive(0, n − 1)` over
 *     the library's enabled entries eligible for the slot, in library order.
 *     Affixless draws nothing.
 *  3. **Bonus count** — the rarity's weights for counts `0…max` (the
 *     definition's maximum; counts above it are excluded, never clamped onto
 *     it), renormalised. One positive outcome draws nothing; otherwise
 *     `intInclusive(1, Σ kept weights)`, walked in ascending count order.
 *  4. **Families** — `count` draws `intInclusive(0, remaining − 1)`, uniform
 *     without replacement over the enabled, slot-eligible families in rule
 *     order (the legacy selection algorithm, unweighted).
 *  5. **Magnitudes** — one `intInclusive(0, steps)` per chosen family, in the
 *     order chosen, over that family's range *for this rarity*.
 *  6. **Primary SP, last** — only when the definition is `primarySpEligible`
 *     and the rule's chance is above 0: a gate `intInclusive(1, 10000) ≤
 *     chanceBp` (drawn only below 10000), then `intInclusive(0, steps)`.
 *
 * Primary SP is last so enabling or disabling it never moves an earlier draw.
 *
 * ## Fail closed, before any draw
 *
 * {@link planHighRarityRoll} checks everything a roll needs without touching
 * the RNG — a rule for the rarity, a rule set that still validates, the
 * assigned library (never another), a non-empty affix pool for the slot, a
 * positive count mass under the definition's maximum, enough distinct
 * families for every reachable count, and the per-copy SP ceiling. Any
 * problem is {@link EquipmentRollUnavailableError}: no fallback to another
 * rarity's ranges, no invented weights, no partial item.
 */
import { EquipmentRollUnavailableError, type EquipmentIssue } from '../../shared/errors';
import type { Rng } from '../../shared/random';
import type { ManagedAffixEntry } from './affixLibraries';
import {
  combatBonusListIssues,
  FLAT_SP_BONUS_STAT,
  MAX_COMBAT_BONUSES_PER_ITEM,
  sortCombatBonuses,
  type CombatBonus,
} from './combatBonuses';
import type { EquipmentRoll, RollableDefinition } from './equipmentRoll';
import {
  validateRollRules,
  type ManagedFamilyRule,
  type ManagedRarityRule,
  type ManagedRuleRarity,
  type PrimarySpRule,
  type RollRules,
} from './rollRules';
import { EQUIPMENT_FLAT_SP_MAX_PER_ITEM, EQUIPMENT_HIGH_RARITY_ROLL_RARITIES, type EquipmentHighRarity } from './vocabulary';

const BASIS_POINTS = 10_000;

/** One managed library at the exact revision a grant rolls from. */
export interface ResolvedAffixLibrary {
  key: string;
  revision: number;
  /** The revision's entries, in library order (enabled and disabled). */
  entries: readonly ManagedAffixEntry[];
}

/** What a high-rarity roll reads: one published rules revision and, if it assigns one, its library. */
export interface HighRarityRollContext {
  rules: RollRules;
  /** The library the rarity's assignment names, at the grant's revision; null when affixless or unavailable. */
  affixLibrary: ResolvedAffixLibrary | null;
}

/** The roll policy a definition carries (migration 0072). Absent = defaults. */
export type HighRarityDefinition = RollableDefinition & {
  primarySpEligible?: boolean | null;
  maxAdditionalBonuses?: number | null;
};

export function isHighRarity(rarity: string): rarity is EquipmentHighRarity {
  return (EQUIPMENT_HIGH_RARITY_ROLL_RARITIES as readonly string[]).includes(rarity);
}

/** One reachable bonus count and its integer weight after exclusion. */
export interface CountOutcome {
  count: number;
  weightBp: number;
}

/**
 * The bonus-count outcomes a definition can roll: the rarity's weights for
 * `0…max`, zero weights dropped, in ascending count order. Their sum is the
 * renormalisation denominator; empty means nothing is rollable.
 *
 * `{0:0, 1:4000, 2:5000, 3:1000}` with max 2 → `[{1,4000}, {2,5000}]`:
 * P(1) = 4/9, P(2) = 5/9 — the excluded 10% is spread proportionally.
 */
export function bonusCountOutcomes(weightsBp: readonly number[], max: number): CountOutcome[] {
  return weightsBp
    .slice(0, max + 1)
    .map((weightBp, count) => ({ count, weightBp }))
    .filter((o) => o.weightBp > 0);
}

/** Everything a roll will draw from, decided without the RNG. */
export interface HighRarityRollPlan {
  rarity: ManagedRuleRarity;
  rule: ManagedRarityRule;
  /** Library candidates for the slot, in library order; null when affixless. */
  affix: { library: ResolvedAffixLibrary; candidates: ManagedAffixEntry[] } | null;
  /** Enabled, slot-eligible families, in rule order. */
  families: ManagedFamilyRule[];
  /** The definition's effective maximum: its own, or the per-item ceiling. */
  maxAdditionalBonuses: number;
  counts: CountOutcome[];
  countTotalBp: number;
  /** The primary SP rule this definition rolls; null when it rolls none. */
  primarySp: PrimarySpRule | null;
}

/** Rule-set errors per rules object: a revision is immutable, so this is computed once. */
const ruleErrors = new WeakMap<RollRules, EquipmentIssue[]>();

function rulesErrorsFor(rules: RollRules, rarity: ManagedRuleRarity): EquipmentIssue[] {
  let errors = ruleErrors.get(rules);
  if (!errors) {
    // Library checks need the database and were made at publish; the shape,
    // weights, ranges, caps and family feasibility are re-checked here so a
    // revision that does not validate can never roll.
    errors = validateRollRules(rules).errors;
    ruleErrors.set(rules, errors);
  }
  return errors.filter((e) => e.path.startsWith(`rarities.${rarity}`) || e.path.startsWith('flatSpLimits'));
}

/**
 * Check everything a roll of `definition` needs, without drawing. Returns the
 * plan, or every reason it cannot roll.
 */
export function planHighRarityRoll(
  definition: HighRarityDefinition,
  ctx: HighRarityRollContext,
): { ok: true; plan: HighRarityRollPlan } | { ok: false; issues: EquipmentIssue[] } {
  const rarity = definition.rarity;
  if (!isHighRarity(rarity)) {
    return { ok: false, issues: [{ path: 'rarity', message: `${rarity} is not rolled by the distribution roll` }] };
  }
  const at = `rarities.${rarity}`;
  const rule = ctx.rules.rarities[rarity];
  if (!rule) return { ok: false, issues: [{ path: at, message: `the published rules configure no ${rarity} rolls` }] };

  const issues: EquipmentIssue[] = [...rulesErrorsFor(ctx.rules, rarity)];
  const slot = definition.slot;

  let affix: HighRarityRollPlan['affix'] = null;
  if (rule.affixes.mode === 'library') {
    const wanted = rule.affixes.library;
    const library = ctx.affixLibrary;
    if (!library || library.key !== wanted) {
      // Never another library in its place.
      issues.push({ path: `${at}.affixes.library`, message: `affix library "${wanted}" is not available to this grant` });
    } else {
      const candidates = library.entries.filter((e) => e.enabled && (e.slots as readonly string[]).includes(slot));
      if (candidates.length === 0) {
        issues.push({
          path: `${at}.affixes.library`,
          message: `affix library "${wanted}" revision ${library.revision} has no enabled affix for ${slot} gear`,
        });
      } else {
        affix = { library, candidates };
      }
    }
  }

  const families = rule.families.filter((f) => f.enabled && (f.slots as readonly string[]).includes(slot));
  const own = definition.maxAdditionalBonuses ?? null;
  if (own !== null && (!Number.isInteger(own) || own < 0 || own > MAX_COMBAT_BONUSES_PER_ITEM)) {
    issues.push({ path: 'maxAdditionalBonuses', message: `must be 0–${MAX_COMBAT_BONUSES_PER_ITEM} or null, got ${JSON.stringify(own)}` });
  }
  const maxAdditionalBonuses = own ?? MAX_COMBAT_BONUSES_PER_ITEM;
  const counts = bonusCountOutcomes(rule.bonusCountWeightsBp, maxAdditionalBonuses);
  const countTotalBp = counts.reduce((sum, o) => sum + o.weightBp, 0);
  if (countTotalBp === 0) {
    issues.push({
      path: `${at}.bonusCountWeightsBp`,
      message: `no bonus count from 0 to ${maxAdditionalBonuses} (this definition's maximum) has positive weight`,
    });
  }
  const largest = counts.reduce((max, o) => Math.max(max, o.count), 0);
  if (largest > families.length) {
    issues.push({
      path: `${at}.families`,
      message: `${slot} gear can roll ${largest} bonus(es) but only ${families.length} distinct enabled famil${families.length === 1 ? 'y is' : 'ies are'} eligible`,
    });
  }

  const primarySp = definition.primarySpEligible === true && rule.primarySp && rule.primarySp.chanceBp > 0 ? rule.primarySp : null;
  const flat = largest > 0 ? families.find((f) => f.stat === FLAT_SP_BONUS_STAT) : undefined;
  const worstSp = (primarySp?.max ?? 0) + (flat?.maxValue ?? 0);
  const perItem = Math.min(ctx.rules.flatSpLimits.perItemMax, EQUIPMENT_FLAT_SP_MAX_PER_ITEM);
  if (worstSp > perItem) {
    issues.push({ path: `${at}.primarySp.max`, message: `a copy could reach ${worstSp} flat SP; one copy may carry at most ${perItem}` });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plan: { rarity, rule, affix, families, maxAdditionalBonuses, counts, countTotalBp, primarySp } };
}

/** A distribution roll: an `EquipmentRoll`, with `affixSnapshot` set when it drew a managed affix. */
export type HighRarityRoll = EquipmentRoll;

const stepped = (rng: Rng, min: number, max: number, step: number) => min + rng.intInclusive(0, (max - min) / step) * step;

/**
 * Roll one SSR/UR/LR instance. The multiplier range must already have been
 * validated (`rollEquipmentInstance` does).
 *
 * @throws {EquipmentRollUnavailableError} before any draw when the plan fails.
 */
export function rollHighRarityInstance(
  definition: HighRarityDefinition,
  opts: { rng: Rng; config: HighRarityRollContext },
): HighRarityRoll {
  const planned = planHighRarityRoll(definition, opts.config);
  if (!planned.ok) throw new EquipmentRollUnavailableError(definition.key, definition.rarity, planned.issues);
  const { plan } = planned;
  const { rng } = opts;

  // 1. multiplier
  const rolledMultiplierBp = stepped(rng, definition.multiplierMinBp, definition.multiplierMaxBp, definition.multiplierStepBp);

  // 2. affix
  let affixKey: string | null = null;
  let affixSnapshot: HighRarityRoll['affixSnapshot'];
  if (plan.affix) {
    const entry = plan.affix.candidates[rng.intInclusive(0, plan.affix.candidates.length - 1)]!;
    affixKey = entry.key;
    affixSnapshot = { library: plan.affix.library.key, libraryRevision: plan.affix.library.revision, suffix: entry.suffix };
  }

  // 3. bonus count
  let count = plan.counts[0]!.count;
  if (plan.counts.length > 1) {
    let r = rng.intInclusive(1, plan.countTotalBp);
    for (const outcome of plan.counts) {
      if (r <= outcome.weightBp) {
        count = outcome.count;
        break;
      }
      r -= outcome.weightBp;
    }
  }

  // 4. families, without replacement; 5. their magnitudes, in the order chosen
  const remaining = [...plan.families];
  const chosen: ManagedFamilyRule[] = [];
  for (let i = 0; i < count; i += 1) chosen.push(remaining.splice(rng.intInclusive(0, remaining.length - 1), 1)[0]!);
  const combatBonuses: CombatBonus[] = sortCombatBonuses(
    chosen.map((f) => ({ stat: f.stat, valueBp: stepped(rng, f.minValue, f.maxValue, f.step) })),
  );

  // 6. primary SP, last
  let flatSp = 0;
  const sp = plan.primarySp;
  if (sp && (sp.chanceBp >= BASIS_POINTS || rng.intInclusive(1, BASIS_POINTS) <= sp.chanceBp)) {
    flatSp = stepped(rng, sp.min, sp.max, sp.step);
  }

  // The plan made these unreachable; a failure here is a bug, never a grant.
  const bonusIssues = combatBonusListIssues(combatBonuses);
  if (bonusIssues.length > 0) throw new RangeError(`high-rarity roll produced invalid bonuses: ${bonusIssues.map((i) => i.message).join('; ')}`);

  return {
    rolledMultiplierBp,
    affixKey,
    combatBonuses,
    ...(flatSp > 0 ? { flatSp } : {}),
    ...(affixSnapshot ? { affixSnapshot } : {}),
  };
}

// ── definition feasibility (authoring and publish) ──────────────────────────

/**
 * Why a definition could never roll under `rules` because of its own roll
 * policy: its `maxAdditionalBonuses` excludes every bonus count the rarity
 * gives positive weight. Empty for N/R/SR, for a rarity the rules do not
 * configure (such a definition is simply not rollable yet), and for any
 * definition with a reachable count. Rule-wide problems (weights, families,
 * libraries) are the rules' own validation, not reported here.
 */
export function definitionRollPolicyIssues(
  definition: { key: string; rarity: string; maxAdditionalBonuses?: number | null },
  rules: RollRules,
): EquipmentIssue[] {
  if (!isHighRarity(definition.rarity)) return [];
  const rule = rules.rarities[definition.rarity];
  if (!rule) return [];
  const max = definition.maxAdditionalBonuses ?? MAX_COMBAT_BONUSES_PER_ITEM;
  if (bonusCountOutcomes(rule.bonusCountWeightsBp, max).length > 0) return [];
  return [
    {
      path: 'maxAdditionalBonuses',
      message:
        `"${definition.key}" allows at most ${max} additional bonus(es), but the published ${definition.rarity} rule ` +
        `gives no count from 0 to ${max} any weight — it could never roll`,
    },
  ];
}

// ── analysis (previews and tests) ───────────────────────────────────────────

export interface HighRarityRollAnalysis {
  /** Exact count probabilities after exclusion and renormalisation, as `weight / total`. */
  counts: { count: number; weightBp: number; probability: number }[];
  countTotalBp: number;
  /** Probability that the copy rolls primary SP at all. */
  primarySpProbability: number;
  families: { stat: string; minValue: number; maxValue: number; step: number }[];
  affixCandidates: number | null;
}

/** The analytic distribution a definition rolls under a configuration, or the reasons it cannot roll. */
export function analyseHighRarityRoll(
  definition: HighRarityDefinition,
  ctx: HighRarityRollContext,
): { ok: true; analysis: HighRarityRollAnalysis } | { ok: false; issues: EquipmentIssue[] } {
  const planned = planHighRarityRoll(definition, ctx);
  if (!planned.ok) return planned;
  const { plan } = planned;
  return {
    ok: true,
    analysis: {
      counts: plan.counts.map((o) => ({ ...o, probability: o.weightBp / plan.countTotalBp })),
      countTotalBp: plan.countTotalBp,
      primarySpProbability: plan.primarySp ? plan.primarySp.chanceBp / BASIS_POINTS : 0,
      families: plan.families.map((f) => ({ stat: f.stat, minValue: f.minValue, maxValue: f.maxValue, step: f.step })),
      affixCandidates: plan.affix ? plan.affix.candidates.length : null,
    },
  };
}
