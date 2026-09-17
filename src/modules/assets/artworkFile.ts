/**
 * Where does an authored artwork path point, and may it be served?
 *
 * The one implementation of the three checks every authored-artwork surface
 * needs, in the order that keeps unsafe input away from the filesystem:
 *
 *   1. shape — strict relative path with a supported image extension
 *      ({@link isSafeRelativeArtworkPath}); nothing on disk is consulted;
 *   2. containment — `resolveAssetPath` confines it to the assets root;
 *   3. existence.
 *
 * Callers decide what each answer means for them: the Discord resolver logs
 * and renders text-only, the admin artwork routes answer 400/404, and the
 * Result Presentation preview reports a status to the editor.
 */
import fs from 'node:fs';
import { resolveAssetPath } from '../content/loader';
import {
  ARTWORK_CONTENT_TYPES,
  artworkExtensionOf,
  isSafeRelativeArtworkPath,
  type ArtworkExtension,
} from './artworkPath';

export type LocatedArtwork =
  | {
      status: 'available';
      absolutePath: string;
      extension: ArtworkExtension;
      contentType: string;
    }
  /** Bad shape, unsupported extension, or resolves outside the assets root. */
  | { status: 'unsafe'; reason: string }
  /** A well-formed path with no file behind it — usually a typo. */
  | { status: 'missing' };

export function locateArtworkFile(assetsDir: string, relativePath: string): LocatedArtwork {
  if (!isSafeRelativeArtworkPath(relativePath)) {
    return {
      status: 'unsafe',
      reason:
        'Artwork must be a relative path under assets/ ending in .png, .webp, .jpg, .jpeg or .gif.',
    };
  }
  const extension = artworkExtensionOf(relativePath)!;
  let absolutePath: string;
  try {
    absolutePath = resolveAssetPath(assetsDir, relativePath);
  } catch {
    return { status: 'unsafe', reason: 'Artwork path resolves outside the assets directory.' };
  }
  if (!fs.existsSync(absolutePath)) return { status: 'missing' };
  return {
    status: 'available',
    absolutePath,
    extension,
    contentType: ARTWORK_CONTENT_TYPES[extension],
  };
}
