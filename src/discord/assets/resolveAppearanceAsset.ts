/**
 * The Discord process's `AssetId → renderable artwork` resolver.
 *
 * **This is the only place Discord code turns artwork identity into storage.**
 * Everything upstream — the appearance service, the Platform API, the game-event
 * bus — speaks `AssetId { kind, slug, variant }` and nothing else. Moving the
 * bot to a CDN or object storage in production is a change to this one file:
 * return a hosted URL instead of an `AttachmentBuilder`, same input signature,
 * no caller touched and no API contract affected.
 *
 * Defense in depth: a resolution failure falls back to the species' default
 * artwork rather than throwing, because a content mistake in one appearance
 * must never blank out an inspect card. `null` is the last resort and every
 * caller already handles a card-less embed.
 */
import fs from 'node:fs';
import { AttachmentBuilder } from 'discord.js';
import type { AssetId } from '../../modules/content/schemas';
import { defaultAssetId } from '../../modules/appearance/appearanceContent';
import { resolveAssetPath } from '../../modules/content/loader';
import type { Logger } from '../../shared/logger';

/** Attachment filename every appearance embed references. */
export const CARD_FILENAME = 'card.png';

export interface AppearanceAssetContext {
  config: { assetsDir: string };
  logger: Logger;
}

/**
 * The local layout this resolver expects: `assets/<kind>/<slug>/<variant>.png`.
 * Private to the Discord process — the identical mapping in the content loader
 * is a separate, equally private copy, and neither is exported upward.
 */
function toRelativePath(assetId: AssetId): string {
  return `${assetId.kind}/${assetId.slug}/${assetId.variant}.png`;
}

function attach(ctx: AppearanceAssetContext, assetId: AssetId): AttachmentBuilder | null {
  try {
    const absolute = resolveAssetPath(ctx.config.assetsDir, toRelativePath(assetId));
    if (!fs.existsSync(absolute)) return null;
    return new AttachmentBuilder(absolute, { name: CARD_FILENAME });
  } catch {
    // Path traversal or an unreadable root. Caller falls back.
    return null;
  }
}

/**
 * Artwork for one appearance, falling back to the species default.
 *
 * Returns `null` only when neither exists, which callers render as a
 * text-only embed.
 */
export function resolveAppearanceAsset(
  ctx: AppearanceAssetContext,
  assetId: AssetId,
): AttachmentBuilder | null {
  const direct = attach(ctx, assetId);
  if (direct) return direct;

  const fallback = defaultAssetId(assetId.slug, 'standard');
  if (fallback.variant !== assetId.variant) {
    const standard = attach(ctx, fallback);
    if (standard) {
      ctx.logger.warn(
        { assetId },
        'appearance artwork missing — fell back to the species default',
      );
      return standard;
    }
  }

  ctx.logger.warn({ assetId }, 'no artwork resolved for appearance');
  return null;
}

/**
 * Artwork for an appearance with a caller-supplied last-resort path.
 *
 * Used by the inspect card, which still holds the species row and can degrade
 * to `species.imagePath` when a species has no resolvable appearance art at
 * all. That path never leaves this module.
 */
export function resolveAppearanceAssetOrPath(
  ctx: AppearanceAssetContext,
  assetId: AssetId,
  legacyImagePath: string,
): AttachmentBuilder | null {
  const resolved = resolveAppearanceAsset(ctx, assetId);
  if (resolved) return resolved;
  try {
    const absolute = resolveAssetPath(ctx.config.assetsDir, legacyImagePath);
    if (!fs.existsSync(absolute)) return null;
    return new AttachmentBuilder(absolute, { name: CARD_FILENAME });
  } catch {
    return null;
  }
}
