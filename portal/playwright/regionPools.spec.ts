/**
 * Region Pools in a real browser, against `regionPoolBackend.ts` — whose
 * issues come from the server's validator and whose odds come from the
 * server's analyser over the shipped rarity table. Runs on the desktop and the
 * 375px-class mobile project.
 */
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';

import { RegionPoolBackend, type FakeRegion, type FakeSpecies } from './regionPoolBackend';
import { stubApi } from './stubApi';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const S = (
  slug: string,
  name: string,
  rarity: string,
  extra: Partial<FakeSpecies> = {},
): FakeSpecies => ({
  slug,
  name,
  rarity,
  enabled: true,
  tags: [],
  race: 'human',
  affinity: 'dominant',
  ...extra,
});

const SPECIES: FakeSpecies[] = [
  S('cafe_maid', 'Cafe Maid', 'N'),
  S('alley_cat', 'Alley Catgirl', 'N', { race: 'demi-human' }),
  S('shrine_girl', 'Shrine Assistant', 'R', { affinity: 'caregiver' }),
  S('sr_idol', 'Stage Idol', 'SR'),
  S('sr_nurse', 'Night Nurse', 'SR', { affinity: 'caregiver' }),
  S('ssr_knight', 'Rose Knight', 'SSR', { race: 'valkyrie' }),
  S('ur_witch', 'Moon Witch', 'UR', { race: 'spirit' }),
  S('lr_queen', 'Peak Queen', 'LR', { tags: ['region_exclusive'] }),
  S('ex_goddess', 'Ex Goddess', 'EX', { race: 'angel' }),
  S('valley_n', 'Valley Farmhand', 'N'),
  S('valley_lr', 'Valley Legend', 'LR'),
  S('belt_empress', 'Belt Empress', 'LR', { tags: ['region_exclusive'], race: 'android' }),
  S('delve_wraith', 'Delve Wraith', 'SR', { tags: ['dungeon_exclusive'], race: 'demon' }),
  S('new_r', 'Fresh Recruit', 'R'),
];

const REGIONS: FakeRegion[] = [
  { id: 'waifu-valley', name: 'Waifu Valley', released: true, isDefault: true, shipped: null },
  {
    id: 'twin-peeks',
    name: 'Twin Peeks',
    released: true,
    isDefault: false,
    shipped: [
      { species: 'cafe_maid', weight: 2 },
      { species: 'shrine_girl', weight: 1 },
      { species: 'new_r', weight: 4 },
    ],
  },
  {
    id: 'assteroid-belt',
    name: 'Assteroid Belt',
    released: false,
    isDefault: false,
    shipped: null,
  },
];

const PEAKS = [
  { species: 'cafe_maid', weight: 3 },
  { species: 'alley_cat', weight: 1 },
  { species: 'shrine_girl', weight: 1 },
  { species: 'sr_idol', weight: 3 },
  { species: 'sr_nurse', weight: 1 },
  { species: 'ssr_knight', weight: 1 },
  { species: 'ur_witch', weight: 1 },
  { species: 'lr_queen', weight: 1 },
  { species: 'ex_goddess', weight: 1 },
];

async function open(
  page: Page,
  permissions = ['regions.read', 'regions.write', 'regions.publish'],
  path = '/admin/region-pools/twin-peeks',
) {
  await stubApi(page, { session: { permissions } });
  const backend = new RegionPoolBackend(SPECIES, REGIONS, {
    'waifu-valley': [
      { species: 'valley_n', weight: 1 },
      { species: 'shrine_girl', weight: 1 },
      { species: 'sr_nurse', weight: 1 },
      { species: 'ssr_knight', weight: 1 },
      { species: 'ur_witch', weight: 1 },
      { species: 'valley_lr', weight: 1 },
    ],
    'twin-peeks': PEAKS,
    'assteroid-belt': [{ species: 'belt_empress', weight: 1 }],
  });
  await backend.install(page);
  await page.goto(path);
  return backend;
}
const heading = (page: Page) =>
  page.getByRole('heading', { level: 1, name: 'Region Pool — Twin Peeks' });

test('navigation: the sidebar entry leads to the overview and into a region', async ({
  page,
  isMobile,
}) => {
  await open(page, ['regions.read'], '/dashboard');
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Admin — Region Pools' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Region Pools' })).toBeVisible();
  const belt = page.getByTestId('region-card-assteroid-belt');
  await expect(belt).toContainText('Unreleased');
  await expect(page.getByTestId('region-card-twin-peeks')).toContainText('Released');
  await page.getByRole('link', { name: 'Twin Peeks' }).click();
  await expect(heading(page)).toBeVisible();
});

test('read-only users inspect pools, odds and history without mutation controls', async ({
  page,
}) => {
  const backend = await open(page, ['regions.read']);
  await expect(heading(page)).toBeVisible();
  await expect(page.getByTestId('read-only-note')).toBeVisible();
  // regions.read alone loads thumbnails; species without artwork get the placeholder.
  // Thumbnails load only near the viewport, so bring each row on screen first.
  const maid = page.getByTestId('region-species-cafe_maid-thumbnail');
  await maid.scrollIntoViewIfNeeded();
  await expect(maid.getByRole('img', { name: 'Cafe Maid' })).toBeVisible();
  const cat = page.getByTestId('region-species-alley_cat-thumbnail');
  await cat.scrollIntoViewIfNeeded();
  await expect(cat).toContainText('Preview unavailable');
  expect(backend.artworkRequests).toContain('cafe_maid');
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await expect(page.getByLabel('Weight for Cafe Maid')).toBeDisabled();
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByTestId('revision-1')).toBeVisible();
  await expect(page.getByRole('button', { name: /Roll back/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Probability' }).click();
  await expect(page.getByTestId('analysis-species-sr_idol')).toBeVisible();
});

test('rarity sections show the real analyser’s odds and the EX explanation', async ({ page }) => {
  await open(page);
  // tables.json: N 60, R 25, SR 10, SSR 4, UR 0.9, LR 0.1 → SR is 10% of rarity rolls.
  await expect(page.getByTestId('rarity-chance-SR')).toContainText('10.0%');
  // Stage Idol is 3 of SR's 4 weight: 75% of SR; 7.5% of encounters; × 74% encounter share per Hunt.
  const idol = page.getByTestId('pool-row-sr_idol-odds');
  await expect(idol).toContainText('75.0%');
  await expect(idol).toContainText('7.50%');
  await expect(idol).toContainText('5.55%');
  await expect(page.getByTestId('ex-explanation')).toContainText('never rolls EX');
  await expect(page.getByTestId('rarity-section-EX')).toContainText('Ex Goddess is EX');
});

test('add, reweight, remove, save; the projection is untouched until publish', async ({ page }) => {
  const backend = await open(page);
  await page.getByRole('button', { name: '+ Add species' }).click();
  const picker = page.getByTestId('region-species-picker');
  await expect(
    picker.getByRole('button', { name: 'Add Delve Wraith to this pool' }),
  ).toBeDisabled();
  await picker.getByLabel('Search species').fill('fresh');
  await picker.getByRole('button', { name: 'Add Fresh Recruit to this pool' }).click();
  await page.getByLabel('Weight for Stage Idol').fill('1');
  await page.getByRole('button', { name: 'Remove Alley Catgirl from this pool' }).click();
  await expect(page.getByTestId('status-local')).toContainText('1 added, 1 removed, 1 reweighted');
  await expect(page.getByTestId('pool-row-sr_idol-odds')).toContainText('Save to recalculate');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('region-pool-notice')).toContainText('Hunting is unchanged');
  await expect(page.getByTestId('status-draft')).toContainText('Revision 2');
  // Recalculated by the server: SR is now 1:1.
  await expect(page.getByTestId('pool-row-sr_idol-odds')).toContainText('50.0%');
  expect(backend.pools.get('twin-peeks')!.revisions).toHaveLength(1);
  await expect(page.getByTestId('status-published')).toContainText('Revision #1');
});

test('discard asks first; a stale draft names the other administrator and reloads', async ({
  page,
}) => {
  const backend = await open(page);
  await page.getByLabel('Weight for Cafe Maid').fill('9');
  await page.getByRole('button', { name: 'Discard unsaved edits' }).click();
  const confirm = page.getByTestId('region-pool-confirm');
  await expect(confirm).toContainText('Every change on this page');
  await confirm.getByRole('button', { name: 'Discard unsaved edits' }).click();
  await expect(page.getByLabel('Weight for Cafe Maid')).toHaveValue('3');

  backend.saveAsSomeoneElse('twin-peeks', [...PEAKS.slice(0, 2), ...PEAKS.slice(3)]);
  await page.getByLabel('Weight for Cafe Maid').fill('7');
  await page.getByRole('button', { name: 'Save draft' }).click();
  const banner = page.getByTestId('stale-banner');
  await expect(banner).toContainText('now at revision 2, saved by 999999999999999999');
  await banner.getByRole('button', { name: 'Reload latest draft' }).click();
  await expect(page.getByTestId('stale-banner')).toHaveCount(0);
  await expect(page.getByTestId('pool-row-shrine_girl')).toHaveCount(0);
  await expect(page.getByLabel('Weight for Cafe Maid')).toHaveValue('3');
});

test('shipped comparison: merge newly shipped species; custom weights stay', async ({ page }) => {
  const backend = await open(page);
  await page.getByRole('tab', { name: 'Shipped content' }).click();
  await expect(page.getByTestId('shipped-vs-published')).toContainText(
    'Added (1): Fresh Recruit (weight 4)',
  );
  await expect(page.getByTestId('shipped-portal-only')).toContainText('Alley Catgirl');
  await expect(page.getByTestId('shipped-weight-conflicts')).toContainText(
    'Cafe Maid — draft 3, shipped 2',
  );
  await page.getByRole('button', { name: 'Merge all newly shipped species' }).click();
  await expect(page.getByTestId('region-pool-notice')).toContainText('Not published');
  const draft = backend.pools.get('twin-peeks')!.draft;
  expect(draft.find((e) => e.species === 'new_r')).toEqual({ species: 'new_r', weight: 4 });
  expect(draft.find((e) => e.species === 'cafe_maid')).toEqual({ species: 'cafe_maid', weight: 3 });
  expect(draft.some((e) => e.species === 'alley_cat')).toBe(true);
  expect(backend.pools.get('twin-peeks')!.revisions).toHaveLength(1);
});

test('publish review: acknowledgements, a stale fingerprint, and a fresh review', async ({
  page,
}) => {
  const backend = await open(page);
  await page.getByLabel('Weight for Stage Idol').fill('5');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('status-draft')).toContainText('Revision 2');

  await page.getByRole('button', { name: /Review & publish/ }).click();
  const dialog = page.getByTestId('region-pool-review');
  await expect(dialog.getByTestId('review-diff')).toContainText('Stage Idol 3 → 5');
  await expect(dialog.getByTestId('review-probability')).toContainText('Stage Idol');
  const firstHash = (await dialog.getByTestId('review-hash').textContent())!;
  await dialog.getByRole('checkbox', { name: /Ex Goddess is EX/ }).check();

  // A species changes after the review was issued: the fingerprint no longer matches.
  backend.species.get('sr_nurse')!.enabled = false;
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(dialog.getByTestId('review-refusal')).toContainText('This review is out of date.');
  await expect(dialog.getByRole('button', { name: 'Publish' })).toBeDisabled();
  expect(backend.publishes).toHaveLength(1);

  await dialog.getByRole('button', { name: 'Start a fresh review' }).click();
  await expect(dialog.getByTestId('review-hash')).not.toHaveText(firstHash);
  await dialog.getByRole('checkbox', { name: /Ex Goddess is EX/ }).check();
  await dialog.getByRole('checkbox', { name: /Night Nurse is disabled/ }).check();
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByTestId('region-pool-notice')).toContainText('Published revision #2');
  expect(backend.publishes).toHaveLength(2);
  const second = backend.publishes[1]!.body as {
    reviewHash: string;
    acknowledgedWarnings: string[];
  };
  expect(second.reviewHash).not.toBe(firstHash);
  expect(second.acknowledgedWarnings.sort()).toEqual([
    'species_disabled:sr_nurse',
    'species_not_huntable:ex_goddess',
  ]);
  await expect(page.getByTestId('status-published')).toContainText('Revision #2');
});

test('rollback explains itself and confirms replacing an unpublished draft', async ({ page }) => {
  const backend = await open(page);
  // Publish revision 2 first.
  await page.getByLabel('Weight for Stage Idol').fill('5');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('status-draft')).toContainText('Revision 2');
  await page.getByRole('button', { name: /Review & publish/ }).click();
  let dialog = page.getByTestId('region-pool-review');
  await dialog.getByRole('checkbox', { name: /Ex Goddess is EX/ }).check();
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByTestId('region-pool-notice')).toContainText('Published revision #2');
  // Then leave unpublished work in the draft.
  await page.getByLabel('Weight for Cafe Maid').fill('6');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('status-draft')).toContainText('Unpublished changes');

  await page.getByRole('tab', { name: 'History' }).click();
  await page.getByRole('button', { name: 'Roll back to revision 1' }).click();
  dialog = page.getByTestId('region-pool-review');
  await expect(dialog).toContainText('creates a new published revision');
  await expect(dialog).toContainText('does not erase any historical revision');
  await expect(dialog).toContainText('saved, unpublished draft changes will be lost');
  const go = dialog.getByRole('button', { name: 'Roll back to revision #1' });
  await dialog.getByRole('checkbox', { name: /Ex Goddess is EX/ }).check();
  await expect(go).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /rolling back replaces the draft/ }).check();
  await go.click();
  await expect(page.getByTestId('region-pool-notice')).toContainText(
    'Rolled back: published revision #3',
  );
  const pool = backend.pools.get('twin-peeks')!;
  expect(pool.revisions.map((r) => r.number)).toEqual([1, 2, 3]);
  expect(pool.revisions[2]).toMatchObject({ source: 'rollback', rolledBackFrom: 1 });
  expect(pool.draft).toEqual(PEAKS);
  await expect(page.getByTestId('revision-3')).toContainText('Rollback of revision #1');
});

test('region-exclusive conflict with an unreleased region is reported, and blocks as the API decides', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: '+ Add species' }).click();
  const picker = page.getByTestId('region-species-picker');
  await picker.getByLabel('Search species').fill('belt');
  await expect(picker.getByTestId('region-species-option-belt_empress')).toContainText(
    'region-exclusive conflict',
  );
  await picker.getByRole('button', { name: 'Add Belt Empress to this pool' }).click();
  const row = page.getByTestId('pool-row-belt_empress');
  await expect(row.getByTestId('exclusive-conflict-regions')).toContainText(
    'Assteroid Belt (unreleased)',
  );
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('status-draft')).toContainText('Revision 2');
  await page.getByRole('button', { name: /Review & publish/ }).click();
  const dialog = page.getByTestId('region-pool-review');
  await expect(dialog.getByTestId('review-errors')).toContainText(
    'Belt Empress is region-exclusive',
  );
  await expect(dialog.getByTestId('review-errors')).toContainText('Assteroid Belt (unreleased)');
  await expect(dialog.getByRole('button', { name: 'Publish' })).toBeDisabled();
});

test('scenario odds: level 40 shift, scripted spawns and a filtered selector', async ({ page }) => {
  await open(page, ['regions.read']);
  await page.getByRole('tab', { name: 'Probability' }).click();
  const panel = page.getByTestId('region-pool-analysis');
  await expect(panel.getByTestId('analysis-rarity-N')).toContainText('60.0%');
  await panel.getByRole('button', { name: 'Level 40' }).click();
  // rareEncounterShift at 40 moves one weight unit from N to R.
  await expect(panel.getByTestId('analysis-rarity-N')).toContainText('59.0%');
  await expect(panel.getByTestId('analysis-assumptions')).toContainText(
    'rare-encounter shift applies',
  );
  await panel.getByRole('tab', { name: 'Scripted spawns' }).click();
  await expect(panel.getByTestId('analysis-assumptions')).toContainText('No Buddy Bonus applies');
  await panel.getByRole('tab', { name: 'Filtered World Encounter selectors' }).click();
  await panel.getByRole('checkbox', { name: 'Filter rarities SR' }).check();
  await expect(panel.getByTestId('analysis-species-sr_idol')).toContainText('75.0%');
  await expect(panel.getByTestId('analysis-species')).not.toContainText('Cafe Maid');
});

test('mobile layout and accessibility of the editor', async ({ page }) => {
  await open(page);
  await expect(heading(page)).toBeVisible();
  await expect(page.getByTestId('pool-row-sr_idol-odds')).toContainText('75.0%');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (window as any).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return (results.violations as Array<{ id: string; nodes: Array<{ html: string }> }>).map(
      (v) =>
        `${v.id}: ${v.nodes
          .slice(0, 2)
          .map((n) => n.html)
          .join(' | ')}`,
    );
  });
  expect(violations).toEqual([]);
});
