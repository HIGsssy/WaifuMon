/**
 * Pure helpers for the dungeon zone editor: a blank zone, human-facing
 * conversions (percent ↔ basis points, comma lists), and routing server
 * issues to the part of the form that shows them.
 */
import {
  DUNGEON_MAX_ROOM_EXITS,
  type DungeonAuthoredLayoutDoc,
  type DungeonBackgroundDoc,
  type DungeonContentRef,
  type DungeonLayoutMode,
  type DungeonNodeType,
  type DungeonPoolEntryDoc,
  type DungeonPoolKey,
  type DungeonRewardBandDoc,
  type DungeonRoomDoc,
  type DungeonZoneDoc,
  type DungeonZoneIssue,
  type DungeonZoneSummary,
  layoutModeOf,
} from '@/api/adminDungeons';

export const NODE_TYPE_LABELS: Record<DungeonNodeType, string> = {
  combat: 'Combat',
  elite: 'Elite',
  event: 'Event',
  reward: 'Reward',
  rest: 'Rest',
  miniboss: 'Miniboss',
  boss: 'Boss',
  exit: 'Exit',
};

export const POOL_LABELS: Record<DungeonPoolKey, string> = {
  combat: 'Combat pool',
  elite: 'Elite pool',
  miniboss: 'Miniboss pool',
  boss: 'Boss pool',
  event: 'Event pool',
};

export const DUNGEON_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const DEFAULT_CURRENCY_KEY = 'ascension_currency';

/** A zone that parses but is not yet a dungeon — saved disabled until it is. */
export function newZone(): DungeonZoneDoc {
  return {
    key: '',
    name: '',
    description: '',
    enabled: false,
    order: 0,
    artworkPath: null,
    backgroundArtworkPath: null,
    artworkAssetId: null,
    backgroundAssetId: null,
    backgrounds: [],
    tags: ['initial_tuning'],
    availableRegions: [],
    generation: {
      minNodes: 6,
      maxNodes: 9,
      branching: { minBranches: 0, maxBranches: 1, chanceBasisPoints: 3000, maxLength: 1 },
      extraction: { minDepth: 4, nodeTypes: ['rest', 'exit'], minPoints: 1, windows: [] },
      nodeWeights: { combat: 60, elite: 10, event: 10, reward: 10, rest: 10, miniboss: 0, exit: 0 },
      boss: { required: true },
      rest: { minNodes: 1, maxNodes: 2, minDepth: 2, maxDepth: null, beforeBoss: false },
      depthRanges: { elite: { minDepth: 2, maxDepth: null } },
      required: [],
      limits: [],
      noConsecutive: ['rest'],
      maxConsecutiveSameEnemy: 2,
    },
    nodeSettings: { rest: { healBasisPoints: 3000 } },
    pools: { combat: [], elite: [], miniboss: [], boss: [], event: [] },
    rewards: {
      currencyKey: DEFAULT_CURRENCY_KEY,
      defeatCurrencyRetentionBasisPoints: 2500,
      bands: [],
      completion: { currency: { min: 0, max: 0 }, rewardTable: null },
      extraction: { currency: { min: 0, max: 0 }, rewardTable: null },
    },
  };
}

function uniqueId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/** A new entry for `pool`, naming `contentKey`, with an id not yet used there. */
export function newPoolEntry(
  pool: DungeonPoolKey,
  contentKey: string,
  existing: readonly DungeonPoolEntryDoc[],
): DungeonPoolEntryDoc {
  const entry = {
    id: uniqueId(
      contentKey || 'entry',
      existing.map((e) => e.id),
    ),
    enabled: true,
    weight: 10,
    minDepth: 1,
    maxDepth: null,
    tags: [],
  };
  return pool === 'event' ? { ...entry, eventKey: contentKey } : { ...entry, enemyKey: contentKey };
}

/** A background pool entry for a freshly chosen image. */
export function newBackground(
  image: { assetId: string; name?: string } | { artworkPath: string },
  existing: readonly DungeonBackgroundDoc[],
): DungeonBackgroundDoc {
  const label =
    'assetId' in image
      ? (image.name ?? 'background')
      : (image.artworkPath.split('/').pop() ?? 'background');
  const base =
    label
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'background';
  return {
    id: uniqueId(
      base,
      existing.map((b) => b.id),
    ),
    enabled: true,
    weight: 10,
    minDepth: 1,
    maxDepth: null,
    assetId: 'assetId' in image ? image.assetId : null,
    artworkPath: 'assetId' in image ? null : image.artworkPath,
  };
}

export function newRewardBand(existing: readonly DungeonRewardBandDoc[]): DungeonRewardBandDoc {
  return {
    id: uniqueId(
      'band',
      existing.map((b) => b.id),
    ),
    enabled: true,
    minDepth: 1,
    maxDepth: null,
    nodeTypes: [],
    rewardTable: null,
    equipmentRewardTable: null,
    currency: { min: 0, max: 0 },
  };
}

/** 2500 → 25. Two decimals is the precision basis points carry. */
export function basisPointsToPercent(basisPoints: number): number {
  return Math.round(basisPoints) / 100;
}

/** 25 → 2500, clamped to 0–100%. Anything unreadable is 0. */
export function percentToBasisPoints(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(10_000, Math.max(0, Math.round(percent * 100)));
}

/** An optional integer: empty is null (an open-ended depth, "no limit"). */
export function intOrNull(text: string): number | null {
  const n = Number(text);
  return text.trim() === '' || !Number.isFinite(n) ? null : Math.trunc(n);
}

/** `robotic, high_risk` → `['robotic', 'high_risk']`. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) =>
          t
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_'),
        )
        .filter((t) => t !== ''),
    ),
  ];
}

/** The issues at `prefix` exactly, or anywhere beneath it. */
export function issuesAt(issues: readonly DungeonZoneIssue[], prefix: string): DungeonZoneIssue[] {
  return issues.filter(
    (i) => i.path === prefix || i.path.startsWith(`${prefix}.`) || i.path.startsWith(`${prefix}[`),
  );
}

/** Issues the form has no field for — shown in the summary instead. */
export function issuesOutside(
  issues: readonly DungeonZoneIssue[],
  prefixes: readonly string[],
): DungeonZoneIssue[] {
  const shown = new Set(prefixes.flatMap((p) => issuesAt(issues, p)));
  return issues.filter((i) => !shown.has(i));
}

/** Nodes grouped by depth, lane 0 first — the rows a preview renders. */
export function nodesByDepth<T extends { depth: number; lane: number }>(
  nodes: readonly T[],
): T[][] {
  const rows = new Map<number, T[]>();
  for (const node of nodes) rows.set(node.depth, [...(rows.get(node.depth) ?? []), node]);
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row.sort((a, b) => a.lane - b.lane));
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ── creating a dungeon ──────────────────────────────────────────────────────

export const LAYOUT_MODE_LABELS: Record<DungeonLayoutMode, string> = {
  procedural: 'Procedural',
  authored: 'Room by room',
};

/** `Rust Warrens!` → `rust_warrens`: a usable key from what the author typed as the name. */
export function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/, '');
}

const enabledFirst = (refs: readonly DungeonContentRef[]) => [
  ...refs.filter((r) => r.enabled),
  ...refs.filter((r) => !r.enabled),
];

/** The enemy a starter dungeon ends on: one tagged as a boss, else the last listed. */
function starterBoss(enemies: readonly DungeonContentRef[]): DungeonContentRef | undefined {
  const usable = enabledFirst(enemies);
  return (
    usable.find((e) => e.tags.includes('boss') || /boss|colossus/.test(e.key)) ??
    usable.filter((e) => e.enabled).at(-1) ??
    usable.at(-1)
  );
}

export interface NewDungeonInput {
  name: string;
  key: string;
  regions: string[];
  layoutMode: DungeonLayoutMode;
}

/**
 * The starter dungeon the creation wizard saves: disabled, with just enough
 * in it to open in the editor as something that already works.
 *
 *   - procedural — one combat pool, one boss, a rest before the boss that
 *     doubles as the way out, default weights;
 *   - room by room — Start → Combat → Rest → Boss.
 */
export function starterZone(
  input: NewDungeonInput,
  // Only what a starter needs of an enemy: which exist, which are enabled, which are bosses.
  reference: { enemies: readonly DungeonContentRef[] },
): DungeonZoneDoc {
  const first = enabledFirst(reference.enemies)[0];
  const boss = starterBoss(reference.enemies);
  const base = newZone();
  const shared = {
    ...base,
    key: input.key,
    name: input.name.trim(),
    availableRegions: input.regions,
    layoutMode: input.layoutMode,
    rewards: {
      ...base.rewards,
      bands: [
        { ...newRewardBand([]), id: 'fights', currency: { min: 1, max: 3 } },
        {
          ...newRewardBand([]),
          id: 'boss',
          nodeTypes: ['boss' as const],
          currency: { min: 10, max: 10 },
        },
      ],
    },
  };
  if (input.layoutMode === 'authored') {
    const room = (
      id: string,
      name: string,
      type: DungeonNodeType,
      next: string[],
    ): DungeonRoomDoc => ({
      ...newRoom(id, type, first?.key ?? null, null),
      name,
      next,
    });
    return {
      ...shared,
      authored: {
        startRoomId: 'start',
        rooms: [
          room('start', 'Start', 'combat', ['combat']),
          room('combat', 'Combat', 'combat', ['rest']),
          { ...room('rest', 'Rest', 'rest', ['boss']), extraction: true },
          { ...room('boss', 'Boss', 'boss', []), enemyKey: boss?.key ?? null },
        ],
      },
    };
  }
  return {
    ...shared,
    authored: { startRoomId: null, rooms: [] },
    generation: {
      ...base.generation,
      minNodes: 5,
      maxNodes: 7,
      extraction: { minDepth: 3, nodeTypes: ['rest', 'exit'], minPoints: 1, windows: [] },
      // Only what the starter pools can fill: fights and rests.
      nodeWeights: { combat: 80, elite: 0, event: 0, reward: 0, rest: 20, miniboss: 0, exit: 0 },
      rest: { minNodes: 1, maxNodes: 2, minDepth: 2, maxDepth: null, beforeBoss: true },
      depthRanges: {},
      firstNodeType: null,
    },
    pools: {
      ...base.pools,
      combat: first ? [newPoolEntry('combat', first.key, [])] : [],
      boss: boss ? [newPoolEntry('boss', boss.key, [])] : [],
    },
  };
}

// ── authored rooms ──────────────────────────────────────────────────────────

export const NO_ROOMS: DungeonAuthoredLayoutDoc = { startRoomId: null, rooms: [] };

export const isFightType = (type: DungeonNodeType) =>
  type === 'combat' || type === 'elite' || type === 'miniboss' || type === 'boss';

export function newRoom(
  id: string,
  type: DungeonNodeType,
  enemyKey: string | null,
  eventKey: string | null,
): DungeonRoomDoc {
  return {
    id,
    name: '',
    type,
    next: [],
    enemyKey: isFightType(type) ? enemyKey : null,
    eventKey: type === 'event' ? eventKey : null,
    reward: null,
    healBasisPoints: null,
    extraction: false,
    backgroundAssetId: null,
    backgroundArtworkPath: null,
    scene: null,
    notes: '',
  };
}

/** What a room is called on its card: its name, else its type. */
export function roomTitle(room: Pick<DungeonRoomDoc, 'name' | 'type'>): string {
  return room.name.trim() !== '' ? room.name : NODE_TYPE_LABELS[room.type];
}

const roomId = (base: string, rooms: readonly DungeonRoomDoc[]) =>
  uniqueId(
    keyFromName(base) || 'room',
    rooms.map((r) => r.id),
  );

/** Changing a room's type drops what the new type cannot hold, and nothing else. */
export function withRoomType(
  room: DungeonRoomDoc,
  type: DungeonNodeType,
  defaults: { enemyKey: string | null; eventKey: string | null },
): DungeonRoomDoc {
  return {
    ...room,
    type,
    enemyKey: isFightType(type) ? (room.enemyKey ?? defaults.enemyKey) : null,
    eventKey: type === 'event' ? (room.eventKey ?? defaults.eventKey) : null,
    healBasisPoints: type === 'rest' ? room.healBasisPoints : null,
    scene: isFightType(type) ? room.scene : null,
    // A boss ends the dungeon: it leads nowhere and is not a way out.
    next: type === 'boss' ? [] : room.next,
    extraction: type === 'boss' ? false : room.extraction,
  };
}

const replaceRoom = (
  layout: DungeonAuthoredLayoutDoc,
  id: string,
  change: (room: DungeonRoomDoc) => DungeonRoomDoc,
): DungeonRoomDoc[] => layout.rooms.map((r) => (r.id === id ? change(r) : r));

/** Put `room` in the list right after `afterId`, so the document reads in walking order. */
function insertAfter(
  rooms: DungeonRoomDoc[],
  afterId: string,
  room: DungeonRoomDoc,
): DungeonRoomDoc[] {
  const at = rooms.findIndex((r) => r.id === afterId);
  return at < 0 ? [...rooms, room] : [...rooms.slice(0, at + 1), room, ...rooms.slice(at + 1)];
}

/**
 * The first room of an empty layout, or a room slotted in after `afterId`: it
 * takes over where that room led, and that room now leads to it. A final Boss
 * stays final — the new room goes in before it instead.
 */
export function addNextRoom(
  layout: DungeonAuthoredLayoutDoc,
  afterId: string | null,
  room: DungeonRoomDoc,
): { layout: DungeonAuthoredLayoutDoc; roomId: string } {
  const id = roomId(room.id || room.name || room.type, layout.rooms);
  const after = layout.rooms.find((r) => r.id === afterId);
  if (!after) {
    return {
      layout: {
        startRoomId: layout.startRoomId ?? id,
        rooms: [...layout.rooms, { ...room, id, next: [] }],
      },
      roomId: id,
    };
  }
  if (after.type === 'boss') {
    // Everything that led to the boss now leads to the new room, which leads to the boss.
    const rooms = layout.rooms.map((r) =>
      r.next.includes(after.id) ? { ...r, next: r.next.map((n) => (n === after.id ? id : n)) } : r,
    );
    const at = rooms.findIndex((r) => r.id === after.id);
    rooms.splice(at, 0, { ...room, id, next: [after.id] });
    return {
      layout: { startRoomId: layout.startRoomId === after.id ? id : layout.startRoomId, rooms },
      roomId: id,
    };
  }
  const rooms = replaceRoom(layout, after.id, (r) => ({ ...r, next: [id] }));
  return {
    layout: { ...layout, rooms: insertAfter(rooms, after.id, { ...room, id, next: after.next }) },
    roomId: id,
  };
}

/** Whether `fromId` can take another way on. */
export function canBranch(layout: DungeonAuthoredLayoutDoc, fromId: string): boolean {
  const from = layout.rooms.find((r) => r.id === fromId);
  return from !== undefined && from.type !== 'boss' && from.next.length < DUNGEON_MAX_ROOM_EXITS;
}

/**
 * A second (or third) way on from `fromId`. The new room rejoins where the
 * existing way on leads next, so the fork closes by itself: one room that
 * leads to A becomes a choice between A and the new room, both leading on to
 * whatever came after A.
 */
export function addBranch(
  layout: DungeonAuthoredLayoutDoc,
  fromId: string,
  room: DungeonRoomDoc,
): { layout: DungeonAuthoredLayoutDoc; roomId: string } {
  const from = layout.rooms.find((r) => r.id === fromId);
  if (!from || !canBranch(layout, fromId)) return { layout, roomId: fromId };
  const id = roomId(room.id || room.name || room.type, layout.rooms);
  const sibling = layout.rooms.find((r) => r.id === from.next[0]);
  // Beside a Boss there is nothing after to rejoin: the new room leads to the Boss itself.
  const rejoin = !sibling ? [] : sibling.type === 'boss' ? [sibling.id] : sibling.next;
  const rooms = replaceRoom(layout, fromId, (r) => ({ ...r, next: [...r.next, id] }));
  const lastSibling = [...from.next].reverse().find((n) => layout.rooms.some((r) => r.id === n));
  return {
    layout: {
      ...layout,
      rooms: insertAfter(rooms, lastSibling ?? fromId, { ...room, id, next: rejoin }),
    },
    roomId: id,
  };
}

/** A copy of a room, slotted in right after it. A copied Boss becomes a Miniboss: only one room ends the dungeon. */
export function duplicateRoom(
  layout: DungeonAuthoredLayoutDoc,
  id: string,
): { layout: DungeonAuthoredLayoutDoc; roomId: string } {
  const original = layout.rooms.find((r) => r.id === id);
  if (!original) return { layout, roomId: id };
  const copy: DungeonRoomDoc = {
    ...original,
    id: '',
    name: `${roomTitle(original)} copy`,
    type: original.type === 'boss' ? 'miniboss' : original.type,
  };
  return addNextRoom(layout, id, { ...copy, id: `${original.id}_copy` });
}

/**
 * Remove a room and close the gap: whatever led to it now leads to where it
 * led. Deleting the start room makes the room after it the start.
 */
export function deleteRoom(layout: DungeonAuthoredLayoutDoc, id: string): DungeonAuthoredLayoutDoc {
  const gone = layout.rooms.find((r) => r.id === id);
  if (!gone) return layout;
  const onward = gone.next.filter((n) => n !== id);
  const rooms = layout.rooms
    .filter((r) => r.id !== id)
    .map((r) =>
      r.next.includes(id)
        ? {
            ...r,
            next: [...new Set(r.next.flatMap((n) => (n === id ? onward : [n])))]
              .filter((n) => n !== r.id)
              .slice(0, DUNGEON_MAX_ROOM_EXITS),
          }
        : r,
    );
  const startRoomId =
    layout.startRoomId === id
      ? (onward.find((n) => rooms.some((r) => r.id === n)) ?? rooms[0]?.id ?? null)
      : layout.startRoomId;
  return { startRoomId, rooms };
}

/** Every room that leads, directly or not, to `id` — linking `id` to one of them would make a loop. */
export function roomsLeadingTo(layout: DungeonAuthoredLayoutDoc, id: string): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const room of layout.rooms) {
      if (room.next.includes(current) && !found.has(room.id)) {
        found.add(room.id);
        queue.push(room.id);
      }
    }
  }
  return found;
}

/** One line of the room outline. */
export interface RoomOutlineRow {
  room: DungeonRoomDoc;
  /** Indent level: 0 on the trunk, one deeper inside each fork. */
  indent: number;
  /** `A`, `B`, `C` — which way of a fork this room opens; null on the trunk. */
  branch: string | null;
  /** The room was already drawn above (the fork rejoined): show a pointer, not a second card. */
  rejoin: boolean;
  /** Nothing leads here from the start. */
  unreachable: boolean;
}

/**
 * The layout as an indented outline, walked from the start: the trunk at the
 * left, each way of a fork indented under the room that offers it, and a
 * pointer where ways rejoin a room already drawn. Rooms nothing leads to come
 * last. Loops and broken links cannot hang this: each room is drawn once.
 */
export function roomOutline(layout: DungeonAuthoredLayoutDoc): RoomOutlineRow[] {
  const byId = new Map(layout.rooms.map((r) => [r.id, r]));
  const nextOf = (room: DungeonRoomDoc) =>
    [...new Set(room.next)].flatMap((id) =>
      byId.has(id) && id !== room.id ? [byId.get(id)!] : [],
    );
  const rows: RoomOutlineRow[] = [];
  const drawn = new Set<string>();

  // Ways into each room from rooms the start can reach: a room with several is where a fork closes.
  const waysIn = new Map<string, number>();
  const start = layout.startRoomId === null ? undefined : byId.get(layout.startRoomId);
  if (start) {
    const seen = new Set([start.id]);
    const queue = [start];
    while (queue.length > 0) {
      for (const next of nextOf(queue.shift()!)) {
        waysIn.set(next.id, (waysIn.get(next.id) ?? 0) + 1);
        if (!seen.has(next.id)) {
          seen.add(next.id);
          queue.push(next);
        }
      }
    }
  }
  const unwalked = new Map(waysIn);

  /** Draws `room` and what follows it; returns rooms a fork is still waiting to rejoin at. */
  const walk = (room: DungeonRoomDoc, indent: number, branch: string | null): DungeonRoomDoc[] => {
    if (drawn.has(room.id)) {
      rows.push({ room, indent, branch, rejoin: true, unreachable: false });
      return [];
    }
    drawn.add(room.id);
    rows.push({ room, indent, branch, rejoin: false, unreachable: false });

    const waiting: DungeonRoomDoc[] = [];
    const visit = (child: DungeonRoomDoc, childIndent: number, letter: string | null) => {
      unwalked.set(child.id, (unwalked.get(child.id) ?? 1) - 1);
      const closesFork = (waysIn.get(child.id) ?? 1) > 1 && childIndent > 0 && !drawn.has(child.id);
      if (closesFork) {
        // Inside a fork, a shared room is only pointed at; it is drawn once, where the fork closes.
        rows.push({
          room: child,
          indent: childIndent,
          branch: letter,
          rejoin: true,
          unreachable: false,
        });
        waiting.push(child);
      } else waiting.push(...walk(child, childIndent, letter));
    };
    const next = nextOf(room);
    if (next.length === 1) visit(next[0]!, indent, null);
    else next.forEach((child, i) => visit(child, indent + 1, String.fromCharCode(65 + i)));

    // Only the room that forks closes the fork: a room on one of its branches passes the wait up.
    if (next.length <= 1) return [...new Set(waiting)];
    const stillWaiting: DungeonRoomDoc[] = [];
    for (const shared of new Set(waiting)) {
      if (drawn.has(shared.id)) continue;
      // Every way in has been walked (or this is the trunk): the fork closes here.
      if (indent === 0 || (unwalked.get(shared.id) ?? 0) <= 0)
        stillWaiting.push(...walk(shared, indent, null));
      else stillWaiting.push(shared);
    }
    return stillWaiting;
  };

  if (start) for (const left of walk(start, 0, null)) if (!drawn.has(left.id)) walk(left, 0, null);
  for (const room of layout.rooms) {
    if (!drawn.has(room.id)) {
      drawn.add(room.id);
      rows.push({ room, indent: 0, branch: null, rejoin: false, unreachable: true });
    }
  }
  return rows;
}

/** The index of the room an issue path names (`authored.rooms[3].next` → 3), or null. */
export function issueRoomIndex(path: string): number | null {
  const match = /^authored\.rooms\[(\d+)\]/.exec(path);
  return match ? Number(match[1]) : null;
}

/** `8 rooms` for a room-by-room dungeon, `6–9 rooms` for a generated one. */
export function zoneSize(zone: DungeonZoneSummary): string {
  if (layoutModeOf(zone) === 'authored') {
    const rooms = zone.roomCount ?? zone.maxNodes;
    return `${rooms} room${rooms === 1 ? '' : 's'}`;
  }
  return zone.minNodes === zone.maxNodes
    ? `${zone.minNodes} rooms`
    : `${zone.minNodes}–${zone.maxNodes} rooms`;
}
