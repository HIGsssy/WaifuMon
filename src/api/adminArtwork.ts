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
 */
import { readFile } from 'node:fs/promises';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ARTWORK_PATH_MAX_LENGTH } from '../modules/assets/artworkPath';
import { locateArtworkFile } from '../modules/assets/artworkFile';
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
