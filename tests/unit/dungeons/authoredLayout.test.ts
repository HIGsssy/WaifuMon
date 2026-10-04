/**
 * Authored dungeons: a hand-built room layout validated in the author's
 * terms and compiled into the same run graph the generator produces.
 */
import { describe, expect, it } from 'vitest';
import {
  AuthoredLayoutError,
  analyseAuthoredLayout,
  buildDungeonGraph,
  compileAuthoredDungeon,
  selectRunScenes,
  validateAuthoredLayout,
  zoneEndsOnBoss,
  zoneRunLength,
} from '../../../src/modules/dungeons/authoredLayout';
import { generateDungeon, type DungeonGraph } from '../../../src/modules/dungeons/dungeonGenerator';
import { selectDungeonScenes } from '../../../src/modules/dungeons/dungeonScenes';
import { loadShippedDungeonZones } from '../../../src/modules/dungeons/dungeonZoneStore';
import {
  DungeonZoneDefinitionSchema,
  dungeonZoneHash,
  type DungeonZoneDefinition,
} from '../../../src/modules/dungeons/zoneDefinition';
import { hasErrors, validateDungeonZone } from '../../../src/modules/dungeons/zoneValidation';
import { CONTENT_DIR } from '../../helpers/fixtures';
import { testCatalogue, testValidationContext, testZone, testZoneDoc } from '../../helpers/dungeonFixtures';

type RoomInput = Record<string, unknown> & { id: string; type: string };

const ASSET_A = '11111111-1111-4111-8111-111111111111';
const ASSET_B = '22222222-2222-4222-8222-222222222222';

/** An authored zone over the test catalogue, with these rooms; the first is the start. */
function authored(rooms: RoomInput[], patch: Record<string, unknown> = {}): DungeonZoneDefinition {
  return testZone({
    layoutMode: 'authored',
    authored: { startRoomId: rooms[0]?.id ?? null, rooms },
    ...patch,
  } as never);
}

const fight = (id: string, next: string[], over: Record<string, unknown> = {}): RoomInput => ({
  id,
  type: 'combat',
  enemyKey: 'grunt',
  next,
  ...over,
});
const boss = (id = 'boss'): RoomInput => ({ id, type: 'boss', enemyKey: 'overlord' });

/** start → fight → rest → boss. */
const linear = () => [fight('start', ['second']), fight('second', ['camp']), { id: 'camp', type: 'rest', next: ['boss'] }, boss()];

/** start → camp → (elite | cache) → landing → boss: a fork that rejoins. */
const forked = () => [
  fight('start', ['camp']),
  { id: 'camp', name: 'Repair Bay', type: 'rest', extraction: true, next: ['elite', 'cache'] },
  { id: 'elite', type: 'elite', enemyKey: 'sentinel', next: ['landing'] },
  { id: 'cache', name: 'Salvage Cache', type: 'reward', next: ['landing'], reward: { rewardTable: 'loot', currency: { min: 3, max: 5 } } },
  { id: 'landing', type: 'rest', healBasisPoints: 2000, next: ['boss'] },
  boss(),
];

const messages = (zone: DungeonZoneDefinition) => validateAuthoredLayout(zone).map((i) => i.message);
const nodeOfRoom = (graph: DungeonGraph, roomId: string) => graph.nodes.find((n) => n.roomId === roomId)!;
const leadsTo = (graph: DungeonGraph, roomId: string) =>
  nodeOfRoom(graph, roomId).outgoing.map((id) => graph.nodes.find((n) => n.id === graph.edges.find((e) => e.id === id)!.to)!.roomId);

describe('layout mode', () => {
  it('defaults a zone stored before the field existed to procedural, with no rooms', () => {
    const zone = testZone();
    expect(zone.layoutMode).toBe('procedural');
    expect(zone.authored).toEqual({ startRoomId: null, rooms: [] });
    expect(zone.generation.firstNodeType).toBeNull();
  });

  it('does not change the hash of a procedural zone that uses none of the new fields', () => {
    // Pinned before layout modes existed: a deploy must not make Scrapheap look edited.
    const scrapheap = loadShippedDungeonZones(CONTENT_DIR).find((z) => z.key === 'scrapheap_gauntlet')!;
    expect(scrapheap.definition.layoutMode).toBe('procedural');
    expect(scrapheap.hash).toBe('4459a3863a297359b7e8979655686019cc414dbfa33af50948e173e2b279536c');
    // …and the new fields do count once they are used.
    expect(dungeonZoneHash({ ...scrapheap.definition, layoutMode: 'authored' })).not.toBe(scrapheap.hash);
    expect(
      dungeonZoneHash({ ...scrapheap.definition, generation: { ...scrapheap.definition.generation, firstNodeType: 'combat' } }),
    ).not.toBe(scrapheap.hash);
  });

  it('lets an authored zone leave the generator blocks out entirely', () => {
    const { generation: _g, pools: _p, ...doc } = testZoneDoc();
    const zone = DungeonZoneDefinitionSchema.parse({ ...doc, layoutMode: 'authored', authored: { startRoomId: 'a', rooms: [boss('a')] } });
    expect(zone.pools.combat).toEqual([]);
    expect(compileAuthoredDungeon(zone, 1).nodes).toHaveLength(1);
  });

  it('refuses two rooms with the same id', () => {
    const parsed = DungeonZoneDefinitionSchema.safeParse(
      testZoneDoc({ layoutMode: 'authored', authored: { startRoomId: 'a', rooms: [fight('a', ['a2']), boss('a')] } } as never),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('compiling a layout', () => {
  it('turns a linear layout into one node per room, in order, ending on the boss', () => {
    const graph = compileAuthoredDungeon(authored(linear()), 7);
    expect(graph.nodes.map((n) => [n.id, n.roomId, n.depth, n.type])).toEqual([
      ['n1', 'start', 1, 'combat'],
      ['n2', 'second', 2, 'combat'],
      ['n3', 'camp', 3, 'rest'],
      ['n4', 'boss', 4, 'boss'],
    ]);
    expect(graph).toMatchObject({ seed: 7, depthCount: 4, startNodeId: 'n1', terminalNodeId: 'n4', attempts: 1 });
    expect(graph.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['n1>n2', 'n2>n3', 'n3>n4']);
    expect(graph.nodes.map((n) => n.terminal)).toEqual([false, false, false, true]);
    expect(graph.nodes[3]).toMatchObject({ boss: true, extraction: false, content: { kind: 'enemy', key: 'overlord' }, source: null });
  });

  it('compiles a branch: one room leading to two, each its own node at the same depth', () => {
    const graph = compileAuthoredDungeon(authored(forked()), 1);
    expect(leadsTo(graph, 'camp')).toEqual(['elite', 'cache']);
    expect(nodeOfRoom(graph, 'elite')).toMatchObject({ depth: 3, lane: 0 });
    expect(nodeOfRoom(graph, 'cache')).toMatchObject({ depth: 3, lane: 1 });
  });

  it('compiles a rejoin: both sides of the fork lead to the same node', () => {
    const graph = compileAuthoredDungeon(authored(forked()), 1);
    expect(leadsTo(graph, 'elite')).toEqual(['landing']);
    expect(leadsTo(graph, 'cache')).toEqual(['landing']);
    expect(graph.nodes).toHaveLength(6);
    expect(graph.depthCount).toBe(5);
  });

  it('puts a room at the depth of the longest route to it, so depth only increases along any route', () => {
    // The long side has two rooms, the short side one; they rejoin.
    const zone = authored([
      fight('start', ['long_a', 'short']),
      fight('long_a', ['long_b']),
      fight('long_b', ['boss']),
      fight('short', ['boss']),
      boss(),
    ]);
    const graph = compileAuthoredDungeon(zone, 1);
    expect(nodeOfRoom(graph, 'boss').depth).toBe(4);
    for (const edge of graph.edges) {
      const depth = (id: string) => graph.nodes.find((n) => n.id === id)!.depth;
      expect(depth(edge.to)).toBeGreaterThan(depth(edge.from));
    }
    expect(zoneRunLength(zone)).toEqual({ min: 3, max: 4 });
  });

  it('starts on the start room, wherever the author listed it', () => {
    const rooms = [boss(), { id: 'camp', type: 'rest', next: ['boss'] }, fight('entry', ['camp'])];
    const zone = authored(rooms, { authored: { startRoomId: 'entry', rooms } });
    const graph = compileAuthoredDungeon(zone, 1);
    expect(graph.nodes.find((n) => n.id === graph.startNodeId)!.roomId).toBe('entry');
    expect(graph.nodes.map((n) => n.roomId)).toEqual(['entry', 'camp', 'boss']);
  });

  it('carries extraction: where the author allowed it, on every interior Exit, and never on the final room', () => {
    const zone = authored([
      fight('start', ['camp'], { extraction: true }),
      { id: 'camp', type: 'rest', next: ['hatch'] },
      { id: 'hatch', type: 'exit', next: ['way_out'] },
      { id: 'way_out', type: 'exit' },
    ]);
    const graph = compileAuthoredDungeon(zone, 1);
    expect(graph.nodes.map((n) => [n.roomId, n.extraction])).toEqual([
      ['start', true],
      ['camp', false],
      ['hatch', true],
      ['way_out', false],
    ]);
    expect(nodeOfRoom(graph, 'way_out')).toMatchObject({ terminal: true, boss: false });
    expect(zoneEndsOnBoss(zone)).toBe(false);
  });

  it('gives a rest its own heal when the room sets one, and the zone’s otherwise', () => {
    const graph = compileAuthoredDungeon(authored(forked()), 1);
    expect(nodeOfRoom(graph, 'landing').restHealBasisPoints).toBe(2000);
    expect(nodeOfRoom(graph, 'camp').restHealBasisPoints).toBeUndefined();
  });

  it('pays a room its own reward when it has one, and the zone’s reward band otherwise', () => {
    const graph = compileAuthoredDungeon(authored(forked()), 1);
    expect(nodeOfRoom(graph, 'cache')).toMatchObject({
      rewardBandId: null,
      reward: { rewardTable: 'loot', equipmentRewardTable: null, currency: { min: 3, max: 5 } },
    });
    // No room reward: the same band a generated node of that type and depth would get.
    expect(nodeOfRoom(graph, 'start')).toMatchObject({ rewardBandId: 'early' });
    expect(nodeOfRoom(graph, 'start').reward).toBeUndefined();
    expect(nodeOfRoom(graph, 'boss').rewardBandId).toBe('boss');
  });

  it('names rooms on their nodes, and places content the author chose rather than a pool entry', () => {
    const graph = compileAuthoredDungeon(authored(forked()), 1);
    expect(nodeOfRoom(graph, 'camp').name).toBe('Repair Bay');
    expect(nodeOfRoom(graph, 'elite').name).toBeUndefined();
    expect(nodeOfRoom(graph, 'elite')).toMatchObject({ content: { kind: 'enemy', key: 'sentinel' }, source: null });
    const event = compileAuthoredDungeon(authored([{ id: 'a', type: 'event', eventKey: 'shrine', next: ['boss'] }, boss()]), 1);
    expect(event.nodes[0]!.content).toEqual({ kind: 'event', key: 'shrine' });
  });

  it('is the same graph for every seed — only the recorded seed differs', () => {
    const zone = authored(forked());
    const { seed: _a, ...one } = compileAuthoredDungeon(zone, 1);
    const { seed: _b, ...other } = compileAuthoredDungeon(zone, 987_654);
    expect(other).toEqual(one);
  });

  it('refuses to compile an illegal layout, saying why', () => {
    const zone = authored([fight('start', ['gone'])]);
    expect(() => compileAuthoredDungeon(zone, 1)).toThrow(AuthoredLayoutError);
    try {
      compileAuthoredDungeon(zone, 1);
    } catch (err) {
      expect((err as AuthoredLayoutError).issues[0]!.message).toMatch(/points to a room that no longer exists/);
    }
  });
});

describe('one graph builder for both modes', () => {
  it('generates for a procedural zone and compiles for an authored one', () => {
    const procedural = testZone();
    expect(buildDungeonGraph(procedural, testCatalogue(), 42)).toEqual(generateDungeon(procedural, testCatalogue(), 42));
    const zone = authored(linear());
    expect(buildDungeonGraph(zone, testCatalogue(), 42)).toEqual(compileAuthoredDungeon(zone, 42));
  });

  it('produces the same node shape either way', () => {
    const generated = generateDungeon(testZone(), testCatalogue(), 3).nodes[0]!;
    const compiled = compileAuthoredDungeon(authored(linear()), 3).nodes[0]!;
    for (const field of Object.keys(generated)) expect(compiled).toHaveProperty(field);
  });
});

describe('layout rules, in the author’s words', () => {
  it('accepts a legal layout', () => {
    expect(messages(authored(forked()))).toEqual([]);
  });

  it('needs at least one room and a start room', () => {
    expect(messages(authored([]))).toEqual(['This dungeon has no rooms yet — add a room to start building it.']);
    const rooms = linear();
    expect(messages(authored(rooms, { authored: { startRoomId: null, rooms } }))).toContain('Choose the room a run starts in.');
    expect(messages(authored(rooms, { authored: { startRoomId: 'deleted', rooms } }))[0]).toMatch(/start room no longer exists/);
  });

  it('names the room whose link points at a room that is gone', () => {
    const zone = authored([fight('start', ['camp']), { id: 'camp', name: 'Repair Bay', type: 'rest', next: ['deleted_room'] }]);
    expect(messages(zone)).toContain('Room "Repair Bay" points to a room that no longer exists.');
    expect(validateAuthoredLayout(zone).find((i) => /Repair Bay/.test(i.message))!.path).toBe('authored.rooms[1].next');
  });

  it('finds a room nothing leads to', () => {
    const zone = authored([...linear(), { id: 'orphan', name: 'Side Vault', type: 'reward', next: ['boss'] }]);
    expect(messages(zone)).toEqual(['Room "Side Vault" cannot be reached from the start — link another room to it, or delete it.']);
    expect(analyseAuthoredLayout(zone).reachable.map((r) => r.id)).not.toContain('orphan');
  });

  it('rejects a loop, and a room that leads to itself', () => {
    const loop = authored([fight('start', ['a']), fight('a', ['b'], { name: 'Hall' }), fight('b', ['a', 'boss'], { name: 'Stair' }), boss()]);
    const found = messages(loop).find((m) => /form a loop/.test(m))!;
    expect(found).toMatch(/"Hall" → "Stair" → "Hall"/);
    expect(found).toMatch(/must always move forward/);
    expect(() => compileAuthoredDungeon(loop, 1)).toThrow(AuthoredLayoutError);

    const self = authored([fight('start', ['start', 'boss'], { name: 'Mirror' }), boss()]);
    expect(messages(self)).toContain('Room "Mirror" leads back to itself.');
  });

  it('wants exactly one final room, and it must be a Boss or an Exit', () => {
    const two = authored([fight('start', ['a', 'b']), boss('a'), { id: 'b', name: 'Back Door', type: 'exit' }]);
    expect(messages(two).some((m) => /all end the dungeon — only one final room/.test(m))).toBe(true);

    const deadEnd = authored([fight('start', ['camp']), { id: 'camp', name: 'Camp', type: 'rest' }]);
    expect(messages(deadEnd)).toEqual([
      'Room "Camp" leads nowhere. A dungeon ends on a Boss or an Exit — add a next room, or change its type.',
    ]);
  });

  it('keeps a Boss as the final room only', () => {
    const zone = authored([fight('start', ['boss']), { ...boss(), name: 'Warden', next: ['after'] }, { id: 'after', type: 'exit' }]);
    expect(messages(zone)).toContain('Boss room "Warden" must be the final room — a Boss cannot lead anywhere.');
    expect(zoneEndsOnBoss(authored(linear()))).toBe(true);
  });

  it('wants an enemy in every fight and an event in every event room', () => {
    const zone = authored([
      { id: 'start', name: 'Gate', type: 'combat', next: ['oddity'] },
      { id: 'oddity', name: 'Oddity', type: 'event', next: ['boss'] },
      boss(),
    ]);
    expect(messages(zone)).toEqual([
      'Room "Gate" is a fight with no enemy — choose one.',
      'Room "Oddity" is an event room with no event — choose one.',
    ]);
  });

  it('does not let the final room offer extraction', () => {
    const zone = authored([fight('start', ['boss']), { ...boss(), name: 'Core', extraction: true }]);
    expect(messages(zone)[0]).toMatch(/final room "Core" cannot offer extraction/);
  });
});

describe('zone validation of an authored zone', () => {
  const validate = (zone: DungeonZoneDefinition) => validateDungeonZone(zone, testValidationContext()).issues;

  it('passes a legal layout without consulting the generator rules or pools', () => {
    // Pools that could never generate a run are irrelevant to an authored zone.
    expect(validate(authored(forked(), { pools: { combat: [], elite: [], miniboss: [], boss: [], event: [] } }))).toEqual([]);
  });

  it('makes a broken layout an error on an enabled zone and a warning on a disabled one', () => {
    const broken = [fight('start', ['camp']), { id: 'camp', type: 'rest' }];
    const live = validate(authored(broken));
    expect(hasErrors(live)).toBe(true);
    const draft = validate(authored(broken, { enabled: false }));
    expect(draft.map((i) => i.severity)).toEqual(['warning']);
    expect(draft[0]!.message).toBe(live[0]!.message);
  });

  it('checks what each room names: enemies, events and reward tables', () => {
    const issues = validate(
      authored([
        fight('start', ['odd'], { name: 'Gate', enemyKey: 'nobody' }),
        { id: 'odd', name: 'Oddity', type: 'event', eventKey: 'nothing', next: ['vault'] },
        { id: 'vault', name: 'Vault', type: 'reward', next: ['boss'], reward: { rewardTable: 'missing', equipmentRewardTable: 'closed' } },
        boss(),
      ]),
    );
    expect(issues.map((i) => [i.path, i.severity, i.message])).toEqual([
      ['authored.rooms[0].enemyKey', 'error', 'Room "Gate" uses an enemy that no longer exists — choose another.'],
      ['authored.rooms[1].eventKey', 'error', 'Room "Oddity" uses an event that no longer exists — choose another.'],
      ['authored.rooms[2].reward.rewardTable', 'error', 'Room "Vault" pays from reward table "missing", which does not exist.'],
      ['authored.rooms[2].reward.equipmentRewardTable', 'warning', 'Room "Vault" pays from reward table "closed", which is disabled — it pays nothing.'],
    ]);
  });

  it('refuses a disabled enemy on an enabled zone — an authored room cannot draw another', () => {
    const ctx = testValidationContext(testCatalogue({ disabledEnemies: ['grunt'] }));
    const issues = validateDungeonZone(authored(linear()), ctx).issues;
    expect(issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([
      'Room "Combat (start)" uses grunt, which is disabled — choose another enemy.',
      'Room "Combat (second)" uses grunt, which is disabled — choose another enemy.',
    ]);
  });

  it('warns about a Reward room that would pay nothing', () => {
    const zone = authored(
      [fight('start', ['vault']), { id: 'vault', name: 'Empty Vault', type: 'reward', next: ['boss'] }, boss()],
      { rewards: { defeatCurrencyRetentionBasisPoints: 2500, bands: [{ id: 'boss', nodeTypes: ['boss'], currency: { min: 1, max: 1 } }] } },
    );
    expect(validate(zone)).toEqual([
      expect.objectContaining({ path: 'authored.rooms[1].reward', severity: 'warning', message: expect.stringMatching(/"Empty Vault" is a Reward room that pays nothing/) }),
    ]);
  });

  it('checks room artwork against the asset library', () => {
    const zone = authored([
      fight('start', ['boss'], { name: 'Gate', backgroundAssetId: ASSET_A, scene: { spriteAssetId: ASSET_B } }),
      boss(),
    ]);
    const issues = validateDungeonZone(zone, {
      ...testValidationContext(),
      assets: new Map([[ASSET_B, { name: 'Old sprite', status: 'disabled' as const }]]),
    }).issues;
    expect(issues.map((i) => [i.path, i.severity])).toEqual([
      ['authored.rooms[0].backgroundAssetId', 'error'],
      ['authored.rooms[0].scene.spriteAssetId', 'warning'],
    ]);
    expect(issues[0]!.message).toBe('Room "Gate": its background no longer exists — choose another or clear it.');
  });

  it('describes a shape error by the room it is in, never a document path', () => {
    const { issues } = validateDungeonZone(
      testZoneDoc({ layoutMode: 'authored', authored: { startRoomId: 'a', rooms: [{ id: 'a', name: 'Repair Bay', type: 'rest', healBasisPoints: 20_000 }] } } as never),
      testValidationContext(),
    );
    expect(issues[0]).toMatchObject({ path: 'authored.rooms[0].healBasisPoints', severity: 'error' });
    expect(issues[0]!.message).toMatch(/^Room "Repair Bay": /);
  });

  it('labels a procedural shape error with the field the editor shows', () => {
    const { issues } = validateDungeonZone(testZoneDoc({ generation: { minNodes: 1 } } as never), testValidationContext());
    expect(issues[0]!.message).toMatch(/^Shortest run: /);
  });
});

describe('scenes of an authored run', () => {
  const zoneArt = { backgroundArtworkPath: 'dungeons/backgrounds/default.webp' };

  it('uses a room’s own background, else the zone default, recorded per node', () => {
    const zone = authored(
      [fight('start', ['camp'], { backgroundAssetId: ASSET_A }), { id: 'camp', type: 'rest', next: ['boss'], backgroundArtworkPath: 'dungeons/backgrounds/camp.webp' }, boss()],
      zoneArt,
    );
    const scenes = selectRunScenes(zone, compileAuthoredDungeon(zone, 1), 1);
    expect(scenes.nodes).toEqual({
      n1: { background: { entryId: 'room:start', assetId: ASSET_A, artworkPath: null } },
      n2: { background: { entryId: 'room:camp', assetId: null, artworkPath: 'dungeons/backgrounds/camp.webp' } },
      n3: { background: { entryId: 'zone_default', assetId: null, artworkPath: 'dungeons/backgrounds/default.webp' } },
    });
  });

  it('leaves a node without a background when neither the room nor the zone has one', () => {
    const zone = authored(linear());
    const scenes = selectRunScenes(zone, compileAuthoredDungeon(zone, 1), 1);
    expect(Object.values(scenes.nodes).every((n) => n.background === null)).toBe(true);
  });

  it('carries a room’s enemy art override only where the room set one', () => {
    const placement = { anchor: 'center' as const, scaleBasisPoints: 5000, offsetX: 0, offsetY: 0 };
    const zone = authored([
      fight('start', ['second'], { scene: { spriteAssetId: ASSET_A, spritePlacement: placement } }),
      fight('second', ['boss'], { scene: { spriteAssetId: null, artworkAssetId: null, spritePlacement: null } }),
      boss(),
    ]);
    const scenes = selectRunScenes(zone, compileAuthoredDungeon(zone, 1), 1);
    expect(scenes.nodes.n1!.enemy).toEqual({ spriteAssetId: ASSET_A, artworkAssetId: null, spritePlacement: placement });
    expect(scenes.nodes.n2!.enemy).toBeUndefined();
    expect(scenes.nodes.n3!.enemy).toBeUndefined();
  });

  it('still draws a procedural zone’s backgrounds from its pool', () => {
    const zone = testZone({ backgrounds: [{ id: 'bg', weight: 1, artworkPath: 'dungeons/backgrounds/a.webp' }] } as never);
    const graph = generateDungeon(zone, testCatalogue(), 5);
    expect(selectRunScenes(zone, graph, 5)).toEqual(selectDungeonScenes(zone, graph, 5));
  });
});

describe('a fixed first room on a procedural zone', () => {
  it('starts every run on the chosen type without changing what the seed draws elsewhere', () => {
    const anchored = testZone({ generation: { firstNodeType: 'event' } } as never);
    for (let seed = 1; seed <= 60; seed++) {
      const graph = generateDungeon(anchored, testCatalogue(), seed);
      expect(graph.nodes[0]!.type).toBe('event');
    }
  });

  it('leaves a zone without one generating exactly as before', () => {
    const plain = testZone();
    const explicit = testZone({ generation: { firstNodeType: null } } as never);
    for (let seed = 1; seed <= 20; seed++) {
      expect(generateDungeon(explicit, testCatalogue(), seed)).toEqual(generateDungeon(plain, testCatalogue(), seed));
    }
  });

  it('is refused, in plain words, when that type cannot stand first', () => {
    // The test zone's elites start at depth 2.
    const { issues } = validateDungeonZone(testZoneDoc({ generation: { firstNodeType: 'elite' } } as never), testValidationContext());
    const issue = issues.find((i) => i.path === 'generation.firstNodeType')!;
    expect(issue.severity).toBe('error');
    expect(issue.message).toMatch(/Every run is set to start with a elite room, but a elite cannot be placed first/);
  });
});
