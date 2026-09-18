/**
 * `AssetId → a file on disk` — the shared, presentation-agnostic half of
 * artwork resolution.
 *
 * This used to live inside the Discord layer, which was fine while Discord was
 * the only thing that rendered artwork. It is not any more: the card renderer
 * needs the same lookup, and a card API importing from `src/discord/` would be
 * a dependency running exactly the wrong way. So the generic part moved here
 * and Discord became a consumer.
 *
 * The split is deliberate and worth keeping:
 *
 *   - **Here:** which file backs an `AssetId`, what format it is in, does it
 *     exist, and what to fall back to when it does not. No `discord.js`, no
 *     `AttachmentBuilder`, no HTTP, no image encoding.
 *   - **Callers:** what to *do* with the file. Discord wraps it in an
 *     attachment; the card renderer reads its bytes; the API streams it.
 *
 * **Format is an answer, not an assumption.** An appearance may be stored as
 * WebP (the runtime format) or PNG (the source masters). Which file exists,
 * and in what format, is answered one layer down by
 * `modules/assets/speciesArtworkFile.ts`; this module adds only the fallback
 * chain. No caller builds an artwork filename or guesses a content type.
 *
 * **Fallback is defense in depth, not a feature.** A content mistake in one
 * appearance must never blank out an inspect card, so resolution degrades
 * appearance → species default → (optionally) the legacy `imagePath`, and only
 * returns `null` when nothing at all exists. Callers already handle `null`.
 */
import { defaultAssetId } from './appearanceContent';
import { DEFAULT_APPEARANCE_ID, type AssetId } from '../content/schemas';
import {
  locateLegacyArtwork,
  locateSpeciesArtwork,
  type ArtworkFile,
} from '../assets/speciesArtworkFile';
import type { Logger } from '../../shared/logger';

export interface AppearanceAssetContext {
  /** Absolute path to the assets root — `config.assetsDir`. */
  assetsDir: string;
  /** Optional: receives the same fallback warnings Discord logged before. */
  logger?: Logger | undefined;
}

/** Which of the three candidates actually produced the file. */
export type AppearanceAssetSource = 'appearance' | 'species-default' | 'legacy-image-path';

export interface ResolvedAppearanceAsset extends ArtworkFile {
  /**
   * The asset that resolved — not necessarily the one asked for, when the
   * lookup fell back. Callers that care (logging, cache keys) can tell.
   */
  assetId: AssetId;
  source: AppearanceAssetSource;
}

/**
 * Absolute path for an `AssetId`, or `null` if it does not exist or the path
 * would escape the assets root. Never throws.
 */
export function appearanceAssetPath(ctx: AppearanceAssetContext, assetId: AssetId): string | null {
  return locateSpeciesArtwork(ctx.assetsDir, assetId)?.absolutePath ?? null;
}

/**
 * Artwork for one appearance, falling back to the species' default look.
 *
 * Returns `null` only when neither exists.
 */
export function resolveAppearanceAsset(
  ctx: AppearanceAssetContext,
  assetId: AssetId,
): ResolvedAppearanceAsset | null {
  const direct = locateSpeciesArtwork(ctx.assetsDir, assetId);
  if (direct) return { ...direct, assetId, source: 'appearance' };

  const fallback = defaultAssetId(assetId.slug, DEFAULT_APPEARANCE_ID);
  if (fallback.variant !== assetId.variant) {
    const standard = locateSpeciesArtwork(ctx.assetsDir, fallback);
    if (standard) {
      ctx.logger?.warn(
        { assetId },
        'appearance artwork missing — fell back to the species default',
      );
      return { ...standard, assetId: fallback, source: 'species-default' };
    }
  }

  ctx.logger?.warn({ assetId }, 'no artwork resolved for appearance');
  return null;
}

/**
 * As {@link resolveAppearanceAsset}, with a caller-supplied last resort.
 *
 * Used where the caller still holds the species row and can degrade to
 * `species.imagePath` — a loader-private field that must not travel further
 * than the caller that already has it.
 */
export function resolveAppearanceAssetOrLegacyPath(
  ctx: AppearanceAssetContext,
  assetId: AssetId,
  legacyImagePath: string,
): ResolvedAppearanceAsset | null {
  const resolved = resolveAppearanceAsset(ctx, assetId);
  if (resolved) return resolved;

  // Compatibility only for an unusual pre-AssetId default path. Expansion
  // directories are intentionally not derived or probed here: all live
  // species art uses the canonical AssetId layout.
  const legacy = locateLegacyArtwork(ctx.assetsDir, legacyImagePath);
  return legacy ? { ...legacy, assetId, source: 'legacy-image-path' } : null;
}
