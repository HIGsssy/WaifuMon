/**
 * The Enemy Catalogue package import, end to end in a real browser at desktop
 * and phone width: the review always ends in a visible Apply Import, whatever
 * the package needs, and the apply request carries the reviewed plan. A kept
 * conflict with nothing new used to end the workflow with no action at all.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

import type { EnemyImportEntry, EnemyImportPreview, EnemyImportResult, EnemySlotPlan } from '@/api/adminEnemies';

import { stubApi } from './stubApi';

const ZIP = { name: 'enemies.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') };
const none: EnemySlotPlan = { source: 'none', destination: { kind: 'none' }, notes: [] };
const entry = (key: string, name: string, outcome: EnemyImportEntry['outcome'], used = false): EnemyImportEntry => ({
  key,
  name,
  outcome,
  changedFields: outcome === 'update' || outcome === 'conflict' ? ['hp'] : [],
  activation: null,
  references: used ? [{ kind: 'dungeon_zone', key: 'hall', name: 'The Hall', usage: 'room "Hall"' }] : [],
  issues: [],
  artwork: none,
  sprite: none,
});
function plan(entries: EnemyImportEntry[]): EnemyImportPreview {
  const counts = { create: 0, update: 0, conflict: 0, unchanged: 0, invalid: 0 };
  for (const e of entries) counts[e.outcome] += 1;
  return {
    package: { format: 'waifumon-enemy-package', version: 1, exportedAt: '2026-10-29T12:00:00.000Z', scope: 'selected', sourceEnvironment: 'staging', packageHash: 'abc', warnings: [] },
    entries,
    assets: [],
    counts,
    decisionKeys: entries.filter((e) => e.outcome === 'update' || e.outcome === 'conflict').map((e) => e.key).sort(),
    ok: true,
    planHash: 'sha256:reviewed-plan',
  };
}
const RECEIPT: EnemyImportResult = { importId: 7, requestId: 'r', replayed: false, created: [], updated: [], skipped: [], unchanged: [], assets: { created: [], reused: [] } };
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Long enough that the end of the review is far below the fold at either width. */
const LARGE = [
  ...Array.from({ length: 20 }, (_, i) => entry(`same_${i}`, `Same ${i}`, 'unchanged')),
  entry('fresh', 'Fresh', 'create'),
  entry('tuned', 'Tuned', 'update'),
  entry('guard', 'Guard', 'conflict', true),
];

async function open(
  page: Page,
  review: EnemyImportPreview,
  answer: (route: Route) => Promise<void> = (route) => json(route, 200, { data: RECEIPT }),
  permissions = ['enemies.read', 'enemies.write', 'artwork.read', 'artwork.write'],
) {
  await stubApi(page, { session: { permissions } });
  const applied: URL[] = [];
  await page.route('**/api/v1/admin/enemies/import/preview', (route) => json(route, 200, { data: review }));
  await page.route('**/api/v1/admin/enemies/import/apply*', (route) => {
    applied.push(new URL(route.request().url()));
    return answer(route);
  });
  await page.goto('/admin/enemies/import');
  await page.getByLabel('Enemy package file').setInputFiles(ZIP);
  await expect(page.getByTestId('enemy-import-preview')).toBeVisible();
  return applied;
}
const applyButton = (page: Page) => page.getByRole('button', { name: 'Apply Import' });
const confirmImport = (page: Page) => page.getByTestId('enemy-import-confirm').getByRole('button', { name: 'Confirm import' });

test('the action is on screen throughout a long review, and applies the reviewed plan', async ({ page }) => {
  const applied = await open(page, plan(LARGE), (route) =>
    json(route, 200, { data: { ...RECEIPT, created: ['fresh'], updated: ['guard'], skipped: ['tuned'], unchanged: LARGE.slice(0, 20).map((e) => e.key) } }),
  );

  // Before any decision: visible at the top of a long page, disabled, and says exactly why.
  await expect(applyButton(page)).toBeInViewport();
  await expect(applyButton(page)).toBeDisabled();
  await expect(page.getByTestId('enemy-import-undecided')).toHaveText(/2 enemies before applying: Guard, Tuned\./);
  await expect(page.getByTestId('enemy-import-undecided')).toBeInViewport();

  await page.getByRole('button', { name: 'Go to next decision' }).click();
  await expect(page.getByRole('radio', { name: 'Update Guard' })).toBeFocused();
  await expect(page.getByRole('radio', { name: 'Update Guard' })).toBeInViewport();
  await page.getByRole('radio', { name: 'Update Guard' }).check();
  await expect(page.getByTestId('enemy-import-undecided')).toHaveText(/1 enemy before applying: Tuned\./);
  await page.getByRole('radio', { name: 'Keep Existing Tuned' }).check();

  // The last decision enables it where the admin is already looking.
  await expect(applyButton(page)).toBeEnabled();
  await expect(applyButton(page)).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(applied).toHaveLength(0);

  await applyButton(page).click();
  await expect(page.getByTestId('enemy-import-confirm')).toContainText('1 kept as they are: Tuned');
  await expect(confirmImport(page)).toBeInViewport();
  expect(applied).toHaveLength(0);
  await confirmImport(page).dblclick();

  const result = page.getByTestId('enemy-import-result');
  await expect(result).toContainText('1 new, 1 updated, 1 kept as they were, 20 unchanged');
  await expect(result).toBeInViewport();
  expect(applied).toHaveLength(1);
  const { searchParams } = applied[0]!;
  expect(searchParams.get('expectedPlanHash')).toBe('sha256:reviewed-plan');
  // `decisionKeys` order: guard, tuned.
  expect(searchParams.get('decisions')).toBe('us');
  expect(searchParams.get('requestId')).toMatch(/^[0-9a-f-]{36}$/);

  await result.getByRole('link', { name: 'Back to Enemy Catalogue' }).click();
  await expect(page).toHaveURL(/\/admin\/enemies$/);
});

test('keeping every conflict with nothing new still completes', async ({ page }) => {
  const applied = await open(page, plan([entry('tuned', 'Tuned', 'update'), entry('guard', 'Guard', 'conflict', true), entry('same', 'Same', 'unchanged')]), (route) =>
    json(route, 200, { data: { ...RECEIPT, skipped: ['guard', 'tuned'], unchanged: ['same'] } }),
  );
  await page.getByRole('radio', { name: 'Keep Existing Guard' }).check();
  await page.getByRole('radio', { name: 'Keep Existing Tuned' }).check();
  await expect(page.getByTestId('enemy-import-nothing')).toContainText('no enemy will change');
  await applyButton(page).click();
  await confirmImport(page).click();
  await expect(page.getByTestId('enemy-import-result')).toContainText('2 kept as they were, 1 unchanged');
  expect(applied[0]!.searchParams.get('decisions')).toBe('ss');
});

test('an all-new package needs only Apply Import and its confirmation', async ({ page }) => {
  const applied = await open(page, plan([entry('fresh', 'Fresh', 'create')]), (route) =>
    json(route, 200, { data: { ...RECEIPT, created: ['fresh'] } }),
  );
  await expect(applyButton(page)).toBeEnabled();
  await expect(applyButton(page)).toBeInViewport();
  await applyButton(page).click();
  await confirmImport(page).click();
  await expect(page.getByTestId('enemy-import-result')).toContainText('1 new');
  expect(applied[0]!.searchParams.get('decisions')).toBe('');
});

test('a stale plan is refused on screen, and Check again starts a fresh review', async ({ page }) => {
  const applied = await open(page, plan([entry('fresh', 'Fresh', 'create')]), (route) =>
    json(route, 409, { error: { code: 'ENEMY_IMPORT_STALE', message: 'The catalogue changed.' }, requestId: 'e2e' }),
  );
  await applyButton(page).click();
  await confirmImport(page).click();
  await expect(page.getByTestId('enemy-import-stale')).toBeInViewport();
  await expect(page.getByTestId('enemy-import-result')).toHaveCount(0);
  await expect(applyButton(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByTestId('enemy-import-stale')).toHaveCount(0);
  await expect(applyButton(page)).toBeEnabled();
  expect(applied).toHaveLength(1);
});

test('without artwork.write the block is explained and no request is sent', async ({ page }) => {
  const applied = await open(page, plan([entry('fresh', 'Fresh', 'create')]), undefined, ['enemies.read', 'enemies.write']);
  await expect(page.getByTestId('enemy-import-no-permission')).toBeInViewport();
  await expect(applyButton(page)).toBeDisabled();
  expect(applied).toHaveLength(0);
});
