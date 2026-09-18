/**
 * Where does an authored artwork path point, and may it be served?
 *
 * The one implementation of the three checks every authored-artwork surface
 * needs, in the order that keeps unsafe input away from the filesystem:
 *
 *   1. shape — strict relative path with a supported image extension
 *      ({@link isSafeRelativeArtworkPath}); nothing on disk is consulted;
 *   2. containment — lexically inside the assets root, and its *real*
 *      (symlink-resolved) location inside the real assets root
 *      ({@link resolveExistingAssetFile}), so a symlink under `assets/` that
 *      leads elsewhere is refused;
 *   3. existence, as a regular file.
 *
 * Callers decide what each answer means for them: the Discord resolver logs
 * and renders text-only, the admin artwork routes answer 400/404, and the
 * Result Presentation preview reports a status to the editor.
 */
import { resolveExistingAssetFile } from './assetContainment';
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
  /** Bad shape, unsupported extension, or resolves outside the assets root (lexically or via a symlink). */
  | { status: 'unsafe'; reason: string }
  /**
   * A well-formed path with no regular file behind it — usually a typo; also
   * a broken or looping symlink, or a directory.
   */
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
  const found = resolveExistingAssetFile(assetsDir, relativePath);
  if (found.status === 'unsafe') {
    return { status: 'unsafe', reason: found.reason };
  }
  if (found.status === 'missing') return { status: 'missing' };
  return {
    status: 'available',
    absolutePath: found.absolutePath,
    extension,
    contentType: ARTWORK_CONTENT_TYPES[extension],
  };
}
