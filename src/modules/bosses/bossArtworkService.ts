/**
 * Boss artwork: the library an admin picks a boss's picture from, and the
 * uploads that add to it.
 *
 * A boss can show one of two kinds of picture, and both stay supported:
 *
 *   - **Shipped** — a file under `assets/` in Git, named by the boss's
 *     `artwork` path. Listed here, never written or deleted here: it changes
 *     with a commit and a deploy.
 *   - **Managed** — an image uploaded through the Portal, named by the boss's
 *     `artworkAssetId`. It is an ordinary managed artwork asset
 *     (`modules/artworkAssets`) in the `boss_art` category: the bytes live in
 *     the managed artwork store (`MANAGED_ASSETS_DIR`), the row and its audit
 *     trail in `artwork_assets` / `artwork_asset_events`.
 *
 * This service adds only what is boss-specific on top of that store: the
 * combined library with who uses what, the upload normalisation, and the rule
 * that these routes reach `boss_art` assets and nothing else. Validation of the
 * bytes, storage keys, the delete guard and the audit rows are the asset
 * service's, unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { asc } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { bossDefinitions, type ArtworkAssetCategory, type BossDefinitionStatus } from '../../db/schema';
import type { ArtworkAssetReference } from '../../shared/errors';
import { ArtworkUploadInvalidError } from '../../shared/errors';
import type { ArtworkAsset, ArtworkAssetEvent, ArtworkAssetService } from '../artworkAssets/artworkAssetService';
import { ARTWORK_MAX_PIXELS, inspectImage } from '../artworkAssets/imageInspection';
import { resolveExistingAssetFile } from '../assets/assetContainment';

export const BOSS_ARTWORK_CATEGORY: ArtworkAssetCategory = 'boss_art';
/** Where shipped boss artwork lives, relative to the assets root. */
export const BOSS_ARTWORK_SHIPPED_DIR = 'bosses';
/**
 * Longest edge a stored boss image keeps. Discord shows an embed image far
 * smaller than this, and every announcement edit re-sends the file.
 */
export const BOSS_ARTWORK_MAX_EDGE = 2048;
const WEBP_QUALITY = 90;
const LIBRARY_PAGE_SIZE = 200;

export const BOSS_ARTWORK_SHIPPED_TYPES: Readonly<Record<string, string>> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

/** A boss that names a piece of artwork. */
export interface BossArtworkUser {
  id: string;
  name: string;
  status: BossDefinitionStatus;
}

export interface ShippedBossArtwork {
  /** Relative to the assets root — exactly what a boss's `artwork` stores. */
  path: string;
  /** False for a path a boss names that has no file on this server. */
  exists: boolean;
  usedBy: BossArtworkUser[];
}

export interface ManagedBossArtwork {
  asset: ArtworkAsset;
  usedBy: BossArtworkUser[];
}

export interface BossArtworkLibrary {
  shipped: ShippedBossArtwork[];
  managed: ManagedBossArtwork[];
}

export interface BossArtworkService {
  /** Shipped file paths under `assets/bosses/`, sorted. */
  shippedPaths(): string[];
  /** Everything a boss can show, with the bosses that show it. */
  library(): Promise<BossArtworkLibrary>;
  /** One uploaded boss image with its references and history. Null when it is not boss artwork. */
  get(
    id: string,
  ): Promise<{ asset: ArtworkAsset; usedBy: BossArtworkUser[]; references: ArtworkAssetReference[]; events: ArtworkAssetEvent[] } | null>;
  /** The bytes of an uploaded boss image (a disabled one included), for previews. */
  read(id: string): Promise<{ asset: ArtworkAsset; bytes: Buffer } | null>;
  /**
   * Validate, normalise and store an upload as boss artwork.
   * @throws {ArtworkUploadInvalidError} for anything that is not an acceptable image.
   */
  upload(
    input: { bytes: Buffer; filename?: string | undefined; name?: string | undefined },
    actor: string | null,
  ): Promise<ArtworkAsset>;
  /**
   * Delete an uploaded boss image nothing uses.
   * @returns false when the id names no boss artwork.
   * @throws {ArtworkAssetInUseError} while a boss (or a live encounter) still shows it.
   */
  delete(id: string, actor: string | null): Promise<boolean>;
}

export interface BossArtworkServiceDeps {
  db: Db;
  assets: ArtworkAssetService;
  /** The shipped assets root. Absent: no shipped artwork is listed. */
  assetsDir?: string | undefined;
}

/**
 * The bytes to store for an upload that already passed {@link inspectImage}:
 * WebP, no larger than {@link BOSS_ARTWORK_MAX_EDGE} on its longest edge.
 * An image that already is both is stored untouched.
 */
export async function normalizeBossArtwork(
  bytes: Buffer,
  image: { mimeType: string; width: number; height: number },
): Promise<Buffer> {
  if (image.mimeType === 'image/webp' && Math.max(image.width, image.height) <= BOSS_ARTWORK_MAX_EDGE) return bytes;
  try {
    return await sharp(bytes, { limitInputPixels: ARTWORK_MAX_PIXELS, failOn: 'error' })
      .rotate() // bake in the EXIF orientation: the re-encode drops the tag
      .resize({ width: BOSS_ARTWORK_MAX_EDGE, height: BOSS_ARTWORK_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch {
    throw new ArtworkUploadInvalidError('The image could not be converted — it may be corrupt.');
  }
}

export function createBossArtworkService(deps: BossArtworkServiceDeps): BossArtworkService {
  const { db, assets, assetsDir } = deps;

  function shippedPaths(): string[] {
    if (!assetsDir) return [];
    try {
      return fs
        .readdirSync(path.join(assetsDir, BOSS_ARTWORK_SHIPPED_DIR), { withFileTypes: true })
        .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() in BOSS_ARTWORK_SHIPPED_TYPES)
        .map((entry) => `${BOSS_ARTWORK_SHIPPED_DIR}/${entry.name}`)
        .sort();
    } catch {
      return [];
    }
  }

  /** Every boss's two artwork references, in list order. */
  async function bossRows() {
    return db
      .select({
        id: bossDefinitions.bossKey,
        name: bossDefinitions.name,
        status: bossDefinitions.status,
        artwork: bossDefinitions.artwork,
        artworkAssetId: bossDefinitions.artworkAssetId,
      })
      .from(bossDefinitions)
      .orderBy(asc(bossDefinitions.position), asc(bossDefinitions.bossKey));
  }

  const userOf = (boss: BossArtworkUser): BossArtworkUser => ({ id: boss.id, name: boss.name, status: boss.status });

  /** A live boss image, or null for anything else — another category's asset is not found here. */
  async function bossAsset(id: string): Promise<ArtworkAsset | null> {
    const asset = await assets.get(id);
    return asset && asset.status !== 'deleted' && asset.category === BOSS_ARTWORK_CATEGORY ? asset : null;
  }

  return {
    shippedPaths,

    async library() {
      const bosses = await bossRows();
      const files = new Set(shippedPaths());
      // A path a boss names stays visible even when its file is gone or lives elsewhere under assets/.
      const paths = [...new Set([...files, ...bosses.flatMap((b) => (b.artwork ? [b.artwork] : []))])].sort();
      const shipped = paths.map((file) => ({
        path: file,
        exists:
          files.has(file) || (assetsDir ? resolveExistingAssetFile(assetsDir, file).status === 'available' : false),
        usedBy: bosses.filter((b) => b.artwork === file).map(userOf),
      }));
      // Every upload, not one page of them: an image the library cannot show cannot be chosen or deleted.
      const rows: ArtworkAsset[] = [];
      for (;;) {
        const page = await assets.list({ category: BOSS_ARTWORK_CATEGORY, limit: LIBRARY_PAGE_SIZE, offset: rows.length });
        rows.push(...page.assets);
        if (page.assets.length === 0 || rows.length >= page.total) break;
      }
      const managed = rows.map((asset) => ({
        asset,
        usedBy: bosses.filter((b) => b.artworkAssetId === asset.id).map(userOf),
      }));
      return { shipped, managed };
    },

    async get(id) {
      const asset = await bossAsset(id);
      if (!asset) return null;
      const [bosses, references, events] = await Promise.all([bossRows(), assets.references(asset.id), assets.events(asset.id)]);
      return {
        asset,
        usedBy: bosses.filter((b) => b.artworkAssetId === asset.id).map(userOf),
        references,
        events,
      };
    },

    async read(id) {
      // A boss's picture stays viewable even if the asset was since moved to another category.
      if (!(await bossAsset(id)) && !(await bossRows()).some((b) => b.artworkAssetId === id.toLowerCase())) return null;
      return assets.read(id);
    },

    async upload({ bytes, filename, name }, actor) {
      const image = await inspectImage(bytes);
      const stored = await normalizeBossArtwork(bytes, image);
      return assets.upload({ bytes: stored, category: BOSS_ARTWORK_CATEGORY, filename, name }, actor);
    },

    async delete(id, actor) {
      if (!(await bossAsset(id))) return false;
      return (await assets.delete(id, actor)) !== null;
    },
  };
}
