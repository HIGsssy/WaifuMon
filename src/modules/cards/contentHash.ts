/**
 * Artwork content hashing — owned by the cards module, never by callers.
 *
 * The V2 plan originally had callers pass both an artwork path and a
 * precomputed hash. That is a footgun: a caller that memoizes by path and
 * misses an update silently serves a stale card forever, and nothing in the
 * type system catches it. Hashing lives here instead, so cache identity is
 * always the real SHA-256 of the bytes the renderer actually drew.
 */
import fs from 'node:fs/promises';
import { CardArtworkMissingError } from './errors';
import { ArtworkHashMemo, sha256Hex } from './cache/hashMemo';
import { isNotFound } from './assets/loader';

export { sha256Hex };

/** Shared default memo so repeated renders in one process re-stat, not re-read. */
const defaultMemo = new ArtworkHashMemo();

export interface HashArtworkContext {
  memo?: ArtworkHashMemo;
  speciesSlug?: string;
  appearanceId?: string;
}

/**
 * SHA-256 (hex) of the artwork bytes at `absolutePath`.
 *
 * Independent of path, mtime, and size by construction. A missing or
 * unreadable file surfaces as {@link CardArtworkMissingError} — the renderer
 * never substitutes other artwork.
 */
export async function hashArtwork(
  absolutePath: string,
  ctx: HashArtworkContext = {},
): Promise<string> {
  const memo = ctx.memo ?? defaultMemo;
  try {
    return await memo.hashFile(absolutePath);
  } catch (err) {
    if (isNotFound(err) || isNotADirectory(err) || isDirectoryRead(err)) {
      throw new CardArtworkMissingError(
        absolutePath,
        ctx.speciesSlug ?? 'unknown',
        ctx.appearanceId ?? 'unknown',
      );
    }
    throw err;
  }
}

/**
 * Reads the artwork bytes, raising the same typed error as {@link hashArtwork}
 * so a caller only has one failure mode to handle for "artwork is not there".
 */
export async function readArtwork(
  absolutePath: string,
  ctx: HashArtworkContext = {},
): Promise<Buffer> {
  try {
    return await fs.readFile(absolutePath);
  } catch (err) {
    if (isNotFound(err) || isNotADirectory(err) || isDirectoryRead(err)) {
      throw new CardArtworkMissingError(
        absolutePath,
        ctx.speciesSlug ?? 'unknown',
        ctx.appearanceId ?? 'unknown',
      );
    }
    throw err;
  }
}

function isNotADirectory(err: unknown): boolean {
  return codeOf(err) === 'ENOTDIR';
}

/** Reading a directory as a file: EISDIR on Linux, EPERM/EACCES on Windows. */
function isDirectoryRead(err: unknown): boolean {
  const code = codeOf(err);
  return code === 'EISDIR' || code === 'EPERM';
}

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export { ArtworkHashMemo };
