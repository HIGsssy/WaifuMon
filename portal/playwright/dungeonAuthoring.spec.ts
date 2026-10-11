/**
 * The dungeon editor's usability acceptance test: a first-time author builds
 * a normal dungeon through what is on screen, with drafts checked by the real
 * server validator (see `dungeonBackend.ts`).
 */
import { expect, test, type Page } from '@playwright/test';
import { starterDungeon } from '../src/features/adminDungeons/dungeonModel';
import { serveDungeon, validate } from './dungeonBackend';
import { stubApi } from './stubApi';

test.skip(({ isMobile }) => isMobile, 'desktop authoring flow');
const SHOTS = process.env.DUNGEON_SHOTS;

async function open(
  page: Page,
  permissions = ['dungeons.read', 'dungeons.write', 'dungeons.publish'],
) {
  await stubApi(page, { session: { permissions } });
  const backend = await serveDungeon(
    page,
    starterDungeon('usability', 'Service Tunnels', ['waifu-valley']),
  );
  await page.goto('/admin/dungeons/definitions/usability');
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  return backend;
}
/** The "+" on a room card, then a template: the whole of creating and connecting a room. */
async function addNext(page: Page, after: string, template: string) {
  await page.getByRole('button', { name: `Add next room after ${after}`, exact: true }).click();
  await page.getByRole('button', { name: `${template} room`, exact: true }).click();
}
const errorsOf = async (definition: unknown) =>
  (await validate(definition)).issues.filter((i) => i.severity === 'error');

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`a first-time author builds Entrance → Combat → Rest → Boss → Exit at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const backend = await open(page);
    const name = page.getByLabel('Room name', { exact: true });
    const save = page.getByRole('button', { name: 'Save draft', exact: true });

    // Combat room: template, name, enemy, second wave, enemy.
    await addNext(page, 'Entrance', 'Combat');
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Combat');
    await page.keyboard.type('Main Hall');
    // Nothing was chosen on the author's behalf, and the editor says what is left to do.
    await expect(page.getByLabel('Wave 1 enemy', { exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: /^Checklist: 1 to finish/ })).toBeVisible();
    await expect(save).toBeDisabled();
    await page
      .getByLabel('Wave 1 enemy', { exact: true })
      .selectOption({ label: 'Scrapyard Drone — HP 40 · ATK 6 · DEF 2' });
    await page.getByRole('button', { name: 'Add wave', exact: true }).click();
    await page.getByLabel('Wave 2 enemy', { exact: true }).selectOption('golem');
    await expect(
      page.getByRole('button', { name: /^Activity 1: Fight\. Scrapyard Drone, then Rust Golem/ }),
    ).toBeVisible();
    await expect(save).toBeEnabled();

    // Rest, Boss and Exit follow the same two clicks each.
    await addNext(page, 'Main Hall', 'Rest');
    await expect(name).toHaveValue('Rest');
    await page.getByLabel('Restore HP percent').fill('40');
    await addNext(page, 'Rest', 'Boss');
    await page.getByLabel('Wave 1 enemy', { exact: true }).selectOption('warden');
    await addNext(page, 'Boss', 'Exit');
    await expect(name).toHaveValue('Exit');
    // An exit ends the run, so it offers no way to extend the dungeon.
    await expect(page.getByRole('button', { name: 'Add next room after Exit' })).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(5);
    await expect(page.locator('.react-flow__edge')).toHaveCount(4);

    // The author never opened anything advanced and never saw an identifier.
    for (const toggle of await page.getByRole('button', { name: /^Advanced/ }).all())
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const text = await page.locator('[data-testid="dungeon-workspace"]').innerText();
    expect(text).not.toMatch(/\b[rac]_[0-9a-f]{32}\b/);
    expect(text).not.toMatch(/flag|routing|outcome|rooms\[/i);

    await expect(
      page.getByRole('button', { name: /^Checklist: (Nothing to fix|\d+ to review)/ }),
    ).toBeVisible();
    if (SHOTS) {
      // Let the map finish moving to the new room; Playwright's own scroll-into-view is undone.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/editor-${viewport.width}x${viewport.height}.png` });
    }
    await save.click();
    await expect(page.getByText('Draft saved. Publication is unchanged.')).toBeVisible();
    expect(backend.saves).toBe(1);

    const draft = backend.detail.draft;
    expect(draft.entranceRoomId).toBe('entrance');
    expect(
      draft.rooms.map((r) => [r.name, r.kind ?? 'room', r.actions.map((a) => a.type)]),
    ).toEqual([
      ['Entrance', 'room', []],
      ['Main Hall', 'room', ['combat']],
      ['Rest', 'room', ['rest']],
      ['Boss', 'room', ['boss']],
      ['Exit', 'exit', []],
    ]);
    const [, hall, rest, boss, exit] = draft.rooms;
    expect(hall!.actions[0]!.waves).toEqual([
      { enemy: { key: 'slime' } },
      { enemy: { key: 'golem' } },
    ]);
    expect(rest!.actions[0]!.healBasisPoints).toBe(4000);
    expect(boss!.actions[0]!.waves).toEqual([{ enemy: { key: 'warden' } }]);
    // One open path between each pair, in order, and no custom flow anywhere.
    expect(draft.connections.map((c) => [c.from, c.to, c.kind ?? 'path', c.requires])).toEqual([
      ['entrance', hall!.id, 'path', undefined],
      [hall!.id, rest!.id, 'path', undefined],
      [rest!.id, boss!.id, 'path', undefined],
      [boss!.id, exit!.id, 'path', undefined],
    ]);
    for (const room of draft.rooms)
      for (const action of room.actions) {
        expect(action.outcomes).toEqual({});
        expect(action.next).toBeUndefined();
        expect(action.when).toBeUndefined();
      }
    expect(draft.flags).toEqual([]);
    // The server's own validator finds nothing wrong with what was built.
    expect(await errorsOf(draft)).toEqual([]);
    expect(backend.detail.issues.filter((i) => i.severity === 'error')).toEqual([]);

    // Publishing is its own explicit step.
    expect(backend.publishes).toBe(0);
    await page.getByRole('button', { name: 'Publish draft', exact: true }).click();
    await expect(page.getByText('Published revision 1.')).toBeVisible();
    expect(backend.publishes).toBe(1);
  });
}

test('branches, connects an existing room, locks a path and refuses repeated connections', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const backend = await open(page, ['dungeons.read', 'dungeons.write']);
  // Without the publish permission the action is not offered at all.
  await expect(page.getByRole('button', { name: 'Publish draft' })).toHaveCount(0);

  await addNext(page, 'Entrance', 'Combat');
  await page.getByLabel('Wave 1 enemy', { exact: true }).selectOption('slime');
  // A second way out of the same room, from the inspector this time.
  await page.getByRole('button', { name: 'Select room Entrance', exact: true }).click();
  await page
    .getByRole('region', { name: 'Ways out' })
    .getByRole('button', { name: 'Add next room' })
    .click();
  await page.getByRole('button', { name: 'Treasure room', exact: true }).click();
  await page.getByLabel('Reward table', { exact: true }).selectOption('tunnel_loot');
  await addNext(page, 'Combat', 'Exit');
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);

  // The side room rejoins the main route through an existing room.
  await page.getByRole('button', { name: 'Select room Treasure', exact: true }).click();
  const existing = page.getByLabel('Connect to existing room');
  await expect(existing.locator('option')).toHaveText([
    'Connect to an existing room…',
    'Entrance',
    'Combat',
    'Exit',
  ]);
  await existing.selectOption({ label: 'Exit' });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Open path to Exit' })).toContainText('Open path');
  // Already connected, so it is no longer offered; the exit offers no way out at all.
  await expect(existing.locator('option')).toHaveText([
    'Connect to an existing room…',
    'Entrance',
    'Combat',
  ]);

  // Dragging a path that already exists is refused with a reason, not drawn twice.
  await page.getByRole('button', { name: 'Select room Combat', exact: true }).click();
  const from = (await page
    .locator('.react-flow__node', { hasText: 'Entrance' })
    .locator('.react-flow__handle.source')
    .boundingBox())!;
  const to = (await page
    .locator('.react-flow__node', { hasText: 'Combat' })
    .locator('.react-flow__handle.target')
    .boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(page.getByText('Entrance already leads to Combat.')).toBeVisible();
  // Nothing can be dragged out of an exit at all.
  await expect(
    page.locator('.react-flow__node', { hasText: 'Exit' }).locator('.react-flow__handle.source'),
  ).not.toHaveClass(/connectablestart/);
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);

  // Locking a path is one choice, with a rule that is valid as created.
  await page.getByRole('button', { name: 'Select path Entrance → Treasure' }).click();
  await page.getByLabel('Locked path').check();
  await expect(page.getByLabel('This path opens when room')).toBeVisible();
  await page.getByLabel('This path opens when room').selectOption({ label: 'Combat' });

  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publication is unchanged.')).toBeVisible();
  const draft = backend.detail.draft;
  const id = (name: string) => draft.rooms.find((r) => r.name === name)!.id;
  expect(draft.connections.map((c) => [c.from, c.to])).toEqual([
    ['entrance', id('Combat')],
    ['entrance', id('Treasure')],
    [id('Combat'), id('Exit')],
    [id('Treasure'), id('Exit')],
  ]);
  expect(draft.connections[1]).toMatchObject({
    kind: 'path',
    requires: { type: 'room_completed', roomId: id('Combat') },
  });
  expect(draft.entranceRoomId).toBe('entrance');
  expect(await errorsOf(draft)).toEqual([]);
});

test('the checklist explains unfinished work in plain language and leads to it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await open(page);
  await addNext(page, 'Entrance', 'Empty');
  await expect(page.getByLabel('Room name', { exact: true })).toBeFocused();
  await page.keyboard.type('Main Hall');
  const todo = page.getByRole('navigation', { name: 'Dungeon outline' });
  await expect(todo.getByText('Main Hall has no way out.')).toBeVisible();
  await expect(todo.getByText('Connect this room to another room or to an exit.')).toBeVisible();
  await expect(todo.getByText('Main Hall has no activities.')).toBeVisible();
  await expect(todo).not.toContainText(/rooms\[|room_no_route|r_[0-9a-f]{8}/);
  await page.getByRole('button', { name: 'Show dungeon settings' }).click();
  await page.getByRole('button', { name: 'Show me: Main Hall has no way out.' }).click();
  await expect(page.getByLabel('Room name', { exact: true })).toHaveValue('Main Hall');
  await addNext(page, 'Main Hall', 'Exit');
  await expect(todo.getByText('Main Hall has no way out.')).toHaveCount(0);
});
