/**
 * Delve scenes end to end: the background a node drew is snapshotted when the
 * run starts, an enemy's sprite is composed over it, every missing piece falls
 * back to the next picture, and nothing an admin does afterwards re-rolls a
 * run already in progress.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonRunSceneArtwork, dungeonZoneArtwork } from '../../src/discord/dungeonArtwork';
import type { AppContext } from '../../src/discord/types';
import type { SpritePlacement } from '../../src/modules/artworkAssets/scenePlacement';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonPlayService';
import type { LoadedContent } from '../../src/modules/content/schemas';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonPlayFixtures';
import { BLUE, GREEN, RED, isNear, opaqueSprite, pixelAt, solidImage, transparentSprite } from '../helpers/imageFixtures';
import { silentLogger } from '../helpers/testDb';

const YELLOW = { r: 230, g: 220, b: 30 };
const PURPLE = { r: 150, g: 30, b: 200 };

let w: DungeonWorld;
let ctx: AppContext;
const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-scene-assets-'));

/** Managed assets, by what they are. */
const ids = { bgBlue: '', bgYellow: '', sprite: '', fullArt: '', zoneArt: '', zoneBg: '' };

const CENTER: SpritePlacement = { anchor: 'center', scaleBasisPoints: 8000, offsetX: 0, offsetY: 0 };

beforeAll(async () => {
  w = await createDungeonWorld();
  // Shipped (Git) artwork: real images this time, so they can be composed.
  const shipped: [string, Buffer][] = [
    ['combat/enemies/grunt.webp', await solidImage(300, 300, PURPLE, 'webp')],
    ['dungeons/zones/shipped_zone.png', await solidImage(300, 300, GREEN)],
    ['dungeons/backgrounds/shipped_bg.png', await solidImage(640, 360, GREEN)],
    ['dungeons/events/shrine.png', await solidImage(200, 200, YELLOW)],
  ];
  for (const [file, bytes] of shipped) {
    fs.mkdirSync(path.join(assetsDir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(assetsDir, file), bytes);
  }
  const up = async (bytes: Buffer, category: Parameters<typeof w.assets.upload>[0]['category'], filename: string) =>
    (await w.assets.upload({ bytes, category, filename }, 'admin')).id;
  ids.bgBlue = await up(await solidImage(800, 450, BLUE), 'dungeon_background', 'blue.png');
  ids.bgYellow = await up(await solidImage(800, 450, YELLOW), 'dungeon_background', 'yellow.png');
  ids.sprite = await up(await transparentSprite(300, 300, RED), 'enemy_sprite', 'grunt-sprite.png');
  ids.fullArt = await up(await solidImage(300, 300, RED), 'enemy_art', 'grunt-full.png');
  ids.zoneArt = await up(await solidImage(300, 300, YELLOW), 'dungeon_zone', 'zone.png');
  ids.zoneBg = await up(await solidImage(640, 360, PURPLE), 'dungeon_background', 'zone-bg.png');

  ctx = {
    config: { assetsDir },
    logger: silentLogger(),
    content: w.content.current,
    services: { dungeonPlay: w.play, artworkAssets: w.assets, sceneComposition: w.scenes },
  } as unknown as AppContext;
});
afterAll(async () => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
  await w?.cleanup();
});

/** A zone whose every fight is a Grunt (or the named enemy), with a chosen background pool. */
const zone = (key: string, backgrounds: unknown[], patch: Record<string, unknown> = {}, enemyKey = 'grunt') =>
  w.zone(key, (z) => {
    z.pools.combat = [{ id: enemyKey, enemyKey, weight: 10 }];
    z.pools.boss = [{ id: enemyKey, enemyKey, weight: 10 }];
    Object.assign(z, { backgrounds, ...patch });
  });

const setEnemyArt = (key: string, art: { artworkAssetId?: string | null; spriteAssetId?: string | null; spritePlacement?: SpritePlacement | null }) =>
  w.setEnemyArtwork(key, art);

/** Walk until the player stands on a node that satisfies `want`, without resolving it. */
async function advanceTo(playerId: number, from: DungeonRunView, want: (v: DungeonRunView) => boolean): Promise<DungeonRunView> {
  let view = from;
  for (let guard = 0; guard < 100; guard++) {
    if (view.nodeStatus === 'entered' && want(view)) return view;
    if (view.status !== 'active') break;
    const result =
      view.nodeStatus === 'entered'
        ? await w.play.resolveNode(playerId, view.id, view.node.id)
        : await w.play.enterNode(playerId, view.id, view.next[0]!.id);
    view = result.run;
  }
  throw new Error('advanceTo: the run ended before reaching the node');
}

const startOn = async (zoneKey: string, firstNode: (type: string) => boolean = (t) => t === 'combat') => {
  const seed = await w.seedFor(zoneKey, (g) => firstNode(g.nodes[0]!.type));
  const { playerId } = await w.player();
  return { playerId, seed, view: await w.play.start(playerId, zoneKey, { seed }) };
};

async function picture(view: DungeonRunView) {
  const art = await dungeonRunSceneArtwork(ctx, view);
  if (!art) return null;
  const source = art.file.attachment as string | Buffer;
  const bytes = typeof source === 'string' ? fs.readFileSync(source) : source;
  return { name: art.file.name!, url: art.url, bytes };
}
const colourAt = async (bytes: Buffer, x: number, y: number) => pixelAt(await sharp(bytes).png().toBuffer(), x, y);

describe('a fight', () => {
  it('shows the composed scene: the snapshotted background with the enemy sprite over it', async () => {
    await setEnemyArt('grunt', { spriteAssetId: ids.sprite, spritePlacement: CENTER });
    await zone('sc_composed', [{ id: 'blue', weight: 1, assetId: ids.bgBlue }]);
    const { view } = await startOn('sc_composed');

    // The choice is on the run, not made by the screen.
    expect(view.node.background).toEqual({ entryId: 'blue', assetId: ids.bgBlue, artworkPath: null });
    expect(view.node.enemy!.visual).toMatchObject({ spriteAssetId: ids.sprite, spritePlacement: CENTER });

    const scene = (await picture(view))!;
    expect(scene.name).toMatch(/^dungeon-scene-[0-9a-f]{16}\.webp$/);
    expect(scene.url).toBe(`attachment://${scene.name}`);
    expect(await sharp(scene.bytes).metadata()).toMatchObject({ format: 'webp', width: 1200, height: 675 });
    expect(isNear(await colourAt(scene.bytes, 600, 337), RED)).toBe(true); // the sprite
    expect(isNear(await colourAt(scene.bytes, 30, 30), BLUE)).toBe(true); // the background
    // Rendering again attaches the same cached scene.
    expect((await picture(view))!.name).toBe(scene.name);
  });

  it('uses the zone background when the node drew none, and a shipped background when that is what the pool names', async () => {
    await zone('sc_zone_bg', [], { backgroundAssetId: ids.zoneBg });
    const a = await startOn('sc_zone_bg');
    expect(a.view.node.background).toBeNull();
    const overZone = (await picture(a.view))!;
    expect(overZone.name).toMatch(/^dungeon-scene-/);
    expect(isNear(await colourAt(overZone.bytes, 30, 30), PURPLE)).toBe(true);
    expect(isNear(await colourAt(overZone.bytes, 600, 337), RED)).toBe(true);

    await zone('sc_shipped_bg', [{ id: 'git', weight: 1, artworkPath: 'dungeons/backgrounds/shipped_bg.png' }]);
    const b = await startOn('sc_shipped_bg');
    expect(b.view.node.background).toEqual({ entryId: 'git', assetId: null, artworkPath: 'dungeons/backgrounds/shipped_bg.png' });
    const overShipped = (await picture(b.view))!;
    expect(isNear(await colourAt(overShipped.bytes, 30, 30), GREEN)).toBe(true);
    expect(isNear(await colourAt(overShipped.bytes, 600, 337), RED)).toBe(true);
  });

  it('falls back to the enemy’s full artwork — managed first, then shipped', async () => {
    await zone('sc_full_art', [{ id: 'blue', weight: 1, assetId: ids.bgBlue }]);
    // No sprite, managed full art: the asset's own bytes, named by its hash.
    await setEnemyArt('grunt', { artworkAssetId: ids.fullArt });
    const managed = await startOn('sc_full_art');
    const hash = (await w.assets.get(ids.fullArt))!.contentHash;
    const full = (await picture(managed.view))!;
    expect(full.name).toBe(`dungeon-art-${hash.slice(0, 12)}.png`);
    expect(isNear(await colourAt(full.bytes, 150, 150), RED)).toBe(true);

    // No override at all: the shipped file, exactly as before managed art existed.
    await setEnemyArt('grunt', {});
    const shipped = await startOn('sc_full_art');
    expect((await picture(shipped.view))!.name).toBe('dungeon-grunt.webp');

    await setEnemyArt('grunt', { spriteAssetId: ids.sprite, spritePlacement: CENTER });
  });

  it('with no sprite and no enemy art: the node background alone, then zone art, then zone background, then text', async () => {
    // Sentinel has no artwork of any kind.
    await zone('sc_bg_only', [{ id: 'yellow', weight: 1, assetId: ids.bgYellow }], { artworkAssetId: ids.zoneArt }, 'sentinel');
    const a = await startOn('sc_bg_only');
    const alone = (await picture(a.view))!;
    expect(alone.name).toMatch(/^dungeon-scene-/);
    expect(isNear(await colourAt(alone.bytes, 600, 337), YELLOW)).toBe(true); // no sprite in the middle

    const zoneArtHash = (await w.assets.get(ids.zoneArt))!.contentHash;
    await zone('sc_zone_art', [], { artworkAssetId: ids.zoneArt, artworkPath: 'dungeons/zones/shipped_zone.png', backgroundAssetId: ids.zoneBg }, 'sentinel');
    const b = await startOn('sc_zone_art');
    expect((await picture(b.view))!.name).toBe(`dungeon-art-${zoneArtHash.slice(0, 12)}.png`);

    await zone('sc_zone_shipped', [], { artworkPath: 'dungeons/zones/shipped_zone.png', backgroundArtworkPath: 'dungeons/backgrounds/shipped_bg.png' }, 'sentinel');
    const c = await startOn('sc_zone_shipped');
    expect((await picture(c.view))!.name).toBe('dungeon-shipped-zone.png');

    await zone('sc_zone_bg_only', [], { artworkPath: 'dungeons/zones/not_deployed.png', backgroundArtworkPath: 'dungeons/backgrounds/shipped_bg.png' }, 'sentinel');
    const d = await startOn('sc_zone_bg_only');
    expect((await picture(d.view))!.name).toBe('dungeon-shipped-bg.png');

    await zone('sc_nothing', [], {}, 'sentinel');
    const e = await startOn('sc_nothing');
    expect(await picture(e.view)).toBeNull();
  });
});

describe('event, rest and reward nodes', () => {
  it('show the selected background alone — never an enemy composed onto it', async () => {
    await zone('sc_noncombat', [{ id: 'blue', weight: 1, assetId: ids.bgBlue }], { artworkAssetId: ids.zoneArt });
    for (const type of ['rest', 'reward']) {
      const { playerId, view } = await startOn('sc_noncombat');
      const at = await advanceTo(playerId, view, (v) => v.node.type === type);
      expect(at.node.enemy).toBeNull();
      expect(at.node.background).toMatchObject({ entryId: 'blue' });
      const scene = (await picture(at))!;
      expect(scene.name, type).toMatch(/^dungeon-scene-/);
      // The whole canvas is background: no red sprite anywhere down the middle.
      for (const [x, y] of [[600, 337], [600, 600], [1000, 500], [30, 30]] as const) {
        expect(isNear(await colourAt(scene.bytes, x, y), BLUE), `${type} ${x},${y}`).toBe(true);
      }
    }
  });

  it('an event’s own artwork wins; without it, the background; without a pool, the zone art', async () => {
    const withArt = (on: boolean): LoadedContent => ({
      ...w.content.current,
      dungeonEvents: w.content.current.dungeonEvents!.map((e) => ({ ...e, artworkPath: on ? 'dungeons/events/shrine.png' : null })),
    });
    const original = w.content.current;
    const eventZone = async (key: string, backgrounds: unknown[], patch: Record<string, unknown> = {}) =>
      w.zone(key, (z) => {
        z.generation.nodeWeights = { ...z.generation.nodeWeights, event: 500 };
        Object.assign(z, { backgrounds, ...patch });
      });
    try {
      w.content.current = withArt(true);
      await eventZone('sc_event_art', [{ id: 'blue', weight: 1, assetId: ids.bgBlue }]);
      const a = await startOn('sc_event_art', (t) => t === 'event');
      expect(a.view.node.event).not.toBeNull();
      expect((await picture(a.view))!.name).toBe('dungeon-shrine.png');

      w.content.current = withArt(false);
      const b = await startOn('sc_event_art', (t) => t === 'event');
      const scene = (await picture(b.view))!;
      expect(scene.name).toMatch(/^dungeon-scene-/);
      expect(isNear(await colourAt(scene.bytes, 600, 337), BLUE)).toBe(true);

      await eventZone('sc_event_zone', [], { artworkPath: 'dungeons/zones/shipped_zone.png' });
      const c = await startOn('sc_event_zone', (t) => t === 'event');
      expect((await picture(c.view))!.name).toBe('dungeon-shipped-zone.png');
    } finally {
      w.content.current = original;
    }
  });
});

describe('snapshot semantics', () => {
  const POOL = [
    { id: 'blue', weight: 50, assetId: ids.bgBlue },
    { id: 'yellow', weight: 50, assetId: ids.bgYellow },
    { id: 'git', weight: 50, artworkPath: 'dungeons/backgrounds/shipped_bg.png' },
  ];
  const pool = () => POOL.map((b) => ({ ...b, ...(b.id === 'blue' ? { assetId: ids.bgBlue } : b.id === 'yellow' ? { assetId: ids.bgYellow } : {}) }));

  it('the same seed reproduces the same backgrounds for every node', async () => {
    await zone('sc_seeded', pool());
    const a = await w.player();
    const b = await w.player();
    const first = await w.play.start(a.playerId, 'sc_seeded', { seed: 4242 });
    const second = await w.play.start(b.playerId, 'sc_seeded', { seed: 4242 });
    const scenesOf = async (id: number) => (await w.runs.getRun(id))!.snapshot.scenes!;
    expect(await scenesOf(second.id)).toEqual(await scenesOf(first.id));
    const scenes = await scenesOf(first.id);
    const run = (await w.runs.getRun(first.id))!;
    expect(Object.keys(scenes.nodes).sort()).toEqual(run.graph.nodes.map((n) => n.id).sort());
    expect(new Set(Object.values(scenes.nodes).map((s) => s.background!.entryId)).size).toBeGreaterThan(1);

    const c = await w.player();
    const other = await w.play.start(c.playerId, 'sc_seeded', { seed: 4243 });
    expect(JSON.stringify((await scenesOf(other.id)).nodes)).not.toBe(JSON.stringify(scenes.nodes));
  });

  it('an active run never re-rolls: repaints, zone edits and enemy edits leave its scene choice alone', async () => {
    await zone('sc_stable', pool());
    const { playerId, view } = await startOn('sc_stable');
    const chosen = view.node.background;
    const placement = view.node.enemy!.visual.spritePlacement;
    const before = (await picture(view))!;

    // Painting the screen again and again asks the run, and gets the same answer.
    for (let i = 0; i < 5; i++) {
      const again = await w.play.run(playerId, view.id);
      expect(again.node.background).toEqual(chosen);
      expect((await picture(again))!.name).toBe(before.name);
    }

    // An admin replaces the pool, moves the sprite and swaps the enemy's art.
    const current = (await w.zones.get('sc_stable'))!;
    await w.zones.update(
      'sc_stable',
      { zone: { ...current.zone, backgrounds: [{ id: 'only', weight: 1, assetId: ids.zoneBg }], backgroundAssetId: ids.zoneBg }, expectedRevision: current.revision },
      'admin',
    );
    await setEnemyArt('grunt', { spriteAssetId: ids.sprite, spritePlacement: { anchor: 'left', scaleBasisPoints: 3000, offsetX: 0, offsetY: 0 } });

    const after = await w.play.run(playerId, view.id);
    expect(after.node.background).toEqual(chosen);
    expect(after.node.enemy!.visual.spritePlacement).toEqual(placement);
    expect((await picture(after))!.name).toBe(before.name);
    // Every other node of the run kept its background too.
    const run = (await w.runs.getRun(view.id))!;
    expect(Object.values(run.snapshot.scenes!.nodes).every((s) => ['blue', 'yellow', 'git'].includes(s.background!.entryId))).toBe(true);

    // The next run is generated from the edited zone and enemy.
    const next = await startOn('sc_stable');
    expect(next.view.node.background).toMatchObject({ entryId: 'only', assetId: ids.zoneBg });
    expect(next.view.node.enemy!.visual.spritePlacement).toMatchObject({ anchor: 'left', scaleBasisPoints: 3000 });
    await setEnemyArt('grunt', { spriteAssetId: ids.sprite, spritePlacement: CENTER });
  });

  it('replacing the image behind an asset shows the new image in an active run — same choice, new picture', async () => {
    const spriteId = (await w.assets.upload({ bytes: await opaqueSprite(200, 200, RED), category: 'enemy_sprite', filename: 'swap.png' }, 'admin')).id;
    await setEnemyArt('sentinel', { spriteAssetId: spriteId, spritePlacement: CENTER });
    await zone('sc_replace', [{ id: 'blue', weight: 1, assetId: ids.bgBlue }], {}, 'sentinel');
    const { playerId, view } = await startOn('sc_replace');
    const before = (await picture(view))!;
    expect(isNear(await colourAt(before.bytes, 600, 337), RED)).toBe(true);

    await w.assets.replace(spriteId, { bytes: await opaqueSprite(200, 200, GREEN) }, 'admin');
    const after = await w.play.run(playerId, view.id);
    // The run still names the same asset…
    expect(after.node.enemy!.visual.spriteAssetId).toBe(spriteId);
    expect(after.node.background).toEqual(view.node.background);
    // …and the scene is a new render of the replacement, not the stale cached one.
    const repainted = (await picture(after))!;
    expect(repainted.name).not.toBe(before.name);
    expect(isNear(await colourAt(repainted.bytes, 600, 337), GREEN)).toBe(true);
    expect(isNear(await colourAt(repainted.bytes, 30, 30), BLUE)).toBe(true);
  });

  it('disabling or losing artwork mid-run never breaks the screen: it falls back', async () => {
    const spriteId = (await w.assets.upload({ bytes: await transparentSprite(200, 200, RED), category: 'enemy_sprite', filename: 'gone.png' }, 'admin')).id;
    const bgId = (await w.assets.upload({ bytes: await solidImage(400, 225, YELLOW), category: 'dungeon_background', filename: 'gone-bg.png' }, 'admin')).id;
    await setEnemyArt('grunt', { spriteAssetId: spriteId, spritePlacement: CENTER });
    await zone('sc_fallback', [{ id: 'y', weight: 1, assetId: bgId }], { backgroundArtworkPath: 'dungeons/backgrounds/shipped_bg.png' });
    const { view } = await startOn('sc_fallback');
    expect((await picture(view))!.name).toMatch(/^dungeon-scene-/);

    // The sprite is switched off: the enemy's shipped full art takes over.
    await w.assets.setEnabled(spriteId, false, 'admin');
    expect((await picture(view))!.name).toBe('dungeon-grunt.webp');
    await w.assets.setEnabled(spriteId, true, 'admin');

    // The node's background is switched off: the sprite is composed over the zone's shipped background.
    await w.assets.setEnabled(bgId, false, 'admin');
    const overZone = (await picture(view))!;
    expect(overZone.name).toMatch(/^dungeon-scene-/);
    expect(isNear(await colourAt(overZone.bytes, 30, 30), GREEN)).toBe(true);
    expect(isNear(await colourAt(overZone.bytes, 600, 337), RED)).toBe(true);

    // The stored files vanish (a database restored without its artwork volume).
    // A scene already rendered is still in the cache and still shows…
    await w.assets.setEnabled(bgId, true, 'admin');
    const rendered = (await picture(view))!.name;
    fs.rmSync(path.join(w.artworkDir, 'managed'), { recursive: true, force: true });
    expect((await picture(view))!.name).toBe(rendered);
    // …and once the cache is gone too there is still a screen: the shipped art.
    fs.rmSync(path.join(w.artworkDir, 'cache'), { recursive: true, force: true });
    expect((await picture(view))!.name).toBe('dungeon-grunt.webp');
  });

  it('a run started before scenes existed renders exactly as it used to', async () => {
    await zone('sc_legacy', [], { artworkPath: 'dungeons/zones/shipped_zone.png' });
    const { view } = await startOn('sc_legacy');
    // What an older snapshot looks like: no scenes, no enemy artwork, no asset ids on the zone.
    const legacy = {
      ...view,
      zone: { ...view.zone, artworkAssetId: null, backgroundAssetId: null },
      node: { ...view.node, background: null, enemy: { ...view.node.enemy!, visual: { ...view.node.enemy!.visual, spriteAssetId: null, artworkAssetId: null } } },
    } as DungeonRunView;
    expect((await dungeonRunSceneArtwork(ctx, legacy))!.file.name).toBe('dungeon-grunt.webp');
    // And with no artwork services wired at all, shipped art still shows.
    const bare = { ...ctx, services: {} } as unknown as AppContext;
    expect((await dungeonRunSceneArtwork(bare, view))!.file.name).toBe('dungeon-grunt.webp');
  });
});

describe('the Delve home and zone screens', () => {
  it('show the managed zone art over the shipped path, then the background, then nothing', async () => {
    const art = await w.assets.upload({ bytes: await solidImage(120, 120, PURPLE), category: 'dungeon_zone', filename: 'home.png' }, 'admin');
    const zoneRef = { artworkAssetId: art.id, artworkPath: 'dungeons/zones/shipped_zone.png', backgroundAssetId: null, backgroundArtworkPath: 'dungeons/backgrounds/shipped_bg.png' };
    expect((await dungeonZoneArtwork(ctx, [zoneRef]))!.file.name).toBe(`dungeon-art-${art.contentHash.slice(0, 12)}.png`);
    await w.assets.setEnabled(art.id, false, 'admin');
    expect((await dungeonZoneArtwork(ctx, [zoneRef]))!.file.name).toBe('dungeon-shipped-zone.png');
    expect((await dungeonZoneArtwork(ctx, [{ ...zoneRef, artworkPath: null }]))!.file.name).toBe('dungeon-shipped-bg.png');
    expect(await dungeonZoneArtwork(ctx, [{ artworkPath: null, backgroundArtworkPath: null }])).toBeNull();
  });
});
