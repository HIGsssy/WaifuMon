/**
 * The `/dev-assets/*` development middleware, and the containment check that
 * decides what it may serve.
 *
 * Lives beside `vite.config.ts` rather than inside it so the security-relevant
 * part can be exercised by a test against a real temporary directory tree.
 *
 * **Containment mirrors the bot's `src/modules/assets/assetContainment.ts`**
 * (`isPathInside` / `resolveExistingAssetFile`) — same invariants, same order.
 * It is mirrored, not imported: the Portal is built from `portal/` alone (the
 * Docker build context holds nothing else) and ESLint forbids importing bot
 * source, so a shared import would break the image build. The two must agree:
 *
 *   1. the request is lexically inside the assets root
 *   2. the root's real (`realpath`) location is resolved
 *   3. the candidate's real location is resolved — every symlink followed
 *   4. the candidate's real location is inside the root's real location
 *   5. the candidate is a regular file
 *
 * A symlink that stays inside the assets root is served, exactly as production
 * serves it; one that leads outside — directly, through a symlinked directory,
 * or down a chain — is refused.
 */
import { createReadStream, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Content types the asset directory actually holds. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** Where the bot's artwork build (`npm run artwork:build`) writes its renditions. */
const THUMBNAIL_DIR = '.thumbnails';

/**
 * Formats an extensionless artwork request may resolve to, most preferred
 * first. Mirrors `SPECIES_ARTWORK_EXTENSIONS` in the bot's
 * `src/modules/assets/speciesArtworkFile.ts` — the Portal is a separate
 * package and cannot import it, but the two lists must agree.
 */
const ARTWORK_EXTENSIONS = ['.webp', '.png'];

/**
 * How long a browser may reuse artwork without asking.
 *
 * Five minutes plus revalidation, **not** `immutable`. These URLs are mutable
 * by design: an artist replaces `standard.png` in place and expects to see it.
 * `immutable` would be correct only for a content-addressed URL, and inventing
 * one here would trade a real workflow for a cache-hit rate that revalidation
 * already delivers — a 304 costs a round trip and zero bytes, which is the
 * whole problem worth solving when the payload is 4.5 MB.
 */
const ASSET_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

/** Weak validator from the facts a stat gives us. Enough to answer 304s. */
function entityTagFor(stats: { size: number; mtimeMs: number }): string {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

/**
 * True when `candidate` is `root` or lies beneath it. Segment-aware, so
 * `/assets2/x` is not inside `/assets`. Mirrors the bot's `isPathInside`.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // another drive/root altogether
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

export type ContainedFile =
  /** A regular file whose real location is inside the real assets root. */
  | { status: 'available'; realPath: string }
  /** Nothing servable: absent, a broken or looping link, a directory, … */
  | { status: 'missing' }
  /** Escapes the assets root — lexically, or through a symlink. */
  | { status: 'unsafe' };

/**
 * Whether the absolute `candidate` may be served from `root`. Never throws.
 *
 * Returns the candidate's *real* path, which is what the caller must open:
 * that is the location the check approved, not a name that may route through
 * a link.
 */
export function resolveContainedFile(root: string, candidate: string): ContainedFile {
  const lexicalRoot = path.resolve(root);
  const lexical = path.resolve(candidate);
  if (!isPathInside(lexicalRoot, lexical)) return { status: 'unsafe' };

  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(lexicalRoot);
  } catch {
    return { status: 'missing' }; // no assets directory at all
  }
  try {
    realFile = realpathSync(lexical);
  } catch {
    // ENOENT (including a broken symlink), ELOOP, ENOTDIR, EACCES, a NUL byte.
    return { status: 'missing' };
  }

  if (!isPathInside(realRoot, realFile)) return { status: 'unsafe' };

  try {
    if (!statSync(realFile).isFile()) return { status: 'missing' };
  } catch {
    return { status: 'missing' };
  }
  return { status: 'available', realPath: realFile };
}

/** What the middleware decided a request path names. */
export type DevAssetResolution =
  | { status: 'available'; realPath: string; contentType: string | undefined }
  | { status: 'missing' }
  | { status: 'unsafe' };

/**
 * Resolves a `/dev-assets`-relative request path (already percent-decoded,
 * query string removed) to the file to send.
 *
 *   - `/t/<width>/<asset>` prefers the pre-generated WebP under
 *     `<root>/.thumbnails/<width>/`, falling back to the original.
 *   - An extensionless original resolves WebP-first, then PNG — the same
 *     preference as the bot's species artwork.
 *
 * Every candidate is probed with {@link resolveContainedFile}, so an escaping
 * candidate is never chosen; as in production's `inspectSpeciesArtwork`, a
 * later safe candidate may still be. `unsafe` only when nothing was servable
 * and at least one candidate tried to escape.
 */
export function resolveDevAsset(root: string, requestPath: string): DevAssetResolution {
  const resolvedRoot = path.resolve(root);
  const candidates: string[] = [];

  const thumbnail = /^\/t\/(\d+)\/(.+)$/.exec(requestPath);
  if (thumbnail) {
    const [, width, rest] = thumbnail as unknown as [string, string, string];
    const webp = rest.replace(/\.[^./]+$/, '') + '.webp';
    candidates.push(path.resolve(resolvedRoot, THUMBNAIL_DIR, width, webp));
  }

  // A size request falls back to the original asset, so strip the prefix
  // before resolving: `/t/512/waifumon/x/standard` → `/waifumon/x/standard`.
  const originalPath = requestPath.replace(/^\/t\/\d+\//, '/');
  const original = path.resolve(resolvedRoot, `.${originalPath}`);
  candidates.push(original);
  if (path.extname(original) === '') {
    candidates.push(...ARTWORK_EXTENSIONS.map((ext) => original + ext));
  }

  let unsafe = false;
  for (const candidate of candidates) {
    const found = resolveContainedFile(resolvedRoot, candidate);
    if (found.status === 'available') {
      // The type comes from the name asked for — the file actually sent.
      const contentType = CONTENT_TYPES[path.extname(candidate).toLowerCase()];
      return { status: 'available', realPath: found.realPath, contentType };
    }
    if (found.status === 'unsafe') unsafe = true;
  }
  return unsafe ? { status: 'unsafe' } : { status: 'missing' };
}

/**
 * The connect handler mounted at `/dev-assets`. `req.url` is relative to the
 * mount point. Browser-facing errors are fixed strings: no resolved path, no
 * filesystem error text.
 */
export function createDevAssetsHandler(
  root: string,
  warn: (message: string) => void = () => {},
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    let requestPath: string;
    try {
      requestPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    } catch {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    const resolution = resolveDevAsset(root, requestPath);

    if (resolution.status === 'unsafe') {
      // The request is the developer's own input; the escaping target is not
      // named, so the log carries nothing the request did not.
      warn(`[dev-assets] refused ${JSON.stringify(requestPath)}: outside the assets root`);
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    if (resolution.status === 'missing') {
      next();
      return;
    }

    let stats;
    try {
      stats = statSync(resolution.realPath);
    } catch {
      next();
      return;
    }

    const etag = entityTagFor(stats);
    const lastModified = new Date(stats.mtimeMs).toUTCString();

    res.setHeader('Cache-Control', ASSET_CACHE_CONTROL);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', lastModified);

    // `If-None-Match` wins over `If-Modified-Since` per RFC 9110 — the
    // entity tag is the stronger statement about what the client holds.
    const noneMatch = req.headers['if-none-match'];
    const modifiedSince = req.headers['if-modified-since'];
    const fresh = noneMatch
      ? noneMatch === etag
      : modifiedSince !== undefined &&
        Math.floor(stats.mtimeMs / 1000) <= Math.floor(Date.parse(modifiedSince) / 1000);

    if (fresh) {
      res.statusCode = 304;
      res.end();
      return;
    }

    if (resolution.contentType) res.setHeader('Content-Type', resolution.contentType);
    res.setHeader('Content-Length', String(stats.size));
    const stream = createReadStream(resolution.realPath);
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = 404;
      res.end();
    });
    stream.pipe(res);
  };
}

/**
 * Serves the bot repo's `assets/` folder at `/dev-assets/*`.
 *
 * Deliberately not `publicDir` and deliberately not a copy: the repo's assets
 * directory is the single source of truth for artwork, and duplicating ~50
 * species folders into `portal/public/` would drift the first time an artist
 * replaces a PNG.
 *
 * Two things beyond "stream the file", both of which exist because the source
 * art averages 4.5 MB and shares an HTTP/1.1 origin with the Platform API
 * proxy — so every avoidable image byte is a connection the API is not waiting
 * behind:
 *
 *  1. **Validators.** This used to send `Cache-Control: no-cache` with no ETag
 *     and no Last-Modified, which is the worst of both worlds: the browser
 *     revalidated every time and, having nothing to revalidate *with*, was
 *     handed the full body again on every navigation. With an ETag the same
 *     request becomes a 304 and no bytes move.
 *  2. **Size renditions.** `/dev-assets/t/<width>/<asset>` serves the
 *     pre-generated WebP under `<assets>/.thumbnails/<width>/`, falling back to
 *     the original when one has not been generated. The Content-Type comes from
 *     whatever is actually sent, so the fallback cannot mislabel itself and the
 *     Portal works identically before and after the script is run.
 *
 * Artwork is requested without an extension and resolved WebP-first (see
 * `resolveDevAsset`), so converting a PNG to WebP needs no Portal change.
 */
export function devAssets(root: string): Plugin {
  return {
    name: 'waifumon-dev-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(
        '/dev-assets',
        createDevAssetsHandler(root, (message) => server.config.logger.warn(message)),
      );
    },
  };
}
