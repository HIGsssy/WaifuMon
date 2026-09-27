/**
 * Workload definitions and the start-request contract.
 *
 * Pinned:
 *   - concurrency and duration are bounded (1–100 players, 30 s–30 min), a
 *     cards run must name its cache mode, and unknown fields are refused;
 *   - every request any profile can issue is a read of an allowed surface —
 *     never an admin route, never a mutation path;
 *   - think time is human-shaped and clamped; the mixed rotation is 55/35/10;
 *   - the cold-plan estimate is bounded.
 */
import { describe, expect, it } from 'vitest';
import { seededRng } from '../../../src/shared/random';
import {
  chooseAction,
  coldCardsNeeded,
  MAX_COLD_PLAN,
  personaFor,
  primeRequests,
  rampMs,
  thinkTimeMs,
  type ActionContext,
} from '../../../src/modules/loadTest/profiles';
import {
  CONCURRENCY_PRESETS,
  DURATION_PRESETS_SECONDS,
  loadTestStartSchema,
  MAX_CONCURRENCY,
} from '../../../src/modules/loadTest/types';
import { fakePlayers } from '../../helpers/loadTestFakes';

describe('start request validation', () => {
  const ok = { profile: 'mixed', concurrency: 10, durationSeconds: 300 };

  it('accepts every preset combination', () => {
    for (const concurrency of CONCURRENCY_PRESETS) {
      for (const durationSeconds of DURATION_PRESETS_SECONDS) {
        expect(loadTestStartSchema.safeParse({ ...ok, concurrency, durationSeconds }).success).toBe(true);
      }
    }
  });

  it.each([
    ['zero players', { concurrency: 0 }],
    ['over the ceiling', { concurrency: MAX_CONCURRENCY + 1 }],
    ['fractional players', { concurrency: 2.5 }],
    ['too short', { durationSeconds: 29 }],
    ['too long', { durationSeconds: 30 * 60 + 1 }],
    ['unknown profile', { profile: 'flood' }],
    ['an unknown field', { rps: 1000 }],
    ['cards without a cache mode', { profile: 'cards' }],
    ['a bad card mode', { profile: 'cards', cardMode: 'lukewarm' }],
  ])('refuses %s', (_name, patch) => {
    expect(loadTestStartSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });

  it('accepts a custom value inside the bounds', () => {
    expect(loadTestStartSchema.safeParse({ ...ok, concurrency: 37, durationSeconds: 45 }).success).toBe(true);
    expect(MAX_CONCURRENCY).toBe(100);
  });
});

function ctxFor(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    player: fakePlayers(3)[0]!,
    rng: seededRng(3),
    cardsAvailable: true,
    cardMode: 'warm',
    takeCold: () => ({ slug: 'alpha', level: 40 }),
    noteColdExhausted: () => {},
    ...overrides,
  };
}

describe('what a profile can request', () => {
  it('only reads allowed surfaces — no admin, no mutation, no metrics', () => {
    const paths = new Set<string>();
    for (const profile of ['normal', 'portal', 'cards', 'mixed'] as const) {
      for (const cardMode of ['warm', 'cold'] as const) {
        for (let i = 0; i < 20; i += 1) {
          const persona = personaFor(profile, cardMode, i, true);
          for (const action of persona.actions) {
            for (const step of action.build(ctxFor({ cardMode }))) {
              for (const spec of step) paths.add(spec.path);
            }
          }
        }
      }
    }
    for (const path of paths) {
      expect(path.startsWith('/api/v1/') || path === '/auth/session').toBe(true);
      expect(path).not.toMatch(/\/admin\/|\/metrics|\/appearance(\?|$)|\/ensure|\/claim|\/hunt|\/capture(\/|\?|$)/);
    }
  });

  it('priming touches each read once, and only the player\'s own or public data', () => {
    const player = fakePlayers(3)[0]!;
    const reqs = primeRequests(player, true);
    expect(new Set(reqs.map((r) => r.path)).size).toBe(reqs.length);
    expect(reqs.filter((r) => r.card)).toHaveLength(player.gridWaifuIds.length);
    for (const r of reqs) {
      for (const m of r.path.matchAll(/\/players\/(\d+)/g)) {
        const id = Number(m[1]);
        expect(id === player.playerId || player.neighbourPlayerIds.includes(id)).toBe(true);
      }
    }
  });
});

describe('personas', () => {
  it('mixed is 55% Discord, 35% Portal, 10% card-heavy over the rotation', () => {
    const counts = { discord: 0, portal: 0, cards: 0 };
    for (let i = 0; i < 20; i += 1) counts[personaFor('mixed', null, i, true).name] += 1;
    expect(counts).toEqual({ discord: 11, portal: 7, cards: 2 });
  });

  it('the dedicated profiles use one persona throughout', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(personaFor('normal', null, i, true).name).toBe('discord');
      expect(personaFor('portal', null, i, true).name).toBe('portal');
      expect(personaFor('cards', 'warm', i, true).name).toBe('cards');
    }
  });

  it('weights choose actions in proportion', () => {
    const rng = seededRng(1);
    const actions = [
      { name: 'a', weight: 3, build: () => [] },
      { name: 'b', weight: 1, build: () => [] },
    ];
    let a = 0;
    for (let i = 0; i < 4000; i += 1) if (chooseAction(actions, rng).name === 'a') a += 1;
    expect(a / 4000).toBeGreaterThan(0.7);
    expect(a / 4000).toBeLessThan(0.8);
  });
});

describe('think time', () => {
  it('is clamped and centred on the median', () => {
    const think = { medianMs: 10_000, sigma: 0.5, minMs: 3_000, maxMs: 30_000 };
    const rng = seededRng(5);
    const samples = Array.from({ length: 5_000 }, () => thinkTimeMs(think, rng)).sort((x, y) => x - y);
    expect(samples[0]).toBeGreaterThanOrEqual(3_000);
    expect(samples.at(-1)).toBeLessThanOrEqual(30_000);
    const median = samples[2_500]!;
    expect(median).toBeGreaterThan(9_000);
    expect(median).toBeLessThan(11_000);
  });

  it('ramps over a tenth of the run, at most 30 s', () => {
    expect(rampMs(60_000)).toBe(6_000);
    expect(rampMs(600_000)).toBe(30_000);
  });
});

describe('cold plan sizing', () => {
  it('is zero for workloads that never render cold', () => {
    expect(coldCardsNeeded('portal', null, 50, 600_000)).toBe(0);
    expect(coldCardsNeeded('normal', null, 50, 600_000)).toBe(0);
    expect(coldCardsNeeded('cards', 'warm', 50, 600_000)).toBe(0);
  });

  it('is bounded for the heaviest cold run', () => {
    expect(coldCardsNeeded('cards', 'cold', 100, 30 * 60_000)).toBe(MAX_COLD_PLAN);
    expect(coldCardsNeeded('mixed', null, 10, 300_000)).toBeGreaterThan(0);
  });
});
