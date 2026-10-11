/**
 * Which managed asset a dungeon's artwork reference means on this server.
 *
 * A dungeon names managed artwork by **category and content hash** so the
 * reference survives a move between environments. Two rules, shared by
 * validation, the run snapshot, the delete guard and the editor preview:
 *
 *   1. an active asset holding exactly those bytes — the oldest, since uploads
 *      are not deduplicated;
 *   2. else the asset that *most recently gave those bytes up* through a
 *      Replace, while it is active. Replacing an image keeps the asset and
 *      changes its hash; without this rule every dungeon using it — published
 *      revisions included, which can never be rewritten — would silently lose
 *      the picture. A replacement is the same asset with a newer look, so the
 *      reference follows it, through any number of replacements.
 *
 * Rule 2 never chooses between assets. When several once held the same bytes,
 * the bytes belong to the one that held them last (the highest replace event
 * id) and to no other: if that asset is disabled or deleted the reference
 * resolves to nothing rather than moving to an unrelated asset's new picture.
 *
 * Everything is read from `artwork_assets` and the append-only
 * `artwork_asset_events`, so the answer is the same after a restart and for
 * every dungeon naming the reference. Nothing is cached and no definition is
 * rewritten. Replacement history is local: it is not part of a dungeon
 * package, so another environment resolves the same reference from its own
 * assets and its own history.
 *
 * A disabled or deleted asset resolves to nothing under either rule.
 */
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { artworkAssetEvents, artworkAssets } from '../../db/schema';

export interface ManagedArtworkKeyParts {
  category: string;
  contentHash: string;
}
export const managedArtworkKey = (ref: ManagedArtworkKeyParts) => `${ref.category}:${ref.contentHash}`;

/**
 * Who owns each `<category>:<hash>` no longer held by the asset that had it:
 * the asset that replaced those bytes away most recently, whatever its status.
 * The category is the asset's current one.
 */
async function formerHolders(tx: DbOrTx): Promise<Map<string, { id: string; status: string; category: string; contentHash: string }>> {
  const rows = await tx
    .select({ id: artworkAssets.id, status: artworkAssets.status, category: artworkAssets.category, contentHash: artworkAssetEvents.oldHash })
    .from(artworkAssetEvents)
    .innerJoin(artworkAssets, eq(artworkAssets.id, artworkAssetEvents.assetId))
    .where(and(eq(artworkAssetEvents.action, 'replace'), isNotNull(artworkAssetEvents.oldHash)))
    .orderBy(desc(artworkAssetEvents.id));
  const holders = new Map<string, { id: string; status: string; category: string; contentHash: string }>();
  for (const row of rows) {
    if (!row.contentHash) continue;
    const key = managedArtworkKey({ category: row.category, contentHash: row.contentHash });
    if (!holders.has(key)) holders.set(key, { ...row, contentHash: row.contentHash });
  }
  return holders;
}

/**
 * Every `<category>:<hash>` that resolves here, mapped to its asset: current
 * hashes first, then the hashes active assets held before a replacement.
 */
export async function managedArtworkIndex(tx: DbOrTx): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const active = await tx
    .select({ id: artworkAssets.id, category: artworkAssets.category, contentHash: artworkAssets.contentHash })
    .from(artworkAssets)
    .where(eq(artworkAssets.status, 'active'))
    .orderBy(asc(artworkAssets.createdAt), asc(artworkAssets.id));
  for (const row of active) {
    const key = managedArtworkKey(row);
    if (!index.has(key)) index.set(key, row.id);
  }
  for (const [key, holder] of await formerHolders(tx)) {
    if (holder.status === 'active' && !index.has(key)) index.set(key, holder.id);
  }
  return index;
}

/** The asset each reference resolves to here, or null. Keys are {@link managedArtworkKey}. */
export async function resolveManagedArtworkIds(
  tx: DbOrTx,
  refs: readonly ManagedArtworkKeyParts[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = Object.fromEntries(refs.map((r) => [managedArtworkKey(r), null]));
  if (refs.length === 0) return out;
  const index = await managedArtworkIndex(tx);
  for (const key of Object.keys(out)) out[key] = index.get(key) ?? null;
  return out;
}

/**
 * Every hash a reference could name and mean this asset: its current one, and
 * the earlier ones it still owns (see {@link formerHolders}). For the delete
 * guard, so it holds for a disabled asset too.
 */
export async function managedArtworkHashesOf(tx: DbOrTx, assetId: string, currentHash: string): Promise<string[]> {
  const owned = [...(await formerHolders(tx)).values()].filter((h) => h.id === assetId).map((h) => h.contentHash);
  return [...new Set([currentHash, ...owned])];
}
