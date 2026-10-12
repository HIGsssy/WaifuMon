/**
 * The Dungeon Loot editor's acceptance test: an author builds the design's
 * example table — a guaranteed reward, a chance drop and a group of random
 * picks — through what is on screen, test-rolls it before saving, then retunes
 * it. Bodies, odds and rolls are checked by the real server modules (see
 * `dungeonLootBackend.ts`).
 */
import { expect, test, type Page } from '@playwright/test';
import { inspect, lootTable, serveLoot } from './dungeonLootBackend';
import { stubApi } from './stubApi';

const SHOTS = process.env.DUNGEON_SHOTS;
const WRITER = ['dungeons.read', 'dungeons.write'];

async function addReward(page: Page, section: string, button: string, type: string) {
  await page.getByTestId(section).getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('radio', { name: type, exact: true }).click();
}

test('an author creates, test-rolls and retunes a loot table without an id or a weight', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'desktop authoring flow');
  await page.setViewportSize({ width: 1366, height: 768 });
  await stubApi(page, { session: { permissions: WRITER } });
  const backend = await serveLoot(page);

  // Reached from dungeon administration.
  await page.goto('/admin/dungeons');
  await page.getByRole('link', { name: 'Dungeon Loot Tables', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dungeon Loot Tables' })).toBeVisible();
  await expect(page.getByTestId('loot-empty')).toBeVisible();
  await page.getByRole('link', { name: 'New loot table', exact: true }).click();

  await page.getByLabel('Table name', { exact: true }).fill('Scrapheap Boss Hoard');
  await page.getByLabel('Tier', { exact: true }).selectOption('boss');
  await page
    .getByLabel('Description', { exact: true })
    .fill('Main loot for the Service Tunnels foreman.');

  // Every time: 2–4 Bent Gear, found by name.
  await addReward(page, 'section-guaranteed', '+ Add guaranteed reward', 'Item');
  await page.getByLabel('Search items', { exact: true }).fill('bent');
  await page
    .getByTestId('item-picker')
    .getByRole('button', { name: /Bent Gear/ })
    .click();
  await page.getByRole('button', { name: 'Use a range', exact: true }).click();
  await page.getByLabel('Lowest amount', { exact: true }).fill('2');
  await page.getByLabel('Highest amount', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect(page.getByTestId('guaranteed-row')).toHaveText(/^2–4 Bent Gear/);

  // A chance drop, in percent.
  await addReward(page, 'section-chances', '+ Add chance drop', 'Essence');
  await page.getByLabel('Chance percent', { exact: true }).fill('30');
  await page.getByRole('button', { name: 'Use a range', exact: true }).click();
  await page.getByLabel('Lowest amount', { exact: true }).fill('5');
  await page.getByLabel('Highest amount', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Add chance drop', exact: true }).click();
  await expect(page.getByTestId('chance-row')).toContainText('5–10 Essence');

  // A group of random picks: two kinds of gear and a deliberate Nothing.
  const pools = page.getByTestId('section-pools');
  await pools.getByRole('button', { name: '+ Add a group of random picks', exact: true }).click();
  await pools.getByLabel('Group name', { exact: true }).fill('Boss gear');
  for (const [rarity, matches] of [
    ['R', '2 pieces can drop: Bolt Cutter, Iron Plate.'],
    ['SR', '1 piece can drop: Heart Locket.'],
  ] as const) {
    await pools.getByRole('button', { name: '+ Add reward', exact: true }).click();
    await page.getByRole('radio', { name: 'Equipment', exact: true }).click();
    await page.getByLabel('Equipment rarity', { exact: true }).selectOption(rarity);
    // Eligibility comes from the game's own selector rules.
    await expect(page.getByTestId('equipment-matches')).toHaveText(matches);
    await page.getByRole('button', { name: 'Add choice', exact: true }).click();
  }
  await pools.getByRole('button', { name: '+ Add “Nothing”', exact: true }).click();
  await page.getByLabel(/^Share of R gear/).fill('60');
  await page.getByLabel(/^Share of Heart Locket|^Share of SR gear/).fill('15');
  await page.getByLabel('Share of Nothing in Boss gear', { exact: true }).fill('25');
  await expect(page.getByTestId('share-percent')).toHaveText(['60%', '15%', '25%']);

  // Exact odds from the server's analyser, for the unsaved table.
  await expect(page.getByTestId('odds-summary')).toHaveText(
    'On average per roll: 2.25 Essence, 3 Bent Gear and 0.75 gear pieces.',
  );
  await expect(page.getByTestId('odds-nothing')).toHaveText('This table always gives something.');
  await page.getByRole('button', { name: 'See all odds', exact: true }).click();
  await expect(page.getByTestId('pick-odds')).toContainText('Nothing — 25%');
  await expect(page.getByTestId('all-odds')).toContainText('Bolt Cutter30%0.3Kept');

  // Test Roll before anything is saved.
  await expect(page.getByRole('status')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Test roll', exact: true }).click();
  const roll = page.getByTestId('test-roll');
  await expect(roll).toContainText('awards nothing to any player');
  await expect(roll.getByTestId('test-roll-got')).toContainText('Bent Gear');
  await expect(roll.getByTestId('line-hit').first()).toHaveText(/^Every time: [234] Bent Gear$/);
  await expect(roll.getByTestId('test-roll-seed')).toContainText(/Seed \d+\./);
  expect(backend.saves).toBe(0);
  expect(backend.testRolls.at(-1)!.target.tableBody.pools[0]!.name).toBe('Boss gear');
  // The same seed gives the same roll.
  const lines = await roll.getByTestId('test-roll-lines').innerText();
  await roll.getByRole('button', { name: 'Use this seed', exact: true }).click();
  await roll.getByRole('button', { name: 'Roll again', exact: true }).click();
  await expect(roll.getByRole('button', { name: 'Roll again', exact: true })).toBeEnabled();
  expect(await roll.getByTestId('test-roll-lines').innerText()).toBe(lines);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/loot-test-roll.png` });
  await page.getByRole('button', { name: 'Close test roll', exact: true }).click();

  // The author never saw an identifier or the stored word for a share.
  const text = await page.locator('main, body').first().innerText();
  expect(text).not.toMatch(/\b[gcpe]_[0-9a-f]{32}\b/);
  expect(text).not.toMatch(/weight|basis/i);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/loot-editor.png`, fullPage: true });

  await page.getByRole('button', { name: 'Create table', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Loot table — Scrapheap Boss Hoard' }),
  ).toBeVisible();
  expect(backend.saves).toBe(1);
  const created = backend.tables[0]!;
  expect(created).toMatchObject({ key: 'scrapheap_boss_hoard', tier: 'boss', revision: 1 });
  // The stored body is the design's example, with generated IDs, and the real validator accepts it.
  expect((await inspect(created.body)).issues).toEqual([]);
  expect(created.body.guaranteed.map((e) => e.grant)).toEqual([
    { type: 'item', item: 'bent_gear', quantity: { min: 2, max: 4 } },
  ]);
  expect(created.body.chances.map((e) => [e.chanceBasisPoints, e.grant])).toEqual([
    [3000, { type: 'currency', currency: 'essence', amount: { min: 5, max: 10 } }],
  ]);
  expect(created.body.pools).toHaveLength(1);
  expect(created.body.pools[0]).toMatchObject({ name: 'Boss gear', draws: 1 });
  expect(
    created.body.pools[0]!.entries.map((e) => [e.weight, 'grant' in e ? e.grant : 'nothing']),
  ).toEqual([
    [60, { type: 'equipment', selector: { rarity: 'R' } }],
    [15, { type: 'equipment', selector: { rarity: 'SR' } }],
    [25, 'nothing'],
  ]);
  const ids = [
    ...created.body.guaranteed,
    ...created.body.chances,
    ...created.body.pools,
    ...created.body.pools[0]!.entries,
  ].map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);

  // Retune it: a bigger Nothing share, live percentages, then Save.
  const save = page.getByRole('button', { name: 'Save table', exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel('Share of Nothing in Boss gear', { exact: true }).fill('75');
  await expect(page.getByTestId('share-percent')).toHaveText(['40%', '10%', '50%']);
  await expect(page.getByTestId('odds-summary')).toContainText('0.5 gear pieces');
  await save.click();
  await expect(page.getByRole('status')).toContainText('Saved.');
  expect(backend.saves).toBe(2);
  expect(backend.tables[0]!.revision).toBe(2);
  expect(backend.tables[0]!.body.pools[0]!.entries.map((e) => e.id)).toEqual(
    created.body.pools[0]!.entries.map((e) => e.id),
  );
  expect(backend.tables[0]!.body.pools[0]!.entries[2]!.weight).toBe(75);

  // It is in the catalogue, and nothing was published along the way.
  await page.getByRole('link', { name: 'Back to loot tables', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Scrapheap Boss Hoard', exact: true })).toBeVisible();
  await expect(page.getByTestId('loot-table-usage')).toContainText('Not used by any dungeon');
  expect(backend.publishes).toBe(0);
});

test('the editor keeps Save in reach and does not overflow at any width', async ({ page }) => {
  await stubApi(page, { session: { permissions: WRITER } });
  const hoard = await lootTable(
    'scrapheap_boss_hoard',
    'Scrapheap Boss Hoard',
    {
      guaranteed: [
        { id: 'scrap', grant: { type: 'item', item: 'bent_gear', quantity: { min: 2, max: 4 } } },
      ],
      chances: [
        {
          id: 'essence',
          chanceBasisPoints: 3000,
          grant: { type: 'currency', currency: 'essence', amount: { min: 5, max: 10 } },
        },
      ],
      pools: [
        {
          id: 'gear',
          name: 'Boss gear',
          draws: 1,
          entries: [
            { id: 'rare', weight: 60, grant: { type: 'equipment', selector: { rarity: 'R' } } },
            { id: 'none', weight: 25, nothing: true },
          ],
        },
      ],
    },
    { tier: 'boss' },
  );
  await serveLoot(page, [hoard], {
    scrapheap_boss_hoard: {
      drafts: [],
      published: [
        {
          kind: 'published',
          dungeonKey: 'tunnels',
          name: 'Service Tunnels',
          enabled: true,
          revisionId: 4,
          revision: 4,
          current: true,
          snapshotStatus: 'embedded',
        },
      ],
    },
  });
  await page.goto('/admin/dungeons/loot/scrapheap_boss_hoard');
  await expect(page.getByTestId('republish-note')).toHaveText(
    '1 dungeon uses this table. It keeps paying the old version until it is published again.',
  );
  await expect(page.getByTestId('odds-summary')).toBeVisible();
  // Save stays on screen while the author is at the top of a long table.
  await expect(page.getByRole('button', { name: 'Save table', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Test roll', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Edit 2–4 Bent Gear', exact: true }).click();
  await expect(page.getByTestId('reward-editor')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/loot-editor-${page.viewportSize()!.width}.png` });
});
