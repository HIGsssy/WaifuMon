/**
 * Procedural background selection: one background per node, by weight within
 * its depth range, decided by the run seed alone — and never touching the
 * graph's own random stream.
 */
import { describe, expect, it } from 'vitest';
import { generateDungeon } from '../../../src/modules/dungeons/dungeonGenerator';
import { sceneSeedOf, selectDungeonScenes } from '../../../src/modules/dungeons/dungeonScenes';
import { DungeonZoneDefinitionSchema } from '../../../src/modules/dungeons/zoneDefinition';
import { testCatalogue, testZone, testZoneDoc } from '../../helpers/dungeonFixtures';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const zoneWith = (backgrounds: unknown[]) => DungeonZoneDefinitionSchema.parse({ ...testZoneDoc(), backgrounds });
const POOL = [
  { id: 'cave', assetId: A, weight: 40, maxDepth: 4 },
  { id: 'deep', assetId: B, weight: 20, minDepth: 5 },
  { id: 'shipped', artworkPath: 'dungeons/backgrounds/scrap.webp', weight: 40, maxDepth: 4 },
];

describe('the background pool schema', () => {
  it('accepts a managed asset or a shipped path, with weight, enabled and a depth range', () => {
    const zone = zoneWith(POOL);
    expect(zone.backgrounds).toEqual([
      { id: 'cave', enabled: true, weight: 40, minDepth: 1, maxDepth: 4, assetId: A, artworkPath: null },
      { id: 'deep', enabled: true, weight: 20, minDepth: 5, maxDepth: null, assetId: B, artworkPath: null },
      { id: 'shipped', enabled: true, weight: 40, minDepth: 1, maxDepth: 4, assetId: null, artworkPath: 'dungeons/backgrounds/scrap.webp' },
    ]);
    // A zone with no pool is valid and unchanged in meaning.
    expect(testZone().backgrounds).toEqual([]);
    expect(testZone()).toMatchObject({ artworkAssetId: null, backgroundAssetId: null });
  });

  it('refuses a background naming no image, two images, a bad id, a duplicate or a bad range', () => {
    const bad = (backgrounds: unknown[]) => DungeonZoneDefinitionSchema.safeParse({ ...testZoneDoc(), backgrounds }).success;
    expect(bad([{ id: 'none', weight: 1 }])).toBe(false);
    expect(bad([{ id: 'both', weight: 1, assetId: A, artworkPath: 'dungeons/backgrounds/x.webp' }])).toBe(false);
    expect(bad([{ id: 'x', weight: 1, assetId: 'not-a-uuid' }])).toBe(false);
    expect(bad([{ id: 'x', weight: 1, assetId: '../../etc/passwd' }])).toBe(false);
    expect(bad([{ id: 'x', weight: 1, artworkPath: '../outside.webp' }])).toBe(false);
    expect(bad([{ id: 'x', weight: 1, artworkPath: 'assets/dungeons/x.webp' }])).toBe(false);
    expect(bad([{ id: 'dup', weight: 1, assetId: A }, { id: 'dup', weight: 1, assetId: B }])).toBe(false);
    expect(bad([{ id: 'x', weight: 1, assetId: A, minDepth: 5, maxDepth: 2 }])).toBe(false);
    expect(bad([{ id: 'x', weight: -1, assetId: A }])).toBe(false);
  });

  it('normalises an asset id to lower case, so references compare equal', () => {
    expect(zoneWith([{ id: 'x', weight: 1, assetId: A.toUpperCase().replace(/1/g, 'A') }]).backgrounds[0]!.assetId).toBe(
      A.replace(/1/g, 'a'),
    );
  });
});

describe('selection', () => {
  const zone = zoneWith(POOL);
  const graph = generateDungeon(zone, testCatalogue(), 42);

  it('gives every node a scene, and the same seed the same scenes', () => {
    const first = selectDungeonScenes(zone, graph, 42);
    expect(Object.keys(first.nodes).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
    expect(selectDungeonScenes(zone, graph, 42)).toEqual(first);
    // Regenerating the graph from the seed reproduces the whole thing.
    expect(selectDungeonScenes(zone, generateDungeon(zone, testCatalogue(), 42), 42)).toEqual(first);
    expect(first.version).toBe(1);
  });

  it('a different seed selects differently', () => {
    const picks = (seed: number) => {
      const g = generateDungeon(zone, testCatalogue(), seed);
      return g.nodes.map((n) => selectDungeonScenes(zone, g, seed).nodes[n.id]!.background?.entryId).join(',');
    };
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(picks)).size).toBeGreaterThan(1);
  });

  it('respects each background’s depth range', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const g = generateDungeon(zone, testCatalogue(), seed);
      const scenes = selectDungeonScenes(zone, g, seed);
      for (const node of g.nodes) {
        const bg = scenes.nodes[node.id]!.background;
        expect(bg, `seed ${seed} ${node.id}`).not.toBeNull();
        if (node.depth <= 4) expect(['cave', 'shipped']).toContain(bg!.entryId);
        else expect(bg!.entryId).toBe('deep');
      }
    }
  });

  it('follows the weights, skips disabled and zero-weight entries', () => {
    const weighted = zoneWith([
      { id: 'common', assetId: A, weight: 90 },
      { id: 'rare', assetId: B, weight: 10 },
      { id: 'off', artworkPath: 'dungeons/backgrounds/off.webp', weight: 1000, enabled: false },
      { id: 'zero', artworkPath: 'dungeons/backgrounds/zero.webp', weight: 0 },
    ]);
    const counts: Record<string, number> = {};
    for (let seed = 1; seed <= 300; seed++) {
      const g = generateDungeon(weighted, testCatalogue(), seed);
      for (const scene of Object.values(selectDungeonScenes(weighted, g, seed).nodes)) {
        counts[scene.background!.entryId] = (counts[scene.background!.entryId] ?? 0) + 1;
      }
    }
    expect(Object.keys(counts).sort()).toEqual(['common', 'rare']);
    const share = counts.rare! / (counts.rare! + counts.common!);
    expect(share).toBeGreaterThan(0.06);
    expect(share).toBeLessThan(0.14);
  });

  it('records the image the entry names — an asset id or a shipped path', () => {
    const scenes = selectDungeonScenes(zone, graph, 42);
    for (const scene of Object.values(scenes.nodes)) {
      const entry = zone.backgrounds.find((b) => b.id === scene.background!.entryId)!;
      expect(scene.background).toEqual({ entryId: entry.id, assetId: entry.assetId, artworkPath: entry.artworkPath });
    }
  });

  it('a node no background covers gets none; an empty pool gives none anywhere', () => {
    const shallowOnly = zoneWith([{ id: 'cave', assetId: A, weight: 1, maxDepth: 1 }]);
    const g = generateDungeon(shallowOnly, testCatalogue(), 9);
    const scenes = selectDungeonScenes(shallowOnly, g, 9);
    for (const node of g.nodes) {
      expect(scenes.nodes[node.id]!.background?.entryId ?? null).toBe(node.depth === 1 ? 'cave' : null);
    }
    const none = selectDungeonScenes(testZone(), graph, 42);
    expect(Object.values(none.nodes).every((s) => s.background === null)).toBe(true);
    // A zone snapshotted before the pool existed has no `backgrounds` at all.
    expect(Object.values(selectDungeonScenes({} as never, graph, 42).nodes).every((s) => s.background === null)).toBe(true);
  });

  it('does not disturb graph generation: the same seed builds the same graph with or without a pool', () => {
    for (const seed of [1, 7, 42, 1234]) {
      const plain = generateDungeon(testZone(), testCatalogue(), seed);
      const pooled = generateDungeon(zone, testCatalogue(), seed);
      expect(pooled.nodes).toEqual(plain.nodes);
      expect(pooled.edges).toEqual(plain.edges);
    }
    // And the scene stream is its own, not the graph's.
    expect(sceneSeedOf(42)).not.toBe(42);
    expect(sceneSeedOf(42)).toBe(sceneSeedOf(42));
    expect(sceneSeedOf(42)).not.toBe(sceneSeedOf(43));
  });

  it('narrowing one background’s depth range does not reshuffle the other nodes', () => {
    const before = zoneWith([{ id: 'a', assetId: A, weight: 1 }, { id: 'b', assetId: B, weight: 1 }]);
    const after = zoneWith([{ id: 'a', assetId: A, weight: 1 }, { id: 'b', assetId: B, weight: 1, minDepth: 2 }]);
    const g = generateDungeon(before, testCatalogue(), 77);
    const s1 = selectDungeonScenes(before, g, 77);
    const s2 = selectDungeonScenes(after, g, 77);
    for (const node of g.nodes) {
      if (node.depth >= 2) expect(s2.nodes[node.id]).toEqual(s1.nodes[node.id]);
    }
  });
});
