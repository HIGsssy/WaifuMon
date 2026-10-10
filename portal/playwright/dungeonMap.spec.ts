import { expect, test } from '@playwright/test';
import type { DungeonDetail } from '../src/api/adminDungeons';
import { starterDungeon } from '../src/features/adminDungeons/dungeonModel';
import { stubApi } from './stubApi';

test('drag, connect cyclic rooms, save and reopen the real canvas', async ({ page }) => {
  await stubApi(page, { session: { permissions: ['dungeons.read', 'dungeons.write'] } });
  let stored: DungeonDetail = {
    key: 'map_test',
    name: 'Map test',
    enabled: true,
    position: 0,
    roomCount: 2,
    draftRevision: 1,
    draftHash: 'hash',
    published: null,
    draftDiffers: true,
    open: true,
    updatedAt: '2026-10-10T00:00:00Z',
    updatedBy: null,
    draft: {
      ...starterDungeon('map_test', 'Map test', []),
      rooms: [
        { id: 'entrance', name: 'Entrance', actions: [] },
        { id: 'exit', name: 'Exit', kind: 'exit', extraction: true, actions: [] },
      ],
    },
    layout: {
      rooms: { entrance: { x: 80, y: 40 }, exit: { x: 420, y: 240 } },
      viewport: { x: 0, y: 0, zoom: 1 },
      notes: [],
    },
    issues: [],
  };
  let saves = 0;
  await page.route('**/api/v1/admin/dungeons/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = stored;
    if (path.endsWith('/definitions')) data = { dungeons: [stored] };
    else if (path.endsWith('/currencies')) data = { currencies: [] };
    else if (path.endsWith('/settings'))
      data = {
        dailyRunLimit: 3,
        dailyRunLimitMin: 0,
        dailyRunLimitMax: 50,
        updatedAt: null,
        updatedBy: null,
      };
    else if (path.endsWith('/reference'))
      data = {
        regions: [],
        enemies: [],
        currencies: [],
        rewardTables: [],
        actionTypes: [],
        reservedActionTypes: {},
      };
    else if (path.endsWith('/revisions')) data = { revisions: [] };
    else if (path.endsWith('/history')) data = { events: [] };
    else if (path.endsWith('/validate'))
      data = {
        definition: route.request().postDataJSON().definition,
        contentHash: 'hash',
        publishable: true,
        issues: [],
      };
    else if (path.endsWith('/draft')) {
      const input = route.request().postDataJSON();
      expect(input.expectedRevision).toBe(stored.draftRevision);
      stored = {
        ...stored,
        draft: input.definition,
        layout: input.layout,
        draftRevision: stored.draftRevision + 1,
      };
      saves++;
      data = stored;
    }
    await route.fulfill({ json: { data, meta: { requestId: 'map-e2e' } } });
  });
  await page.goto('/admin/dungeons');
  await page.getByRole('link', { name: 'Map test', exact: true }).click();
  const canvas = page.getByLabel('Dungeon map canvas');
  await canvas.scrollIntoViewIfNeeded();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.react-flow__minimap')).toBeVisible();
  const entrance = page.locator('.react-flow__node[data-id="entrance"]');
  const box = (await entrance.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 40, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByText('Unsaved dungeon changes')).toBeVisible();
  expect(saves).toBe(0);
  async function connect(from: string, to: string) {
    const source = (await page
      .locator(`.react-flow__node[data-id="${from}"] .react-flow__handle.source`)
      .boundingBox())!;
    const target = (await page
      .locator(`.react-flow__node[data-id="${to}"] .react-flow__handle.target`)
      .boundingBox())!;
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
    await page.mouse.up();
  }
  await connect('entrance', 'exit');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await connect('exit', 'entrance');
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publication is unchanged.')).toBeVisible();
  expect(saves).toBe(1);
  expect(stored.draft.connections.map((c) => [c.from, c.to])).toEqual([
    ['entrance', 'exit'],
    ['exit', 'entrance'],
  ]);
  expect(stored.layout.rooms!.entrance!.x).toBeGreaterThan(100);
  const savedPosition = stored.layout.rooms!.entrance!;
  await page.reload();
  await expect(entrance).toHaveCSS(
    'transform',
    `matrix(1, 0, 0, 1, ${savedPosition.x}, ${savedPosition.y})`,
  );
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await expect(page.getByText('Unsaved dungeon changes')).toHaveCount(0);
  // The production data router blocks browser back as well as link navigation.
  await page.getByRole('button', { name: 'Select room Entrance', exact: true }).click();
  await page.getByLabel('Room name', { exact: true }).fill('Local edits');
  let navigationWarnings = 0;
  page.on('dialog', (dialog) => {
    navigationWarnings++;
    void dialog.dismiss();
  });
  await page.getByRole('link', { name: 'Back to dungeons' }).click();
  await expect.poll(() => navigationWarnings).toBe(1);
  await expect(page).toHaveURL(/definitions\/map_test$/);
  await expect(page.getByLabel('Room name', { exact: true })).toHaveValue('Local edits');
  // Chromium may suppress native confirm dialogs from a scripted history pop.
  // Observe the guard directly and cancel, after testing the native link dialog.
  await page.evaluate(() => {
    window.confirm = () => {
      document.body.dataset.navigationWarning = 'shown';
      return false;
    };
    window.history.back();
  });
  await expect(page.locator('body')).toHaveAttribute('data-navigation-warning', 'shown');
  await expect(page).toHaveURL(/definitions\/map_test$/);
  await expect(page.getByLabel('Room name', { exact: true })).toHaveValue('Local edits');
});
