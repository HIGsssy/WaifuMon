/**
 * Real-browser accessibility pass (plan §17, §21 Phase 3).
 *
 * The component suite already runs axe over every page, but jsdom cannot
 * compute colour, so `color-contrast` is disabled there. This spec closes that
 * gap: it runs the same rule set **with contrast enabled** against the
 * production build, in both themes — which is the only way to know the palette
 * in §17 actually clears AA.
 *
 * axe-core is injected from `node_modules` rather than a CDN, so the suite has
 * no network dependency.
 */
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

import { systemMetricsReport } from '../msw/fixtures';
import { stubApi } from './stubApi';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ html: string; failureSummary?: string }>;
}

async function analyse(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (window as any).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return results.violations as AxeViolation[];
  });
}

function format(violations: AxeViolation[]): string {
  return violations
    .map(
      (violation) =>
        `[${violation.impact}] ${violation.id}: ${violation.help}\n` +
        violation.nodes
          .slice(0, 3)
          .map((node) => `    ${node.html}\n    ${node.failureSummary ?? ''}`)
          .join('\n'),
    )
    .join('\n\n');
}

const PAGES = [
  '/dashboard',
  '/collection',
  '/collection/101',
  '/buddy',
  '/inventory',
  '/shop',
  '/encyclopedia',
  '/encyclopedia/void_empress',
  '/guide',
  '/profile',
  '/settings',
  '/achievements',
  '/leaderboards',
  // Admin — Waifumon Gallery (the e2e session holds gallery.read).
  '/admin/gallery',
  '/admin/gallery/neon_kitsune',
  '/admin/gallery/star_marshal',
  // Admin — System Metrics (owner-only; the e2e owner profile holds it). The
  // one page using the success/warning status tokens, so this is where their
  // contrast is actually measured.
  '/admin/system',
];

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await stubApi(page);
      // The theme provider reads this before first paint.
      await page.addInitScript((value) => {
        localStorage.setItem('waifumon-portal:theme', value);
      }, theme);
    });

    for (const url of PAGES) {
      test(`${url} has no WCAG A/AA violations, contrast included`, async ({ page }) => {
        await page.goto(url);
        await page.waitForLoadState('networkidle');
        // Guard against auditing the sign-in screen instead of the page.
        await expect(page, `${url} did not reach an authenticated page`).not.toHaveURL(
          /\/select-player/,
        );

        const violations = await analyse(page);
        expect(violations, format(violations)).toEqual([]);
      });
    }
  });
}

test.describe('keyboard navigation', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
  });

  test('a keyboard user can skip the nav and reach the content', async ({ page }) => {
    await page.goto('/dashboard');

    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('focus rings are visible on every interactive control', async ({ page }) => {
    await page.goto('/collection');
    await page.waitForLoadState('networkidle');

    // Walk the first dozen focus stops and confirm each paints an outline.
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      const hasVisibleRing = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || element === document.body) return true;
        const style = getComputedStyle(element);
        const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
        const ring = style.boxShadow !== 'none';
        return outline || ring;
      });
      expect(hasVisibleRing).toBe(true);
    }
  });

  test('a card can be opened with the keyboard alone', async ({ page }) => {
    await page.goto('/collection');
    await page.waitForLoadState('networkidle');

    await page.getByRole('link', { name: /Nyx/ }).focus();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/collection\/101$/);
  });
});

/**
 * System Metrics is the one page whose colours depend on live data: the
 * Elevated / Critical badges, the danger banner and the desaturated
 * last-known-values state only render when something is wrong. The URL sweep
 * above sees a healthy fixture, so these states would otherwise never have
 * their contrast measured at all.
 */
test.describe('System Metrics under stress', () => {
  function stressedReport() {
    const r = systemMetricsReport(new Date().toISOString());
    r.eventLoop.recent.utilization = 0.8; // warn
    r.database.pool = { totalCount: 10, idleCount: 0, waitingCount: 3, max: 10 }; // critical
    r.cards.workers = { ...r.cards.workers, active: 2, queued: 1 }; // warn
    r.http.recent.counts = { ...r.http.recent.counts, serverErrors: 2 }; // warn
    r.system.host.loadPerCore = 1.4; // warn
    r.system.host.pressure.io = { someAvg10: 12, someAvg60: 8, fullAvg10: 3, fullAvg60: 1 }; // warn
    r.system.cgroup.oomKills = 1; // critical
    return r;
  }

  for (const theme of ['dark', 'light'] as const) {
    test(`${theme}: warn and critical readings meet contrast`, async ({ page }) => {
      await stubApi(page);
      await page.route('**/api/v1/admin/system/metrics', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: stressedReport(), meta: { requestId: 'e2e' } }),
        }),
      );
      await page.addInitScript((value) => localStorage.setItem('waifumon-portal:theme', value), theme);
      await page.goto('/admin/system');
      await expect(page.getByText('Critical').first()).toBeVisible();
      await expect(page.getByText('Elevated').first()).toBeVisible();

      const violations = await analyse(page);
      expect(violations, format(violations)).toEqual([]);
    });

    test(`${theme}: the unavailable state over last-known data meets contrast`, async ({ page }) => {
      await stubApi(page);
      let calls = 0;
      await page.route('**/api/v1/admin/system/metrics', (route) => {
        calls += 1;
        return calls === 1
          ? route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ data: stressedReport(), meta: { requestId: 'e2e' } }),
            })
          : route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({
                error: { code: 'INTERNAL_ERROR', message: 'Internal error.' },
                requestId: 'e2e',
              }),
            });
      });
      await page.addInitScript((value) => localStorage.setItem('waifumon-portal:theme', value), theme);
      await page.goto('/admin/system');
      // The page polls every 5 s; the second poll fails and the banner appears.
      await expect(page.getByText('Unable to retrieve metrics.')).toBeVisible({ timeout: 12_000 });
      await expect(page.getByTestId('metrics-body')).toHaveAttribute('data-current', 'false');

      const violations = await analyse(page);
      expect(violations, format(violations)).toEqual([]);
    });
  }
});
