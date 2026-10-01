/**
 * Equipment reward selectors — the one authored shape every reward source uses
 * to say *which kind* of gear it hands out, and the pure rules that turn one
 * into a base definition.
 *
 * A World Encounter `give_equipment` effect, a boss reward entry and an
 * expedition reward entry all carry the same selector:
 *
 *   { slot?, rarity?, definitionKeys? }
 *
 *   - `slot` — `attack` / `defense` / `health`; omitted means any slot.
 *   - `rarity` — `N` / `R` / `SR`; omitted means any of those three. SSR and
 *     above are never acquired randomly yet (they have no affix pool), so they
 *     are outside every selector, explicit or not.
 *   - `definitionKeys` — an optional whitelist, combined with the two filters.
 *
 * The source decides **whether** a reward happens; the selector decides
 * **which base definitions** are eligible; selection among them is uniform.
 * Nothing here — and nothing a reward source authors — decides a multiplier
 * or an affix: those belong to `grantEquipment` (`equipmentRoll.ts`).
 *
 * ## Strict, not permissive
 *
 * An explicit key that does not exist, is disabled, or contradicts the
 * selector's own slot/rarity makes the whole selector invalid — it is never
 * quietly dropped from the pool. A selector whose pool comes out empty is
 * invalid too. Both fail with {@link EquipmentRewardConfigError}; there is no
 * fallback to another slot, rarity or the starter gear.
 *
 * Kept free of database imports: the content loader validates selector shapes
 * with {@link EquipmentRewardSelectorSchema}, and the pure checks below run at
 * authoring time, import time and runtime against whatever definition list the
 * caller read.
 */
import { z } from 'zod';
import { EquipmentRewardConfigError, type EquipmentIssue } from '../../shared/errors';
import type { Rng } from '../../shared/random';
import { EQUIPMENT_AFFIX_RARITIES } from './affixCatalogue';
import {
  EQUIPMENT_KEY_MAX_LENGTH,
  EQUIPMENT_KEY_PATTERN,
  EQUIPMENT_SLOTS,
  type EquipmentSlot,
} from './vocabulary';

/** Rarities a reward may hand out at random — exactly the rarities with affix pools. */
export const EQUIPMENT_REWARD_RARITIES = EQUIPMENT_AFFIX_RARITIES;
export type EquipmentRewardRarity = (typeof EQUIPMENT_REWARD_RARITIES)[number];

/** Longest explicit whitelist one selector may name. */
export const EQUIPMENT_REWARD_MAX_KEYS = 50;

/**
 * The selector's fields, as a raw Zod shape — spread into a World Encounter
 * effect (which must stay a plain object for its discriminated union) and
 * wrapped by {@link EquipmentRewardSelectorSchema} everywhere else. One shape,
 * so the three reward sources cannot drift apart.
 */
export const EQUIPMENT_REWARD_SELECTOR_SHAPE = {
  slot: z.enum(EQUIPMENT_SLOTS).optional(),
  rarity: z.enum(EQUIPMENT_REWARD_RARITIES).optional(),
  definitionKeys: z
    .array(
      z
        .string()
        .min(1)
        .max(EQUIPMENT_KEY_MAX_LENGTH)
        .regex(EQUIPMENT_KEY_PATTERN, 'definition key must be lowercase snake_case'),
    )
    .min(1, 'list at least one definition, or omit definitionKeys for any matching definition')
    .max(EQUIPMENT_REWARD_MAX_KEYS)
    .refine((keys) => new Set(keys).size === keys.length, 'lists the same definition twice')
    .optional(),
} as const;

/** Strict, so an authored `affixKey`, `multiplier` or `pool` is refused rather than ignored. */
export const EquipmentRewardSelectorSchema = z.object(EQUIPMENT_REWARD_SELECTOR_SHAPE).strict();
export type EquipmentRewardSelector = z.infer<typeof EquipmentRewardSelectorSchema>;

/** What selection needs to know about a definition. */
export interface RewardableDefinition {
  key: string;
  name: string;
  slot: EquipmentSlot | string;
  rarity: string;
  enabled: boolean;
}

function isRewardRarity(rarity: string): boolean {
  return (EQUIPMENT_REWARD_RARITIES as readonly string[]).includes(rarity);
}

function matchesFilters(selector: EquipmentRewardSelector, definition: RewardableDefinition): boolean {
  if (selector.slot !== undefined && definition.slot !== selector.slot) return false;
  if (selector.rarity !== undefined && definition.rarity !== selector.rarity) return false;
  return isRewardRarity(definition.rarity);
}

/** `Any R Attack Equipment`, `One of 2 listed N Equipment` — for logs, errors and authoring summaries. */
export function describeEquipmentSelector(selector: EquipmentRewardSelector): string {
  const rarity = selector.rarity ? `${selector.rarity} ` : '';
  const slot = selector.slot ? `${selector.slot[0]!.toUpperCase()}${selector.slot.slice(1)} ` : '';
  const keys = selector.definitionKeys;
  if (keys && keys.length > 0) {
    return keys.length === 1
      ? `${rarity}${slot}Equipment: ${keys[0]}`
      : `One of ${keys.length} listed ${rarity}${slot}Equipment`;
  }
  return `Any ${rarity}${slot}Equipment`;
}

/**
 * A stable identity for a selector — the same selector authored with its
 * whitelist in another order gets the same key. Used to look a snapshotted
 * pool back up (expeditions) and to spot a duplicate entry in a reward group.
 */
export function equipmentSelectorKey(selector: EquipmentRewardSelector): string {
  const keys = selector.definitionKeys ? [...selector.definitionKeys].sort().join(',') : '*';
  return `slot=${selector.slot ?? '*'};rarity=${selector.rarity ?? '*'};keys=${keys}`;
}

/**
 * Everything wrong with a selector against this definition list, by path.
 * Empty means the selector is valid *and* has at least one eligible
 * definition. Checks the runtime shape too, so a stored selector this build
 * cannot read is reported rather than coerced.
 */
export function equipmentSelectorIssues(
  selector: unknown,
  definitions: readonly RewardableDefinition[],
): EquipmentIssue[] {
  const parsed = EquipmentRewardSelectorSchema.safeParse(selector);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'selector', message: i.message }));
  }
  const s = parsed.data;
  const issues: EquipmentIssue[] = [];
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  for (const [index, key] of (s.definitionKeys ?? []).entries()) {
    const path = `definitionKeys[${index}]`;
    const definition = byKey.get(key);
    if (!definition) {
      issues.push({ path, message: `"${key}" is not an equipment definition` });
      continue;
    }
    if (!definition.enabled) {
      issues.push({ path, message: `"${key}" is disabled and cannot be acquired` });
    }
    if (s.slot !== undefined && definition.slot !== s.slot) {
      issues.push({ path, message: `"${key}" is ${definition.slot} gear, but this reward is ${s.slot} only` });
    }
    if (s.rarity !== undefined && definition.rarity !== s.rarity) {
      issues.push({ path, message: `"${key}" is ${definition.rarity}, but this reward is ${s.rarity} only` });
    } else if (!isRewardRarity(definition.rarity)) {
      issues.push({
        path,
        message: `"${key}" is ${definition.rarity}; random rewards hand out only ${EQUIPMENT_REWARD_RARITIES.join('/')}`,
      });
    }
  }
  if (issues.length > 0) return issues;
  if (eligibleUnchecked(s, definitions).length === 0) {
    issues.push({
      path: 'selector',
      message: `no enabled equipment definition matches "${describeEquipmentSelector(s)}"`,
    });
  }
  return issues;
}

function eligibleUnchecked(
  selector: EquipmentRewardSelector,
  definitions: readonly RewardableDefinition[],
): RewardableDefinition[] {
  const whitelist = selector.definitionKeys ? new Set(selector.definitionKeys) : null;
  return definitions
    .filter((d) => d.enabled && matchesFilters(selector, d) && (whitelist === null || whitelist.has(d.key)))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The definitions a selector may hand out, sorted by key so a seeded or
 * derived draw is stable regardless of the order the list was read in.
 *
 * @throws {EquipmentRewardConfigError} for any issue {@link equipmentSelectorIssues} reports.
 */
export function eligibleRewardDefinitions(
  selector: unknown,
  definitions: readonly RewardableDefinition[],
): RewardableDefinition[] {
  const issues = equipmentSelectorIssues(selector, definitions);
  if (issues.length > 0) throw new EquipmentRewardConfigError(issues);
  return eligibleUnchecked(EquipmentRewardSelectorSchema.parse(selector), definitions);
}

/**
 * One definition, uniformly, from an already-eligible pool. No per-definition
 * weights yet: the reward source controls whether a drop happens and which
 * pool applies; within the pool every base item is equally likely.
 */
export function pickRewardDefinition<T extends { key: string }>(eligible: readonly T[], rng: Rng): T {
  if (eligible.length === 0) {
    throw new EquipmentRewardConfigError([{ path: 'selector', message: 'no eligible equipment definition' }]);
  }
  return eligible[rng.intInclusive(0, eligible.length - 1)]!;
}
