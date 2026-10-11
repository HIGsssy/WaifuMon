/**
 * What a fight screen shows: the enemy's sprite and the Buddy on a background
 * whenever the enemy has a sprite; its full artwork alone, without the Buddy,
 * when it has only that; the background with the Buddy when it has neither.
 * Runs the real compositor over files in a temp assets tree — no database.
 *
 * Set `DUNGEON_SHOTS=<dir>` to also write sample renders made from the art
 * shipped in `assets/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonRunSceneArtwork } from '../../../src/discord/dungeonArtwork';
import { createSceneCompositionService } from '../../../src/modules/artworkAssets/sceneComposition';
import { DEFAULT_SPRITE_PLACEMENT, SCENE_HEIGHT, SCENE_WIDTH, layoutPlayerBuddy, layoutSprite } from '../../../src/modules/artworkAssets/scenePlacement';
import { BLUE, GREEN, RED, isNear, pixelAt, solidImage, transparentSprite } from '../../helpers/imageFixtures';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-dungeon-scene-'));
const assetsDir = path.join(root, 'assets');
const YELLOW = { r: 230, g: 210, b: 40 };
const PURPLE = { r: 150, g: 40, b: 200 };
const ORANGE = { r: 240, g: 140, b: 20 };
/** A species with a dungeon sprite in the temp tree: the run's Buddy. */
const BUDDY = 'test_buddy';
const put = (relative: string, bytes: Buffer) => {
  const file = path.join(assetsDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
beforeAll(async () => {
  put('dungeons/backgrounds/room.png', await solidImage(640, 360, BLUE));
  put('dungeons/backgrounds/dungeon.png', await solidImage(640, 360, GREEN));
  put('dungeons/zones/cover.png', await solidImage(640, 360, YELLOW));
  put('combat/sprites/drone.png', await transparentSprite(300, 300, RED));
  put('combat/sprites/golem.png', await transparentSprite(300, 300, PURPLE));
  put('combat/enemies/drone.png', await solidImage(640, 360, PURPLE));
  put(`waifumon/${BUDDY}/${BUDDY}_sprite.webp`, await transparentSprite(300, 300, ORANGE, 'webp'));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const warnings: unknown[] = [];
const context = (dir = assetsDir) =>
  ({
    config: { assetsDir: dir },
    services: { sceneComposition: createSceneCompositionService({ cacheDir: path.join(root, 'cache') }) },
    logger: { warn: (fields: unknown) => warnings.push(fields) },
  }) as unknown as Parameters<typeof dungeonRunSceneArtwork>[0];
const none = { assetId: null, artworkPath: null };
const shipped = (artworkPath: string) => ({ assetId: null, artworkPath });
function view(input: {
  sprite?: string | null;
  art?: string | null;
  room?: string | null;
  dungeon?: string | null;
  cover?: string | null;
  buddy?: string | null;
}) {
  const dungeonBackground = input.dungeon ? shipped(input.dungeon) : none;
  return {
    dungeon: { artwork: input.cover ? shipped(input.cover) : none, background: dungeonBackground },
    // As the run service builds it: the room's own background, else the dungeon's.
    roomBackground: input.room ? shipped(input.room) : dungeonBackground,
    fighter: input.buddy ? { speciesSlug: input.buddy } : null,
    enemy: {
      visual: {
        artworkAssetId: null,
        artworkPath: input.art ?? null,
        spriteAssetId: null,
        spriteArtworkPath: input.sprite ?? null,
        spritePlacement: DEFAULT_SPRITE_PLACEMENT,
      },
    },
  } as unknown as Parameters<typeof dungeonRunSceneArtwork>[1];
}
async function picture(v: ReturnType<typeof view>, ctx = context()) {
  const found = await dungeonRunSceneArtwork(ctx, v);
  if (!found) return null;
  const source = (found.file as unknown as { attachment: string | Buffer }).attachment;
  return { name: found.file.name ?? '', bytes: typeof source === 'string' ? fs.readFileSync(source) : source };
}
/** The middle of where a 300×300 sprite stands at the default placement. */
const spriteCentre = () => {
  const box = layoutSprite({ width: 300, height: 300 }, DEFAULT_SPRITE_PLACEMENT, { width: SCENE_WIDTH, height: SCENE_HEIGHT });
  return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)] as const;
};
const corner = [SCENE_WIDTH - 15, 15] as const;
/** The middle of where the 300×300 Buddy sprite stands. */
const buddyCentre = () => {
  const box = layoutPlayerBuddy({ width: 300, height: 300 });
  return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)] as const;
};
const shippedFile = (relative: string) => fs.readFileSync(path.join(assetsDir, ...relative.split('/')));

describe('a fight against an enemy with a sprite', () => {
  it('stands the sprite on the room’s background, not the enemy’s full artwork', async () => {
    const scene = (await picture(view({ sprite: 'combat/sprites/drone.png', art: 'combat/enemies/drone.png', room: 'dungeons/backgrounds/room.png', dungeon: 'dungeons/backgrounds/dungeon.png' })))!;
    expect(scene.name).toMatch(/^dungeon-scene-/);
    expect(await sharp(scene.bytes).metadata()).toMatchObject({ width: SCENE_WIDTH, height: SCENE_HEIGHT });
    expect(isNear(await pixelAt(scene.bytes, ...spriteCentre()), RED)).toBe(true);
    expect(isNear(await pixelAt(scene.bytes, ...corner), BLUE)).toBe(true);
  });
  it('falls back to the dungeon background, then to the dungeon artwork, as the scene', async () => {
    const dungeon = (await picture(view({ sprite: 'combat/sprites/drone.png', art: 'combat/enemies/drone.png', dungeon: 'dungeons/backgrounds/dungeon.png', cover: 'dungeons/zones/cover.png' })))!;
    expect(isNear(await pixelAt(dungeon.bytes, ...corner), GREEN)).toBe(true);
    const cover = (await picture(view({ sprite: 'combat/sprites/drone.png', art: 'combat/enemies/drone.png', cover: 'dungeons/zones/cover.png' })))!;
    expect(cover.name).toMatch(/^dungeon-scene-/);
    expect(isNear(await pixelAt(cover.bytes, ...corner), YELLOW)).toBe(true);
    expect(isNear(await pixelAt(cover.bytes, ...spriteCentre()), RED)).toBe(true);
  });
  it('keeps the sprite on a plain stage when no background can be found — never the full artwork', async () => {
    for (const backgrounds of [{}, { room: 'dungeons/backgrounds/deleted.png', dungeon: 'dungeons/backgrounds/also-gone.png' }]) {
      const scene = (await picture(view({ sprite: 'combat/sprites/drone.png', art: 'combat/enemies/drone.png', ...backgrounds })))!;
      expect(scene.name).toMatch(/^dungeon-scene-/);
      expect(isNear(await pixelAt(scene.bytes, ...spriteCentre()), RED)).toBe(true);
      const [r, g, b] = await pixelAt(scene.bytes, ...corner);
      // Dark and neutral: the generated stage, not the enemy's (purple) full artwork.
      expect(Math.max(r, g, b)).toBeLessThan(80);
    }
  });
  it('shows a different sprite for a different enemy in the next wave, on the same background', async () => {
    const waves = await Promise.all(
      ['combat/sprites/drone.png', 'combat/sprites/golem.png'].map((sprite) => picture(view({ sprite, room: 'dungeons/backgrounds/room.png' }))),
    );
    expect(waves[0]!.name).not.toBe(waves[1]!.name);
    expect(isNear(await pixelAt(waves[0]!.bytes, ...spriteCentre()), RED)).toBe(true);
    expect(isNear(await pixelAt(waves[1]!.bytes, ...spriteCentre()), PURPLE)).toBe(true);
    for (const wave of waves) expect(isNear(await pixelAt(wave!.bytes, ...corner), BLUE)).toBe(true);
  });
});

describe('a fight against an enemy without a usable sprite', () => {
  it('shows its full artwork as the whole picture', async () => {
    const scene = (await picture(view({ art: 'combat/enemies/drone.png', room: 'dungeons/backgrounds/room.png' })))!;
    expect(scene.name).toBe('dungeon-drone.png');
    expect(isNear(await pixelAt(scene.bytes, 20, 20), PURPLE)).toBe(true);
  });
  it('does the same when the sprite it names is missing', async () => {
    const scene = (await picture(view({ sprite: 'combat/sprites/not-shipped.png', art: 'combat/enemies/drone.png', room: 'dungeons/backgrounds/room.png' })))!;
    expect(scene.name).toBe('dungeon-drone.png');
  });
  it('shows the room’s background when it has no artwork either, and nothing when there is none', async () => {
    const scene = (await picture(view({ room: 'dungeons/backgrounds/room.png' })))!;
    expect(isNear(await pixelAt(scene.bytes, 20, 20), BLUE)).toBe(true);
    expect(await picture(view({}))).toBeNull();
  });
});

describe('the player’s Buddy in a fight', () => {
  const sprite = 'combat/sprites/drone.png';
  const art = 'combat/enemies/drone.png';
  const room = 'dungeons/backgrounds/room.png';

  it('sprite available: background + enemy sprite + Buddy', async () => {
    const scene = (await picture(view({ sprite, art, room, buddy: BUDDY })))!;
    expect(scene.name).toMatch(/^dungeon-scene-/);
    expect(isNear(await pixelAt(scene.bytes, ...corner), BLUE)).toBe(true);
    expect(isNear(await pixelAt(scene.bytes, ...spriteCentre()), RED)).toBe(true);
    expect(isNear(await pixelAt(scene.bytes, ...buddyCentre()), ORANGE)).toBe(true);
    // The enemy is where it stands without her: she changes nothing about its placement.
    const alone = (await picture(view({ sprite, art, room })))!;
    expect(isNear(await pixelAt(alone.bytes, ...spriteCentre()), RED)).toBe(true);
    expect(isNear(await pixelAt(alone.bytes, ...buddyCentre()), BLUE)).toBe(true);
  });
  it('no sprite, full artwork: the artwork alone, byte for byte, with no Buddy over it', async () => {
    for (const missingSprite of [null, 'combat/sprites/not-shipped.png']) {
      const scene = (await picture(view({ sprite: missingSprite, art, room, dungeon: 'dungeons/backgrounds/dungeon.png', buddy: BUDDY })))!;
      expect(scene.name).toBe('dungeon-drone.png');
      expect(scene.bytes.equals(shippedFile(art))).toBe(true);
    }
  });
  it('no sprite or artwork: the background with the Buddy, down the usual fallbacks', async () => {
    const onRoom = (await picture(view({ room, buddy: BUDDY })))!;
    expect(onRoom.name).toMatch(/^dungeon-scene-/);
    expect(isNear(await pixelAt(onRoom.bytes, ...corner), BLUE)).toBe(true);
    expect(isNear(await pixelAt(onRoom.bytes, ...buddyCentre()), ORANGE)).toBe(true);
    // No enemy is drawn where one would stand.
    expect(isNear(await pixelAt(onRoom.bytes, ...spriteCentre()), BLUE)).toBe(true);
    const onCover = (await picture(view({ cover: 'dungeons/zones/cover.png', buddy: BUDDY })))!;
    expect(isNear(await pixelAt(onCover.bytes, ...corner), YELLOW)).toBe(true);
    expect(isNear(await pixelAt(onCover.bytes, ...buddyCentre()), ORANGE)).toBe(true);
    // An artwork path that names nothing is the same as none.
    const goneArt = (await picture(view({ art: 'combat/enemies/not-shipped.png', room, buddy: BUDDY })))!;
    expect(goneArt.name).toBe(onRoom.name);
    expect(await picture(view({ buddy: BUDDY }))).toBeNull();
  });
  it('waves whose enemies have different artwork each get their own rule, in the same room', async () => {
    const waves = [
      { sprite, art }, // sprite and artwork
      { sprite: null, art }, // artwork only
      { sprite: null, art: null }, // neither
      { sprite: 'combat/sprites/golem.png', art: null }, // sprite only
    ];
    const [both, artOnly, neither, spriteOnly] = await Promise.all(waves.map((enemy) => picture(view({ ...enemy, room, buddy: BUDDY }))));
    expect(isNear(await pixelAt(both!.bytes, ...spriteCentre()), RED)).toBe(true);
    expect(isNear(await pixelAt(both!.bytes, ...buddyCentre()), ORANGE)).toBe(true);
    expect(artOnly!.bytes.equals(shippedFile(art))).toBe(true);
    expect(isNear(await pixelAt(neither!.bytes, ...spriteCentre()), BLUE)).toBe(true);
    expect(isNear(await pixelAt(neither!.bytes, ...buddyCentre()), ORANGE)).toBe(true);
    expect(isNear(await pixelAt(spriteOnly!.bytes, ...spriteCentre()), PURPLE)).toBe(true);
    expect(isNear(await pixelAt(spriteOnly!.bytes, ...buddyCentre()), ORANGE)).toBe(true);
    for (const scene of [both, neither, spriteOnly]) expect(isNear(await pixelAt(scene!.bytes, ...corner), BLUE)).toBe(true);
  });
});

// Sample renders from the art shipped in the repository, for a reviewer to look at.
const SHOTS = process.env.DUNGEON_SHOTS;
const realAssets = path.resolve(process.cwd(), 'assets');
const real = (relative: string) => fs.existsSync(path.join(realAssets, relative));
// No enemy sprite is shipped in the repository (they are uploaded per enemy), so
// two species sprites stand in for enemy sprites here.
const STAND_IN_SPRITES = ['waifumon/library_ghost/library_ghost_sprite.webp', 'waifumon/abyssal_shrine_oracle/abyssal_shrine_oracle_sprite.webp'];
describe.skipIf(!SHOTS || !STAND_IN_SPRITES.every(real) || !real('combat/enemies/security_automaton.webp'))('sample renders', () => {
  it('writes background + enemy sprite + Buddy, the full-artwork fallback, and two waves', async () => {
    const backdrop = (fs.readdirSync(path.join(realAssets, 'locations'), { recursive: true }) as string[])
      .map((f) => f.split(path.sep).join('/'))
      .sort()
      .find((f) => /\.(png|webp|jpe?g)$/.test(f));
    const buddy = 'crimson_oni_bride';
    const ctx = context(realAssets);
    const background = backdrop ? `locations/${backdrop}` : null;
    const art = 'combat/enemies/security_automaton.webp';
    const shots: Record<string, ReturnType<typeof view>> = {
      'render-sprite-on-background': view({ sprite: STAND_IN_SPRITES[0]!, art, room: background, buddy }),
      'render-wave-2-different-sprite': view({ sprite: STAND_IN_SPRITES[1]!, art, room: background, buddy }),
      'render-sprite-no-background': view({ sprite: STAND_IN_SPRITES[0]!, art, buddy }),
      'render-no-sprite-full-art-fallback': view({ art, room: background, buddy }),
    };
    fs.mkdirSync(SHOTS!, { recursive: true });
    for (const [name, v] of Object.entries(shots)) {
      const scene = await picture(v, ctx);
      expect(scene, name).not.toBeNull();
      await sharp(scene!.bytes).png().toFile(path.join(SHOTS!, `${name}.png`));
    }
  });
});
