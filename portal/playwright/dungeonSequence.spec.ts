import { expect, test } from '@playwright/test';
import type { DungeonDetail } from '../src/api/adminDungeons';
import { starterDungeon } from '../src/features/adminDungeons/dungeonModel';
import { stubApi } from './stubApi';

test('construct and save a multi-action room, then reopen its configuration', async ({ page }) => {
  await stubApi(page, { session: { permissions: ['dungeons.read', 'dungeons.write'] } });
  let stored: DungeonDetail = {
    key: 'sequence',
    name: 'Sequence test',
    enabled: true,
    position: 0,
    roomCount: 1,
    draftRevision: 3,
    draftHash: 'hash',
    published: null,
    draftDiffers: true,
    open: true,
    updatedAt: '2026-10-10T00:00:00Z',
    updatedBy: null,
    draft: starterDungeon('sequence', 'Sequence test', []),
    layout: { rooms: { entrance: { x: 50, y: 60 } }, notes: [] },
    issues: [],
  };
  await page.route('**/api/v1/admin/dungeons/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = stored;
    if (path.endsWith('/reference'))
      data = {
        regions: [],
        currencies: [],
        actionTypes: ['combat', 'reward', 'rest'],
        reservedActionTypes: {},
        rewardTables: [{ id: 'loot', enabled: true }],
        enemies: [
          { key: 'slime', name: 'Slime', enabled: true, attack: 1, defense: 1, hp: 10 },
          { key: 'dragon', name: 'Dragon', enabled: true, attack: 2, defense: 2, hp: 20 },
        ],
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
    else if (path.endsWith('/draft')) {
      const input = route.request().postDataJSON();
      expect(input.expectedRevision).toBe(3);
      stored = { ...stored, draft: input.definition, layout: input.layout, draftRevision: 4 };
      data = stored;
    }
    await route.fulfill({ json: { data, meta: { requestId: 'sequence-e2e' } } });
  });
  await page.goto('/admin/dungeons/definitions/sequence');
  await page.getByRole('button', { name: 'Select room Entrance', exact: true }).click();
  await page.getByRole('button', { name: 'Add action', exact: true }).click();
  await page.getByLabel('Wave 1 enemy', { exact: true }).selectOption('slime');
  await page.getByRole('button', { name: 'Add combat wave' }).click();
  await page.getByLabel('Wave 2 enemy', { exact: true }).selectOption('dragon');
  await page.getByLabel('Wave advancement').selectOption('auto');
  await page.getByLabel('defeat route').selectOption('retreat');
  await page.getByLabel('New action type').selectOption('reward');
  await page.getByRole('button', { name: 'Add action', exact: true }).click();
  await page.getByLabel('Action label', { exact: true }).fill('Treasure');
  await page.getByLabel('Reward table', { exact: true }).selectOption('loot');
  await page.getByLabel('New action type').selectOption('rest');
  await page.getByRole('button', { name: 'Add action', exact: true }).click();
  await page.getByLabel('Restore HP percent').fill('25');
  await page.getByLabel('done route').selectOption('room_complete');
  await expect(page.getByText('Unsaved dungeon changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publication is unchanged.')).toBeVisible();
  const actions = stored.draft.rooms[0]!.actions;
  expect(actions.map((a) => a.type)).toEqual(['combat', 'reward', 'rest']);
  expect(new Set(actions.map((a) => a.id)).size).toBe(3);
  expect(actions[0]).toMatchObject({
    advance: 'auto',
    waves: [{ enemy: { key: 'slime' } }, { enemy: { key: 'dragon' } }],
    outcomes: { defeat: { type: 'retreat' } },
  });
  expect(actions[1]).toMatchObject({ label: 'Treasure', reward: { rewardTable: 'loot' } });
  expect(actions[2]).toMatchObject({
    healBasisPoints: 2500,
    outcomes: { done: { type: 'room_complete' } },
  });
  expect(stored.layout.rooms!.entrance).toEqual({ x: 50, y: 60 });
  await page.reload();
  await page.getByRole('button', { name: 'Select room Entrance', exact: true }).click();
  await page.getByRole('button', { name: 'Select action 2: Treasure', exact: true }).click();
  await expect(page.getByLabel('Reward table', { exact: true })).toHaveValue('loot');
  await page.getByRole('button', { name: 'Select action 3: rest', exact: true }).click();
  await expect(page.getByLabel('done route')).toHaveValue('room_complete');
  await expect(page.getByText('Unsaved dungeon changes')).toHaveCount(0);
});
