/**
 * Authored artwork paths — the rules shared by every surface that lets an
 * author point at a file under `ASSETS_DIR`.
 *
 * Two layers, on purpose:
 *
 *   1. **Shape**, checked when the path is authored: {@link relativeArtworkPath}
 *      applies the boss content rules (`relativeAssetPath`: no absolute path,
 *      no drive letter, no backslash, no `..` segment, no URL) plus a closed
 *      extension allowlist. A bad path is an error at the field.
 *   2. **Containment**, checked when the path is used: `resolveAssetPath`
 *      confines the resolved file to the assets root. That stays the last line
 *      of defence for rows that reached the database some other way.
 *
 * Pure and Discord-free, so the API, the Discord presenters and tests can all
 * share one answer to "is this an artwork path, and what kind of file is it?".
 */
import { z } from 'zod';
import { relativeAssetPath } from '../content/schemas';

/**
 * Image formats authored artwork may use. The same set the admin artwork
 * endpoint serves, lower-case and without the dot.
 */
export const SUPPORTED_ARTWORK_EXTENSIONS = ['png', 'webp', 'jpg', 'jpeg', 'gif'] as const;
export type ArtworkExtension = (typeof SUPPORTED_ARTWORK_EXTENSIONS)[number];

/** MIME type per supported extension. Typed as a total map, so a new format needs one. */
export const ARTWORK_CONTENT_TYPES: Readonly<Record<ArtworkExtension, string>> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};

/** Longest authored artwork path, matching the World Encounter field. */
export const ARTWORK_PATH_MAX_LENGTH = 200;

/**
 * The file's extension when it is a supported artwork format, else null.
 * Case-insensitive; a path with no extension, or a dot only in a directory
 * name, has none.
 */
export function artworkExtensionOf(relativePath: string): ArtworkExtension | null {
  const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return (SUPPORTED_ARTWORK_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as ArtworkExtension)
    : null;
}

/** A strict relative artwork path with a supported image extension. */
export const relativeArtworkPath = z
  .string()
  .max(ARTWORK_PATH_MAX_LENGTH, `artwork must be at most ${ARTWORK_PATH_MAX_LENGTH} characters`)
  .pipe(relativeAssetPath)
  .refine((p) => artworkExtensionOf(p) !== null, {
    message: `artwork must be one of: ${SUPPORTED_ARTWORK_EXTENSIONS.map((e) => `.${e}`).join(', ')}`,
  });

/** True when `value` passes {@link relativeArtworkPath}. */
export function isSafeRelativeArtworkPath(value: string): boolean {
  return relativeArtworkPath.safeParse(value).success;
}

/**
 * The attachment filename Discord should see for an artwork file: a
 * sanitised stem chosen by the caller, plus the **source file's real
 * extension**. Returns null when the source is not a supported format.
 *
 * The stem keeps `assets/` layout out of what players see, and the extension
 * keeps Discord from being told a `.webp` is a `.png`.
 */
export function artworkAttachmentFilename(stem: string, sourcePath: string): string | null {
  const ext = artworkExtensionOf(sourcePath);
  if (!ext) return null;
  const safeStem = stem.toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'artwork';
  return `${safeStem}.${ext}`;
}
