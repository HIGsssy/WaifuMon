/**
 * End-to-end smoke test (plan §22.9, §21 Phase 3).
 *
 * The journey the plan names: startup → dashboard → collection → detail →
 * back. Run against a production build, so it also proves the shipped bundle
 * boots, splits its routes, and resolves a session.
 *
 * Two extra assertions ride along because they are cheap here and expensive to
 * check any other way:
 *
 *   - the diagnostics route is genuinely absent from a production build (§24.16)
 *   - the app issues no non-GET request during a full walk (§24.6)
 */
import { expect, test } from '@playwright/test';

import { stubApi } from './stubApi';

test.beforeEach(async ({ page }) => {
  await stubApi(page);
});

test('startup → dashboard → collection → detail → back', async ({ page }) => {
  await page.goto('/');

  // The index route redirects, and the session resolves from the env value.
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  // The hero, not the header: the header's name is hidden below `sm` by design
  // (§18), so asserting on it would fail on the phone project for a good reason.
  await expect(page.getByRole('heading', { name: 'Mika', level: 2 })).toBeVisible();
  await expect(page.getByText('Level 12')).toBeVisible();

  // Balances and dex progress land.
  await expect(page.getByText('1,820')).toBeVisible();
  await expect(page.getByText('3 / 50')).toBeVisible();

  // Navigate to the Collection. On mobile the nav lives behind the drawer.
  const drawerTrigger = page.getByRole('button', { name: 'Open navigation' });
  if (await drawerTrigger.isVisible()) {
    await drawerTrigger.click();
  }
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Collection' })
    .click();

  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole('heading', { name: 'Collection', level: 1 })).toBeVisible();

  const card = page.getByRole('link', { name: /Nyx/ });
  await expect(card).toBeVisible();

  // Card → detail.
  await card.click();
  await expect(page).toHaveURL(/\/collection\/101$/);
  await expect(page.getByRole('heading', { name: 'Nyx', level: 1 })).toBeVisible();
  await expect(page.getByText('Progression')).toBeVisible();
  // Honest placeholders rather than fabricated stats (§16).
  await expect(page.getByText(/combat is not modelled/i)).toBeVisible();

  // …and back.
  await page.getByRole('link', { name: 'Back to Collection' }).click();
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole('link', { name: /Nyx/ })).toBeVisible();
});

test('every page in the site map renders in the production build', async ({ page }) => {
  const pages: Array<[string, string]> = [
    ['/dashboard', 'Dashboard'],
    ['/collection', 'Collection'],
    ['/buddy', 'Buddy'],
    ['/inventory', 'Inventory'],
    ['/shop', 'Shop'],
    ['/encyclopedia', 'Encyclopedia'],
    ['/guide', 'Game Guide'],
    ['/profile', 'Trainer Profile'],
    ['/settings', 'Settings'],
    ['/achievements', 'Achievements'],
    ['/events', 'Events'],
    ['/friends', 'Friends'],
  ];

  for (const [url, heading] of pages) {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
});

test('the diagnostics route is absent from a production build', async ({ page }) => {
  await page.goto('/__dev/diagnostics');

  // Not merely unlinked — the route is never registered, so it 404s.
  await expect(page.getByText('Page not found')).toBeVisible();
  await expect(page.getByText('Developer diagnostics')).toHaveCount(0);
});

test('the Portal issues no write request during a full walk', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
  });

  for (const url of [
    '/dashboard',
    '/collection',
    '/collection/101',
    '/buddy',
    '/inventory',
    '/shop',
  ]) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
  }

  expect(writes).toEqual([]);
});

test('the collection filter lives in the URL and survives reload', async ({ page }) => {
  await page.goto('/collection?rarity=UR');
  await expect(page.getByRole('link', { name: /Nyx/ })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/rarity=UR/);
  await expect(page.getByRole('link', { name: /Nyx/ })).toBeVisible();
});
