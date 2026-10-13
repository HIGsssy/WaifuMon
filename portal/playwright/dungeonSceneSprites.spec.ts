import { expect, test } from '@playwright/test';
import { stubApi } from './stubApi';
import { serveDungeon } from './dungeonBackend';
import { starterDungeon } from '../src/features/adminDungeons/dungeonModel';
import type { SceneSpriteDetail, SceneSpriteInstance } from '../src/api/adminDungeonSceneSprites';
import path from 'node:path';
const rendererPath = path.resolve(
  process.cwd(),
  '../src/modules/artworkAssets/sceneComposition.ts',
);
const fixturePath = path.resolve(process.cwd(), '../tests/helpers/imageFixtures.ts');
const placementPath = path.resolve(process.cwd(), '../src/modules/artworkAssets/scenePlacement.ts');
const definitionPath = path.resolve(
  process.cwd(),
  '../src/modules/dungeons/sceneSprites/sceneSpriteDefinition.ts',
);
const BLUE = { r: 30, g: 60, b: 220 },
  RED = { r: 220, g: 30, b: 30 };
const solidImage = async (w: number, h: number, color: object): Promise<Buffer> =>
  (await import(fixturePath)).solidImage(w, h, color);
const transparentSprite = async (w: number, h: number, color: object): Promise<Buffer> =>
  (await import(fixturePath)).transparentSprite(w, h, color);
const renderScene = async (input: object): Promise<Buffer> =>
  (await import(rendererPath)).renderScene(input);

const permissions = [
  'dungeons.read',
  'dungeons.write',
  'dungeons.publish',
  'artwork.read',
  'artwork.write',
];
const initial = (): SceneSpriteDetail => ({
  key: 'chest',
  name: 'Chest',
  category: 'Chest',
  assetId: '12345678-1234-1234-1234-123456789abc',
  placement: { anchor: 'bottom-center', scaleBasisPoints: 4000, offsetX: 0, offsetY: 0 },
  mirror: false,
  visualLayer: 'background',
  revision: 1,
  archived: false,
  createdAt: '',
  updatedAt: '',
  updatedBy: null,
  references: [],
  events: [],
});
const envelope = (data: unknown) => ({ data, meta: { requestId: 'scene-browser' } });

test('room and activity placements save/reload and remain usable at the narrow-screen width', async ({
  page,
}, testInfo) => {
  await stubApi(page, { session: { permissions } });
  const d = starterDungeon('scene_test', 'Scene Test', ['waifu-valley']);
  d.rooms[0]!.actions = [{ id: 'rest', type: 'rest', label: 'Rest here', healBasisPoints: 3000 }];
  d.rooms.push({ id: 'out', name: 'Out', kind: 'exit', actions: [] });
  d.connections.push({ id: 'out_path', from: d.rooms[0]!.id, to: 'out', kind: 'path', label: '' });
  const backend = await serveDungeon(page, d);
  await page.route('**/api/v1/admin/dungeons/scene-sprites', (route) =>
    route.fulfill({ json: envelope({ sprites: [initial()] }) }),
  );
  await page.route('**/api/v1/admin/dungeons/scene-preview', async (route) => {
    const request = route.request().postDataJSON() as {
      roomSprites?: SceneSpriteInstance[];
      activitySprites?: SceneSpriteInstance[];
    };
    const bytes = await transparentSprite(150, 200, RED);
    const { resolveSceneSpriteInstance } = await import(definitionPath);
    const placements = [...(request.roomSprites ?? []), ...(request.activitySprites ?? [])].map(
      (i) => ({ ...resolveSceneSpriteInstance(initial(), i), bytes }),
    );
    const image = await renderScene({
      background: await solidImage(1200, 675, BLUE),
      environmentalSprites: placements,
    });
    await route.fulfill({
      contentType: 'image/webp',
      body: image,
      headers: { 'x-dungeon-scene': 'sprite', 'x-dungeon-scene-background': 'plain' },
    });
  });
  await page.goto('/admin/dungeons/definitions/scene_test');
  await page.getByRole('button', { name: 'Select room Entrance', exact: true }).click();
  const room = page.getByRole('region', { name: 'Room Scene Sprites' });
  await room.getByLabel('Add room scene sprite').selectOption('chest');
  await room.getByRole('button', { name: 'Add sprite', exact: true }).click();
  await room.getByRole('button', { name: 'Add sprite', exact: true }).click();
  await room
    .getByLabel('Scene sprite 1', { exact: true })
    .getByLabel('Sprite position')
    .selectOption('left');
  await room.getByLabel('Mirror scene sprite 1').check();
  await room.getByLabel('Layer for scene sprite 1').selectOption('foreground');
  await expect(room.getByRole('img')).toBeVisible();
  const restCard = page.getByRole('button', {
    name: 'Activity 1: Rest. Restore 30% HP',
    exact: true,
  });
  if ((await restCard.getAttribute('aria-expanded')) === 'false') await restCard.click();
  const activity = page.getByRole('region', { name: 'Activity Scene Sprites' });
  await activity.getByLabel('Add activity scene sprite').selectOption('chest');
  await activity.getByRole('button', { name: 'Add sprite', exact: true }).click();
  await activity.getByRole('button', { name: 'Move sprite 1 right' }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect.poll(() => backend.detail.draft.rooms[0]?.sceneSprites?.length).toBe(2);
  expect(backend.detail.draft.rooms[0]?.actions[0]?.sceneSprites?.[0]?.placement?.offsetX).toBe(20);
  await page.reload();
  await page.getByRole('button', { name: 'Select room Entrance', exact: true }).click();
  await expect(room.getByLabel('Mirror scene sprite 1')).toBeChecked();
  await expect(room.getByLabel('Layer for scene sprite 1')).toHaveValue('foreground');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: `/tmp/waifumon-scene-placement-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test('managed catalogue edit, preview, archive and search work on desktop and mobile', async ({
  page,
}, testInfo) => {
  await stubApi(page, { session: { permissions } });
  let sprite = initial();
  const bytes = await transparentSprite(150, 200, RED);
  const asset = {
    id: sprite.assetId,
    name: 'Chest art',
    category: 'dungeon_scene_sprite',
    status: 'active',
    contentHash: 'a'.repeat(64),
    width: 150,
    height: 200,
    fileSize: bytes.length,
    hasAlpha: true,
    mimeType: 'image/png',
    version: 1,
    originalFilename: 'chest.png',
    createdAt: '',
    updatedAt: '',
    uploadedBy: null,
    updatedBy: null,
    replacedAt: null,
  };
  await page.route('**/api/v1/admin/dungeons/scene-sprites**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/archived')) {
      sprite = {
        ...sprite,
        archived: request.postDataJSON().archived,
        revision: sprite.revision + 1,
      };
      return route.fulfill({ json: envelope(sprite) });
    }
    if (request.method() === 'POST' || request.method() === 'PUT') {
      const body = request.postDataJSON();
      sprite = {
        ...sprite,
        ...body.sprite,
        key: body.key ?? sprite.key,
        revision: sprite.revision + 1,
      };
      return route.fulfill({ json: envelope(sprite) });
    }
    return route.fulfill({
      json: envelope(url.pathname.endsWith('/scene-sprites') ? { sprites: [sprite] } : sprite),
    });
  });
  await page.route('**/api/v1/admin/artwork/assets**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/file'))
      return route.fulfill({ contentType: 'image/png', body: bytes });
    return route.fulfill({
      json: envelope(
        route.request().method() === 'POST'
          ? { asset }
          : { asset, references: [], events: [], assets: [asset], total: 1 },
      ),
    });
  });
  await page.route('**/api/v1/admin/artwork/scene-preview', async (route) => {
    const input = route.request().postDataJSON() as {
      environmentalSprites: Array<{
        placement: unknown;
        mirror: boolean;
        visualLayer: 'background' | 'foreground';
      }>;
    };
    const { SpritePlacementSchema } = await import(placementPath);
    return route.fulfill({
      contentType: 'image/webp',
      body: await renderScene({
        background: await solidImage(1200, 675, BLUE),
        environmentalSprites: input.environmentalSprites.map((s) => ({
          bytes,
          placement: SpritePlacementSchema.parse(s.placement),
          mirror: s.mirror,
          visualLayer: s.visualLayer,
        })),
      }),
    });
  });
  await page.goto('/admin/dungeons/scene-sprites');
  await page.getByRole('button', { name: /Chest chest/ }).click();
  await page.getByLabel('Sprite display name').fill('Treasure Chest');
  await page.getByLabel('Mirror sprite', { exact: true }).check();
  await page.getByLabel('Sprite visual layer').selectOption('foreground');
  await page.getByRole('button', { name: 'Save sprite', exact: true }).click();
  await expect.poll(() => sprite.name).toBe('Treasure Chest');
  await page
    .getByTestId('scene-sprite-preview-background-file')
    .setInputFiles({
      name: 'background.png',
      mimeType: 'image/png',
      buffer: await solidImage(1200, 675, BLUE),
    });
  await expect(page.getByTestId('scene-preview').getByRole('img')).toBeVisible();
  await page.getByRole('button', { name: 'Archive sprite', exact: true }).click();
  await page.getByLabel('Include archived sprites').check();
  await expect(page.getByRole('button', { name: /Treasure Chest \(archived\)/ })).toBeVisible();
  await page.getByLabel('Search scene sprites').fill('unknown');
  await expect(page.getByRole('button', { name: /Treasure Chest \(archived\)/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: `/tmp/waifumon-scene-catalogue-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
