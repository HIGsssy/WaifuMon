/**
 * Playwright configuration (plan §21 Phase 3, §22.9).
 *
 * The suite runs against a **production build**, served by `vite preview` —
 * not the dev server. That matters for two of the three specs:
 *
 *   - the accessibility spec checks colour contrast, which needs the real
 *     compiled stylesheet rather than jsdom's absence of one
 *   - the smoke spec proves the shipped bundle works, including route-level
 *     code splitting and the diagnostics route being absent
 *
 * Every API call is stubbed in the browser (`playwright/stubApi.ts`), so the
 * suite needs no database, no Discord client and no running bot. That is what
 * lets it run in CI.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './playwright',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Serialised in CI so the single preview server is not contended.
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // The plan's 375px baseline (§18) — every layout is designed here first.
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],

  webServer: {
    command: `npm run build:e2e && npx vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
