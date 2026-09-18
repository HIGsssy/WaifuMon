/**
 * Authored-artwork bytes for Portal Admin editors.
 *
 * One implementation, used by separately authorized routes: the World
 * Encounter editor (`encounters.read`) and the Result Presentation editor
 * (`presentations.read`). Each route keeps its own permission; there is
 * deliberately no generic asset endpoint a narrower permission could use to
 * reach another area's content.
 *
 * The Portal's image resolver never turns stored paths into URLs, so these
 * routes answer with bytes. They are not a general asset server:
 *
 *   - the path must pass the strict authored-artwork rules (relative, no
 *     traversal, a supported image extension) — otherwise 400;
 *   - it is confined to `assetsDir` by `resolveAssetPath` — otherwise 400;
 *   - a well-formed path with no file is a plain 404, which is what a typo
 *     looks like to an author.
 *
 * The same split applies to the artwork *picker*: {@link browseAdminArtwork}
 * and {@link searchAdminArtwork} wrap the shared browser
 * (`modules/assets/artworkBrowser.ts`), and each consumer registers its own
 * routes under its own permission with its own backend-owned roots. There is
 * no generic listing route either.
 */
import { readFile } from 'node:fs/promises';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ARTWORK_PATH_MAX_LENGTH } from '../modules/assets/artworkPath';
import { locateArtworkFile } from '../modules/assets/artworkFile';
import {
  ARTWORK_SEARCH_MAX_LIMIT,
  ARTWORK_SEARCH_QUERY_MAX_LENGTH,
  ArtworkBrowseError,
  browseArtworkDirectory,
  searchArtwork,
  type ArtworkBrowseRoots,
  type ArtworkDirectoryListing,
  type ArtworkSearchResult,
} from '../modules/assets/artworkBrowser';
import { AppError } from '../shared/errors';

/** Query schema shared by the artwork routes. Shape checks happen in {@link sendAdminArtwork}. */
export const adminArtworkQuery = z.object({
  path: z.string().min(1).max(ARTWORK_PATH_MAX_LENGTH),
});

/** Reply shape for a binary body; see `ArtworkReply` in `routes/v1/artwork.ts`. */
type BinaryReply = {
  header(k: string, v: string): BinaryReply;
  send(payload: Buffer): unknown;
};

export async function sendAdminArtwork(
  reply: FastifyReply,
  assetsDir: string,
  relativePath: string,
): Promise<FastifyReply> {
  const located = locateArtworkFile(assetsDir, relativePath);
  if (located.status === 'unsafe') {
    throw new AppError('VALIDATION_ERROR', `Unsafe artwork path: ${located.reason}`, located.reason);
  }
  if (located.status === 'missing') {
    throw new AppError('NOT_FOUND', 'Artwork not found', 'No artwork file at that path.');
  }
  const out = reply as unknown as BinaryReply;
  out
    .header('content-type', located.contentType)
    .header('cache-control', 'private, max-age=60, must-revalidate')
    .send(await readFile(located.absolutePath));
  return reply;
}

/* ─────────────────────── Artwork picker ─────────────────────── */

/** `?path=` for a browse route. Omitted or empty is the top level. */
export const adminArtworkBrowseQuery = z.object({
  path: z.string().max(ARTWORK_PATH_MAX_LENGTH).optional(),
});

/** `?q=` (and optional `limit`) for a search route. */
export const adminArtworkSearchQuery = z.object({
  q: z.string().min(1).max(ARTWORK_SEARCH_QUERY_MAX_LENGTH),
  limit: z.coerce.number().int().min(1).max(ARTWORK_SEARCH_MAX_LIMIT).optional(),
});

const folderEntrySchema = z.object({ name: z.string(), path: z.string() });
const fileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  folder: z.string(),
  extension: z.string(),
});

/** Response payload of a browse route. Relative paths only. */
export const artworkDirectorySchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  breadcrumbs: z.array(folderEntrySchema),
  directories: z.array(folderEntrySchema),
  files: z.array(fileEntrySchema),
});

/** Response payload of a search route. */
export const artworkSearchSchema = z.object({
  query: z.string(),
  results: z.array(fileEntrySchema),
  truncated: z.boolean(),
  limit: z.number().int(),
});

function asAppError(err: unknown): unknown {
  if (!(err instanceof ArtworkBrowseError)) return err;
  return err.kind === 'not_found'
    ? new AppError('NOT_FOUND', err.message, err.message)
    : new AppError('VALIDATION_ERROR', err.message, err.message);
}

/** One folder under the caller's roots; 400 for a bad or out-of-root path, 404 when gone. */
export async function browseAdminArtwork(
  assetsDir: string,
  roots: ArtworkBrowseRoots,
  folder: string | undefined,
): Promise<ArtworkDirectoryListing> {
  try {
    return await browseArtworkDirectory(assetsDir, roots, folder);
  } catch (err) {
    throw asAppError(err);
  }
}

/** Bounded search under the caller's roots. */
export async function searchAdminArtwork(
  assetsDir: string,
  roots: ArtworkBrowseRoots,
  query: string,
  limit: number | undefined,
): Promise<ArtworkSearchResult> {
  try {
    return await searchArtwork(assetsDir, roots, query, limit);
  } catch (err) {
    throw asAppError(err);
  }
}
