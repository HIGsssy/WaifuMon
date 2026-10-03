/**
 * Generate many runs of one zone and summarise what came out — the tool for
 * sanity-checking authored rules before players meet them.
 *
 * Deterministic: seeds are `firstSeed`, `firstSeed + 1`, …, so the same zone
 * and arguments always give the same report. A seed the generator cannot
 * satisfy is counted, with its reason, rather than thrown.
 */
import { DungeonGenerationError } from '../../shared/errors';
import {
  generateDungeon,
  MAX_DUNGEON_SEED,
  type DungeonContentCatalogue,
  type GenerateDungeonOptions,
} from './dungeonGenerator';
import { DUNGEON_NODE_TYPES, type DungeonNodeType, type DungeonZoneDefinition } from './zoneDefinition';

export const MAX_SIMULATION_RUNS = 20_000;

export interface DungeonSimulationOptions extends GenerateDungeonOptions {
  runs: number;
  /** Defaults to 1. */
  firstSeed?: number;
}

export interface ContentAppearance {
  key: string;
  /** Nodes holding it, across every run. */
  nodes: number;
  /** Runs it appeared in at least once. */
  runs: number;
  /** `runs` as a share of the valid runs, 0..1. */
  runRate: number;
}

export interface DungeonSimulationReport {
  zoneKey: string;
  firstSeed: number;
  runs: number;
  valid: number;
  invalid: number;
  /** 0..1. */
  invalidRate: number;
  /** Why the invalid runs failed, by the generator's last failure reason. */
  failures: Record<string, number>;
  averageAttempts: number;
  averageNodeCount: number;
  minNodeCount: number;
  maxNodeCount: number;
  averageDepth: number;
  /** Nodes of each type across every valid run. */
  nodeTypeCounts: Record<DungeonNodeType, number>;
  /** Each type's share of all nodes, 0..1. */
  nodeTypeShare: Record<DungeonNodeType, number>;
  /** Share of valid runs holding at least one node of the type, 0..1. */
  nodeTypeRunRate: Record<DungeonNodeType, number>;
  /** Share of valid runs with at least one fork. */
  branchRate: number;
  averageBranches: number;
  bossRate: number;
  restRate: number;
  /** Share of valid runs with at least one extraction point. */
  extractionRate: number;
  averageExtractionPoints: number;
  enemies: ContentAppearance[];
  events: ContentAppearance[];
}

const zeroes = () => Object.fromEntries(DUNGEON_NODE_TYPES.map((t) => [t, 0])) as Record<DungeonNodeType, number>;

export function simulateDungeonGeneration(
  zone: DungeonZoneDefinition,
  catalogue: DungeonContentCatalogue,
  options: DungeonSimulationOptions,
): DungeonSimulationReport {
  const runs = Math.floor(options.runs);
  const firstSeed = options.firstSeed ?? 1;
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_SIMULATION_RUNS) {
    throw new RangeError(`runs must be between 1 and ${MAX_SIMULATION_RUNS}, got ${String(options.runs)}`);
  }
  if (!Number.isInteger(firstSeed) || firstSeed < 0 || firstSeed + runs - 1 > MAX_DUNGEON_SEED) {
    throw new RangeError(`firstSeed ${String(firstSeed)} with ${runs} runs leaves the seed range`);
  }

  const failures: Record<string, number> = {};
  const nodeTypeCounts = zeroes();
  const runsWithType = zeroes();
  const appearances = { enemy: new Map<string, [number, number]>(), event: new Map<string, [number, number]>() };
  let valid = 0;
  let attempts = 0;
  let nodeTotal = 0;
  let minNodeCount = Number.POSITIVE_INFINITY;
  let maxNodeCount = 0;
  let depthTotal = 0;
  let branchTotal = 0;
  let runsWithBranch = 0;
  let extractionTotal = 0;
  let runsWithExtraction = 0;

  for (let i = 0; i < runs; i++) {
    let graph;
    try {
      graph = generateDungeon(zone, catalogue, firstSeed + i, options);
    } catch (err) {
      if (!(err instanceof DungeonGenerationError)) throw err;
      const reason = err.diagnostics.lastFailure;
      failures[reason] = (failures[reason] ?? 0) + 1;
      continue;
    }
    valid += 1;
    attempts += graph.attempts;
    nodeTotal += graph.nodes.length;
    minNodeCount = Math.min(minNodeCount, graph.nodes.length);
    maxNodeCount = Math.max(maxNodeCount, graph.nodes.length);
    depthTotal += graph.depthCount;

    const branches = graph.nodes.filter((n) => n.outgoing.length > 1).length;
    branchTotal += branches;
    if (branches > 0) runsWithBranch += 1;
    const extraction = graph.nodes.filter((n) => n.extraction).length;
    extractionTotal += extraction;
    if (extraction > 0) runsWithExtraction += 1;

    const typesSeen = new Set<DungeonNodeType>();
    const contentSeen = new Set<string>();
    for (const node of graph.nodes) {
      nodeTypeCounts[node.type] += 1;
      typesSeen.add(node.type);
      if (!node.content) continue;
      const tally = appearances[node.content.kind];
      const entry = tally.get(node.content.key) ?? [0, 0];
      entry[0] += 1;
      const seenKey = `${node.content.kind}:${node.content.key}`;
      if (!contentSeen.has(seenKey)) {
        contentSeen.add(seenKey);
        entry[1] += 1;
      }
      tally.set(node.content.key, entry);
    }
    for (const type of typesSeen) runsWithType[type] += 1;
  }

  const per = (n: number, d: number) => (d === 0 ? 0 : n / d);
  const rates = (counts: Record<DungeonNodeType, number>, d: number) =>
    Object.fromEntries(DUNGEON_NODE_TYPES.map((t) => [t, per(counts[t], d)])) as Record<DungeonNodeType, number>;
  const appearanceList = (tally: Map<string, [number, number]>): ContentAppearance[] =>
    [...tally.entries()]
      .map(([key, [nodes, inRuns]]) => ({ key, nodes, runs: inRuns, runRate: per(inRuns, valid) }))
      .sort((a, b) => b.nodes - a.nodes || a.key.localeCompare(b.key));
  const nodeTypeRunRate = rates(runsWithType, valid);

  return {
    zoneKey: zone.key,
    firstSeed,
    runs,
    valid,
    invalid: runs - valid,
    invalidRate: per(runs - valid, runs),
    failures,
    averageAttempts: per(attempts, valid),
    averageNodeCount: per(nodeTotal, valid),
    minNodeCount: valid === 0 ? 0 : minNodeCount,
    maxNodeCount,
    averageDepth: per(depthTotal, valid),
    nodeTypeCounts,
    nodeTypeShare: rates(nodeTypeCounts, nodeTotal),
    nodeTypeRunRate,
    branchRate: per(runsWithBranch, valid),
    averageBranches: per(branchTotal, valid),
    bossRate: nodeTypeRunRate.boss,
    restRate: nodeTypeRunRate.rest,
    extractionRate: per(runsWithExtraction, valid),
    averageExtractionPoints: per(extractionTotal, valid),
    enemies: appearanceList(appearances.enemy),
    events: appearanceList(appearances.event),
  };
}
