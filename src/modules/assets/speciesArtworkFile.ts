/**
 * Species artwork on disk — the lowest layer of artwork resolution.
 *
 * Answers exactly one kind of question: *given an `AssetId` (or a legacy
 * relative path), which physical file backs it, and what format is it?* It
 * knows the storage layout (`<kind>/<slug>/<variant>.<ext>`), the formats
 * species artwork may be stored in and their preference order, MIME types, and
 * whether a file exists inside the assets root.
 *
 * It deliberately knows nothing else: no species-default fallback, no unlock
 * rules, no content loading, no Discord, no HTTP. Those live above it —
 * `appearance/assetResolver.ts` adds the fallback chain, the content loader
 * and the appearance sync tool ask it whether artwork exists — and because
 * this module imports none of them, none of them import each other through it.
 */
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AssetId } from '../content/schemas';
import { ARTWORK_CONTENT_TYPES, artworkExtensionOf, type ArtworkExtension } from './artworkPath';

/**
 * Formats species artwork may be stored in, most preferred first.
 *
 * WebP is the runtime format; PNG is what the source masters are, and stays
 * resolvable so a tree that has not been converted — or has only been partly
 * converted — behaves exactly as it always did. The first format that exists
 * on disk wins.
 */
export const SPECIES_ARTWORK_EXTENSIONS = ['webp', 'png'] as const;
export type SpeciesArtworkExtension = (typeof SPECIES_ARTWORK_EXTENSIONS)[number];

/** One artwork file that exists, and what format it is in. */
export interface ArtworkFile {
  /** Absolute path to a file that exists at resolution time. */
  absolutePath: string;
  /** The file's real format, lower-case, without the dot. */
  extension: ArtworkExtension;
  /** MIME type for {@link extension}. */
  contentType: string;
}

/**
 * `relative` resolved under the assets root, or `null` when it would escape
 * it. The one containment rule every artwork path goes through; the content
 * loader's throwing `resolveAssetPath` is built on it.
 */
export function assetPathWithin(assetsDir: string, relative: string): string | null {
  const root = path.resolve(assetsDir);
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * The storage stem an `AssetId` maps to: `<kind>/<slug>/<variant>`, relative
 * to the assets root, with no extension. This is the *entire* coupling between
 * artwork identity and artwork storage — changing the layout is changing this
 * function.
 */
export function speciesArtworkStem(assetId: AssetId): string {
  return `${assetId.kind}/${assetId.slug}/${assetId.variant}`;
}

/** One candidate relative path per supported format, in preference order. */
export function speciesArtworkCandidatePaths(assetId: AssetId): string[] {
  const stem = speciesArtworkStem(assetId);
  return SPECIES_ARTWORK_EXTENSIONS.map((ext) => `${stem}.${ext}`);
}

/**
 * The file backing one `AssetId`, in whichever supported format exists —
 * WebP before PNG — or `null`. No fallback and no logging.
 *
 * Never throws — a bad `slug` in content is a missing file, not a crash.
 */
export function locateSpeciesArtwork(assetsDir: string, assetId: AssetId): ArtworkFile | null {
  for (const relative of speciesArtworkCandidatePaths(assetId)) {
    const found = existingArtwork(assetsDir, relative);
    if (found) return found;
  }
  return null;
}

/**
 * A legacy authored path (`species.imagePath`), format-agnostically.
 *
 * It was authored when all species art was PNG, so its extension says what the
 * file *used* to be. It is treated as a stem: the same format preference as an
 * `AssetId` applies, and the literal path is the final candidate so an
 * authored non-PNG/WebP path keeps resolving.
 */
export function locateLegacyArtwork(assetsDir: string, legacyPath: string): ArtworkFile | null {
  const candidates: string[] = [];
  const authored = artworkExtensionOf(legacyPath);
  if (
    authored !== null &&
    (SPECIES_ARTWORK_EXTENSIONS as readonly string[]).includes(authored)
  ) {
    const stem = legacyPath.slice(0, legacyPath.length - authored.length - 1);
    candidates.push(...SPECIES_ARTWORK_EXTENSIONS.map((ext) => `${stem}.${ext}`));
  }
  if (!candidates.includes(legacyPath)) candidates.push(legacyPath);

  for (const relative of candidates) {
    const found = existingArtwork(assetsDir, relative);
    if (found) return found;
  }
  return null;
}

/**
 * Pre-generated display renditions, under the assets root:
 * `<RENDITION_DIR>/<width>/<artwork stem>.webp`.
 *
 * Written by the artwork build tool (`src/tools/artworkBuild.ts`); always WebP
 * whatever the source format, so a WebP and a PNG source share one rendition.
 */
export const ARTWORK_RENDITION_DIR = '.thumbnails';

/** The widths renditions are generated at. Mirrors the Portal's `IMAGE_SIZE_BUCKETS`. */
export const ARTWORK_RENDITION_WIDTHS = [256, 512, 1024] as const;
export type ArtworkRenditionWidth = (typeof ARTWORK_RENDITION_WIDTHS)[number];

/** Rendition path, relative to the assets root, for an artwork stem. */
export function renditionRelativePath(stem: string, width: number): string {
  return `${ARTWORK_RENDITION_DIR}/${width}/${stem}.webp`;
}

/**
 * The file to serve for `artwork` at a display `width`: the pre-generated
 * rendition when one exists, otherwise the artwork itself.
 *
 * Renditions are an optimisation, never a requirement — a missing one costs
 * bytes, not correctness. `width` undefined always answers the artwork.
 */
export async function resolveArtworkRendition(
  assetsDir: string,
  artwork: ArtworkFile,
  width: number | undefined,
): Promise<ArtworkFile> {
  if (width === undefined) return artwork;
  const root = path.resolve(assetsDir);
  const relative = path.relative(root, artwork.absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return artwork;
  }
  const stem = relative.split(path.sep).join('/').replace(/\.[^./]+$/, '');
  const rendition = assetPathWithin(root, renditionRelativePath(stem, width));
  if (rendition === null) return artwork;
  try {
    if ((await stat(rendition)).isFile()) {
      return { absolutePath: rendition, extension: 'webp', contentType: ARTWORK_CONTENT_TYPES.webp };
    }
  } catch {
    // Renditions are an optimization. Fall through to the artwork itself.
  }
  return artwork;
}

function existingArtwork(assetsDir: string, relative: string): ArtworkFile | null {
  const extension = artworkExtensionOf(relative);
  if (extension === null) return null;
  const absolutePath = assetPathWithin(assetsDir, relative);
  if (absolutePath === null) return null;
  if (!fs.existsSync(absolutePath)) return null;
  return { absolutePath, extension, contentType: ARTWORK_CONTENT_TYPES[extension] };
}
