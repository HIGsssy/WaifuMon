/**
 * Board rotation. Pure — no DB, no stored rotation state.
 *
 * The board is derived rather than stored, so the properties worth testing are
 * properties of a *function*: same inputs, same board; different window,
 * different board; different player, different board. If those three hold,
 * there is nothing to drift and nothing to recover after a restart.
 *
 * Since the draw became duration-stratified there is a fourth property, and it
 * is the one the change exists for: a board always offers every commitment
 * length the content author configured. Under the old uniform draw that was
 * left to chance, and a player looking for an overnight mission found none on
 * roughly 38% of boards.
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
import { ConfigError, IncompleteExpeditionPoolError } from '../../src/shared/errors';

/** The shipped ladder, shortest first. */
const TIERS = [60, 180, 360, 1080] as const;

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

/**
 * Twelve missions, three on every tier — so one slot per tier is a genuine
 * selection rather than a foregone conclusion, and Waifu Valley's real shape
 * (2–4 per tier) sits inside what these tests cover.
 */
const POOL = TIERS.flatMap((minutes, tier) =>
  Array.from({ length: 3 }, (_, i) =>
    expedition(`mission_t${tier}_${i}`, { durationMinutes: minutes }),
  ),
);

const build = (over: Partial<Parameters<typeof buildBoard>[0]> = {}) =>
  buildBoard({
    playerId: 1,
    regionId: 'thirstlands',
    expeditions: POOL,
    durations: TIERS,
    boardSize: 4,
    rotationHours: 12,
    now: new Date('2026-09-21T03:00:00Z'),
    ...over,
  });

const keys = (board: RegionalExpedition[]) => board.map((e) => e.key);
const minutes = (board: RegionalExpedition[]) => board.map((e) => e.durationMinutes);
const windowAt = (hoursFromEpochStart: number) =>
  new Date(Date.UTC(2026, 8, 21, 0) + hoursFromEpochStart * 3600_000);

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

/**
 * The guarantee the stratified draw exists to make. Every assertion here is
 * about *which tiers* a board carries, never about which mission — the choice
 * within a tier is the rotation's business and is covered further down.
 */
describe('duration coverage', () => {
  it('puts exactly one mission from each tier on a boardSize-4 board', () => {
    expect(minutes(build())).toEqual([...TIERS]);
  });

  /**
   * The old failure mode, stated as a test. Under the uniform draw this held
   * for only ~62% of (player, window) pairs; it must now hold for all of them.
   */
  it('never omits a tier, for any player, in any window', () => {
    for (let playerId = 1; playerId <= 150; playerId += 1) {
      for (let w = 0; w < 6; w += 1) {
        const board = build({ playerId, now: windowAt(w * 12 + 3) });
        expect(minutes(board)).toEqual([...TIERS]);
      }
    }
  });

  it('reads the ladder from the config rather than assuming four tiers', () => {
    const twoTier = [
      ...Array.from({ length: 3 }, (_, i) => expedition(`s_${i}`, { durationMinutes: 60 })),
      ...Array.from({ length: 3 }, (_, i) => expedition(`l_${i}`, { durationMinutes: 360 })),
    ];
    const board = build({ expeditions: twoTier, durations: [60, 360], boardSize: 2 });
    expect(minutes(board)).toEqual([60, 360]);
  });

  it('accepts a ladder listed out of order and still lays it out shortest first', () => {
    expect(minutes(build({ durations: [1080, 60, 360, 180] }))).toEqual([...TIERS]);
  });

  /**
   * A board larger than the ladder spends its surplus on the *shortest* tiers,
   * because an extra 1h option gets used several times a day and an extra
   * overnight one at most once.
   */
  it('spends surplus slots on the shortest tiers first', () => {
    expect(minutes(build({ boardSize: 6 }))).toEqual([60, 60, 180, 180, 360, 1080]);
  });
});

describe('buildBoard', () => {
  it('returns exactly boardSize missions when every tier has spares', () => {
    expect(build()).toHaveLength(4);
  });

  it('returns one per tier when the pool is exactly one per tier', () => {
    const minimal = TIERS.map((m, i) => expedition(`only_${i}`, { durationMinutes: m }));
    expect(keys(build({ expeditions: minimal }))).toEqual([
      'only_0',
      'only_1',
      'only_2',
      'only_3',
    ]);
  });

  it('returns an empty board for a region with no content — not an error', () => {
    expect(build({ regionId: 'waifu-valley' })).toEqual([]);
  });

  it('never repeats a mission', () => {
    const board = keys(build());
    expect(new Set(board).size).toBe(board.length);
  });

  it('omits a disabled mission', () => {
    const pool = [...POOL, expedition('switched_off', { durationMinutes: 60, enabled: false })];
    // Every board drawn from this pool, at any window, must exclude it.
    for (let hour = 0; hour < 48; hour += 3) {
      const board = keys(build({ expeditions: pool, boardSize: 99, now: windowAt(hour) }));
      expect(board).not.toContain('switched_off');
    }
  });

  it('omits missions belonging to another region', () => {
    const pool = [...POOL, expedition('elsewhere', { durationMinutes: 60, region: 'twin-peeks' })];
    expect(keys(build({ expeditions: pool, boardSize: 99 }))).not.toContain('elsewhere');
  });
});

/**
 * An incomplete pool is a content bug, and it must say so.
 *
 * A short board is the one failure mode a player cannot distinguish from
 * correct behaviour — "there is no overnight mission tonight" looks exactly
 * like "this region has no overnight missions at all". `validateExpeditionContent`
 * refuses the condition at boot; these assert that the draw itself refuses it
 * too, rather than trusting the loader to have run.
 */
describe('an incomplete regional pool', () => {
  const missingOvernight = POOL.filter((e) => e.durationMinutes !== 1080);

  it('throws rather than returning a board with a tier missing', () => {
    expect(() => build({ expeditions: missingOvernight })).toThrow(IncompleteExpeditionPoolError);
  });

  it('names the region and the missing tiers', () => {
    try {
      build({ expeditions: missingOvernight });
      expect.unreachable('expected an IncompleteExpeditionPoolError');
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteExpeditionPoolError);
      const e = error as IncompleteExpeditionPoolError;
      expect(e.regionId).toBe('thirstlands');
      expect(e.missingDurations).toEqual([1080]);
      expect(e.message).toContain('1080');
    }
  });

  it('reports every missing tier at once, not just the first', () => {
    const shortOnly = POOL.filter((e) => e.durationMinutes === 60);
    try {
      build({ expeditions: shortOnly });
      expect.unreachable('expected an IncompleteExpeditionPoolError');
    } catch (error) {
      expect((error as IncompleteExpeditionPoolError).missingDurations).toEqual([180, 360, 1080]);
    }
  });

  // A region nobody has authored yet is not "incomplete", it is absent — and
  // that is the shipped state of every region but Waifu Valley.
  it('stays silent for a region with no missions at all', () => {
    expect(build({ expeditions: [], regionId: 'thirstlands' })).toEqual([]);
  });

  // A tier whose only mission is switched off is a gap, not a tier: the board
  // cannot show a disabled mission, so the promise is broken either way.
  it('treats a tier whose missions are all disabled as missing', () => {
    const pool = POOL.map((e) =>
      e.durationMinutes === 1080 ? { ...e, enabled: false } : e,
    );
    expect(() => build({ expeditions: pool })).toThrow(IncompleteExpeditionPoolError);
  });

  it('refuses a board too small to carry one mission per tier', () => {
    expect(() => build({ boardSize: 3 })).toThrow(ConfigError);
    expect(() => build({ boardSize: 3 })).toThrow(/below the number of duration tiers/);
  });

  it('refuses an empty duration ladder', () => {
    expect(() => build({ durations: [] })).toThrow(ConfigError);
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
    const atMiddle = keys(build({ now: new Date('2026-09-21T06:17:43Z') }));
    const atEnd = keys(build({ now: new Date('2026-09-21T11:59:59Z') }));
    expect(atMiddle).toEqual(atStart);
    expect(atEnd).toEqual(atStart);
  });

  /**
   * Stability has to survive the stratification: the tier a mission sits in
   * must not depend on anything that moves during a window.
   */
  it('holds every player steady across a whole window', () => {
    for (let playerId = 1; playerId <= 60; playerId += 1) {
      const atStart = keys(build({ playerId, now: new Date('2026-09-21T00:00:00Z') }));
      const atEnd = keys(build({ playerId, now: new Date('2026-09-21T11:59:59Z') }));
      expect(atEnd).toEqual(atStart);
    }
  });

  it('changes at the window boundary and not before', () => {
    const before = keys(build({ now: new Date('2026-09-21T11:59:59Z') }));
    const after = keys(build({ now: new Date('2026-09-21T12:00:00Z') }));
    expect(after).not.toEqual(before);
  });

  /**
   * Rotation must actually rotate. With three missions per tier, a single
   * boundary could coincidentally redraw the same four; what cannot happen
   * over many windows is the board standing still.
   */
  it('works through the alternatives on every tier as windows pass', () => {
    const seenPerTier = TIERS.map(() => new Set<string>());
    for (let w = 0; w < 60; w += 1) {
      const board = build({ now: windowAt(w * 12 + 1) });
      board.forEach((mission, tier) => seenPerTier[tier]!.add(mission.key));
    }
    // Every mission on every tier must come up, not merely more than one.
    for (const seen of seenPerTier) expect(seen.size).toBe(3);
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
      ...TIERS.flatMap((m, tier) =>
        Array.from({ length: 3 }, (_, i) =>
          expedition(`tp_t${tier}_${i}`, { durationMinutes: m, region: 'twin-peeks' }),
        ),
      ),
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

  /**
   * The order content happens to be read in must not reach the player. The
   * loader flattens region files in directory order, and a file rename would
   * otherwise silently reshuffle every board in the game.
   */
  it('ignores the order the pool was given in', () => {
    const shuffled = [...POOL].reverse();
    const interleaved = [...POOL].sort((a, b) => (a.key < b.key ? 1 : -1));
    for (let playerId = 1; playerId <= 40; playerId += 1) {
      const canonical = keys(build({ playerId }));
      expect(keys(build({ playerId, expeditions: shuffled }))).toEqual(canonical);
      expect(keys(build({ playerId, expeditions: interleaved }))).toEqual(canonical);
    }
  });

  /**
   * Within a tier, the winner is a pure function of the same seed the old
   * uniform draw used. Adding a mission to *another* tier must not disturb it —
   * that is what makes the stratification four independent draws rather than
   * one draw with extra steps.
   */
  it('picks within a tier independently of the other tiers', () => {
    const board = build();
    const extraShort = [
      ...POOL,
      expedition('mission_t0_extra', { durationMinutes: 60 }),
      expedition('mission_t0_extra2', { durationMinutes: 60 }),
    ];
    const widened = build({ expeditions: extraShort });
    // The 3h, 6h and 18h picks are untouched by three new 1h missions.
    expect(keys(widened).slice(1)).toEqual(keys(board).slice(1));
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

  it('spreads appearances roughly evenly within each tier', () => {
    const counts = new Map<string, number>();
    const players = 2000;
    for (let playerId = 1; playerId <= players; playerId += 1) {
      for (const key of keys(build({ playerId }))) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(POOL.length);
    // One slot per tier over three candidates => each mission expected on a
    // third of boards. A wide band: this asserts no mission is starved or
    // dominant, not that md5 is uniform.
    for (const [, count] of counts) {
      expect(count / players).toBeGreaterThan(0.25);
      expect(count / players).toBeLessThan(0.42);
    }
  });
});

describe('orderBoardForDisplay', () => {
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
   * The player-facing contract: 1h → 3h → 6h → 18h, every time, for everyone.
   */
  it('renders a selected board as 1h → 3h → 6h → 18h', () => {
    for (let playerId = 1; playerId <= 100; playerId += 1) {
      const shown = orderBoardForDisplay(build({ playerId }));
      expect(minutes(shown)).toEqual([...TIERS]);
    }
  });

  /**
   * Presentation must not leak back into selection: the set a window shows is
   * decided by the stratified draw alone, and re-ordering it cannot add or
   * drop one.
   */
  it('changes the order of a board but never its membership', () => {
    for (let playerId = 1; playerId <= 50; playerId += 1) {
      const selected = build({ playerId });
      const shown = orderBoardForDisplay(selected);
      expect(new Set(keys(shown))).toEqual(new Set(keys(selected)));
      expect(minutes(shown)).toEqual([...minutes(shown)].sort((a, b) => a - b));
      // And the same inputs still produce the same board.
      expect(keys(orderBoardForDisplay(build({ playerId })))).toEqual(keys(shown));
    }
  });
});
