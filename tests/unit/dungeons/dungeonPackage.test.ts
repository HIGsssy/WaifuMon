/**
 * The Dungeon Content Package: build, serialise, read back, verify — and the
 * shipped example, which must stay a valid package the sandbox can finish.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoPlayDungeonSandbox, createDungeonSandbox } from '../../../src/modules/dungeons/engine/sandbox';
import {
  DUNGEON_PACKAGE_FORMAT,
  buildDungeonPackage,
  dungeonContentHash,
  dungeonPackageFilename,
  packagedEnemyHash,
  readDungeonPackage,
  serializeDungeonPackage,
  type DungeonPackage,
} from '../../../src/modules/dungeons/package/dungeonPackage';
import { combatEnemyHash } from '../../../src/modules/enemies/enemyStore';
import { TEST_ENEMIES, testDungeon } from '../../helpers/dungeonFixtures';

const ENEMIES = new Map(TEST_ENEMIES.map((e) => [e.key, e]));
const SOURCE = { environment: 'staging', origin: 'draft' as const, draftRevision: 4, publishedRevision: 2 };
const LAYOUT = { viewport: { x: 10, y: 20, zoom: 0.5 }, rooms: { gate: { x: 0, y: 0 }, den: { x: 900, y: 40 }, gone: { x: 1, y: 1 } }, notes: [] };

function build(over: Partial<Parameters<typeof buildDungeonPackage>[0]> = {}): DungeonPackage {
  return buildDungeonPackage({ definition: testDungeon(), layout: LAYOUT, enemies: ENEMIES, source: SOURCE, ...over });
}
const reread = (pkg: unknown) => readDungeonPackage(JSON.parse(JSON.stringify(pkg)));

describe('building a package', () => {
  it('carries the envelope, the definition, the layout and a computed manifest', () => {
    const pkg = build();
    expect(pkg).toMatchObject({
      format: DUNGEON_PACKAGE_FORMAT,
      schemaVersion: 1,
      source: { environment: 'staging', dungeonKey: 'test_tunnels', origin: 'draft', draftRevision: 4, publishedRevision: 2 },
      contentHash: dungeonContentHash(testDungeon()),
      dependencies: {
        enemies: ['grunt', 'overlord', 'sentinel', 'warden'].map((key) => ({ key, contentHash: packagedEnemyHash(ENEMIES.get(key)!) })),
        rewardTables: [],
        regions: ['waifu-valley'],
        currencies: ['ascension_currency'],
        species: [],
        items: [],
        equipment: [],
      },
    });
    expect(pkg.packageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pkg.bundled.enemies.map((e) => e.key)).toEqual(['grunt', 'overlord', 'sentinel', 'warden']);
    // A position for a room that no longer exists is not carried along.
    expect(Object.keys(pkg.editor.layout.rooms)).toEqual(['gate', 'den']);
  });

  it('hashes enemies exactly as the Enemy Catalogue does, so an importer can compare them', () => {
    for (const enemy of TEST_ENEMIES) expect(packagedEnemyHash(enemy)).toBe(combatEnemyHash(enemy));
  });

  it('names reward tables and artwork by stable identifiers, never by database id', () => {
    const definition = testDungeon(undefined, (d) => {
      d.artwork = { kind: 'shipped', path: 'dungeons/zones/test.webp' };
      d.rooms[0]!.background = { kind: 'managed', category: 'dungeon_background', contentHash: 'b'.repeat(64), name: 'gate.webp' };
      d.rooms[0]!.actions![1] = { id: 'pay', type: 'reward', reward: { rewardTable: 'loot-v1', equipmentRewardTable: 'gear-v1' } };
    });
    const pkg = build({ definition });
    expect(pkg.dependencies.rewardTables).toEqual([{ kind: 'expedition', id: 'gear-v1' }, { kind: 'expedition', id: 'loot-v1' }]);
    expect(pkg.assets).toEqual([
      { kind: 'managed', category: 'dungeon_background', contentHash: 'b'.repeat(64), name: 'gate.webp' },
      { kind: 'shipped', path: 'dungeons/zones/test.webp' },
    ]);
    expect(JSON.stringify(pkg)).not.toMatch(/"(assetId|revisionId|id)":\s*\d/);
  });

  it('lists an enemy the environment lacks as a dependency with no hash, and does not bundle it', () => {
    const pkg = build({ enemies: new Map([...ENEMIES].filter(([key]) => key !== 'warden')) });
    expect(pkg.dependencies.enemies.find((e) => e.key === 'warden')).toEqual({ key: 'warden', contentHash: null });
    expect(pkg.bundled.enemies.map((e) => e.key)).not.toContain('warden');
    expect(reread(pkg).ok).toBe(true);
  });
});

describe('content hash', () => {
  it('is independent of layout, export time, package id and key order', () => {
    const a = build({ layout: LAYOUT });
    const b = build({ layout: { rooms: { gate: { x: 999, y: 999 } }, notes: [{ id: 'n', x: 0, y: 0, text: 'moved everything' }] }, exportedAt: new Date('2031-01-01T00:00:00Z') });
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.packageId).not.toBe(a.packageId);

    const shuffled = JSON.parse(JSON.stringify(testDungeon())) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(shuffled).reverse());
    expect(dungeonContentHash(reordered as never)).toBe(a.contentHash);
  });

  it('changes with any gameplay change, including the order of actions', () => {
    const base = dungeonContentHash(testDungeon());
    expect(dungeonContentHash(testDungeon(undefined, (d) => void (d.rooms[1]!.actions![1] = { id: 'breather', type: 'rest', optional: true, healBasisPoints: 2600 })))).not.toBe(base);
    expect(dungeonContentHash(testDungeon(undefined, (d) => void d.rooms[1]!.actions!.reverse()))).not.toBe(base);
    expect(dungeonContentHash(testDungeon(undefined, (d) => void (d.connections![0]!.label = 'renamed')))).not.toBe(base);
  });

  it('treats a spelled-out default the same as an omitted one', () => {
    const explicit = testDungeon(undefined, (d) => {
      d.rooms[0]!.kind = 'room';
      d.rooms[0]!.extraction = false;
      d.connections![0]!.kind = 'path';
    });
    expect(dungeonContentHash(explicit)).toBe(dungeonContentHash(testDungeon()));
  });
});

describe('round trips', () => {
  it('serialises and reads back to the same package', () => {
    const pkg = build();
    const text = serializeDungeonPackage(pkg);
    const read = readDungeonPackage(text);
    expect(read).toMatchObject({ ok: true, issues: [] });
    expect(read.package).toEqual(pkg);
    // And again: the text is stable.
    expect(serializeDungeonPackage(read.package!)).toBe(text);
  });

  it('re-exporting what was read gives the same content hash and manifest', () => {
    const first = build();
    const read = readDungeonPackage(serializeDungeonPackage(first)).package!;
    const second = buildDungeonPackage({
      definition: read.dungeon,
      layout: read.editor.layout,
      enemies: new Map(read.bundled.enemies.map((e) => [e.key, e])),
      source: { environment: 'production', origin: 'draft', draftRevision: 1, publishedRevision: null },
    });
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.dependencies).toEqual(first.dependencies);
    expect(second.dungeon).toEqual(first.dungeon);
    expect(second.editor).toEqual(first.editor);
  });

  it('names the file after the dungeon and its content', () => {
    const pkg = build();
    expect(dungeonPackageFilename(pkg)).toBe(`test_tunnels.${pkg.contentHash.slice(7, 19)}.dungeon.json`);
  });
});

describe('reading a package', () => {
  const codes = (raw: unknown) => reread(raw).issues.map((i) => i.code);

  function newlineDependencies(member: 'enemies' | 'rewardTables' | 'regions') {
    const definition = build().dungeon;
    for (const room of definition.rooms) room.actions = [];
    if (member === 'enemies') definition.rooms[0]!.actions = [{
      id: 'fight', type: 'combat', waves: [{ enemy: { key: 'a\nb' } }, { enemy: { key: 'c' } }],
    } as never];
    else if (member === 'rewardTables') definition.rooms[0]!.actions = [{
      id: 'reward', type: 'reward', reward: { rewardTable: 'a\nb', equipmentRewardTable: 'c' },
    } as never];
    else definition.availableRegions = ['a\nb', 'c'];
    return build({ definition, enemies: new Map() });
  }

  it.each(['enemies', 'rewardTables', 'regions'] as const)('rejects newline delimiter collisions in %s manifests', (member) => {
    const pkg = newlineDependencies(member);
    if (member === 'enemies') pkg.dependencies.enemies = ['a', 'b\nc'].map((key) => ({ key, contentHash: null }));
    else if (member === 'rewardTables') pkg.dependencies.rewardTables = ['a', 'b\nc'].map((id) => ({ kind: 'expedition', id }));
    else pkg.dependencies.regions = ['a', 'b\nc'];
    const result = reread(pkg);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'package_dependencies_mismatch', path: `dependencies.${member}` }));
  });

  it.each(['enemies', 'rewardTables', 'regions'] as const)('accepts correct newline-containing %s manifests and stable serialization', (member) => {
    const pkg = newlineDependencies(member);
    // Manifest membership is independent of order, including embedded delimiters.
    pkg.dependencies[member].reverse();
    const text = serializeDungeonPackage(pkg);
    const result = readDungeonPackage(text);
    expect(result.ok).toBe(true);
    expect(result.package).toEqual(pkg);
    expect(serializeDungeonPackage(result.package!)).toBe(text);
  });

  it('rejects a bundled enemy even when an invalid manifest falsely declares it referenced', () => {
    const pkg = newlineDependencies('enemies');
    pkg.dependencies.enemies = ['a', 'b\nc'].map((key) => ({ key, contentHash: null }));
    pkg.bundled.enemies = [{ ...TEST_ENEMIES[0]!, key: 'a' }];
    const result = reread(pkg);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'package_dependencies_mismatch', path: 'dependencies.enemies' }));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'package_bundle_unreferenced', path: 'bundled.enemies[0]' }));
  });

  it('refuses things that are not a dungeon package, by code', () => {
    expect(readDungeonPackage('{not json').issues[0]).toMatchObject({ code: 'package_not_json', severity: 'error' });
    expect(codes([])).toEqual(['package_format']);
    expect(codes({ ...build(), format: 'waifumon-world-encounters' })).toEqual(['package_format']);
  });

  it('refuses a schema version it does not know, saying which it supports', () => {
    const result = reread({ ...build(), schemaVersion: 2 });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'package_schema_version', message: expect.stringContaining('supported: 1') })]);
  });

  it('refuses a member it does not understand rather than importing half a dungeon', () => {
    const result = reread({ ...build(), events: [{ key: 'future' }] });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual(['package_schema']);
  });

  it('detects content edited after export', () => {
    const pkg = build();
    const tampered = JSON.parse(JSON.stringify(pkg)) as DungeonPackage;
    tampered.dungeon.rooms[4]!.actions[1] = { ...tampered.dungeon.rooms[4]!.actions[1]!, reward: { rewardTable: null, equipmentRewardTable: null, currency: { min: 9000, max: 9000 } } } as never;
    expect(codes(tampered)).toEqual(['package_hash_mismatch']);
  });

  it('detects a manifest that understates what the dungeon needs', () => {
    const pkg = build();
    const lying = { ...pkg, dependencies: { ...pkg.dependencies, enemies: pkg.dependencies.enemies.slice(1), currencies: [] } };
    expect(codes(lying)).toEqual(expect.arrayContaining(['package_dependencies_mismatch']));
    expect(reread(lying).issues.filter((i) => i.code === 'package_dependencies_mismatch').map((i) => i.path)).toEqual(['dependencies.enemies', 'dependencies.currencies']);
  });

  it('detects bundled enemies that are unreferenced, duplicated or do not match their hash', () => {
    const pkg = build();
    const stray = { ...pkg, bundled: { enemies: [...pkg.bundled.enemies, ENEMIES.get('brute')!] } };
    expect(codes(stray)).toEqual(['package_bundle_unreferenced']);
    const doubled = { ...pkg, bundled: { enemies: [...pkg.bundled.enemies, pkg.bundled.enemies[0]!] } };
    expect(codes(doubled)).toEqual(['package_bundle_duplicate']);
    const swapped = { ...pkg, bundled: { enemies: pkg.bundled.enemies.map((e) => (e.key === 'grunt' ? { ...e, hp: 999_999 } : e)) } };
    expect(codes(swapped)).toEqual(['package_bundle_hash_mismatch']);
  });

  it('reports the dungeon’s own problems with their own codes and a package path', () => {
    const pkg = build();
    const broken = JSON.parse(JSON.stringify(pkg)) as DungeonPackage;
    broken.dungeon.entranceRoomId = 'nowhere';
    const result = reread(broken);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'entrance_missing', path: 'dungeon.entranceRoomId' }));
  });
});

describe('the shipped example', () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'content', 'dungeons', 'examples', 'service_tunnels.dungeon.json');
  const read = readDungeonPackage(fs.readFileSync(file, 'utf8'));

  it('is a valid package with no issues', () => {
    expect(read.issues).toEqual([]);
    expect(read.ok).toBe(true);
  });

  it('demonstrates rooms, branches, chained waves, a gate, an alternate route and an exit', () => {
    const dungeon = read.package!.dungeon;
    expect(dungeon.rooms.length).toBeGreaterThanOrEqual(5);
    expect(dungeon.connections.filter((c) => c.from === dungeon.entranceRoomId).length).toBeGreaterThanOrEqual(2);
    const actions = dungeon.rooms.flatMap((r) => r.actions);
    expect(actions.some((a) => (a.type === 'combat' || a.type === 'boss') && a.waves.length >= 2)).toBe(true);
    expect(actions.some((a) => a.type === 'gate')).toBe(true);
    expect(dungeon.connections.some((c) => c.requires)).toBe(true);
    expect(dungeon.rooms.some((r) => r.kind === 'exit')).toBe(true);
    // Two different ways into the bulkhead.
    expect(dungeon.connections.filter((c) => c.to === 'bulkhead').map((c) => c.from).sort()).toEqual(['locker_room', 'pump_room']);
  });

  it('can be finished in the sandbox along both routes, from its own bundled enemies', async () => {
    const pkg = read.package!;
    const dependencies = { enemies: Object.fromEntries(pkg.bundled.enemies.map((e) => [e.key, e])), rewardTables: {} };
    const fighter = { waifuId: 0, name: 'Sandbox Buddy', attack: 300, defense: 150, maxHp: 4000 };

    const main = createDungeonSandbox({ definition: pkg.dungeon, dependencies, fighter, seed: 3 });
    expect(await autoPlayDungeonSandbox(main)).toMatchObject({ stoppedBy: 'ended' });
    expect(main.state.status).toBe('completed');
    expect(main.state.rooms.locker_room).toBeUndefined();
    expect(main.state.rooms.bulkhead!.actions.vault).toBeUndefined();

    const side = createDungeonSandbox({ definition: pkg.dungeon, dependencies, fighter, seed: 3 });
    const route = await autoPlayDungeonSandbox(side, {
      choose: (view) =>
        view.phase !== 'connections'
          ? null
          : view.room.id === 'gate' && !side.state.rooms.locker_room
            ? { type: 'move', connectionId: 'c_side' }
            : view.room.id === 'locker_room'
              ? { type: 'move', connectionId: 'c_locker_bulk' }
              : null,
    });
    expect(route.stoppedBy).toBe('ended');
    expect(side.state.status).toBe('completed');
    // The keycard opened the vault, and the sealed bulkhead sent the run back for the valve.
    expect(side.state.rooms.bulkhead!.actions.vault).toMatchObject({ status: 'completed' });
    expect(side.state.rooms.pump_room).toMatchObject({ completed: true });
    expect(side.state.flags).toEqual({ found_keycard: true, valve_opened: true });
    expect(side.effects.map((e) => e.type)).toEqual(['settle_run']);
  });
});
