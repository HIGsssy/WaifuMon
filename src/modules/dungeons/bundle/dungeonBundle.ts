/**
 * Complete Dungeon Bundles (Content Portability CP-4B): one ZIP that moves an
 * authored dungeon from staging to production **with the artwork and the
 * transferable dependencies it needs**, so the destination needs no access to
 * the source's database, artwork storage or filesystem.
 *
 *     <key>.<hash>.bundle.zip
 *     ├── manifest.json            waifumon-dungeon-bundle v1: bindings and asset entries
 *     ├── dungeon.json             the existing waifumon-dungeon-package (v1–v4), unchanged
 *     ├── enemies/manifest.json    a CP-3 enemy manifest (only when the dungeon names enemies)
 *     ├── enemies/enemies.json     the CP-3 waifumon-combat-enemies v1 document
 *     ├── pools.json               waifumon-dungeon-species-pools v1 (only for referenced shared pools)
 *     └── artwork/asset-NNN.webp   bytes, one per distinct (category, sha256)
 *
 * The archive is a *wrapper*: `dungeon.json` is exactly the JSON package a
 * Dungeon JSON export writes and keeps its own version and semantics. The
 * wrapper adds what that file cannot hold:
 *
 *   - `artwork`: for every artwork reference the dungeon makes (cover,
 *     backgrounds, room backgrounds, reachable event art), the bytes it means;
 *   - `sceneSprites`: the catalogue definition of every placed Scene Sprite
 *     and its bytes — the frozen revision visuals for a revision export, the
 *     current catalogue for a draft;
 *   - the CP-3 enemy documents for every enemy any wave can field, with their
 *     full art and sprites;
 *   - the portable definition of every referenced shared WaifuMon pool.
 *
 * Species, items, equipment, currencies, regions and legacy reward tables are
 * **external prerequisites**: referenced by key, checked on the destination,
 * never created by an import.
 *
 * Identity is portable throughout: dungeons, enemies, sprites and pools by
 * stable key; artwork by a package-local `asset-NNN` with its declared and
 * verified `(category, sha256)`. No asset id, storage key, URL or host path
 * from the exporting environment appears anywhere.
 *
 * Parsing reuses CP-3's bounded ZIP reader, image verification and enemy
 * document validation, and the dungeon importer's own package reader (with
 * its nesting and node bounds). Everything — including every image's bytes —
 * is validated before an importer looks at the destination.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DungeonBundleInvalidError, type DungeonBundleIssue, EnemyPackageInvalidError } from '../../../shared/errors';
import { ARTWORK_UPLOAD_MAX_BYTES, type InspectedImage } from '../../artworkAssets/imageInspection';
import {
  BUNDLE_ARTWORK_DIR,
  BUNDLE_ASSET_ID_PATTERN,
  BundleAssetEntrySchema,
  bundleEntryIssues,
  verifyBundleAsset,
  type BundleAssetEntry,
} from '../../artworkAssets/package/artworkBundle';
import { readZip, writeZip, ZipArchiveError } from '../../artworkAssets/package/zipArchive';
import { SpritePlacementSchema } from '../../artworkAssets/scenePlacement';
import { COMBAT_ENEMY_FILE_FORMAT, COMBAT_ENEMY_FILE_VERSION, type CombatEnemyDefinition } from '../../combat/enemyDefinitions';
import {
  ENEMY_PACKAGE_LIMITS,
  parsePackageJsonFile,
  readEnemyPackageDocuments,
  type EnemyPackage,
  type EnemyPackageManifest,
} from '../../enemies/enemyPackage';
import { canonicalJson } from '../../rewardTables/rewardTableCore';
import {
  DungeonArtworkRefSchema,
  dungeonDependencies,
  type DungeonArtworkRef,
  type DungeonDefinition,
} from '../content/dungeonDefinition';
import { packagedEnemyHash, serializeDungeonPackage, type DungeonPackage } from '../package/dungeonPackage';
import { importHash, readImportPackage } from '../package/dungeonImportService';
import {
  SCENE_SPRITE_CATEGORIES,
  SCENE_SPRITE_LAYERS,
  SceneSpriteKeySchema,
  sceneSpriteKeys,
} from '../sceneSprites/sceneSpriteDefinition';
import { SharedPoolPackageSchema, sharedPoolKeys, type SharedPoolDefinition } from '../sharedPools/sharedPoolDefinition';

export const DUNGEON_BUNDLE_FORMAT = 'waifumon-dungeon-bundle' as const;
export const DUNGEON_BUNDLE_VERSION = 1 as const;
export const DUNGEON_BUNDLE_CONTENT_TYPE = 'dungeon' as const;
export const BUNDLE_MANIFEST_FILE = 'manifest.json';
export const BUNDLE_DUNGEON_FILE = 'dungeon.json';
export const BUNDLE_ENEMY_DIR = 'enemies/';
export const BUNDLE_ENEMY_MANIFEST_FILE = 'enemies/manifest.json';
export const BUNDLE_ENEMY_DEFINITIONS_FILE = 'enemies/enemies.json';
export const BUNDLE_POOLS_FILE = 'pools.json';
const JSON_FILES = [BUNDLE_MANIFEST_FILE, BUNDLE_DUNGEON_FILE, BUNDLE_ENEMY_MANIFEST_FILE, BUNDLE_ENEMY_DEFINITIONS_FILE, BUNDLE_POOLS_FILE];

/**
 * One set of limits for export and import, so whatever exports imports.
 * Larger than an enemy package (a dungeon carries its enemies *and* its
 * backgrounds, event art and sprites), smaller than anything that would need
 * streaming: the whole archive is held in memory per request.
 */
export const DUNGEON_BUNDLE_LIMITS = {
  /** The ZIP itself — and the import routes' request-body limit. */
  maxArchiveBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 96 * 1024 * 1024,
  maxAssets: 600,
  maxImageBytes: ARTWORK_UPLOAD_MAX_BYTES,
  /** Each JSON member; `dungeon.json` matches the Dungeon JSON import route's 2 MiB. */
  maxJsonBytes: 2 * 1024 * 1024,
  maxTotalJsonBytes: 6 * 1024 * 1024,
  /** `dungeon.json` keeps the dungeon importer's own depth; the other members CP-3's. */
  maxDungeonJsonDepth: 64,
  maxJsonDepth: ENEMY_PACKAGE_LIMITS.maxJsonDepth,
  maxCompressionRatio: 100,
  maxEnemies: ENEMY_PACKAGE_LIMITS.maxEnemies,
  maxSceneSprites: 200,
  maxSharedPools: 100,
} as const;

const assetRef = z.string().regex(BUNDLE_ASSET_ID_PATTERN);

/** A Scene Sprite as it travels: the catalogue definition, minus its environment-local asset id. */
export const BundleSceneSpriteSchema = z
  .object({
    key: SceneSpriteKeySchema,
    name: z.string().trim().min(1).max(100),
    /** Catalogue grouping. Not part of a revision's frozen visuals, so null for revision exports. */
    category: z.enum(SCENE_SPRITE_CATEGORIES).nullable(),
    placement: SpritePlacementSchema,
    mirror: z.boolean(),
    visualLayer: z.enum(SCENE_SPRITE_LAYERS),
    asset: assetRef,
  })
  .strict();
export type BundleSceneSprite = z.infer<typeof BundleSceneSpriteSchema>;

export const DungeonBundleManifestSchema = z
  .object({
    format: z.literal(DUNGEON_BUNDLE_FORMAT),
    version: z.literal(DUNGEON_BUNDLE_VERSION),
    contentType: z.literal(DUNGEON_BUNDLE_CONTENT_TYPE),
    exportedAt: z.string().datetime(),
    /** Diagnostics only: never used to resolve anything. */
    source: z
      .object({
        environment: z.string().max(64),
        dungeonKey: z.string().min(1).max(100),
        origin: z.enum(['draft', 'revision']),
        draftRevision: z.number().int().min(1).nullable(),
        publishedRevision: z.number().int().min(1).nullable(),
      })
      .strict(),
    dungeonPackage: z
      .object({
        file: z.literal(BUNDLE_DUNGEON_FILE),
        schemaVersion: z.number().int().min(1).max(4),
        contentHash: z.string().max(80),
        /** `importHash` of the parsed package — the identity the dungeon importer records. */
        packageHash: z.string().max(80),
      })
      .strict(),
    /** One per artwork reference the dungeon makes, in `dungeonDependencies` order. */
    artwork: z.array(z.object({ ref: DungeonArtworkRefSchema, asset: assetRef }).strict()).max(2000),
    sceneSprites: z
      .object({
        /** `catalogue`: a draft's current sprites. `revision_snapshot`: the revision's frozen visuals. */
        evidence: z.enum(['catalogue', 'revision_snapshot']),
        snapshotHash: z.string().max(80).nullable(),
        sprites: z.array(BundleSceneSpriteSchema).max(DUNGEON_BUNDLE_LIMITS.maxSceneSprites),
      })
      .strict()
      .nullable(),
    enemies: z.object({ manifest: z.literal(BUNDLE_ENEMY_MANIFEST_FILE), definitions: z.literal(BUNDLE_ENEMY_DEFINITIONS_FILE) }).strict().nullable(),
    sharedPools: z.object({ file: z.literal(BUNDLE_POOLS_FILE), keys: z.array(z.string().max(100)).max(DUNGEON_BUNDLE_LIMITS.maxSharedPools) }).strict().nullable(),
    assets: z.array(BundleAssetEntrySchema).max(DUNGEON_BUNDLE_LIMITS.maxAssets),
    /** What the exporter noted but did not need to carry (an enemy's unused fallback, say). Informational. */
    warnings: z.array(z.object({ path: z.string().max(200), message: z.string().max(400) }).strict()).max(1000),
  })
  .strict();
export type DungeonBundleManifest = z.infer<typeof DungeonBundleManifestSchema>;

/** A bundle as read: every member validated, every image inspected. */
export interface DungeonBundle {
  manifest: DungeonBundleManifest;
  /** The JSON package, read with the Scene Sprite gate lifted (the bundle carries the sprites). */
  pkg: DungeonPackage;
  enemies: EnemyPackage | null;
  pools: SharedPoolDefinition[];
  assets: Map<string, { entry: BundleAssetEntry; data: Buffer; image: InspectedImage }>;
  /** sha256 over every JSON member, canonical; the bytes are bound by the manifest's hashes. */
  bundleHash: string;
}

export function dungeonBundleHash(parts: {
  manifest: DungeonBundleManifest;
  pkg: DungeonPackage;
  enemies: { manifest: EnemyPackageManifest; definitions: readonly CombatEnemyDefinition[] } | null;
  pools: readonly SharedPoolDefinition[];
}): string {
  return `sha256:${createHash('sha256').update(canonicalJson(parts)).digest('hex')}`;
}

// ── artwork roles ───────────────────────────────────────────────────────────

const artworkKey = (ref: DungeonArtworkRef) => (ref.kind === 'shipped' ? `shipped:${ref.path}` : `managed:${ref.category}:${ref.contentHash}`);

/**
 * The managed category a shipped dungeon image becomes when the destination
 * lacks the file: `dungeon_zone` when it is only ever the dungeon's cover,
 * otherwise `dungeon_background` (the category the editor uploads room, dungeon
 * and event backgrounds under).
 */
export function shippedDungeonArtworkCategory(definition: DungeonDefinition, path: string): 'dungeon_zone' | 'dungeon_background' {
  const is = (ref: DungeonArtworkRef | null | undefined) => ref?.kind === 'shipped' && ref.path === path;
  const background =
    is(definition.background) ||
    definition.rooms.some((room) => is(room.background)) ||
    (definition.events ?? []).some((event) => is(event.artwork));
  return background || !is(definition.artwork) ? 'dungeon_background' : 'dungeon_zone';
}

/** The definition with every listed shipped image replaced by its managed copy. Pure. */
export function rebindShippedArtwork(
  definition: DungeonDefinition,
  managed: ReadonlyMap<string, Extract<DungeonArtworkRef, { kind: 'managed' }>>,
): DungeonDefinition {
  if (managed.size === 0) return definition;
  const swap = <T extends DungeonArtworkRef | null | undefined>(ref: T): T =>
    (ref?.kind === 'shipped' && managed.has(ref.path) ? { ...managed.get(ref.path)! } : ref) as T;
  return {
    ...definition,
    artwork: swap(definition.artwork),
    background: swap(definition.background),
    rooms: definition.rooms.map((room) => ({ ...room, background: swap(room.background) })),
    ...(definition.events ? { events: definition.events.map((event) => ({ ...event, artwork: swap(event.artwork) })) } : {}),
  };
}

/** The definition with each Scene Sprite instance of a copied sprite pointed at its new key. Pure. */
export function rekeySceneSprites(definition: DungeonDefinition, keys: ReadonlyMap<string, string>): DungeonDefinition {
  if (keys.size === 0) return definition;
  const rekey = <T extends { spriteKey: string }>(list: readonly T[] | undefined): T[] | undefined =>
    list?.map((instance) => (keys.has(instance.spriteKey) ? { ...instance, spriteKey: keys.get(instance.spriteKey)! } : instance));
  return {
    ...definition,
    rooms: definition.rooms.map((room) => {
      const sprites = rekey(room.sceneSprites);
      return {
        ...room,
        ...(sprites ? { sceneSprites: sprites } : {}),
        actions: room.actions.map((action) => {
          const own = rekey((action as { sceneSprites?: { spriteKey: string }[] }).sceneSprites);
          return (own ? { ...action, sceneSprites: own } : action) as typeof action;
        }),
      };
    }),
  };
}

// ── read ────────────────────────────────────────────────────────────────────

/**
 * Read and validate an uploaded bundle completely: archive safety, every JSON
 * member, the dungeon package (with its own integrity checks), that the
 * manifest covers exactly the artwork, sprites, enemies and shared pools the
 * dungeon needs, and every image's bytes against its declared hash, size, type
 * and dimensions.
 *
 * @throws {DungeonBundleInvalidError} listing every problem found.
 */
export async function parseDungeonBundle(archive: Buffer): Promise<DungeonBundle> {
  const L = DUNGEON_BUNDLE_LIMITS;
  let files: Map<string, Buffer>;
  try {
    const entries = readZip(archive, {
      maxArchiveBytes: L.maxArchiveBytes,
      maxEntries: L.maxAssets + JSON_FILES.length + 2,
      maxExpandedBytes: L.maxExpandedBytes,
      maxCompressionRatio: L.maxCompressionRatio,
      maxEntryBytes: (name) =>
        JSON_FILES.includes(name)
          ? L.maxJsonBytes
          : name.startsWith(BUNDLE_ARTWORK_DIR) && !name.slice(BUNDLE_ARTWORK_DIR.length).includes('/')
            ? L.maxImageBytes
            : null,
      allowDirectory: (name) => name === BUNDLE_ARTWORK_DIR || name === BUNDLE_ENEMY_DIR,
    });
    files = new Map(entries.map((e) => [e.name, e.data]));
  } catch (err) {
    if (err instanceof ZipArchiveError) throw new DungeonBundleInvalidError([{ path: 'archive', message: err.message }]);
    throw err;
  }

  const issues: DungeonBundleIssue[] = [];
  const fail = (): never => {
    throw new DungeonBundleInvalidError(issues);
  };
  const jsonBytes = JSON_FILES.reduce((sum, name) => sum + (files.get(name)?.length ?? 0), 0);
  if (jsonBytes > L.maxTotalJsonBytes) issues.push({ path: 'archive', message: `its JSON members total more than ${L.maxTotalJsonBytes} bytes` });
  const rawManifest = parsePackageJsonFile(BUNDLE_MANIFEST_FILE, files.get(BUNDLE_MANIFEST_FILE), issues);
  const rawPackage = parsePackageJsonFile(BUNDLE_DUNGEON_FILE, files.get(BUNDLE_DUNGEON_FILE), issues, L.maxDungeonJsonDepth);
  if (issues.length) fail();
  const manifestResult = DungeonBundleManifestSchema.safeParse(rawManifest);
  if (!manifestResult.success) {
    issues.push(...manifestResult.error.issues.slice(0, 50).map((i) => ({ path: [BUNDLE_MANIFEST_FILE, ...i.path].join('.'), message: i.message })));
    fail();
  }
  const manifest = manifestResult.data!;

  // The dungeon package, by the importer's own reader — Scene Sprites allowed, since the bundle carries them.
  const read = readImportPackage(rawPackage, { allowSceneSprites: true });
  for (const issue of read.issues.filter((i) => i.severity === 'error')) issues.push({ path: `${BUNDLE_DUNGEON_FILE}${issue.path ? `.${issue.path}` : ''}`, message: issue.message });
  if (!read.package || !read.ok) fail();
  const pkg = read.package!;
  const definition = pkg.dungeon;
  if (manifest.source.dungeonKey !== definition.key) issues.push({ path: 'manifest.source.dungeonKey', message: `says "${manifest.source.dungeonKey}" but the dungeon inside is "${definition.key}"` });
  if (manifest.dungeonPackage.schemaVersion !== pkg.schemaVersion || manifest.dungeonPackage.contentHash !== pkg.contentHash || manifest.dungeonPackage.packageHash !== importHash(pkg))
    issues.push({ path: 'manifest.dungeonPackage', message: 'does not describe the dungeon.json inside: the bundle was edited after it was exported' });

  for (const message of bundleEntryIssues(manifest.assets)) issues.push({ path: 'manifest.assets', message });
  const entries = new Map(manifest.assets.map((a) => [a.id, a]));
  const used = new Set<string>();
  const use = (path: string, ref: string) => {
    if (!entries.has(ref)) issues.push({ path, message: `names asset "${ref}", which the manifest does not declare` });
    used.add(ref);
    return entries.get(ref);
  };

  // Artwork: exactly the references the dungeon makes, each with matching bytes.
  const wanted = dungeonDependencies(definition).artwork;
  if (canonicalJson(manifest.artwork.map((a) => a.ref)) !== canonicalJson(wanted))
    issues.push({ path: 'manifest.artwork', message: 'must list exactly the artwork the dungeon references, in order' });
  manifest.artwork.forEach((binding, i) => {
    const entry = use(`manifest.artwork[${i}]`, binding.asset);
    if (!entry) return;
    const expected = binding.ref.kind === 'managed' ? binding.ref.category : shippedDungeonArtworkCategory(definition, binding.ref.path);
    if (entry.category !== expected) issues.push({ path: `manifest.artwork[${i}]`, message: `${artworkKey(binding.ref)} must be carried as ${expected} artwork` });
    if (binding.ref.kind === 'managed' && entry.sha256 !== binding.ref.contentHash)
      issues.push({ path: `manifest.artwork[${i}]`, message: `the carried bytes are not the image the dungeon names (${binding.ref.contentHash.slice(0, 12)}…)` });
  });

  // Scene Sprites: one definition per placed key.
  const spriteKeys = sceneSpriteKeys(definition);
  const sprites = manifest.sceneSprites?.sprites ?? [];
  if (spriteKeys.length && !manifest.sceneSprites) issues.push({ path: 'manifest.sceneSprites', message: 'the dungeon places Scene Sprites, so their definitions must be carried' });
  if (canonicalJson(sprites.map((s) => s.key)) !== canonicalJson(spriteKeys))
    issues.push({ path: 'manifest.sceneSprites.sprites', message: `must define exactly the placed sprites (${spriteKeys.join(', ') || 'none'}), sorted by key` });
  sprites.forEach((sprite, i) => use(`manifest.sceneSprites.sprites[${i}]`, sprite.asset));
  if (manifest.sceneSprites && !spriteKeys.length) issues.push({ path: 'manifest.sceneSprites', message: 'the dungeon places no Scene Sprites' });
  if (manifest.sceneSprites && (manifest.sceneSprites.evidence === 'revision_snapshot') !== (pkg.source.origin === 'revision'))
    issues.push({ path: 'manifest.sceneSprites.evidence', message: 'a revision export carries its frozen sprite visuals; a draft export its current catalogue sprites' });

  // Shared pools: the portable definition of each referenced key.
  const poolKeys = sharedPoolKeys(definition);
  let pools: SharedPoolDefinition[] = [];
  if (poolKeys.length || manifest.sharedPools) {
    if (!manifest.sharedPools || canonicalJson(manifest.sharedPools.keys) !== canonicalJson(poolKeys))
      issues.push({ path: 'manifest.sharedPools', message: `must carry exactly the shared pools the dungeon references (${poolKeys.join(', ') || 'none'})` });
    const rawPools = parsePackageJsonFile(BUNDLE_POOLS_FILE, files.get(BUNDLE_POOLS_FILE), issues);
    const parsed = SharedPoolPackageSchema.safeParse(rawPools);
    if (rawPools !== undefined && !parsed.success)
      issues.push(...parsed.error.issues.slice(0, 50).map((i) => ({ path: [BUNDLE_POOLS_FILE, ...i.path].join('.'), message: i.message })));
    if (parsed.success) {
      pools = [...parsed.data.pools].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (canonicalJson(pools.map((p) => p.key)) !== canonicalJson(poolKeys))
        issues.push({ path: BUNDLE_POOLS_FILE, message: 'must hold exactly the referenced shared pools' });
    }
  }

  // Enemies: the CP-3 documents for every enemy a wave can field.
  const enemyKeys = dungeonDependencies(definition).enemies;
  let enemyDocs: { manifest: unknown; definitions: unknown } | null = null;
  if (enemyKeys.length || manifest.enemies) {
    if (!manifest.enemies) issues.push({ path: 'manifest.enemies', message: 'the dungeon fields enemies, so their definitions and artwork must be carried' });
    enemyDocs = {
      manifest: parsePackageJsonFile(BUNDLE_ENEMY_MANIFEST_FILE, files.get(BUNDLE_ENEMY_MANIFEST_FILE), issues),
      definitions: parsePackageJsonFile(BUNDLE_ENEMY_DEFINITIONS_FILE, files.get(BUNDLE_ENEMY_DEFINITIONS_FILE), issues),
    };
    const listed = (enemyDocs.manifest as { assets?: unknown } | undefined)?.assets;
    if (Array.isArray(listed))
      listed.forEach((raw, i) => {
        const id = (raw as { id?: unknown } | null)?.id;
        const entry = typeof id === 'string' ? use(`${BUNDLE_ENEMY_MANIFEST_FILE}.assets[${i}]`, id) : undefined;
        if (entry && canonicalJson(entry) !== canonicalJson(raw))
          issues.push({ path: `${BUNDLE_ENEMY_MANIFEST_FILE}.assets[${i}]`, message: `must repeat the bundle's entry for "${entry.id}" exactly` });
      });
  }

  // Every archive entry is declared; every declared file is present; every asset is used.
  const declared = new Set([
    BUNDLE_MANIFEST_FILE,
    BUNDLE_DUNGEON_FILE,
    ...(manifest.enemies ? [BUNDLE_ENEMY_MANIFEST_FILE, BUNDLE_ENEMY_DEFINITIONS_FILE] : []),
    ...(manifest.sharedPools ? [BUNDLE_POOLS_FILE] : []),
    ...manifest.assets.map((a) => a.file),
  ]);
  for (const name of files.keys()) if (!declared.has(name)) issues.push({ path: name, message: 'is not declared in the manifest' });
  for (const entry of manifest.assets) if (!used.has(entry.id)) issues.push({ path: 'manifest.assets', message: `asset "${entry.id}" is not used by the dungeon, a sprite or an enemy` });
  if (issues.length) fail();

  // The expensive part, once per image: every image's actual bytes.
  const assets: DungeonBundle['assets'] = new Map();
  for (const entry of manifest.assets) {
    const data = files.get(entry.file);
    const verified = await verifyBundleAsset(entry, data);
    if ('issue' in verified) issues.push({ path: entry.file, message: verified.issue });
    else assets.set(entry.id, { entry, data: data!, image: verified.image });
  }
  if (issues.length) fail();

  let enemies: EnemyPackage | null = null;
  if (enemyDocs) {
    try {
      enemies = await readEnemyPackageDocuments(enemyDocs.manifest, enemyDocs.definitions, files, {
        standalone: false,
        paths: { manifest: BUNDLE_ENEMY_MANIFEST_FILE, enemies: BUNDLE_ENEMY_DEFINITIONS_FILE },
        verified: assets,
      });
    } catch (err) {
      if (!(err instanceof EnemyPackageInvalidError)) throw err;
      issues.push(...err.issues);
      fail();
    }
    const carried = enemies!.definitions.map((d) => d.key);
    if (canonicalJson([...carried].sort()) !== canonicalJson(enemyKeys))
      issues.push({ path: BUNDLE_ENEMY_DEFINITIONS_FILE, message: `must hold exactly the enemies the dungeon fields (${enemyKeys.join(', ') || 'none'})` });
    // The CP-3 documents and the dungeon package were exported together: they must agree.
    for (const enemy of enemies!.definitions) {
      const declaredHash = pkg.dependencies.enemies.find((e) => e.key === enemy.key)?.contentHash ?? null;
      if (declaredHash !== packagedEnemyHash(enemy))
        issues.push({ path: `${BUNDLE_ENEMY_DEFINITIONS_FILE}.${enemy.key}`, message: 'does not match the enemy definition recorded in dungeon.json' });
    }
    if (issues.length) fail();
  }

  const enemyParts = enemies ? { manifest: enemies.manifest, definitions: enemies.definitions } : null;
  return { manifest, pkg, enemies, pools, assets, bundleHash: dungeonBundleHash({ manifest, pkg, enemies: enemyParts, pools }) };
}

// ── write ───────────────────────────────────────────────────────────────────

/** The ZIP for a manifest, its members and the asset bytes by archive path. Deterministic. */
export function buildDungeonBundleArchive(input: {
  manifest: DungeonBundleManifest;
  pkg: DungeonPackage;
  enemies: { manifest: EnemyPackageManifest; definitions: readonly CombatEnemyDefinition[] } | null;
  pools: readonly SharedPoolDefinition[];
  files: ReadonlyMap<string, Buffer>;
}): Buffer {
  const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return writeZip([
    { name: BUNDLE_MANIFEST_FILE, data: json(input.manifest), compress: true },
    { name: BUNDLE_DUNGEON_FILE, data: Buffer.from(serializeDungeonPackage(input.pkg), 'utf8'), compress: true },
    ...(input.enemies
      ? [
          { name: BUNDLE_ENEMY_MANIFEST_FILE, data: json(input.enemies.manifest), compress: true },
          {
            name: BUNDLE_ENEMY_DEFINITIONS_FILE,
            data: json({ format: COMBAT_ENEMY_FILE_FORMAT, version: COMBAT_ENEMY_FILE_VERSION, enemies: input.enemies.definitions }),
            compress: true,
          },
        ]
      : []),
    ...(input.manifest.sharedPools
      ? [{ name: BUNDLE_POOLS_FILE, data: json({ format: 'waifumon-dungeon-species-pools', schemaVersion: 1, pools: input.pools }), compress: true }]
      : []),
    ...input.manifest.assets.map((entry) => ({ name: entry.file, data: input.files.get(entry.file)! })),
  ]);
}

export function dungeonBundleFilename(pkg: Pick<DungeonPackage, 'source' | 'contentHash'>): string {
  return `${pkg.source.dungeonKey}.${pkg.contentHash.slice(7, 19)}.bundle.zip`;
}
