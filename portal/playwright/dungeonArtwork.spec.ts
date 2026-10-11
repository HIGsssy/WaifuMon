/**
 * Dungeon pictures in the editor, through the real asset picker: choosing a
 * background shows it, a room inherits or overrides it, a picture this server
 * does not hold is called out, and a fight previews the enemy as it will look.
 */
import { expect, test, type Page } from '@playwright/test';
import type { DungeonDefinition } from '../src/api/adminDungeons';
import { starterDungeon } from '../src/features/adminDungeons/dungeonModel';
import { LIBRARY, serveDungeon } from './dungeonBackend';
import { stubApi } from './stubApi';

test.skip(({ isMobile }) => isMobile, 'desktop authoring flow');
test.use({ viewport: { width: 1366, height: 768 } });
const SHOTS = process.env.DUNGEON_SHOTS;
const PERMISSIONS = ['dungeons.read', 'dungeons.write', 'artwork.read', 'enemies.read'];

async function open(page: Page, definition: DungeonDefinition) {
  await stubApi(page, { session: { permissions: PERMISSIONS } });
  const backend = await serveDungeon(page, definition);
  await page.goto(`/admin/dungeons/definitions/${definition.key}`);
  await expect(page.locator('.react-flow__node')).toHaveCount(definition.rooms.length);
  return backend;
}
const loaded = (image: ReturnType<Page['getByRole']>) =>
  expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
const reference = (name: string) => {
  const asset = LIBRARY.find((a) => a.name === name)!;
  return { kind: 'managed', category: asset.category, contentHash: asset.contentHash, name };
};

test('choose a scene background, see it, override it in a room, and save the portable references', async ({
  page,
}) => {
  const backend = await open(page, starterDungeon('pictures', 'Service Tunnels', ['waifu-valley']));
  const scene = page.getByTestId('dungeon-background');
  await expect(scene.getByText('Not set.')).toBeVisible();
  // One clear action; no path box, hash or "browse" on the default view.
  await expect(scene.getByRole('button')).toHaveText(['Choose…', 'Details']);
  await expect(page.getByLabel(/path$/)).toHaveCount(0);

  await scene.getByRole('button', { name: 'Choose scene background' }).click();
  // The existing asset library, opened on scene backgrounds.
  await expect(page.getByRole('button', { name: 'Select Night Tunnels' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select Tunnels Cover' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select Night Tunnels' }).click();
  const picture = scene.getByRole('img', { name: 'Scene background: Night Tunnels' });
  await expect(picture).toBeVisible();
  await loaded(picture);
  await expect(scene.getByTestId('dungeon-background-status')).toHaveText('Night Tunnels');
  await expect(scene.getByRole('button', { name: 'Replace scene background' })).toBeVisible();
  await expect(page.getByTestId('dungeon-workspace')).not.toContainText(/a{20}|dungeon_background/);

  // A room shows the dungeon's picture until it is given its own.
  await page.getByRole('button', { name: 'Add next room after Entrance', exact: true }).click();
  await page.getByRole('button', { name: 'Combat room', exact: true }).click();
  const room = page.getByTestId('room-background');
  await expect(room.getByTestId('room-background-status')).toContainText(
    'Uses the dungeon’s scene background.',
  );
  await loaded(room.getByRole('img', { name: 'Room background: Night Tunnels' }));
  await page.getByLabel('Wave 1 enemy', { exact: true }).selectOption('slime');
  const fight = page.getByTestId('wave-1-appearance');
  await loaded(fight.getByRole('img', { name: 'Fight preview for wave 1: Scrapyard Drone' }));
  await expect(fight).toContainText(
    'Scrapyard Drone’s combat sprite on the dungeon’s scene background.',
  );

  await room.getByRole('button', { name: 'Choose room background' }).click();
  await page.getByRole('button', { name: 'Select Boiler Room' }).click();
  await expect(room.getByTestId('room-background-status')).toHaveText(
    'This room has its own background: Boiler Room.',
  );
  await loaded(room.getByRole('img', { name: 'Room background: Boiler Room' }));
  await expect(fight).toContainText('Scrapyard Drone’s combat sprite on this room’s background.');
  if (SHOTS) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${SHOTS}/artwork-room-background.png` });
  }

  // A second wave with an enemy that has no sprite says what players will get instead.
  await page.getByRole('button', { name: 'Add wave', exact: true }).click();
  await page.getByLabel('Wave 2 enemy', { exact: true }).selectOption('golem');
  const second = page.getByTestId('wave-2-appearance');
  await expect(second).toContainText(
    'Rust Golem has no combat sprite, so its full artwork fills the scene',
  );
  await expect(
    second.getByRole('link', { name: 'Add a combat sprite for Rust Golem' }),
  ).toHaveAttribute('href', '/admin/enemies/golem');
  await second.scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/artwork-fight-preview.png` });
  // The preview was asked for with the room's fallback order, nothing author-chosen per wave.
  expect(backend.scenes.at(-1)).toEqual({
    enemyKey: 'golem',
    backgrounds: [reference('Boiler Room'), reference('Night Tunnels'), null],
  });

  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publication is unchanged.')).toBeVisible();
  const draft = backend.detail.draft;
  expect(draft.background).toEqual(reference('Night Tunnels'));
  expect(draft.artwork).toBeNull();
  expect(draft.rooms[1]!.background).toEqual(reference('Boiler Room'));
  expect(draft.rooms[0]!.background ?? null).toBeNull();
  // The real validator, told what this server holds, has no complaint about either picture.
  expect(backend.detail.issues.filter((i) => i.code === 'artwork_missing')).toEqual([]);

  await room.getByRole('button', { name: 'Clear room background' }).click();
  await expect(room.getByTestId('room-background-status')).toContainText(
    'Uses the dungeon’s scene background.',
  );
});

test('a picture this server does not hold is called out where it is used, and left as stored', async ({
  page,
}) => {
  const elsewhere = {
    kind: 'managed' as const,
    category: 'dungeon_background',
    contentHash: 'f'.repeat(64),
    name: 'Old Vault',
  };
  const definition = {
    ...starterDungeon('imported', 'Imported Vault', ['waifu-valley']),
    background: elsewhere,
    artwork: reference('Tunnels Cover') as DungeonDefinition['artwork'],
  };
  const backend = await open(page, definition);
  const scene = page.getByTestId('dungeon-background');
  await expect(scene.getByRole('alert')).toHaveText(
    'This picture can’t be found on this server, so players won’t see it.',
  );
  await expect(scene.getByTestId('dungeon-background-missing')).toContainText(
    '“Old Vault” was removed or switched off in Artwork',
  );
  // The picture that is here still previews beside it.
  await loaded(
    page
      .getByTestId('dungeon-artwork')
      .getByRole('img', { name: 'Dungeon artwork: Tunnels Cover' }),
  );
  // The checklist says the same thing in plain words, as a warning rather than a blocker.
  const todo = page.getByRole('navigation', { name: 'Dungeon outline' });
  await expect(
    todo.getByText('A picture this dungeon uses can’t be found on this server.'),
  ).toBeVisible();
  await expect(todo.getByText('Worth a look')).toBeVisible();
  await expect(todo).not.toContainText(/f{12}|is not in this environment/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/artwork-missing-picture.png` });

  // Nothing was rewritten by opening it; technical details are one step away.
  await expect(page.getByText('Unsaved dungeon changes')).toHaveCount(0);
  await scene.getByRole('button', { name: 'Scene background details' }).click();
  await expect(scene.getByText('f'.repeat(64))).toBeVisible();
  await page.getByLabel('Dungeon name').fill('Imported Vault II');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved. Publication is unchanged.')).toBeVisible();
  expect(backend.detail.draft.background).toEqual(elsewhere);

  // Replacing it clears the warning for good.
  await scene.getByRole('button', { name: 'Replace scene background' }).click();
  await page.getByRole('button', { name: 'Select Night Tunnels' }).click();
  await loaded(scene.getByRole('img', { name: 'Scene background: Night Tunnels' }));
  await expect(
    todo.getByText('A picture this dungeon uses can’t be found on this server.'),
  ).toHaveCount(0);
});
