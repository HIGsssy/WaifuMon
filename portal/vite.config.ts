/**
 * Portal dev server + build config.
 *
 * Three things happen here that the rest of the app depends on:
 *
 *  1. `/api/*` is proxied to the Platform API so the browser makes same-origin
 *     requests and CORS never enters the picture in dev (plan §20). `/health`
 *     and `/ready` are proxied too — they live at the API server's root, not
 *     under `/api/v1`, and the diagnostics page probes `/ready` (§23).
 *  2. `/dev-assets/*` is served straight out of the repo's `assets/` directory
 *     (Further Considerations #4: proxy, don't copy — one source, no drift).
 *     Dev only; the local-dev-assets image provider is the only consumer.
 *  3. `__APP_VERSION__` is defined from the Portal's package version so the
 *     diagnostics page can report a build identity without importing JSON.
 */
import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
// `defineConfig` comes from vitest so the `test` block is typed alongside the
// Vite options; everything else is plain Vite.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

const appVersion = (
  JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')) as { version: string }
).version;

/** Content types the asset directory actually holds. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

// (see `devAssets` below for the caching and size-rendition behaviour)

/** Where `scripts/generate-thumbnails.mjs` writes its renditions. */
const THUMBNAIL_DIR = '.thumbnails';

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

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
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
 */
function devAssets(root: string): Plugin {
  const resolvedRoot = path.resolve(root);

  /**
   * `/t/512/waifumon/x/standard.png` → the thumbnail path, if one exists.
   *
   * The `/t/<width>/` shape is produced by the `localDevAssets` image provider
   * (`src/images/providers/localDevAssets.ts`); the two must agree.
   */
  function thumbnailFor(requestPath: string): string | null {
    const match = /^\/t\/(\d+)\/(.+)$/.exec(requestPath);
    if (!match) return null;

    const [, width, rest] = match as unknown as [string, string, string];
    const webp = rest.replace(/\.[^./]+$/, '') + '.webp';
    const candidate = path.resolve(resolvedRoot, THUMBNAIL_DIR, width, webp);

    if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) return null;
    return isFile(candidate) ? candidate : null;
  }

  return {
    name: 'waifumon-dev-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/dev-assets', (req, res, next) => {
        const raw = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');

        // A size request falls back to the original asset, so strip the prefix
        // before resolving: `/t/512/waifumon/x.png` → `/waifumon/x.png`.
        const originalPath = raw.replace(/^\/t\/\d+\//, '/');
        const target = thumbnailFor(raw) ?? path.resolve(resolvedRoot, `.${originalPath}`);

        // Containment check — a `..` segment must not escape the assets root.
        if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        let stats;
        try {
          stats = statSync(target);
        } catch {
          next();
          return;
        }
        if (!stats.isFile()) {
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

        const type = CONTENT_TYPES[path.extname(target).toLowerCase()];
        if (type) res.setHeader('Content-Type', type);
        res.setHeader('Content-Length', String(stats.size));
        createReadStream(target).pipe(res);
      });
    },
  };
}

/** Prints the effective proxy target once, so a misconfigured port is obvious (§26). */
function announceProxy(target: string, assetsDir: string): Plugin {
  return {
    name: 'waifumon-announce-proxy',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        server.config.logger.info(
          `\n  portal  Platform API proxy -> ${target}\n  portal  /dev-assets -> ${assetsDir}\n`,
        );
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, 'VITE_');
  const apiTarget = env.VITE_PLATFORM_API_PROXY_TARGET || 'http://127.0.0.1:3120';
  // Default: the sibling bot repo's assets folder (`portal/` lives beside it).
  const assetsDir = env.VITE_DEV_ASSETS_PATH
    ? path.resolve(here, env.VITE_DEV_ASSETS_PATH)
    : path.resolve(here, '..', 'assets');

  return {
    plugins: [react(), tailwindcss(), devAssets(assetsDir), announceProxy(apiTarget, assetsDir)],
    resolve: {
      alias: { '@': path.resolve(here, 'src') },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        // Root-level ops endpoints on the API server — used by §23 diagnostics.
        '/ready': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      // Every feature route is a lazy chunk (§15); keep the warning honest.
      chunkSizeWarningLimit: 700,
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      css: false,
      restoreMocks: true,
      include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
      // A fixed env so `portalEnv` is deterministic. Tests that need a
      // different value re-import the module after `vi.stubEnv`.
      env: {
        VITE_PLATFORM_API_URL: '/api',
        VITE_PLATFORM_API_TOKEN: 'test-token',
        VITE_DEFAULT_PLAYER_ID: '1',
        // Pre-fills the developer-login form's guild field, which is the
        // behaviour the login tests assert. Matches `msw/fixtures.ts`.
        VITE_DEFAULT_DISCORD_GUILD_ID: '987654321098765432',
      },
    },
  };
});
