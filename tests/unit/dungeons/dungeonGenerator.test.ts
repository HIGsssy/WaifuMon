/**
 * The dungeon generator: determinism, structure, every authored constraint,
 * and clean failure when the rules cannot be met.
 *
 * `validateDungeonGraph` is the oracle for "is this graph legal"; the tests
 * that matter most also assert the rule directly, so the oracle is not the
 * only thing standing between a generator bug and a pass.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_GENERATION_ATTEMPTS,
  DUNGEON_GENERATOR_VERSION,
  MAX_DUNGEON_SEED,
  generateDungeon,
  validateDungeonGraph,
  type DungeonGraph,
} from '../../../src/modules/dungeons/dungeonGenerator';
import { simulateDungeonGeneration } from '../../../src/modules/dungeons/dungeonSimulation';
import { DungeonGenerationError } from '../../../src/shared/errors';
import { testCatalogue, testZone } from '../../helpers/dungeonFixtures';

const catalogue = testCatalogue();
const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);
const graphs = (zone = testZone(), cat = catalogue) => SEEDS.map((seed) => generateDungeon(zone, cat, seed));

const nodeOf = (graph: DungeonGraph, id: string) => graph.nodes.find((n) => n.id === id)!;
const successors = (graph: DungeonGraph, id: string) =>
  graph.edges.filter((e) => e.from === id).map((e) => nodeOf(graph, e.to));
const mainPath = (graph: DungeonGraph) =>
  graph.nodes.filter((n) => graph.nodes.filter((m) => m.depth === n.depth).length === 1);

describe('determinism', () => {
  it('produces the same graph for the same zone and seed', () => {
    for (const seed of [0, 1, 7, 12345, MAX_DUNGEON_SEED]) {
      expect(generateDungeon(testZone(), catalogue, seed)).toEqual(generateDungeon(testZone(), catalogue, seed));
    }
  });

  it('varies with the seed', () => {
    const shapes = new Set(graphs().map((g) => JSON.stringify(g.nodes.map((n) => [n.depth, n.type, n.content?.key]))));
    expect(shapes.size).toBeGreaterThan(100);
  });

  it('changes when the zone definition changes', () => {
    const a = generateDungeon(testZone(), catalogue, 42);
    const b = generateDungeon(testZone({ generation: { minNodes: 10, maxNodes: 10 } }), catalogue, 42);
    expect(b.nodes).toHaveLength(10);
    expect(b).not.toEqual(a);
  });

  it('never calls Math.random', () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error('Math.random was called');
    };
    try {
      expect(() => graphs()).not.toThrow();
    } finally {
      Math.random = original;
    }
  });

  it('rejects a seed outside the unsigned 32-bit range', () => {
    for (const seed of [-1, 1.5, MAX_DUNGEON_SEED + 1, Number.NaN]) {
      expect(() => generateDungeon(testZone(), catalogue, seed)).toThrow(RangeError);
    }
  });
});

describe('graph structure', () => {
  it('is plain serialisable data that survives a JSON round trip', () => {
    const graph = generateDungeon(testZone(), catalogue, 3);
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph);
    expect(graph.generatorVersion).toBe(DUNGEON_GENERATOR_VERSION);
    expect(validateDungeonGraph(testZone(), JSON.parse(JSON.stringify(graph)) as DungeonGraph)).toEqual([]);
  });

  it('keeps the node count inside minNodes..maxNodes, and reaches both ends', () => {
    const counts = graphs().map((g) => g.nodes.length);
    expect(Math.min(...counts)).toBe(6);
    expect(Math.max(...counts)).toBe(10);
  });

  it('gives every node its depth, a unique id, and edges that go exactly one depth deeper', () => {
    for (const graph of graphs()) {
      expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(graph.nodes.length);
      expect(nodeOf(graph, graph.startNodeId).depth).toBe(1);
      for (const edge of graph.edges) {
        expect(nodeOf(graph, edge.to).depth).toBe(nodeOf(graph, edge.from).depth + 1);
        expect(nodeOf(graph, edge.from).outgoing).toContain(edge.id);
      }
    }
  });

  it('is a DAG: no node can reach itself', () => {
    for (const graph of graphs()) {
      for (const start of graph.nodes) {
        const seen = new Set<string>();
        const stack = successors(graph, start.id).map((n) => n.id);
        while (stack.length > 0) {
          const id = stack.pop()!;
          expect(id).not.toBe(start.id);
          if (seen.has(id)) continue;
          seen.add(id);
          stack.push(...successors(graph, id).map((n) => n.id));
        }
      }
    }
  });

  it('branches sometimes, two ways at most, and always rejoins before the final node', () => {
    const all = graphs();
    const branched = all.filter((g) => g.nodes.some((n) => n.outgoing.length > 1));
    expect(branched.length).toBeGreaterThan(50);
    expect(branched.length).toBeLessThan(all.length);
    for (const graph of all) {
      for (const node of graph.nodes) expect(node.outgoing.length).toBeLessThanOrEqual(2);
      expect(graph.nodes.filter((n) => n.depth === 1)).toHaveLength(1);
      expect(graph.nodes.filter((n) => n.depth === graph.depthCount)).toHaveLength(1);
      expect(graph.nodes.filter((n) => n.outgoing.length > 1).length).toBeLessThanOrEqual(1);
    }
  });

  it('never branches when branching is off, and always does when a branch is required', () => {
    const off = testZone({ generation: { branching: { minBranches: 0, maxBranches: 0 } } });
    for (const graph of graphs(off)) expect(graph.nodes.length).toBe(graph.depthCount);
    const forced = testZone({ generation: { branching: { minBranches: 1, maxBranches: 1 } } });
    for (const graph of graphs(forced)) {
      expect(graph.nodes.filter((n) => n.outgoing.length === 2)).toHaveLength(1);
    }
  });
});

describe('constraints', () => {
  it('passes the independent validator for every seed', () => {
    const zone = testZone();
    for (const graph of graphs(zone)) expect(validateDungeonGraph(zone, graph)).toEqual([]);
  });

  it('places exactly one boss, as the terminal node at the final depth', () => {
    for (const graph of graphs()) {
      const bosses = graph.nodes.filter((n) => n.type === 'boss');
      expect(bosses).toHaveLength(1);
      expect(bosses[0]).toMatchObject({ terminal: true, boss: true, depth: graph.depthCount, outgoing: [] });
      expect(bosses[0]!.id).toBe(graph.terminalNodeId);
      expect(bosses[0]!.content).toEqual({ kind: 'enemy', key: 'overlord' });
    }
  });

  it('ends on an exit, with no boss, when no boss is required', () => {
    const zone = testZone({ generation: { boss: { required: false } } });
    for (const graph of graphs(zone)) {
      expect(graph.nodes.some((n) => n.type === 'boss')).toBe(false);
      expect(nodeOf(graph, graph.terminalNodeId).type).toBe('exit');
    }
  });

  it('guarantees the required nodes on the main path, where no route can skip them', () => {
    for (const graph of graphs()) {
      const types = mainPath(graph).map((n) => n.type);
      expect(types).toContain('rest');
      expect(types).toContain('reward');
    }
  });

  it('never opens on an elite, and keeps every type inside its depth range', () => {
    for (const graph of graphs()) {
      expect(nodeOf(graph, graph.startNodeId).type).not.toBe('elite');
      for (const node of graph.nodes) {
        if (node.type === 'elite') expect(node.depth).toBeGreaterThanOrEqual(2);
        if (node.type === 'miniboss') expect(node.depth).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('never places forbidden consecutive nodes along an edge', () => {
    for (const graph of graphs()) {
      for (const edge of graph.edges) {
        const [from, to] = [nodeOf(graph, edge.from), nodeOf(graph, edge.to)];
        if (from.type === 'rest') expect(to.type).not.toBe('rest');
        if (from.type === 'reward') expect(to.type).not.toBe('reward');
      }
    }
  });

  it('respects limits', () => {
    for (const graph of graphs()) {
      expect(graph.nodes.filter((n) => n.type === 'elite').length).toBeLessThanOrEqual(2);
      expect(graph.nodes.filter((n) => n.type === 'miniboss').length).toBeLessThanOrEqual(1);
    }
  });

  it('marks extraction only from the extraction depth, on the configured types, never on the final node', () => {
    for (const graph of graphs()) {
      for (const node of graph.nodes) {
        const expected = !node.terminal && node.depth >= 3 && (node.type === 'rest' || node.type === 'exit');
        expect(node.extraction).toBe(expected);
      }
      expect(mainPath(graph).filter((n) => n.extraction).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('places a guaranteed extraction point inside each required window, on the main path', () => {
    const zone = testZone({
      generation: { extraction: { windows: [{ minDepth: 3, maxDepth: 3, required: true }] } },
    });
    for (const graph of graphs(zone)) {
      const early = mainPath(graph).filter((n) => n.extraction && n.depth === 3);
      expect(early).toHaveLength(1);
      expect(validateDungeonGraph(zone, graph)).toEqual([]);
    }
    // Without the window the guaranteed point wanders deeper.
    expect(graphs().some((g) => !mainPath(g).some((n) => n.extraction && n.depth === 3))).toBe(true);
  });

  it('places an optional window when the run has room for it and skips it when it does not', () => {
    const zone = testZone({
      generation: {
        extraction: {
          windows: [
            { minDepth: 3, maxDepth: 3, required: true },
            { minDepth: 6, maxDepth: null, required: false },
          ],
        },
      },
    });
    const all = graphs(zone);
    const late = (g: DungeonGraph) => mainPath(g).filter((n) => n.extraction && n.depth >= 6);
    const withRoom = all.filter((g) => mainPath(g).some((n) => !n.terminal && n.depth >= 6));
    const without = all.filter((g) => !withRoom.includes(g));
    expect(withRoom.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    // Room for one is not a promise of one — the slot must also be legal for a
    // rest or an exit — but most long runs get it, and no short run fails for lacking it.
    expect(withRoom.filter((g) => late(g).length >= 1).length / withRoom.length).toBeGreaterThan(0.9);
    for (const g of without) expect(late(g)).toHaveLength(0);
    for (const g of all) {
      expect(mainPath(g).some((n) => n.extraction && n.depth === 3)).toBe(true);
      expect(validateDungeonGraph(zone, g)).toEqual([]);
    }
  });

  it('generates exactly what it did before windows existed when a zone declares none', () => {
    // A run snapshotted before windows has no `windows` key at all.
    const legacy = testZone();
    delete (legacy.generation.extraction as { windows?: unknown }).windows;
    for (const seed of [1, 2, 3, 99, 4242]) {
      expect(generateDungeon(legacy, catalogue, seed)).toEqual(generateDungeon(testZone(), catalogue, seed));
      expect(validateDungeonGraph(legacy, generateDungeon(legacy, catalogue, seed))).toEqual([]);
    }
  });

  it('never places an exit above the extraction depth', () => {
    const zone = testZone({ generation: { nodeWeights: { exit: 40 }, extraction: { minDepth: 4 } } });
    const all = graphs(zone);
    expect(all.some((g) => g.nodes.some((n) => n.type === 'exit'))).toBe(true);
    for (const graph of all) {
      for (const node of graph.nodes) if (node.type === 'exit') expect(node.depth).toBeGreaterThanOrEqual(4);
    }
  });

  it('never fights the same enemy more than the limit in a row', () => {
    const zone = testZone({ generation: { maxConsecutiveSameEnemy: 1, nodeWeights: { combat: 100 } } });
    for (const graph of graphs(zone)) {
      for (const edge of graph.edges) {
        const [from, to] = [nodeOf(graph, edge.from), nodeOf(graph, edge.to)];
        if (from.content?.kind === 'enemy' && to.content?.kind === 'enemy') {
          expect(to.content.key).not.toBe(from.content.key);
        }
      }
    }
  });
});

describe('pools and depth', () => {
  it('draws content only from the pool of the node type, inside the entry depth range', () => {
    for (const graph of graphs()) {
      for (const node of graph.nodes) {
        if (node.type === 'combat') {
          expect(['grunt', 'brute']).toContain(node.content!.key);
          if (node.content!.key === 'grunt') expect(node.depth).toBeLessThanOrEqual(4);
          if (node.content!.key === 'brute') expect(node.depth).toBeGreaterThanOrEqual(3);
          expect(node.source).toEqual({ pool: 'combat', entryId: node.content!.key });
        }
        if (node.type === 'elite') expect(node.content).toEqual({ kind: 'enemy', key: 'sentinel' });
        if (node.type === 'event') expect(node.content!.kind).toBe('event');
        if (node.type === 'event' && node.content!.key === 'trap') expect(node.depth).toBeGreaterThanOrEqual(2);
        if (node.type === 'rest' || node.type === 'reward') expect(node.content).toBeNull();
      }
    }
  });

  it('follows pool weights: the heavier entry appears more often where both are eligible', () => {
    const tally = { grunt: 0, brute: 0 };
    for (const graph of graphs()) {
      for (const node of graph.nodes) {
        if (node.type === 'combat' && (node.depth === 3 || node.depth === 4)) tally[node.content!.key as 'grunt']++;
      }
    }
    expect(tally.grunt).toBeGreaterThan(tally.brute);
    expect(tally.brute).toBeGreaterThan(0);
  });

  it('follows node weights: a zero-weight type never appears by chance, a heavy one dominates', () => {
    const report = simulateDungeonGeneration(testZone(), catalogue, { runs: 400 });
    expect(report.nodeTypeCounts.exit).toBe(0);
    expect(report.nodeTypeShare.combat).toBeGreaterThan(report.nodeTypeShare.elite);
    expect(report.nodeTypeShare.combat).toBeGreaterThan(report.nodeTypeShare.event);
  });

  it('skips disabled entries, zero weights and disabled content', () => {
    const zone = testZone({
      pools: {
        combat: [
          { id: 'grunt', enemyKey: 'grunt', weight: 60 },
          { id: 'off', enemyKey: 'brute', weight: 60, enabled: false },
          { id: 'zero', enemyKey: 'sentinel', weight: 0 },
          { id: 'gone', enemyKey: 'warden', weight: 60 },
        ],
      },
    });
    const cat = testCatalogue({ disabledEnemies: ['warden'] });
    for (const graph of graphs(zone, cat)) {
      for (const node of graph.nodes) if (node.type === 'combat') expect(node.content!.key).toBe('grunt');
    }
  });

  it('assigns each node the reward band for its depth, preferring a band that names its type', () => {
    for (const graph of graphs()) {
      for (const node of graph.nodes) {
        const expected = node.type === 'boss' ? 'boss' : node.depth <= 4 ? 'early' : 'deep';
        expect(node.rewardBandId).toBe(expected);
      }
    }
  });
});

describe('failure', () => {
  const failureOf = (run: () => unknown): DungeonGenerationError => {
    try {
      run();
    } catch (err) {
      if (err instanceof DungeonGenerationError) return err;
      throw err;
    }
    throw new Error('expected a DungeonGenerationError');
  };

  it('fails with a typed error when a required boss has no eligible pool entry', () => {
    const err = failureOf(() => generateDungeon(testZone({ pools: { boss: [] } }), catalogue, 1));
    expect(err.code).toBe('DUNGEON_GENERATION_FAILED');
    expect(err.diagnostics).toMatchObject({ zoneKey: 'test_zone', seed: 1, attempts: DEFAULT_MAX_GENERATION_ATTEMPTS });
    expect(err.diagnostics.lastFailure).toMatch(/no eligible boss/);
    expect(Object.values(err.diagnostics.failures).reduce((a, b) => a + b, 0)).toBe(DEFAULT_MAX_GENERATION_ATTEMPTS);
  });

  it('fails when the boss enemy is disabled in the catalogue', () => {
    const cat = testCatalogue({ disabledEnemies: ['overlord'] });
    expect(failureOf(() => generateDungeon(testZone(), cat, 1)).diagnostics.lastFailure).toMatch(/no eligible boss/);
  });

  it('fails cleanly on an impossible constraint instead of returning a partial dungeon', () => {
    // Three rests are required, but rests may not be adjacent and at most one may exist.
    const zone = testZone({
      generation: { required: [{ types: ['rest'], min: 3 }], limits: [{ types: ['rest'], max: 1 }] },
    });
    const err = failureOf(() => generateDungeon(zone, catalogue, 5));
    expect(err.diagnostics.lastFailure).toMatch(/required rest/);
  });

  it('fails when a required type has no eligible pool', () => {
    const zone = testZone({ generation: { required: [{ types: ['miniboss'], min: 1 }] }, pools: { miniboss: [] } });
    expect(failureOf(() => generateDungeon(zone, catalogue, 5)).diagnostics.lastFailure).toMatch(/required miniboss/);
  });

  it('fails when every weighted type is illegal somewhere', () => {
    // Only combat has a weight, and combat has nothing eligible past depth 1.
    const zone = testZone({
      generation: {
        nodeWeights: { combat: 10, elite: 0, event: 0, reward: 0, rest: 0, miniboss: 0, exit: 0 },
        required: [],
        extraction: { minDepth: 3, minPoints: 0 },
      },
      pools: { combat: [{ id: 'grunt', enemyKey: 'grunt', weight: 1, minDepth: 1, maxDepth: 1 }] },
    });
    expect(failureOf(() => generateDungeon(zone, catalogue, 5)).diagnostics.lastFailure).toMatch(/no legal node type/);
  });

  it('stops at the retry bound', () => {
    const zone = testZone({ pools: { boss: [] } });
    for (const maxAttempts of [1, 3, 17]) {
      expect(failureOf(() => generateDungeon(zone, catalogue, 9, { maxAttempts })).diagnostics.attempts).toBe(maxAttempts);
    }
  });

  it('retries past an unlucky layout and reports how many attempts it took', () => {
    // A required fork leaves few main-path slots; some layouts cannot fit the guarantees.
    const zone = testZone({
      generation: { minNodes: 6, maxNodes: 6, branching: { minBranches: 1, maxBranches: 1, maxLength: 2 } },
    });
    const all = graphs(zone);
    expect(all.some((g) => g.attempts > 1)).toBe(true);
    for (const graph of all) expect(validateDungeonGraph(zone, graph)).toEqual([]);
  });
});

describe('validateDungeonGraph', () => {
  const zone = testZone();
  const base = () => generateDungeon(zone, catalogue, 11);

  it('reports a cycle-forming or level-skipping edge', () => {
    const graph = base();
    graph.edges[0]!.to = graph.startNodeId;
    expect(validateDungeonGraph(zone, graph).join('\n')).toMatch(/does not go one depth deeper/);
  });

  it('reports a required extraction window left empty', () => {
    const plain = generateDungeon(testZone(), catalogue, SEEDS.find((seed) => {
      const g = generateDungeon(testZone(), catalogue, seed);
      return !mainPath(g).some((n) => n.extraction && n.depth === 3);
    })!);
    const windowed = testZone({ generation: { extraction: { windows: [{ minDepth: 3, maxDepth: 3, required: true }] } } });
    expect(validateDungeonGraph(windowed, plain).join(' ')).toMatch(/no main-path extraction point at depth 3–3/);
    const optional = testZone({ generation: { extraction: { windows: [{ minDepth: 3, maxDepth: 3, required: false }] } } });
    expect(validateDungeonGraph(optional, plain)).toEqual([]);
  });

  it('reports a second boss, a wrong extraction flag and a foreign pool entry', () => {
    const second = base();
    second.nodes[1]!.type = 'boss';
    expect(validateDungeonGraph(zone, second).join('\n')).toMatch(/exactly one boss/);

    const flag = base();
    flag.nodes[0]!.extraction = true;
    expect(validateDungeonGraph(zone, flag).join('\n')).toMatch(/extraction flag/);

    const foreign = base();
    const fight = foreign.nodes.find((n) => n.type === 'combat')!;
    fight.source = { pool: 'combat', entryId: 'nope' };
    expect(validateDungeonGraph(zone, foreign).join('\n')).toMatch(/the zone does not have/);
  });
});
