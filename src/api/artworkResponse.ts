/**
 * Sending a resolved species artwork file — shared by every route that serves
 * one: the player artwork routes (`routes/v1/artwork.ts`) and the Admin
 * Gallery (`routes/v1/admin/gallery.ts`).
 *
 * This is the *response* half only. Deciding which file a request may see —
 * the dex rule, ownership, unlocks, or the gallery's exact-appearance rule —
 * stays with each route, and so does any fallback between appearances. What
 * lives here is what every caller must do identically once it holds an
 * `ArtworkFile` that already passed the containment check:
 *
 *   - choose between the file and a pre-generated display rendition of *that
 *     same file* (`resolveArtworkRendition`, itself containment-checked);
 *   - a weak ETag from size + mtime, answered with 304 on `If-None-Match`;
 *   - the caller's `Cache-Control`, and the real format's `Content-Type`.
 */
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  ARTWORK_RENDITION_WIDTHS,
  resolveArtworkRendition,
  type ArtworkFile,
} from '../modules/assets/speciesArtworkFile';

/** Display widths an artwork request may ask for — the pre-generated rendition sizes. */
export const ARTWORK_REQUEST_WIDTHS = ARTWORK_RENDITION_WIDTHS;

/** The `?width=` field every artwork route shares. */
export const artworkWidthQueryField = z.coerce
  .number()
  .int()
  .refine(
    (width) => ARTWORK_REQUEST_WIDTHS.includes(width as (typeof ARTWORK_REQUEST_WIDTHS)[number]),
    { message: `width must be one of ${ARTWORK_REQUEST_WIDTHS.join(', ')}` },
  )
  .optional();

export interface ArtworkReply {
  code(statusCode: 304): ArtworkReply;
  header(key: string, value: string): ArtworkReply;
  send(payload?: unknown): unknown;
}

export interface ArtworkRequest {
  headers: Record<string, unknown>;
  query: { width?: number | undefined };
}

function matchesEtag(header: unknown, etag: string): boolean {
  if (typeof header !== 'string') return false;
  const normalizedEtag = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === normalizedEtag);
}

export async function sendArtwork(
  assetsDir: string,
  req: ArtworkRequest,
  reply: ArtworkReply,
  artwork: ArtworkFile,
  cacheControl: string,
): Promise<void> {
  // The resolver already knows the file's real format; the route only
  // chooses between it and a pre-generated display rendition.
  const selected = await resolveArtworkRendition(assetsDir, artwork, req.query.width);
  const stats = await stat(selected.absolutePath);
  const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;

  reply.header('ETag', etag).header('Cache-Control', cacheControl);
  if (matchesEtag(req.headers['if-none-match'], etag)) {
    reply.code(304);
    reply.send();
    return;
  }

  reply.header('Content-Type', selected.contentType);
  reply.send(await readFile(selected.absolutePath));
}
