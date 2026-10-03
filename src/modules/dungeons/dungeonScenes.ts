/**
 * Which background each node of a run is drawn against.
 *
 * Decided once, when the run is generated, and stored on the run snapshot —
 * a screen never chooses. The choice is a pure function of the zone and the
 * run's seed, so the same seed reproduces the same scenes.
 *
 * Deliberately **not** part of the generator: the graph's own random stream
 * is untouched (an existing seed still produces the same graph), and nothing
 * here knows about images. It draws from its own stream, derived from the
 * run seed, one roll per node in graph order.
 *
 * A node at a depth no enabled, weighted background covers gets none and
 * falls back to the zone background.
 *
 * Pure: no database, no assets, no image library.
 */
import { rollWeighted, seededRng } from '../../shared/random';
import type { DungeonGraph } from './dungeonGenerator';
import { backgroundsOf, depthInRange, type DungeonZoneDefinition } from './zoneDefinition';

export const DUNGEON_SCENES_VERSION = 1 as const;

/** The background a node drew: the pool entry, and the one image it names. */
export interface DungeonSceneBackground {
  entryId: string;
  assetId: string | null;
  artworkPath: string | null;
}

export interface DungeonNodeScene {
  background: DungeonSceneBackground | null;
}

export interface DungeonRunScenes {
  version: typeof DUNGEON_SCENES_VERSION;
  /** Node id → its scene. Every node of the graph has an entry. */
  nodes: Record<string, DungeonNodeScene>;
}

/** The scene stream's seed: a fixed scramble of the run seed, so it is not the graph's stream. */
export function sceneSeedOf(runSeed: number): number {
  let h = (runSeed ^ 0x5ce9e5ed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function selectDungeonScenes(
  zone: Pick<DungeonZoneDefinition, 'backgrounds'>,
  graph: Pick<DungeonGraph, 'nodes'>,
  runSeed: number,
): DungeonRunScenes {
  const rng = seededRng(sceneSeedOf(runSeed));
  const pool = backgroundsOf(zone).filter((b) => b.enabled && b.weight > 0);
  const nodes: Record<string, DungeonNodeScene> = {};
  for (const node of graph.nodes) {
    const eligible = pool.filter((b) => depthInRange(node.depth, b));
    // Always one roll per node, so adding a depth range to one background
    // never shifts what the nodes after it draw.
    const roll = rng.next();
    if (eligible.length === 0) {
      nodes[node.id] = { background: null };
      continue;
    }
    const picked = rollWeighted(
      eligible.map((b) => ({ weight: b.weight, value: b })),
      { next: () => roll, intInclusive: rng.intInclusive },
    );
    nodes[node.id] = {
      background: { entryId: picked.id, assetId: picked.assetId, artworkPath: picked.artworkPath },
    };
  }
  return { version: DUNGEON_SCENES_VERSION, nodes };
}
