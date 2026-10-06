/**
 * Scene composition: layout arithmetic, the rendered pixels, and the cache.
 * Real images in, real pixels out — rendered into a temp cache directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SCENE_LAYER_ORDER,
  createSceneCompositionService,
  renderScene,
  sceneCacheKey,
  type SceneLayer,
} from '../../../src/modules/artworkAssets/sceneComposition';
import {
  DEFAULT_SPRITE_PLACEMENT,
  PLAYER_BUDDY_COLLISION_SHARE,
  PLAYER_BUDDY_MAX_WIDTH_SHARE,
  PLAYER_BUDDY_PLACEMENT,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  SPRITE_ANCHORS,
  SpritePlacementSchema,
  layoutOverlapShare,
  layoutPlayerBuddy,
  layoutSprite,
  type SpritePlacement,
} from '../../../src/modules/artworkAssets/scenePlacement';
import { speciesDungeonSpriteAssetId, speciesDungeonSpritePath } from '../../../src/modules/assets/speciesArtworkFile';
import { playerBuddySpriteLayer } from '../../../src/modules/artworkAssets/sceneLayers';
import { BLUE, GREEN, RED, isNear, opaqueSprite, pixelAt, solidImage, transparentSprite } from '../../helpers/imageFixtures';

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-scene-cache-'));
afterAll(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

const placement = (over: Partial<SpritePlacement> = {}): SpritePlacement => SpritePlacementSchema.parse(over);
const layer = (hash: string, bytes: Buffer | null, onLoad?: () => void): SceneLayer => ({
  hash,
  load: async () => {
    onLoad?.();
    return bytes;
  },
});
const centre = (box: { left: number; top: number; width: number; height: number }) => ({
  x: box.left + Math.floor(box.width / 2),
  y: box.top + Math.floor(box.height / 2),
});

describe('placement', () => {
  it('defaults to bottom-right at 85% height', () => {
    expect(DEFAULT_SPRITE_PLACEMENT).toEqual({ anchor: 'bottom-right', scaleBasisPoints: 8500, offsetX: 0, offsetY: 0 });
  });

  it('bounds every authored value', () => {
    for (const bad of [
      { scaleBasisPoints: 999 },
      { scaleBasisPoints: 10_001 },
      { offsetX: 601 },
      { offsetX: -601 },
      { offsetY: 338 },
      { offsetX: 1.5 },
      { anchor: 'top-left' },
      { anchor: 'center', extra: true },
    ]) {
      expect(SpritePlacementSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('puts left, center and right where they say, vertically centred', () => {
    const source = { width: 200, height: 400 };
    const left = layoutSprite(source, placement({ anchor: 'left', scaleBasisPoints: 5000 }));
    const mid = layoutSprite(source, placement({ anchor: 'center', scaleBasisPoints: 5000 }));
    const right = layoutSprite(source, placement({ anchor: 'right', scaleBasisPoints: 5000 }));
    expect(left.left).toBeLessThan(mid.left);
    expect(mid.left).toBeLessThan(right.left);
    expect(Math.abs(mid.left + mid.width / 2 - SCENE_WIDTH / 2)).toBeLessThanOrEqual(1);
    expect(right.left + right.width).toBeLessThanOrEqual(SCENE_WIDTH);
    expect(SCENE_WIDTH - (right.left + right.width)).toBe(left.left); // same margin both sides
    for (const box of [left, mid, right]) expect(Math.abs(box.top + box.height / 2 - SCENE_HEIGHT / 2)).toBeLessThanOrEqual(1);
  });

  it('stands the bottom anchors on the floor line', () => {
    const source = { width: 300, height: 300 };
    const boxes = (['bottom-left', 'bottom-center', 'bottom-right'] as const).map((anchor) =>
      layoutSprite(source, placement({ anchor, scaleBasisPoints: 4000 })),
    );
    for (const box of boxes) expect(SCENE_HEIGHT - (box.top + box.height)).toBe(Math.round(SCENE_HEIGHT * 0.02));
    expect(boxes[0]!.left).toBeLessThan(boxes[1]!.left);
    expect(boxes[1]!.left).toBeLessThan(boxes[2]!.left);
  });

  it('scales by height and keeps the sprite’s aspect ratio', () => {
    for (const source of [{ width: 200, height: 400 }, { width: 640, height: 480 }, { width: 333, height: 777 }]) {
      for (const scaleBasisPoints of [2500, 5000, 8500, 10_000]) {
        const box = layoutSprite(source, placement({ anchor: 'center', scaleBasisPoints }));
        expect(box.height).toBe(Math.round((SCENE_HEIGHT * scaleBasisPoints) / 10_000));
        expect(box.width / box.height).toBeCloseTo(source.width / source.height, 1);
      }
    }
    const half = layoutSprite({ width: 100, height: 100 }, placement({ scaleBasisPoints: 5000 }));
    const full = layoutSprite({ width: 100, height: 100 }, placement({ scaleBasisPoints: 10_000 }));
    expect(full.height).toBe(half.height * 2 - (SCENE_HEIGHT % 2 === 0 ? 0 : 1));
  });

  it('shrinks a sprite too wide for the canvas, still in proportion', () => {
    const box = layoutSprite({ width: 4000, height: 500 }, placement({ anchor: 'center', scaleBasisPoints: 10_000 }));
    expect(box.width).toBe(SCENE_WIDTH);
    expect(box.width / box.height).toBeCloseTo(8, 1);
  });

  it('applies offsets after the anchor, and never leaves the canvas', () => {
    const source = { width: 200, height: 200 };
    const base = layoutSprite(source, placement({ anchor: 'center', scaleBasisPoints: 3000 }));
    const moved = layoutSprite(source, placement({ anchor: 'center', scaleBasisPoints: 3000, offsetX: 120, offsetY: -80 }));
    expect(moved.left - base.left).toBe(120);
    expect(moved.top - base.top).toBe(-80);
    for (const anchor of SPRITE_ANCHORS) {
      for (const [offsetX, offsetY] of [[600, 337], [-600, -337], [600, -337], [-600, 337]] as const) {
        const box = layoutSprite({ width: 500, height: 900 }, placement({ anchor, scaleBasisPoints: 10_000, offsetX, offsetY }));
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.left + box.width).toBeLessThanOrEqual(SCENE_WIDTH);
        expect(box.top + box.height).toBeLessThanOrEqual(SCENE_HEIGHT);
      }
    }
  });
});

describe('rendering', () => {
  it('a background alone fills the canonical 1200×675 canvas without stretching', async () => {
    // A square source is cropped to cover, not squashed.
    const out = await renderScene({ background: await solidImage(800, 800, BLUE) });
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: SCENE_WIDTH, height: SCENE_HEIGHT });
    for (const [x, y] of [[5, 5], [600, 337], [1194, 669]] as const) expect(isNear(await pixelAt(out, x, y), BLUE)).toBe(true);
  });

  it('layers a transparent sprite: its opaque part shows, its transparent part shows the background', async () => {
    const sprite = await transparentSprite(400, 400, RED);
    const p = placement({ anchor: 'center', scaleBasisPoints: 8000 });
    const out = await renderScene({ background: await solidImage(1200, 675, BLUE), sprite: { bytes: sprite, placement: p } });
    const box = layoutSprite({ width: 400, height: 400 }, p);
    const mid = centre(box);
    expect(isNear(await pixelAt(out, mid.x, mid.y), RED)).toBe(true);
    // Inside the sprite's box but in its transparent border: the background.
    expect(isNear(await pixelAt(out, box.left + 8, box.top + 8), BLUE)).toBe(true);
    // Well outside it: the background.
    expect(isNear(await pixelAt(out, 20, 20), BLUE)).toBe(true);
    expect((await sharp(out).metadata()).width).toBe(SCENE_WIDTH);
  });

  it('draws the sprite where each anchor, scale and offset put it', async () => {
    const background = await solidImage(1200, 675, BLUE);
    const sprite = await opaqueSprite(200, 300, RED);
    const cases: Partial<SpritePlacement>[] = [
      { anchor: 'left', scaleBasisPoints: 4000 },
      { anchor: 'center', scaleBasisPoints: 4000 },
      { anchor: 'right', scaleBasisPoints: 4000 },
      { anchor: 'bottom-left', scaleBasisPoints: 6000 },
      { anchor: 'bottom-right', scaleBasisPoints: 2500 },
      { anchor: 'center', scaleBasisPoints: 3000, offsetX: -300, offsetY: 150 },
    ];
    for (const c of cases) {
      const p = placement(c);
      const out = await renderScene({ background, sprite: { bytes: sprite, placement: p } });
      const box = layoutSprite({ width: 200, height: 300 }, p);
      const mid = centre(box);
      expect(isNear(await pixelAt(out, mid.x, mid.y), RED), JSON.stringify(c)).toBe(true);
      // Just inside each edge is sprite; just outside is background.
      expect(isNear(await pixelAt(out, box.left + 3, mid.y), RED), JSON.stringify(c)).toBe(true);
      expect(isNear(await pixelAt(out, box.left + box.width - 4, mid.y), RED), JSON.stringify(c)).toBe(true);
      if (box.left > 6) expect(isNear(await pixelAt(out, box.left - 6, mid.y), BLUE), JSON.stringify(c)).toBe(true);
      if (box.top > 6) expect(isNear(await pixelAt(out, mid.x, box.top - 6), BLUE), JSON.stringify(c)).toBe(true);
    }
  });

  it('honours a custom output size', async () => {
    const out = await renderScene({ background: await solidImage(300, 300, GREEN), output: { width: 640, height: 360 } });
    expect(await sharp(out).metadata()).toMatchObject({ width: 640, height: 360 });
  });

  it('never interprets markup: an SVG handed in as a layer is not rendered as a document', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="file:///etc/passwd"/><script>alert(1)</script></svg>',
    );
    const scenes = createSceneCompositionService({ cacheDir });
    // The service answers null (fall back) rather than rendering or throwing…
    const composed = await scenes.compose({
      background: layer('bg-svg-test', await solidImage(64, 64)),
      sprite: { layer: layer('svg-sprite', svg), placement: placement() },
    });
    if (composed) {
      // …and if the image library does rasterise it, the output is still a plain WebP of the canonical size.
      const meta = await sharp(fs.readFileSync(composed.absolutePath)).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: SCENE_WIDTH, height: SCENE_HEIGHT });
    }
    // Uploads can never get this far: the inspector refuses SVG by signature (imageInspection.test.ts).
  });
});

describe('cache', () => {
  const scenes = createSceneCompositionService({ cacheDir });

  it('the same inputs give the same key and the same file, rendered once', async () => {
    let loads = 0;
    const background = layer('hash-bg-1', await solidImage(600, 400, BLUE), () => loads++);
    const sprite = { layer: layer('hash-sprite-1', await transparentSprite(100, 100), () => loads++), placement: placement() };

    const first = await scenes.compose({ background, sprite });
    expect(first).toMatchObject({ cached: false, contentType: 'image/webp' });
    expect(loads).toBe(2);
    const bytes = fs.readFileSync(first!.absolutePath);

    const second = await scenes.compose({ background, sprite });
    expect(second).toMatchObject({ cached: true, cacheKey: first!.cacheKey, absolutePath: first!.absolutePath });
    // A cache hit does not even read the source images.
    expect(loads).toBe(2);
    expect(fs.readFileSync(second!.absolutePath).equals(bytes)).toBe(true);
    expect(first!.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    expect(path.dirname(path.dirname(first!.absolutePath))).toBe(cacheDir);
  });

  it('the key changes with anything that changes the pixels, and with nothing else', async () => {
    const bg = layer('bg', null);
    const sprite = layer('sprite', null);
    const key = (over: { bg?: SceneLayer; sprite?: SceneLayer | null; placement?: SpritePlacement; output?: { width: number; height: number } } = {}) =>
      sceneCacheKey({
        background: over.bg ?? bg,
        sprite: over.sprite === null ? null : { layer: over.sprite ?? sprite, placement: over.placement ?? placement() },
        ...(over.output ? { output: over.output } : {}),
      });
    const base = key();
    expect(key()).toBe(base);
    // A different loader for the same hash is the same scene.
    expect(key({ bg: layer('bg', Buffer.from('x')) })).toBe(base);
    const variants = [
      key({ bg: layer('bg-replaced', null) }), // the background asset was replaced
      key({ sprite: layer('sprite-replaced', null) }), // the sprite asset was replaced
      key({ sprite: null }), // background only
      key({ placement: placement({ anchor: 'center' }) }),
      key({ placement: placement({ scaleBasisPoints: 8400 }) }),
      key({ placement: placement({ offsetX: 1 }) }),
      key({ placement: placement({ offsetY: 1 }) }),
      key({ output: { width: 800, height: 450 } }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('replacing an asset renders a new scene instead of serving the old one', async () => {
    const sprite = { layer: layer('s-keep', await opaqueSprite(100, 100, RED)), placement: placement({ anchor: 'center' }) };
    const before = await scenes.compose({ background: layer('bg-v1', await solidImage(400, 300, BLUE)), sprite });
    const after = await scenes.compose({ background: layer('bg-v2', await solidImage(400, 300, GREEN)), sprite });
    expect(after!.cacheKey).not.toBe(before!.cacheKey);
    expect(after!.cached).toBe(false);
    expect(isNear(await pixelAt(fs.readFileSync(before!.absolutePath), 10, 10), BLUE)).toBe(true);
    expect(isNear(await pixelAt(fs.readFileSync(after!.absolutePath), 10, 10), GREEN)).toBe(true);
  });

  it('re-renders when the cache was cleaned, and concurrent requests share one render', async () => {
    let loads = 0;
    const background = layer('bg-concurrent', await solidImage(400, 300, BLUE), () => loads++);
    const [a, b, c] = await Promise.all([scenes.compose({ background }), scenes.compose({ background }), scenes.compose({ background })]);
    expect(loads).toBe(1);
    expect(a!.absolutePath).toBe(b!.absolutePath);
    expect(c!.cacheKey).toBe(a!.cacheKey);

    fs.rmSync(a!.absolutePath);
    const again = await scenes.compose({ background });
    expect(again).toMatchObject({ cached: false, cacheKey: a!.cacheKey });
    expect(fs.existsSync(again!.absolutePath)).toBe(true);
  });

  it('answers null — never throws — when a layer is gone or is not an image', async () => {
    const good = layer('bg-good', await solidImage(100, 100));
    expect(await scenes.compose({ background: layer('bg-gone', null) })).toBeNull();
    expect(await scenes.compose({ background: good, sprite: { layer: layer('sprite-gone', null), placement: placement() } })).toBeNull();
    expect(await scenes.compose({ background: layer('bg-garbage', Buffer.from('not an image at all')) })).toBeNull();
    expect(
      await scenes.compose({ background: good, sprite: { layer: layer('sprite-garbage', Buffer.from('nope')), placement: placement() } }),
    ).toBeNull();
  });
});

describe('the player Buddy: a reserved left-side actor', () => {
  /** A typical WaifuMon sprite: full-body, 1350px tall. */
  const TALL = { width: 900, height: 1350 };

  it('resolves a species to its sprite by the standard convention, inside the species artwork layout', async () => {
    expect(speciesDungeonSpritePath('alley_catgirl')).toBe('waifumon/alley_catgirl/alley_catgirl_sprite.webp');
    expect(speciesDungeonSpriteAssetId('alley_catgirl')).toEqual({ kind: 'waifumon', slug: 'alley_catgirl', variant: 'alley_catgirl_sprite' });

    const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-buddy-sprite-'));
    try {
      const bytes = await opaqueSprite(90, 135, GREEN, 'webp');
      fs.mkdirSync(path.join(assetsDir, 'waifumon', 'alley_catgirl'), { recursive: true });
      fs.writeFileSync(path.join(assetsDir, 'waifumon', 'alley_catgirl', 'alley_catgirl_sprite.webp'), bytes);
      // Her card art is beside it and is never what the layer reads.
      fs.writeFileSync(path.join(assetsDir, 'waifumon', 'alley_catgirl', 'standard.webp'), await solidImage(50, 50, RED, 'webp'));

      const found = playerBuddySpriteLayer(assetsDir, 'alley_catgirl')!;
      expect((await found.load())!.equals(bytes)).toBe(true);
      expect(found.hash).toMatch(/^[0-9a-f]{64}$/);
      // No sprite file, no layer — the card art is not substituted. Nor is a non-slug ever a path.
      fs.mkdirSync(path.join(assetsDir, 'waifumon', 'android_maid'), { recursive: true });
      fs.writeFileSync(path.join(assetsDir, 'waifumon', 'android_maid', 'standard.webp'), await solidImage(50, 50, RED, 'webp'));
      expect(playerBuddySpriteLayer(assetsDir, 'android_maid')).toBeNull();
      expect(playerBuddySpriteLayer(assetsDir, 'never_shipped')).toBeNull();
      for (const bad of ['', null, undefined, '../alley_catgirl', 'alley_catgirl/..', 'Alley Catgirl']) {
        expect(playerBuddySpriteLayer(assetsDir, bad), String(bad)).toBeNull();
      }
    } finally {
      fs.rmSync(assetsDir, { recursive: true, force: true });
    }
  });

  it('stands bottom-left on the floor line, whatever the sprite', () => {
    expect(PLAYER_BUDDY_PLACEMENT).toEqual({ anchor: 'bottom-left', scaleBasisPoints: 8000, offsetX: 0, offsetY: 0 });
    const box = layoutPlayerBuddy(TALL);
    // Exactly the shared layout arithmetic at the reserved placement.
    expect(box).toEqual(layoutSprite(TALL, PLAYER_BUDDY_PLACEMENT));
    expect(box).toEqual({ left: 48, top: SCENE_HEIGHT - 540 - 14, width: 360, height: 540 });
    // Entirely in the left half.
    expect(box.left + box.width).toBeLessThan(SCENE_WIDTH / 2);
  });

  it('never grows past the reserved side: a wide sprite shrinks in proportion and stays on the floor', () => {
    const limit = Math.round(SCENE_WIDTH * PLAYER_BUDDY_MAX_WIDTH_SHARE);
    for (const source of [{ width: 1957, height: 1350 }, { width: 1350, height: 1350 }, { width: 403, height: 1350 }]) {
      const box = layoutPlayerBuddy(source);
      expect(box.width, JSON.stringify(source)).toBeLessThanOrEqual(limit);
      expect(box.left).toBe(48);
      expect(box.top + box.height).toBe(SCENE_HEIGHT - 14);
      expect(Math.abs(box.width / box.height - source.width / source.height)).toBeLessThan(0.01);
    }
    expect(layoutPlayerBuddy({ width: 1957, height: 1350 }).width).toBe(limit);
    // The enemy's own layout is not bounded by it.
    expect(layoutSprite({ width: 1957, height: 1350 }, placement()).width).toBeGreaterThan(limit);
  });

  it('leaves a default-placed enemy clear, and measures one authored into her side', () => {
    const buddy = layoutPlayerBuddy(TALL);
    const share = (over: Partial<SpritePlacement>) => layoutOverlapShare(buddy, layoutSprite(TALL, placement(over)));
    expect(share({})).toBe(0);
    expect(share({ anchor: 'right' })).toBe(0);
    // Every anchor is still accepted; the left ones are a measurable collision.
    expect(share({ anchor: 'bottom-left' })).toBeGreaterThan(PLAYER_BUDDY_COLLISION_SHARE);
    expect(share({ anchor: 'left' })).toBeGreaterThan(PLAYER_BUDDY_COLLISION_SHARE);
    expect(share({ anchor: 'bottom-left', scaleBasisPoints: 8000 })).toBe(1);
    // A nudge clear of her is not one.
    expect(share({ anchor: 'bottom-center', scaleBasisPoints: 6000, offsetX: 150 })).toBeLessThan(PLAYER_BUDDY_COLLISION_SHARE);
  });

  it('is drawn in the reserved box, with the enemy still where its placement puts it', async () => {
    const background = await solidImage(1200, 675, BLUE);
    const buddy = await opaqueSprite(200, 300, GREEN, 'webp');
    const enemy = await opaqueSprite(200, 300, RED);
    for (const anchor of ['bottom-right', 'right', 'center'] as const) {
      const enemyPlacement = placement({ anchor, scaleBasisPoints: 5000 });
      const out = await renderScene({ background, playerBuddy: { bytes: buddy }, sprite: { bytes: enemy, placement: enemyPlacement } });
      const buddyAt = centre(layoutPlayerBuddy({ width: 200, height: 300 }));
      const enemyBox = layoutSprite({ width: 200, height: 300 }, enemyPlacement);
      const enemyAt = centre(enemyBox);
      expect(isNear(await pixelAt(out, buddyAt.x, buddyAt.y), GREEN), anchor).toBe(true);
      expect(isNear(await pixelAt(out, enemyAt.x, enemyAt.y), RED), anchor).toBe(true);
      expect(isNear(await pixelAt(out, 20, 20), BLUE), anchor).toBe(true);
      // The enemy is exactly where the same request draws it without her.
      const alone = await renderScene({ background, sprite: { bytes: enemy, placement: enemyPlacement } });
      expect(isNear(await pixelAt(alone, enemyAt.x, enemyAt.y), RED), anchor).toBe(true);
      expect(isNear(await pixelAt(alone, buddyAt.x, buddyAt.y), BLUE), anchor).toBe(true);
    }
  });

  it('layers background, then Buddy, then enemy', async () => {
    expect(SCENE_LAYER_ORDER).toEqual(['background', 'playerBuddy', 'sprite']);
    const buddy = await opaqueSprite(200, 300, GREEN, 'webp');
    // A small enemy authored into her side: it covers part of her box.
    const enemyPlacement = placement({ anchor: 'bottom-left', scaleBasisPoints: 3000 });
    const out = await renderScene({
      background: await solidImage(1200, 675, BLUE),
      playerBuddy: { bytes: buddy },
      sprite: { bytes: await opaqueSprite(200, 300, RED), placement: enemyPlacement },
    });
    const buddyBox = layoutPlayerBuddy({ width: 200, height: 300 });
    const enemyBox = layoutSprite({ width: 200, height: 300 }, enemyPlacement);
    const shared = centre(enemyBox);
    expect(layoutOverlapShare(buddyBox, enemyBox)).toBeGreaterThan(0);
    // Where both are, the enemy is on top; above it, the Buddy shows over the background.
    expect(isNear(await pixelAt(out, shared.x, shared.y), RED)).toBe(true);
    expect(isNear(await pixelAt(out, shared.x, buddyBox.top + 20), GREEN)).toBe(true);
    expect(isNear(await pixelAt(out, shared.x, buddyBox.top - 20), BLUE)).toBe(true);
  });

  describe('through the service', () => {
    const warnings: Record<string, unknown>[] = [];
    const scenes = createSceneCompositionService({ cacheDir, logger: { warn: (fields) => void warnings.push(fields) } });

    it('is part of the cache key only when she is in the scene', async () => {
      const background = layer('pb-key-bg', null);
      const sprite = { layer: layer('pb-key-sprite', null), placement: placement() };
      const without = sceneCacheKey({ background, sprite });
      expect(sceneCacheKey({ background, sprite, playerBuddy: null })).toBe(without);
      const a = sceneCacheKey({ background, sprite, playerBuddy: { layer: layer('buddy-a', null) } });
      const b = sceneCacheKey({ background, sprite, playerBuddy: { layer: layer('buddy-b', null) } });
      expect(new Set([without, a, b]).size).toBe(3);
      // The label only names her in a log line.
      expect(sceneCacheKey({ background, sprite, playerBuddy: { layer: layer('buddy-a', null), label: 'alley_catgirl' } })).toBe(a);
    });

    it('a Buddy whose image is gone or broken is left out — the scene still renders, and says which species', async () => {
      const background = layer('pb-bg', await solidImage(1200, 675, BLUE));
      const sprite = { layer: layer('pb-sprite', await opaqueSprite(200, 300, RED)), placement: placement({ anchor: 'center', scaleBasisPoints: 5000 }) };
      const plain = (await scenes.compose({ background, sprite }))!;
      expect(plain.playerBuddy).toBe(false);
      const buddyAt = centre(layoutPlayerBuddy({ width: 200, height: 300 }));

      for (const [hash, bytes] of [['pb-gone', null], ['pb-garbage', Buffer.from('not an image')]] as const) {
        warnings.length = 0;
        const scene = (await scenes.compose({ background, sprite, playerBuddy: { layer: layer(hash, bytes), label: 'alley_catgirl' } }))!;
        // The Buddy-less scene, under the Buddy-less key.
        expect(scene, hash).toMatchObject({ cacheKey: plain.cacheKey, playerBuddy: false });
        const out = fs.readFileSync(scene.absolutePath);
        expect(isNear(await pixelAt(out, 600, 337), RED)).toBe(true);
        expect(isNear(await pixelAt(out, buddyAt.x, buddyAt.y), BLUE)).toBe(true);
        expect(warnings).toEqual([expect.objectContaining({ tag: 'scene/player-buddy-omitted', speciesSlug: 'alley_catgirl' })]);
      }

      const withBuddy = (await scenes.compose({ background, sprite, playerBuddy: { layer: layer('pb-good', await opaqueSprite(200, 300, GREEN, 'webp')) } }))!;
      expect(withBuddy.playerBuddy).toBe(true);
      expect(withBuddy.cacheKey).not.toBe(plain.cacheKey);
      expect(isNear(await pixelAt(fs.readFileSync(withBuddy.absolutePath), buddyAt.x, buddyAt.y), GREEN)).toBe(true);
    });

    it('reports where both actors land, from the images’ real sizes', async () => {
      const request = {
        background: layer('pb-layout-bg', null),
        sprite: { layer: layer('pb-layout-sprite', await opaqueSprite(200, 300, RED)), placement: placement({ anchor: 'bottom-left' }) },
        playerBuddy: { layer: layer('pb-layout-buddy', await opaqueSprite(90, 135, GREEN, 'webp')) },
      };
      const boxes = await scenes.layouts(request);
      expect(boxes.playerBuddy).toEqual(layoutPlayerBuddy({ width: 90, height: 135 }));
      expect(boxes.sprite).toEqual(layoutSprite({ width: 200, height: 300 }, placement({ anchor: 'bottom-left' })));
      expect(layoutOverlapShare(boxes.playerBuddy!, boxes.sprite!)).toBe(1);
      expect(await scenes.layouts({ background: request.background })).toEqual({ sprite: null, playerBuddy: null });
      expect(await scenes.layouts({ ...request, playerBuddy: { layer: layer('pb-layout-gone', null) } })).toMatchObject({ playerBuddy: null });
    });
  });
});
