/**
 * Shared region banner resolver.
 *
 * Every screen that shows a region banner (main menu, Locations home,
 * destination detail, travel-success) goes through here so path validation,
 * file existence and attachment naming stay identical across surfaces.
 *
 * Discord embeds have no true background image and no way to fix an image's
 * width, so appearance is controlled by the shipped asset dimensions — the
 * loader deliberately does not enforce a 4:1 aspect, but the schema's field
 * doc recommends 1200×300.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { resolveAssetPath } from '../modules/content/loader';
import type { AppContext } from './types';

export interface RegionBanner {
  file: AttachmentBuilder;
  /** For `embed.setImage(...)`. */
  url: string;
  /** The attachment filename actually used. */
  name: string;
}

/**
 * Best-effort banner attachment.
 *
 * Returns `null` when the region has no banner configured, when `assetsDir`
 * is not wired (unit tests with a bare `ctx.config`), when the path escapes
 * the assets root, or when the file is missing on disk. Every branch is a
 * "render without the banner" branch — a missing banner is never fatal.
 */
export function resolveRegionBanner(
  ctx: AppContext,
  regionId: string,
  bannerImagePath: string | null | undefined,
): RegionBanner | null {
  if (!bannerImagePath) return null;
  const assetsDir = ctx.config.assetsDir;
  if (!assetsDir) return null;
  try {
    const abs = resolveAssetPath(assetsDir, bannerImagePath);
    if (!fs.existsSync(abs)) {
      ctx.logger.debug(
        { regionId, bannerImagePath },
        'region banner not found on disk — rendering without banner',
      );
      return null;
    }
    // Namespace the attachment by region so two banners in the same payload
    // (unlikely, but the detail screen could bump into the main menu one)
    // never collide on Discord's attachment table.
    const ext = path.extname(bannerImagePath) || '.png';
    const name = `region-${regionId}-banner${ext}`;
    return {
      file: new AttachmentBuilder(abs, { name }),
      url: `attachment://${name}`,
      name,
    };
  } catch (err) {
    ctx.logger.warn(
      { err, regionId, bannerImagePath },
      'region banner failed to resolve — rendering without banner',
    );
    return null;
  }
}
