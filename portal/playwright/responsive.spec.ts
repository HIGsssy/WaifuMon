/**
 * Responsive audit (plan §18, §21 Phase 3).
 *
 * The plan asks for a manual pass at 375 / 640 / 768 / 1024 / 1440 to catch
 * layout shift and overflow. This is that pass, mechanised — a human eye is
 * better at judging *taste*, but a browser is far better at noticing that a
 * card grid is four pixels too wide at 768.
 *
 * Three properties are checked at every breakpoint:
 *
 *   1. **No horizontal overflow.** The page body never scrolls sideways; wide
 *      content (tables, filter rows) scrolls inside its own container.
 *   2. **Navigation is reachable.** Sidebar above `lg`, drawer below it — one
 *      or the other, never neither.
 *   3. **Touch targets are large enough** on the phone baseline (≥ 44px, §18).
 */
import { expect, test, type Page } from '@playwright/test';

import { stubApi } from './stubApi';

const BREAKPOINTS: ReadonlyArray<{ name: string; width: number; height: number }> = [
  { name: '375 (phone)', width: 375, height: 812 },
  { name: '640 (sm)', width: 640, height: 900 },
  { name: '768 (tablet)', width: 768, height: 1024 },
  { name: '1024 (lg)', width: 1024, height: 900 },
  { name: '1440 (desktop)', width: 1440, height: 900 },
];

const PAGES = [
  '/dashboard',
  '/collection',
  '/collection/101',
  '/buddy',
  '/inventory',
  '/shop',
  '/encyclopedia',
  '/guide',
  '/profile',
  '/settings',
];

/** How far the document scrolls sideways. Should always be zero. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollWidth - doc.clientWidth);
  });
}

/**
 * Elements wider than the viewport that are *not* inside a horizontal scroll
 * container. A table that scrolls in its own box is fine; a card grid that
 * pushes the page sideways is not.
 */
async function unscrollableOverflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const offenders: string[] = [];

    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= viewport + 1) continue;

      // Walk up looking for something that scrolls this content on purpose.
      let node: HTMLElement | null = element;
      let contained = false;
      while (node) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden') {
          contained = true;
          break;
        }
        node = node.parentElement;
      }

      if (!contained) {
        offenders.push(
          `${element.tagName.toLowerCase()}.${element.className.toString().split(' ').slice(0, 3).join('.')} (${Math.round(rect.width)}px)`,
        );
      }
    }
    return [...new Set(offenders)].slice(0, 5);
  });
}

test.describe('responsive layout', () => {
  // One project is enough; the viewport is set explicitly per case.
  test.skip(({ browserName }) => browserName !== 'chromium', 'viewport audit runs once');

  for (const breakpoint of BREAKPOINTS) {
    test(`no horizontal overflow at ${breakpoint.name}`, async ({ page }) => {
      await stubApi(page);
      await page.setViewportSize({ width: breakpoint.width, height: breakpoint.height });

      for (const url of PAGES) {
        await page.goto(url);
        await page.waitForLoadState('networkidle');

        expect(await horizontalOverflow(page), `${url} scrolls sideways`).toBe(0);
        expect(
          await unscrollableOverflowingElements(page),
          `${url} has content wider than the viewport outside a scroll container`,
        ).toEqual([]);
      }
    });
  }

  test('navigation is reachable at every breakpoint', async ({ page }) => {
    await stubApi(page);

    for (const breakpoint of BREAKPOINTS) {
      await page.setViewportSize({ width: breakpoint.width, height: breakpoint.height });
      await page.goto('/dashboard');

      const sidebarVisible = await page
        .getByRole('navigation', { name: 'Primary' })
        .first()
        .isVisible();
      const drawerVisible = await page.getByRole('button', { name: 'Open navigation' }).isVisible();

      expect(
        sidebarVisible || drawerVisible,
        `no navigation affordance at ${breakpoint.name}`,
      ).toBe(true);
    }
  });

  test('interactive controls meet the 44px touch target on the phone baseline', async ({
    page,
  }) => {
    await stubApi(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/collection');
    await page.waitForLoadState('networkidle');

    const undersized = await page.evaluate(() => {
      const offenders: string[] = [];
      const controls = document.querySelectorAll<HTMLElement>(
        'button:not([aria-pressed]), input, select, [role="combobox"]',
      );
      for (const control of Array.from(controls)) {
        const rect = control.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue; // not rendered
        if (rect.height < 44) {
          offenders.push(`${control.tagName.toLowerCase()} (${Math.round(rect.height)}px tall)`);
        }
      }
      return [...new Set(offenders)];
    });

    expect(undersized).toEqual([]);
  });

  test('the collection grid gains columns as the viewport widens', async ({ page }) => {
    await stubApi(page);

    async function columnCount(): Promise<number> {
      return page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>('main .grid');
        if (!grid) return 0;
        return getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      });
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/collection');
    await page.waitForLoadState('networkidle');
    const phone = await columnCount();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(100);
    const desktop = await columnCount();

    // §18: 2 columns on a phone rising to 4–5 on a wide display.
    expect(phone).toBe(2);
    expect(desktop).toBeGreaterThanOrEqual(4);
  });
});
