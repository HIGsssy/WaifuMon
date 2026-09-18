/**
 * "Is this inside the assets root?" — the one definition, in two strengths.
 *
 *   - **Lexical** ({@link assetPathWithin}) — pure path arithmetic, no disk
 *     access. Correct for paths that may not exist yet: build outputs,
 *     rendition targets, shape checks at authoring time. It cannot see
 *     symlinks.
 *   - **Canonical** ({@link resolveExistingAssetFile}) — for a file that is
 *     about to be *read or served*. The lexical check first, then the real
 *     (`realpath`) location of the file must lie inside the real location of
 *     the assets root, and it must be a regular file. A symlink under
 *     `assets/` that leads outside it — directly or through a chain — is
 *     refused; one that stays inside is fine.
 *
 * {@link isPathInside} is the boundary test both use, and the one the artwork
 * picker's enumeration uses: segment-aware, so `/assets2/x` is not inside
 * `/assets`.
 *
 * Pure `node:fs`/`node:path`: no content, no HTTP, no Discord.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * True when `candidate` is `root` or lies beneath it. Both should be absolute
 * and normalised (`path.resolve` / `realpath` output). Compares whole path
 * segments, never string prefixes.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // another drive/root altogether
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * `relative` resolved under the assets root, or `null` when it would escape
 * it. Lexical only — see the module comment for when that is enough.
 */
export function assetPathWithin(assetsDir: string, relative: string): string | null {
  const root = path.resolve(assetsDir);
  const resolved = path.resolve(root, relative);
  return isPathInside(root, resolved) ? resolved : null;
}

export type ExistingAssetFile =
  /** A regular file whose real location is inside the real assets root. */
  | { status: 'available'; absolutePath: string }
  /**
   * Nothing readable there: no such file, a broken or looping symlink, a
   * directory, or an unreadable path component.
   */
  | { status: 'missing' }
  /** Escapes the assets root — lexically, or through a symlink. */
  | { status: 'unsafe'; reason: string };

/**
 * The file behind `relative`, if it may be read: lexically inside the assets
 * root, its canonical target inside the canonical assets root, and a regular
 * file.
 *
 * Returns the *lexical* absolute path (what the caller asked for, so its
 * extension and layout are the ones the caller reasoned about), and only
 * after its real target has been checked. Never throws.
 *
 * Two synchronous syscalls (`realpath` of the root and of the file, then a
 * `stat`) — no scanning.
 */
export function resolveExistingAssetFile(assetsDir: string, relative: string): ExistingAssetFile {
  const lexical = assetPathWithin(assetsDir, relative);
  if (lexical === null) {
    return { status: 'unsafe', reason: 'Path resolves outside the assets directory.' };
  }

  let realRoot: string;
  let realFile: string;
  try {
    realRoot = fs.realpathSync(path.resolve(assetsDir));
  } catch {
    return { status: 'missing' }; // no assets directory at all
  }
  try {
    realFile = fs.realpathSync(lexical);
  } catch {
    // ENOENT (including a broken symlink), ELOOP, ENOTDIR, EACCES: there is
    // nothing here that can be served.
    return { status: 'missing' };
  }

  if (!isPathInside(realRoot, realFile)) {
    return {
      status: 'unsafe',
      reason: 'Path leads outside the assets directory through a symbolic link.',
    };
  }

  try {
    if (!fs.statSync(realFile).isFile()) return { status: 'missing' };
  } catch {
    return { status: 'missing' };
  }
  return { status: 'available', absolutePath: lexical };
}
