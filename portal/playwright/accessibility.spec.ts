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
