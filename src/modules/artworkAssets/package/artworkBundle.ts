/**
 * Artwork carried inside a content package, and bound to managed assets on
 * the destination (Content Portability CP-3; written for CP-4 to reuse).
 *
 * A package never carries an asset **id**, storage key or URL — those name
 * rows and files in the environment that exported it. It carries the bytes,
 * plus a manifest entry per distinct `(category, sha256)`:
 *
 *     { id: "asset-001", file: "artwork/asset-001.webp", category, sha256,
 *       bytes, mimeType, width, height, name }
 *
 * `id` is a logical name local to the package. Domain manifests (enemies
 * here; dungeons later) say which entry fills which role.
 *
 * On import each entry is resolved to a destination asset:
 *
 *   1. **reuse** an `active` asset of the **same category** holding the exact
 *      bytes whose stored file is present — preferring the asset the target
 *      already uses, else the oldest (the `managedArtworkLookup` rule). The
 *      same bytes in another category are *not* reused: a category is a role,
 *      and a background is not a sprite;
 *   2. otherwise **create** a new asset under a destination-generated id and
 *      storage key, through {@link insertManagedAssetRow}.
 *
 * Nothing here writes an existing asset's bytes, status or category, and
 * cleanup only ever removes files this import staged under ids it generated
 * and that no `artwork_assets` row names — so a reused or shared asset can
 * never be deleted by a failed import.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../../../db/client';
import {
  ARTWORK_ASSET_CATEGORIES,
  artworkAssets,
  type ArtworkAssetCategory,
  type ArtworkAssetMimeType,
} from '../../../db/schema';
import { ArtworkUploadInvalidError } from '../../../shared/errors';
import { insertManagedAssetRow, type ArtworkAsset } from '../artworkAssetService';
import { artworkStorageKey, type ArtworkStorage } from '../artworkStorage';
import { ARTWORK_MIME_EXTENSIONS, inspectImage, type InspectedImage } from '../imageInspection';

export const BUNDLE_ASSET_ID_PATTERN = /^asset-[0-9]{3,4}$/;
export const BUNDLE_ARTWORK_DIR = 'artwork/';
const SHA256 = /^[0-9a-f]{64}$/;

export const BundleAssetEntrySchema = z
  .object({
    id: z.string().regex(BUNDLE_ASSET_ID_PATTERN, 'must be asset-NNN'),
    file: z.string().max(64),
    category: z.enum(ARTWORK_ASSET_CATEGORIES),
    sha256: z.string().regex(SHA256, 'must be a lowercase sha256'),
    bytes: z.number().int().positive(),
    mimeType: z.enum(['image/png', 'image/webp', 'image/jpeg']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** A display name for a created asset; informational. */
    name: z.string().trim().min(1).max(100),
  })
  .strict();
export type BundleAssetEntry = z.infer<typeof BundleAssetEntrySchema>;

/** The archive path an entry's bytes live at. */
export function bundleAssetFile(id: string, mimeType: ArtworkAssetMimeType): string {
  return `${BUNDLE_ARTWORK_DIR}${id}.${ARTWORK_MIME_EXTENSIONS[mimeType]}`;
}

/**
 * Structural problems with a set of entries: duplicate ids, files or
 * `(category, sha256)` identities, and files not at their canonical path.
 */
export function bundleEntryIssues(entries: readonly BundleAssetEntry[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const files = new Set<string>();
  const identities = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) issues.push(`asset id "${entry.id}" is declared twice`);
    ids.add(entry.id);
    if (files.has(entry.file)) issues.push(`file "${entry.file}" is declared twice`);
    files.add(entry.file);
    const identity = `${entry.category}:${entry.sha256}`;
    if (identities.has(identity)) issues.push(`asset "${entry.id}" repeats the bytes of another ${entry.category} asset`);
    identities.add(identity);
    if (entry.file !== bundleAssetFile(entry.id, entry.mimeType)) {
      issues.push(`asset "${entry.id}" must be stored at ${bundleAssetFile(entry.id, entry.mimeType)}`);
    }
  }
  return issues;
}

/**
 * Check one entry's actual bytes: inspected as an accepted still image
 * (`inspectImage` — signature, decode, dimensions, pixel limit), and equal to
 * what the manifest declares. Returns the inspection, or why not.
 */
export async function verifyBundleAsset(
  entry: BundleAssetEntry,
  data: Buffer | undefined,
): Promise<{ image: InspectedImage } | { issue: string }> {
  if (!data) return { issue: `asset "${entry.id}" is declared but ${entry.file} is missing from the package` };
  if (data.length !== entry.bytes) return { issue: `asset "${entry.id}" is ${data.length} bytes, not the declared ${entry.bytes}` };
  let image: InspectedImage;
  try {
    image = await inspectImage(data);
  } catch (err) {
    const reason = err instanceof ArtworkUploadInvalidError ? err.userMessage : 'it could not be read as an image';
    return { issue: `asset "${entry.id}" is not an accepted image: ${reason}` };
  }
  if (image.contentHash !== entry.sha256) return { issue: `asset "${entry.id}" does not match its declared sha256` };
  if (image.mimeType !== entry.mimeType || image.width !== entry.width || image.height !== entry.height) {
    return { issue: `asset "${entry.id}" is a ${image.width}×${image.height} ${image.mimeType}, not what the manifest declares` };
  }
  return { image };
}

/** Export side: one entry per distinct `(category, sha256)`, numbered in the order first added. */
export function createBundleAssetCollector() {
  const entries: BundleAssetEntry[] = [];
  const files = new Map<string, Buffer>();
  const byIdentity = new Map<string, BundleAssetEntry>();
  return {
    add(input: { category: ArtworkAssetCategory; bytes: Buffer; image: InspectedImage; name: string }): BundleAssetEntry {
      const identity = `${input.category}:${input.image.contentHash}`;
      const existing = byIdentity.get(identity);
      if (existing) return existing;
      const id = `asset-${String(entries.length + 1).padStart(3, '0')}`;
      const entry: BundleAssetEntry = {
        id,
        file: bundleAssetFile(id, input.image.mimeType),
        category: input.category,
        sha256: input.image.contentHash,
        bytes: input.image.fileSize,
        mimeType: input.image.mimeType,
        width: input.image.width,
        height: input.image.height,
        name: input.name.trim().slice(0, 100) || id,
      };
      entries.push(entry);
      files.set(entry.file, input.bytes);
      byIdentity.set(identity, entry);
      return entry;
    },
    entries: () => [...entries],
    files: () => new Map(files),
  };
}

/**
 * Destination side: the asset an entry may reuse, or null to create one.
 * `prefer` (the asset the target already holds in that role) wins when it
 * qualifies. Only `active` assets whose stored file is present qualify.
 */
export async function findReusableAsset(
  tx: DbOrTx,
  storage: Pick<ArtworkStorage, 'exists'>,
  wanted: { category: ArtworkAssetCategory; sha256: string; prefer?: string | null },
): Promise<string | null> {
  const rows = await tx
    .select({ id: artworkAssets.id, storageKey: artworkAssets.storageKey })
    .from(artworkAssets)
    .where(
      and(eq(artworkAssets.category, wanted.category), eq(artworkAssets.contentHash, wanted.sha256), eq(artworkAssets.status, 'active')),
    )
    .orderBy(asc(artworkAssets.createdAt), asc(artworkAssets.id));
  const ordered = wanted.prefer ? [...rows.filter((r) => r.id === wanted.prefer), ...rows.filter((r) => r.id !== wanted.prefer)] : rows;
  for (const row of ordered) if (await storage.exists(row.storageKey)) return row.id;
  return null;
}

/** An entry about to become a new destination asset: its id and key exist before its row does. */
export interface StagedBundleAsset {
  entry: BundleAssetEntry;
  image: InspectedImage;
  assetId: string;
  storageKey: string;
}

/** Generate destination ids and storage keys for the entries to create. Writes nothing. */
export function planStagedAssets(items: readonly { entry: BundleAssetEntry; image: InspectedImage }[]): StagedBundleAsset[] {
  return items.map(({ entry, image }) => {
    const assetId = randomUUID();
    return {
      entry,
      image,
      assetId,
      storageKey: artworkStorageKey({ category: entry.category, assetId, contentHash: image.contentHash, extension: image.extension }),
    };
  });
}

/** Write each staged asset's bytes. Callers journal the keys first, and clean them up on failure. */
export async function writeStagedAssets(
  storage: Pick<ArtworkStorage, 'put'>,
  staged: readonly StagedBundleAsset[],
  bytesOf: (entry: BundleAssetEntry) => Buffer,
): Promise<void> {
  for (const asset of staged) await storage.put(asset.storageKey, bytesOf(asset.entry));
}

/** Insert the rows for staged assets, in the import's transaction. */
export async function insertStagedAssets(
  tx: DbOrTx,
  staged: readonly StagedBundleAsset[],
  opts: { actor: string | null; details: Record<string, unknown> },
): Promise<Map<string, ArtworkAsset>> {
  const created = new Map<string, ArtworkAsset>();
  for (const asset of staged) {
    created.set(
      asset.entry.id,
      await insertManagedAssetRow(
        tx,
        {
          id: asset.assetId,
          category: asset.entry.category,
          storageKey: asset.storageKey,
          image: asset.image,
          originalFilename: asset.entry.file.slice(BUNDLE_ARTWORK_DIR.length),
          name: asset.entry.name,
          details: opts.details,
        },
        opts.actor,
      ),
    );
  }
  return created;
}

/**
 * Remove staged files that no asset row names. Run after a failed import's
 * transaction rolled back, and by crash recovery. A key some row holds — a
 * committed import, or anything else — is left alone. Returns what it removed.
 */
export async function removeUnclaimedStagedFiles(
  tx: DbOrTx,
  storage: Pick<ArtworkStorage, 'delete'>,
  storageKeys: readonly string[],
): Promise<string[]> {
  if (storageKeys.length === 0) return [];
  const claimed = new Set(
    (await tx.select({ key: artworkAssets.storageKey }).from(artworkAssets).where(inArray(artworkAssets.storageKey, [...storageKeys]))).map(
      (r) => r.key,
    ),
  );
  const removed: string[] = [];
  for (const key of storageKeys) {
    if (claimed.has(key)) continue;
    await storage.delete(key);
    removed.push(key);
  }
  return removed;
}
