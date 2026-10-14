/**
 * What an encounter screen shows: the offered WaifuMon's dungeon sprite as
 * the scene's actor — at the activity's placement and mirror, over the run's
 * Buddy, between the room's background and foreground Scene Sprites — and,
 * when she cannot be drawn, her standard artwork, then the room, then text.
 * Runs the real compositor over files in a temp assets tree — no database.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonRunSceneArtwork } from '../../../src/discord/dungeonArtwork';
import { SCENE_CONTENT_TYPE, SCENE_RENDERER_VERSION, createSceneCompositionService, sceneCacheKey } from '../../../src/modules/artworkAssets/sceneComposition';
import type { SceneLayer } from '../../../src/modules/artworkAssets/sceneComposition';
import { shippedArtworkLayer } from '../../../src/modules/artworkAssets/sceneLayers';
import {
  DEFAULT_SPRITE_PLACEMENT,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  SpritePlacementSchema,
  layoutPlayerBuddy,
  layoutSprite,
  type SpritePlacement,
} from '../../../src/modules/artworkAssets/scenePlacement';
import { BLUE, GREEN, RED, isNear, opaqueSprite, pixelAt, solidImage, transparentSprite, twoToneSprite } from '../../helpers/imageFixtures';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-dungeon-encounter-scene-'));
const assetsDir = path.join(root, 'assets');
const ORANGE = { r: 240, g: 140, b: 20 };
const PURPLE = { r: 150, g: 40, b: 200 };
const YELLOW = { r: 230, g: 210, b: 40 };
/** The run's Buddy. */
const BUDDY = 'test_buddy';
/** A WaifuMon with a dungeon sprite: a red block on a transparent canvas. */
const WILD = 'wild_one';
/** One whose sprite is green on the left half, red on the right. */
const TWO_TONE = 'two_tone';
/** One with standard artwork but no dungeon sprite. */
const NO_SPRITE = 'no_sprite';
const ROOM = 'dungeons/backgrounds/room.png';
const SPRITE = 300;

const put = (relative: string, bytes: Buffer) => {
  const file = path.join(assetsDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
beforeAll(async () => {
  put(ROOM, await solidImage(640, 360, BLUE));
  put(`waifumon/${BUDDY}/${BUDDY}_sprite.webp`, await transparentSprite(SPRITE, SPRITE, ORANGE, 'webp'));
  put(`waifumon/${WILD}/${WILD}_sprite.webp`, await transparentSprite(SPRITE, SPRITE, RED, 'webp'));
  put(`waifumon/${TWO_TONE}/${TWO_TONE}_sprite.webp`, await twoToneSprite(SPRITE, SPRITE, GREEN, RED));
  put(`waifumon/${NO_SPRITE}/standard.png`, await solidImage(400, 600, PURPLE));
  put('scene/back.png', await opaqueSprite(SPRITE, SPRITE, PURPLE));
  put('scene/front.png', await opaqueSprite(SPRITE, SPRITE, YELLOW));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const warnings: { tag?: string }[] = [];
/** Managed Scene Sprite layers by asset id, as the artwork service would hand them out. */
const managed: Record<string, SceneLayer> = {};
const context = (opts: { scenes?: boolean } = {}) =>
  ({
    config: { assetsDir },
    content: { species: [WILD, TWO_TONE, NO_SPRITE].map((slug) => ({ slug, imagePath: `waifumon/${slug}/standard.png` })) },
    services: {
      ...(opts.scenes === false ? {} : { sceneComposition: createSceneCompositionService({ cacheDir: path.join(root, 'cache') }) }),
      artworkAssets: { layer: async (id: string) => managed[id] ?? null },
      appearance: { currentAppearance: (s: { slug: string }) => ({ assetId: { slug: s.slug, variant: 'missing_variant' } }) },
    },
    logger: { warn: (fields: { tag?: string }) => warnings.push(fields) },
  }) as unknown as Parameters<typeof dungeonRunSceneArtwork>[0];

const none = { assetId: null, artworkPath: null };
function view(input: {
  actor?: { speciesSlug: string; placement?: SpritePlacement; mirror?: boolean } | null;
  room?: string | null;
  buddy?: string | null;
  sceneSprites?: { assetId: string; placement: SpritePlacement; visualLayer: 'background' | 'foreground' }[];
}) {
  const roomBackground = input.room ? { assetId: null, artworkPath: input.room } : none;
  return {
    dungeon: { artwork: none, background: none },
    roomBackground,
    fighter: input.buddy === null ? null : { speciesSlug: input.buddy ?? BUDDY },
    enemy: null,
    ...(input.actor ? { encounterActor: { placement: DEFAULT_SPRITE_PLACEMENT, mirror: false, ...input.actor } } : {}),
    ...(input.sceneSprites
      ? { sceneSprites: input.sceneSprites.map((s) => ({ ...s, mirror: false, contentHash: managed[s.assetId]!.hash })) }
      : {}),
  } as unknown as Parameters<typeof dungeonRunSceneArtwork>[1];
}
async function picture(v: ReturnType<typeof view>, ctx = context()) {
  const found = await dungeonRunSceneArtwork(ctx, v);
  if (!found) return null;
  const source = (found.file as unknown as { attachment: string | Buffer }).attachment;
  return { name: found.file.name ?? '', bytes: typeof source === 'string' ? fs.readFileSync(source) : source };
}
const output = { width: SCENE_WIDTH, height: SCENE_HEIGHT };
const boxOf = (placement: SpritePlacement) => layoutSprite({ width: SPRITE, height: SPRITE }, placement, output);
const centreOf = (box: { left: number; top: number; width: number; height: number }) =>
  [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)] as const;
const buddyCentre = () => centreOf(layoutPlayerBuddy({ width: SPRITE, height: SPRITE }));
const corner = [SCENE_WIDTH - 10, 10] as const;

describe('a WaifuMon on offer', () => {
  it('is the scene’s actor at the default placement, over the room, beside the run’s Buddy', async () => {
    const scene = (await picture(view({ actor: { speciesSlug: WILD }, room: ROOM })))!;
    expect(scene.name).toMatch(/^dungeon-scene-/);
    expect(isNear(await pixelAt(scene.bytes, ...centreOf(boxOf(DEFAULT_SPRITE_PLACEMENT))), RED)).toBe(true);
    expect(isNear(await pixelAt(scene.bytes, ...buddyCentre()), ORANGE)).toBe(true);
    expect(isNear(await pixelAt(scene.bytes, ...corner), BLUE)).toBe(true);
  });

  it('stands where the activity places her', async () => {
    const placement = SpritePlacementSchema.parse({ anchor: 'center', scaleBasisPoints: 5000, offsetX: 120, offsetY: -40 });
    const scene = (await picture(view({ actor: { speciesSlug: WILD, placement }, room: ROOM })))!;
    expect(isNear(await pixelAt(scene.bytes, ...centreOf(boxOf(placement))), RED)).toBe(true);
    // Not at the default spot, which shows the room.
    expect(isNear(await pixelAt(scene.bytes, ...centreOf(boxOf(DEFAULT_SPRITE_PLACEMENT))), BLUE)).toBe(true);
  });

  it('is mirrored inside her box when the activity says so, as a separate cached scene', async () => {
    const box = boxOf(DEFAULT_SPRITE_PLACEMENT);
    const leftQuarter = [Math.round(box.left + box.width / 4), Math.round(box.top + box.height / 2)] as const;
    const plain = (await picture(view({ actor: { speciesSlug: TWO_TONE }, room: ROOM })))!;
    const mirrored = (await picture(view({ actor: { speciesSlug: TWO_TONE, mirror: true }, room: ROOM })))!;
    expect(isNear(await pixelAt(plain.bytes, ...leftQuarter), GREEN)).toBe(true);
    expect(isNear(await pixelAt(mirrored.bytes, ...leftQuarter), RED)).toBe(true);
    expect(mirrored.name).not.toBe(plain.name);
  });

  it('stands between the room’s background and foreground Scene Sprites', async () => {
    managed.back = shippedArtworkLayer(assetsDir, 'scene/back.png')!;
    managed.front = shippedArtworkLayer(assetsDir, 'scene/front.png')!;
    const her = boxOf(DEFAULT_SPRITE_PLACEMENT);
    const [hx, hy] = centreOf(her);
    // A small foreground prop centred on her block.
    const front = SpritePlacementSchema.parse({ anchor: 'center', scaleBasisPoints: 1000, offsetX: hx - SCENE_WIDTH / 2, offsetY: hy - Math.floor(SCENE_HEIGHT / 2) });
    const scene = (await picture(view({
      actor: { speciesSlug: WILD },
      room: ROOM,
      sceneSprites: [
        { assetId: 'back', placement: DEFAULT_SPRITE_PLACEMENT, visualLayer: 'background' },
        { assetId: 'front', placement: front, visualLayer: 'foreground' },
      ],
    })))!;
    // Behind her: the background prop shows only around her opaque block.
    expect(isNear(await pixelAt(scene.bytes, Math.round(her.left + her.width * 0.1), hy), PURPLE)).toBe(true);
    expect(isNear(await pixelAt(scene.bytes, Math.round(her.left + her.width * 0.3), Math.round(her.top + her.height * 0.3)), RED)).toBe(true);
    // In front of her: the foreground prop covers her middle.
    expect(isNear(await pixelAt(scene.bytes, ...centreOf(boxOf(front))), YELLOW)).toBe(true);
    expect(isNear(await pixelAt(scene.bytes, ...buddyCentre()), ORANGE)).toBe(true);
  });
});

describe('fallbacks', () => {
  it('without a dungeon sprite: her standard artwork alone, warned about once', async () => {
    const before = warnings.filter((w) => w.tag === 'dungeons/encounter-sprite-missing').length;
    for (let i = 0; i < 2; i++) {
      const scene = (await picture(view({ actor: { speciesSlug: NO_SPRITE }, room: ROOM })))!;
      expect(scene.name).toMatch(/^card\./);
      expect(isNear(await pixelAt(scene.bytes, 10, 10), PURPLE)).toBe(true);
    }
    expect(warnings.filter((w) => w.tag === 'dungeons/encounter-sprite-missing').length).toBe(before + 1);
  });

  it('without a compositor: her standard artwork', async () => {
    const scene = (await picture(view({ actor: { speciesSlug: NO_SPRITE }, room: ROOM }), context({ scenes: false })))!;
    expect(scene.name).toMatch(/^card\./);
  });

  it('with neither: the room, and with no room either, text only', async () => {
    const roomOnly = (await picture(view({ actor: { speciesSlug: 'nobody_at_all' }, room: ROOM })))!;
    expect(roomOnly.name).toMatch(/^dungeon-scene-/);
    expect(isNear(await pixelAt(roomOnly.bytes, ...centreOf(boxOf(DEFAULT_SPRITE_PLACEMENT))), BLUE)).toBe(true);
    expect(await picture(view({ actor: { speciesSlug: 'nobody_at_all' } }), context({ scenes: false }))).toBeNull();
    // A slug that is not one never reaches the file system.
    expect(await picture(view({ actor: { speciesSlug: '../escape' } }), context({ scenes: false }))).toBeNull();
  });

  it('once she is no longer on offer, the room without her — and without the Buddy', async () => {
    const scene = (await picture(view({ room: ROOM })))!;
    expect(isNear(await pixelAt(scene.bytes, ...centreOf(boxOf(DEFAULT_SPRITE_PLACEMENT))), BLUE)).toBe(true);
    expect(isNear(await pixelAt(scene.bytes, ...buddyCentre()), BLUE)).toBe(true);
  });
});

describe('the compositor’s actor mirror', () => {
  const layer = (hash: string): SceneLayer => ({ hash, load: async () => null });
  const request = (mirror?: boolean) => ({
    background: layer('bg'),
    sprite: { layer: layer('sprite'), placement: DEFAULT_SPRITE_PLACEMENT, ...(mirror === undefined ? {} : { mirror }) },
  });

  it('leaves every existing (unmirrored) scene’s cache key as it was', () => {
    const p = DEFAULT_SPRITE_PLACEMENT;
    const before = createHash('sha256').update(JSON.stringify([
      'scene', SCENE_RENDERER_VERSION, 'bg', ['sprite', p.anchor, p.scaleBasisPoints, p.offsetX, p.offsetY], [SCENE_WIDTH, SCENE_HEIGHT], SCENE_CONTENT_TYPE,
    ])).digest('hex');
    expect(sceneCacheKey(request())).toBe(before);
    expect(sceneCacheKey(request(false))).toBe(before);
    expect(sceneCacheKey(request(true))).not.toBe(before);
  });
});
