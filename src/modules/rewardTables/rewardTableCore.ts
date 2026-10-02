/**
 * Boss and expedition reward tables — what both kinds share, pure.
 *
 * The two kinds have one group shape (`id`, `enabled`, `rolls`,
 * `chanceBasisPoints`, item `entries`, Equipment `equipment`) and differ only
 * at the table level (boss `buddyXp`; expedition currency ranges and XP) and
 * in who references them. Everything here is written once against that shared
 * group shape and parameterised by kind:
 *
 *   - parsing a stored or submitted table with the kind's own Zod schema;
 *   - the semantic hash the seed uses to tell an untouched row from an edited
 *     one;
 *   - authoring validation — schema, item references, Equipment selectors
 *     against the definitions on this server, and what references the table;
 *   - resolving each Equipment entry into the base definitions it may pay, for
 *     the snapshots bosses and expeditions take.
 *
 * No database and no logger: callers pass in what this needs.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  BossRewardTableSchema,
  ExpeditionRewardTableSchema,
  equipmentEntrySelector,
  type BossRewardTable,
  type EquipmentRewardEntry,
  type ExpeditionRewardTable,
} from '../content/schemas';
import {
  eligibleRewardDefinitions,
  equipmentSelectorIssues,
  equipmentSelectorKey,
  type EquipmentRewardSelector,
  type RewardableDefinition,
} from '../equipment/rewardSelector';
import type { EquipmentSlot } from '../equipment/vocabulary';

export const REWARD_TABLE_KINDS = ['boss', 'expedition'] as const;
export type RewardTableKind = (typeof REWARD_TABLE_KINDS)[number];

export type RewardTableOf<K extends RewardTableKind> = K extends 'boss' ? BossRewardTable : ExpeditionRewardTable;
export type AnyRewardTable = BossRewardTable | ExpeditionRewardTable;

/** The kind's own schema — the same one the content loader parses the shipped file with. */
export function rewardTableSchema(kind: RewardTableKind): z.ZodType<AnyRewardTable, z.ZodTypeDef, unknown> {
  return kind === 'boss' ? BossRewardTableSchema : ExpeditionRewardTableSchema;
}

/** The file a kind's shipped tables live in, relative to the content directory. */
export function rewardTableFile(kind: RewardTableKind): string {
  return kind === 'boss' ? 'bossRewards.json' : 'expeditionRewards.json';
}

// ── hashing ─────────────────────────────────────────────────────────────────

/** JSON with object keys sorted at every depth and array order kept. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * What a table *means*, as a hash: parsed (so defaults are filled in and a
 * file that spells out `"enabled": true` hashes the same as one that omits
 * it), then serialised with sorted keys and kept array order. Group and entry
 * order is significant — it changes deterministic draws — so reordering is a
 * change. Reformatting the file is not.
 *
 * @throws {z.ZodError} when the table does not parse as `kind`.
 */
export function rewardTableHash(kind: RewardTableKind, table: unknown): string {
  const parsed = rewardTableSchema(kind).parse(table);
  return createHash('sha256').update(canonicalJson(parsed)).digest('hex');
}

// ── references ──────────────────────────────────────────────────────────────

/** Something in content that pays from a reward table. */
export interface RewardTableReference {
  /** `boss` for a boss; the mission field otherwise. */
  role: 'boss' | 'success' | 'bonus' | 'failure';
  /** Boss id or expedition key. */
  key: string;
  name: string;
  enabled: boolean;
}

interface ReferenceSources {
  bosses: readonly { id: string; name: string; enabled: boolean; rewardTable: string }[];
  expeditions: readonly {
    key: string;
    name: string;
    enabled: boolean;
    rewardTable: string;
    exceptionalRewardTable: string | null;
    failureRewardTable: string | null;
  }[];
}

/** Every boss or mission that pays from `kind`/`id`, enabled or not. */
export function rewardTableReferences(
  kind: RewardTableKind,
  id: string,
  content: ReferenceSources,
): RewardTableReference[] {
  if (kind === 'boss') {
    return content.bosses
      .filter((b) => b.rewardTable === id)
      .map((b) => ({ role: 'boss' as const, key: b.id, name: b.name, enabled: b.enabled }));
  }
  const out: RewardTableReference[] = [];
  for (const e of content.expeditions) {
    const base = { key: e.key, name: e.name, enabled: e.enabled };
    if (e.rewardTable === id) out.push({ role: 'success', ...base });
    if (e.exceptionalRewardTable === id) out.push({ role: 'bonus', ...base });
    if (e.failureRewardTable === id) out.push({ role: 'failure', ...base });
  }
  return out;
}

// ── validation ──────────────────────────────────────────────────────────────

export interface RewardTableIssue {
  /** `groups[2].equipment[0].definitionKeys[1]` — where the editor shows it. */
  path: string;
  message: string;
  /** An error refuses the save; a warning is shown and saved through. */
  severity: 'error' | 'warning';
}

export interface RewardTableValidation {
  /** The parsed table when the schema accepted it. */
  table: AnyRewardTable | null;
  issues: RewardTableIssue[];
}

export interface RewardTableValidationContext {
  /** Item slugs that exist in content. */
  itemSlugs: ReadonlySet<string>;
  /** Every Equipment definition on this server, enabled or not. */
  definitions: readonly RewardableDefinition[];
  /** What pays from this table — for the "disabling stops X" warnings. */
  references: readonly RewardTableReference[];
}

function zodPath(path: readonly (string | number)[]): string {
  let out = '';
  for (const part of path) out += typeof part === 'number' ? `[${part}]` : out ? `.${part}` : part;
  return out || 'table';
}

/**
 * Everything wrong with a submitted table, by path and severity.
 *
 *   1. Schema — the kind's Zod schema, group and duplicate rules included.
 *      A schema failure stops here: nothing below can be checked reliably.
 *   2. Items — every entry's `itemId` must be an item in content.
 *   3. Equipment — each entry's selector against this server's definitions:
 *      missing, disabled, slot- or rarity-mismatched, SSR/UR, or matching
 *      nothing. An error when the entry could roll (table, group and entry all
 *      enabled), a warning otherwise — so disabling a table whose gear broke is
 *      always possible.
 *   4. References — switching off a table something live pays from is allowed
 *      (it is the emergency stop) but said out loud.
 */
export function validateRewardTable(
  kind: RewardTableKind,
  input: unknown,
  ctx: RewardTableValidationContext,
): RewardTableValidation {
  const parsed = rewardTableSchema(kind).safeParse(input);
  if (!parsed.success) {
    return {
      table: null,
      issues: parsed.error.issues.map((i) => ({ path: zodPath(i.path), message: i.message, severity: 'error' })),
    };
  }
  const table = parsed.data;
  const issues: RewardTableIssue[] = [];

  for (const [g, group] of table.groups.entries()) {
    for (const [e, entry] of group.entries.entries()) {
      if (!ctx.itemSlugs.has(entry.itemId)) {
        issues.push({
          path: `groups[${g}].entries[${e}].itemId`,
          message: `"${entry.itemId}" is not an item`,
          severity: 'error',
        });
      }
    }
    for (const [e, entry] of (group.equipment ?? []).entries()) {
      const live = table.enabled && group.enabled && entry.enabled;
      for (const issue of equipmentSelectorIssues(equipmentEntrySelector(entry), ctx.definitions)) {
        issues.push({
          path: issue.path === 'selector' ? `groups[${g}].equipment[${e}]` : `groups[${g}].equipment[${e}].${issue.path}`,
          message: live ? issue.message : `${issue.message} (not rolled while disabled)`,
          severity: live ? 'error' : 'warning',
        });
      }
    }
  }

  if (!table.enabled) {
    for (const ref of ctx.references.filter((r) => r.enabled)) {
      issues.push({ path: 'enabled', message: disabledReferenceMessage(ref), severity: 'warning' });
    }
  }
  return { table, issues };
}

function disabledReferenceMessage(ref: RewardTableReference): string {
  switch (ref.role) {
    case 'boss':
      return `boss "${ref.name}" (${ref.key}) will stop spawning while this table is disabled`;
    case 'success':
      return `mission "${ref.name}" (${ref.key}) cannot be deployed while its reward table is disabled`;
    case 'bonus':
      return `mission "${ref.name}" (${ref.key}) pays no exceptional bonus while this table is disabled`;
    case 'failure':
      return `mission "${ref.name}" (${ref.key}) pays no failure consolation while this table is disabled`;
  }
}

// ── Equipment pools ─────────────────────────────────────────────────────────

/** One base definition an Equipment entry may pay, as a snapshot records it. */
export interface EquipmentRewardCandidate {
  key: string;
  name: string;
  slot: EquipmentSlot;
  rarity: string;
}

/**
 * Every enabled Equipment entry's eligible definitions, keyed by
 * `equipmentSelectorKey` — resolved against the database when a boss spawns or
 * a mission deploys, and carried on the snapshot so payout is deterministic
 * and a definition disabled afterwards is still paid to whoever was promised it.
 */
export type EquipmentRewardPools = Readonly<Record<string, readonly EquipmentRewardCandidate[]>>;

type GroupWithEquipment = {
  enabled: boolean;
  equipment?: readonly EquipmentRewardEntry[] | undefined;
};

/**
 * The table as a player without the Equipment feature rolls it: every group's
 * Equipment entries removed, so gear is never in the pick to begin with.
 *
 * A group's item entries then share its whole weight — the same
 * renormalisation as disabling those entries — and the group keeps its id, so
 * every draw (keyed on group id and roll) stays exactly where it was. A group
 * that only ever paid gear is dropped rather than left with no entries, which
 * the rollers would otherwise report as a misconfigured table. A group that
 * was already empty is left alone so that warning still fires.
 *
 * Pure: the caller's table is not mutated.
 */
export function withoutEquipmentRewards<T extends AnyRewardTable>(table: T): T {
  const groups = table.groups.flatMap((group) => {
    const paysGear = group.enabled && (group.equipment ?? []).some((entry) => entry.enabled);
    const { equipment: _equipment, ...itemsOnly } = group;
    if (paysGear && !group.entries.some((entry) => entry.enabled)) return [];
    return [itemsOnly];
  });
  return { ...table, groups } as T;
}

/**
 * Every Equipment selector these tables can roll, deduplicated by
 * `equipmentSelectorKey`. Disabled groups and entries never roll, so they need
 * no pool.
 */
export function equipmentSelectorsOf(
  tables: readonly ({ groups: readonly GroupWithEquipment[] } | null | undefined)[],
): Map<string, EquipmentRewardSelector> {
  const selectors = new Map<string, EquipmentRewardSelector>();
  for (const table of tables) {
    for (const group of table?.groups ?? []) {
      if (!group.enabled) continue;
      for (const entry of group.equipment ?? []) {
        if (!entry.enabled) continue;
        const selector = equipmentEntrySelector(entry);
        selectors.set(equipmentSelectorKey(selector), selector);
      }
    }
  }
  return selectors;
}

/**
 * Resolve selectors into pools against a definition list.
 *
 * @throws {EquipmentRewardConfigError} for the first selector that is invalid
 *   or matches nothing — the snapshot must not be taken.
 */
export function resolveEquipmentPools(
  selectors: ReadonlyMap<string, EquipmentRewardSelector>,
  definitions: readonly RewardableDefinition[],
): Record<string, EquipmentRewardCandidate[]> {
  const pools: Record<string, EquipmentRewardCandidate[]> = {};
  for (const [key, selector] of selectors) {
    pools[key] = eligibleRewardDefinitions(selector, definitions).map((d) => ({
      key: d.key,
      name: d.name,
      slot: d.slot as EquipmentSlot,
      rarity: d.rarity,
    }));
  }
  return pools;
}
