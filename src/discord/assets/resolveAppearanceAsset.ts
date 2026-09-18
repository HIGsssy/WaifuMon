/**
 * The Discord process's `AssetId → AttachmentBuilder` adapter.
 *
 * The *lookup* — which file backs an `AssetId`, and what to fall back to when
 * it is missing — moved to `src/modules/appearance/assetResolver.ts` so the
 * card renderer could share it without the API importing from the Discord
 * layer. What is left here is the only genuinely Discord-shaped part: wrapping
 * a resolved file in an attachment under a fixed stem (`card`) and the file's
 * **real** extension, so the attachment is `card.webp` or `card.png` according
 * to what was actually resolved — never WebP bytes under a `.png` name.
 * Embeds point at it with {@link artworkAttachmentUrl}, never a literal.
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
import type { ArtworkFile } from '../../modules/assets/speciesArtworkFile';
import { artworkAttachmentFilename } from '../../modules/assets/artworkPath';
import type { Logger } from '../../shared/logger';

/**
 * Attachment filename stem for raw appearance artwork. The extension comes
 * from the resolved file, so the full name is `card.webp` or `card.png`.
 */
export const CARD_ATTACHMENT_STEM = 'card';

/**
 * The `attachment://` URL an embed uses to show `file`. Always derived from
 * the attachment's own name, so the embed and the upload cannot disagree
 * about the extension.
 */
export function artworkAttachmentUrl(file: AttachmentBuilder): string {
  return `attachment://${file.name}`;
}

export interface AppearanceAssetContext {
  config: { assetsDir: string };
  logger: Logger;
}

function shared(ctx: AppearanceAssetContext): SharedContext {
  return { assetsDir: ctx.config.assetsDir, logger: ctx.logger };
}

function attach(artwork: ArtworkFile | null): AttachmentBuilder | null {
  if (artwork === null) return null;
  const name = artworkAttachmentFilename(CARD_ATTACHMENT_STEM, artwork.absolutePath);
  return name === null ? null : new AttachmentBuilder(artwork.absolutePath, { name });
}

/**
 * Artwork for one appearance, falling back to the species default.
 *
 * Returns `null` when neither exists — and, deliberately, when `assetId` is
 * `null`. A withheld identifier is how a locked appearance travels (see
 * `AppearanceView.assetId`), and the whole point is that there is nothing to
 * resolve; accepting it here and answering `null` means a caller that forgets
 * to check `isUnlocked` degrades to the text-only embed instead of type-erroring
 * its way into `undefined` and attaching whatever falls out. Callers render
 * `null` as a text-only embed either way.
 */
export function resolveAppearanceAsset(
  ctx: AppearanceAssetContext,
  assetId: AssetId | null | undefined,
): AttachmentBuilder | null {
  if (!assetId) return null;
  return attach(resolveAsset(shared(ctx), assetId));
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
  return attach(resolveAppearanceAssetOrLegacyPath(shared(ctx), assetId, legacyImagePath));
}
