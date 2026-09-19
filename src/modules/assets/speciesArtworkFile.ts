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
import path from 'node:path';
import type { AssetId } from '../content/schemas';
import { ARTWORK_CONTENT_TYPES, artworkExtensionOf, type ArtworkExtension } from './artworkPath';
import { isPathInside, resolveExistingAssetFile } from './assetContainment';

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

// The containment rules live in `assetContainment.ts`; `assetPathWithin` is
// re-exported here because the build tool and the content loader import it
// from this module.
export { assetPathWithin } from './assetContainment';

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
  const inspected = inspectSpeciesArtwork(assetsDir, assetId);
  return inspected.status === 'available' ? inspected.file : null;
}

/**
 * {@link locateSpeciesArtwork}, keeping the reason when there is no file.
 *
 *   - `available` — the first candidate, in preference order, that may be read;
 *   - `unsafe`    — no candidate is readable and at least one escapes the
 *                   assets root (through a symlink — an `AssetId` cannot
 *                   express a lexical escape);
 *   - `missing`   — nothing there at all.
 *
 * Same containment check, same candidates, same order: `unsafe` is only ever a
 * more specific word for what `locateSpeciesArtwork` reports as `null`. Never
 * throws, and never reads file contents.
 */
export type SpeciesArtworkInspection =
  | { status: 'available'; file: ArtworkFile }
  | { status: 'missing' }
  | { status: 'unsafe' };

export function inspectSpeciesArtwork(
  assetsDir: string,
  assetId: AssetId,
): SpeciesArtworkInspection {
  let unsafe = false;
  for (const relative of speciesArtworkCandidatePaths(assetId)) {
    const extension = artworkExtensionOf(relative);
    if (extension === null) continue;
    const found = resolveExistingAssetFile(assetsDir, relative);
    if (found.status === 'available') {
      return {
        status: 'available',
        file: {
          absolutePath: found.absolutePath,
          extension,
          contentType: ARTWORK_CONTENT_TYPES[extension],
        },
      };
    }
    if (found.status === 'unsafe') unsafe = true;
  }
  return unsafe ? { status: 'unsafe' } : { status: 'missing' };
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
 * Which pre-generated renditions exist for an `AssetId`, per width.
 *
 * Checked with the same canonical containment as the artwork itself — a
 * rendition symlinked out of the assets root counts as absent — and never
 * reads a byte. Presence only: a missing rendition is served as the original.
 */
export function speciesArtworkRenditions(
  assetsDir: string,
  assetId: AssetId,
): Record<ArtworkRenditionWidth, boolean> {
  const stem = speciesArtworkStem(assetId);
  const out = {} as Record<ArtworkRenditionWidth, boolean>;
  for (const width of ARTWORK_RENDITION_WIDTHS) {
    out[width] =
      resolveExistingAssetFile(assetsDir, renditionRelativePath(stem, width)).status === 'available';
  }
  return out;
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
  if (!isPathInside(root, artwork.absolutePath)) return artwork;
  const relative = path.relative(root, artwork.absolutePath);
  const stem = relative.split(path.sep).join('/').replace(/\.[^./]+$/, '');
  // A rendition is read and served like the artwork itself, so it gets the
  // same canonical containment check. Renditions are an optimization: any
  // answer but "available" falls through to the artwork.
  const rendition = resolveExistingAssetFile(root, renditionRelativePath(stem, width));
  if (rendition.status !== 'available') return artwork;
  return {
    absolutePath: rendition.absolutePath,
    extension: 'webp',
    contentType: ARTWORK_CONTENT_TYPES.webp,
  };
}

/**
 * The candidate as an {@link ArtworkFile} when it may be read: a supported
 * format, and a regular file whose real location is inside the real assets
 * root (a symlink out of `assets/` counts as absent).
 */
function existingArtwork(assetsDir: string, relative: string): ArtworkFile | null {
  const extension = artworkExtensionOf(relative);
  if (extension === null) return null;
  const found = resolveExistingAssetFile(assetsDir, relative);
  if (found.status !== 'available') return null;
  return { absolutePath: found.absolutePath, extension, contentType: ARTWORK_CONTENT_TYPES[extension] };
}
