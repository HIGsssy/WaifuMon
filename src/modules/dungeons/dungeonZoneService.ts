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
 *   - **Preview** builds the graph the way a real run does — generated for a
 *     procedural zone, compiled from its rooms for an authored one — and
 *     persists nothing. **Simulate** is the generator's distribution over many
 *     seeds, so it exists for procedural zones only.
 *   - **Layout mode** is chosen when a zone is created. A save that would
 *     change it is refused unless it says so (`confirmLayoutChange`). Nothing
 *     is deleted either way: the generator settings and the rooms both stay in
 *     the document, whichever one is in use.
 *
 * Nothing here touches a run already generated: a run snapshots its zone.
 */
import { randomInt } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  artworkAssets,
  dungeonZones,
  progressionCurrencies,
  rewardTables,
  type DungeonZoneRow,
} from '../../db/schema';
import {
  AppError,
  DungeonZoneInvalidError,
  DungeonZoneKeyTakenError,
  DungeonZoneStaleError,
} from '../../shared/errors';
import { zoneDocumentAssetSlots, type ArtworkAssetService } from '../artworkAssets/artworkAssetService';
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import {
  AuthoredLayoutError,
  analyseAuthoredLayout,
  buildDungeonGraph,
  selectRunScenes,
  zoneRunLength,
} from './authoredLayout';
import {
  isValidDungeonSeed,
  MAX_DUNGEON_SEED,
  type DungeonContentCatalogue,
  type DungeonGraph,
} from './dungeonGenerator';
import type { DungeonRunScenes } from './dungeonScenes';
import { simulateDungeonGeneration, type DungeonSimulationReport } from './dungeonSimulation';
import {
  dungeonCatalogueFromContent,
  dungeonRegionsFromContent,
  parseDungeonZoneRow,
  readDungeonZoneRow,
  type DungeonRegionRef,
  type ShippedDungeonZone,
} from './dungeonZoneStore';
import type { DungeonEventDefinition } from './eventDefinitions';
import {
  DUNGEON_POOL_KEYS,
  DUNGEON_ZONE_FILE,
  DUNGEON_ZONE_FILE_FORMAT,
  DUNGEON_ZONE_FILE_VERSION,
  DungeonZoneDefinitionSchema,
  authoredLayoutOf,
  dungeonZoneHash,
  layoutModeOf,
  restRulesOf,
  type DungeonLayoutMode,
  type DungeonNodeType,
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
  /** How the zone's runs are laid out. */
  layoutMode: DungeonLayoutMode;
  /**
   * Rooms a run walks, shortest to longest: the generator's node range for a
   * procedural zone, the shortest and longest route for an authored one.
   */
  minNodes: number;
  maxNodes: number;
  /** Rooms in an authored layout; null for a procedural zone. */
  roomCount: number | null;
  /** The zone cover, for a thumbnail: the managed asset where set, else the shipped path. */
  artworkAssetId: string | null;
  artworkPath: string | null;
  /** Pools with at least one entry. */
  poolCount: number;
  poolEntryCount: number;
  rewardBandCount: number;
  /** Region ids the zone can be started in. */
  availableRegions: string[];
  revision: number;
  origin: DungeonZoneOrigin;
  /** Whether the row equals this build's shipped zone; null when none ships. */
  matchesShipped: boolean | null;
  updatedAt: Date;
  updatedBy: string | null;
  /**
   * Set while the zone's regions are a one-time compatibility value nobody
   * has reviewed: `all_enabled_regions` means it predates region availability
   * and was opened everywhere. Cleared by the next save.
   */
  regionBackfill: 'shipped' | 'all_enabled_regions' | null;
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
  /** The region catalogue, in its authored order. */
  regions: DungeonRegionRef[];
}

/**
 * What a generated graph did with the zone's structural rules — computed from
 * the graph, never assumed from the zone, so the preview shows what happened.
 */
export interface DungeonPreviewStructure {
  availableRegions: { id: string; name: string | null }[];
  artworkPath: string | null;
  backgroundArtworkPath: string | null;
  artworkAssetId: string | null;
  backgroundAssetId: string | null;
  /** The background each node drew for this seed — what a real run would snapshot. */
  scenes: DungeonRunScenes;
  restNodes: { id: string; depth: number; extraction: boolean }[];
  extractionNodes: { id: string; depth: number; type: DungeonNodeType }[];
  bossNodeId: string | null;
  restBeforeBoss: {
    /** Whether the zone asks for it. */
    required: boolean;
    /** Whether the node before the final one is a single rest no route can skip. */
    satisfied: boolean;
  };
}

/** Either a saved zone by key, or an unsaved draft. */
export type DungeonZoneTarget = { key: string } | { zone: unknown };

export interface DungeonPreview {
  zoneKey: string;
  /** How the graph was made. An authored graph is the same for every seed. */
  layoutMode: DungeonLayoutMode;
  seed: number;
  graph: DungeonGraph;
  /** Display names for the content the graph selected. */
  names: { enemies: Record<string, string>; events: Record<string, string> };
  structure: DungeonPreviewStructure;
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
  /**
   * `confirmLayoutChange` must be set for a save that changes the zone's
   * layout mode; without it such a save is refused and nothing is written.
   */
  update(
    key: string,
    input: { zone: unknown; expectedRevision: number; confirmLayoutChange?: boolean | undefined },
    actor: string | null,
  ): Promise<DungeonZoneDetail | null>;
  /** Switch a zone on or off. Off always succeeds; on is validated like a save. */
  setEnabled(
    key: string,
    input: { enabled: boolean; expectedRevision: number },
    actor: string | null,
  ): Promise<DungeonZoneDetail | null>;
  /**
   * One run's graph, without persisting anything: generated for a procedural
   * zone, the authored layout itself for an authored one. Null when `key`
   * names no zone.
   */
  preview(target: DungeonZoneTarget, seed?: number): Promise<DungeonPreview | null>;
  /** Procedural zones only: an authored zone has no generation to measure, and is refused. */
  simulate(
    target: DungeonZoneTarget,
    options: { runs: number; firstSeed?: number },
  ): Promise<DungeonSimulationReport | null>;
  export(): Promise<DungeonZoneExport>;
}

export interface DungeonContentSource {
  combatEnemies?: readonly CombatEnemyDefinition[] | undefined;
  dungeonEvents?: readonly DungeonEventDefinition[] | undefined;
  /** Region content. Absent or empty falls back to the closed set of region ids. */
  regions?: readonly { id: string; name: string; enabled: boolean; order?: number }[] | undefined;
}

export interface DungeonZoneServiceDeps {
  db: Db;
  /** Enemies and events — what pools reference. */
  getContent: () => DungeonContentSource;
  /** This build's shipped zones. */
  getShipped: () => readonly ShippedDungeonZone[];
  /** Managed artwork, for the reference audit trail. Optional: without it, nothing is recorded. */
  assets?: Pick<ArtworkAssetService, 'recordReferenceChanges'> | undefined;
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
  regions: readonly DungeonRegionRef[],
): Promise<DungeonZoneValidationContext> {
  const tables = await tx
    .select({ id: rewardTables.tableId, enabled: rewardTables.enabled })
    .from(rewardTables)
    .where(eq(rewardTables.kind, 'expedition'));
  const currencies = await tx
    .select({ key: progressionCurrencies.currencyKey, enabled: progressionCurrencies.enabled })
    .from(progressionCurrencies);
  const assets = await tx
    .select({ id: artworkAssets.id, name: artworkAssets.name, status: artworkAssets.status })
    .from(artworkAssets);
  return {
    catalogue,
    assets: new Map(assets.map((a) => [a.id, { name: a.name, status: a.status }])),
    rewardTables: new Map(tables.map((t) => [t.id, { enabled: t.enabled }])),
    currencies: new Map(currencies.map((c) => [c.key, { enabled: c.enabled }])),
    regions: new Map(regions.map((r) => [r.id, { name: r.name, enabled: r.enabled }])),
  };
}

/** Whether the node before the final one is a single rest that no route can skip. */
export function restPrecedesFinalNode(graph: DungeonGraph): boolean {
  const before = graph.nodes.filter((n) => n.depth === graph.depthCount - 1);
  return before.length === 1 && before[0]!.type === 'rest';
}

export function createDungeonZoneService(deps: DungeonZoneServiceDeps): DungeonZoneService {
  const { db } = deps;
  const catalogue = () => dungeonCatalogueFromContent(deps.getContent());
  const regions = () => dungeonRegionsFromContent(deps.getContent());
  const shippedFor = (key: string) => deps.getShipped().find((z) => z.key === key);

  function originOf(row: DungeonZoneRow): DungeonZoneOrigin {
    if (row.seedHash === null) return 'custom';
    return row.contentHash === row.seedHash ? 'shipped' : 'edited';
  }

  function summaryOf(row: DungeonZoneRow, zone: DungeonZoneDefinition): DungeonZoneSummary {
    const shipped = shippedFor(row.zoneKey);
    const mode = layoutModeOf(zone);
    const authored = mode === 'authored';
    return {
      key: row.zoneKey,
      name: zone.name,
      enabled: row.enabled,
      order: zone.order,
      tags: zone.tags,
      layoutMode: mode,
      minNodes: authored ? zoneRunLength(zone).min : zone.generation.minNodes,
      maxNodes: authored ? zoneRunLength(zone).max : zone.generation.maxNodes,
      roomCount: authored ? authoredLayoutOf(zone).rooms.length : null,
      artworkAssetId: zone.artworkAssetId,
      artworkPath: zone.artworkPath,
      poolCount: DUNGEON_POOL_KEYS.filter((p) => zone.pools[p].length > 0).length,
      poolEntryCount: DUNGEON_POOL_KEYS.reduce((n, p) => n + zone.pools[p].length, 0),
      rewardBandCount: zone.rewards.bands.length,
      availableRegions: zone.availableRegions,
      revision: row.revision,
      origin: originOf(row),
      matchesShipped: shipped ? shipped.hash === row.contentHash : null,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      regionBackfill: row.regionCompat === 'pending' ? null : row.regionCompat,
    };
  }

  async function detailOf(tx: DbOrTx, row: DungeonZoneRow): Promise<DungeonZoneDetail> {
    const zone = parseDungeonZoneRow(row);
    const ctx = await loadDungeonValidationContext(tx, catalogue(), regions());
    return { ...summaryOf(row, zone), zone, issues: validateDungeonZone(zone, ctx).issues };
  }

  /** Validate for a write and return the parsed zone, or throw with every issue. */
  async function assertWritable(tx: DbOrTx, key: string, input: unknown): Promise<DungeonZoneDefinition> {
    const ctx = await loadDungeonValidationContext(tx, catalogue(), regions());
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
        // An admin has now chosen the regions deliberately.
        regionCompat: null,
      })
      .where(and(eq(dungeonZones.zoneKey, row.zoneKey), eq(dungeonZones.revision, row.revision)))
      .returning();
    // The row is locked, so this only fails if the lock was not taken — still
    // answered as stale rather than as a silent no-op.
    if (!updated) throw new DungeonZoneStaleError(row.zoneKey, row.revision, -1, null, new Date());
    await deps.assets?.recordReferenceChanges(
      tx,
      {
        entity: `dungeon_zone:${row.zoneKey}`,
        before: zoneDocumentAssetSlots(row.definition),
        after: zoneDocumentAssetSlots(zone),
      },
      actor,
    );
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
        parsed.error.issues.map((i) => ({ path: zodIssuePath(i.path), message: i.message, severity: 'error' as const })),
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
        regions: regions(),
      };
    },

    async validate(input, key) {
      const ctx = await loadDungeonValidationContext(db, catalogue(), regions());
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
        await deps.assets?.recordReferenceChanges(
          tx,
          { entity: `dungeon_zone:${zone.key}`, before: [], after: zoneDocumentAssetSlots(zone) },
          actor,
        );
        return detailOf(tx, inserted);
      });
    },

    async update(key, { zone: input, expectedRevision, confirmLayoutChange }, actor) {
      return db.transaction(async (tx) => {
        const row = await readDungeonZoneRow(tx, key, true);
        if (!row) return null;
        assertRevision(row, expectedRevision);
        const zone = await assertWritable(tx, key, input);
        const before = layoutModeOf(parseDungeonZoneRow(row));
        const after = layoutModeOf(zone);
        if (before !== after && confirmLayoutChange !== true) {
          const name = (mode: DungeonLayoutMode) => (mode === 'authored' ? 'room-by-room' : 'procedural');
          throw new DungeonZoneInvalidError([
            {
              path: 'layoutMode',
              message:
                `This would change the dungeon from ${name(before)} to ${name(after)}. ` +
                'Confirm the layout change to save it. Nothing is deleted: the generator settings and the rooms are both kept.',
              severity: 'error',
            },
          ]);
        }
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
      let graph: DungeonGraph;
      try {
        graph = buildDungeonGraph(zone, content, chosen);
      } catch (err) {
        if (!(err instanceof AuthoredLayoutError)) throw err;
        throw new DungeonZoneInvalidError(err.issues.map((i) => ({ ...i, severity: 'error' as const })));
      }
      const names = { enemies: {} as Record<string, string>, events: {} as Record<string, string> };
      for (const node of graph.nodes) {
        if (!node.content) continue;
        const from = node.content.kind === 'enemy' ? content.enemies : content.events;
        const into = node.content.kind === 'enemy' ? names.enemies : names.events;
        into[node.content.key] = from.get(node.content.key)?.name ?? node.content.key;
      }
      const regionNames = new Map(regions().map((r) => [r.id, r.name]));
      const structure: DungeonPreviewStructure = {
        availableRegions: zone.availableRegions.map((id) => ({ id, name: regionNames.get(id) ?? null })),
        artworkPath: zone.artworkPath,
        backgroundArtworkPath: zone.backgroundArtworkPath,
        artworkAssetId: zone.artworkAssetId,
        backgroundAssetId: zone.backgroundAssetId,
        scenes: selectRunScenes(zone, graph, chosen),
        restNodes: graph.nodes.filter((n) => n.type === 'rest').map((n) => ({ id: n.id, depth: n.depth, extraction: n.extraction })),
        extractionNodes: graph.nodes.filter((n) => n.extraction).map((n) => ({ id: n.id, depth: n.depth, type: n.type })),
        bossNodeId: graph.nodes.find((n) => n.boss)?.id ?? null,
        restBeforeBoss: {
          // A generator guarantee: an authored layout promises only what its rooms show.
          required: layoutModeOf(zone) !== 'authored' && restRulesOf(zone.generation).beforeBoss,
          satisfied: restPrecedesFinalNode(graph),
        },
      };
      return { zoneKey: zone.key, layoutMode: layoutModeOf(zone), seed: chosen, graph, names, structure };
    },

    async simulate(target, options) {
      const zone = await resolveTarget(target);
      if (!zone) return null;
      if (layoutModeOf(zone) === 'authored') {
        const rooms = analyseAuthoredLayout(zone).reachable.length;
        throw new AppError(
          'VALIDATION_ERROR',
          `dungeon zone "${zone.key}" is authored: there is no generation to simulate`,
          `This dungeon is built room by room, so every run walks the same ${rooms} rooms — there is nothing to simulate. Use Preview to see the layout.`,
        );
      }
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
