/**
 * The dungeon generator: a validated zone definition and a seed in, a legal
 * run graph out — or a typed failure, never a partial dungeon.
 *
 * Pure and neutral: no database, no Discord, no Portal. The Admin preview and
 * a real run call the same function.
 *
 * ## Determinism
 *
 * One `seededRng(seed)` drives every choice, in a fixed order. The same zone
 * definition, the same content catalogue and the same seed always produce the
 * same graph. Nothing here reads a clock or `Math.random`.
 *
 * ## The graph
 *
 * A layered DAG. Depth runs `1..depthCount`. Most depths hold one node — the
 * **main path**. A **fork** makes `1..maxLength` consecutive depths hold two
 * (lane 0 and lane 1): the node before the fork leads to both lanes, each lane
 * runs straight, and both rejoin at the node after. Every edge goes from depth
 * `d` to `d + 1`, so there are no cycles by construction. Forks never touch
 * the first or the final depth and never abut one another.
 *
 * ## The algorithm
 *
 * Each attempt:
 *
 *   1. **Length.** Roll the total node count in `minNodes..maxNodes`, the
 *      number of forks, and each fork's length. `depthCount` is the total
 *      minus the nodes spent on fork alternates. Optional forks that do not
 *      fit are dropped; a required one that does not fit fails the attempt.
 *   2. **Layout.** Place the forks, build the slots and the edges.
 *   3. **Reserve.** The final slot is the boss (or an `exit` when no boss is
 *      required). With `rest.beforeBoss`, the slot before it is a rest — that
 *      depth was kept off every fork in step 2, so every route to the boss
 *      passes through it; nothing is drawn for it. Then one extraction point
 *      per `extraction.windows` entry (an optional window that has no free
 *      slot is skipped), then any further guaranteed extraction points, then
 *      rests up to `rest.minNodes`, then each `required` group, are placed on
 *      main-path slots — the ones no route can skip. A zone with no windows
 *      and no rest rules draws nothing for them, so it generates exactly as
 *      it did before they existed.
 *   4. **Fill.** Every remaining slot, in depth order, takes a weighted pick
 *      among the types that are *legal* there. Weights choose; legality
 *      (depth ranges, an eligible pool, limits, adjacency) filters.
 *   5. **Content.** Each enemy and event node takes a weighted pick from the
 *      eligible entries of its pool; each node takes its reward band.
 *   6. **Validate.** The finished graph is checked again from scratch by
 *      {@link validateDungeonGraph}, which shares no state with the steps above.
 *
 * A step that cannot proceed fails the attempt with a named reason, and the
 * next attempt continues from the same RNG stream. After `maxAttempts` the
 * generator throws {@link DungeonGenerationError} with a tally of the reasons.
 */
import { DungeonGenerationError } from '../../shared/errors';
import { rollWeighted, seededRng, type Rng } from '../../shared/random';
import {
  BASIS_POINTS,
  DUNGEON_WEIGHTED_NODE_TYPES,
  depthInRange,
  poolForNodeType,
  reservedTailDepths,
  restRulesOf,
  rewardBandFor,
  type DungeonNodeType,
  type DungeonPoolEntry,
  type DungeonPoolKey,
  type DungeonWeightedNodeType,
  type DungeonZoneDefinition,
} from './zoneDefinition';

/** Bumped when the algorithm changes in a way that changes what a seed produces. */
export const DUNGEON_GENERATOR_VERSION = 1;
export const DUNGEON_GRAPH_FORMAT = 'waifumon-dungeon-graph' as const;
export const DEFAULT_MAX_GENERATION_ATTEMPTS = 64;
export const MAX_DUNGEON_SEED = 0xffff_ffff;

/** What the generator needs to know about the content a pool entry names. */
export interface DungeonContentRef {
  key: string;
  name: string;
  enabled: boolean;
}

/** The content pool entries may reference, as it stands when a run is generated. */
export interface DungeonContentCatalogue {
  enemies: ReadonlyMap<string, DungeonContentRef>;
  events: ReadonlyMap<string, DungeonContentRef>;
}

export interface DungeonGraphNode {
  /** `n1`, `n2`, … in depth order, lane 0 first. */
  id: string;
  /** 1-based. */
  depth: number;
  /** 0 on the main path and one side of a fork, 1 on the other. */
  lane: 0 | 1;
  type: DungeonNodeType;
  /** Ids of the edges leaving this node. Empty only on the terminal node. */
  outgoing: string[];
  /** The enemy or event placed here; null for a type that has none. */
  content: { kind: 'enemy' | 'event'; key: string } | null;
  /** The pool entry the content was drawn from. */
  source: { pool: DungeonPoolKey; entryId: string } | null;
  /** The zone's reward band this node pays from; null when none covers it. */
  rewardBandId: string | null;
  /** Whether the player may extract here. */
  extraction: boolean;
  /** The last node of the run. */
  terminal: boolean;
  boss: boolean;
}

export interface DungeonGraphEdge {
  id: string;
  from: string;
  to: string;
}

/** A generated run: plain data, safe to store as JSON and to send to a client. */
export interface DungeonGraph {
  format: typeof DUNGEON_GRAPH_FORMAT;
  generatorVersion: number;
  zoneKey: string;
  seed: number;
  depthCount: number;
  startNodeId: string;
  terminalNodeId: string;
  nodes: DungeonGraphNode[];
  edges: DungeonGraphEdge[];
  /** How many attempts the generator needed (1 is the common case). */
  attempts: number;
}

export interface GenerateDungeonOptions {
  /** Retry bound; defaults to {@link DEFAULT_MAX_GENERATION_ATTEMPTS}. */
  maxAttempts?: number;
}

export function isValidDungeonSeed(seed: unknown): seed is number {
  return typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= MAX_DUNGEON_SEED;
}

// ── eligibility ─────────────────────────────────────────────────────────────

function contentKeyOf(entry: DungeonPoolEntry): string {
  return 'enemyKey' in entry ? entry.enemyKey : entry.eventKey;
}

function catalogueFor(pool: DungeonPoolKey, catalogue: DungeonContentCatalogue) {
  return pool === 'event' ? catalogue.events : catalogue.enemies;
}

/**
 * The entries of a pool that may be drawn at `depth`: enabled, weighted, in
 * depth range, and naming content that exists and is enabled.
 */
export function eligiblePoolEntries(
  zone: DungeonZoneDefinition,
  pool: DungeonPoolKey,
  depth: number,
  catalogue: DungeonContentCatalogue,
): DungeonPoolEntry[] {
  const lookup = catalogueFor(pool, catalogue);
  const entries: readonly DungeonPoolEntry[] = zone.pools[pool];
  return entries.filter(
    (entry) =>
      entry.enabled &&
      entry.weight > 0 &&
      depthInRange(depth, entry) &&
      lookup.get(contentKeyOf(entry))?.enabled === true,
  );
}

/** A zone's extraction windows. Zones snapshotted before windows existed have none. */
export function extractionWindowsOf(
  zone: DungeonZoneDefinition,
): readonly { minDepth: number; maxDepth: number | null; required: boolean }[] {
  return zone.generation.extraction.windows ?? [];
}

/**
 * Whether `type` may sit at `depth` at all — its depth range, and something
 * for it to hold: an eligible pool entry for enemy and event nodes, a reward
 * band for a reward node, the extraction depth for an exit.
 *
 * `terminal` is the final node, whose type is structural: a required boss
 * ignores `depthRanges`, and a closing `exit` ignores the extraction depth.
 */
export function nodeTypeAllowedAtDepth(
  zone: DungeonZoneDefinition,
  type: DungeonNodeType,
  depth: number,
  catalogue: DungeonContentCatalogue,
  terminal = false,
): boolean {
  if (!terminal) {
    if (type === 'boss') return false;
    if (!depthInRange(depth, zone.generation.depthRanges[type])) return false;
    if (type === 'rest' && !depthInRange(depth, restRulesOf(zone.generation))) return false;
    if (type === 'exit' && depth < zone.generation.extraction.minDepth) return false;
  }
  const pool = poolForNodeType(type);
  if (pool && eligiblePoolEntries(zone, pool, depth, catalogue).length === 0) return false;
  if (type === 'reward' && rewardBandFor(zone.rewards.bands, type, depth) === null) return false;
  return true;
}

// ── one attempt ─────────────────────────────────────────────────────────────

interface Slot {
  index: number;
  depth: number;
  lane: 0 | 1;
  /** The only node at its depth — every route passes through it. */
  mainPath: boolean;
  terminal: boolean;
  type: DungeonNodeType | null;
  predecessors: number[];
  successors: number[];
}

/** An attempt that cannot proceed. Caught by the retry loop, never thrown out. */
class AttemptFailure extends Error {}

function fail(reason: string): never {
  throw new AttemptFailure(reason);
}

function buildSlots(zone: DungeonZoneDefinition, rng: Rng): Slot[] {
  const gen = zone.generation;
  const { minBranches, maxBranches, chanceBasisPoints, maxLength } = gen.branching;

  // 1. Length.
  const total = rng.intInclusive(gen.minNodes, gen.maxNodes);
  let branchCount = minBranches;
  for (let i = minBranches; i < maxBranches; i++) {
    if (rng.next() * BASIS_POINTS < chanceBasisPoints) branchCount += 1;
  }
  const lengths: number[] = [];
  for (let i = 0; i < branchCount; i++) lengths.push(rng.intInclusive(1, maxLength));

  // Forks live strictly between the first and final depth, with a rejoin node
  // between any two, so they need `sum + (count - 1)` of the `depthCount - 2`
  // interior depths. Drop optional forks until they fit.
  // A rest that must precede the boss takes the last interior depth off the
  // table for forks: both lanes of a fork there would reach the boss directly.
  const reservedTail = reservedTailDepths(gen);
  const depthCountFor = () => total - lengths.reduce((a, b) => a + b, 0);
  const slackFor = () =>
    depthCountFor() - 2 - reservedTail - (lengths.reduce((a, b) => a + b, 0) + Math.max(0, lengths.length - 1));
  while (lengths.length > 0 && (depthCountFor() < 2 + reservedTail || slackFor() < 0)) {
    if (lengths.length <= minBranches) fail('required branches do not fit in the run length');
    lengths.pop();
  }
  const depthCount = depthCountFor();
  if (depthCount < 2) fail('run is too short for a start and a final node');
  if (depthCount < 2 + reservedTail) fail('run is too short for a start, a rest before the boss, and the boss');

  // 2. Layout. Spread the spare interior depths across the gaps before each fork.
  const forked = new Set<number>();
  let slack = slackFor();
  let cursor = 2;
  for (const length of lengths) {
    const gap = rng.intInclusive(0, slack);
    slack -= gap;
    const start = cursor + gap;
    for (let d = start; d < start + length; d++) forked.add(d);
    cursor = start + length + 1;
  }

  const slots: Slot[] = [];
  const byDepth: Slot[][] = [];
  for (let depth = 1; depth <= depthCount; depth++) {
    const lanes: (0 | 1)[] = forked.has(depth) ? [0, 1] : [0];
    const row = lanes.map((lane): Slot => ({
      index: slots.length + lane,
      depth,
      lane,
      mainPath: lanes.length === 1,
      terminal: depth === depthCount,
      type: null,
      predecessors: [],
      successors: [],
    }));
    slots.push(...row);
    byDepth.push(row);
  }
  for (let d = 0; d < byDepth.length - 1; d++) {
    const from = byDepth[d]!;
    const to = byDepth[d + 1]!;
    for (const a of from) {
      for (const b of to) {
        // Inside a fork each lane runs straight; everywhere else all pairs join.
        if (from.length === 2 && to.length === 2 && a.lane !== b.lane) continue;
        a.successors.push(b.index);
        b.predecessors.push(a.index);
      }
    }
  }
  return slots;
}

function assignTypes(
  zone: DungeonZoneDefinition,
  slots: Slot[],
  catalogue: DungeonContentCatalogue,
  rng: Rng,
): void {
  const gen = zone.generation;
  const noConsecutive = new Set<DungeonNodeType>(gen.noConsecutive);

  const countOf = (types: readonly DungeonNodeType[], mainPathOnly: boolean) =>
    slots.filter((s) => s.type !== null && types.includes(s.type) && (!mainPathOnly || s.mainPath)).length;

  const restRules = restRulesOf(gen);
  const legal = (type: DungeonNodeType, slot: Slot): boolean => {
    if (!nodeTypeAllowedAtDepth(zone, type, slot.depth, catalogue)) return false;
    if (type === 'rest' && restRules.maxNodes !== null && countOf(['rest'], false) >= restRules.maxNodes) return false;
    for (const limit of gen.limits) {
      if (limit.types.includes(type) && countOf(limit.types, false) >= limit.max) return false;
    }
    if (noConsecutive.has(type)) {
      for (const neighbour of [...slot.predecessors, ...slot.successors]) {
        if (slots[neighbour]!.type === type) return false;
      }
    }
    return true;
  };

  /** Weighted by `nodeWeights`; a set whose weights are all zero is picked evenly. */
  const pickType = (types: readonly DungeonNodeType[]): DungeonNodeType => {
    const weightOf = (t: DungeonNodeType) =>
      t === 'boss' ? 0 : gen.nodeWeights[t as DungeonWeightedNodeType];
    const weighted = types.some((t) => weightOf(t) > 0);
    return rollWeighted(
      types.map((t) => ({ value: t, weight: weighted ? weightOf(t) : 1 })),
      rng,
    );
  };

  /**
   * Put one node of `types` on a free main-path slot that `accepts` it. With
   * no such slot: fails the attempt, or — when `optional` — places nothing,
   * draws nothing and returns false.
   */
  const reserve = (
    types: readonly DungeonNodeType[],
    accepts: (slot: Slot) => boolean,
    what: string,
    optional = false,
  ): boolean => {
    const candidates = slots
      .filter((s) => s.type === null && s.mainPath && !s.terminal && accepts(s))
      .map((slot) => ({ slot, types: types.filter((t) => legal(t, slot)) }))
      .filter((c) => c.types.length > 0);
    if (candidates.length === 0) {
      if (optional) return false;
      fail(`no main-path slot can hold ${what}`);
    }
    const chosen = candidates[rng.intInclusive(0, candidates.length - 1)]!;
    chosen.slot.type = pickType(chosen.types);
    return true;
  };

  // 3. Reserve. The final node first: its type is structural.
  const final = slots[slots.length - 1]!;
  const finalType: DungeonNodeType = gen.boss.required ? 'boss' : 'exit';
  if (!nodeTypeAllowedAtDepth(zone, finalType, final.depth, catalogue, true)) {
    fail(`no eligible boss at final depth ${final.depth}`);
  }
  final.type = finalType;

  if (reservedTailDepths(gen) > 0) {
    // The one slot at the depth before the boss. Structural, so nothing is
    // drawn — but it is still a rest, and must be a legal one.
    const approach = slots.find((s) => s.depth === final.depth - 1 && s.mainPath);
    if (!approach || !legal('rest', approach)) {
      fail(`a rest cannot sit before the boss at depth ${final.depth - 1}`);
    }
    approach.type = 'rest';
  }

  const { minDepth, nodeTypes: extractionTypes, minPoints } = gen.extraction;
  const offersExtraction = (s: Slot) =>
    s.type !== null && !s.terminal && s.depth >= minDepth && extractionTypes.includes(s.type);
  for (const window of extractionWindowsOf(zone)) {
    const inWindow = (s: Slot) => s.depth >= minDepth && depthInRange(s.depth, window);
    if (slots.some((s) => s.mainPath && offersExtraction(s) && inWindow(s))) continue;
    reserve(
      extractionTypes,
      inWindow,
      `an extraction point at depth ${window.minDepth}–${window.maxDepth ?? 'end'}`,
      !window.required,
    );
  }
  while (slots.filter((s) => s.mainPath && offersExtraction(s)).length < minPoints) {
    reserve(extractionTypes, (s) => s.depth >= minDepth, 'a guaranteed extraction point');
  }
  while (countOf(['rest'], true) < restRules.minNodes) {
    reserve(['rest'], () => true, 'a required rest');
  }
  for (const group of gen.required) {
    while (countOf(group.types, true) < group.min) {
      reserve(group.types, () => true, `a required ${group.types.join('/')} node`);
    }
  }

  // 4. Fill.
  for (const slot of slots) {
    if (slot.type !== null) continue;
    const options = DUNGEON_WEIGHTED_NODE_TYPES.filter((t) => gen.nodeWeights[t] > 0 && legal(t, slot));
    if (options.length === 0) fail(`no legal node type at depth ${slot.depth}`);
    slot.type = pickType(options);
  }
}

function toGraph(
  zone: DungeonZoneDefinition,
  slots: Slot[],
  catalogue: DungeonContentCatalogue,
  seed: number,
  attempts: number,
  rng: Rng,
): DungeonGraph {
  const gen = zone.generation;
  const idOf = (index: number) => `n${index + 1}`;
  const edges: DungeonGraphEdge[] = [];
  /** Per slot: the enemy placed there and how many times in a row it has been met. */
  const streaks: ({ enemyKey: string; length: number } | null)[] = [];

  // 5. Content.
  const nodes = slots.map((slot): DungeonGraphNode => {
    const type = slot.type!;
    const pool = poolForNodeType(type);
    let content: DungeonGraphNode['content'] = null;
    let source: DungeonGraphNode['source'] = null;
    let streak: { enemyKey: string; length: number } | null = null;

    if (pool) {
      const streakWith = (enemyKey: string) =>
        1 +
        Math.max(
          0,
          ...slot.predecessors.map((p) => (streaks[p]?.enemyKey === enemyKey ? streaks[p]!.length : 0)),
        );
      const candidates = eligiblePoolEntries(zone, pool, slot.depth, catalogue).filter(
        (entry) =>
          !('enemyKey' in entry) ||
          gen.maxConsecutiveSameEnemy === null ||
          streakWith(entry.enemyKey) <= gen.maxConsecutiveSameEnemy,
      );
      if (candidates.length === 0) fail(`no eligible ${pool} entry at depth ${slot.depth}`);
      const entry = rollWeighted(
        candidates.map((value) => ({ value, weight: value.weight })),
        rng,
      );
      if ('enemyKey' in entry) {
        content = { kind: 'enemy', key: entry.enemyKey };
        streak = { enemyKey: entry.enemyKey, length: streakWith(entry.enemyKey) };
      } else {
        content = { kind: 'event', key: entry.eventKey };
      }
      source = { pool, entryId: entry.id };
    }
    streaks.push(streak);

    const outgoing = slot.successors.map((to) => {
      const id = `e${edges.length + 1}`;
      edges.push({ id, from: idOf(slot.index), to: idOf(to) });
      return id;
    });
    return {
      id: idOf(slot.index),
      depth: slot.depth,
      lane: slot.lane,
      type,
      outgoing,
      content,
      source,
      rewardBandId: rewardBandFor(zone.rewards.bands, type, slot.depth)?.id ?? null,
      extraction:
        !slot.terminal &&
        slot.depth >= gen.extraction.minDepth &&
        gen.extraction.nodeTypes.includes(type),
      terminal: slot.terminal,
      boss: type === 'boss',
    };
  });

  return {
    format: DUNGEON_GRAPH_FORMAT,
    generatorVersion: DUNGEON_GENERATOR_VERSION,
    zoneKey: zone.key,
    seed,
    depthCount: slots[slots.length - 1]!.depth,
    startNodeId: nodes[0]!.id,
    terminalNodeId: nodes[nodes.length - 1]!.id,
    nodes,
    edges,
    attempts,
  };
}

/**
 * Generate a run.
 *
 * `zone` must already be a parsed {@link DungeonZoneDefinition}. Whether the
 * zone is *enabled* is the caller's business: the Admin preview generates
 * disabled zones on purpose; starting a real run refuses them.
 *
 * @throws {DungeonGenerationError} when no attempt produced a legal graph.
 */
export function generateDungeon(
  zone: DungeonZoneDefinition,
  catalogue: DungeonContentCatalogue,
  seed: number,
  options: GenerateDungeonOptions = {},
): DungeonGraph {
  if (!isValidDungeonSeed(seed)) {
    throw new RangeError(`dungeon seed must be an integer in 0..${MAX_DUNGEON_SEED}, got ${String(seed)}`);
  }
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_GENERATION_ATTEMPTS));
  const rng = seededRng(seed);
  const failures: Record<string, number> = {};
  let lastFailure = 'no attempt was made';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const slots = buildSlots(zone, rng);
      assignTypes(zone, slots, catalogue, rng);
      const graph = toGraph(zone, slots, catalogue, seed, attempt, rng);
      // 6. Validate. Anything reported here is a generator bug, but a broken
      // graph must not escape either way.
      const violations = validateDungeonGraph(zone, graph);
      if (violations.length > 0) fail(`generated graph is invalid: ${violations[0]!}`);
      return graph;
    } catch (err) {
      if (!(err instanceof AttemptFailure)) throw err;
      lastFailure = err.message;
      failures[lastFailure] = (failures[lastFailure] ?? 0) + 1;
    }
  }
  throw new DungeonGenerationError({ zoneKey: zone.key, seed, attempts: maxAttempts, failures, lastFailure });
}

// ── validation ──────────────────────────────────────────────────────────────

/**
 * Every rule a graph breaks, checked from the graph and the zone alone — the
 * generator's own bookkeeping is not consulted, so this is an independent
 * oracle for it and for tests.
 *
 * Content is checked against the zone's pools (the entry exists and its depth
 * range admits the node), not against the live catalogue: a stored graph stays
 * valid after an enemy it names is disabled.
 */
export function validateDungeonGraph(zone: DungeonZoneDefinition, graph: DungeonGraph): string[] {
  const gen = zone.generation;
  const out: string[] = [];
  const { nodes, edges } = graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edgeById = new Map(edges.map((e) => [e.id, e]));

  if (byId.size !== nodes.length) out.push('node ids are not unique');
  if (edgeById.size !== edges.length) out.push('edge ids are not unique');
  if (nodes.length < gen.minNodes || nodes.length > gen.maxNodes) {
    out.push(`${nodes.length} nodes is outside ${gen.minNodes}..${gen.maxNodes}`);
  }

  const successors = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const predecessors = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      out.push(`edge ${edge.id} names a missing node`);
      continue;
    }
    // Strictly one depth deeper: this is what makes the graph acyclic.
    if (to.depth !== from.depth + 1) out.push(`edge ${edge.id} does not go one depth deeper`);
    if (!from.outgoing.includes(edge.id)) out.push(`edge ${edge.id} is not listed on node ${from.id}`);
    successors.get(from.id)!.push(to.id);
    predecessors.get(to.id)!.push(from.id);
  }
  for (const node of nodes) {
    for (const id of node.outgoing) {
      if (edgeById.get(id)?.from !== node.id) out.push(`node ${node.id} lists edge ${id} it does not own`);
    }
  }
  if (out.length > 0) return out;

  const depthCount = Math.max(...nodes.map((n) => n.depth));
  if (graph.depthCount !== depthCount) out.push('depthCount does not match the deepest node');
  const atDepth = (d: number) => nodes.filter((n) => n.depth === d);
  const mainPath = (n: DungeonGraphNode) => atDepth(n.depth).length === 1;

  const start = atDepth(1);
  if (start.length !== 1 || start[0]!.id !== graph.startNodeId) out.push('there is not exactly one start node');
  const terminals = nodes.filter((n) => n.terminal);
  const last = atDepth(depthCount);
  if (terminals.length !== 1 || last.length !== 1 || terminals[0] !== last[0]) {
    out.push('there is not exactly one terminal node at the final depth');
  } else if (graph.terminalNodeId !== terminals[0]!.id) {
    out.push('terminalNodeId does not name the terminal node');
  }
  for (let d = 1; d <= depthCount; d++) {
    const count = atDepth(d).length;
    if (count < 1 || count > 2) out.push(`depth ${d} has ${count} nodes`);
  }

  const reached = new Set<string>([graph.startNodeId]);
  const queue = [graph.startNodeId];
  while (queue.length > 0) {
    for (const next of successors.get(queue.shift()!) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  for (const node of nodes) {
    if (!reached.has(node.id)) out.push(`node ${node.id} cannot be reached from the start`);
    if (!node.terminal && node.outgoing.length === 0) out.push(`node ${node.id} is a dead end`);
    if (node.terminal && node.outgoing.length > 0) out.push(`terminal node ${node.id} has outgoing edges`);
    if (node.boss !== (node.type === 'boss')) out.push(`node ${node.id} boss flag disagrees with its type`);
  }

  const forks = nodes.filter((n) => n.outgoing.length > 1).length;
  if (forks < gen.branching.minBranches || forks > gen.branching.maxBranches) {
    out.push(`${forks} branches is outside ${gen.branching.minBranches}..${gen.branching.maxBranches}`);
  }

  const bosses = nodes.filter((n) => n.type === 'boss');
  if (gen.boss.required) {
    if (bosses.length !== 1 || !bosses[0]!.terminal) out.push('there is not exactly one boss, as the final node');
  } else {
    if (bosses.length > 0) out.push('a boss was placed but none is required');
    if (terminals[0] && terminals[0].type !== 'exit') out.push('a run without a boss must end on an exit');
  }

  for (const node of nodes) {
    if (!node.terminal) {
      if (!depthInRange(node.depth, gen.depthRanges[node.type])) {
        out.push(`${node.type} node ${node.id} is outside its depth range at depth ${node.depth}`);
      }
      if (node.type === 'exit' && node.depth < gen.extraction.minDepth) {
        out.push(`exit node ${node.id} is above the extraction depth`);
      }
    }
    const extraction =
      !node.terminal && node.depth >= gen.extraction.minDepth && gen.extraction.nodeTypes.includes(node.type);
    if (node.extraction !== extraction) out.push(`node ${node.id} extraction flag is wrong`);

    if (gen.noConsecutive.includes(node.type)) {
      for (const next of successors.get(node.id)!) {
        if (byId.get(next)!.type === node.type) out.push(`${node.type} nodes ${node.id} and ${next} are consecutive`);
      }
    }

    const pool = poolForNodeType(node.type);
    if (!pool) {
      if (node.content || node.source) out.push(`${node.type} node ${node.id} carries content`);
    } else if (!node.content || !node.source || node.source.pool !== pool) {
      out.push(`${node.type} node ${node.id} has no content from the ${pool} pool`);
    } else {
      const entries: readonly DungeonPoolEntry[] = zone.pools[pool];
      const entry = entries.find((e) => e.id === node.source!.entryId);
      if (!entry) out.push(`node ${node.id} names pool entry "${node.source.entryId}" the zone does not have`);
      else {
        if (contentKeyOf(entry) !== node.content.key) out.push(`node ${node.id} content does not match its pool entry`);
        if (!depthInRange(node.depth, entry)) out.push(`node ${node.id} uses "${entry.id}" outside its depth range`);
      }
    }
    if (node.rewardBandId !== (rewardBandFor(zone.rewards.bands, node.type, node.depth)?.id ?? null)) {
      out.push(`node ${node.id} names the wrong reward band`);
    }
    if (node.type === 'reward' && node.rewardBandId === null) out.push(`reward node ${node.id} has no reward band`);
  }

  for (const limit of gen.limits) {
    const count = nodes.filter((n) => limit.types.includes(n.type)).length;
    if (count > limit.max) out.push(`${count} ${limit.types.join('/')} nodes is above the limit of ${limit.max}`);
  }
  for (const group of gen.required) {
    const count = nodes.filter((n) => group.types.includes(n.type) && mainPath(n)).length;
    if (count < group.min) {
      out.push(`${count} ${group.types.join('/')} nodes on the main path is below the required ${group.min}`);
    }
  }
  const restRules = restRulesOf(gen);
  const rests = nodes.filter((n) => n.type === 'rest');
  for (const node of rests) {
    if (!depthInRange(node.depth, restRules)) {
      out.push(`rest node ${node.id} is outside the rest depth range at depth ${node.depth}`);
    }
  }
  if (restRules.maxNodes !== null && rests.length > restRules.maxNodes) {
    out.push(`${rests.length} rest nodes is above the maximum of ${restRules.maxNodes}`);
  }
  const mainPathRests = rests.filter(mainPath).length;
  if (mainPathRests < restRules.minNodes) {
    out.push(`${mainPathRests} rest nodes on the main path is below the minimum of ${restRules.minNodes}`);
  }
  if (reservedTailDepths(gen) > 0 && terminals[0]) {
    const before = nodes.filter((n) => n.depth === terminals[0]!.depth - 1);
    if (before.length !== 1 || before[0]!.type !== 'rest') {
      out.push('the node before the boss is not a single rest that every route passes through');
    }
  }

  const extractionPoints = nodes.filter((n) => n.extraction && mainPath(n)).length;
  if (extractionPoints < gen.extraction.minPoints) {
    out.push(`${extractionPoints} main-path extraction points is below the required ${gen.extraction.minPoints}`);
  }
  for (const window of extractionWindowsOf(zone)) {
    if (!window.required) continue;
    if (!nodes.some((n) => n.extraction && mainPath(n) && depthInRange(n.depth, window))) {
      out.push(`no main-path extraction point at depth ${window.minDepth}–${window.maxDepth ?? 'end'}`);
    }
  }

  if (gen.maxConsecutiveSameEnemy !== null) {
    // Nodes are in depth order, so every predecessor is settled first.
    const streak = new Map<string, number>();
    for (const node of [...nodes].sort((a, b) => a.depth - b.depth)) {
      if (node.content?.kind !== 'enemy') continue;
      const before = predecessors
        .get(node.id)!
        .map((p) => byId.get(p)!)
        .filter((p) => p.content?.kind === 'enemy' && p.content.key === node.content!.key)
        .map((p) => streak.get(p.id) ?? 0);
      const length = 1 + Math.max(0, ...before);
      streak.set(node.id, length);
      if (length > gen.maxConsecutiveSameEnemy) {
        out.push(`enemy "${node.content.key}" is fought ${length} times in a row at node ${node.id}`);
      }
    }
  }
  return out;
}

/** Narrowing helpers for callers that read a graph back from storage. */
export function enemyKeysOf(graph: DungeonGraph): string[] {
  return [...new Set(graph.nodes.flatMap((n) => (n.content?.kind === 'enemy' ? [n.content.key] : [])))];
}

export function eventKeysOf(graph: DungeonGraph): string[] {
  return [...new Set(graph.nodes.flatMap((n) => (n.content?.kind === 'event' ? [n.content.key] : [])))];
}
