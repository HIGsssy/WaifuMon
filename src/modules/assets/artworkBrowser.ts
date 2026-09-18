/**
 * Read-only browsing and search over authored artwork — the listing half of
 * the Portal's artwork picker.
 *
 * This is the only code that *enumerates* the assets directory on behalf of
 * an author, so it is deliberately narrower than the byte-serving path
 * (`artworkFile.ts`):
 *
 *   - **Roots.** Every call names the directories it may see
 *     ({@link ArtworkBrowseRoots}). The roots are chosen by the backend, per
 *     consumer — the Result Presentation routes pass `results`, never the
 *     assets root — and a request can only address a folder *inside* one.
 *   - **Shape.** A requested folder is a strict relative path: the same
 *     `relativeAssetPath` rules authored artwork uses, plus no empty, `.` or
 *     hidden segment. Nothing on disk is consulted for a bad shape.
 *   - **Canonical containment.** Lexical containment is not enough once you
 *     list directories: a symlink under a root could point anywhere. Every
 *     folder is `realpath`ed and must stay inside its root's real location
 *     (the same {@link isPathInside} boundary the byte-serving path uses, but
 *     against the consumer's root rather than the whole assets directory),
 *     and every entry that is a symlink is followed only if its target does
 *     too — a link out of the root is silently absent, not an error.
 *   - **Entries.** Only sub-folders and files with a supported artwork
 *     extension (`SUPPORTED_ARTWORK_EXTENSIONS`) whose path is itself a legal
 *     authored artwork path. Hidden (`.`-prefixed) names are skipped at every
 *     level, so caches such as `.thumbnails/` never appear.
 *
 * Answers carry relative paths only — never an absolute path, the assets
 * directory or a symlink target.
 *
 * Pure filesystem + path logic: no HTTP, no permissions. Callers own
 * authorization and turn {@link ArtworkBrowseError} into a response.
 */
import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { relativeAssetPath } from '../content/schemas';
import {
  ARTWORK_PATH_MAX_LENGTH,
  artworkExtensionOf,
  isSafeRelativeArtworkPath,
  type ArtworkExtension,
} from './artworkPath';
import { isPathInside } from './assetContainment';

/**
 * Folders (relative to the assets root) a consumer may browse. Non-empty,
 * each a plain relative directory such as `results`.
 */
export type ArtworkBrowseRoots = readonly string[];

export interface ArtworkFolderEntry {
  name: string;
  /** Relative to the assets root. */
  path: string;
}

export interface ArtworkFileEntry {
  name: string;
  /** Relative to the assets root — exactly what an artwork field stores. */
  path: string;
  /** The folder the file is in, relative to the assets root. */
  folder: string;
  extension: ArtworkExtension;
}

export interface ArtworkDirectoryListing {
  /** The folder listed; `''` is the top level (the roots themselves). */
  path: string;
  /** Where "up" goes, or null at the top. */
  parent: string | null;
  /** From the top level down to {@link path}, excluding the top itself. */
  breadcrumbs: ArtworkFolderEntry[];
  directories: ArtworkFolderEntry[];
  files: ArtworkFileEntry[];
}

export interface ArtworkSearchResult {
  query: string;
  results: ArtworkFileEntry[];
  /** More matches exist than were returned, or the scan stopped early. */
  truncated: boolean;
  limit: number;
}

export type ArtworkBrowseErrorKind = 'invalid' | 'not_found';

/** A request the browser refuses. `invalid` → 400, `not_found` → 404. */
export class ArtworkBrowseError extends Error {
  constructor(
    readonly kind: ArtworkBrowseErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ArtworkBrowseError';
  }
}

/** Default and ceiling for search results. */
export const ARTWORK_SEARCH_DEFAULT_LIMIT = 100;
export const ARTWORK_SEARCH_MAX_LIMIT = 200;
/** Longest search query accepted. */
export const ARTWORK_SEARCH_QUERY_MAX_LENGTH = 100;
/**
 * Upper bound on directory entries one search may examine. Far above today's
 * corpus (tens of files under `results/`); a search that reaches it reports
 * `truncated` rather than scanning on.
 */
const SEARCH_SCAN_BUDGET = 20_000;
/** Deepest folder a search descends into, below its root. */
const SEARCH_MAX_DEPTH = 16;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** Natural order, with a plain comparison as a tie-break so it is stable. */
const byName = (a: { name: string }, b: { name: string }) =>
  collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byPath = (a: { path: string }, b: { path: string }) =>
  collator.compare(a.path, b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * True for a name that may appear in a listing: not hidden, and nothing a
 * relative path could not carry cleanly.
 */
function isListableName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith('.') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    // Control characters (NUL, newlines…) have no place in an authored path.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

/**
 * A requested folder in canonical form — `''` for the top level — or an
 * `invalid` error. Trailing slashes are forgiven; everything else that is
 * not already canonical is refused rather than repaired.
 */
export function normalizeBrowsePath(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  if (trimmed.length > ARTWORK_PATH_MAX_LENGTH) {
    throw new ArtworkBrowseError('invalid', 'That folder path is too long.');
  }
  if (!relativeAssetPath.safeParse(trimmed).success) {
    throw new ArtworkBrowseError('invalid', 'Folder must be a relative path inside the artwork folders.');
  }
  if (!trimmed.split('/').every(isListableName) || trimmed.split('/').includes('.')) {
    throw new ArtworkBrowseError('invalid', 'Folder must be a relative path inside the artwork folders.');
  }
  return trimmed;
}

/** The root `folder` lies in (segment-wise), or null. */
function rootOf(roots: ArtworkBrowseRoots, folder: string): string | null {
  return roots.find((root) => folder === root || folder.startsWith(`${root}/`)) ?? null;
}

/** `realpath`, or null when the entry is gone or unreadable. */
async function realOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/**
 * The real, on-disk location of one browse root, or null when it does not
 * exist, is not a directory, or resolves outside the real assets directory.
 */
async function realRoot(assetsDir: string, root: string): Promise<string | null> {
  const realAssets = await realOrNull(path.resolve(assetsDir));
  if (!realAssets) return null;
  const lexical = path.resolve(assetsDir, root);
  if (!isPathInside(path.resolve(assetsDir), lexical)) return null;
  const real = await realOrNull(lexical);
  if (!real || !isPathInside(realAssets, real)) return null;
  const info = await stat(real).catch(() => null);
  return info?.isDirectory() ? real : null;
}

type Classified = { kind: 'dir'; real: string } | { kind: 'file'; extension: ArtworkExtension } | null;

/**
 * What one directory entry is, *after* following a symlink — or null when it
 * should not be listed. `relative` is its path under the assets root.
 */
async function classify(
  entry: Dirent,
  absolute: string,
  relative: string,
  rootReal: string,
): Promise<Classified> {
  if (!isListableName(entry.name)) return null;
  let isDir = entry.isDirectory();
  let isFile = entry.isFile();
  let real = absolute;
  if (entry.isSymbolicLink()) {
    const target = await realOrNull(absolute);
    // A link whose target leaves this root — even for somewhere else inside
    // the assets directory — is not part of what this consumer may see.
    if (!target || !isPathInside(rootReal, target)) return null;
    const info = await stat(target).catch(() => null);
    if (!info) return null;
    isDir = info.isDirectory();
    isFile = info.isFile();
    real = target;
  } else if (!isDir && !isFile) {
    return null; // sockets, FIFOs, devices
  }
  if (isDir) return { kind: 'dir', real };
  if (!isFile) return null;
  const extension = artworkExtensionOf(entry.name);
  // The listed path must be something an artwork field would accept.
  if (!extension || !isSafeRelativeArtworkPath(relative)) return null;
  return { kind: 'file', extension };
}

function crumbs(folder: string): ArtworkFolderEntry[] {
  if (folder === '') return [];
  const parts = folder.split('/');
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

/**
 * One folder's immediate contents: sub-folders first, then artwork files,
 * each in natural order. Never recursive.
 *
 * `''` is the top level. With a single root that *is* the root; with several
 * it lists the roots (that exist) as folders and no files.
 */
export async function browseArtworkDirectory(
  assetsDir: string,
  roots: ArtworkBrowseRoots,
  requested: string | undefined | null,
): Promise<ArtworkDirectoryListing> {
  const folder = normalizeBrowsePath(requested);

  if (folder === '' && roots.length !== 1) {
    const present: ArtworkFolderEntry[] = [];
    for (const root of roots) {
      if (await realRoot(assetsDir, root)) {
        present.push({ name: root, path: root });
      }
    }
    return { path: '', parent: null, breadcrumbs: [], directories: present.sort(byName), files: [] };
  }

  const target = folder === '' ? roots[0]! : folder;
  const root = rootOf(roots, target);
  if (!root) {
    throw new ArtworkBrowseError('invalid', 'That folder is outside the artwork folders you can browse.');
  }
  const rootReal = await realRoot(assetsDir, root);
  if (!rootReal) {
    throw new ArtworkBrowseError('not_found', `The artwork folder "${root}" does not exist on the server.`);
  }

  const dirReal = await realOrNull(path.resolve(assetsDir, target));
  if (!dirReal || !isPathInside(rootReal, dirReal)) {
    // Missing, or a symlinked folder that leaves the root: to the author both
    // mean "no such folder here".
    throw new ArtworkBrowseError('not_found', 'That folder no longer exists.');
  }

  let entries: Dirent[];
  try {
    entries = await readdir(dirReal, { withFileTypes: true });
  } catch {
    throw new ArtworkBrowseError('not_found', 'That folder no longer exists.');
  }

  const directories: ArtworkFolderEntry[] = [];
  const files: ArtworkFileEntry[] = [];
  for (const entry of entries) {
    const relative = `${target}/${entry.name}`;
    const kind = await classify(entry, path.join(dirReal, entry.name), relative, rootReal);
    if (kind?.kind === 'dir') directories.push({ name: entry.name, path: relative });
    else if (kind?.kind === 'file') {
      files.push({ name: entry.name, path: relative, folder: target, extension: kind.extension });
    }
  }

  const atRoot = target === root;
  const parent = atRoot ? (roots.length === 1 ? null : '') : target.slice(0, target.lastIndexOf('/'));
  return {
    path: target,
    parent,
    breadcrumbs: crumbs(target),
    directories: directories.sort(byName),
    files: files.sort(byName),
  };
}

/**
 * Artwork files under the roots whose relative path contains every
 * whitespace-separated term of `query`, case-insensitively. Matching the path
 * rather than just the name means a folder name (`waifubux`) finds what is in
 * it.
 *
 * An on-demand, bounded walk: at most {@link SEARCH_SCAN_BUDGET} entries and
 * {@link SEARCH_MAX_DEPTH} levels, each real folder visited once (so a
 * symlink loop ends), and the same entry rules as browsing. Results are in
 * natural path order and capped at `limit`; `truncated` says there was more.
 */
export async function searchArtwork(
  assetsDir: string,
  roots: ArtworkBrowseRoots,
  rawQuery: string,
  limit: number = ARTWORK_SEARCH_DEFAULT_LIMIT,
): Promise<ArtworkSearchResult> {
  const query = rawQuery.trim();
  if (query === '') throw new ArtworkBrowseError('invalid', 'Enter something to search for.');
  if (query.length > ARTWORK_SEARCH_QUERY_MAX_LENGTH) {
    throw new ArtworkBrowseError('invalid', 'That search is too long.');
  }
  const cap = Math.max(1, Math.min(Math.trunc(limit), ARTWORK_SEARCH_MAX_LIMIT));
  const terms = query.toLowerCase().split(/\s+/);

  const matches: ArtworkFileEntry[] = [];
  let budget = SEARCH_SCAN_BUDGET;
  let exhausted = false;

  for (const root of roots) {
    const rootReal = await realRoot(assetsDir, root);
    if (!rootReal) continue;
    const visited = new Set<string>([rootReal]);
    const queue: Array<{ real: string; relative: string; depth: number }> = [
      { real: rootReal, relative: root, depth: 0 },
    ];
    while (queue.length > 0 && !exhausted) {
      const { real, relative, depth } = queue.shift()!;
      let entries: Dirent[];
      try {
        // Sorted, so which alias of a doubly-reachable folder is reported is
        // deterministic: the first in natural order wins.
        entries = (await readdir(real, { withFileTypes: true })).sort(byName);
      } catch {
        continue; // vanished mid-walk; skip it
      }
      for (const entry of entries) {
        if (budget-- <= 0) {
          exhausted = true;
          break;
        }
        const childRelative = `${relative}/${entry.name}`;
        const kind = await classify(entry, path.join(real, entry.name), childRelative, rootReal);
        if (kind?.kind === 'dir') {
          if (depth + 1 <= SEARCH_MAX_DEPTH && !visited.has(kind.real)) {
            visited.add(kind.real);
            queue.push({ real: kind.real, relative: childRelative, depth: depth + 1 });
          }
        } else if (kind?.kind === 'file') {
          const haystack = childRelative.toLowerCase();
          if (terms.every((t) => haystack.includes(t))) {
            matches.push({
              name: entry.name,
              path: childRelative,
              folder: relative,
              extension: kind.extension,
            });
          }
        }
      }
    }
  }

  matches.sort(byPath);
  return {
    query,
    results: matches.slice(0, cap),
    truncated: exhausted || matches.length > cap,
    limit: cap,
  };
}
