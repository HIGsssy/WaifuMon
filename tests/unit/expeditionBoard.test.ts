/**
 * Board rotation. Pure — no DB, no stored rotation state.
 *
 * The board is derived rather than stored, so the properties worth testing are
 * properties of a *function*: same inputs, same board; different window,
 * different board; different player, different board. If those three hold,
 * there is nothing to drift and nothing to recover after a restart.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBoard,
  orderBoardForDisplay,
  rotationEndsAt,
  rotationWindow,
} from '../../src/modules/expeditions/expeditionBoard';
import {
  ExpeditionDefinitionSchema,
  type RegionalExpedition,
} from '../../src/modules/content/schemas';

function expedition(key: string, over: Record<string, unknown> = {}): RegionalExpedition {
  // `region` belongs to the *file*, not the definition — and the definition
  // schema is `.strict()`, so it has to be lifted out before parsing rather
  // than spread in with the rest.
  const { region = 'thirstlands', ...definitionOver } = over;
  return {
    ...ExpeditionDefinitionSchema.parse({
      key,
      name: key,
      type: 'supply_run',
      durationMinutes: 360,
      recommendedLevel: 10,
      baseSuccessChance: 0.5,
      rewardTable: 't',
      ...definitionOver,
    }),
    region: region as RegionalExpedition['region'],
  };
}

/** Ten missions, so a board of four is a genuine selection. */
const POOL = Array.from({ length: 10 }, (_, i) => expedition(`mission_${i}`));

const build = (over: Partial<Parameters<typeof buildBoard>[0]> = {}) =>
  buildBoard({
    playerId: 1,
    regionId: 'thirstlands',
    expeditions: POOL,
    boardSize: 4,
    rotationHours: 12,
    now: new Date('2026-09-21T03:00:00Z'),
    ...over,
  });

const keys = (board: RegionalExpedition[]) => board.map((e) => e.key);

describe('rotationWindow', () => {
  it('is stable across a window and changes at the boundary', () => {
    const early = new Date('2026-09-21T00:00:00Z');
    const late = new Date('2026-09-21T11:59:59Z');
    const next = new Date('2026-09-21T12:00:00Z');
    expect(rotationWindow(early, 12)).toBe(rotationWindow(late, 12));
    expect(rotationWindow(next, 12)).toBe(rotationWindow(early, 12) + 1);
  });

  it('follows the configured window length', () => {
    const a = new Date('2026-09-21T00:00:00Z');
    const b = new Date('2026-09-21T05:00:00Z');
    // Same 12-hour window, different 4-hour ones.
    expect(rotationWindow(a, 12)).toBe(rotationWindow(b, 12));
    expect(rotationWindow(a, 4)).not.toBe(rotationWindow(b, 4));
  });
});

describe('rotationEndsAt', () => {
  it('lands on the next boundary', () => {
    expect(rotationEndsAt(new Date('2026-09-21T03:00:00Z'), 12).toISOString()).toBe(
      '2026-09-21T12:00:00.000Z',
    );
    expect(rotationEndsAt(new Date('2026-09-21T13:00:00Z'), 12).toISOString()).toBe(
      '2026-09-22T00:00:00.000Z',
    );
  });

  it('is always in the future', () => {
    const at = new Date('2026-09-21T11:59:59Z');
    expect(rotationEndsAt(at, 12).getTime()).toBeGreaterThan(at.getTime());
  });
});

describe('buildBoard', () => {
  it('returns exactly boardSize missions when the pool is larger', () => {
    expect(build()).toHaveLength(4);
  });

  it('returns the whole pool when it is smaller than boardSize', () => {
    const small = [expedition('only_one')];
    expect(keys(build({ expeditions: small }))).toEqual(['only_one']);
  });

  it('returns an empty board for a region with no content — not an error', () => {
    expect(build({ regionId: 'waifu-valley' })).toEqual([]);
  });

  it('never repeats a mission', () => {
    const board = keys(build());
    expect(new Set(board).size).toBe(board.length);
  });

  it('omits a disabled mission', () => {
    const pool = [...POOL, expedition('switched_off', { enabled: false })];
    // Every board drawn from this pool, at any window, must exclude it.
    for (let hour = 0; hour < 48; hour += 3) {
      const board = keys(
        build({
          expeditions: pool,
          boardSize: 99,
          now: new Date(Date.UTC(2026, 8, 21, hour)),
        }),
      );
      expect(board).not.toContain('switched_off');
    }
  });

  it('omits missions belonging to another region', () => {
    const pool = [...POOL, expedition('elsewhere', { region: 'twin-peeks' })];
    expect(keys(build({ expeditions: pool, boardSize: 99 }))).not.toContain('elsewhere');
  });
});

describe('determinism', () => {
  /**
   * The property the whole "derived, not stored" design rests on. A player who
   * opens the screen, closes it and opens it again must see the same board —
   * otherwise reopening becomes a reroll, and the board becomes something to
   * farm rather than something to choose from.
   */
  it('gives the same board for the same inputs, every time', () => {
    const first = keys(build());
    for (let i = 0; i < 20; i += 1) expect(keys(build())).toEqual(first);
  });

  it('is stable at any moment inside one rotation window', () => {
    const atStart = keys(build({ now: new Date('2026-09-21T00:00:00Z') }));
    const atEnd = keys(build({ now: new Date('2026-09-21T11:59:59Z') }));
    expect(atEnd).toEqual(atStart);
  });

  it('changes at the window boundary and not before', () => {
    const before = keys(build({ now: new Date('2026-09-21T11:59:59Z') }));
    const after = keys(build({ now: new Date('2026-09-21T12:00:00Z') }));
    expect(after).not.toEqual(before);
  });

  /**
   * Per-player rather than global. A shared board makes the good mission a
   * race won by whoever happened to be online; a per-player one means nobody's
   * board is evidence about anybody else's.
   */
  it('gives two players in one region different boards', () => {
    const a = keys(build({ playerId: 1 }));
    const b = keys(build({ playerId: 2 }));
    expect(b).not.toEqual(a);
  });

  it('gives one player different boards in different regions', () => {
    const pool = [
      ...POOL,
      ...Array.from({ length: 10 }, (_, i) => expedition(`tp_${i}`, { region: 'twin-peeks' })),
    ];
    const here = keys(build({ expeditions: pool, regionId: 'thirstlands' }));
    const there = keys(build({ expeditions: pool, regionId: 'twin-peeks' }));
    expect(here).not.toEqual(there);
  });

  it('orders totally, so two missions are never ambiguously ranked', () => {
    // A board of the whole pool must still be a stable permutation.
    const full = keys(build({ boardSize: 99 }));
    expect(full).toHaveLength(POOL.length);
    expect(keys(build({ boardSize: 99 }))).toEqual(full);
  });

  it('reshuffles everything when the salt changes', () => {
    const shipped = keys(build());
    const resalted = keys(build({ salt: 'waifumon.expedition.board.v2' }));
    expect(resalted).not.toEqual(shipped);
  });
});

describe('fairness', () => {
  /**
   * Every mission should be reachable. A hash-and-sort that quietly favoured
   * some keys would produce a pool where a few missions simply never appear —
   * content nobody can ever play, and nothing would say so.
   */
  it('shows every mission in the pool to somebody, eventually', () => {
    const seen = new Set<string>();
    for (let playerId = 1; playerId <= 200; playerId += 1) {
      for (const key of keys(build({ playerId }))) seen.add(key);
    }
    expect(seen.size).toBe(POOL.length);
  });

  it('spreads appearances roughly evenly across a large sample', () => {
    const counts = new Map<string, number>();
    const players = 2000;
    for (let playerId = 1; playerId <= players; playerId += 1) {
      for (const key of keys(build({ playerId }))) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    // 4 of 10 slots => each mission expected on 40% of boards. A wide band:
    // this asserts no mission is starved or dominant, not that md5 is uniform.
    for (const [, count] of counts) {
      expect(count / players).toBeGreaterThan(0.3);
      expect(count / players).toBeLessThan(0.5);
    }
  });
});

describe('orderBoardForDisplay', () => {
  const TIERS = [60, 180, 360, 1080];
  // Durations assigned so the hash order and the duration order disagree.
  const MIXED = [
    expedition('zeta', { durationMinutes: 1080 }),
    expedition('alpha', { durationMinutes: 360 }),
    expedition('mu', { durationMinutes: 60 }),
    expedition('beta', { durationMinutes: 180 }),
    expedition('gamma', { durationMinutes: 360 }),
  ];

  it('lays the board out shortest first, whatever order it was selected in', () => {
    const shown = orderBoardForDisplay([...MIXED].reverse());
    expect(shown.map((e) => e.durationMinutes)).toEqual([60, 180, 360, 360, 1080]);
  });

  it('breaks a duration tie on the key', () => {
    const shown = orderBoardForDisplay(MIXED);
    expect(keys(shown)).toEqual(['mu', 'beta', 'alpha', 'gamma', 'zeta']);
  });

  it('does not mutate its input', () => {
    const input = [...MIXED];
    orderBoardForDisplay(input);
    expect(keys(input)).toEqual(keys(MIXED));
  });

  /**
   * Presentation must not leak back into selection: the set a window shows is
   * decided by the hash sort alone, and re-ordering it cannot add or drop one.
   */
  it('changes the order of a board but never its membership', () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      expedition(`mission_${i}`, { durationMinutes: TIERS[i % TIERS.length] }),
    );
    for (let playerId = 1; playerId <= 50; playerId += 1) {
      const selected = build({ playerId, expeditions: pool });
      const shown = orderBoardForDisplay(selected);
      expect(new Set(keys(shown))).toEqual(new Set(keys(selected)));
      const minutes = shown.map((e) => e.durationMinutes);
      expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
      // And the same inputs still produce the same board.
      expect(keys(orderBoardForDisplay(build({ playerId, expeditions: pool })))).toEqual(keys(shown));
    }
  });
});
