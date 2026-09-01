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
 *   - **Here:** which file backs an `AssetId`, does it exist, and what to fall
 *     back to when it does not. No `discord.js`, no `AttachmentBuilder`, no
 *     HTTP, no image encoding.
 *   - **Callers:** what to *do* with the path. Discord wraps it in an
 *     attachment; the card renderer reads its bytes.
 *
 * **Fallback is defense in depth, not a feature.** A content mistake in one
 * appearance must never blank out an inspect card, so resolution degrades
 * appearance → species default → (optionally) the legacy `imagePath`, and only
 * returns `null` when nothing at all exists. Callers already handle `null`.
 */
import fs from 'node:fs';
import { appearanceAssetRelativePath, appearanceRelativePathForSpecies, defaultAssetId } from './appearanceContent';
import { DEFAULT_APPEARANCE_ID, type AssetId } from '../content/schemas';
import { resolveAssetPath } from '../content/loader';
import type { Logger } from '../../shared/logger';

export interface AppearanceAssetContext {
  /** Absolute path to the assets root — `config.assetsDir`. */
  assetsDir: string;
  /** Optional: receives the same fallback warnings Discord logged before. */
  logger?: Logger | undefined;
}

/** Which of the three candidates actually produced the file. */
export type AppearanceAssetSource = 'appearance' | 'species-default' | 'legacy-image-path';

export interface ResolvedAppearanceAsset {
  /** Absolute path to a file that exists at resolution time. */
  absolutePath: string;
  /**
   * The asset that resolved — not necessarily the one asked for, when the
   * lookup fell back. Callers that care (logging, cache keys) can tell.
   */
  assetId: AssetId;
  source: AppearanceAssetSource;
}

/**
 * Absolute path for an `AssetId`, or `null` if it does not exist or the path
 * would escape the assets root. Never throws — a bad `slug` in content is a
 * missing file, not a crash.
 */
export function appearanceAssetPath(ctx: AppearanceAssetContext, assetId: AssetId): string | null {
  return existingPath(ctx, appearanceAssetRelativePath(assetId));
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
  const direct = appearanceAssetPath(ctx, assetId);
  if (direct) return { absolutePath: direct, assetId, source: 'appearance' };

  const fallback = defaultAssetId(assetId.slug, DEFAULT_APPEARANCE_ID);
  if (fallback.variant !== assetId.variant) {
    const standard = appearanceAssetPath(ctx, fallback);
    if (standard) {
      ctx.logger?.warn(
        { assetId },
        'appearance artwork missing — fell back to the species default',
      );
      return { absolutePath: standard, assetId: fallback, source: 'species-default' };
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
  // First, the artwork that sits **beside** the species' own image: the one
  // convention shared by core (`waifumon/<slug>/`) and expansion packs
  // (`expansions/<pack>/<slug>/`). For a core species this path is identical to
  // the canonical `waifumon/<slug>/<variant>.png` the assetId already maps to,
  // so core resolution is byte-for-byte unchanged; for an expansion species it
  // is where the pack keeps its milestone art. `assetId.variant` is the
  // appearance id.
  const beside = existingPath(ctx, appearanceRelativePathForSpecies(legacyImagePath, assetId.variant));
  if (beside) return { absolutePath: beside, assetId, source: 'appearance' };

  const resolved = resolveAppearanceAsset(ctx, assetId);
  if (resolved) return resolved;

  // The species' default look, again taken from beside its own image, so an
  // expansion species that only shipped `standard.png` still renders.
  const besideStandard = existingPath(
    ctx,
    appearanceRelativePathForSpecies(legacyImagePath, DEFAULT_APPEARANCE_ID),
  );
  if (besideStandard) {
    return {
      absolutePath: besideStandard,
      assetId: defaultAssetId(assetId.slug, DEFAULT_APPEARANCE_ID),
      source: 'species-default',
    };
  }

  const legacy = existingPath(ctx, legacyImagePath);
  return legacy ? { absolutePath: legacy, assetId, source: 'legacy-image-path' } : null;
}

function existingPath(ctx: AppearanceAssetContext, relative: string): string | null {
  try {
    const absolute = resolveAssetPath(ctx.assetsDir, relative);
    return fs.existsSync(absolute) ? absolute : null;
  } catch {
    // Path traversal or an unreadable root — `resolveAssetPath` already threw
    // to say so. Treated as missing so one bad content entry degrades instead
    // of taking down the surface that asked.
    return null;
  }
}
