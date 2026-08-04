/**
 * Hunt-session boundary maths and the location-flavor tracker.
 *
 * These are the rules the Activity Feed's "ventured into / returned from"
 * pairing rests on, so they're pinned independently of Discord.
 */
import { describe, expect, it } from 'vitest';
import {
  createHuntSessionTracker,
  pickLocationFlavor,
  resolveHuntSessionBoundary,
} from '../../src/modules/hunt/huntSession';
import { crossedAffectionStage, affectionStageFor } from '../../src/modules/collection/affectionStages';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const POOL = ['the Whispering Forest', 'the Neon Boardwalk', 'the Velvet Grove', 'the Moonlit Docks'];

function minutesBefore(n: number): Date {
  return new Date(NOW.getTime() - n * 60 * 1000);
}

describe('resolveHuntSessionBoundary', () => {
  it('opens a session on the very first hunt', () => {
    const b = resolveHuntSessionBoundary({
      lastHuntAt: null,
      careModeActive: false,
      now: NOW,
      idleMinutes: 15,
    });
    expect(b).toMatchObject({ opened: true, closedPreviousReason: null });
  });

  it('stays silent for hunts inside an open session', () => {
    const b = resolveHuntSessionBoundary({
      lastHuntAt: minutesBefore(3),
      careModeActive: false,
      now: NOW,
      idleMinutes: 15,
    });
    expect(b.opened).toBe(false);
    expect(b.closedPreviousReason).toBeNull();
  });

  it('sweeps an abandoned session and opens a new one past the idle window', () => {
    const b = resolveHuntSessionBoundary({
      lastHuntAt: minutesBefore(20),
      careModeActive: false,
      now: NOW,
      idleMinutes: 15,
    });
    expect(b).toMatchObject({ opened: true, closedPreviousReason: 'inactivity' });
    expect(b.previousLastHuntAt).toEqual(minutesBefore(20));
  });

  it('treats exactly the idle threshold as abandoned', () => {
    const b = resolveHuntSessionBoundary({
      lastHuntAt: minutesBefore(15),
      careModeActive: false,
      now: NOW,
      idleMinutes: 15,
    });
    expect(b.closedPreviousReason).toBe('inactivity');
  });

  it('opens a fresh session out of Care Mode without re-closing the old one', () => {
    // `care.start` already emitted PLAYER_COMPLETED_HUNT for that session.
    const b = resolveHuntSessionBoundary({
      lastHuntAt: minutesBefore(90),
      careModeActive: true,
      now: NOW,
      idleMinutes: 15,
    });
    expect(b).toMatchObject({ opened: true, closedPreviousReason: null });
  });
});

describe('pickLocationFlavor', () => {
  it('is deterministic for the same player and open time', () => {
    const a = pickLocationFlavor(POOL, 42, NOW);
    const b = pickLocationFlavor(POOL, 42, NOW);
    expect(a).toBe(b);
    expect(POOL).toContain(a);
  });

  it('returns null for an empty or missing pool', () => {
    expect(pickLocationFlavor([], 42, NOW)).toBeNull();
    expect(pickLocationFlavor(undefined, 42, NOW)).toBeNull();
  });

  it('spreads across the pool over many sessions', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const picked = pickLocationFlavor(POOL, i, new Date(NOW.getTime() + i * 60_000));
      if (picked) seen.add(picked);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('createHuntSessionTracker', () => {
  it('pairs the open and close location for one session', () => {
    const tracker = createHuntSessionTracker({ locations: POOL });
    const opened = tracker.open(7, NOW);
    expect(tracker.isOpen(7)).toBe(true);
    const closed = tracker.close(7);
    expect(closed?.location).toBe(opened);
    expect(tracker.isOpen(7)).toBe(false);
  });

  it('returns null when closing a session it never saw (e.g. after a restart)', () => {
    const tracker = createHuntSessionTracker({ locations: POOL });
    expect(tracker.close(7)).toBeNull();
    // …but can still produce a plausible venue deterministically.
    expect(POOL).toContain(tracker.fallbackLocation(7, NOW));
  });

  it('keeps players independent', () => {
    const tracker = createHuntSessionTracker({ locations: POOL });
    tracker.open(1, NOW);
    tracker.open(2, NOW);
    tracker.close(1);
    expect(tracker.isOpen(1)).toBe(false);
    expect(tracker.isOpen(2)).toBe(true);
  });
});

describe('affection stages', () => {
  it('reports the highest stage reached', () => {
    expect(affectionStageFor(0)).toBeNull();
    expect(affectionStageFor(9)).toBeNull();
    expect(affectionStageFor(10)?.name).toBe('Acquainted');
    expect(affectionStageFor(99)?.name).toBe('Fond');
    expect(affectionStageFor(10_000)?.name).toBe('Soulbound');
  });

  it('detects a crossing only when a threshold is passed', () => {
    expect(crossedAffectionStage(8, 9)).toBeNull();
    expect(crossedAffectionStage(9, 10)?.name).toBe('Acquainted');
    expect(crossedAffectionStage(10, 10)).toBeNull();
  });

  it('reports only the highest stage when a single grant vaults several', () => {
    expect(crossedAffectionStage(0, 120)?.name).toBe('Devoted');
  });
});
