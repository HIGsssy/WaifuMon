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

/**
 * Serves the bot repo's `assets/` folder at `/dev-assets/*`.
 *
 * Deliberately not `publicDir` and deliberately not a copy: the repo's assets
 * directory is the single source of truth for artwork, and duplicating ~50
 * species folders into `portal/public/` would drift the first time an artist
 * replaces a PNG.
 */
function devAssets(root: string): Plugin {
  const resolvedRoot = path.resolve(root);
  return {
    name: 'waifumon-dev-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/dev-assets', (req, res, next) => {
        const raw = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
        const target = path.resolve(resolvedRoot, `.${raw}`);

        // Containment check — a `..` segment must not escape the assets root.
        if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        let isFile = false;
        try {
          isFile = statSync(target).isFile();
        } catch {
          isFile = false;
        }
        if (!isFile) {
          next();
          return;
        }

        const type = CONTENT_TYPES[path.extname(target).toLowerCase()];
        if (type) res.setHeader('Content-Type', type);
        // Dev-only: artwork is replaced by hand, so revalidate rather than cache hard.
        res.setHeader('Cache-Control', 'no-cache');
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
      },
    },
  };
});
