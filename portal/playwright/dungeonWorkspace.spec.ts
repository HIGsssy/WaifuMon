import { expect, test, type Page } from '@playwright/test';
import type { DungeonAction, DungeonDetail } from '../src/api/adminDungeons';
import { starterDungeon } from '../src/features/adminDungeons/dungeonModel';
import { stubApi } from './stubApi';

// The three-pane workspace is a desktop layout; narrower screens stack it.
test.skip(({ isMobile }) => isMobile, 'desktop workspace layout');
test.use({ viewport: { width: 1440, height: 900 } });

const fight = (id: string): DungeonAction => ({
  id,
  type: 'combat',
  label: '',
  optional: false,
  outcomes: {},
  waves: [{ enemy: { key: 'slime' } }],
  advance: 'confirm',
});
const stored: DungeonDetail = {
  key: 'workspace',
  name: 'Workspace test',
  enabled: true,
  position: 0,
  roomCount: 3,
  draftRevision: 2,
  draftHash: 'hash',
  published: null,
  draftDiffers: true,
  open: false,
  updatedAt: '2026-10-10T00:00:00Z',
  updatedBy: null,
  draft: {
    ...starterDungeon('workspace', 'Workspace test', []),
    rooms: [
      { id: 'entrance', name: 'Entrance', actions: [] },
      {
        id: 'guard',
        name: 'Guard post',
        actions: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(fight),
      },
      { id: 'vault', name: 'Far vault', kind: 'exit', actions: [] },
    ],
    connections: [
      { id: 'c1', from: 'entrance', to: 'guard' },
      { id: 'c2', from: 'guard', to: 'vault' },
    ],
  },
  layout: {
    rooms: {
      entrance: { x: 40, y: 40 },
      guard: { x: 300, y: 220 },
      vault: { x: 4000, y: 3000 },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    notes: [],
  },
  issues: [],
};

async function open(page: Page) {
  await stubApi(page, {
    session: { permissions: ['dungeons.read', 'dungeons.write', 'dungeons.publish'] },
  });
  await page.route('**/api/v1/admin/dungeons/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = stored;
    if (path.endsWith('/reference'))
      data = {
        regions: [],
        currencies: [],
        rewardTables: [],
        actionTypes: ['combat'],
        reservedActionTypes: {},
        enemies: [{ key: 'slime', name: 'Slime', enabled: true, attack: 1, defense: 1, hp: 10 }],
      };
    else if (path.endsWith('/revisions')) data = { revisions: [] };
    else if (path.endsWith('/history')) data = { events: [] };
    else if (path.endsWith('/import-history')) data = { imports: [] };
    else if (path.endsWith('/validate'))
      data = {
        definition: route.request().postDataJSON().definition,
        contentHash: 'hash',
        publishable: true,
        issues: [],
      };
    await route.fulfill({ json: { data, meta: { requestId: 'workspace-e2e' } } });
  });
  await page.goto('/admin/dungeons/definitions/workspace');
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
}
const box = async (page: Page, label: string) => (await page.getByLabel(label).boundingBox())!;
const transform = (page: Page) =>
  page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform);

test('canvas, outline and inspector share the desktop viewport with Save and Publish in reach', async ({
  page,
}) => {
  await open(page);
  const outline = await box(page, 'Dungeon outline');
  const canvas = await box(page, 'Dungeon map canvas');
  const inspector = await box(page, 'Map inspector');
  // Side by side, in order, and all inside the window without scrolling the page.
  expect(outline.x + outline.width).toBeLessThanOrEqual(canvas.x + 1);
  expect(canvas.x + canvas.width).toBeLessThanOrEqual(inspector.x + 1);
  expect(inspector.x + inspector.width).toBeLessThanOrEqual(1440);
  for (const pane of [outline, canvas, inspector]) {
    expect(pane.y).toBeGreaterThanOrEqual(0);
    expect(pane.y + pane.height).toBeLessThanOrEqual(900);
  }
  // The canvas takes the height the window offers rather than a fixed 520px.
  expect(canvas.height).toBeGreaterThan(600);
  expect(canvas.width).toBeGreaterThan(450);
  expect(Math.round(inspector.width)).toBe(400);
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Publish draft', exact: true })).toBeInViewport();
  await expect(page.getByLabel('Dungeon name')).toBeInViewport();
  await expect(page.locator('.react-flow__minimap')).toBeInViewport();
  await expect(page.locator('.react-flow__controls-fitview')).toBeInViewport();

  // Selecting on the canvas opens the room beside it; nothing scrolls away.
  await page.locator('.react-flow__node[data-id="guard"]').click();
  await expect(page.getByLabel('Room name', { exact: true })).toHaveValue('Guard post');
  await expect(page.getByLabel('Room name', { exact: true })).toBeInViewport();
  await expect(page.locator('.react-flow__node[data-id="guard"]')).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // The inspector scrolls on its own: the page, the header and the map stay put.
  const panel = page.getByLabel('Map inspector');
  expect(await panel.evaluate((el) => el.scrollHeight > el.clientHeight + 200)).toBe(true);
  const before = await transform(page);
  await panel.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await transform(page)).toBe(before);
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeInViewport();
  expect((await box(page, 'Dungeon map canvas')).y).toBe(canvas.y);

  // ...and working the canvas does not move the inspector.
  const scrolled = await panel.evaluate((el) => el.scrollTop);
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => transform(page)).not.toBe(before);
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(scrolled);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // Panning and zooming alone are layout edits, saved only explicitly.
  await expect(page.getByText('Unsaved dungeon changes')).toBeVisible();
});

test('the outline focuses rooms on the canvas and secondary functions keep the workspace state', async ({
  page,
}) => {
  await open(page);
  const vault = page.locator('.react-flow__node[data-id="vault"]');
  await expect(vault).not.toBeInViewport();
  await page.getByRole('button', { name: 'Select room Far vault', exact: true }).click();
  await expect(vault).toBeInViewport();
  await expect(page.getByLabel('Room name', { exact: true })).toHaveValue('Far vault');
  // Being shown a room is not an edit.
  await expect(page.getByText('Unsaved dungeon changes')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select path Entrance → Guard post' }).click();
  await expect(page.locator('.react-flow__node[data-id="entrance"]')).toBeInViewport();
  await expect(page.getByLabel('Path button text')).toBeVisible();

  // Collapsing the outline hands its width to the canvas.
  const wide = await box(page, 'Dungeon map canvas');
  await page.getByRole('button', { name: 'Hide outline' }).click();
  expect((await box(page, 'Dungeon map canvas')).width).toBeGreaterThan(wide.width + 120);
  await page.getByRole('button', { name: 'Show outline' }).click();

  await page.getByRole('button', { name: 'History & export' }).click();
  await expect(page.getByRole('button', { name: 'Export saved draft' })).toBeVisible();
  await expect(page.getByText('No published revisions.')).toBeVisible();
  await expect(page.getByText('No imports yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Publish draft', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByLabel('Path button text')).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
});

test('below the desktop breakpoint the panes stack without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await open(page);
  const canvas = await box(page, 'Dungeon map canvas');
  const inspector = await box(page, 'Map inspector');
  expect(inspector.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
  expect(canvas.height).toBeGreaterThanOrEqual(384);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  // The header follows the page so Save stays in reach while the panes scroll.
  await page.getByLabel('Map inspector').scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 600);
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeInViewport();
});
