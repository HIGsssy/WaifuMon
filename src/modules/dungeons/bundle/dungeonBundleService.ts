/**
 * Complete Dungeon Bundles: export, preview, apply (Content Portability
 * CP-4B). The format is `dungeonBundle.ts`. Everything here is built from the
 * systems that already own each piece:
 *
 *   - the dungeon: the Dungeon JSON export and importer (`dungeonImportService`),
 *     run inside this transaction with the bundle's dependencies in view;
 *   - enemies: CP-3's export collection, plan and write (`enemyPackageService.bundle`);
 *   - artwork: CP-3's asset entries, reuse rule, staging and insert (`artworkBundle`)
 *     and its journal and recovery (`importJournal`);
 *   - Scene Sprites and shared pools: their own services' in-transaction writes.
 *
 * ## Export
 *
 * The draft, the published revision or a numbered revision, read in one
 * repeatable-read transaction. Every artwork reference the dungeon makes, every
 * placed Scene Sprite and every enemy's art travel as verified bytes; every
 * referenced shared pool as its portable definition. A revision export carries
 * the revision's **frozen** sprite visuals, never today's catalogue rows. Any
 * image that cannot be read, or whose bytes are not what the dungeon names
 * (managed artwork replaced since it was chosen), refuses the export; the
 * archive is parsed back before it is returned, so an export is always
 * importable by this build.
 *
 * ## Preview, then apply what was previewed
 *
 * Preview writes nothing. It reviews the dungeon against what this server will
 * hold *after* the bundle's own dependencies are written — new enemies,
 * sprites, pools and artwork included — and reports every external
 * prerequisite (species, items, equipment, currencies, regions, legacy reward
 * tables) it does not install. Conflicts need explicit decisions:
 *
 *   - an enemy that differs: **update** (CP-3, existing enabled state kept) or **keep**;
 *   - a Scene Sprite that differs: **update** the shared sprite, **keep** this
 *     server's, or **copy** under a new key for this dungeon only;
 *   - a shared pool that differs: **update** it (other dungeons' future runs
 *     follow, and the review lists them) or **keep** this server's;
 *   - a loot table that differs: the Dungeon JSON importer's own decisions.
 *
 * `planHash` binds the review to the destination state, independent of the
 * decisions chosen; apply recomputes it under the apply locks and refuses
 * (`DUNGEON_BUNDLE_STALE`) if anything it relied on moved.
 *
 * ## Lifecycle
 *
 * Exactly CP-4A's: the dungeon's **draft** only. A new dungeon is created
 * disabled and unpublished; an existing one keeps its enabled state and
 * published revision, so players, active runs and the published species
 * policy stay on that revision until someone publishes. New enemies and new
 * shared pools arrive disabled. Nothing is enabled or published here.
 *
 * ## Files and the database
 *
 * CP-3's order, through its journal (`kind = dungeon_bundle`): journal row
 * committed, then new artwork staged under fresh ids, then one transaction
 * (locks → state check → asset rows → enemies → sprites → pools → dungeon
 * draft → receipt). A caught failure removes unclaimed staged files; a crash
 * leaves a `staged` row that the shared startup recovery cleans up. Reused
 * assets are never written, disabled or deleted.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../../../db/client';
import {
  artworkAssets,
  dungeonSceneSprites,
  dungeonSpeciesPools,
  equipmentDefinitions,
  items,
  progressionCurrencies,
  rewardTables,
  species as speciesTable,
  type ArtworkAssetCategory,
} from '../../../db/schema';
import {
  ArtworkUploadInvalidError,
  DungeonBundleDecisionsRequiredError,
  DungeonBundleExportRefusedError,
  DungeonBundleInvalidError,
  DungeonBundleRejectedError,
  DungeonBundleRequestConflictError,
  DungeonBundleStaleError,
  DungeonImportError,
  DungeonInvalidError,
  type DungeonBundleExportRefusal,
  type DungeonBundleIssue,
  uniqueViolationConstraint,
} from '../../../shared/errors';
import type { ArtworkAssetService } from '../../artworkAssets/artworkAssetService';
import type { ArtworkStorage } from '../../artworkAssets/artworkStorage';
import { inspectImage, type InspectedImage } from '../../artworkAssets/imageInspection';
import { managedArtworkIndex, managedArtworkKey } from '../../artworkAssets/managedArtworkLookup';
import {
  createBundleAssetCollector,
  findReusableAsset,
  insertStagedAssets,
  planStagedAssets,
  writeStagedAssets,
  type BundleAssetEntry,
  type StagedBundleAsset,
} from '../../artworkAssets/package/artworkBundle';
import {
  failImportJournal,
  findImportReceipt,
  markImportApplied,
  openImportJournal,
} from '../../artworkAssets/package/importJournal';
import { locateArtworkFile } from '../../assets/artworkFile';
import { ENEMY_PACKAGE_CONTENT_TYPE, ENEMY_PACKAGE_FORMAT, ENEMY_PACKAGE_VERSION, type EnemyPackageManifest } from '../../enemies/enemyPackage';
import type { EnemyImportEntry, EnemyPackageService, EnemyPlannedEntry, EnemySlotDestination } from '../../enemies/enemyPackageService';
import { readCombatEnemyRows } from '../../enemies/enemyStore';
import { canonicalJson } from '../../rewardTables/rewardTableCore';
import { dungeonDependencies, type DungeonArtworkRef, type DungeonDefinition } from '../content/dungeonDefinition';
import type { DungeonContentService, DungeonExportOrigin } from '../dungeonContentService';
import { DungeonLootImportDecisionsSchema } from '../package/dungeonLootImport';
import {
  isRepairableImportIssue,
  type DungeonBundleImportContext,
  type DungeonImportPlan,
  type DungeonImportResult,
} from '../package/dungeonImportService';
import { SceneSpriteInputSchema, sceneSpriteKeys } from '../sceneSprites/sceneSpriteDefinition';
import type { SceneSpriteService } from '../sceneSprites/sceneSpriteService';
import { sceneSpriteCatalogue, type SceneSpriteCatalogue } from '../sceneSprites/sceneSpriteSnapshot';
import { SharedPoolDefinitionSchema, sharedPoolKeys, type SharedPoolDefinition } from '../sharedPools/sharedPoolDefinition';
import type { SharedDungeonPoolService } from '../sharedPools/sharedPoolService';
import {
  BUNDLE_DUNGEON_FILE,
  BUNDLE_ENEMY_DEFINITIONS_FILE,
  BUNDLE_ENEMY_MANIFEST_FILE,
  BUNDLE_POOLS_FILE,
  DUNGEON_BUNDLE_CONTENT_TYPE,
  DUNGEON_BUNDLE_FORMAT,
  DUNGEON_BUNDLE_LIMITS,
  DUNGEON_BUNDLE_VERSION,
  buildDungeonBundleArchive,
  dungeonBundleFilename,
  parseDungeonBundle,
  rebindShippedArtwork,
  rekeySceneSprites,
  shippedDungeonArtworkCategory,
  type BundleSceneSprite,
  type DungeonBundle,
  type DungeonBundleManifest,
} from './dungeonBundle';
import { importHash } from '../package/dungeonImportService';

// ── public shapes ───────────────────────────────────────────────────────────

export const DungeonBundleDecisionsSchema = z
  .object({
    /** The explicit dungeon decision the review asked for. Required to apply. */
    dungeon: z.enum(['create', 'replace', 'unchanged']).optional(),
    enemies: z.record(z.string().max(100), z.enum(['update', 'keep'])).default({}),
    sceneSprites: z.record(z.string().max(100), z.enum(['update', 'keep', 'copy'])).default({}),
    sharedPools: z.record(z.string().max(100), z.enum(['update', 'keep'])).default({}),
    lootTables: DungeonLootImportDecisionsSchema.optional(),
    /** Repair mode: accept a draft that still lacks external prerequisites. Never bypasses bundle checks. */
    allowIncomplete: z.boolean().default(false),
  })
  .strict();
export type DungeonBundleDecisions = z.infer<typeof DungeonBundleDecisionsSchema>;

export interface BundlePlanIssue {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

/** Where one of the dungeon's own artwork references comes from on this server. */
export interface BundleDungeonArtworkPlan {
  /** Plain words: "Dungeon cover", "Room “Hall” background". */
  usage: string[];
  source: 'managed' | 'shipped';
  /** The shipped path, for a shipped reference. Diagnostics. */
  path: string | null;
  asset: string;
  /** `shipped_file`: this server's own file holds the same bytes. `reuse` / `create`: managed artwork. */
  destination: 'shipped_file' | 'reuse' | 'create';
  /** A shipped image this server lacks (or holds differently) becomes its managed copy in the draft. */
  rebound: boolean;
}

export interface BundleAssetPlan extends BundleAssetEntry {
  action: 'reuse' | 'create' | 'not_needed';
  /** Destination assets reused for it. Diagnostics. */
  reuse: string[];
  usedBy: string[];
}

export interface BundleSpritePlan {
  key: string;
  name: string;
  outcome: 'create' | 'identical' | 'conflict';
  changedFields: string[];
  archivedHere: boolean;
  /** Where this server already uses the sprite (drafts and revisions). */
  references: { dungeonKey: string; name: string; source: string }[];
  suggestedCopyKey: string;
  decision: 'update' | 'keep' | 'copy' | null;
  /** The sprite key this dungeon will place after import. */
  resultKey: string;
  asset: string;
  assetDestination: 'reuse' | 'create' | 'not_needed';
}

export interface BundlePoolPlan {
  key: string;
  name: string;
  outcome: 'create' | 'identical' | 'conflict';
  changedFields: string[];
  /** This server's state now; null when the pool is new here. */
  enabledHere: boolean | null;
  enabledAfterImport: boolean;
  currentRevision: number | null;
  /** Other dungeons whose drafts or publications use this pool here. */
  otherDungeons: { dungeonKey: string; name: string; source: string }[];
  decision: 'update' | 'keep' | null;
  /** Which body the dungeon is reviewed (and will run) with. */
  uses: 'bundled' | 'destination';
  species: { slug: string; status: 'available' | 'missing' | 'disabled' }[];
}

export interface BundleEnemyPlan extends EnemyImportEntry {
  decision: 'update' | 'keep' | null;
}

export interface BundlePrerequisite {
  kind: 'species' | 'item' | 'equipment' | 'currency' | 'region' | 'reward_table';
  key: string;
  name: string;
  status: 'available' | 'missing' | 'disabled';
  notes: string[];
}

export interface BundleDisabledDependency {
  kind: 'enemy' | 'shared_pool';
  key: string;
  name: string;
  /** Publication refuses until it is enabled (shared pools); enemies only warn. */
  requiredForPublication: boolean;
}

/**
 * - `ready`: complete; validate and publish with the existing tools.
 * - `needs_enabling`: complete, but a shared pool will be disabled — enable it before publishing.
 * - `incomplete`: only missing external prerequisites block it; importable as a repair draft.
 * - `blocked`: cannot be imported here as reviewed.
 */
export type BundleReadiness = 'ready' | 'needs_enabling' | 'incomplete' | 'blocked';

export interface DungeonBundlePreview {
  bundle: {
    format: string;
    version: number;
    exportedAt: string;
    sourceEnvironment: string;
    origin: 'draft' | 'revision';
    draftRevision: number | null;
    publishedRevision: number | null;
    packageSchemaVersion: number;
    sceneSpriteEvidence: 'catalogue' | 'revision_snapshot' | null;
    bundleHash: string;
    warnings: { path: string; message: string }[];
  };
  dungeon: {
    key: string;
    name: string;
    decision: 'create' | 'replace' | 'unchanged';
    plan: DungeonImportPlan;
  };
  artwork: { dungeon: BundleDungeonArtworkPlan[]; assets: BundleAssetPlan[] };
  sceneSprites: BundleSpritePlan[];
  sharedPools: BundlePoolPlan[];
  enemies: BundleEnemyPlan[];
  prerequisites: BundlePrerequisite[];
  remainsDisabled: BundleDisabledDependency[];
  issues: BundlePlanIssue[];
  /** `<kind>:<key>` for every conflict still without a decision. */
  decisionsRequired: string[];
  readiness: BundleReadiness;
  planHash: string;
}

export interface DungeonBundleImportResult {
  importId: number;
  requestId: string;
  replayed: boolean;
  dungeonKey: string;
  dungeonResult: DungeonImportResult['result'];
  draftRevision: number;
  dungeonImportId: number;
  enabled: boolean;
  publishedRevision: number | null;
  readiness: BundleReadiness;
  enemies: { created: string[]; updated: string[]; skipped: string[]; unchanged: string[] };
  sceneSprites: { created: string[]; updated: string[]; copied: { from: string; to: string }[]; reused: string[]; kept: string[] };
  sharedPools: { created: string[]; updated: string[]; reused: string[]; kept: string[] };
  assets: { created: number; reused: number };
  createdLootTables: string[];
  remainsDisabled: BundleDisabledDependency[];
  issues: BundlePlanIssue[];
}

export interface DungeonBundleExport {
  filename: string;
  archive: Buffer;
  counts: { assets: number; enemies: number; sceneSprites: number; sharedPools: number };
  warnings: { path: string; message: string }[];
}

export interface DungeonBundleRequest {
  expectedPlanHash: string;
  requestId: string;
  decisions: DungeonBundleDecisions;
}

export interface DungeonBundleService {
  /** @throws {DungeonBundleExportRefusedError | DungeonNotFoundError | DungeonRevisionNotFoundError} */
  exportBundle(key: string, origin: DungeonExportOrigin): Promise<DungeonBundleExport>;
  /** @throws {DungeonBundleInvalidError} */
  preview(archive: Buffer, decisions?: Partial<DungeonBundleDecisions>): Promise<DungeonBundlePreview>;
  /**
   * @throws {DungeonBundleInvalidError | DungeonBundleStaleError | DungeonBundleRejectedError |
   *   DungeonBundleDecisionsRequiredError | DungeonBundleRequestConflictError}
   */
  apply(archive: Buffer, request: DungeonBundleRequest, actor: string | null): Promise<DungeonBundleImportResult>;
}

export interface DungeonBundleServiceDeps {
  db: Db;
  content: Pick<DungeonContentService, 'exportBundleSource' | 'planImportInTx' | 'applyImportInTx' | 'validationContext'>;
  enemyPackages: Pick<EnemyPackageService, 'bundle' | 'recoverInterruptedImports'>;
  sceneSprites: Pick<SceneSpriteService, 'applyImported' | 'get'>;
  sharedPools: Pick<SharedDungeonPoolService, 'applyImported' | 'references'>;
  assets: Pick<ArtworkAssetService, 'read'>;
  storage: ArtworkStorage;
  /** The shipped artwork root (`ASSETS_DIR`): read on export, compared on import, never written. */
  assetsDir: string;
  getRegions: () => readonly { id: string; name?: string; enabled: boolean }[];
  /** Diagnostics label written into exported manifests. */
  environment: string;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
  now?: () => Date;
  /** Test seams: fail at a precise point to prove cleanup and recovery. */
  faults?: { afterStaging?: () => Promise<void>; beforeCommit?: (tx: DbOrTx) => Promise<void> };
}

// ── internals ───────────────────────────────────────────────────────────────

const sha256 = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const byKey = <T>(a: [string, T], b: [string, T]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const NEUTRAL: DungeonBundleDecisions = { enemies: {}, sceneSprites: {}, sharedPools: {}, allowIncomplete: false };
const SPRITE_FIELDS = ['name', 'placement', 'mirror', 'visualLayer'] as const;
type ManagedRef = Extract<DungeonArtworkRef, { kind: 'managed' }>;

/** What this server holds that the bundle's review depends on. Loaded once per plan. */
interface DestinationState {
  /** Per (category, sha256): an active asset with its file present, or null. */
  reusable: Map<string, string | null>;
  /** Per (category, sha256): what a dungeon reference resolves to here today. */
  resolves: Map<string, { id: string; contentHash: string } | null>;
  /** Shipped files at the dungeon's shipped paths: sha256, or null when absent. */
  shipped: Map<string, string | null>;
  sprites: Map<string, { revision: number; archived: boolean; definition: z.infer<typeof SceneSpriteInputSchema> | null; asset: { id: string; category: string; contentHash: string; usable: boolean } | null }>;
  spriteKeys: Set<string>;
  spriteReferences: Map<string, BundleSpritePlan['references']>;
  catalogue: SceneSpriteCatalogue;
  pools: Map<string, { revision: number; definition: SharedPoolDefinition }>;
  poolReferences: Map<string, BundlePoolPlan['otherDungeons']>;
  speciesRows: Map<string, { name: string; enabled: boolean; tags: string[] }>;
  speciesArtwork: ((slug: string) => boolean) | undefined;
  enemyPlan: Awaited<ReturnType<EnemyPackageService['bundle']['plan']>> | null;
  external: Omit<BundlePrerequisite, 'notes'>[];
}

interface Evaluation {
  preview: DungeonBundlePreview;
  /** Entries some approved write needs created, by entry id. */
  toCreate: Map<string, BundleAssetEntry>;
  /** Entry id → reused destination asset id (every reuse any approved write relies on). */
  reused: Map<string, string>;
  bundleContext: DungeonBundleImportContext;
  spriteWrites: { key: string; sprite: BundleSceneSprite; expectedRevision: number | null; copyOf: string | null; reuse: string | null; existingCategory: BundleSceneSprite['category'] }[];
  poolWrites: { definition: SharedPoolDefinition; expectedRevision: number | null }[];
  enemyApproved: (entry: EnemyPlannedEntry) => boolean;
}

function artworkUsages(definition: DungeonDefinition, ref: DungeonArtworkRef): string[] {
  const same = (other: DungeonArtworkRef | null | undefined) => !!other && canonicalJson(other) === canonicalJson(ref);
  const out: string[] = [];
  if (same(definition.artwork)) out.push('Dungeon cover');
  if (same(definition.background)) out.push('Dungeon background');
  for (const room of definition.rooms) if (same(room.background)) out.push(`Room “${room.name || room.id}” background`);
  for (const event of definition.events ?? []) if (same(event.artwork)) out.push(`Event “${event.title}” artwork`);
  return out;
}

function copyKeyFor(key: string, taken: ReadonlySet<string>): string {
  let suffix = '_imported';
  let n = 2;
  let candidate = `${key.slice(0, 100 - suffix.length).replace(/_+$/, '')}${suffix}`;
  while (taken.has(candidate)) {
    suffix = `_imported_${n++}`;
    candidate = `${key.slice(0, 100 - suffix.length).replace(/_+$/, '')}${suffix}`;
  }
  return candidate;
}

export function createDungeonBundleService(deps: DungeonBundleServiceDeps): DungeonBundleService {
  const { db, storage } = deps;
  const now = () => deps.now?.() ?? new Date();

  async function readShipped(relative: string): Promise<{ bytes: Buffer } | { status: 'missing' | 'unsafe' }> {
    const located = locateArtworkFile(deps.assetsDir, relative);
    if (located.status !== 'available') return { status: located.status };
    try {
      return { bytes: await fs.readFile(located.absolutePath) };
    } catch {
      return { status: 'missing' };
    }
  }
  async function inspect(bytes: Buffer): Promise<InspectedImage | string> {
    try {
      return await inspectImage(bytes);
    } catch (err) {
      return err instanceof ArtworkUploadInvalidError ? err.userMessage : 'it could not be read as an image';
    }
  }

  // ── export ────────────────────────────────────────────────────────────────

  async function exportBundle(key: string, origin: DungeonExportOrigin): Promise<DungeonBundleExport> {
    const L = DUNGEON_BUNDLE_LIMITS;
    const built = await db.transaction(
      async (tx) => {
        let source: Awaited<ReturnType<DungeonBundleServiceDeps['content']['exportBundleSource']>>;
        try {
          source = await deps.content.exportBundleSource(tx, key, origin);
        } catch (err) {
          if (err instanceof DungeonInvalidError)
            throw new DungeonBundleExportRefusedError('invalid', 'This dungeon cannot be exported as it stands. Repair it first.', err.issues.map((i) => ({ path: i.path, message: i.message })));
          throw err;
        }
        const { pkg, sceneSpriteSnapshot } = source;
        const definition = pkg.dungeon;
        const collector = createBundleAssetCollector();
        const errors: (DungeonBundleIssue & { reason: DungeonBundleExportRefusal })[] = [];
        const warnings: { path: string; message: string }[] = [];

        // Managed artwork by the bytes it names: the oldest active exact asset whose file reads back intact.
        async function managedBytes(category: string, contentHash: string): Promise<{ bytes: Buffer; image: InspectedImage; name: string } | null> {
          const rows = await tx
            .select({ id: artworkAssets.id, name: artworkAssets.name })
            .from(artworkAssets)
            .where(and(eq(artworkAssets.category, category as ArtworkAssetCategory), eq(artworkAssets.contentHash, contentHash), eq(artworkAssets.status, 'active')))
            .orderBy(asc(artworkAssets.createdAt), asc(artworkAssets.id));
          for (const row of rows) {
            const read = await deps.assets.read(row.id);
            const image = read ? await inspect(read.bytes) : null;
            if (read && image && typeof image !== 'string' && image.contentHash === contentHash) return { bytes: read.bytes, image, name: row.name };
          }
          return null;
        }

        // 1. The dungeon's own artwork.
        const artwork: DungeonBundleManifest['artwork'] = [];
        for (const ref of dungeonDependencies(definition).artwork) {
          const where = artworkUsages(definition, ref).join(', ') || 'artwork';
          if (ref.kind === 'managed') {
            const found = await managedBytes(ref.category, ref.contentHash);
            if (!found) {
              errors.push({
                path: where,
                message: `managed ${ref.category} image ${ref.name ?? ref.contentHash.slice(0, 12)} is not stored here with the exact bytes the dungeon names (it may have been replaced). Choose the image again in the editor, save, and export again.`,
                reason: 'artwork_unavailable',
              });
              continue;
            }
            artwork.push({ ref, asset: collector.add({ category: ref.category as ArtworkAssetCategory, bytes: found.bytes, image: found.image, name: ref.name ?? found.name }).id });
          } else {
            const file = await readShipped(ref.path);
            if (!('bytes' in file)) {
              errors.push({ path: where, message: `shipped image ${ref.path} is ${file.status === 'unsafe' ? 'outside the assets folder' : 'missing'} on this server`, reason: 'artwork_unavailable' });
              continue;
            }
            const image = await inspect(file.bytes);
            if (typeof image === 'string') {
              errors.push({ path: where, message: `shipped image ${ref.path} cannot travel as managed artwork: ${image}. Convert it to PNG, WebP or JPEG and choose it again.`, reason: 'unsupported_artwork' });
              continue;
            }
            const category = shippedDungeonArtworkCategory(definition, ref.path);
            artwork.push({ ref, asset: collector.add({ category, bytes: file.bytes, image, name: path.posix.basename(ref.path) }).id });
          }
        }

        // 2. Scene Sprites: frozen revision visuals, or the draft's current catalogue sprites.
        const spriteKeys = sceneSpriteKeys(definition);
        const sprites: BundleSceneSprite[] = [];
        if (spriteKeys.length) {
          const rows = new Map(
            (await tx.select().from(dungeonSceneSprites).where(inArray(dungeonSceneSprites.spriteKey, spriteKeys))).map((r) => [r.spriteKey, r]),
          );
          for (const spriteKey of spriteKeys) {
            const at = `sceneSprites.${spriteKey}`;
            let visual: { assetId: string; name: string; contentHash: string | null; placement: BundleSceneSprite['placement']; mirror: boolean; visualLayer: BundleSceneSprite['visualLayer']; category: BundleSceneSprite['category'] };
            if (sceneSpriteSnapshot) {
              const frozen = sceneSpriteSnapshot.sprites[spriteKey]!;
              visual = { ...frozen, category: null };
            } else {
              const row = rows.get(spriteKey);
              const parsed = row ? SceneSpriteInputSchema.safeParse(row.definition) : null;
              if (!row || !parsed?.success) {
                errors.push({ path: at, message: `Scene Sprite "${spriteKey}" is missing or unreadable here`, reason: 'dependency_unavailable' });
                continue;
              }
              if (row.archivedAt) {
                errors.push({ path: at, message: `Scene Sprite "${parsed.data.name}" is archived. Restore it or remove its placements, then export again.`, reason: 'dependency_unavailable' });
                continue;
              }
              visual = { ...parsed.data, contentHash: null };
            }
            const read = await deps.assets.read(visual.assetId);
            const image = read ? await inspect(read.bytes) : null;
            const expected = visual.contentHash ?? read?.asset.contentHash;
            if (!read || !image || typeof image === 'string' || image.contentHash !== expected) {
              errors.push({
                path: at,
                message: sceneSpriteSnapshot
                  ? `the frozen artwork of Scene Sprite "${visual.name}" in this revision is no longer readable with its recorded bytes. Export the draft instead.`
                  : `the artwork of Scene Sprite "${visual.name}" cannot be read here`,
                reason: 'artwork_unavailable',
              });
              continue;
            }
            const entry = collector.add({ category: read.asset.category, bytes: read.bytes, image, name: read.asset.name });
            sprites.push({ key: spriteKey, name: visual.name, category: visual.category, placement: visual.placement, mirror: visual.mirror, visualLayer: visual.visualLayer, asset: entry.id });
          }
        }

        // 3. Enemies, by CP-3's own collection: full art, sprites and every shipped file they render.
        const enemyKeys = dungeonDependencies(definition).enemies;
        let enemyDocs: { manifest: EnemyPackageManifest; definitions: Awaited<ReturnType<EnemyPackageService['bundle']['collect']>>['definitions'] } | null = null;
        if (enemyKeys.length) {
          const all = new Map((await readCombatEnemyRows(tx)).map((r) => [r.enemyKey, r]));
          const missing = enemyKeys.filter((k) => !all.has(k));
          for (const k of missing) errors.push({ path: `enemies.${k}`, message: `enemy "${k}" is not in this server's Enemy Catalogue`, reason: 'dependency_unavailable' });
          const rows = enemyKeys.flatMap((k) => (all.has(k) ? [all.get(k)!] : []));
          const collected = await deps.enemyPackages.bundle.collect(rows, collector);
          for (const e of collected.errors) errors.push({ path: `enemies.${e.path}`, message: e.message, reason: e.reason });
          for (const w of collected.warnings) warnings.push({ path: `enemies.${w.key}.${w.slot}`, message: w.message });
          const ids = new Set(collected.bindings.flatMap((b) => [b.artwork.managed, b.artwork.shipped?.asset ?? null, b.sprite.managed, b.sprite.shipped?.asset ?? null]).filter((id): id is string => id !== null));
          enemyDocs = {
            manifest: {
              format: ENEMY_PACKAGE_FORMAT,
              version: ENEMY_PACKAGE_VERSION,
              contentType: ENEMY_PACKAGE_CONTENT_TYPE,
              exportedAt: now().toISOString(),
              scope: 'selected',
              source: { environment: deps.environment.slice(0, 64) },
              enemies: collected.bindings,
              assets: collector.entries().filter((e) => ids.has(e.id)),
              warnings: collected.warnings,
            },
            definitions: collected.definitions,
          };
        }

        // 4. Shared pools, by stable key.
        const poolKeys = sharedPoolKeys(definition);
        const pools: SharedPoolDefinition[] = [];
        if (poolKeys.length) {
          const rows = new Map((await tx.select().from(dungeonSpeciesPools).where(inArray(dungeonSpeciesPools.poolKey, poolKeys))).map((r) => [r.poolKey, r]));
          for (const poolKey of poolKeys) {
            const parsed = rows.has(poolKey) ? SharedPoolDefinitionSchema.safeParse(rows.get(poolKey)!.definition) : null;
            if (!parsed?.success) errors.push({ path: `sharedPools.${poolKey}`, message: `shared WaifuMon pool "${poolKey}" is missing or unreadable here`, reason: 'dependency_unavailable' });
            else pools.push(parsed.data);
          }
        }

        if (errors.length) {
          const order: DungeonBundleExportRefusal[] = ['dependency_unavailable', 'artwork_unavailable', 'unsupported_artwork'];
          const reason = order.find((r) => errors.some((e) => e.reason === r)) ?? 'artwork_unavailable';
          throw new DungeonBundleExportRefusedError(
            reason,
            'This dungeon needs content that cannot be packaged from this server, so nothing was exported.',
            errors.map(({ path: p, message }) => ({ path: p, message })),
          );
        }
        const entries = collector.entries();
        if (entries.length > L.maxAssets || (enemyDocs?.definitions.length ?? 0) > L.maxEnemies || pools.length > L.maxSharedPools || sprites.length > L.maxSceneSprites)
          throw new DungeonBundleExportRefusedError('too_large', 'This dungeon carries more images, enemies, sprites or pools than a bundle may hold.');
        const manifest: DungeonBundleManifest = {
          format: DUNGEON_BUNDLE_FORMAT,
          version: DUNGEON_BUNDLE_VERSION,
          contentType: DUNGEON_BUNDLE_CONTENT_TYPE,
          exportedAt: now().toISOString(),
          source: {
            environment: deps.environment.slice(0, 64),
            dungeonKey: definition.key,
            origin: pkg.source.origin,
            draftRevision: pkg.source.draftRevision,
            publishedRevision: pkg.source.publishedRevision,
          },
          dungeonPackage: { file: BUNDLE_DUNGEON_FILE, schemaVersion: pkg.schemaVersion, contentHash: pkg.contentHash, packageHash: importHash(pkg) },
          artwork,
          sceneSprites: spriteKeys.length
            ? { evidence: sceneSpriteSnapshot ? 'revision_snapshot' : 'catalogue', snapshotHash: sceneSpriteSnapshot?.hash ?? null, sprites }
            : null,
          enemies: enemyDocs ? { manifest: BUNDLE_ENEMY_MANIFEST_FILE, definitions: BUNDLE_ENEMY_DEFINITIONS_FILE } : null,
          sharedPools: poolKeys.length ? { file: BUNDLE_POOLS_FILE, keys: poolKeys } : null,
          assets: entries,
          warnings,
        };
        return { manifest, pkg, enemies: enemyDocs, pools, files: collector.files() };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const imageBytes = built.manifest.assets.reduce((sum, e) => sum + e.bytes, 0);
    const archive = buildDungeonBundleArchive(built);
    if (archive.length > L.maxArchiveBytes || imageBytes + L.maxTotalJsonBytes > L.maxExpandedBytes)
      throw new DungeonBundleExportRefusedError('too_large', `The bundle would be ${archive.length} bytes (${imageBytes} of images), more than an import accepts.`);
    // Never hand out a file this build's own importer would refuse.
    try {
      await parseDungeonBundle(archive);
    } catch (err) {
      if (err instanceof DungeonBundleInvalidError) throw new DungeonBundleExportRefusedError('invalid', 'The bundle failed its own import checks, so nothing was exported.', err.issues);
      throw err;
    }
    return {
      filename: dungeonBundleFilename(built.pkg),
      archive,
      counts: {
        assets: built.manifest.assets.length,
        enemies: built.enemies?.definitions.length ?? 0,
        sceneSprites: built.manifest.sceneSprites?.sprites.length ?? 0,
        sharedPools: built.pools.length,
      },
      warnings: built.manifest.warnings,
    };
  }

  // ── destination state ─────────────────────────────────────────────────────

  async function loadState(tx: DbOrTx, bundle: DungeonBundle, lock: boolean): Promise<DestinationState> {
    const { pkg, manifest } = bundle;
    const definition = pkg.dungeon;
    const deps0 = dungeonDependencies(definition);
    const spriteEntries = manifest.sceneSprites?.sprites ?? [];
    if (lock) {
      // The order every importer shares: dungeon key, its enemies, then CP-3's asset lock.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dungeon_import:key:${definition.key}`}, 0))`);
      for (const enemy of [...deps0.enemies].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dungeon_import:enemy:${enemy}`}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'enemy_package_import:assets'}, 0))`);
      if (bundle.pools.length) await tx.execute(sql`select pg_advisory_xact_lock(74740001)`);
      if (spriteEntries.length) await tx.execute(sql`LOCK TABLE dungeon_scene_sprites IN SHARE ROW EXCLUSIVE MODE`);
    }

    const reusable = new Map<string, string | null>();
    for (const { entry } of bundle.assets.values()) {
      const identity = `${entry.category}:${entry.sha256}`;
      if (!reusable.has(identity)) reusable.set(identity, await findReusableAsset(tx, storage, { category: entry.category, sha256: entry.sha256 }));
    }
    const index = await managedArtworkIndex(tx);
    const resolves = new Map<string, { id: string; contentHash: string } | null>();
    const indexIds = [...new Set([...index.values()])];
    const indexRows = indexIds.length
      ? new Map((await tx.select({ id: artworkAssets.id, contentHash: artworkAssets.contentHash }).from(artworkAssets).where(inArray(artworkAssets.id, indexIds))).map((r) => [r.id, r]))
      : new Map<string, { id: string; contentHash: string }>();
    for (const binding of manifest.artwork) {
      const entry = bundle.assets.get(binding.asset)!.entry;
      const id = index.get(managedArtworkKey({ category: entry.category, contentHash: entry.sha256 }));
      resolves.set(`${entry.category}:${entry.sha256}`, id ? (indexRows.get(id) ?? null) : null);
    }
    const reuseIds = [...new Set([...reusable.values()].filter((id): id is string => id !== null))].sort();
    if (lock && reuseIds.length) await tx.select({ id: artworkAssets.id }).from(artworkAssets).where(inArray(artworkAssets.id, reuseIds)).for('share');

    const shipped = new Map<string, string | null>();
    for (const binding of manifest.artwork)
      if (binding.ref.kind === 'shipped') {
        const file = await readShipped(binding.ref.path);
        shipped.set(binding.ref.path, 'bytes' in file ? createHash('sha256').update(file.bytes).digest('hex') : null);
      }

    // Scene Sprites: the carried keys' rows, every key (for copy names), and the full catalogue for review.
    const sprites: DestinationState['sprites'] = new Map();
    const spriteReferences = new Map<string, BundleSpritePlan['references']>();
    const allSpriteKeys = new Set((await tx.select({ key: dungeonSceneSprites.spriteKey }).from(dungeonSceneSprites)).map((r) => r.key));
    if (spriteEntries.length) {
      const rows = await tx
        .select({ sprite: dungeonSceneSprites, asset: artworkAssets })
        .from(dungeonSceneSprites)
        .leftJoin(artworkAssets, eq(artworkAssets.id, dungeonSceneSprites.assetId))
        .where(inArray(dungeonSceneSprites.spriteKey, spriteEntries.map((s) => s.key)));
      for (const { sprite, asset } of rows) {
        const parsed = SceneSpriteInputSchema.safeParse(sprite.definition);
        sprites.set(sprite.spriteKey, {
          revision: sprite.revision,
          archived: sprite.archivedAt !== null,
          definition: parsed.success ? parsed.data : null,
          asset: asset ? { id: asset.id, category: asset.category, contentHash: asset.contentHash, usable: asset.status === 'active' && (await storage.exists(asset.storageKey)) } : null,
        });
      }
      if (!lock)
        for (const key of sprites.keys()) {
          const detail = await deps.sceneSprites.get(key);
          spriteReferences.set(key, (detail?.references ?? []).map((r) => ({ dungeonKey: r.dungeonKey, name: r.name, source: r.source })));
        }
    }
    const catalogue = spriteEntries.length ? await sceneSpriteCatalogue(tx, storage) : new Map();

    // Shared pools by key, and who else uses them.
    const pools: DestinationState['pools'] = new Map();
    const poolReferences = new Map<string, BundlePoolPlan['otherDungeons']>();
    if (bundle.pools.length) {
      const query = tx.select().from(dungeonSpeciesPools).where(inArray(dungeonSpeciesPools.poolKey, bundle.pools.map((p) => p.key))).orderBy(asc(dungeonSpeciesPools.poolKey));
      for (const row of lock ? await query.for('share') : await query) {
        const parsed = SharedPoolDefinitionSchema.safeParse(row.definition);
        if (parsed.success) pools.set(row.poolKey, { revision: row.revision, definition: parsed.data });
      }
      if (!lock)
        for (const key of pools.keys())
          poolReferences.set(key, (await deps.sharedPools.references(key)).filter((r) => r.dungeonKey !== definition.key).map((r) => ({ dungeonKey: r.dungeonKey, name: r.name, source: r.source })));
    }

    // Species: required by encounters, or in any pool body the dungeon may use.
    const poolSpecies = [...bundle.pools, ...[...pools.values()].map((p) => p.definition)].flatMap((p) => p.entries.flatMap((e) => ('species' in e ? [e.species] : [])));
    const requiredSpecies = pkg.schemaVersion === 4 ? pkg.dependencies.requiredSpecies.map((s) => s.slug) : [];
    const speciesSlugs = [...new Set([...poolSpecies, ...requiredSpecies])].sort();
    const speciesRows = new Map(
      speciesSlugs.length
        ? (await tx.select({ slug: speciesTable.slug, name: speciesTable.name, enabled: speciesTable.enabled, tags: speciesTable.tags }).from(speciesTable).where(inArray(speciesTable.slug, speciesSlugs))).map((r) => [r.slug, r])
        : [],
    );
    const speciesArtwork = speciesSlugs.length ? (await deps.content.validationContext(tx)).encounterSource?.speciesArtwork : undefined;

    // External prerequisites: authoritative destination rows, never created here.
    const external: DestinationState['external'] = [];
    for (const slug of speciesSlugs) {
      const row = speciesRows.get(slug);
      external.push({ kind: 'species', key: slug, name: row?.name ?? slug, status: !row ? 'missing' : row.enabled ? 'available' : 'disabled' });
    }
    const itemKeys = [...new Set([
      ...(pkg.schemaVersion !== 1 ? pkg.dependencies.items : []),
      ...(pkg.schemaVersion === 3 || pkg.schemaVersion === 4 ? pkg.dependencies.requiredItems : []),
      ...(pkg.schemaVersion === 4 ? pkg.dependencies.captureItems : []),
    ])].sort();
    const itemRows = new Map(itemKeys.length ? (await tx.select({ slug: items.slug, name: items.name, enabled: items.enabled }).from(items).where(inArray(items.slug, itemKeys))).map((r) => [r.slug, r]) : []);
    for (const key of itemKeys) {
      const row = itemRows.get(key);
      external.push({ kind: 'item', key, name: row?.name ?? key, status: !row ? 'missing' : row.enabled ? 'available' : 'disabled' });
    }
    const gearKeys = pkg.schemaVersion !== 1 ? [...new Set(pkg.dependencies.equipment.flatMap((e) => e.candidateKeys))].sort() : [];
    const gearRows = new Map(gearKeys.length ? (await tx.select({ key: equipmentDefinitions.key, name: equipmentDefinitions.name, enabled: equipmentDefinitions.enabled }).from(equipmentDefinitions).where(inArray(equipmentDefinitions.key, gearKeys))).map((r) => [r.key, r]) : []);
    for (const key of gearKeys) {
      const row = gearRows.get(key);
      external.push({ kind: 'equipment', key, name: row?.name ?? key, status: !row ? 'missing' : row.enabled ? 'available' : 'disabled' });
    }
    const currencyRows = new Map(deps0.currencies.length ? (await tx.select({ key: progressionCurrencies.currencyKey, name: progressionCurrencies.singularName, enabled: progressionCurrencies.enabled }).from(progressionCurrencies).where(inArray(progressionCurrencies.currencyKey, deps0.currencies))).map((r) => [r.key, r]) : []);
    for (const key of deps0.currencies) {
      const row = currencyRows.get(key);
      external.push({ kind: 'currency', key, name: row?.name ?? key, status: !row ? 'missing' : row.enabled ? 'available' : 'disabled' });
    }
    const regions = new Map(deps.getRegions().map((r) => [r.id, r]));
    for (const key of deps0.regions) {
      const row = regions.get(key);
      external.push({ kind: 'region', key, name: row?.name ?? key, status: !row ? 'missing' : row.enabled ? 'available' : 'disabled' });
    }
    const tableRows = new Map(deps0.rewardTables.length ? (await tx.select({ id: rewardTables.tableId, enabled: rewardTables.enabled }).from(rewardTables).where(and(eq(rewardTables.kind, 'expedition'), inArray(rewardTables.tableId, deps0.rewardTables)))).map((r) => [r.id, r]) : []);
    for (const key of deps0.rewardTables) {
      const row = tableRows.get(key);
      external.push({ kind: 'reward_table', key, name: key, status: !row ? 'missing' : row.enabled ? 'available' : 'disabled' });
    }

    const enemyPlan = bundle.enemies ? await deps.enemyPackages.bundle.plan(tx, bundle.enemies, lock) : null;
    return { reusable, resolves, shipped, sprites, spriteKeys: allSpriteKeys, spriteReferences, catalogue, pools, poolReferences, speciesRows, speciesArtwork, enemyPlan, external };
  }

  // ── evaluation: the review for one set of decisions ───────────────────────

  async function evaluate(tx: DbOrTx, bundle: DungeonBundle, state: DestinationState, decisions: DungeonBundleDecisions, lock: boolean): Promise<Evaluation> {
    const { pkg, manifest } = bundle;
    const definition = pkg.dungeon;
    const issues: BundlePlanIssue[] = [];
    const entryOf = (id: string) => bundle.assets.get(id)!.entry;
    const reuseOf = (entry: BundleAssetEntry) => state.reusable.get(`${entry.category}:${entry.sha256}`) ?? null;
    const toCreate = new Map<string, BundleAssetEntry>();
    const reused = new Map<string, string>();
    const usage = new Map<string, string[]>();
    const used = (id: string, label: string) => usage.set(id, [...(usage.get(id) ?? []), label]);
    const need = (entry: BundleAssetEntry, prefer?: string | null): 'reuse' | 'create' => {
      const id = prefer ?? reuseOf(entry);
      if (id) {
        reused.set(entry.id, id);
        return 'reuse';
      }
      toCreate.set(entry.id, entry);
      return 'create';
    };
    const decisionsRequired: string[] = [];
    for (const [kind, map, known] of [
      ['enemy', decisions.enemies, new Set(bundle.enemies?.definitions.map((d) => d.key) ?? [])],
      ['sprite', decisions.sceneSprites, new Set((manifest.sceneSprites?.sprites ?? []).map((s) => s.key))],
      ['pool', decisions.sharedPools, new Set(bundle.pools.map((p) => p.key))],
    ] as const)
      for (const key of Object.keys(map))
        if (!known.has(key)) issues.push({ code: 'bundle_decision_invalid', severity: 'error', path: `decisions.${kind}.${key}`, message: `The bundle carries no ${kind} "${key}".` });

    // 1. The dungeon's own artwork. A shipped image this server lacks becomes its managed copy.
    const rebinds = new Map<string, ManagedRef>();
    const managedKeys = new Set<string>();
    const dungeonArtwork: BundleDungeonArtworkPlan[] = [];
    for (const binding of manifest.artwork) {
      const entry = entryOf(binding.asset);
      const usageLabels = artworkUsages(definition, binding.ref);
      for (const label of usageLabels) used(entry.id, label);
      if (binding.ref.kind === 'shipped' && state.shipped.get(binding.ref.path) === entry.sha256) {
        dungeonArtwork.push({ usage: usageLabels, source: 'shipped', path: binding.ref.path, asset: entry.id, destination: 'shipped_file', rebound: false });
        continue;
      }
      // Rule 1 of the managed lookup picks the oldest active exact asset, file or no file: it must be the one bound.
      const resolved = state.resolves.get(`${entry.category}:${entry.sha256}`) ?? null;
      const reuse = reuseOf(entry);
      if (resolved && resolved.contentHash === entry.sha256 && resolved.id !== reuse) {
        issues.push({
          code: 'artwork_unverifiable',
          severity: 'error',
          path: `artwork.${entry.id}`,
          message: `${usageLabels.join(', ') || 'Artwork'}: this server already has an active ${entry.category} asset with these bytes whose stored file is missing. Repair or disable it in Artwork, then review again.`,
        });
        continue;
      }
      const destination = need(entry);
      managedKeys.add(managedArtworkKey({ category: entry.category, contentHash: entry.sha256 }));
      if (binding.ref.kind === 'shipped') {
        rebinds.set(binding.ref.path, { kind: 'managed', category: entry.category, contentHash: entry.sha256, name: path.posix.basename(binding.ref.path).slice(0, 200) });
        issues.push({
          code: 'artwork_rebound',
          severity: 'warning',
          path: `artwork.${entry.id}`,
          message: `${usageLabels.join(', ')}: ${binding.ref.path} ${state.shipped.get(binding.ref.path) === null ? 'is not on this server' : 'holds a different image on this server'}; the draft uses the bundled copy as managed artwork.`,
        });
      }
      dungeonArtwork.push({ usage: usageLabels, source: binding.ref.kind, path: binding.ref.kind === 'shipped' ? binding.ref.path : null, asset: entry.id, destination, rebound: binding.ref.kind === 'shipped' });
    }

    // 2. Scene Sprites.
    const copies = new Map<string, string>();
    const spritePlans: BundleSpritePlan[] = [];
    const spriteWrites: Evaluation['spriteWrites'] = [];
    const catalogue = new Map(state.catalogue);
    const taken = new Set([...state.spriteKeys, ...(manifest.sceneSprites?.sprites ?? []).map((s) => s.key)]);
    for (const sprite of manifest.sceneSprites?.sprites ?? []) {
      const entry = entryOf(sprite.asset);
      const here = state.sprites.get(sprite.key);
      const suggestedCopyKey = copyKeyFor(sprite.key, taken);
      let outcome: BundleSpritePlan['outcome'] = 'create';
      const changedFields: string[] = [];
      if (here) {
        for (const field of SPRITE_FIELDS) if (!here.definition || canonicalJson(here.definition[field]) !== canonicalJson(sprite[field])) changedFields.push(field);
        if (!here.asset || !here.asset.usable || here.asset.category !== entry.category || here.asset.contentHash !== entry.sha256) changedFields.push('artwork');
        if (here.archived) changedFields.push('archived');
        outcome = changedFields.length ? 'conflict' : 'identical';
      }
      const decision = outcome === 'conflict' ? (decisions.sceneSprites[sprite.key] ?? null) : null;
      if (outcome === 'conflict' && !decision) decisionsRequired.push(`sprite:${sprite.key}`);
      const writes = outcome === 'create' || decision === 'update' || decision === 'copy';
      const resultKey = decision === 'copy' ? suggestedCopyKey : sprite.key;
      let assetDestination: BundleSpritePlan['assetDestination'] = 'not_needed';
      used(entry.id, `Scene Sprite “${sprite.name}”`);
      if (writes) {
        const prefer = decision === 'update' && here?.asset?.usable && here.asset.category === entry.category && here.asset.contentHash === entry.sha256 ? here.asset.id : null;
        assetDestination = need(entry, prefer);
        spriteWrites.push({ key: resultKey, sprite, expectedRevision: decision === 'update' ? here!.revision : null, copyOf: decision === 'copy' ? sprite.key : null, reuse: reused.get(entry.id) ?? null, existingCategory: here?.definition?.category ?? null });
        catalogue.set(resultKey, {
          assetId: reused.get(entry.id) ?? `00000000-0000-4000-8000-${entry.id.replace('asset-', '').padStart(12, '0')}`,
          name: sprite.name,
          artworkCategory: entry.category,
          contentHash: entry.sha256,
          placement: sprite.placement,
          mirror: sprite.mirror,
          visualLayer: sprite.visualLayer,
          archived: decision === 'update' ? here!.archived : false,
          usable: true,
        });
      }
      if (decision === 'copy') {
        copies.set(sprite.key, suggestedCopyKey);
        taken.add(suggestedCopyKey);
      }
      const references = state.spriteReferences.get(sprite.key) ?? [];
      if (decision === 'update' && references.length) {
        const others = [...new Set(references.filter((r) => r.dungeonKey !== definition.key).map((r) => r.name))];
        issues.push({
          code: 'scene_sprite_shared',
          severity: 'warning',
          path: `sceneSprites.${sprite.key}`,
          message: `Updating “${sprite.name}” changes the shared sprite${others.length ? ` for other dungeons' drafts and next publications too (${others.join(', ')})` : ''}. Published revisions keep their frozen visuals.`,
        });
      }
      if (decision === 'update' && here?.archived)
        issues.push({ code: 'scene_sprite_archived_here', severity: 'warning', path: `sceneSprites.${sprite.key}`, message: `“${sprite.name}” is archived here and stays archived; restore it in Dungeon Scene Sprites, or import a copy instead.` });
      spritePlans.push({ key: sprite.key, name: sprite.name, outcome, changedFields, archivedHere: here?.archived ?? false, references, suggestedCopyKey, decision, resultKey, asset: entry.id, assetDestination });
    }

    // 3. Shared pools. Reviewed as if enabled; enabling stays separate and publication checks it.
    const poolPlans: BundlePoolPlan[] = [];
    const poolWrites: Evaluation['poolWrites'] = [];
    const reviewPools = new Map<string, SharedPoolDefinition>();
    const remainsDisabled: BundleDisabledDependency[] = [];
    for (const pool of bundle.pools) {
      const here = state.pools.get(pool.key);
      const strip = (p: SharedPoolDefinition) => ({ ...p, enabled: false });
      let outcome: BundlePoolPlan['outcome'] = 'create';
      const changedFields: string[] = [];
      if (here) {
        for (const field of ['name', 'description', 'entries'] as const) if (canonicalJson(here.definition[field]) !== canonicalJson(pool[field])) changedFields.push(field);
        outcome = changedFields.length ? 'conflict' : 'identical';
      }
      const decision = outcome === 'conflict' ? (decisions.sharedPools[pool.key] ?? null) : null;
      if (outcome === 'conflict' && !decision) decisionsRequired.push(`pool:${pool.key}`);
      const uses: BundlePoolPlan['uses'] = outcome === 'create' || decision === 'update' ? 'bundled' : here ? 'destination' : 'bundled';
      const body = uses === 'bundled' ? pool : here!.definition;
      reviewPools.set(pool.key, { ...strip(body), enabled: true });
      if (outcome === 'create' || decision === 'update') poolWrites.push({ definition: pool, expectedRevision: here?.revision ?? null });
      const enabledAfterImport = here?.definition.enabled ?? false;
      if (!enabledAfterImport) remainsDisabled.push({ kind: 'shared_pool', key: pool.key, name: body.name, requiredForPublication: true });
      const species = body.entries.flatMap((e) => ('species' in e ? [e.species] : [])).map((slug) => {
        const row = state.speciesRows.get(slug);
        return { slug, status: !row ? ('missing' as const) : row.enabled ? ('available' as const) : ('disabled' as const) };
      });
      for (const s of species) {
        if (s.status === 'missing' && uses === 'bundled' && (outcome === 'create' || decision === 'update'))
          issues.push({ code: 'shared_pool_species_missing', severity: 'error', path: `sharedPools.${pool.key}`, message: `Shared pool “${body.name}” names WaifuMon “${s.slug}”, which this server does not have. Deploy that species through the content release first.` });
        if (s.status === 'disabled')
          issues.push({ code: 'shared_pool_species_disabled', severity: 'warning', path: `sharedPools.${pool.key}`, message: `Shared pool “${body.name}” names WaifuMon “${s.slug}”, which is disabled here; the pool cannot be enabled until it is.` });
      }
      const otherDungeons = state.poolReferences.get(pool.key) ?? [];
      if (decision === 'update' && otherDungeons.length)
        issues.push({
          code: 'shared_pool_shared',
          severity: 'warning',
          path: `sharedPools.${pool.key}`,
          message: `Updating “${pool.name}” changes the WaifuMon that future runs of other dungeons meet: ${[...new Set(otherDungeons.map((d) => d.name))].join(', ')}. Runs already in progress keep their frozen pools.`,
        });
      poolPlans.push({ key: pool.key, name: body.name, outcome, changedFields, enabledHere: here ? here.definition.enabled : null, enabledAfterImport, currentRevision: here?.revision ?? null, otherDungeons, decision, uses, species });
    }

    // 4. Enemies, by CP-3's plan.
    const enemyPlans: BundleEnemyPlan[] = [];
    const enemyDecisions = new Map<string, 'update' | 'keep'>();
    const enemyOverlay = new Map<string, { enabled: boolean }>();
    if (state.enemyPlan) {
      for (const entry of state.enemyPlan.planned) {
        const needsDecision = entry.outcome === 'update' || entry.outcome === 'conflict';
        const decision = needsDecision ? (decisions.enemies[entry.key] ?? null) : null;
        if (needsDecision && !decision) decisionsRequired.push(`enemy:${entry.key}`);
        if (decision) enemyDecisions.set(entry.key, decision);
        if (entry.outcome === 'invalid') for (const i of entry.issues) issues.push({ code: 'enemy_invalid', severity: 'error', path: `enemies.${i.path}`, message: i.message });
        if (entry.outcome === 'create') {
          enemyOverlay.set(entry.key, { enabled: false });
          remainsDisabled.push({ kind: 'enemy', key: entry.key, name: entry.name, requiredForPublication: false });
        }
        const { definition: _d, row: _r, ...shown } = entry;
        enemyPlans.push({ ...shown, decision });
      }
    }
    const enemyApproved = (p: EnemyPlannedEntry) => p.outcome === 'create' || ((p.outcome === 'update' || p.outcome === 'conflict') && enemyDecisions.get(p.key) === 'update');
    for (const p of state.enemyPlan?.planned ?? []) {
      for (const slot of ['artwork', 'sprite'] as const) {
        const d = p[slot].destination;
        if (d.kind !== 'reuse' && d.kind !== 'create') continue;
        used(d.asset, `Enemy “${p.name}” — ${slot === 'artwork' ? 'full art' : 'sprite'}`);
        if (!enemyApproved(p)) continue;
        if (d.kind === 'reuse') reused.set(d.asset, d.assetId);
        else toCreate.set(d.asset, entryOf(d.asset));
      }
    }

    // 5. The dungeon itself, by the Dungeon JSON importer, with the bundle's dependencies in view.
    const bundleContext: DungeonBundleImportContext = {
      allowSceneSprites: true,
      rewrite: (d) => rekeySceneSprites(rebindShippedArtwork(d, rebinds), copies),
      enemies: enemyOverlay,
      sharedPools: reviewPools,
      sceneSprites: catalogue,
      managedArtwork: managedKeys,
    };
    const plan = await deps.content.planImportInTx(tx, pkg, { lock, lootTables: decisions.lootTables, bundle: bundleContext });
    for (const table of plan.lootTables ?? []) if (table.status === 'different' && !table.decision) decisionsRequired.push(`lootTable:${table.key}`);
    // CP-3 decides enemies, so the package-level enemy notes do not apply to a bundle.
    const innerIssues: BundlePlanIssue[] = plan.issues.filter((i) => i.code !== 'enemy_conflict');
    const dungeonDecision = plan.target?.status === 'new' ? 'create' : plan.target?.status === 'identical' ? 'unchanged' : 'replace';
    if (decisions.dungeon && decisions.dungeon !== dungeonDecision)
      issues.push({ code: 'bundle_decision_invalid', severity: 'error', path: 'decisions.dungeon', message: `This review requires the "${dungeonDecision}" dungeon decision.` });

    // 6. External prerequisites, with what the review found about each.
    const prerequisites: BundlePrerequisite[] = state.external.map((p) => {
      const notes: string[] = [];
      if (p.kind === 'species') {
        const row = state.speciesRows.get(p.key);
        if (row?.tags.includes('dungeon_exclusive')) notes.push('Dungeon-exclusive: only this dungeon’s own Species access (and any central access) can grant it.');
        if (row && state.speciesArtwork && !state.speciesArtwork(p.key)) notes.push('No dungeon sprite or standard artwork here; deploy it with the species content release.');
        const evidence = plan.encounterDependencies?.requiredSpecies.find((s) => s.slug === p.key);
        if (evidence && evidence.status !== 'available' && evidence.status !== 'missing' && evidence.status !== 'disabled') notes.push(`Encounter access: ${evidence.status.replaceAll('_', ' ')}.`);
      }
      if (p.status !== 'available') notes.push(p.status === 'missing' ? 'Not on this server: deploy it through its own release before this dungeon can be published.' : 'Disabled on this server.');
      return { ...p, notes };
    });
    for (const p of prerequisites)
      if (p.kind === 'species' && p.notes.some((n) => n.startsWith('No dungeon sprite')))
        issues.push({ code: 'species_artwork_missing', severity: 'warning', path: `prerequisites.species.${p.key}`, message: `WaifuMon “${p.name}” has no usable dungeon artwork here. Players will see the room scene or text.` });

    const allIssues = [...issues, ...innerIssues];
    // An unanswered choice is reported in `decisionsRequired`, not as a reason the bundle cannot be imported.
    const blocking = allIssues.filter((i) => i.severity === 'error' && i.code !== 'loot_table_decision_required');
    const innerSet = new Set(innerIssues);
    const repairable = blocking.every((i) => innerSet.has(i) && isRepairableImportIssue(i, pkg.schemaVersion));
    const readiness: BundleReadiness = !blocking.length
      ? remainsDisabled.some((d) => d.requiredForPublication) ? 'needs_enabling' : 'ready'
      : repairable ? 'incomplete' : 'blocked';

    const assets: BundleAssetPlan[] = manifest.assets.map((entry) => ({
      ...entry,
      action: toCreate.has(entry.id) ? 'create' : reused.has(entry.id) ? 'reuse' : 'not_needed',
      reuse: reused.has(entry.id) ? [reused.get(entry.id)!] : [],
      usedBy: usage.get(entry.id) ?? [],
    }));
    const preview: DungeonBundlePreview = {
      bundle: {
        format: manifest.format,
        version: manifest.version,
        exportedAt: manifest.exportedAt,
        sourceEnvironment: manifest.source.environment,
        origin: manifest.source.origin,
        draftRevision: manifest.source.draftRevision,
        publishedRevision: manifest.source.publishedRevision,
        packageSchemaVersion: pkg.schemaVersion,
        sceneSpriteEvidence: manifest.sceneSprites?.evidence ?? null,
        bundleHash: bundle.bundleHash,
        warnings: manifest.warnings,
      },
      dungeon: { key: definition.key, name: definition.name, decision: dungeonDecision, plan },
      artwork: { dungeon: dungeonArtwork, assets },
      sceneSprites: spritePlans,
      sharedPools: poolPlans,
      enemies: enemyPlans,
      prerequisites,
      remainsDisabled,
      issues: allIssues,
      decisionsRequired,
      readiness,
      planHash: '',
    };
    return { preview, toCreate, reused, bundleContext, spriteWrites, poolWrites, enemyApproved };
  }

  /** The decision-independent hash of everything on this server the review relied on. */
  function stateHash(bundle: DungeonBundle, state: DestinationState, neutral: Evaluation): string {
    return sha256({
      bundleHash: bundle.bundleHash,
      dungeonPlan: neutral.preview.dungeon.plan.planHash,
      enemyPlan: state.enemyPlan?.preview.planHash ?? null,
      reusable: [...state.reusable].sort(byKey),
      resolves: [...state.resolves].sort(byKey),
      shipped: [...state.shipped].sort(byKey),
      sprites: [...state.sprites].sort(byKey),
      spriteKeys: [...state.spriteKeys].sort(),
      pools: [...state.pools].sort(byKey),
      species: [...state.speciesRows].sort(byKey),
      external: state.external,
    });
  }

  async function review(tx: DbOrTx, bundle: DungeonBundle, decisions: DungeonBundleDecisions, lock: boolean) {
    const state = await loadState(tx, bundle, lock);
    const neutral = await evaluate(tx, bundle, state, NEUTRAL, lock);
    const planHash = stateHash(bundle, state, neutral);
    const chosen = canonicalJson(decisions) === canonicalJson(NEUTRAL) ? neutral : await evaluate(tx, bundle, state, decisions, lock);
    chosen.preview.planHash = planHash;
    return { state, evaluation: chosen, planHash };
  }

  // ── preview ───────────────────────────────────────────────────────────────

  async function preview(archive: Buffer, raw: Partial<DungeonBundleDecisions> = {}): Promise<DungeonBundlePreview> {
    const bundle = await parseDungeonBundle(archive);
    const decisions = parseDecisions(raw);
    return db.transaction(async (tx) => (await review(tx, bundle, decisions, false)).evaluation.preview, {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  function parseDecisions(raw: unknown): DungeonBundleDecisions {
    const parsed = DungeonBundleDecisionsSchema.safeParse(raw ?? {});
    if (!parsed.success)
      throw new DungeonBundleInvalidError(parsed.error.issues.map((i) => ({ path: ['decisions', ...i.path].join('.'), message: i.message })));
    return parsed.data;
  }

  // ── apply ─────────────────────────────────────────────────────────────────

  function assertApplicable(evaluation: Evaluation, decisions: DungeonBundleDecisions) {
    const p = evaluation.preview;
    if (p.decisionsRequired.length) throw new DungeonBundleDecisionsRequiredError(p.decisionsRequired);
    if (!decisions.dungeon) throw new DungeonBundleDecisionsRequiredError([`dungeon:${p.dungeon.decision}`]);
    const fatal = p.issues.filter((i) => i.severity === 'error');
    if (p.readiness === 'blocked' || (p.readiness === 'incomplete' && !decisions.allowIncomplete))
      throw new DungeonBundleRejectedError(fatal.map((i) => ({ path: i.path, message: i.message })));
  }

  async function apply(archive: Buffer, request: DungeonBundleRequest, actor: string | null): Promise<DungeonBundleImportResult> {
    const bundle = await parseDungeonBundle(archive);
    const decisions = parseDecisions(request.decisions);
    const requestHash = sha256({ kind: 'dungeon_bundle', bundleHash: bundle.bundleHash, expectedPlanHash: request.expectedPlanHash, decisions, actor });

    // An applied request is answered from its receipt, whatever this server looks like now.
    const receipt = await findImportReceipt(db, request.requestId);
    if (receipt?.status === 'applied') {
      if (receipt.requestHash !== requestHash || receipt.kind !== 'dungeon_bundle') throw new DungeonBundleRequestConflictError(false);
      return { ...(receipt.result as unknown as DungeonBundleImportResult), importId: receipt.id, replayed: true };
    }
    await deps.enemyPackages.recoverInterruptedImports().catch((err: unknown) =>
      deps.logger?.warn({ tag: 'dungeon-bundle/recovery', err }, 'could not recover interrupted artwork imports'),
    );

    // Fail fast, before staging anything: stale, undecided or blocked.
    const first = await db.transaction(async (tx) => review(tx, bundle, decisions, false), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    if (first.planHash !== request.expectedPlanHash) throw new DungeonBundleStaleError();
    assertApplicable(first.evaluation, decisions);

    const staged: StagedBundleAsset[] = planStagedAssets([...first.evaluation.toCreate.values()].map((entry) => ({ entry, image: bundle.assets.get(entry.id)!.image })));
    const opened = await openImportJournal(
      db,
      { kind: 'dungeon_bundle', requestId: request.requestId, requestHash, packageHash: bundle.bundleHash, planHash: request.expectedPlanHash, keys: staged.map((s) => s.storageKey), actor },
      now(),
    );
    if ('conflict' in opened) throw new DungeonBundleRequestConflictError(opened.conflict.inProgress);
    const journal = opened.row;

    try {
      await writeStagedAssets(storage, staged, (entry) => bundle.assets.get(entry.id)!.data);
      await deps.faults?.afterStaging?.();
      return await db.transaction(async (tx) => {
        const locked = await review(tx, bundle, decisions, true);
        if (locked.planHash !== request.expectedPlanHash) throw new DungeonBundleStaleError();
        assertApplicable(locked.evaluation, decisions);
        const evaluation = locked.evaluation;
        if (canonicalJson([...evaluation.toCreate.keys()].sort()) !== canonicalJson(staged.map((s) => s.entry.id).sort())) throw new DungeonBundleStaleError();

        // Artwork rows for the staged files, then each dependency, then the draft.
        const created = await insertStagedAssets(tx, staged, { actor, details: { source: 'dungeon_bundle_import', requestId: request.requestId, dungeonKey: bundle.pkg.dungeon.key } });
        const assetIdOf = (entryId: string) => created.get(entryId)?.id ?? evaluation.reused.get(entryId) ?? null;
        const enemyResult = locked.state.enemyPlan
          ? await deps.enemyPackages.bundle.write(tx, locked.state.enemyPlan.planned, evaluation.enemyApproved, (d: EnemySlotDestination) =>
              d.kind === 'reuse' ? d.assetId : d.kind === 'create' ? assetIdOf(d.asset) : null, actor)
          : { created: [], updated: [], skipped: [], unchanged: [] };

        const sprites: DungeonBundleImportResult['sceneSprites'] = { created: [], updated: [], copied: [], reused: [], kept: [] };
        for (const write of evaluation.spriteWrites) {
          const assetId = write.reuse ?? assetIdOf(write.sprite.asset);
          if (!assetId) throw new DungeonBundleStaleError();
          await deps.sceneSprites.applyImported(
            tx,
            write.key,
            {
              name: write.sprite.name,
              category: write.sprite.category ?? write.existingCategory,
              assetId,
              placement: write.sprite.placement,
              mirror: write.sprite.mirror,
              visualLayer: write.sprite.visualLayer,
            },
            write.expectedRevision,
            actor,
            { source: 'dungeon_bundle_import', requestId: request.requestId, dungeonKey: bundle.pkg.dungeon.key, ...(write.copyOf ? { copyOf: write.copyOf } : {}) },
          );
          if (write.copyOf) sprites.copied.push({ from: write.copyOf, to: write.key });
          else (write.expectedRevision === null ? sprites.created : sprites.updated).push(write.key);
        }
        for (const s of evaluation.preview.sceneSprites) {
          if (s.outcome === 'identical') sprites.reused.push(s.key);
          if (s.decision === 'keep') sprites.kept.push(s.key);
        }

        const pools: DungeonBundleImportResult['sharedPools'] = { created: [], updated: [], reused: [], kept: [] };
        for (const write of evaluation.poolWrites) {
          await deps.sharedPools.applyImported(tx, write.definition, write.expectedRevision, actor);
          (write.expectedRevision === null ? pools.created : pools.updated).push(write.definition.key);
        }
        for (const p of evaluation.preview.sharedPools) {
          if (p.outcome === 'identical') pools.reused.push(p.key);
          if (p.decision === 'keep') pools.kept.push(p.key);
        }

        // The draft, by the Dungeon JSON importer, now seeing everything just written.
        let dungeon: DungeonImportResult;
        try {
          dungeon = await deps.content.applyImportInTx(
            tx,
            {
              package: bundle.pkg,
              requestId: request.requestId,
              expectedPlanHash: request.expectedPlanHash,
              expectedRevision: evaluation.preview.dungeon.plan.target?.expectedRevision ?? null,
              decisions: {
                dungeon: decisions.dungeon!,
                // Every enemy exists now: CP-3 created or decided each one.
                enemies: Object.fromEntries(dungeonDependencies(bundle.pkg.dungeon).enemies.map((k) => [k, 'use_existing' as const])),
                allowMissingDependencies: decisions.allowIncomplete,
                ...(decisions.lootTables ? { lootTables: decisions.lootTables } : {}),
              },
            },
            actor,
            { ...evaluation.bundleContext, enemies: undefined, managedArtwork: undefined, sceneSprites: await sceneSpriteCatalogue(tx, storage) },
          );
        } catch (err) {
          if (err instanceof DungeonImportError) {
            if (err.code === 'DUNGEON_IMPORT_STALE') throw new DungeonBundleStaleError();
            throw new DungeonBundleRejectedError(err.issues.map((i) => ({ path: i.path, message: i.message })));
          }
          throw err;
        }

        const result: Omit<DungeonBundleImportResult, 'importId' | 'replayed'> = {
          requestId: request.requestId,
          dungeonKey: dungeon.dungeonKey,
          dungeonResult: dungeon.result,
          draftRevision: dungeon.draftRevision,
          dungeonImportId: dungeon.importId,
          enabled: dungeon.enabled ?? false,
          publishedRevision: dungeon.publishedRevision ?? null,
          readiness: evaluation.preview.readiness,
          enemies: enemyResult,
          sceneSprites: sprites,
          sharedPools: pools,
          assets: { created: staged.length, reused: evaluation.reused.size },
          createdLootTables: dungeon.createdLootTables ?? [],
          remainsDisabled: evaluation.preview.remainsDisabled,
          issues: evaluation.preview.issues,
        };
        await deps.faults?.beforeCommit?.(tx);
        await markImportApplied(tx, journal, result as unknown as Record<string, unknown>, now());
        return { ...result, importId: journal.id, replayed: false };
      });
    } catch (err) {
      await failImportJournal(db, storage, journal, err, now(), (cleanupErr) =>
        deps.logger?.warn({ tag: 'dungeon-bundle/cleanup', requestId: request.requestId, err: cleanupErr }, 'could not clean up a failed dungeon bundle import'),
      );
      if (uniqueViolationConstraint(err)) throw new DungeonBundleStaleError();
      throw err;
    }
  }

  return { exportBundle, preview, apply };
}
