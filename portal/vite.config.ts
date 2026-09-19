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
 *     The middleware and its symlink-aware containment live in
 *     `vite/devAssets.ts`.
 *  3. `__APP_VERSION__` is defined from the Portal's package version so the
 *     diagnostics page can report a build identity without importing JSON.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
// `defineConfig` comes from vitest so the `test` block is typed alongside the
// Vite options; everything else is plain Vite.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';

import { devAssets } from './vite/devAssets';

const here = path.dirname(fileURLToPath(import.meta.url));

const appVersion = (
  JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')) as { version: string }
).version;

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
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        /*
         * The proxy attaches the bearer token.
         *
         * The API accepts exactly one credential — `Authorization: Bearer …` —
         * and deliberately has no cookie auth (no cookies, no CSRF surface).
         * That is fine for `fetch`, which sets its own headers, but an `<img>`
         * element cannot send one. Rendered cards are `<img>` sources, so
         * without this they would 401 and the whole image abstraction would
         * have to be bypassed for one asset kind.
         *
         * This leaks nothing new: `VITE_PLATFORM_API_TOKEN` is already in the
         * client bundle by design (dev-only, §26). Attaching it here is
         * strictly better than the alternatives — a token in the query string
         * would reach browser history and server logs, and weakening the card
         * route's auth is not on the table.
         *
         * Axios sets the same header itself, and the proxy's value simply
         * replaces it with an identical one. When no token is configured the
         * proxy adds nothing and behaves exactly as it did before.
         */
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          ...(env.VITE_PLATFORM_API_TOKEN
            ? { headers: { Authorization: `Bearer ${env.VITE_PLATFORM_API_TOKEN}` } }
            : {}),
        },
        '/auth': { target: apiTarget, changeOrigin: true },
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
