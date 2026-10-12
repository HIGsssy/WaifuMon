/**
 * The reward dependencies a published dungeon revision pins (design 9.1).
 *
 * Pure: the caller supplies the catalogues (`DungeonRewardValidationContext`,
 * the same one validation reads). Nothing here rolls, grants or queries.
 *
 * ## Two hashes, and what moves them
 *
 * `hash` is the snapshot's *gameplay* identity: the resolver version, each
 * referenced table's body hash, each selector's eligible definition keys and
 * the item slugs. It is what `dungeonGameplayHash` folds into a revision's
 * gameplay hash, so it decides whether a publish writes a new revision.
 *
 * Display metadata is stored beside it and is deliberately **not** hashed: a
 * table's name, tier and authoring revision, an item's name and category, a
 * candidate's name, slot and rarity. Renaming a table or an item is not a
 * gameplay change and must not force a new revision. A slot or rarity edit
 * that matters does so by changing which definitions a selector matches, and
 * that changes the key list.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  describeEquipmentSelector,
  equipmentSelectorKey,
  EQUIPMENT_REWARD_RARITIES,
  type EquipmentRewardSelector,
  type RewardableDefinition,
} from '../../equipment/rewardSelector';
import {
  EQUIPMENT_KEY_MAX_LENGTH,
  EQUIPMENT_KEY_PATTERN,
  EQUIPMENT_SLOTS,
} from '../../equipment/vocabulary';
import { canonicalJson } from '../../rewardTables/rewardTableCore';
import { DUNGEON_LOOT_RESOLVER_VERSION } from '../engine/lootResolver';
import type { DungeonRewardValidationContext } from '../validation/dungeonRewardValidation';
import type { DungeonDefinition } from './dungeonDefinition';
import { DungeonKeySchema } from './dungeonIdentifiers';
import { dungeonRewardSites } from './dungeonRewardSites';
import {
  DungeonLootTableBodySchema,
  type DungeonLootTableBody,
  type DungeonRewardGrant,
} from './dungeonRewards';

export const DUNGEON_REWARD_SNAPSHOT_FORMAT = 'waifumon-dungeon-reward-snapshot' as const;
export const DUNGEON_REWARD_SNAPSHOT_VERSION = 1 as const;

const prefixedSha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const SnapshotTableSchema = z
  .object({
    key: DungeonKeySchema,
    name: z.string(),
    tier: z.string().nullable(),
    /** The catalogue row's authoring revision when it was read. Provenance only. */
    sourceRevision: z.number().int().min(1),
    /** The catalogue's body hash: bare hex, as `dungeon_loot_tables.content_hash`. */
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    body: DungeonLootTableBodySchema,
  })
  .strict();
const SnapshotCandidateSchema = z
  .object({
    key: z.string().max(EQUIPMENT_KEY_MAX_LENGTH).regex(EQUIPMENT_KEY_PATTERN),
    name: z.string(),
    slot: z.enum(EQUIPMENT_SLOTS),
    rarity: z.enum(EQUIPMENT_REWARD_RARITIES),
  })
  .strict();

export const DungeonRewardSnapshotSchema = z
  .object({
    format: z.literal(DUNGEON_REWARD_SNAPSHOT_FORMAT),
    version: z.literal(DUNGEON_REWARD_SNAPSHOT_VERSION),
    resolverVersion: z.literal(DUNGEON_LOOT_RESOLVER_VERSION),
    /** Every loot table the definition references, by key. */
    tables: z.record(z.string(), SnapshotTableSchema),
    /** By `equipmentSelectorKey`, for selectors inline and inside tables. Sorted by key. */
    equipmentPools: z.record(z.string(), z.array(SnapshotCandidateSchema).min(1)),
    /** Every item reachable from the rewards, as validated. A display fallback. */
    items: z.record(z.string(), z.object({ name: z.string(), category: z.string() }).strict()),
    hash: prefixedSha256,
  })
  .strict();
export type DungeonRewardSnapshot = z.infer<typeof DungeonRewardSnapshotSchema>;
export type DungeonRewardSnapshotTable = z.infer<typeof SnapshotTableSchema>;
/** An `EquipmentRewardCandidate` whose rarity is one a reward may pay. */
export type DungeonRewardSnapshotCandidate = z.infer<typeof SnapshotCandidateSchema>;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const sortedRecord = <T>(entries: Iterable<readonly [string, T]>): Record<string, T> =>
  Object.fromEntries([...entries].sort(([a], [b]) => compare(a, b)));

/** The catalogue's body hash (`dungeonLootTableContentHash`), without its service. */
export function dungeonLootBodyHash(body: DungeonLootTableBody): string {
  return sha256(DungeonLootTableBodySchema.parse(body));
}

/** See the module comment for what is and is not covered. */
export function dungeonRewardSnapshotHash(
  snapshot: Pick<DungeonRewardSnapshot, 'tables' | 'equipmentPools' | 'items'>,
): string {
  const identity = {
    format: DUNGEON_REWARD_SNAPSHOT_FORMAT,
    version: DUNGEON_REWARD_SNAPSHOT_VERSION,
    resolverVersion: DUNGEON_LOOT_RESOLVER_VERSION,
    tables: Object.fromEntries(
      Object.entries(snapshot.tables).map(([key, table]) => [key, dungeonLootBodyHash(table.body)]),
    ),
    equipmentPools: Object.fromEntries(
      Object.entries(snapshot.equipmentPools).map(([key, pool]) => [
        key,
        pool.map((candidate) => candidate.key).sort(compare),
      ]),
    ),
    items: Object.keys(snapshot.items).sort(compare),
  };
  return `sha256:${sha256(identity)}`;
}

/** What publication compares for a definition that has a reward snapshot (design 9.1). */
export function dungeonGameplayHash(contentHash: string, rewardSnapshotHash: string): string {
  return `sha256:${sha256({ v: 1, contentHash, rewardSnapshotHash })}`;
}

/** Whether any activity or reachable event outcome uses the v2 `rewards` bundle. Without one there is no snapshot. */
export function hasDungeonRewardBundles(definition: DungeonDefinition): boolean {
  return dungeonRewardSites(definition).length > 0;
}

/**
 * A stored snapshot, shape-checked and with its hash recomputed.
 * Null when it is absent, unreadable or does not hash to what it claims.
 */
export function readDungeonRewardSnapshot(raw: unknown): DungeonRewardSnapshot | null {
  if (raw == null) return null;
  const parsed = DungeonRewardSnapshotSchema.safeParse(raw);
  if (!parsed.success) return null;
  return dungeonRewardSnapshotHash(parsed.data) === parsed.data.hash ? parsed.data : null;
}

export type DungeonRewardTableState =
  | { status: 'ok'; table: DungeonRewardSnapshotTable }
  | {
      status: 'missing' | 'archived' | 'invalid';
      name: string | null;
      contentHash: string | null;
    };

/** The reward dependencies of a definition as the supplied catalogues have them now. */
export interface DungeonRewardDependencyState {
  /** Every referenced table, by key. */
  tables: Record<string, DungeonRewardTableState>;
  /** Every reachable selector, by selector key. `candidates` is null when nothing is eligible. */
  equipment: Record<
    string,
    { selector: EquipmentRewardSelector; candidates: DungeonRewardSnapshotCandidate[] | null }
  >;
  /** Every reachable item slug; null when the item does not exist. */
  items: Record<string, { name: string; category: string } | null>;
  /** The snapshot these make, or null while any dependency is missing, archived, unreadable or empty. */
  snapshot: DungeonRewardSnapshot | null;
}

function grantsOf(body: DungeonLootTableBody): DungeonRewardGrant[] {
  return [
    ...body.guaranteed.map((entry) => entry.grant),
    ...body.chances.map((entry) => entry.grant),
    ...body.pools.flatMap((pool) =>
      pool.entries.flatMap((entry) => ('grant' in entry ? [entry.grant] : [])),
    ),
  ];
}

function candidatesOf(
  selector: EquipmentRewardSelector,
  resolve: DungeonRewardValidationContext['resolveEquipmentSelector'],
): DungeonRewardSnapshotCandidate[] | null {
  let eligible: readonly RewardableDefinition[];
  try {
    eligible = resolve ? resolve(selector) : [];
  } catch {
    return null; // An invalid or unmatched selector, as `eligibleRewardDefinitions` reports it.
  }
  const candidates = z.array(SnapshotCandidateSchema).safeParse(
    eligible.map((d) => ({ key: d.key, name: d.name, slot: d.slot, rarity: d.rarity })),
  );
  if (!candidates.success || candidates.data.length === 0) return null;
  return candidates.data.sort((a, b) => compare(a.key, b.key));
}

/**
 * Resolve everything a definition's v2 rewards depend on against `ctx`.
 * Never throws for a broken dependency: it is reported in the state and the
 * snapshot is null. A catalogue the context omits counts as empty.
 */
export function resolveDungeonRewardDependencies(
  definition: DungeonDefinition,
  ctx: DungeonRewardValidationContext,
): DungeonRewardDependencyState {
  const tables = new Map<string, DungeonRewardTableState>();
  const grants: DungeonRewardGrant[] = [];
  for (const { bundle } of dungeonRewardSites(definition)) {
    grants.push(...bundle.guaranteed.map((entry) => entry.grant));
    grants.push(...bundle.chances.map((entry) => entry.grant));
    for (const ref of bundle.tables) {
      if (tables.has(ref.table)) continue;
      const row = ctx.lootTables?.get(ref.table);
      if (!row) {
        tables.set(ref.table, { status: 'missing', name: null, contentHash: null });
        continue;
      }
      const body = DungeonLootTableBodySchema.safeParse(row.body);
      if (!body.success) {
        tables.set(ref.table, { status: 'invalid', name: row.name, contentHash: null });
        continue;
      }
      const contentHash = dungeonLootBodyHash(body.data);
      if (row.archivedAt !== null) {
        tables.set(ref.table, { status: 'archived', name: row.name, contentHash });
        continue;
      }
      grants.push(...grantsOf(body.data));
      tables.set(ref.table, {
        status: 'ok',
        table: {
          key: ref.table,
          name: row.name,
          tier: row.tier ?? null,
          // A caller-built catalogue may carry no authoring revision; the service's always does.
          sourceRevision: row.revision ?? 1,
          contentHash,
          body: body.data,
        },
      });
    }
  }
  const equipment = new Map<string, DungeonRewardDependencyState['equipment'][string]>();
  const items = new Map<string, { name: string; category: string } | null>();
  for (const grant of grants) {
    if (grant.type === 'item' && !items.has(grant.item)) {
      const item = ctx.items?.get(grant.item);
      items.set(grant.item, item ? { name: item.name, category: item.category } : null);
    }
    if (grant.type === 'equipment') {
      const key = equipmentSelectorKey(grant.selector);
      if (!equipment.has(key))
        equipment.set(key, {
          selector: grant.selector,
          candidates: candidatesOf(grant.selector, ctx.resolveEquipmentSelector),
        });
    }
  }
  const state = {
    tables: sortedRecord(tables),
    equipment: sortedRecord(equipment),
    items: sortedRecord(items),
  };
  const complete =
    hasDungeonRewardBundles(definition) &&
    Object.values(state.tables).every((table) => table.status === 'ok') &&
    Object.values(state.equipment).every((pool) => pool.candidates !== null) &&
    Object.values(state.items).every((item) => item !== null);
  if (!complete) return { ...state, snapshot: null };
  const content = {
    tables: Object.fromEntries(
      Object.entries(state.tables).map(([key, table]) => [
        key,
        (table as Extract<DungeonRewardTableState, { status: 'ok' }>).table,
      ]),
    ),
    equipmentPools: Object.fromEntries(
      Object.entries(state.equipment).map(([key, pool]) => [key, pool.candidates!]),
    ),
    items: state.items as Record<string, { name: string; category: string }>,
  };
  return {
    ...state,
    snapshot: {
      format: DUNGEON_REWARD_SNAPSHOT_FORMAT,
      version: DUNGEON_REWARD_SNAPSHOT_VERSION,
      resolverVersion: DUNGEON_LOOT_RESOLVER_VERSION,
      ...content,
      hash: dungeonRewardSnapshotHash(content),
    },
  };
}

export type DungeonRewardDependencyChange =
  | {
      kind: 'table';
      tableKey: string;
      name: string;
      /** `changed`: the body differs from the one published. The rest: it cannot be published as it stands. */
      status: 'changed' | 'missing' | 'archived' | 'invalid';
      publishedHash: string | null;
      currentHash: string | null;
    }
  | {
      kind: 'equipment';
      selectorKey: string;
      description: string;
      /** `empty`: nothing is eligible any more. */
      status: 'changed' | 'empty';
      /** Definition keys eligible now and not when published, and the reverse. */
      added: string[];
      removed: string[];
    };

/**
 * How the live reward dependencies of a draft differ from what its published
 * revision pinned. Compares only what both name: a table or selector the
 * draft newly references is a definition change, which the content hash
 * already reports. A broken dependency is listed even when nothing is published.
 */
export function dungeonRewardDependencyChanges(
  published: DungeonRewardSnapshot | null,
  current: DungeonRewardDependencyState,
): DungeonRewardDependencyChange[] {
  const changes: DungeonRewardDependencyChange[] = [];
  for (const [tableKey, state] of Object.entries(current.tables)) {
    const pinned = published?.tables[tableKey];
    const publishedHash = pinned?.contentHash ?? null;
    if (state.status === 'ok') {
      if (pinned && pinned.contentHash !== state.table.contentHash)
        changes.push({
          kind: 'table',
          tableKey,
          name: state.table.name,
          status: 'changed',
          publishedHash,
          currentHash: state.table.contentHash,
        });
      continue;
    }
    changes.push({
      kind: 'table',
      tableKey,
      name: state.name ?? pinned?.name ?? tableKey,
      status: state.status,
      publishedHash,
      currentHash: state.contentHash,
    });
  }
  for (const [selectorKey, state] of Object.entries(current.equipment)) {
    const pinned = published?.equipmentPools[selectorKey]?.map((candidate) => candidate.key);
    const now = state.candidates?.map((candidate) => candidate.key) ?? [];
    const added = pinned ? now.filter((key) => !pinned.includes(key)) : [];
    const removed = pinned ? pinned.filter((key) => !now.includes(key)) : [];
    if (state.candidates !== null && added.length === 0 && removed.length === 0) continue;
    changes.push({
      kind: 'equipment',
      selectorKey,
      description: describeEquipmentSelector(state.selector),
      status: state.candidates === null ? 'empty' : 'changed',
      added,
      removed,
    });
  }
  return changes;
}
