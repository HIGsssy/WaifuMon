/**
 * The Discord process's `AssetId → AttachmentBuilder` adapter.
 *
 * The *lookup* — which file backs an `AssetId`, and what to fall back to when
 * it is missing — moved to `src/modules/appearance/assetResolver.ts` so the
 * card renderer could share it without the API importing from the Discord
 * layer. What is left here is the only genuinely Discord-shaped part: wrapping
 * a path in an attachment under a fixed filename, so embeds can reference
 * `attachment://card.png` regardless of what the file is really called.
 *
 * Moving the bot to a CDN is still a change to this one file: return a hosted
 * URL instead of an `AttachmentBuilder`, same signatures, no caller touched.
 */
import { AttachmentBuilder } from 'discord.js';
import type { AssetId } from '../../modules/content/schemas';
import {
  resolveAppearanceAsset as resolveAsset,
  resolveAppearanceAssetOrLegacyPath,
  type AppearanceAssetContext as SharedContext,
} from '../../modules/appearance/assetResolver';
import type { Logger } from '../../shared/logger';

/** Attachment filename every appearance embed references. */
export const CARD_FILENAME = 'card.png';

export interface AppearanceAssetContext {
  config: { assetsDir: string };
  logger: Logger;
}

function shared(ctx: AppearanceAssetContext): SharedContext {
  return { assetsDir: ctx.config.assetsDir, logger: ctx.logger };
}

function attach(absolutePath: string | undefined): AttachmentBuilder | null {
  return absolutePath === undefined
    ? null
    : new AttachmentBuilder(absolutePath, { name: CARD_FILENAME });
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
  return attach(resolveAsset(shared(ctx), assetId)?.absolutePath);
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
  return attach(resolveAppearanceAssetOrLegacyPath(shared(ctx), assetId, legacyImagePath)?.absolutePath);
}
