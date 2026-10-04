import { describe, expect, it } from 'vitest';

import type { DungeonZoneIssue } from '@/api/adminDungeons';
import {
  basisPointsToPercent,
  intOrNull,
  issuesAt,
  issuesOutside,
  newPoolEntry,
  newRewardBand,
  newZone,
  nodesByDepth,
  parseTags,
  percentToBasisPoints,
  NO_ROOMS,
  addBranch,
  addNextRoom,
  canBranch,
  deleteRoom,
  duplicateRoom,
  issueRoomIndex,
  keyFromName,
  newRoom,
  roomOutline,
  roomsLeadingTo,
  starterZone,
  withRoomType,
  zoneSize,
} from '../dungeonModel';
import type {
  DungeonAuthoredLayoutDoc,
  DungeonRoomDoc,
  DungeonZoneSummary,
} from '@/api/adminDungeons';

describe('percent ↔ basis points', () => {
  it('shows basis points as the percentage a human expects', () => {
    expect(basisPointsToPercent(2500)).toBe(25);
    expect(basisPointsToPercent(3333)).toBe(33.33);
    expect(basisPointsToPercent(0)).toBe(0);
    expect(basisPointsToPercent(10_000)).toBe(100);
  });

  it('stores a typed percentage as basis points, clamped to 0–100%', () => {
    expect(percentToBasisPoints(25)).toBe(2500);
    expect(percentToBasisPoints(12.5)).toBe(1250);
    expect(percentToBasisPoints(33.33)).toBe(3333);
    expect(percentToBasisPoints(250)).toBe(10_000);
    expect(percentToBasisPoints(-5)).toBe(0);
    expect(percentToBasisPoints(Number.NaN)).toBe(0);
  });

  it('round-trips every whole basis point', () => {
    for (const bp of [0, 1, 99, 2500, 4999, 10_000])
      expect(percentToBasisPoints(basisPointsToPercent(bp))).toBe(bp);
  });
});

describe('inputs', () => {
  it('reads an optional integer, where empty means none', () => {
    expect(intOrNull('')).toBeNull();
    expect(intOrNull('  ')).toBeNull();
    expect(intOrNull('4')).toBe(4);
  });

  it('normalises a comma list of tags to unique snake_case keys', () => {
    expect(parseTags('Robotic, high risk, robotic,, high-risk ,')).toEqual([
      'robotic',
      'high_risk',
    ]);
    expect(parseTags('')).toEqual([]);
  });
});

describe('new documents', () => {
  it('starts a zone disabled, with a boss required and the default currency', () => {
    const zone = newZone();
    expect(zone).toMatchObject({
      key: '',
      enabled: false,
      rewards: { currencyKey: 'ascension_currency' },
    });
    expect(zone.generation.boss.required).toBe(true);
    expect(zone.generation.minNodes).toBeLessThanOrEqual(zone.generation.maxNodes);
  });

  it('gives a new pool entry the right reference field and an id no other entry has', () => {
    const first = newPoolEntry('combat', 'scrapyard_drone', []);
    expect(first).toMatchObject({
      id: 'scrapyard_drone',
      enemyKey: 'scrapyard_drone',
      enabled: true,
      maxDepth: null,
    });
    expect(first).not.toHaveProperty('eventKey');
    const second = newPoolEntry('combat', 'scrapyard_drone', [first]);
    expect(second.id).toBe('scrapyard_drone_2');
    expect(newPoolEntry('combat', 'scrapyard_drone', [first, second]).id).toBe('scrapyard_drone_3');
    expect(newPoolEntry('event', 'shrine', [])).toMatchObject({ eventKey: 'shrine' });
  });

  it('gives a new band a unique id and no rewards', () => {
    const band = newRewardBand([]);
    expect(band).toMatchObject({
      id: 'band',
      nodeTypes: [],
      rewardTable: null,
      currency: { min: 0, max: 0 },
    });
    expect(newRewardBand([band]).id).toBe('band_2');
  });
});

describe('issue routing', () => {
  const issue = (path: string): DungeonZoneIssue => ({ path, message: path, severity: 'error' });
  const issues = [
    issue('generation'),
    issue('generation.minNodes'),
    issue('pools.combat[1].enemyKey'),
    issue('pools.combat[10].weight'),
    issue('pools.boss'),
    issue('zone'),
  ];

  it('matches a path and everything beneath it, without matching a longer index', () => {
    expect(issuesAt(issues, 'pools.combat[1]').map((i) => i.path)).toEqual([
      'pools.combat[1].enemyKey',
    ]);
    expect(issuesAt(issues, 'pools.combat').map((i) => i.path)).toEqual([
      'pools.combat[1].enemyKey',
      'pools.combat[10].weight',
    ]);
    expect(issuesAt(issues, 'generation').map((i) => i.path)).toEqual([
      'generation',
      'generation.minNodes',
    ]);
    expect(issuesAt(issues, 'pools.boss').map((i) => i.path)).toEqual(['pools.boss']);
  });

  it('finds the issues no section shows', () => {
    expect(issuesOutside(issues, ['generation', 'pools']).map((i) => i.path)).toEqual(['zone']);
  });
});

describe('nodesByDepth', () => {
  it('groups nodes into depth rows, lane 0 first', () => {
    const nodes = [
      { id: 'n3', depth: 2, lane: 1 },
      { id: 'n1', depth: 1, lane: 0 },
      { id: 'n2', depth: 2, lane: 0 },
      { id: 'n4', depth: 3, lane: 0 },
    ];
    expect(nodesByDepth(nodes).map((row) => row.map((n) => n.id))).toEqual([
      ['n1'],
      ['n2', 'n3'],
      ['n4'],
    ]);
  });
});

describe('creating a dungeon', () => {
  const enemies = [
    { key: 'scrapyard_drone', name: 'Scrapyard Drone', enabled: true, tags: [] },
    { key: 'retired_unit', name: 'Retired Unit', enabled: false, tags: [] },
    { key: 'scrapheap_colossus', name: 'Scrapheap Colossus', enabled: true, tags: ['boss'] },
  ];

  it('makes a key from a name', () => {
    expect(keyFromName('Rust Warrens!')).toBe('rust_warrens');
    expect(keyFromName('  Base 80085 — Lab  ')).toBe('base_80085_lab');
    expect(keyFromName('???')).toBe('');
  });

  it('starts a procedural dungeon with one combat pool, one boss, a rest and a way out', () => {
    const zone = starterZone(
      {
        name: ' Rust Warrens ',
        key: 'rust_warrens',
        regions: ['waifu-valley'],
        layoutMode: 'procedural',
      },
      { enemies },
    );
    expect(zone).toMatchObject({ name: 'Rust Warrens', enabled: false, layoutMode: 'procedural' });
    expect(zone.pools.combat.map((e) => e.enemyKey)).toEqual(['scrapyard_drone']);
    expect(zone.pools.boss.map((e) => e.enemyKey)).toEqual(['scrapheap_colossus']);
    // Only what those pools can fill is weighted.
    expect(zone.generation.nodeWeights).toMatchObject({
      combat: 80,
      rest: 20,
      elite: 0,
      event: 0,
      reward: 0,
    });
    expect(zone.generation.rest).toMatchObject({ beforeBoss: true });
    expect(zone.generation.extraction.nodeTypes).toContain('rest');
    expect(zone.authored).toEqual(NO_ROOMS);
  });

  it('starts a room-by-room dungeon as Start → Combat → Rest → Boss', () => {
    const zone = starterZone(
      {
        name: 'Rust Warrens',
        key: 'rust_warrens',
        regions: ['waifu-valley'],
        layoutMode: 'authored',
      },
      { enemies },
    );
    const rooms = zone.authored!.rooms;
    expect(rooms.map((r) => `${r.name}:${r.type}`)).toEqual([
      'Start:combat',
      'Combat:combat',
      'Rest:rest',
      'Boss:boss',
    ]);
    expect(rooms.map((r) => r.enemyKey)).toEqual([
      'scrapyard_drone',
      'scrapyard_drone',
      null,
      'scrapheap_colossus',
    ]);
    expect(rooms[2]!.extraction).toBe(true);
    expect(roomOutline(zone.authored!).every((row) => !row.unreachable && !row.rejoin)).toBe(true);
  });
});

describe('room layout editing', () => {
  const r = (id: string, type: DungeonRoomDoc['type'], next: string[]): DungeonRoomDoc => ({
    ...newRoom(id, type, 'grunt', 'shrine'),
    name: id,
    next,
  });
  /** a → b → (c | d) → e → boss */
  const forked = (): DungeonAuthoredLayoutDoc => ({
    startRoomId: 'a',
    rooms: [
      r('a', 'combat', ['b']),
      r('b', 'rest', ['c', 'd']),
      r('c', 'elite', ['e']),
      r('d', 'reward', ['e']),
      r('e', 'rest', ['boss']),
      r('boss', 'boss', []),
    ],
  });
  const next = (layout: DungeonAuthoredLayoutDoc, id: string) =>
    layout.rooms.find((x) => x.id === id)!.next;
  const outline = (layout: DungeonAuthoredLayoutDoc) =>
    roomOutline(layout).map(
      (row) =>
        `${'  '.repeat(row.indent)}${row.branch ? `${row.branch}:` : ''}${row.rejoin ? '>' : ''}${row.room.id}${row.unreachable ? '!' : ''}`,
    );

  it('outlines a fork with its branches indented and the rejoin drawn once, back on the trunk', () => {
    expect(outline(forked())).toEqual(['a', 'b', '  A:c', '  >e', '  B:d', '  >e', 'e', 'boss']);
  });

  it('outlines a fork whose branches have different lengths, and one nested in another', () => {
    const uneven: DungeonAuthoredLayoutDoc = {
      startRoomId: 'a',
      rooms: [
        r('a', 'combat', ['long', 'short']),
        r('long', 'combat', ['long2']),
        r('long2', 'combat', ['boss']),
        r('short', 'rest', ['boss']),
        r('boss', 'boss', []),
      ],
    };
    expect(outline(uneven)).toEqual([
      'a',
      '  A:long',
      '  long2',
      '  >boss',
      '  B:short',
      '  >boss',
      'boss',
    ]);

    const nested: DungeonAuthoredLayoutDoc = {
      startRoomId: 'a',
      rooms: [
        r('a', 'combat', ['b', 'c']),
        r('b', 'combat', ['d', 'e']),
        r('d', 'rest', ['j']),
        r('e', 'rest', ['j']),
        r('c', 'rest', ['j']),
        r('j', 'rest', ['boss']),
        r('boss', 'boss', []),
      ],
    };
    // The shared room waits for every way into it, then is drawn once at the outer fork's level.
    expect(outline(nested)).toEqual([
      'a',
      '  A:b',
      '    A:d',
      '    >j',
      '    B:e',
      '    >j',
      '  B:c',
      '  >j',
      'j',
      'boss',
    ]);
  });

  it('lists rooms nothing leads to last, and survives a loop and a broken link without hanging', () => {
    const broken: DungeonAuthoredLayoutDoc = {
      startRoomId: 'a',
      rooms: [r('a', 'combat', ['b']), r('b', 'combat', ['a', 'gone']), r('lost', 'reward', [])],
    };
    expect(outline(broken)).toEqual(['a', 'b', '>a', 'lost!']);
    expect(outline({ startRoomId: null, rooms: [r('x', 'combat', [])] })).toEqual(['x!']);
  });

  it('adds a next room between a room and where it led, and the first room of an empty layout as the start', () => {
    const added = addNextRoom(forked(), 'a', newRoom('', 'combat', 'grunt', null));
    expect(next(added.layout, 'a')).toEqual([added.roomId]);
    expect(next(added.layout, added.roomId)).toEqual(['b']);
    expect(added.layout.rooms.map((x) => x.id).indexOf(added.roomId)).toBe(1);

    const first = addNextRoom(NO_ROOMS, null, newRoom('', 'combat', 'grunt', null));
    expect(first.layout).toMatchObject({
      startRoomId: first.roomId,
      rooms: [{ id: 'combat', next: [] }],
    });
  });

  it('adds a room before a Boss rather than after it, keeping the Boss final', () => {
    const added = addNextRoom(forked(), 'boss', newRoom('', 'rest', null, null));
    expect(next(added.layout, 'e')).toEqual([added.roomId]);
    expect(next(added.layout, added.roomId)).toEqual(['boss']);
    expect(next(added.layout, 'boss')).toEqual([]);
  });

  it('adds a branch that rejoins after its sibling — or at the Boss, beside the room before it', () => {
    const added = addBranch(forked(), 'a', newRoom('', 'event', null, 'shrine'));
    expect(next(added.layout, 'a')).toEqual(['b', added.roomId]);
    expect(next(added.layout, added.roomId)).toEqual(['c', 'd']);

    const besideBoss = addBranch(forked(), 'e', newRoom('', 'reward', null, null));
    expect(next(besideBoss.layout, 'e')).toEqual(['boss', besideBoss.roomId]);
    expect(next(besideBoss.layout, besideBoss.roomId)).toEqual(['boss']);
  });

  it('stops branching at three ways on, and never from a Boss', () => {
    const layout = forked();
    expect(canBranch(layout, 'b')).toBe(true);
    const three = addBranch(layout, 'b', newRoom('', 'combat', 'grunt', null)).layout;
    expect(canBranch(three, 'b')).toBe(false);
    expect(addBranch(three, 'b', newRoom('', 'combat', 'grunt', null)).layout).toBe(three);
    expect(canBranch(layout, 'boss')).toBe(false);
  });

  it('duplicates a room after itself with a fresh id — and a Boss as a Miniboss before it', () => {
    const copied = duplicateRoom(forked(), 'e');
    const copy = copied.layout.rooms.find((x) => x.id === copied.roomId)!;
    expect(copy).toMatchObject({ id: 'e_copy', name: 'e copy', type: 'rest', next: ['boss'] });
    expect(next(copied.layout, 'e')).toEqual(['e_copy']);

    const boss = duplicateRoom(forked(), 'boss');
    const second = boss.layout.rooms.find((x) => x.id === boss.roomId)!;
    expect(second).toMatchObject({ type: 'miniboss', enemyKey: 'grunt', next: ['boss'] });
    expect(boss.layout.rooms.filter((x) => x.type === 'boss')).toHaveLength(1);
  });

  it('deletes a room by splicing its ways on into whatever led to it', () => {
    const gone = deleteRoom(forked(), 'b');
    expect(next(gone, 'a')).toEqual(['c', 'd']);
    expect(gone.rooms.map((x) => x.id)).toEqual(['a', 'c', 'd', 'e', 'boss']);
    // Deleting one side of a fork leaves the other; deleting the start promotes the next room.
    expect(next(deleteRoom(forked(), 'c'), 'b')).toEqual(['e', 'd']);
    expect(deleteRoom(forked(), 'a').startRoomId).toBe('b');
    expect(deleteRoom({ startRoomId: 'x', rooms: [r('x', 'boss', [])] }, 'x')).toEqual(NO_ROOMS);
  });

  it('knows which rooms lead to a room, so a link back to one of them is never offered', () => {
    expect([...roomsLeadingTo(forked(), 'e')].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...roomsLeadingTo(forked(), 'a')]).toEqual([]);
  });

  it('changing a type keeps what still applies and drops what does not', () => {
    const rest = { ...r('x', 'rest', ['y']), healBasisPoints: 2000, extraction: true };
    const fight = withRoomType(rest, 'combat', { enemyKey: 'grunt', eventKey: 'shrine' });
    expect(fight).toMatchObject({
      type: 'combat',
      enemyKey: 'grunt',
      healBasisPoints: null,
      extraction: true,
      next: ['y'],
    });
    // A Boss ends the dungeon: no way on, no extraction.
    expect(withRoomType(fight, 'boss', { enemyKey: null, eventKey: null })).toMatchObject({
      type: 'boss',
      enemyKey: 'grunt',
      next: [],
      extraction: false,
    });
  });

  it('reads the room an issue is about off its path, and sizes a dungeon for the list', () => {
    expect(issueRoomIndex('authored.rooms[3].next')).toBe(3);
    expect(issueRoomIndex('authored.rooms')).toBeNull();
    expect(issueRoomIndex('pools.combat[3]')).toBeNull();
    const summary = {
      layoutMode: 'authored',
      roomCount: 8,
      minNodes: 7,
      maxNodes: 7,
    } as DungeonZoneSummary;
    expect(zoneSize(summary)).toBe('8 rooms');
    expect(
      zoneSize({ ...summary, layoutMode: 'procedural', roomCount: null, minNodes: 6, maxNodes: 9 }),
    ).toBe('6–9 rooms');
    expect(zoneSize({ minNodes: 5, maxNodes: 5 } as DungeonZoneSummary)).toBe('5 rooms');
  });
});
