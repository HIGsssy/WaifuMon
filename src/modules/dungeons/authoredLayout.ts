/**
 * Authored dungeons: a hand-built room layout in, the run graph out.
 *
 * A procedural zone gets its graph from the generator; an authored zone gets
 * it from {@link compileAuthoredDungeon}. Both produce the same
 * {@link DungeonGraph}, and {@link buildDungeonGraph} is the one place that
 * chooses between them — after it, nothing knows which mode a run came from.
 *
 * ## Rooms and nodes
 *
 * One room compiles to one node. Nodes are numbered `n1`, `n2`, … in depth
 * order (a room's depth is the longest route to it from the start, so depth
 * only ever increases along a route), and each node keeps its room's id and
 * name. What a room chose by hand travels on its node: the enemy or event as
 * `content`, its own payout as `reward`, its own heal as
 * `restHealBasisPoints`. A room that chose none of those inherits exactly
 * what a generated node of its type and depth would have had.
 *
 * ## What makes a layout legal
 *
 *   - exactly one start room, and every room reachable from it;
 *   - every `next` names a room that exists;
 *   - no loops — the layout is a DAG, as a generated one is;
 *   - exactly one final room (a room with no `next`), and it is a Boss or an
 *     Exit; a Boss is only ever the final room;
 *   - every fight names an enemy and every event names an event.
 *
 * {@link validateAuthoredLayout} reports each broken rule in the author's
 * terms, naming rooms by what they are called. Problems are errors on an
 * enabled zone and warnings on a disabled one, so a layout can be saved
 * half-built while it is switched off — and is refused the moment someone
 * tries to switch it on or start a run in it.
 *
 * Pure: no database, no Discord, no Portal.
 */
import {
  DUNGEON_GENERATOR_VERSION,
  DUNGEON_GRAPH_FORMAT,
  generateDungeon,
  isValidDungeonSeed,
  MAX_DUNGEON_SEED,
  type DungeonContentCatalogue,
  type DungeonGraph,
  type DungeonGraphEdge,
  type DungeonGraphNode,
  type GenerateDungeonOptions,
} from './dungeonGenerator';
import {
  DUNGEON_SCENES_VERSION,
  selectDungeonScenes,
  type DungeonNodeScene,
  type DungeonRunScenes,
} from './dungeonScenes';
import {
  authoredLayoutOf,
  isEnemyNodeType,
  layoutModeOf,
  possibleFinalDepths,
  rewardBandFor,
  type DungeonAuthoredRoom,
  type DungeonNodeType,
  type DungeonZoneDefinition,
} from './zoneDefinition';

export interface AuthoredLayoutIssue {
  /** `authored.rooms[2].next` — where the editor shows it. */
  path: string;
  message: string;
}

const TYPE_LABEL: Readonly<Record<DungeonNodeType, string>> = {
  combat: 'Combat',
  elite: 'Elite',
  miniboss: 'Miniboss',
  boss: 'Boss',
  event: 'Event',
  reward: 'Reward',
  rest: 'Rest',
  exit: 'Exit',
};

/** How a room is named to its author: what they called it, else its type and id. */
export function roomLabel(room: Pick<DungeonAuthoredRoom, 'id' | 'name' | 'type'>): string {
  return room.name !== '' ? room.name : `${TYPE_LABEL[room.type]} (${room.id})`;
}

const quoted = (room: Pick<DungeonAuthoredRoom, 'id' | 'name' | 'type'>) => `"${roomLabel(room)}"`;

/** The layout as a graph: what is reachable, how deep, and whether it loops. */
export interface AuthoredLayoutAnalysis {
  /** Rooms reachable from the start, in the order the author listed them. */
  reachable: DungeonAuthoredRoom[];
  /** Room id → 1-based depth: the longest route from the start. Reachable rooms only; empty when the layout loops. */
  depths: Map<string, number>;
  /** Reachable rooms with nowhere to go on to. A legal layout has exactly one. */
  terminals: DungeonAuthoredRoom[];
  /** A loop found among the reachable rooms, as the rooms it passes through; null when there is none. */
  cycle: DungeonAuthoredRoom[] | null;
  /** The fewest and the most rooms a route from the start to the end passes through. */
  routeLength: { min: number; max: number } | null;
}

export function analyseAuthoredLayout(zone: Pick<DungeonZoneDefinition, 'authored'>): AuthoredLayoutAnalysis {
  const { rooms, startRoomId } = authoredLayoutOf(zone);
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const nextOf = (room: DungeonAuthoredRoom) =>
    [...new Set(room.next)].flatMap((id) => (id !== room.id && byId.has(id) ? [byId.get(id)!] : []));
  const empty: AuthoredLayoutAnalysis = { reachable: [], depths: new Map(), terminals: [], cycle: null, routeLength: null };
  const start = startRoomId === null ? undefined : byId.get(startRoomId);
  if (!start) return empty;

  // Depth-first from the start: finds what is reachable, a topological order, and any loop.
  const state = new Map<string, 'open' | 'done'>();
  const order: DungeonAuthoredRoom[] = [];
  const trail: DungeonAuthoredRoom[] = [];
  let cycle: DungeonAuthoredRoom[] | null = null;
  const visit = (room: DungeonAuthoredRoom): void => {
    state.set(room.id, 'open');
    trail.push(room);
    for (const next of nextOf(room)) {
      const seen = state.get(next.id);
      if (seen === 'open') cycle ??= trail.slice(trail.indexOf(next));
      else if (seen === undefined) visit(next);
    }
    trail.pop();
    state.set(room.id, 'done');
    order.push(room);
  };
  visit(start);

  const reachable = rooms.filter((r) => state.has(r.id));
  const terminals = reachable.filter((r) => nextOf(r).length === 0);
  if (cycle) return { reachable, depths: new Map(), terminals, cycle, routeLength: null };

  // `order` is a reverse topological order, so every predecessor is settled first.
  const depths = new Map<string, number>([[start.id, 1]]);
  const shortest = new Map<string, number>([[start.id, 1]]);
  for (const room of [...order].reverse()) {
    for (const next of nextOf(room)) {
      depths.set(next.id, Math.max(depths.get(next.id) ?? 0, depths.get(room.id)! + 1));
      shortest.set(next.id, Math.min(shortest.get(next.id) ?? Infinity, shortest.get(room.id)! + 1));
    }
  }
  const ends = terminals.map((t) => ({ min: shortest.get(t.id)!, max: depths.get(t.id)! }));
  const routeLength =
    ends.length === 0 ? null : { min: Math.min(...ends.map((e) => e.min)), max: Math.max(...ends.map((e) => e.max)) };
  return { reachable, depths, terminals, cycle: null, routeLength };
}

/**
 * Every structural rule the layout breaks, in the author's words. References
 * into other content (does this enemy exist?) are the caller's — see
 * `zoneValidation.ts` — because they need the catalogue.
 */
export function validateAuthoredLayout(zone: Pick<DungeonZoneDefinition, 'authored'>): AuthoredLayoutIssue[] {
  const { rooms, startRoomId } = authoredLayoutOf(zone);
  const issues: AuthoredLayoutIssue[] = [];
  const at = (room: DungeonAuthoredRoom) => `authored.rooms[${rooms.indexOf(room)}]`;
  const byId = new Map(rooms.map((r) => [r.id, r]));

  if (rooms.length === 0) {
    return [{ path: 'authored.rooms', message: 'This dungeon has no rooms yet — add a room to start building it.' }];
  }
  if (startRoomId === null || !byId.has(startRoomId)) {
    issues.push({
      path: 'authored.startRoomId',
      message:
        startRoomId === null
          ? 'Choose the room a run starts in.'
          : 'The start room no longer exists — choose the room a run starts in.',
    });
  }

  for (const room of rooms) {
    const seen = new Set<string>();
    for (const id of room.next) {
      if (id === room.id) {
        issues.push({ path: `${at(room)}.next`, message: `Room ${quoted(room)} leads back to itself.` });
      } else if (!byId.has(id)) {
        issues.push({ path: `${at(room)}.next`, message: `Room ${quoted(room)} points to a room that no longer exists.` });
      } else if (seen.has(id)) {
        issues.push({
          path: `${at(room)}.next`,
          message: `Room ${quoted(room)} leads to ${quoted(byId.get(id)!)} twice.`,
        });
      }
      seen.add(id);
    }
    if (isEnemyNodeType(room.type) && room.enemyKey === null) {
      issues.push({ path: `${at(room)}.enemyKey`, message: `Room ${quoted(room)} is a fight with no enemy — choose one.` });
    }
    if (room.type === 'event' && room.eventKey === null) {
      issues.push({ path: `${at(room)}.eventKey`, message: `Room ${quoted(room)} is an event room with no event — choose one.` });
    }
  }

  const analysis = analyseAuthoredLayout(zone);
  if (analysis.reachable.length === 0) return issues;

  if (analysis.cycle) {
    const loop = [...analysis.cycle, analysis.cycle[0]!].map(quoted).join(' → ');
    issues.push({
      path: `${at(analysis.cycle[0]!)}.next`,
      message: `These rooms form a loop: ${loop}. A dungeon must always move forward — remove one of those links.`,
    });
  }
  const reached = new Set(analysis.reachable.map((r) => r.id));
  for (const room of rooms) {
    if (!reached.has(room.id)) {
      issues.push({
        path: at(room),
        message: `Room ${quoted(room)} cannot be reached from the start — link another room to it, or delete it.`,
      });
    }
  }

  const { terminals } = analysis;
  if (terminals.length > 1) {
    issues.push({
      path: at(terminals[1]!),
      message:
        `${terminals.map(quoted).join(' and ')} all end the dungeon — only one final room is allowed. ` +
        'Give the others a next room.',
    });
  }
  for (const room of terminals) {
    if (room.type !== 'boss' && room.type !== 'exit') {
      issues.push({
        path: at(room),
        message: `Room ${quoted(room)} leads nowhere. A dungeon ends on a Boss or an Exit — add a next room, or change its type.`,
      });
    }
    if (room.extraction && room.type !== 'exit') {
      issues.push({
        path: `${at(room)}.extraction`,
        message: `The final room ${quoted(room)} cannot offer extraction — finishing it completes the dungeon.`,
      });
    }
  }
  for (const room of analysis.reachable) {
    if (room.type === 'boss' && !terminals.includes(room)) {
      issues.push({
        path: at(room),
        message: `Boss room ${quoted(room)} must be the final room — a Boss cannot lead anywhere.`,
      });
    }
  }
  return issues;
}

/** The layout could not be compiled. Carries what {@link validateAuthoredLayout} found. */
export class AuthoredLayoutError extends Error {
  constructor(readonly issues: readonly AuthoredLayoutIssue[]) {
    super(`authored dungeon layout is not legal: ${issues.map((i) => i.message).join(' ')}`);
    this.name = 'AuthoredLayoutError';
  }
}

/**
 * Turn an authored layout into a run graph.
 *
 * The layout decides everything, so `seed` shapes nothing here — it is
 * recorded on the graph because fights and reward draws are still seeded per
 * run.
 *
 * @throws {AuthoredLayoutError} when the layout breaks a structural rule.
 */
export function compileAuthoredDungeon(zone: DungeonZoneDefinition, seed: number): DungeonGraph {
  if (!isValidDungeonSeed(seed)) {
    throw new RangeError(`dungeon seed must be an integer in 0..${MAX_DUNGEON_SEED}, got ${String(seed)}`);
  }
  const issues = validateAuthoredLayout(zone);
  if (issues.length > 0) throw new AuthoredLayoutError(issues);

  const { rooms } = authoredLayoutOf(zone);
  const { depths, terminals } = analyseAuthoredLayout(zone);
  const terminal = terminals[0]!;
  // Depth order, then the author's own order: stable, so a layout always compiles to the same ids.
  const ordered = [...rooms].sort((a, b) => depths.get(a.id)! - depths.get(b.id)! || rooms.indexOf(a) - rooms.indexOf(b));
  const nodeId = new Map(ordered.map((room, i) => [room.id, `n${i + 1}`]));
  const lanes = new Map<number, number>();
  const edges: DungeonGraphEdge[] = [];

  const nodes = ordered.map((room): DungeonGraphNode => {
    const depth = depths.get(room.id)!;
    const lane = lanes.get(depth) ?? 0;
    lanes.set(depth, lane + 1);
    const isTerminal = room === terminal;
    const outgoing = room.next.map((to) => {
      const id = `e${edges.length + 1}`;
      edges.push({ id, from: nodeId.get(room.id)!, to: nodeId.get(to)! });
      return id;
    });
    const content: DungeonGraphNode['content'] = isEnemyNodeType(room.type)
      ? { kind: 'enemy', key: room.enemyKey! }
      : room.type === 'event'
        ? { kind: 'event', key: room.eventKey! }
        : null;
    return {
      id: nodeId.get(room.id)!,
      depth,
      lane,
      type: room.type,
      outgoing,
      content,
      // Authored content is chosen, not drawn: there is no pool entry behind it.
      source: null,
      rewardBandId: room.reward ? null : (rewardBandFor(zone.rewards.bands, room.type, depth)?.id ?? null),
      extraction: !isTerminal && (room.extraction || room.type === 'exit'),
      terminal: isTerminal,
      boss: room.type === 'boss',
      roomId: room.id,
      ...(room.name !== '' ? { name: room.name } : {}),
      ...(room.reward ? { reward: room.reward } : {}),
      ...(room.type === 'rest' && room.healBasisPoints !== null ? { restHealBasisPoints: room.healBasisPoints } : {}),
    };
  });

  return {
    format: DUNGEON_GRAPH_FORMAT,
    generatorVersion: DUNGEON_GENERATOR_VERSION,
    zoneKey: zone.key,
    seed,
    depthCount: depths.get(terminal.id)!,
    startNodeId: nodes[0]!.id,
    terminalNodeId: nodeId.get(terminal.id)!,
    nodes,
    edges,
    attempts: 1,
  };
}

/**
 * The run graph of a zone, whichever way it is made: generated from the seed
 * for a procedural zone, compiled from its rooms for an authored one. Every
 * caller that needs a graph — a real run, the Admin preview, a reproduction,
 * a playtest — comes through here.
 *
 * @throws {DungeonGenerationError} when a procedural zone's rules cannot produce a run.
 * @throws {AuthoredLayoutError} when an authored zone's layout is not legal.
 */
export function buildDungeonGraph(
  zone: DungeonZoneDefinition,
  catalogue: DungeonContentCatalogue,
  seed: number,
  options: GenerateDungeonOptions = {},
): DungeonGraph {
  return layoutModeOf(zone) === 'authored'
    ? compileAuthoredDungeon(zone, seed)
    : generateDungeon(zone, catalogue, seed, options);
}

/**
 * What each node of a run is drawn against, decided once at run start.
 *
 * A procedural zone draws backgrounds from its pool by seed. An authored
 * room uses its own background, else the zone's default — recorded on the
 * node so the default is what shows before the zone cover does — and carries
 * any override of its enemy's sprite, full art and placement.
 */
export function selectRunScenes(zone: DungeonZoneDefinition, graph: DungeonGraph, runSeed: number): DungeonRunScenes {
  if (layoutModeOf(zone) !== 'authored') return selectDungeonScenes(zone, graph, runSeed);
  const rooms = new Map(authoredLayoutOf(zone).rooms.map((r) => [r.id, r]));
  const zoneDefault =
    zone.backgroundAssetId !== null || zone.backgroundArtworkPath !== null
      ? { entryId: 'zone_default', assetId: zone.backgroundAssetId, artworkPath: zone.backgroundArtworkPath }
      : null;
  const nodes: Record<string, DungeonNodeScene> = {};
  for (const node of graph.nodes) {
    const room = node.roomId === undefined ? undefined : rooms.get(node.roomId);
    const own =
      room && (room.backgroundAssetId !== null || room.backgroundArtworkPath !== null)
        ? { entryId: `room:${room.id}`, assetId: room.backgroundAssetId, artworkPath: room.backgroundArtworkPath }
        : null;
    const scene = room?.scene ?? null;
    const overridesEnemy =
      scene !== null &&
      (scene.spriteAssetId !== null || scene.artworkAssetId !== null || scene.spritePlacement !== null);
    nodes[node.id] = {
      background: own ?? zoneDefault,
      ...(overridesEnemy && isEnemyNodeType(node.type) ? { enemy: scene } : {}),
    };
  }
  return { version: DUNGEON_SCENES_VERSION, nodes };
}

/** How long a run of the zone is, in rooms walked: the range a player is told on the zone card. */
export function zoneRunLength(zone: DungeonZoneDefinition): { min: number; max: number } {
  if (layoutModeOf(zone) !== 'authored') return possibleFinalDepths(zone.generation);
  return analyseAuthoredLayout(zone).routeLength ?? { min: 0, max: 0 };
}

/** Whether a run of the zone ends on a boss. */
export function zoneEndsOnBoss(zone: DungeonZoneDefinition): boolean {
  if (layoutModeOf(zone) !== 'authored') return zone.generation.boss.required;
  return analyseAuthoredLayout(zone).terminals.some((room) => room.type === 'boss');
}
