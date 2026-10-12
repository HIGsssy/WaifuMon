/**
 * The dungeon editor's usability acceptance test: a first-time author builds
 * a normal dungeon through what is on screen, with drafts checked by the real
 * server validator (see `dungeonBackend.ts`).
 */
import { expect, test, type Page } from '@playwright/test';
import { starterDungeon } from '../src/features/adminDungeons/dungeonModel';
import { serveDungeon, validate } from './dungeonBackend';
import { ITEMS, lootTable, rewardContext, serveLoot } from './dungeonLootBackend';
import { stubApi } from './stubApi';

// The canvas flows are desktop work; the long-rewards check at the end runs at every width.
const desktopOnly = (isMobile: boolean) => test.skip(isMobile, 'desktop authoring flow');
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
    isMobile,
  }) => {
    desktopOnly(isMobile);
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
  isMobile,
}) => {
  desktopOnly(isMobile);
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
  // A new treasure is set up under Rewards; the older reward-table fields are not offered.
  await expect(page.getByLabel('Reward table', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rewards: No rewards yet' })).toBeVisible();
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
  isMobile,
}) => {
  desktopOnly(isMobile);
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

// ── Rewards (Phase 2, T14) ──────────────────────────────────────────────────

const HOARD = {
  guaranteed: [
    {
      id: 'scrap',
      grant: { type: 'item' as const, item: 'bent_gear', quantity: { min: 2, max: 4 } },
    },
  ],
  chances: [
    {
      id: 'essence',
      chanceBasisPoints: 3000,
      grant: {
        type: 'currency' as const,
        currency: 'essence' as const,
        amount: { min: 5, max: 10 },
      },
    },
  ],
  pools: [
    {
      id: 'gear',
      name: 'Boss gear',
      draws: 1,
      entries: [
        {
          id: 'rare',
          weight: 60,
          grant: { type: 'equipment' as const, selector: { rarity: 'R' as const } },
        },
        {
          id: 'epic',
          weight: 15,
          grant: { type: 'equipment' as const, selector: { rarity: 'SR' as const } },
        },
        { id: 'none', weight: 25, nothing: true as const },
      ],
    },
  ],
};
/** The dungeon editor over a loot catalogue, with rewards checked and rolled by the real server code. */
async function openWithLoot(
  page: Page,
  definition = starterDungeon('usability', 'Service Tunnels', ['waifu-valley']),
) {
  await stubApi(page, {
    session: { permissions: ['dungeons.read', 'dungeons.write', 'dungeons.publish'] },
  });
  const tables = [
    await lootTable('scrapheap_boss_hoard', 'Scrapheap Boss Hoard', HOARD, { tier: 'boss' }),
  ];
  const catalogue = {
    reference: () => ({
      items: ITEMS,
      lootTables: tables.map((t) => ({
        key: t.key,
        name: t.name,
        tier: t.tier,
        archived: t.archivedAt !== null,
        contentHash: t.contentHash,
      })),
    }),
    context: () => rewardContext(tables),
  };
  const backend = await serveDungeon(page, definition, undefined, catalogue);
  const loot = await serveLoot(page, tables, {}, 'loot-tables');
  await page.goto('/admin/dungeons/definitions/usability');
  return { backend, loot, catalogue };
}

test('an author gives a boss guaranteed loot, a chance drop and a shared loot table', async ({
  page,
  isMobile,
}) => {
  desktopOnly(isMobile);
  await page.setViewportSize({ width: 1366, height: 768 });
  const { backend, loot, catalogue } = await openWithLoot(page);
  await expect(page.locator('.react-flow__node')).toHaveCount(1);

  await addNext(page, 'Entrance', 'Boss');
  await page.getByLabel('Wave 1 enemy', { exact: true }).selectOption('warden');
  // The Boss template shows where loot goes, already open and with nothing invented.
  const rewards = page.getByTestId('activity-rewards');
  await expect(rewards.getByRole('button', { name: 'Rewards: No rewards yet' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(rewards.getByTestId('payout-timing')).toHaveText(
    'Paid once, when the player wins the boss fight. A lost fight pays nothing.',
  );

  // Guaranteed: 500 WaifuBux.
  await rewards.getByRole('button', { name: '+ Add guaranteed reward', exact: true }).click();
  await page.getByRole('radio', { name: 'WaifuBux', exact: true }).click();
  await page.getByLabel('Amount', { exact: true }).fill('500');
  await page.getByRole('button', { name: 'Add reward', exact: true }).click();
  // A chance drop: 25% Velvet Charm, found among the charms.
  await rewards.getByRole('button', { name: '+ Add chance drop', exact: true }).click();
  await page.getByLabel('Chance percent', { exact: true }).fill('25');
  await page.getByRole('radio', { name: 'Item', exact: true }).click();
  await page.getByRole('button', { name: 'Charms', exact: true }).click();
  await page
    .getByTestId('item-picker')
    .getByRole('button', { name: /Velvet Charm/ })
    .click();
  await page.getByRole('button', { name: 'Add chance drop', exact: true }).click();
  // A shared loot table, by name, rolled twice.
  await rewards.getByRole('button', { name: '+ Add loot table', exact: true }).click();
  await page.getByLabel('Search loot tables', { exact: true }).fill('hoard');
  await page.getByRole('button', { name: 'Add Scrapheap Boss Hoard', exact: true }).click();
  await page.getByLabel('Times Scrapheap Boss Hoard is rolled', { exact: true }).selectOption('2');

  await expect(rewards.getByTestId('rewards-summary')).toHaveText(
    '500 WaifuBux · 25% 1 Velvet Charm · Scrapheap Boss Hoard ×2',
  );
  await expect(rewards.getByTestId('risk-chip')).toHaveText(['At risk', 'Kept', 'Kept']);
  // This dungeon keeps nothing on defeat, and the explanation says so.
  await expect(rewards.getByTestId('risk-explanation')).toContainText(
    'the player keeps 0% on defeat and 0% on abandoning',
  );
  // Exact odds for the whole bundle, the shared table included, from the server's analyser.
  await expect(rewards.getByTestId('odds-summary')).toHaveText(
    'On average: 4.5 Essence, 500 WaifuBux, 6 Bent Gear, 0.25 Velvet Charm and 1.5 gear pieces.',
  );
  await expect(rewards.getByTestId('odds-risk')).toContainText('500 WaifuBux');

  // Test Roll uses the unsaved bundle and gives nothing to anyone.
  await rewards.getByRole('button', { name: 'Test roll', exact: true }).click();
  const roll = page.getByTestId('test-roll');
  await expect(roll).toContainText('awards nothing to any player');
  await expect(roll.getByTestId('test-roll-got')).toContainText('At risk 500 WaifuBux');
  await expect(roll.getByTestId('roll-group')).toHaveText([
    'This activity’s own rewards',
    'Scrapheap Boss Hoard, roll 1 of 2',
    'Scrapheap Boss Hoard, roll 2 of 2',
  ]);
  expect(loot.testRolls.at(-1)).toMatchObject({
    target: { bundle: { tables: [{ table: 'scrapheap_boss_hoard', draws: 2 }] } },
    progressionCurrency: null,
  });
  expect(backend.saves).toBe(0);
  await page.getByRole('button', { name: 'Close test roll', exact: true }).click();

  // The table opens beside the dungeon; the unsaved dungeon is untouched behind it.
  await rewards.getByRole('button', { name: 'Open table Scrapheap Boss Hoard' }).click();
  const sheet = page.getByTestId('loot-table-sheet');
  await expect(sheet.getByLabel('Table name', { exact: true })).toHaveValue('Scrapheap Boss Hoard');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/rewards-open-table.png` });
  await page.getByRole('button', { name: 'Close loot table', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(rewards.getByTestId('rewards-summary')).toContainText('Scrapheap Boss Hoard ×2');

  // Nothing technical was shown along the way.
  const text = await page.locator('[data-testid="dungeon-workspace"]').innerText();
  expect(text).not.toMatch(/\b[gct]_[0-9a-f]{32}\b/);
  expect(text).not.toMatch(/basis|weight|selector|scrapheap_boss_hoard/i);
  if (SHOTS) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/rewards-boss.png` });
  }

  await addNext(page, 'Boss', 'Exit');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publication is unchanged.')).toBeVisible();
  const boss = backend.detail.draft.rooms.find((r) => r.name === 'Boss')!.actions[0]!;
  expect(boss.waves).toEqual([{ enemy: { key: 'warden' } }]);
  expect(boss.rewards!.guaranteed.map((e) => e.grant)).toEqual([
    { type: 'currency', currency: 'waifubux', amount: { min: 500, max: 500 } },
  ]);
  expect(boss.rewards!.chances.map((e) => [e.chanceBasisPoints, e.grant])).toEqual([
    [2500, { type: 'item', item: 'velvet_charm', quantity: { min: 1, max: 1 } }],
  ]);
  expect(boss.rewards!.tables.map((t) => [t.table, t.draws])).toEqual([
    ['scrapheap_boss_hoard', 2],
  ]);
  // The server's own validator, with the catalogues, finds nothing wrong with it.
  const report = await validate(backend.detail.draft, await catalogue.context());
  expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  expect(backend.publishes).toBe(0);

  // Reopened, the draft still carries the bundle.
  await page.reload();
  await page.getByRole('button', { name: 'Select room Boss', exact: true }).click();
  await expect(
    page.getByRole('button', {
      name: /^Activity 1: Boss fight\. The Warden\. Rewards: 500 WaifuBux · 25% 1 Velvet Charm · Scrapheap Boss Hoard ×2/,
    }),
  ).toBeVisible();
});

test('a reward the dungeon cannot pay is explained in words and blocks publishing, not saving', async ({
  page,
  isMobile,
}) => {
  desktopOnly(isMobile);
  await page.setViewportSize({ width: 1366, height: 768 });
  const { backend } = await openWithLoot(page);
  await addNext(page, 'Entrance', 'Boss');
  await page.getByLabel('Wave 1 enemy', { exact: true }).selectOption('warden');
  await addNext(page, 'Boss', 'Exit');
  await page.getByRole('button', { name: 'Select room Boss', exact: true }).click();
  const rewards = page.getByTestId('activity-rewards');
  // This dungeon has no Baddie Shard currency, so it cannot pay Shards.
  await rewards.getByRole('button', { name: '+ Add guaranteed reward', exact: true }).click();
  await page.getByRole('radio', { name: 'Baddie Shards', exact: true }).click();
  await page.getByLabel('Amount', { exact: true }).fill('40');
  await page.getByRole('button', { name: 'Add reward', exact: true }).click();
  await expect(rewards.getByTestId('guaranteed-row')).toContainText(
    'Fix: This dungeon has no Baddie Shard currency set, so it cannot pay Shards.',
  );
  const todo = page.getByRole('navigation', { name: 'Dungeon outline' });
  await expect(todo).toContainText('Boss: “40 Baddie Shards” in the boss fight needs attention.');
  await expect(todo).not.toContainText(/rooms\[|reward_shards|g_[0-9a-f]{8}/);
  await expect(page.getByRole('button', { name: 'Publish draft', exact: true })).toBeDisabled();
  // The draft can still be saved, so the author can come back to it.
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publication is unchanged.')).toBeVisible();
  expect(backend.saves).toBe(1);
  await expect(page.getByRole('button', { name: 'Publish draft', exact: true })).toBeDisabled();
});

test('a long reward list stays usable and does not overflow at any width', async ({ page }) => {
  const definition = starterDungeon('usability', 'Service Tunnels', ['waifu-valley']);
  const grant = (n: number) => ({
    type: 'item' as const,
    item: n % 2 ? 'bent_gear' : 'velvet_charm',
    quantity: { min: n + 1, max: n + 3 },
  });
  definition.rooms.push({
    id: 'r_boss',
    name: 'Boss',
    kind: 'room',
    extraction: false,
    actions: [
      {
        id: 'a_boss',
        type: 'boss',
        label: '',
        optional: false,
        outcomes: {},
        advance: 'confirm',
        waves: [
          { enemy: { key: 'slime' } },
          { enemy: { key: 'golem' } },
          { enemy: { key: 'warden' } },
        ],
        rewards: {
          guaranteed: Array.from({ length: 10 }, (_, n) => ({ id: `g_${n}`, grant: grant(n) })),
          chances: Array.from({ length: 8 }, (_, n) => ({
            id: `c_${n}`,
            chanceBasisPoints: 250 * (n + 1),
            grant: grant(n),
          })),
          tables: [1, 2, 3].map((draws) => ({
            id: `t_${draws}`,
            table: 'scrapheap_boss_hoard',
            draws,
          })),
        },
      },
    ],
  });
  definition.rooms.push({
    id: 'r_exit',
    name: 'Exit',
    kind: 'exit',
    extraction: false,
    actions: [],
  });
  definition.connections.push(
    { id: 'c_1', from: 'entrance', to: 'r_boss' },
    { id: 'c_2', from: 'r_boss', to: 'r_exit' },
  );
  await openWithLoot(page, definition);
  await page.getByRole('button', { name: 'Select room Boss', exact: true }).click();
  const rewards = page.getByTestId('activity-rewards');
  await expect(rewards.getByTestId('guaranteed-row')).toHaveCount(10);
  await expect(rewards.getByTestId('chance-row')).toHaveCount(8);
  await expect(rewards.getByTestId('table-row')).toHaveCount(3);
  await expect(rewards.getByTestId('odds-summary')).toContainText('On average:');
  // Three waves are still edited above the rewards, exactly as before.
  await expect(page.getByLabel('Wave 3 enemy', { exact: true })).toHaveValue('warden');
  // Collapsing the section brings the list back to one line.
  const toggle = rewards.getByRole('button', { name: /^Rewards: / });
  await toggle.click();
  await expect(rewards.getByTestId('guaranteed-row')).toHaveCount(0);
  await toggle.click();
  // Every control is reachable, and nothing forces sideways scrolling.
  const last = rewards.getByRole('button', { name: 'Test roll', exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const widest = await rewards.evaluate((el) =>
    Math.max(...[...el.querySelectorAll('li')].map((li) => li.scrollWidth - li.clientWidth)),
  );
  expect(widest).toBeLessThanOrEqual(1);
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/rewards-long-${page.viewportSize()!.width}.png` });
});
