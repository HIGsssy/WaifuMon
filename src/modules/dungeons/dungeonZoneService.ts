/**
 * Admin authoring for dungeon zones, and the dry-run tools that go with it.
 *
 *   - **Validation** happens on every write, inside the writing transaction
 *     (`validateDungeonZone`): the schema, every reference, whether the rules
 *     can be reached, and trial runs of the real generator. Errors refuse the
 *     save; warnings ride along.
 *   - **Concurrency** is optimistic. A save names the `revision` it edited and
 *     applies only while that is still current; a stale save is refused with
 *     the current revision, never merged and never overwritten.
 *   - **Lifecycle** is enable/disable. There is no delete: a zone key is
 *     recorded on every run that used it. Disabling is always allowed, even
 *     for a zone whose content has since broken.
 *   - **Preview** and **simulate** call the same generator a real run does and
 *     persist nothing.
 *
 * Nothing here touches a run already generated: a run snapshots its zone.
 */
import { randomInt } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { dungeonZones, progressionCurrencies, rewardTables, type DungeonZoneRow } from '../../db/schema';
import {
  DungeonZoneInvalidError,
  DungeonZoneKeyTakenError,
  DungeonZoneStaleError,
} from '../../shared/errors';
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import {
  generateDungeon,
  isValidDungeonSeed,
  MAX_DUNGEON_SEED,
  type DungeonContentCatalogue,
  type DungeonGraph,
} from './dungeonGenerator';
import { simulateDungeonGeneration, type DungeonSimulationReport } from './dungeonSimulation';
import {
  dungeonCatalogueFromContent,
  parseDungeonZoneRow,
  readDungeonZoneRow,
  type ShippedDungeonZone,
} from './dungeonZoneStore';
import type { DungeonEventDefinition } from './eventDefinitions';
import {
  DUNGEON_POOL_KEYS,
  DUNGEON_ZONE_FILE,
  DUNGEON_ZONE_FILE_FORMAT,
  DUNGEON_ZONE_FILE_VERSION,
  DungeonZoneDefinitionSchema,
  dungeonZoneHash,
  type DungeonZoneDefinition,
} from './zoneDefinition';
import {
  hasErrors,
  validateDungeonZone,
  zodIssuePath,
  type DungeonZoneIssue,
  type DungeonZoneValidationContext,
} from './zoneValidation';

/** Where a row stands relative to Git. */
export type DungeonZoneOrigin =
  /** Holds exactly what was last seeded from the shipped file. */
  | 'shipped'
  /** Seeded from Git, then changed by an admin. */
  | 'edited'
  /** Never shipped: created in the Portal. */
  | 'custom';

export interface DungeonZoneSummary {
  key: string;
  name: string;
  enabled: boolean;
  order: number;
  tags: string[];
  minNodes: number;
  maxNodes: number;
  /** Pools with at least one entry. */
  poolCount: number;
  poolEntryCount: number;
  rewardBandCount: number;
  revision: number;
  origin: DungeonZoneOrigin;
  /** Whether the row equals this build's shipped zone; null when none ships. */
  matchesShipped: boolean | null;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface DungeonZoneDetail extends DungeonZoneSummary {
  zone: DungeonZoneDefinition;
  /** Problems with the stored zone against this server right now. */
  issues: DungeonZoneIssue[];
}

/** What the editor's pickers offer. */
export interface DungeonReferenceData {
  enemies: { key: string; name: string; enabled: boolean; tags: string[] }[];
  events: { key: string; name: string; enabled: boolean; tags: string[] }[];
  rewardTables: { id: string; enabled: boolean }[];
  currencies: { key: string; singularName: string; pluralName: string; enabled: boolean }[];
}

/** Either a saved zone by key, or an unsaved draft. */
export type DungeonZoneTarget = { key: string } | { zone: unknown };

export interface DungeonPreview {
  zoneKey: string;
  seed: number;
  graph: DungeonGraph;
  /** Display names for the content the graph selected. */
  names: { enemies: Record<string, string>; events: Record<string, string> };
}

export interface DungeonZoneExport {
  /** `dungeons/zones.json` — where this goes in Git. */
  file: string;
  document: { format: string; version: number; zones: DungeonZoneDefinition[] };
}

export interface DungeonZoneService {
  list(): Promise<DungeonZoneSummary[]>;
  get(key: string): Promise<DungeonZoneDetail | null>;
  reference(): Promise<DungeonReferenceData>;
  /** Dry run: every issue a save of `zone` would raise, without writing. */
  validate(zone: unknown, key?: string): Promise<DungeonZoneIssue[]>;
  create(zone: unknown, actor: string | null): Promise<DungeonZoneDetail>;
  update(
    key: string,
    input: { zone: unknown; expectedRevision: number },
    actor: string | null,
  ): Promise<DungeonZoneDetail | null>;
  /** Switch a zone on or off. Off always succeeds; on is validated like a save. */
  setEnabled(
    key: string,
    input: { enabled: boolean; expectedRevision: number },
    actor: string | null,
  ): Promise<DungeonZoneDetail | null>;
  /** Generate one run without persisting anything. Null when `key` names no zone. */
  preview(target: DungeonZoneTarget, seed?: number): Promise<DungeonPreview | null>;
  simulate(
    target: DungeonZoneTarget,
    options: { runs: number; firstSeed?: number },
  ): Promise<DungeonSimulationReport | null>;
  export(): Promise<DungeonZoneExport>;
}

export interface DungeonContentSource {
  combatEnemies?: readonly CombatEnemyDefinition[] | undefined;
  dungeonEvents?: readonly DungeonEventDefinition[] | undefined;
}

export interface DungeonZoneServiceDeps {
  db: Db;
  /** Enemies and events — what pools reference. */
  getContent: () => DungeonContentSource;
  /** This build's shipped zones. */
  getShipped: () => readonly ShippedDungeonZone[];
}

/**
 * Keys a new zone may not take: they are path segments of the admin routes and
 * of the Portal's pages, so a zone named one of them could not be opened.
 */
export const RESERVED_DUNGEON_ZONE_KEYS: ReadonlySet<string> = new Set([
  'new',
  'export',
  'import',
  'validate',
  'reference',
  'preview',
  'simulate',
]);

/** A seed for a run or a preview that was not given one. Not part of generation. */
export function randomDungeonSeed(): number {
  return randomInt(0, MAX_DUNGEON_SEED + 1);
}

/** The reward tables and currencies a zone may reference, as this database holds them. */
export async function loadDungeonValidationContext(
  tx: DbOrTx,
  catalogue: DungeonContentCatalogue,
): Promise<DungeonZoneValidationContext> {
  const tables = await tx
    .select({ id: rewardTables.tableId, enabled: rewardTables.enabled })
    .from(rewardTables)
    .where(eq(rewardTables.kind, 'expedition'));
  const currencies = await tx
    .select({ key: progressionCurrencies.currencyKey, enabled: progressionCurrencies.enabled })
    .from(progressionCurrencies);
  return {
    catalogue,
    rewardTables: new Map(tables.map((t) => [t.id, { enabled: t.enabled }])),
    currencies: new Map(currencies.map((c) => [c.key, { enabled: c.enabled }])),
  };
}

export function createDungeonZoneService(deps: DungeonZoneServiceDeps): DungeonZoneService {
  const { db } = deps;
  const catalogue = () => dungeonCatalogueFromContent(deps.getContent());
  const shippedFor = (key: string) => deps.getShipped().find((z) => z.key === key);

  function originOf(row: DungeonZoneRow): DungeonZoneOrigin {
    if (row.seedHash === null) return 'custom';
    return row.contentHash === row.seedHash ? 'shipped' : 'edited';
  }

  function summaryOf(row: DungeonZoneRow, zone: DungeonZoneDefinition): DungeonZoneSummary {
    const shipped = shippedFor(row.zoneKey);
    return {
      key: row.zoneKey,
      name: zone.name,
      enabled: row.enabled,
      order: zone.order,
      tags: zone.tags,
      minNodes: zone.generation.minNodes,
      maxNodes: zone.generation.maxNodes,
      poolCount: DUNGEON_POOL_KEYS.filter((p) => zone.pools[p].length > 0).length,
      poolEntryCount: DUNGEON_POOL_KEYS.reduce((n, p) => n + zone.pools[p].length, 0),
      rewardBandCount: zone.rewards.bands.length,
      revision: row.revision,
      origin: originOf(row),
      matchesShipped: shipped ? shipped.hash === row.contentHash : null,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  async function detailOf(tx: DbOrTx, row: DungeonZoneRow): Promise<DungeonZoneDetail> {
    const zone = parseDungeonZoneRow(row);
    const ctx = await loadDungeonValidationContext(tx, catalogue());
    return { ...summaryOf(row, zone), zone, issues: validateDungeonZone(zone, ctx).issues };
  }

  /** Validate for a write and return the parsed zone, or throw with every issue. */
  async function assertWritable(tx: DbOrTx, key: string, input: unknown): Promise<DungeonZoneDefinition> {
    const ctx = await loadDungeonValidationContext(tx, catalogue());
    const { zone, issues } = validateDungeonZone(input, ctx);
    if (zone && zone.key !== key) {
      issues.unshift({ path: 'key', message: `the zone key is "${key}" and cannot be changed`, severity: 'error' });
    }
    if (!zone || hasErrors(issues)) throw new DungeonZoneInvalidError(issues);
    return zone;
  }

  function assertRevision(row: DungeonZoneRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new DungeonZoneStaleError(row.zoneKey, expectedRevision, row.revision, row.updatedBy, row.updatedAt);
    }
  }

  /** The conditional write every edit goes through. */
  async function writeRow(
    tx: DbOrTx,
    row: DungeonZoneRow,
    zone: DungeonZoneDefinition,
    actor: string | null,
  ): Promise<DungeonZoneRow> {
    const [updated] = await tx
      .update(dungeonZones)
      .set({
        definition: zone as unknown as Record<string, unknown>,
        enabled: zone.enabled,
        position: zone.order,
        contentHash: dungeonZoneHash(zone),
        revision: sql`${dungeonZones.revision} + 1`,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(and(eq(dungeonZones.zoneKey, row.zoneKey), eq(dungeonZones.revision, row.revision)))
      .returning();
    // The row is locked, so this only fails if the lock was not taken — still
    // answered as stale rather than as a silent no-op.
    if (!updated) throw new DungeonZoneStaleError(row.zoneKey, row.revision, -1, null, new Date());
    return updated;
  }

  function keyOf(input: unknown): string | null {
    if (input && typeof input === 'object' && typeof (input as { key?: unknown }).key === 'string') {
      return (input as { key: string }).key;
    }
    return null;
  }

  /** The zone a preview or simulation runs against; null for an unknown key. */
  async function resolveTarget(target: DungeonZoneTarget): Promise<DungeonZoneDefinition | null> {
    if ('key' in target) {
      const row = await readDungeonZoneRow(db, target.key);
      return row ? parseDungeonZoneRow(row) : null;
    }
    const parsed = DungeonZoneDefinitionSchema.safeParse(target.zone);
    if (!parsed.success) {
      throw new DungeonZoneInvalidError(
        parsed.error.issues.map((i) => ({ path: zodIssuePath(i.path), message: i.message, severity: 'error' })),
      );
    }
    return parsed.data;
  }

  return {
    async list() {
      const rows = await db
        .select()
        .from(dungeonZones)
        .orderBy(asc(dungeonZones.position), asc(dungeonZones.zoneKey));
      return rows.map((row) => summaryOf(row, parseDungeonZoneRow(row)));
    },

    async get(key) {
      const row = await readDungeonZoneRow(db, key);
      return row ? detailOf(db, row) : null;
    },

    async reference() {
      const content = deps.getContent();
      const tables = await db
        .select({ id: rewardTables.tableId, enabled: rewardTables.enabled })
        .from(rewardTables)
        .where(eq(rewardTables.kind, 'expedition'))
        .orderBy(asc(rewardTables.position), asc(rewardTables.tableId));
      const currencies = await db
        .select()
        .from(progressionCurrencies)
        .orderBy(asc(progressionCurrencies.currencyKey));
      const refs = (list: readonly { key: string; name: string; enabled: boolean; tags: string[] }[] | undefined) =>
        (list ?? []).map((c) => ({ key: c.key, name: c.name, enabled: c.enabled, tags: c.tags }));
      return {
        enemies: refs(content.combatEnemies),
        events: refs(content.dungeonEvents),
        rewardTables: tables,
        currencies: currencies.map((c) => ({
          key: c.currencyKey,
          singularName: c.singularName,
          pluralName: c.pluralName,
          enabled: c.enabled,
        })),
      };
    },

    async validate(input, key) {
      const ctx = await loadDungeonValidationContext(db, catalogue());
      const { zone, issues } = validateDungeonZone(input, ctx);
      if (key && zone && zone.key !== key) {
        issues.unshift({ path: 'key', message: `the zone key is "${key}" and cannot be changed`, severity: 'error' });
      }
      return issues;
    },

    async create(input, actor) {
      return db.transaction(async (tx) => {
        const key = keyOf(input) ?? '';
        if (RESERVED_DUNGEON_ZONE_KEYS.has(key)) {
          throw new DungeonZoneInvalidError([
            { path: 'key', message: `"${key}" is reserved — choose another zone key`, severity: 'error' },
          ]);
        }
        const zone = await assertWritable(tx, key, input);
        const hash = dungeonZoneHash(zone);
        const [inserted] = await tx
          .insert(dungeonZones)
          .values({
            zoneKey: zone.key,
            enabled: zone.enabled,
            definition: zone as unknown as Record<string, unknown>,
            contentHash: hash,
            // A zone that ships in Git but was missing here (only before the
            // seed has run) is tracked against the shipped copy from the start.
            seedHash: shippedFor(zone.key)?.hash ?? null,
            position: zone.order,
            updatedBy: actor,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) throw new DungeonZoneKeyTakenError(zone.key);
        return detailOf(tx, inserted);
      });
    },

    async update(key, { zone: input, expectedRevision }, actor) {
      return db.transaction(async (tx) => {
        const row = await readDungeonZoneRow(tx, key, true);
        if (!row) return null;
        assertRevision(row, expectedRevision);
        const zone = await assertWritable(tx, key, input);
        return detailOf(tx, await writeRow(tx, row, zone, actor));
      });
    },

    async setEnabled(key, { enabled, expectedRevision }, actor) {
      return db.transaction(async (tx) => {
        const row = await readDungeonZoneRow(tx, key, true);
        if (!row) return null;
        assertRevision(row, expectedRevision);
        const next = { ...parseDungeonZoneRow(row), enabled };
        // Switching off is the emergency stop: it must work on a zone whose
        // content has since broken, so only switching on is validated.
        const zone = enabled ? await assertWritable(tx, key, next) : next;
        return detailOf(tx, await writeRow(tx, row, zone, actor));
      });
    },

    async preview(target, seed) {
      const zone = await resolveTarget(target);
      if (!zone) return null;
      const chosen = seed ?? randomDungeonSeed();
      if (!isValidDungeonSeed(chosen)) {
        throw new DungeonZoneInvalidError([
          { path: 'seed', message: `seed must be an integer from 0 to ${MAX_DUNGEON_SEED}`, severity: 'error' },
        ]);
      }
      const content = catalogue();
      const graph = generateDungeon(zone, content, chosen);
      const names = { enemies: {} as Record<string, string>, events: {} as Record<string, string> };
      for (const node of graph.nodes) {
        if (!node.content) continue;
        const from = node.content.kind === 'enemy' ? content.enemies : content.events;
        const into = node.content.kind === 'enemy' ? names.enemies : names.events;
        into[node.content.key] = from.get(node.content.key)?.name ?? node.content.key;
      }
      return { zoneKey: zone.key, seed: chosen, graph, names };
    },

    async simulate(target, options) {
      const zone = await resolveTarget(target);
      if (!zone) return null;
      return simulateDungeonGeneration(zone, catalogue(), options);
    },

    async export() {
      const rows = await db
        .select()
        .from(dungeonZones)
        .orderBy(asc(dungeonZones.position), asc(dungeonZones.zoneKey));
      return {
        file: DUNGEON_ZONE_FILE,
        document: {
          format: DUNGEON_ZONE_FILE_FORMAT,
          version: DUNGEON_ZONE_FILE_VERSION,
          zones: rows.map(parseDungeonZoneRow),
        },
      };
    },
  };
}
