/**
 * Authored (room-by-room) dungeons end to end.
 *
 * The point of these tests is what is *not* here: there is no authored play
 * service. A hand-built layout is compiled into the same run graph the
 * generator produces, and everything after run start — moving, fighting,
 * resting, rewards, extraction, completion, defeat, artwork, the Discord
 * screens — is the existing code, exercised unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dungeonRunEvents, dungeonRuns, dungeonZones } from '../../src/db/schema';

vi.mock('../../src/discord/assets/attachRenderedCard', () => ({
  ownedArtworkImage: vi.fn(() => ({
    file: new AttachmentBuilder(Buffer.from('buddy'), { name: 'waifumon-buddy.webp' }),
    url: 'attachment://waifumon-buddy.webp',
  })),
}));

import {
  handleDungeonEnter,
  handleDungeonExtract,
  handleDungeonExtractConfirm,
  handleDungeonResolve,
  handleDungeonRun,
  handleDungeonStart,
  handleDungeonZone,
} from '../../src/discord/commands/waifumonDungeon';
import { dungeonRunSceneArtwork } from '../../src/discord/dungeonArtwork';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import type { SpritePlacement } from '../../src/modules/artworkAssets/scenePlacement';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonPlayService';
import { loadShippedDungeonZones, seedDungeonZones } from '../../src/modules/dungeons/dungeonZoneStore';
import type { DungeonZoneDefinitionInput } from '../../src/modules/dungeons/zoneDefinition';
import { AppError, DungeonZoneInvalidError, DungeonZoneUnavailableError } from '../../src/shared/errors';
import {
  GEAR_TABLE,
  STARTER,
  atCompleted,
  authoredZoneDoc,
  createDungeonWorld,
  walk,
  type DungeonWorld,
} from '../helpers/dungeonPlayFixtures';
import { CONTENT_DIR } from '../helpers/fixtures';
import { BLUE, GREEN, RED, isNear, pixelAt, solidImage, transparentSprite } from '../helpers/imageFixtures';
import { silentLogger } from '../helpers/testDb';

const YELLOW = { r: 230, g: 220, b: 30 };
const MAIN = 'au_main';
const CENTER: SpritePlacement = { anchor: 'center', scaleBasisPoints: 8000, offsetX: 0, offsetY: 0 };

let w: DungeonWorld;
let ctx: AppContext;
const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-authored-assets-'));
const ids = { zoneBg: '', roomBg: '', sprite: '', roomSprite: '' };

const authoredZone = (key: string, patch?: (zone: DungeonZoneDefinitionInput) => void) =>
  w.zones.create(authoredZoneDoc(key, patch), 'test');
const roomOf = (view: DungeonRunView) => view.node.label;
const goTo = (name: string) => (next: DungeonRunView['next']) => next.find((n) => n.label === name || n.enemy?.name === name || n.event?.name === name) ?? next[0]!;

beforeAll(async () => {
  w = await createDungeonWorld();
  await authoredZone(MAIN);

  const up = async (bytes: Buffer, category: Parameters<typeof w.assets.upload>[0]['category'], filename: string) =>
    (await w.assets.upload({ bytes, category, filename }, 'admin')).id;
  ids.zoneBg = await up(await solidImage(800, 450, BLUE), 'dungeon_background', 'zone-default.png');
  ids.roomBg = await up(await solidImage(800, 450, YELLOW), 'dungeon_background', 'room.png');
  ids.sprite = await up(await transparentSprite(300, 300, RED), 'enemy_sprite', 'grunt.png');
  ids.roomSprite = await up(await transparentSprite(300, 300, GREEN), 'enemy_sprite', 'grunt-alt.png');

  ctx = {
    config: { assetsDir },
    logger: silentLogger(),
    content: w.content.current,
    services: { dungeonPlay: w.play, collection: w.app.collection, artworkAssets: w.assets, sceneComposition: w.scenes },
  } as unknown as AppContext;
});
afterAll(async () => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
  await w?.cleanup();
});

describe('starting an authored run', () => {
  it('compiles the rooms into the stored graph and starts on the start room', async () => {
    const { playerId } = await w.player();
    const view = await w.play.start(playerId, MAIN);
    expect(view).toMatchObject({ status: 'active', depth: 1, depthCount: 6, currentHp: STARTER.maxHp, nodeStatus: 'entered' });
    expect(view.node).toMatchObject({ id: 'n1', type: 'combat', label: 'Entrance', enemy: { key: 'grunt' } });

    const run = (await w.runs.getRun(view.id))!;
    expect(run.graph.nodes.map((n) => [n.id, n.roomId, n.type, n.depth])).toEqual([
      ['n1', 'entrance', 'combat', 1],
      ['n2', 'pit', 'event', 2],
      ['n3', 'camp', 'rest', 3],
      ['n4', 'post', 'elite', 4],
      ['n5', 'vault', 'reward', 4],
      ['n6', 'landing', 'rest', 5],
      ['n7', 'throne', 'boss', 6],
    ]);
    // The snapshot holds exactly what the rooms placed.
    expect(Object.keys(run.snapshot.enemies).sort()).toEqual(['grunt', 'overlord', 'sentinel']);
    expect(Object.keys(run.snapshot.events)).toEqual(['trap']);
    expect(Object.keys(run.snapshot.rewardTables).sort()).toEqual([GEAR_TABLE, 'test-dungeon-loot'].sort());
    expect(run.snapshot.zone.layoutMode).toBe('authored');
    // A reproduction rebuilds the same graph from the snapshot.
    expect(w.runs.reproduceGraph(run)).toEqual(run.graph);
  });

  it('is the same layout whatever the seed', async () => {
    const a = await w.player();
    const b = await w.player();
    const one = (await w.runs.getRun((await w.play.start(a.playerId, MAIN, { seed: 1 })).id))!;
    const two = (await w.runs.getRun((await w.play.start(b.playerId, MAIN, { seed: 999 })).id))!;
    expect(two.graph.nodes).toEqual(one.graph.nodes);
    expect(two.graph.edges).toEqual(one.graph.edges);
  });

  it('lists the zone with its real length and boss, like any other', async () => {
    const { playerId } = await w.player();
    const card = (await w.play.home(playerId)).zones.find((z) => z.key === MAIN)!;
    expect(card).toMatchObject({ minDepth: 6, maxDepth: 6, hasBoss: true });
  });

  it('refuses an enabled zone whose layout has since been broken, and spends no daily run', async () => {
    await authoredZone('au_broken', (z) => {
      z.enabled = false;
      z.authored!.rooms![5]!.next = [];
    });
    // Switched on behind validation's back: the run service must still refuse it.
    await w.t.db.update(dungeonZones).set({ enabled: true }).where(eq(dungeonZones.zoneKey, 'au_broken'));
    const { playerId } = await w.player();
    const before = await w.allowance.status(playerId);
    await expect(w.play.start(playerId, 'au_broken')).rejects.toBeInstanceOf(DungeonZoneInvalidError);
    expect((await w.allowance.status(playerId)).remaining).toBe(before.remaining);
  });
});

describe('playing an authored run through the existing play service', () => {
  it('fights, takes the event, rests by the room’s own heal, and offers the fork', async () => {
    const { playerId } = await w.player();
    let view = await w.play.start(playerId, MAIN);

    view = (await w.play.resolveNode(playerId, view.id, view.node.id)).run;
    expect(view.resolution).toMatchObject({ kind: 'combat', enemyKey: 'grunt', result: 'player_victory' });
    expect(view.currentHp).toBe(STARTER.maxHp - 36);
    expect(view.unbankedCurrency).toBe(2); // the zone's band: the room set no reward
    expect(view.next.map((n) => n.label)).toEqual(['Pit']);

    view = (await w.play.enterNode(playerId, view.id, view.next[0]!.id)).run;
    view = (await w.play.resolveNode(playerId, view.id, view.node.id)).run;
    expect(view.resolution).toMatchObject({ kind: 'event', eventKey: 'trap', hpChangeBasisPoints: -1000 });
    expect(view.currentHp).toBe(STARTER.maxHp - 36 - 37);

    view = (await w.play.enterNode(playerId, view.id, view.next[0]!.id)).run;
    expect(view.node).toMatchObject({ type: 'rest', label: 'Camp', restHealBasisPoints: 1000, extraction: true });
    view = (await w.play.resolveNode(playerId, view.id, view.node.id)).run;
    // The room's 10%, not the zone's 30%.
    expect(view.resolution).toEqual({ kind: 'rest', healBasisPoints: 1000, hpBefore: 297, hpAfter: 334 });
    expect(view.canExtract).toBe(true);
    expect(view.next.map((n) => [n.label, n.type])).toEqual([['Guard Post', 'elite'], ['Vault', 'reward']]);
  });

  it('takes a branch, closes the other, rejoins, and completes on the boss', async () => {
    const { playerId } = await w.player();
    const start = await w.play.start(playerId, MAIN);
    const atFork = await walk(w.play, playerId, start, { stopAt: atCompleted('rest') });
    const [post, vault] = atFork.next;

    const entered = await w.play.enterNode(playerId, atFork.id, vault!.id);
    expect(entered.status).toBe('applied');
    // The other side of the fork is gone.
    expect(await w.play.enterNode(playerId, atFork.id, post!.id)).toMatchObject({ status: 'refused', refusal: 'not_available' });

    const paid = (await w.play.resolveNode(playerId, atFork.id, vault!.id)).run;
    // The room's own reward: 5 currency, a guaranteed gear drop, and the loot table.
    expect(paid.resolution).toMatchObject({ kind: 'reward', rewards: { currency: 5, waifubux: 11 } });
    expect(paid.secured.map((s) => s.kind).sort()).toEqual(['equipment', 'item', 'waifubux']);
    expect(paid.next.map((n) => n.label)).toEqual(['Landing']); // the rejoin

    const landing = (await w.play.enterNode(playerId, paid.id, paid.next[0]!.id)).run;
    expect(landing.node.restHealBasisPoints).toBe(3000); // inherited from the zone

    const done = await walk(w.play, playerId, landing);
    expect(done.status).toBe('completed');
    expect(done.settlement).toMatchObject({ outcome: 'completed', cause: 'boss_defeated' });
    // entrance 2 + vault 5 + boss 10 + completion 7
    expect(done.settlement!.banked).toBe(24);
    expect(await w.balance(playerId)).toBe(24);
  });

  it('pays the other branch what that room says', async () => {
    const { playerId } = await w.player();
    const done = await walk(w.play, playerId, await w.play.start(playerId, MAIN), { pick: goTo('Guard Post') });
    expect(done.status).toBe('completed');
    // entrance 2 + post 4 + boss 10 + completion 7
    expect(await w.balance(playerId)).toBe(23);
  });

  it('extracts from a room the author allowed it in, banking everything', async () => {
    const { playerId } = await w.player();
    const atCamp = await walk(w.play, playerId, await w.play.start(playerId, MAIN), { stopAt: atCompleted('rest') });
    const out = await w.play.extract(playerId, atCamp.id, atCamp.node.id);
    expect(out.status).toBe('applied');
    expect(out.run.settlement).toMatchObject({ outcome: 'extracted', banked: 2 });
    expect(await w.balance(playerId)).toBe(2);
  });

  it('does not let the player extract from a room that does not offer it', async () => {
    const { playerId } = await w.player();
    const start = await w.play.start(playerId, MAIN);
    const fought = (await w.play.resolveNode(playerId, start.id, start.node.id)).run;
    expect(fought.canExtract).toBe(false);
    expect(await w.play.extract(playerId, fought.id, fought.node.id)).toMatchObject({ status: 'refused', refusal: 'not_extractable' });
  });

  it('ends in defeat on a fight that cannot be won, keeping the retention share', async () => {
    await authoredZone('au_doomed', (z) => {
      z.authored!.rooms![6]!.enemyKey = 'brute';
    });
    const { playerId } = await w.player();
    const done = await walk(w.play, playerId, await w.play.start(playerId, 'au_doomed'), { pick: goTo('Vault') });
    expect(done.status).toBe('defeated');
    expect(done.settlement).toMatchObject({ outcome: 'defeated', cause: 'hp_zero' });
    // 2 + 5 unbanked, 25% kept, rounded down.
    expect(done.settlement!.banked).toBe(1);
  });

  it('completes on a final Exit when the layout has no boss', async () => {
    await authoredZone('au_exit', (z) => {
      z.authored = {
        startRoomId: 'in',
        rooms: [
          { id: 'in', type: 'combat', enemyKey: 'grunt', next: ['hatch'] },
          { id: 'hatch', name: 'Side Hatch', type: 'exit', next: ['out'] },
          { id: 'out', name: 'Daylight', type: 'exit' },
        ],
      };
    });
    const { playerId } = await w.player();
    const card = (await w.play.home(playerId)).zones.find((z) => z.key === 'au_exit')!;
    expect(card.hasBoss).toBe(false);
    const atHatch = await walk(w.play, playerId, await w.play.start(playerId, 'au_exit'), { stopAt: atCompleted('exit') });
    expect(atHatch).toMatchObject({ canExtract: true, node: { label: 'Side Hatch', terminal: false } });
    const done = await walk(w.play, playerId, atHatch);
    expect(done.settlement).toMatchObject({ outcome: 'completed', cause: 'exit_reached' });
  });

  it('writes the same run history a generated run does', async () => {
    const { playerId } = await w.player();
    const done = await walk(w.play, playerId, await w.play.start(playerId, MAIN), { pick: goTo('Vault') });
    const types = (await w.play.history(done.id)).map((e) => e.type);
    expect(types).toEqual([
      'run_started',
      'node_entered', 'combat_resolved',
      'node_entered', 'event_resolved',
      'node_entered', 'rest_resolved',
      'node_entered', 'reward_resolved',
      'node_entered', 'rest_resolved',
      'node_entered', 'combat_resolved',
      'currency_banked',
      'completion',
    ]);
    const [started] = await w.t.db.select().from(dungeonRunEvents).where(eq(dungeonRunEvents.runId, done.id)).limit(1);
    expect(started!.payload).toMatchObject({ zoneKey: MAIN, nodeCount: 7, depthCount: 6 });
  });
});

describe('snapshot: an edit reaches the next run, never one in progress', () => {
  it('keeps an active run on the layout it started with', async () => {
    const key = 'au_snapshot';
    const created = await authoredZone(key);
    const { playerId } = await w.player();
    const atFork = await walk(w.play, playerId, await w.play.start(playerId, key), { stopAt: atCompleted('rest') });

    // The author removes the fork entirely and renames the camp.
    const edited = authoredZoneDoc(key, (z) => {
      const rooms = z.authored!.rooms!;
      rooms[2] = { ...rooms[2]!, name: 'Ruined Camp', next: ['landing'], healBasisPoints: 5000 };
      z.authored!.rooms = rooms.filter((r) => r.id !== 'post' && r.id !== 'vault');
    });
    await w.zones.update(key, { zone: edited, expectedRevision: created.revision }, 'test');

    // The run in progress still has its fork, its room names and its rewards.
    const still = await w.play.run(playerId, atFork.id);
    expect(still.node.label).toBe('Camp');
    expect(still.next.map((n) => n.label)).toEqual(['Guard Post', 'Vault']);
    const done = await walk(w.play, playerId, still, { pick: goTo('Vault') });
    expect(done.settlement!.banked).toBe(24);

    // A new run walks the edited layout.
    const other = await w.player();
    const fresh = await w.play.start(other.playerId, key);
    const stored = (await w.runs.getRun(fresh.id))!;
    expect(stored.graph.nodes.map((n) => n.roomId)).toEqual(['entrance', 'pit', 'camp', 'landing', 'throne']);
    expect(stored.zoneRevision).toBe(created.revision + 1);
    const atCamp = await walk(w.play, other.playerId, fresh, { stopAt: atCompleted('rest') });
    expect(atCamp.node.label).toBe('Ruined Camp');
    expect(atCamp.resolution).toMatchObject({ kind: 'rest', healBasisPoints: 5000 });
  });
});

describe('admin: one zone service for both modes', () => {
  it('summarises an authored zone by its rooms', async () => {
    const summary = (await w.zones.list()).find((z) => z.key === MAIN)!;
    expect(summary).toMatchObject({ layoutMode: 'authored', roomCount: 7, minNodes: 6, maxNodes: 6 });
  });

  it('previews the authored layout exactly, for any seed, with nothing random about it', async () => {
    const one = (await w.zones.preview({ key: MAIN }, 1))!;
    const two = (await w.zones.preview({ key: MAIN }, 2))!;
    expect(one.layoutMode).toBe('authored');
    expect(one.graph.nodes.map((n) => n.name)).toEqual(['Entrance', 'Pit', 'Camp', 'Guard Post', 'Vault', 'Landing', 'Throne']);
    expect(two.graph.nodes).toEqual(one.graph.nodes);
    expect(one.names.enemies).toMatchObject({ grunt: 'Grunt', overlord: 'Overlord' });
    expect(one.structure).toMatchObject({
      bossNodeId: 'n7',
      restNodes: [{ id: 'n3', depth: 3, extraction: true }, { id: 'n6', depth: 5, extraction: false }],
      // A generator guarantee; an authored layout is not held to it.
      restBeforeBoss: { required: false, satisfied: true },
    });
    // Nothing was persisted.
    expect(await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.zoneKey, 'never'))).toEqual([]);
  });

  it('previews an unsaved draft, and reports a broken one in the author’s words', async () => {
    const draft = authoredZoneDoc('au_draft', (z) => {
      z.authored!.rooms![5]!.next = ['nowhere'];
    });
    await expect(w.zones.preview({ zone: draft }, 1)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ message: 'Room "Landing" points to a room that no longer exists.' })]),
    });
    expect((await w.zones.preview({ zone: authoredZoneDoc('au_draft') }, 1))!.graph.nodes).toHaveLength(7);
  });

  it('refuses to simulate generation for a layout that is not generated', async () => {
    const attempt = w.zones.simulate({ key: MAIN }, { runs: 10 });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ code: 'VALIDATION_ERROR', userMessage: expect.stringMatching(/built room by room/) });
  });

  it('saves a half-built layout on a disabled zone, and will not switch it on', async () => {
    const detail = await authoredZone('au_wip', (z) => {
      z.enabled = false;
      z.authored!.rooms!.push({ id: 'loose', name: 'Loose End', type: 'reward' });
    });
    expect(detail.issues.map((i) => i.severity)).toContain('warning');
    await expect(w.zones.setEnabled('au_wip', { enabled: true, expectedRevision: detail.revision }, 'test')).rejects.toBeInstanceOf(
      DungeonZoneInvalidError,
    );
  });

  it('refuses a save that changes the layout mode until it is confirmed, and deletes nothing when it is', async () => {
    const key = 'au_convert';
    await w.zone(key);
    const before = (await w.zones.get(key))!;
    const rooms = authoredZoneDoc(key).authored!;
    const converted = { ...before.zone, layoutMode: 'authored' as const, authored: rooms };

    const refused = w.zones.update(key, { zone: converted, expectedRevision: before.revision }, 'test');
    await expect(refused).rejects.toBeInstanceOf(DungeonZoneInvalidError);
    await expect(refused).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: 'layoutMode', message: expect.stringMatching(/from procedural to room-by-room.*Nothing is deleted/) })],
    });
    expect((await w.zones.get(key))!.revision).toBe(before.revision);

    const saved = (await w.zones.update(key, { zone: converted, expectedRevision: before.revision, confirmLayoutChange: true }, 'test'))!;
    expect(saved.layoutMode).toBe('authored');
    // The generator settings are still there, untouched, should the author go back.
    expect(saved.zone.generation).toEqual(before.zone.generation);
    expect(saved.zone.pools).toEqual(before.zone.pools);

    // …and going back keeps the rooms.
    const back = (await w.zones.update(
      key,
      { zone: { ...saved.zone, layoutMode: 'procedural' }, expectedRevision: saved.revision, confirmLayoutChange: true },
      'test',
    ))!;
    expect(back.layoutMode).toBe('procedural');
    expect(back.zone.authored.rooms).toHaveLength(7);
    // An ordinary save of the same mode needs no confirmation.
    await expect(w.zones.update(key, { zone: { ...back.zone, name: 'Renamed' }, expectedRevision: back.revision }, 'test')).resolves.toMatchObject({
      name: 'Renamed',
    });
  });

  it('records the artwork each room references, so the asset library can show where an image is used', async () => {
    const key = 'au_refs';
    await authoredZone(key, (z) => {
      z.authored!.rooms![0] = { ...z.authored!.rooms![0]!, backgroundAssetId: ids.roomBg, scene: { spriteAssetId: ids.roomSprite } };
    });
    const references = await w.assets.references(ids.roomBg);
    expect(references).toEqual([expect.objectContaining({ kind: 'dungeon_zone', key, field: 'authored.rooms[entrance].backgroundAssetId' })]);
    expect((await w.assets.references(ids.roomSprite))[0]).toMatchObject({ key, field: 'authored.rooms[entrance].scene.spriteAssetId' });
  });
});

describe('the shipped authoring example', () => {
  it('seeds disabled and tagged, validates clean, and is never offered to a player', async () => {
    const shipped = loadShippedDungeonZones(CONTENT_DIR);
    const example = shipped.find((z) => z.definition.layoutMode === 'authored')!;
    expect(example.definition).toMatchObject({ key: 'service_tunnel_example', enabled: false });
    expect(example.definition.tags).toEqual(['authoring_example', 'initial_tuning']);
    // Scrapheap stays procedural.
    expect(shipped.find((z) => z.key === 'scrapheap_gauntlet')!.definition.layoutMode).toBe('procedural');

    await seedDungeonZones(w.t.db, [example]);
    const { playerId } = await w.player();
    expect((await w.play.home(playerId)).zones.map((z) => z.key)).not.toContain(example.key);
    await expect(w.play.start(playerId, example.key)).rejects.toBeInstanceOf(DungeonZoneUnavailableError);
  });
});

/* ───────────────────────── artwork ───────────────────────── */

async function picture(view: DungeonRunView) {
  const art = await dungeonRunSceneArtwork(ctx, view);
  if (!art) return null;
  const source = art.file.attachment as string | Buffer;
  const bytes = typeof source === 'string' ? fs.readFileSync(source) : source;
  return { name: art.file.name!, bytes: await sharp(bytes).png().toBuffer() };
}
const setGruntArt = (art: { spriteAssetId: string | null; spritePlacement: SpritePlacement | null }) =>
  w.setEnemyArtwork('grunt', art);

describe('artwork inheritance', () => {
  beforeAll(() => setGruntArt({ spriteAssetId: ids.sprite, spritePlacement: CENTER }));

  it('a room with nothing set shows the zone default background with the enemy’s own sprite and placement', async () => {
    await authoredZone('au_art_default', (z) => {
      z.backgroundAssetId = ids.zoneBg;
    });
    const { playerId } = await w.player();
    const view = await w.play.start(playerId, 'au_art_default');
    expect(view.node.background).toEqual({ entryId: 'zone_default', assetId: ids.zoneBg, artworkPath: null });
    expect(view.node.enemy!.visual).toMatchObject({ spriteAssetId: ids.sprite, spritePlacement: CENTER });

    const scene = (await picture(view))!;
    expect(scene.name).toMatch(/^dungeon-scene-/); // the production compositor
    expect(isNear(await pixelAt(scene.bytes, 600, 337), RED)).toBe(true);
    expect(isNear(await pixelAt(scene.bytes, 30, 30), BLUE)).toBe(true);
  });

  it('a room’s own background and sprite win over the zone’s and the enemy’s — and a rest room uses the default too', async () => {
    const key = 'au_art_override';
    const offCentre: SpritePlacement = { anchor: 'bottom-left', scaleBasisPoints: 4000, offsetX: 0, offsetY: 0 };
    const created = await authoredZone(key, (z) => {
      z.backgroundAssetId = ids.zoneBg;
      const rooms = z.authored!.rooms!;
      rooms[0] = { ...rooms[0]!, backgroundAssetId: ids.roomBg, scene: { spriteAssetId: ids.roomSprite, spritePlacement: CENTER } };
      rooms[6] = { ...rooms[6]!, enemyKey: 'grunt', scene: { spritePlacement: offCentre } };
    });
    const { playerId } = await w.player();
    const view = await w.play.start(playerId, key);
    expect(view.node.background).toEqual({ entryId: 'room:entrance', assetId: ids.roomBg, artworkPath: null });
    expect(view.node.enemy!.visual).toMatchObject({ spriteAssetId: ids.roomSprite, spritePlacement: CENTER });
    const scene = (await picture(view))!;
    expect(isNear(await pixelAt(scene.bytes, 600, 337), GREEN)).toBe(true);
    expect(isNear(await pixelAt(scene.bytes, 30, 30), YELLOW)).toBe(true);

    // A room that is not a fight: the zone default background, no enemy on it.
    const atCamp = await walk(w.play, playerId, view, { stopAt: (v) => v.node.type === 'rest' });
    const camp = (await picture(atCamp))!;
    expect(isNear(await pixelAt(camp.bytes, 600, 337), BLUE)).toBe(true);

    // The boss room overrides placement only: the enemy's sprite, the room's position.
    const run = (await w.runs.getRun(view.id))!;
    expect(run.snapshot.scenes!.nodes.n7!.enemy).toEqual({ spriteAssetId: null, artworkAssetId: null, spritePlacement: offCentre });

    // Clearing the room's overrides restores what it inherits — for the next run.
    const cleared = authoredZoneDoc(key, (z) => {
      z.backgroundAssetId = ids.zoneBg;
    });
    await w.zones.update(key, { zone: cleared, expectedRevision: created.revision }, 'test');
    const other = await w.player();
    const fresh = await w.play.start(other.playerId, key);
    expect(fresh.node.background).toEqual({ entryId: 'zone_default', assetId: ids.zoneBg, artworkPath: null });
    expect(fresh.node.enemy!.visual).toMatchObject({ spriteAssetId: ids.sprite });
    const restored = (await picture(fresh))!;
    expect(isNear(await pixelAt(restored.bytes, 600, 337), RED)).toBe(true);
    expect(isNear(await pixelAt(restored.bytes, 30, 30), BLUE)).toBe(true);
    // …while the run already in progress keeps the scene it started with.
    expect((await w.play.run(playerId, view.id)).status).toBe('active');
    expect((await w.runs.getRun(view.id))!.snapshot.scenes!.nodes.n1!.background!.assetId).toBe(ids.roomBg);
  });

  it('falls back to text when neither the room nor the zone has artwork and the enemy has no usable art', async () => {
    await authoredZone('au_art_none', (z) => {
      z.authored!.rooms![0] = { ...z.authored!.rooms![0]!, enemyKey: 'sentinel' };
    });
    const { playerId } = await w.player();
    const view = await w.play.start(playerId, 'au_art_none');
    expect(view.node.background).toBeNull();
    expect(await picture(view)).toBeNull();
  });
});

/* ───────────────────────── Discord ───────────────────────── */

interface ButtonJson {
  custom_id?: string;
  label?: string;
}
interface Payload {
  content?: string;
  embeds?: { toJSON(): { title?: string; description?: string; fields?: { name: string; value: string }[] } }[];
  components?: { toJSON(): { components: ButtonJson[] } }[];
}
function click() {
  const painted: Payload[] = [];
  const paint = vi.fn(async (body: unknown) => {
    painted.push(typeof body === 'string' ? { content: body } : (body as Payload));
  });
  const i = { replied: false, deferred: false, isButton: () => true, isStringSelectMenu: () => false, update: paint, reply: paint, editReply: paint, followUp: paint };
  return { i: i as never, last: () => painted[painted.length - 1]! };
}
const buttonsOf = (p: Payload) => (p.components ?? []).flatMap((row) => row.toJSON().components);
const labelsOf = (p: Payload) => buttonsOf(p).map((b) => b.label);
const textOf = (p: Payload) => {
  const e = p.embeds![0]!.toJSON();
  return [p.content, e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n');
};
async function press(
  prov: Provisioned,
  screen: Payload,
  label: string | RegExp,
  handler: (ctx: AppContext, i: never, prov: Provisioned, args: string[]) => Promise<unknown>,
): Promise<Payload> {
  const button = buttonsOf(screen).find((b) => (typeof label === 'string' ? b.label === label : label.test(b.label ?? '')));
  if (!button) throw new Error(`no button ${String(label)} among ${labelsOf(screen).join(', ')}`);
  const parsed = parseCustomId(button.custom_id!);
  if (!parsed || parsed === 'unknown_version') throw new Error(`not a wm id: ${button.custom_id}`);
  const c = click();
  await handler(ctx, c.i, prov, parsed.args);
  return c.last();
}

describe('an authored run on Discord', () => {
  it('starts from the zone screen and plays room by room through the same screens', async () => {
    const { playerId } = await w.player();
    const prov = { playerId, guildDbId: 1 } as Provisioned;

    const zoneScreen = click();
    await handleDungeonZone(ctx, zoneScreen.i, prov, [MAIN]);
    expect(textOf(zoneScreen.last())).toMatch(/Depth: \*\*6\*\* nodes, ending in a boss/);

    let screen = await press(prov, zoneScreen.last(), 'Start Run', handleDungeonStart);
    expect(textOf(screen)).toMatch(/Depth 1 \/ 6/);
    expect(textOf(screen)).toMatch(/Grunt/);

    screen = await press(prov, screen, /Fight/, handleDungeonResolve);
    expect(textOf(screen)).toMatch(/Victory — Grunt/);
    expect(labelsOf(screen)).toContain('Continue — Event — Trap');

    screen = await press(prov, screen, /^Continue/, handleDungeonEnter);
    screen = await press(prov, screen, /./, handleDungeonResolve);
    // A room with no enemy or event is named by what its author called it.
    expect(labelsOf(screen)).toContain('Continue — Rest — Camp');

    screen = await press(prov, screen, /^Continue/, handleDungeonEnter);
    expect(textOf(screen)).toMatch(/Resting restores \*\*10%\*\* of max HP/);
    screen = await press(prov, screen, /./, handleDungeonResolve);

    // The fork: both authored rooms, and the way out the author allowed here.
    expect(labelsOf(screen)).toEqual(expect.arrayContaining(['Elite — Sentinel', 'Cache — Vault', 'Extract']));
    expect(textOf(screen)).toMatch(/Path ahead/);

    screen = await press(prov, screen, 'Cache — Vault', handleDungeonEnter);
    screen = await press(prov, screen, /./, handleDungeonResolve);
    expect(textOf(screen)).toMatch(/Rewards/);
    expect(labelsOf(screen)).toContain('Continue — Rest — Landing');

    const repaint = click();
    const active = (await w.play.activeRun(playerId))!;
    await handleDungeonRun(ctx, repaint.i, prov, [String(active.id)]);
    expect(labelsOf(repaint.last())).toContain('Continue — Rest — Landing');
  });

  it('extracts at the authored extraction room', async () => {
    const { playerId } = await w.player();
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    const atCamp = await walk(w.play, playerId, await w.play.start(playerId, MAIN), { stopAt: atCompleted('rest') });
    const run = click();
    await handleDungeonRun(ctx, run.i, prov, [String(atCamp.id)]);
    const confirm = await press(prov, run.last(), 'Extract', handleDungeonExtractConfirm);
    const done = await press(prov, confirm, 'Extract', handleDungeonExtract);
    expect(textOf(done)).toMatch(/Extracted/);
    expect((await w.play.run(playerId, atCamp.id)).status).toBe('extracted');
  });
});
