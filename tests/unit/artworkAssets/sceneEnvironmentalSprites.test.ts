import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSceneCompositionService,
  renderScene,
  sceneCacheKey,
  type SceneLayer,
  type SceneRequest,
} from '../../../src/modules/artworkAssets/sceneComposition';
import { SpritePlacementSchema, layoutSprite } from '../../../src/modules/artworkAssets/scenePlacement';
import {
  solidImage,
  twoToneSprite,
  transparentSprite,
  pixelAt,
  isNear,
  RED,
  BLUE,
  GREEN,
} from '../../helpers/imageFixtures';
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wm-env-render-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const placement = SpritePlacementSchema.parse({
  anchor: 'center',
  scaleBasisPoints: 5000,
});
const layer = (hash: string, bytes: Buffer | null): SceneLayer => ({
  hash,
  load: async () => bytes,
});
describe('Shared environmental composition', () => {
  it('preserves existing scene keys and pixels when environmental sprites are absent', async () => {
    const background = await solidImage(120, 70);
    const req = { background: layer('bg', background) };
    expect(sceneCacheKey(req)).toBe(sceneCacheKey({ ...req, environmentalSprites: [] }));
    expect(await renderScene({ background })).toEqual(await renderScene({ background, environmentalSprites: [] }));
  });
  it('draws background environmental sprites under enemies and foreground over them, preserving transparent edges', async () => {
    const background = await solidImage(1200, 675, BLUE);
    const env = await transparentSprite(200, 200, RED);
    const enemy = await transparentSprite(200, 200, GREEN);
    const base = { background, sprite: { bytes: enemy, placement } };
    const behind = await renderScene({
      ...base,
      environmentalSprites: [{ bytes: env, placement, mirror: false, visualLayer: 'background' }],
    });
    const front = await renderScene({
      ...base,
      environmentalSprites: [{ bytes: env, placement, mirror: false, visualLayer: 'foreground' }],
    });
    expect(isNear(await pixelAt(behind, 600, 337), GREEN)).toBe(true);
    expect(isNear(await pixelAt(front, 600, 337), RED)).toBe(true);
    expect(isNear(await pixelAt(front, 450, 180), BLUE)).toBe(true);
  });
  it('mirrors within the same aspect-preserving scaled rectangle', async () => {
    const bytes = await twoToneSprite(200, 100, RED, GREEN);
    const background = await solidImage(1200, 675, BLUE);
    const box = layoutSprite({ width: 200, height: 100 }, placement);
    const image = await renderScene({
      background,
      environmentalSprites: [{ bytes, placement, mirror: true, visualLayer: 'foreground' }],
    });
    expect(box.width / box.height).toBeCloseTo(2, 2);
    expect(isNear(await pixelAt(image, box.left + 30, box.top + 30), GREEN)).toBe(true);
    expect(isNear(await pixelAt(image, box.left + box.width - 30, box.top + 30), RED)).toBe(true);
  });
  it('omits unavailable and corrupt sprites under a separate cached key, retaining good ones', async () => {
    const svc = createSceneCompositionService({ cacheDir: dir });
    const req: SceneRequest = {
      background: layer('blue', await solidImage(1200, 675, BLUE)),
      environmentalSprites: [
        {
          layer: layer('missing', null),
          placement,
          mirror: false,
          visualLayer: 'background',
        },
        {
          layer: layer('invalid', Buffer.from('bad')),
          placement,
          mirror: false,
          visualLayer: 'foreground',
        },
        {
          layer: layer('red', await solidImage(100, 100, RED)),
          placement,
          mirror: false,
          visualLayer: 'foreground',
        },
      ],
    };
    const image = (await svc.compose(req))!;
    expect(image.cacheKey).not.toBe(sceneCacheKey(req));
    expect(isNear(await pixelAt(await readFile(image.absolutePath), 600, 337), RED)).toBe(true);
    expect((await svc.compose(req))?.cached).toBe(true);
  });
});
