/**
 * Enemy Catalogue packages (Content Portability CP-3): a ZIP that moves
 * standalone enemies **with their artwork bytes** from one environment to
 * another, with no dungeon or Combat Trial involved.
 *
 *     enemy-package.zip
 *     ├── manifest.json     package identity, per-enemy artwork bindings, asset entries
 *     ├── enemies.json      a `waifumon-combat-enemies` v1 document (the Git/JSON export shape)
 *     └── artwork/
 *         ├── asset-001.webp
 *         └── asset-002.png
 *
 * Identities are portable: enemies by `key`, artwork by a package-local
 * `asset-NNN` whose `(category, sha256)` and bytes are declared and verified.
 * No asset id, storage key, URL or host path from the exporting environment
 * appears anywhere.
 *
 * Each enemy has two artwork **slots** — `artwork` (full art) and `sprite` —
 * and each slot has two layers, exactly as the catalogue renders them
 * (`resolveEnemyVisual`):
 *
 *   - `managed`: the uploaded override, as an asset entry;
 *   - `shipped`: the definition's relative `artworkPath` / `spriteArtworkPath`
 *     under `ASSETS_DIR`, with its bytes as an asset entry so a destination
 *     that lacks the file can still show it.
 *
 * Pure apart from image inspection: parse validates everything, including
 * every image's bytes, before an importer looks at the destination.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EnemyPackageInvalidError, type EnemyPackageIssue } from '../../shared/errors';
import {
  BUNDLE_ARTWORK_DIR,
  BUNDLE_ASSET_ID_PATTERN,
  BundleAssetEntrySchema,
  bundleEntryIssues,
  verifyBundleAsset,
  type BundleAssetEntry,
} from '../artworkAssets/package/artworkBundle';
import { readZip, writeZip, ZipArchiveError } from '../artworkAssets/package/zipArchive';
import { ARTWORK_UPLOAD_MAX_BYTES, type InspectedImage } from '../artworkAssets/imageInspection';
import {
  COMBAT_ENEMY_FILE_FORMAT,
  COMBAT_ENEMY_FILE_VERSION,
  CombatEnemyFileSchema,
  type CombatEnemyDefinition,
} from '../combat/enemyDefinitions';
import { canonicalJson } from '../rewardTables/rewardTableCore';

export const ENEMY_PACKAGE_FORMAT = 'waifumon-enemy-package' as const;
export const ENEMY_PACKAGE_VERSION = 1 as const;
export const ENEMY_PACKAGE_CONTENT_TYPE = 'enemy_catalogue' as const;
export const ENEMY_PACKAGE_MANIFEST_FILE = 'manifest.json';
export const ENEMY_PACKAGE_ENEMIES_FILE = 'enemies.json';

/**
 * One set of limits for export and import, so whatever exports imports.
 * An enemy has at most four images (full art and sprite, managed and
 * shipped); shipped enemy art is ~0.2–0.5 MB and an upload at most 8 MB.
 */
export const ENEMY_PACKAGE_LIMITS = {
  maxEnemies: 250,
  maxAssets: 500,
  /** The ZIP itself — and the import routes' request-body limit. */
  maxArchiveBytes: 48 * 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxJsonBytes: 2 * 1024 * 1024,
  maxJsonDepth: 32,
  maxImageBytes: ARTWORK_UPLOAD_MAX_BYTES,
  maxCompressionRatio: 100,
} as const;

/** The two artwork roles, and the category a shipped file becomes when bound as managed artwork. */
export const ENEMY_ARTWORK_SLOTS = ['artwork', 'sprite'] as const;
export type EnemyArtworkSlot = (typeof ENEMY_ARTWORK_SLOTS)[number];
export const ENEMY_SLOT_CATEGORY = { artwork: 'enemy_art', sprite: 'enemy_sprite' } as const;

const assetRef = z.string().regex(BUNDLE_ASSET_ID_PATTERN);
const SlotBindingSchema = z
  .object({
    /** The managed override's bytes, or null for none. */
    managed: assetRef.nullable(),
    /** The definition's shipped path and, when it could be carried, its bytes. */
    shipped: z.object({ path: z.string().max(300), asset: assetRef.nullable() }).strict().nullable(),
  })
  .strict();
export type EnemySlotBinding = z.infer<typeof SlotBindingSchema>;

const ManifestSchema = z
  .object({
    format: z.literal(ENEMY_PACKAGE_FORMAT),
    version: z.literal(ENEMY_PACKAGE_VERSION),
    contentType: z.literal(ENEMY_PACKAGE_CONTENT_TYPE),
    exportedAt: z.string().datetime(),
    scope: z.enum(['all', 'selected']),
    /** Diagnostics only: never used to resolve anything. */
    source: z.object({ environment: z.string().max(64) }).strict(),
    enemies: z
      .array(z.object({ key: z.string().max(64), artwork: SlotBindingSchema, sprite: SlotBindingSchema }).strict())
      .max(ENEMY_PACKAGE_LIMITS.maxEnemies),
    assets: z.array(BundleAssetEntrySchema).max(ENEMY_PACKAGE_LIMITS.maxAssets),
    /** What the exporter could not carry (a missing fallback, a disabled override). Informational. */
    warnings: z.array(z.object({ key: z.string().max(64), slot: z.enum(ENEMY_ARTWORK_SLOTS), message: z.string().max(300) }).strict()).max(1000),
  })
  .strict();
export type EnemyPackageManifest = z.infer<typeof ManifestSchema>;

/** A package as read: validated, every image inspected. */
export interface EnemyPackage {
  manifest: EnemyPackageManifest;
  definitions: CombatEnemyDefinition[];
  /** Asset entries by id, with their verified bytes. */
  assets: Map<string, { entry: BundleAssetEntry; data: Buffer; image: InspectedImage }>;
  /** sha256 over the canonical manifest and definitions; the bytes are bound by the manifest's hashes. */
  packageHash: string;
}

export function enemyPackageHash(manifest: EnemyPackageManifest, definitions: readonly CombatEnemyDefinition[]): string {
  return createHash('sha256').update(canonicalJson({ manifest, definitions })).digest('hex');
}

function jsonDepth(value: unknown, limit: number, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth;
  let max = depth + 1;
  for (const child of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, jsonDepth(child, limit, depth + 1));
    if (max > limit) return max;
  }
  return max;
}

/** A JSON member of a package: strict UTF-8, nesting bounded (dungeon bundles reuse this). */
export function parsePackageJsonFile(
  name: string,
  data: Buffer | undefined,
  issues: EnemyPackageIssue[],
  maxDepth: number = ENEMY_PACKAGE_LIMITS.maxJsonDepth,
): unknown {
  if (!data) {
    issues.push({ path: name, message: 'is missing from the package' });
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    issues.push({ path: name, message: 'is not valid UTF-8 JSON' });
    return undefined;
  }
  if (jsonDepth(value, maxDepth) > maxDepth) {
    issues.push({ path: name, message: `nests deeper than ${maxDepth} levels` });
    return undefined;
  }
  return value;
}

const zodIssues = (file: string, error: z.ZodError): EnemyPackageIssue[] =>
  error.issues.slice(0, 50).map((i) => ({ path: [file, ...i.path].join('.'), message: i.message }));

/**
 * Read and validate an uploaded package completely: archive safety, both
 * JSON documents, the bindings' consistency with the definitions, and every
 * image's bytes against its declared hash, size, type and dimensions.
 *
 * @throws {EnemyPackageInvalidError} listing every problem found.
 */
export async function parseEnemyPackage(archive: Buffer): Promise<EnemyPackage> {
  const L = ENEMY_PACKAGE_LIMITS;
  let files: Map<string, Buffer>;
  try {
    const entries = readZip(archive, {
      maxArchiveBytes: L.maxArchiveBytes,
      maxEntries: L.maxAssets + 3,
      maxExpandedBytes: L.maxExpandedBytes,
      maxCompressionRatio: L.maxCompressionRatio,
      maxEntryBytes: (name) =>
        name === ENEMY_PACKAGE_MANIFEST_FILE || name === ENEMY_PACKAGE_ENEMIES_FILE
          ? L.maxJsonBytes
          : name.startsWith(BUNDLE_ARTWORK_DIR) && !name.slice(BUNDLE_ARTWORK_DIR.length).includes('/')
            ? L.maxImageBytes
            : null,
      allowDirectory: (name) => name === BUNDLE_ARTWORK_DIR,
    });
    files = new Map(entries.map((e) => [e.name, e.data]));
  } catch (err) {
    if (err instanceof ZipArchiveError) throw new EnemyPackageInvalidError([{ path: 'archive', message: err.message }]);
    throw err;
  }

  const issues: EnemyPackageIssue[] = [];
  const rawManifest = parsePackageJsonFile(ENEMY_PACKAGE_MANIFEST_FILE, files.get(ENEMY_PACKAGE_MANIFEST_FILE), issues);
  const rawEnemies = parsePackageJsonFile(ENEMY_PACKAGE_ENEMIES_FILE, files.get(ENEMY_PACKAGE_ENEMIES_FILE), issues);
  if (issues.length > 0) throw new EnemyPackageInvalidError(issues);
  return readEnemyPackageDocuments(rawManifest, rawEnemies, files, { standalone: true });
}

/**
 * Validate an enemy manifest and its definitions against the archive's files:
 * bindings, asset entries and every image's bytes. A standalone package also
 * declares every file in its archive; a dungeon bundle embeds these documents
 * (with `paths` saying where they sit) and declares its own files itself.
 *
 * @throws {EnemyPackageInvalidError} listing every problem found.
 */
export async function readEnemyPackageDocuments(
  rawManifest: unknown,
  rawEnemies: unknown,
  files: ReadonlyMap<string, Buffer>,
  opts: {
    standalone: boolean;
    paths?: { manifest: string; enemies: string };
    /** Assets the caller already verified (a dungeon bundle checks every image once). */
    verified?: ReadonlyMap<string, { data: Buffer; image: InspectedImage }>;
  },
): Promise<EnemyPackage> {
  const L = ENEMY_PACKAGE_LIMITS;
  const MANIFEST = opts.paths?.manifest ?? ENEMY_PACKAGE_MANIFEST_FILE;
  const ENEMIES = opts.paths?.enemies ?? ENEMY_PACKAGE_ENEMIES_FILE;
  /** Issue paths into the manifest: `manifest.*` for a standalone package, as CP-3 always reported them. */
  const IN_MANIFEST = opts.paths?.manifest ?? 'manifest';
  const issues: EnemyPackageIssue[] = [];
  const manifestResult = ManifestSchema.safeParse(rawManifest);
  if (!manifestResult.success) issues.push(...zodIssues(MANIFEST, manifestResult.error));
  const enemiesResult = CombatEnemyFileSchema.safeParse(rawEnemies);
  if (!enemiesResult.success) issues.push(...zodIssues(ENEMIES, enemiesResult.error));
  if (!manifestResult.success || !enemiesResult.success) throw new EnemyPackageInvalidError(issues);
  const manifest = manifestResult.data;
  const definitions = enemiesResult.data.enemies;

  if (definitions.length > L.maxEnemies) issues.push({ path: ENEMIES, message: `holds more than ${L.maxEnemies} enemies` });
  if (definitions.length === 0) issues.push({ path: ENEMIES, message: 'holds no enemies' });
  const keys = definitions.map((d) => d.key);
  if (manifest.enemies.map((e) => e.key).join('\n') !== keys.join('\n')) {
    issues.push({ path: `${IN_MANIFEST}.enemies`, message: `must list exactly the enemies in ${ENEMIES}, in the same order` });
  }
  for (const message of bundleEntryIssues(manifest.assets)) issues.push({ path: `${IN_MANIFEST}.assets`, message });

  // Every archive entry is declared; every declared file is present.
  const entries = new Map(manifest.assets.map((a) => [a.id, a]));
  if (opts.standalone) {
    const declared = new Set([ENEMY_PACKAGE_MANIFEST_FILE, ENEMY_PACKAGE_ENEMIES_FILE, ...manifest.assets.map((a) => a.file)]);
    for (const name of files.keys()) if (!declared.has(name)) issues.push({ path: name, message: 'is not declared in the manifest' });
  }

  // Bindings agree with the definitions, and every entry is used.
  const used = new Set<string>();
  manifest.enemies.forEach((binding, i) => {
    const definition = definitions[i];
    if (!definition || definition.key !== binding.key) return;
    for (const slot of ENEMY_ARTWORK_SLOTS) {
      const path = `manifest.enemies[${i}].${slot}`;
      const b = binding[slot];
      const authored = slot === 'artwork' ? definition.artworkPath : definition.spriteArtworkPath;
      if ((b.shipped?.path ?? null) !== authored) issues.push({ path: `${path}.shipped`, message: `must name the definition's path (${authored ?? 'none'})` });
      if (b.shipped && b.managed === null && b.shipped.asset === null) {
        issues.push({ path: `${path}.shipped.asset`, message: 'shipped artwork with no managed override must be carried' });
      }
      for (const ref of [b.managed, b.shipped?.asset ?? null]) {
        if (ref === null) continue;
        if (!entries.has(ref)) issues.push({ path, message: `names asset "${ref}", which the manifest does not declare` });
        used.add(ref);
      }
      const shipped = b.shipped?.asset ? entries.get(b.shipped.asset) : undefined;
      if (shipped && shipped.category !== ENEMY_SLOT_CATEGORY[slot]) {
        issues.push({ path: `${path}.shipped.asset`, message: `shipped ${slot} artwork must be declared as ${ENEMY_SLOT_CATEGORY[slot]}` });
      }
    }
  });
  for (const entry of manifest.assets) if (!used.has(entry.id)) issues.push({ path: `${IN_MANIFEST}.assets`, message: `asset "${entry.id}" is not used by any enemy` });
  if (issues.length > 0) throw new EnemyPackageInvalidError(issues);

  // Last, the expensive part: every image's actual bytes.
  const assets: EnemyPackage['assets'] = new Map();
  for (const entry of manifest.assets) {
    const known = opts.verified?.get(entry.id);
    if (known) {
      assets.set(entry.id, { entry, data: known.data, image: known.image });
      continue;
    }
    const data = files.get(entry.file);
    const verified = await verifyBundleAsset(entry, data);
    if ('issue' in verified) issues.push({ path: entry.file, message: verified.issue });
    else assets.set(entry.id, { entry, data: data!, image: verified.image });
  }
  if (issues.length > 0) throw new EnemyPackageInvalidError(issues);

  return { manifest, definitions, assets, packageHash: enemyPackageHash(manifest, definitions) };
}

/** The ZIP for a manifest, its definitions and the asset bytes by archive path. */
export function buildEnemyPackageArchive(
  manifest: EnemyPackageManifest,
  definitions: readonly CombatEnemyDefinition[],
  files: ReadonlyMap<string, Buffer>,
): Buffer {
  const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return writeZip([
    { name: ENEMY_PACKAGE_MANIFEST_FILE, data: json(manifest), compress: true },
    {
      name: ENEMY_PACKAGE_ENEMIES_FILE,
      data: json({ format: COMBAT_ENEMY_FILE_FORMAT, version: COMBAT_ENEMY_FILE_VERSION, enemies: definitions }),
      compress: true,
    },
    ...manifest.assets.map((entry) => ({ name: entry.file, data: files.get(entry.file)! })),
  ]);
}
