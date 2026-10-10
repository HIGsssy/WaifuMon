/**
 * Boss artwork resolution — the one place an encounter's frozen artwork
 * becomes something Discord can be sent, and the only place that decides an
 * encounter is text-only.
 *
 * An encounter freezes two references at spawn, and they resolve in order:
 *
 *   1. **Managed artwork** (`bossArtworkAssetId`) — an image uploaded through
 *      Portal Admin. Used while the asset is active and its file is readable;
 *      the bytes are read live, so replacing the image updates an open
 *      encounter's next render.
 *   2. **Shipped artwork** (`bossArtwork`) — a path under `ASSETS_DIR`, as
 *      before managed artwork existed.
 *   3. Neither: a text/embed-only encounter.
 *
 * A managed asset that is unset, disabled, deleted or whose file is missing
 * falls through. Nothing in that chain is an error for a player.
 *
 * Two layers of defence on the shipped path, both required:
 *
 *   1. `resolveAssetPath` confines the result to `ASSETS_DIR`, so a
 *      hand-edited `artwork` cannot read outside the assets root. The content
 *      schema already rejects `..` and absolute paths; this is the check that
 *      still holds if content is edited past the schema.
 *   2. An existence probe, because the loader's own probe ran at startup and
 *      a file can disappear afterwards. Artwork that vanishes mid-window must
 *      degrade the announcement, never fail the resolution.
 *
 * Returns a spreadable object rather than a bare value so call sites read as
 * `...(await resolveBossArtwork(ctx, encounter))` and the "no artwork" case is
 * simply an absent key.
 */
import type { BossEncounterRow } from '../db/schema';
import { ARTWORK_MIME_EXTENSIONS } from '../modules/artworkAssets/imageInspection';
import { resolveExistingAssetFile } from '../modules/assets/assetContainment';
import type { BossArtworkImage } from './bossPresenter';
import type { AppContext, AppServices } from './types';

export interface BossArtwork {
  artworkPath?: string;
  artworkImage?: BossArtworkImage;
}

/** What resolution reads. Managed artwork is optional: without the service only shipped artwork resolves. */
type BossArtworkContext = Pick<AppContext, 'config' | 'logger'> & {
  services?: Pick<AppServices, 'artworkAssets'> | undefined;
};

export async function resolveBossArtwork(
  ctx: BossArtworkContext,
  encounter: Pick<BossEncounterRow, 'id' | 'bossArtwork' | 'bossArtworkAssetId'>,
): Promise<BossArtwork> {
  // The encounter's own snapshot, not live content: an encounter announced
  // with artwork keeps rendering with it even if the boss is retired midway.
  const assets = ctx.services?.artworkAssets;
  if (encounter.bossArtworkAssetId && assets) {
    try {
      const managed = await assets.readUsable(encounter.bossArtworkAssetId);
      if (managed) {
        return {
          artworkImage: { bytes: managed.bytes, extension: ARTWORK_MIME_EXTENSIONS[managed.asset.mimeType] },
        };
      }
    } catch (err) {
      // A storage fault must cost the picture, never the announcement.
      ctx.logger.warn(
        { tag: 'boss/artwork-managed-unreadable', encounterId: encounter.id, assetId: encounter.bossArtworkAssetId, err },
        'managed boss artwork could not be read — falling back to shipped artwork',
      );
    }
  }
  const relative = encounter.bossArtwork;
  if (!relative) return {};
  const found = resolveExistingAssetFile(ctx.config.assetsDir, relative);
  if (found.status === 'unsafe') {
    ctx.logger.error(
      { tag: 'boss/artwork-unsafe', encounterId: encounter.id, artwork: relative, reason: found.reason },
      'boss artwork path rejected — rendering text-only',
    );
    return {};
  }
  if (found.status === 'missing') {
    ctx.logger.warn(
      { tag: 'boss/artwork-missing', encounterId: encounter.id, artwork: relative },
      'boss artwork missing at post time — rendering text-only',
    );
    return {};
  }
  return { artworkPath: found.absolutePath };
}
