/**
 * Enemy Catalogue packages: export with artwork, preview, apply, recover
 * (Content Portability CP-3). The format is `enemyPackage.ts`; artwork
 * identity and destination binding are `artworkAssets/package/artworkBundle.ts`.
 *
 * ## Export
 *
 * Everything, or exactly the selected keys (an unknown key is an error, an
 * empty selection is refused — never widened). Each enemy's artwork travels
 * as bytes: its managed full art and sprite, and the shipped files its
 * definition names. A shipped file the enemy *renders* (no active managed
 * override in that slot) must be readable and an accepted still image, or the
 * export fails; a shipped file behind an active override is only a fallback,
 * carried when it can be and otherwise noted. A disabled override is not
 * carried — here it already shows the shipped artwork instead.
 *
 * ## Import: preview, then apply what was previewed
 *
 * Each enemy is `create`, `update`, `conflict` (an update to an enemy content
 * here still uses), `unchanged` or `invalid`. New enemies start **disabled**;
 * existing ones keep their enabled state. Every update or conflict needs an
 * explicit update/skip decision. Each artwork slot is bound to a
 * destination-local asset (`artworkBundle`): reused when this server already
 * holds the exact bytes in the same category, otherwise created; a shipped
 * file this server lacks (or holds different bytes for) is bound as managed
 * artwork from the packaged copy. Nothing is written into `assets/`.
 *
 * Apply re-plans under lock and refuses if the plan hash moved.
 *
 * ## Files and the database
 *
 * They cannot commit together, so the order is:
 *
 *   1. journal — an `enemy_package_imports` row (`staged`, with the storage
 *      key of every file about to be written) is **committed first**;
 *   2. stage — the new assets' bytes are written under destination-generated
 *      ids (never an existing asset's key);
 *   3. one transaction — locks, re-plan, asset rows, enemy writes, and the
 *      journal row set `applied` with the result (the receipt a retry replays);
 *   4. on a caught failure the staged files no asset row names are removed
 *      and the row is marked `failed`;
 *   5. after a crash between 2 and 3, the row is still `staged`:
 *      {@link EnemyPackageService.recoverInterruptedImports} (startup, and
 *      before every apply) removes those files once the row is old enough
 *      that no live import can own it, and marks it `abandoned`.
 *
 * Reused assets are never written, disabled or deleted, so an active dungeon
 * run — which froze enemy definitions and asset ids at its start — keeps
 * exactly the images it had.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { combatEnemies, enemyPackageImports, type CombatEnemyRow } from '../../db/schema';
import {
  ArtworkUploadInvalidError,
  EnemyExportKeysNotFoundError,
  EnemyExportRefusedError,
  EnemyImportDecisionsRequiredError,
  EnemyImportRejectedError,
  EnemyImportRequestConflictError,
  EnemyImportStaleError,
  type EnemyPackageIssue,
  type EnemyReference,
} from '../../shared/errors';
import type { ArtworkAssetService } from '../artworkAssets/artworkAssetService';
import type { ArtworkStorage } from '../artworkAssets/artworkStorage';
import { inspectImage, type InspectedImage } from '../artworkAssets/imageInspection';
import {
  createBundleAssetCollector,
  findReusableAsset,
  insertStagedAssets,
  planStagedAssets,
  removeUnclaimedStagedFiles,
  writeStagedAssets,
  type BundleAssetEntry,
  type StagedBundleAsset,
} from '../artworkAssets/package/artworkBundle';
import { locateArtworkFile } from '../assets/artworkFile';
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import { canonicalJson } from '../rewardTables/rewardTableCore';
import {
  ENEMY_ARTWORK_SLOTS,
  ENEMY_PACKAGE_CONTENT_TYPE,
  ENEMY_PACKAGE_FORMAT,
  ENEMY_PACKAGE_LIMITS,
  ENEMY_PACKAGE_VERSION,
  ENEMY_SLOT_CATEGORY,
  buildEnemyPackageArchive,
  parseEnemyPackage,
  type EnemyArtworkSlot,
  type EnemyPackage,
  type EnemyPackageManifest,
  type EnemySlotBinding,
} from './enemyPackage';
import { RESERVED_ENEMY_KEYS, type EnemyCatalogueService } from './enemyService';
import { combatEnemyHash, enemyDefinitionOf, readCombatEnemyRows } from './enemyStore';

/** A `staged` journal row older than this belongs to no live import. */
export const ENEMY_IMPORT_RECOVERY_AGE_MS = 10 * 60 * 1000;

export type EnemyExportSelection = { scope: 'all' } | { scope: 'selected'; keys: readonly string[] };

export interface EnemyPackageExport {
  filename: string;
  archive: Buffer;
  enemies: number;
  assets: number;
  warnings: EnemyPackageManifest['warnings'];
}

export type EnemyImportOutcome = 'create' | 'update' | 'conflict' | 'unchanged' | 'invalid';

/** Where a slot's image will come from on this server. */
export type EnemySlotDestination =
  | { kind: 'none' }
  /** This server's own shipped file at that path already holds the bytes. */
  | { kind: 'shipped_file'; path: string }
  | { kind: 'reuse'; asset: string; assetId: string }
  | { kind: 'create'; asset: string };

export interface EnemySlotPlan {
  /** What the package shows in this slot. */
  source: 'none' | 'managed' | 'shipped';
  destination: EnemySlotDestination;
  notes: string[];
}

export interface EnemyImportEntry {
  key: string;
  name: string;
  outcome: EnemyImportOutcome;
  /** Fields that would change: definition fields, plus `artworkAssetId` / `spriteAssetId`. */
  changedFields: string[];
  activation: { packageEnabled: boolean; enabled: boolean; reason: 'new_enemies_start_disabled' | 'existing_status_kept' } | null;
  /** For a conflict: what here uses the enemy. */
  references: EnemyReference[];
  issues: EnemyPackageIssue[];
  artwork: EnemySlotPlan;
  sprite: EnemySlotPlan;
}

export interface EnemyImportAssetPlan extends BundleAssetEntry {
  /** `not_needed`: this server already shows that image from its own shipped file. */
  action: 'reuse' | 'create' | 'not_needed';
  /** Destination assets reused for it. */
  reuse: string[];
  usedBy: { key: string; slot: EnemyArtworkSlot }[];
}

export interface EnemyImportPreview {
  package: {
    format: string;
    version: number;
    exportedAt: string;
    scope: 'all' | 'selected';
    sourceEnvironment: string;
    packageHash: string;
    warnings: EnemyPackageManifest['warnings'];
  };
  entries: EnemyImportEntry[];
  assets: EnemyImportAssetPlan[];
  counts: Record<EnemyImportOutcome, number>;
  /** Keys needing a decision, in the order `decisions` answers them. */
  decisionKeys: string[];
  ok: boolean;
  planHash: string;
}

export interface EnemyImportResult {
  importId: number;
  requestId: string;
  replayed: boolean;
  created: string[];
  updated: string[];
  skipped: string[];
  unchanged: string[];
  assets: { created: { asset: string; assetId: string; category: string }[]; reused: { asset: string; assetId: string }[] };
}

export interface EnemyImportRequest {
  expectedPlanHash: string;
  requestId: string;
  /** One `u` (update) or `s` (skip) per `decisionKeys` entry, in order. */
  decisions: string;
}

export interface EnemyPackageService {
  /** @throws {EnemyExportKeysNotFoundError | EnemyExportRefusedError} */
  exportPackage(selection: EnemyExportSelection): Promise<EnemyPackageExport>;
  /** @throws {EnemyPackageInvalidError} */
  preview(archive: Buffer): Promise<EnemyImportPreview>;
  /**
   * @throws {EnemyPackageInvalidError | EnemyImportStaleError | EnemyImportRejectedError |
   *   EnemyImportDecisionsRequiredError | EnemyImportRequestConflictError}
   */
  apply(archive: Buffer, request: EnemyImportRequest, actor: string | null): Promise<EnemyImportResult>;
  /** Remove files staged by imports that never finished. Safe to run any time. */
  recoverInterruptedImports(opts?: { olderThanMs?: number }): Promise<{ abandoned: number; removedFiles: number }>;
}

export interface EnemyPackageServiceDeps {
  db: Db;
  enemies: Pick<EnemyCatalogueService, 'applyImported' | 'references'>;
  assets: Pick<ArtworkAssetService, 'getMany' | 'read'>;
  storage: ArtworkStorage;
  /** The shipped artwork root (`ASSETS_DIR`): read on export, compared on import, never written. */
  assetsDir: string;
  /** Diagnostics label written into exported manifests. */
  environment: string;
  logger?: { warn(fields: Record<string, unknown>, message: string): void; info?(fields: Record<string, unknown>, message: string): void };
  now?: () => Date;
  /** Test seams: fail at a precise point to prove cleanup and recovery. */
  faults?: { afterStaging?: () => Promise<void>; beforeCommit?: (tx: DbOrTx) => Promise<void> };
}

const sha256 = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
const DEFINITION_FIELDS = ['name', 'description', 'attack', 'defense', 'hp', 'tags', 'artworkPath', 'spriteArtworkPath', 'spritePlacement'] as const;
const SLOT_COLUMN = { artwork: 'artworkAssetId', sprite: 'spriteAssetId' } as const;

interface PlannedEntry extends EnemyImportEntry {
  definition: CombatEnemyDefinition;
  row: CombatEnemyRow | null;
}
interface Plan {
  preview: EnemyImportPreview;
  planned: PlannedEntry[];
}

export function createEnemyPackageService(deps: EnemyPackageServiceDeps): EnemyPackageService {
  const { db, storage } = deps;
  const now = () => deps.now?.() ?? new Date();

  // ── export ────────────────────────────────────────────────────────────────

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

  async function exportPackage(selection: EnemyExportSelection): Promise<EnemyPackageExport> {
    const L = ENEMY_PACKAGE_LIMITS;
    let rows = await readCombatEnemyRows(db);
    if (selection.scope === 'selected') {
      const wanted = [...new Set(selection.keys)];
      if (wanted.length === 0) throw new EnemyExportRefusedError('empty', 'No enemies were selected, so nothing was exported.');
      const present = new Set(rows.map((r) => r.enemyKey));
      const missing = wanted.filter((k) => !present.has(k)).sort();
      if (missing.length > 0) throw new EnemyExportKeysNotFoundError(missing);
      const set = new Set(wanted);
      rows = rows.filter((r) => set.has(r.enemyKey));
    } else if (rows.length === 0) {
      throw new EnemyExportRefusedError('empty', 'The Enemy Catalogue is empty, so nothing was exported.');
    }
    if (rows.length > L.maxEnemies) {
      throw new EnemyExportRefusedError(
        'too_large',
        `${rows.length} enemies is more than the ${L.maxEnemies} a package may hold. Export a smaller selection.`,
      );
    }

    const managedIds = rows.flatMap((r) => [r.artworkAssetId, r.spriteAssetId]).filter((id): id is string => id !== null);
    const managed = await deps.assets.getMany(managedIds);
    const collector = createBundleAssetCollector();
    const errors: (EnemyPackageIssue & { reason: 'artwork_unavailable' | 'unsupported_artwork' })[] = [];
    const warnings: EnemyPackageManifest['warnings'] = [];
    const bindings: EnemyPackageManifest['enemies'] = [];
    const definitions: CombatEnemyDefinition[] = [];

    for (const row of rows) {
      const definition = enemyDefinitionOf(row);
      definitions.push(definition);
      const binding = { key: row.enemyKey } as EnemyPackageManifest['enemies'][number];
      for (const slot of ENEMY_ARTWORK_SLOTS) {
        const at = `${row.enemyKey}.${slot}`;
        const what = slot === 'artwork' ? 'full artwork' : 'sprite';
        const managedId = row[SLOT_COLUMN[slot]];
        let managedRef: string | null = null;
        if (managedId) {
          const asset = managed.get(managedId);
          if (!asset || asset.status === 'deleted') {
            errors.push({ path: at, message: `the managed ${what} no longer exists — choose another or clear it first`, reason: 'artwork_unavailable' });
          } else if (asset.status === 'disabled') {
            warnings.push({ key: row.enemyKey, slot, message: `managed ${what} "${asset.name}" is disabled, so it was not exported; the shipped artwork shows instead, as it does here` });
          } else {
            const read = await deps.assets.read(managedId);
            const image = read ? await inspect(read.bytes) : null;
            if (!read) errors.push({ path: at, message: `the managed ${what} "${asset.name}" has no stored file on this server`, reason: 'artwork_unavailable' });
            else if (typeof image === 'string') errors.push({ path: at, message: `the managed ${what} "${asset.name}" is not an accepted image: ${image}`, reason: 'unsupported_artwork' });
            else if (image && image.contentHash !== asset.contentHash) {
              errors.push({ path: at, message: `the stored file of managed ${what} "${asset.name}" does not match its recorded hash`, reason: 'artwork_unavailable' });
            } else if (image && read) {
              managedRef = collector.add({ category: asset.category, bytes: read.bytes, image, name: asset.name }).id;
            }
          }
        }

        const shippedPath = slot === 'artwork' ? definition.artworkPath : definition.spriteArtworkPath;
        let shipped: EnemySlotBinding['shipped'] = null;
        if (shippedPath) {
          // Without an active override the shipped file IS the picture, so it must travel.
          const required = managedRef === null;
          const file = await readShipped(shippedPath);
          let asset: string | null = null;
          if ('bytes' in file) {
            const image = await inspect(file.bytes);
            if (typeof image !== 'string') {
              asset = collector.add({ category: ENEMY_SLOT_CATEGORY[slot], bytes: file.bytes, image, name: path.posix.basename(shippedPath) }).id;
            } else if (required) {
              errors.push({ path: at, message: `shipped ${what} ${shippedPath} cannot be imported as managed artwork: ${image}`, reason: 'unsupported_artwork' });
            } else {
              warnings.push({ key: row.enemyKey, slot, message: `fallback ${shippedPath} was not carried: ${image}` });
            }
          } else if (required) {
            errors.push({ path: at, message: `shipped ${what} ${shippedPath} is ${file.status === 'unsafe' ? 'outside the assets folder' : 'missing'} on this server`, reason: 'artwork_unavailable' });
          } else {
            warnings.push({ key: row.enemyKey, slot, message: `fallback ${shippedPath} is missing on this server and was not carried` });
          }
          shipped = { path: shippedPath, asset };
        }
        binding[slot] = { managed: managedRef, shipped };
      }
      bindings.push(binding);
    }

    if (errors.length > 0) {
      const reason = errors.some((e) => e.reason === 'artwork_unavailable') ? 'artwork_unavailable' : 'unsupported_artwork';
      throw new EnemyExportRefusedError(
        reason,
        'Some enemies need artwork that cannot be packaged from this server, so nothing was exported.',
        errors.map(({ path: p, message }) => ({ path: p, message })),
      );
    }
    const entries = collector.entries();
    if (entries.length > L.maxAssets) {
      throw new EnemyExportRefusedError('too_large', `${entries.length} images is more than the ${L.maxAssets} a package may hold. Export a smaller selection.`);
    }
    const manifest: EnemyPackageManifest = {
      format: ENEMY_PACKAGE_FORMAT,
      version: ENEMY_PACKAGE_VERSION,
      contentType: ENEMY_PACKAGE_CONTENT_TYPE,
      exportedAt: now().toISOString(),
      scope: selection.scope,
      source: { environment: deps.environment.slice(0, 64) },
      enemies: bindings,
      assets: entries,
      warnings,
    };
    const imageBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    const archive = buildEnemyPackageArchive(manifest, definitions, collector.files());
    if (archive.length > L.maxArchiveBytes || imageBytes + 2 * L.maxJsonBytes > L.maxExpandedBytes) {
      throw new EnemyExportRefusedError(
        'too_large',
        `The package would be ${archive.length} bytes (${imageBytes} of images), more than an import accepts. Export a smaller selection.`,
      );
    }
    const stamp = manifest.exportedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    return { filename: `enemies-${selection.scope}-${stamp}.zip`, archive, enemies: rows.length, assets: entries.length, warnings };
  }

  // ── planning ──────────────────────────────────────────────────────────────

  async function plan(tx: DbOrTx, pkg: EnemyPackage, lock: boolean): Promise<Plan> {
    const keys = pkg.definitions.map((d) => d.key);
    const query = tx.select().from(combatEnemies).where(inArray(combatEnemies.enemyKey, keys));
    const rows = new Map((lock ? await query.for('update') : await query).map((r) => [r.enemyKey, r]));

    // Destination shipped files, read once per path.
    const shippedHere = new Map<string, Promise<string | null>>();
    const shippedHash = (relative: string) => {
      if (!shippedHere.has(relative)) {
        shippedHere.set(
          relative,
          readShipped(relative).then((f) => ('bytes' in f ? createHash('sha256').update(f.bytes).digest('hex') : null)),
        );
      }
      return shippedHere.get(relative)!;
    };
    /** Does this asset (the one a slot holds now) still carry exactly `entry`? */
    const holds = async (assetId: string | null, entry: BundleAssetEntry) =>
      assetId !== null && (await findReusableAsset(tx, storage, { category: entry.category, sha256: entry.sha256, prefer: assetId })) === assetId;
    const reuseCache = new Map<string, string | null>();
    async function bind(entry: BundleAssetEntry, current: string | null): Promise<EnemySlotDestination> {
      if (await holds(current, entry)) return { kind: 'reuse', asset: entry.id, assetId: current! };
      const identity = `${entry.category}:${entry.sha256}`;
      if (!reuseCache.has(identity)) reuseCache.set(identity, await findReusableAsset(tx, storage, { category: entry.category, sha256: entry.sha256 }));
      const found = reuseCache.get(identity)!;
      return found ? { kind: 'reuse', asset: entry.id, assetId: found } : { kind: 'create', asset: entry.id };
    }

    const planned: PlannedEntry[] = [];
    for (const [i, packaged] of pkg.definitions.entries()) {
      const binding = pkg.manifest.enemies[i]!;
      const row = rows.get(packaged.key) ?? null;
      const slots = {} as Record<EnemyArtworkSlot, EnemySlotPlan>;
      for (const slot of ENEMY_ARTWORK_SLOTS) {
        const b = binding[slot];
        const current = row ? row[SLOT_COLUMN[slot]] : null;
        const notes: string[] = [];
        const entryOf = (id: string | null) => (id ? pkg.assets.get(id)!.entry : null);
        let destination: EnemySlotDestination = { kind: 'none' };
        let source: EnemySlotPlan['source'] = 'none';
        if (b.managed) {
          source = 'managed';
          destination = await bind(entryOf(b.managed)!, current);
          if (b.shipped) {
            const shippedEntry = entryOf(b.shipped.asset);
            const here = await shippedHash(b.shipped.path);
            if (here === null) notes.push(`fallback ${b.shipped.path} is not on this server; only the managed image shows`);
            else if (shippedEntry && here !== shippedEntry.sha256) notes.push(`fallback ${b.shipped.path} differs on this server`);
          }
        } else if (b.shipped) {
          source = 'shipped';
          const entry = entryOf(b.shipped.asset)!;
          const here = await shippedHash(b.shipped.path);
          if (here === entry.sha256) {
            // This server already shows it — unless the slot already holds the same bytes, keep it.
            destination = (await holds(current, entry)) ? { kind: 'reuse', asset: entry.id, assetId: current! } : { kind: 'shipped_file', path: b.shipped.path };
          } else {
            destination = await bind(entry, current);
            notes.push(
              here === null
                ? `${b.shipped.path} is not on this server; the packaged copy is used as managed artwork`
                : `${b.shipped.path} holds a different image on this server; the packaged copy is used as managed artwork`,
            );
          }
        }
        slots[slot] = { source, destination, notes };
      }

      const enabled = row ? row.enabled : false;
      const definition: CombatEnemyDefinition = { ...packaged, enabled };
      const managedOf = (slot: EnemyArtworkSlot) => {
        const d = slots[slot].destination;
        return d.kind === 'reuse' ? d.assetId : d.kind === 'create' ? `create:${d.asset}` : null;
      };
      const issues: EnemyPackageIssue[] = [];
      if (!row && RESERVED_ENEMY_KEYS.has(packaged.key)) issues.push({ path: packaged.key, message: `"${packaged.key}" is a reserved key and cannot be created` });
      if (new Set(packaged.tags).size !== packaged.tags.length) issues.push({ path: `${packaged.key}.tags`, message: 'the same tag is listed twice' });

      let outcome: EnemyImportOutcome;
      let changedFields: string[] = [];
      let references: EnemyReference[] = [];
      if (issues.length > 0) outcome = 'invalid';
      else if (!row) outcome = 'create';
      else {
        const stored = enemyDefinitionOf(row);
        changedFields = DEFINITION_FIELDS.filter((f) => canonicalJson(stored[f]) !== canonicalJson(definition[f]));
        for (const slot of ENEMY_ARTWORK_SLOTS) if (managedOf(slot) !== row[SLOT_COLUMN[slot]]) changedFields.push(SLOT_COLUMN[slot]);
        if (changedFields.length === 0 && combatEnemyHash(definition) === row.contentHash) outcome = 'unchanged';
        else {
          references = (await deps.enemies.references(packaged.key)) ?? [];
          outcome = references.length > 0 ? 'conflict' : 'update';
        }
      }
      const activation =
        packaged.enabled === enabled
          ? null
          : { packageEnabled: packaged.enabled, enabled, reason: row ? ('existing_status_kept' as const) : ('new_enemies_start_disabled' as const) };
      planned.push({
        key: packaged.key,
        name: packaged.name,
        outcome,
        changedFields,
        activation,
        references,
        issues,
        artwork: slots.artwork,
        sprite: slots.sprite,
        definition,
        row,
      });
    }

    const assets: EnemyImportAssetPlan[] = pkg.manifest.assets.map((entry) => {
      const usedBy: EnemyImportAssetPlan['usedBy'] = [];
      const reuse = new Set<string>();
      let create = false;
      for (const p of planned) {
        for (const slot of ENEMY_ARTWORK_SLOTS) {
          const d = p[slot].destination;
          if ((d.kind === 'reuse' || d.kind === 'create') && d.asset === entry.id) {
            usedBy.push({ key: p.key, slot });
            if (d.kind === 'reuse') reuse.add(d.assetId);
            else create = true;
          }
        }
      }
      return { ...entry, action: create ? 'create' : reuse.size > 0 ? 'reuse' : 'not_needed', reuse: [...reuse], usedBy };
    });

    const counts: Record<EnemyImportOutcome, number> = { create: 0, update: 0, conflict: 0, unchanged: 0, invalid: 0 };
    for (const p of planned) counts[p.outcome] += 1;
    const decisionKeys = planned.filter((p) => p.outcome === 'update' || p.outcome === 'conflict').map((p) => p.key).sort();
    const planHash = `sha256:${sha256({
      packageHash: pkg.packageHash,
      entries: planned.map((p) => ({
        key: p.key,
        outcome: p.outcome,
        revision: p.row?.revision ?? null,
        enabled: p.row?.enabled ?? null,
        artwork: p.artwork.destination,
        sprite: p.sprite.destination,
      })),
    })}`;
    const m = pkg.manifest;
    return {
      planned,
      preview: {
        package: {
          format: m.format,
          version: m.version,
          exportedAt: m.exportedAt,
          scope: m.scope,
          sourceEnvironment: m.source.environment,
          packageHash: pkg.packageHash,
          warnings: m.warnings,
        },
        entries: planned.map(({ definition: _d, row: _r, ...entry }) => entry),
        assets,
        counts,
        decisionKeys,
        ok: counts.invalid === 0,
        planHash,
      },
    };
  }

  // ── apply ─────────────────────────────────────────────────────────────────

  function replayOf(row: typeof enemyPackageImports.$inferSelect): EnemyImportResult {
    return { ...(row.result as unknown as EnemyImportResult), importId: row.id, replayed: true };
  }

  async function journal(input: { requestId: string; requestHash: string; packageHash: string; planHash: string; keys: string[]; actor: string | null }) {
    const [inserted] = await db
      .insert(enemyPackageImports)
      .values({
        requestId: input.requestId,
        requestHash: input.requestHash,
        packageHash: input.packageHash,
        planHash: input.planHash,
        status: 'staged',
        stagedStorageKeys: input.keys,
        actor: input.actor,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    // The id was used before: only a failed or abandoned attempt of the very same request may be retried.
    const [reclaimed] = await db
      .update(enemyPackageImports)
      .set({ status: 'staged', stagedStorageKeys: input.keys, planHash: input.planHash, createdAt: now(), finishedAt: null, error: null })
      .where(
        and(
          eq(enemyPackageImports.requestId, input.requestId),
          eq(enemyPackageImports.requestHash, input.requestHash),
          inArray(enemyPackageImports.status, ['failed', 'abandoned']),
        ),
      )
      .returning();
    if (reclaimed) return reclaimed;
    const [existing] = await db.select().from(enemyPackageImports).where(eq(enemyPackageImports.requestId, input.requestId));
    throw new EnemyImportRequestConflictError(existing?.requestHash === input.requestHash && existing.status === 'staged');
  }

  async function apply(archive: Buffer, request: EnemyImportRequest, actor: string | null): Promise<EnemyImportResult> {
    const pkg = await parseEnemyPackage(archive);
    const requestHash = sha256({ packageHash: pkg.packageHash, expectedPlanHash: request.expectedPlanHash, decisions: request.decisions, actor });

    // An applied request is answered from its receipt, whatever the catalogue looks like now.
    const [receipt] = await db.select().from(enemyPackageImports).where(eq(enemyPackageImports.requestId, request.requestId));
    if (receipt?.status === 'applied') {
      if (receipt.requestHash !== requestHash) throw new EnemyImportRequestConflictError(false);
      return replayOf(receipt);
    }

    await recoverInterruptedImports().catch((err: unknown) =>
      deps.logger?.warn({ tag: 'enemy-package/recovery', err }, 'could not recover interrupted enemy imports'),
    );

    const first = await plan(db, pkg, false);
    if (first.preview.planHash !== request.expectedPlanHash) throw new EnemyImportStaleError();
    if (!first.preview.ok) {
      throw new EnemyImportRejectedError(first.preview.entries.flatMap((e) => e.issues));
    }
    const { decisionKeys } = first.preview;
    const chosen = new Map<string, 'u' | 's'>();
    const undecided: string[] = [];
    decisionKeys.forEach((key, i) => {
      const c = request.decisions[i];
      if (request.decisions.length === decisionKeys.length && (c === 'u' || c === 's')) chosen.set(key, c);
      else undecided.push(key);
    });
    if (undecided.length > 0 || request.decisions.length !== decisionKeys.length) {
      throw new EnemyImportDecisionsRequiredError(undecided.length > 0 ? undecided : decisionKeys);
    }
    const writes = (p: { key: string; outcome: EnemyImportOutcome }) =>
      p.outcome === 'create' || ((p.outcome === 'update' || p.outcome === 'conflict') && chosen.get(p.key) === 'u');

    // Only assets an approved write binds are created.
    const toCreate = new Map<string, { entry: BundleAssetEntry; image: InspectedImage }>();
    for (const p of first.planned.filter(writes)) {
      for (const slot of ENEMY_ARTWORK_SLOTS) {
        const d = p[slot].destination;
        if (d.kind === 'create') toCreate.set(d.asset, { entry: pkg.assets.get(d.asset)!.entry, image: pkg.assets.get(d.asset)!.image });
      }
    }
    const staged: StagedBundleAsset[] = planStagedAssets([...toCreate.values()]);
    const row = await journal({
      requestId: request.requestId,
      requestHash,
      packageHash: pkg.packageHash,
      planHash: request.expectedPlanHash,
      keys: staged.map((s) => s.storageKey),
      actor,
    });

    try {
      await writeStagedAssets(storage, staged, (entry) => pkg.assets.get(entry.id)!.data);
      await deps.faults?.afterStaging?.();
      return await db.transaction(async (tx) => {
        // The keys a dungeon import also locks, so the two importers never interleave on an enemy.
        for (const key of [...pkg.definitions.map((d) => d.key)].sort()) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dungeon_import:enemy:${key}`}, 0))`);
        }
        // One enemy package import at a time decides reuse-or-create, so two never create the same image twice.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'enemy_package_import:assets'}, 0))`);
        const locked = await plan(tx, pkg, true);
        if (locked.preview.planHash !== request.expectedPlanHash) throw new EnemyImportStaleError();

        const created = await insertStagedAssets(tx, staged, { actor, details: { source: 'enemy_package_import', requestId: request.requestId } });
        const assetIdOf = (d: EnemySlotDestination) =>
          d.kind === 'reuse' ? d.assetId : d.kind === 'create' ? created.get(d.asset)!.id : null;
        const result: Omit<EnemyImportResult, 'importId' | 'replayed'> = {
          requestId: request.requestId,
          created: [],
          updated: [],
          skipped: [],
          unchanged: [],
          assets: {
            created: staged.map((s) => ({ asset: s.entry.id, assetId: s.assetId, category: s.entry.category })),
            reused: [],
          },
        };
        const reused = new Map<string, string>();
        for (const p of locked.planned) {
          if (!writes(p)) {
            (p.outcome === 'unchanged' ? result.unchanged : result.skipped).push(p.key);
            continue;
          }
          for (const slot of ENEMY_ARTWORK_SLOTS) {
            const d = p[slot].destination;
            if (d.kind === 'reuse') reused.set(d.asset, d.assetId);
          }
          await deps.enemies.applyImported(
            tx,
            {
              definition: p.definition,
              artworkAssetId: assetIdOf(p.artwork.destination),
              spriteAssetId: assetIdOf(p.sprite.destination),
              expectedRevision: p.row ? p.row.revision : null,
            },
            actor,
          );
          (p.outcome === 'create' ? result.created : result.updated).push(p.key);
        }
        result.assets.reused = [...reused].map(([asset, assetId]) => ({ asset, assetId }));
        await deps.faults?.beforeCommit?.(tx);
        await tx
          .update(enemyPackageImports)
          .set({ status: 'applied', result: result as unknown as Record<string, unknown>, finishedAt: now() })
          .where(eq(enemyPackageImports.id, row.id));
        return { ...result, importId: row.id, replayed: false };
      });
    } catch (err) {
      try {
        await removeUnclaimedStagedFiles(db, storage, staged.map((s) => s.storageKey));
        await db
          .update(enemyPackageImports)
          .set({ status: 'failed', finishedAt: now(), error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500) })
          .where(and(eq(enemyPackageImports.id, row.id), eq(enemyPackageImports.status, 'staged')));
      } catch (cleanupErr) {
        // The row stays `staged`; recovery removes the files later.
        deps.logger?.warn({ tag: 'enemy-package/cleanup', requestId: request.requestId, err: cleanupErr }, 'could not clean up a failed enemy import');
      }
      throw err;
    }
  }

  async function recoverInterruptedImports(opts: { olderThanMs?: number } = {}) {
    const cutoff = new Date(now().getTime() - (opts.olderThanMs ?? ENEMY_IMPORT_RECOVERY_AGE_MS));
    const stale = await db
      .select()
      .from(enemyPackageImports)
      .where(and(eq(enemyPackageImports.status, 'staged'), lt(enemyPackageImports.createdAt, cutoff)));
    let removedFiles = 0;
    let abandoned = 0;
    for (const row of stale) {
      const removed = await removeUnclaimedStagedFiles(db, storage, row.stagedStorageKeys);
      removedFiles += removed.length;
      const [marked] = await db
        .update(enemyPackageImports)
        .set({ status: 'abandoned', finishedAt: now(), error: `interrupted; ${removed.length} staged file(s) removed` })
        .where(and(eq(enemyPackageImports.id, row.id), eq(enemyPackageImports.status, 'staged')))
        .returning({ id: enemyPackageImports.id });
      if (marked) abandoned += 1;
    }
    if (abandoned > 0) deps.logger?.info?.({ tag: 'enemy-package/recovery', abandoned, removedFiles }, 'recovered interrupted enemy imports');
    return { abandoned, removedFiles };
  }

  return {
    exportPackage,
    async preview(archive) {
      const pkg = await parseEnemyPackage(archive);
      return (await plan(db, pkg, false)).preview;
    },
    apply,
    recoverInterruptedImports,
  };
}
