/**
 * The load engine against a fake `fetch`: what virtual players request, how
 * outcomes are counted, and how a run ends.
 *
 * Pinned:
 *   - failure accounting: 4xx, 5xx, timeouts and network errors are counted
 *     separately; a revalidated card's 304 is a success; stop-cancelled
 *     requests are neither;
 *   - every request is a GET to the configured origin, carries the virtual
 *     player's own session cookie, and names only that player or a synthetic
 *     neighbour — never any other player id;
 *   - workload selection: Portal/API issues no card requests, cold cards use
 *     the species route with a level, a spent cold plan is reported;
 *   - think time: a player idles between actions rather than hammering;
 *   - stop ends every loop promptly; the same seed replays the same requests.
 */
import { describe, expect, it } from 'vitest';
import { LoadEngine, sleep, type FetchLike } from '../../../src/modules/loadTest/engine';
import type { RunnerPlan } from '../../../src/modules/loadTest/types';
import { fakePlayers } from '../../helpers/loadTestFakes';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function recordingFetch(
  respond: (url: string, headers: Record<string, string>) => Promise<Response> | Response = () =>
    new Response('{}', { status: 200 }),
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: String(init.method), headers });
    return respond(url, headers);
  };
  return { fetch, calls };
}

function plan(overrides: Partial<RunnerPlan> = {}): RunnerPlan {
  const concurrency = overrides.concurrency ?? 2;
  return {
    runKey: 'test',
    baseUrl: 'http://127.0.0.1:9',
    sessionCookieName: 'wm_portal_session',
    profile: 'mixed',
    cardMode: null,
    cardsAvailable: true,
    concurrency,
    durationMs: 400,
    seed: 7,
    requestTimeoutMs: 1_000,
    progressIntervalMs: 1_000,
    players: fakePlayers(concurrency),
    ...overrides,
  };
}

/** Time at 200× speed — clock and waits together — so a minute of think time takes 0.3 s. */
function fastThink(): { now: () => number; sleep: (ms: number, s: AbortSignal) => Promise<void> } {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * 200,
    sleep: (ms, signal) => sleep(ms / 200, signal),
  };
}

describe('request shape and isolation', () => {
  it('only GETs its own origin, with its own cookie, naming only synthetic players', async () => {
    const p = plan({ concurrency: 3, durationMs: 60_000 });
    const { fetch, calls } = recordingFetch();
    const engine = new LoadEngine(p, { fetch, ...fastThink() });
    await engine.prime();
    await engine.run([]);

    expect(calls.length).toBeGreaterThan(20);
    const allowedIds = new Set(p.players.map((pl) => pl.playerId));
    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.url.startsWith(`${p.baseUrl}/api/v1/`) || call.url === `${p.baseUrl}/auth/session`).toBe(true);
      const token = /wm_portal_session=(token-\d+)/.exec(call.headers.cookie ?? '')?.[1];
      expect(token).toBeDefined();
      const owner = p.players.find((pl) => pl.sessionToken === token)!;
      for (const match of call.url.matchAll(/\/players\/(\d+)/g)) {
        const id = Number(match[1]);
        expect(allowedIds.has(id)).toBe(true);
        if (!call.url.includes('/public')) expect(id).toBe(owner.playerId);
      }
    }
  });

  it('replays the same request sequence for the same seed', async () => {
    const run = async (seed: number) => {
      const { fetch, calls } = recordingFetch();
      const engine = new LoadEngine(plan({ concurrency: 1, durationMs: 30_000, seed }), { fetch, ...fastThink() });
      await engine.run([]);
      return calls.slice(0, 15).map((c) => c.url);
    };
    const a = await run(99);
    const b = await run(99);
    const c = await run(100);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('failure accounting', () => {
  it('separates 4xx, 5xx, timeouts and network errors, and counts successes', async () => {
    let n = 0;
    const { fetch } = recordingFetch(async () => {
      n += 1;
      switch (n % 5) {
        case 0:
          return new Response('{}', { status: 500 });
        case 1:
          return new Response('{}', { status: 404 });
        case 2:
          throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
        case 3: {
          const err = new Error('timed out');
          err.name = 'TimeoutError';
          // Behave like a real timeout: wait for the engine's own timer.
          await new Promise((r) => setTimeout(r, 80));
          throw err;
        }
        default:
          return new Response('{}', { status: 200 });
      }
    });
    const engine = new LoadEngine(
      plan({ concurrency: 1, profile: 'normal', durationMs: 20_000, requestTimeoutMs: 50 }),
      { fetch, ...fastThink() },
    );
    const summary = await engine.run([]);
    const f = summary.failures;
    expect(f.http5xx).toBeGreaterThan(0);
    expect(f.http4xx).toBeGreaterThan(0);
    expect(f.network).toBeGreaterThan(0);
    expect(f.timeout).toBeGreaterThan(0);
    expect(f.total).toBe(f.http4xx + f.http5xx + f.network + f.timeout);
    expect(summary.completed).toBeGreaterThan(0);
    expect(summary.attempted).toBe(summary.completed + f.total + summary.canceled);
    expect(summary.sampleErrors.some((e) => e.includes('HTTP 500'))).toBe(true);
    // Only successes enter the latency distribution.
    expect(summary.latency.count).toBe(summary.completed);
    const perEndpoint = summary.endpoints.reduce((s, e) => s + e.failed, 0);
    expect(perEndpoint).toBe(f.total);
  });

  it('counts a revalidated card answered 304 as a success', async () => {
    const { fetch, calls } = recordingFetch((url, headers) => {
      if (url.includes('/card')) {
        return headers['if-none-match']
          ? new Response(null, { status: 304 })
          : new Response('bytes', { status: 200, headers: { etag: '"k@512"' } });
      }
      return new Response('{}', { status: 200 });
    });
    const engine = new LoadEngine(
      plan({ concurrency: 1, profile: 'cards', cardMode: 'warm', durationMs: 60_000 }),
      { fetch, ...fastThink() },
    );
    await engine.prime();
    const summary = await engine.run([]);
    expect(calls.some((c) => c.headers['if-none-match'] === '"k@512"')).toBe(true);
    expect(summary.cards.notModified).toBeGreaterThan(0);
    expect(summary.failures.total).toBe(0);
  });

  it('fails priming loudly when the server refuses the sessions', async () => {
    const { fetch } = recordingFetch(() => new Response('{}', { status: 401 }));
    const engine = new LoadEngine(plan({ concurrency: 1 }), { fetch });
    await expect(engine.prime()).rejects.toThrow(/priming failed/);
  });
});

describe('workload selection', () => {
  it('Portal/API requests no card images', async () => {
    const { fetch, calls } = recordingFetch();
    await new LoadEngine(plan({ profile: 'portal', durationMs: 60_000 }), { fetch, ...fastThink() }).run([]);
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.some((c) => c.url.includes('/card'))).toBe(false);
  });

  it('Normal Gameplay stays on player-scoped gameplay reads', async () => {
    const { fetch, calls } = recordingFetch();
    await new LoadEngine(plan({ profile: 'normal', durationMs: 60_000 }), { fetch, ...fastThink() }).run([]);
    const paths = calls.map((c) => new URL(c.url).pathname);
    expect(paths.every((p) => p.startsWith('/api/v1/players/'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/encounter'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/currency'))).toBe(true);
  });

  it('cold cards hit the species route at the planned levels, once each, then report the plan spent', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('bytes', { status: 200 }));
    const cold = [
      { slug: 'alpha', level: 50 },
      { slug: 'beta', level: 50 },
      { slug: 'alpha', level: 49 },
    ];
    const summary = await new LoadEngine(
      plan({ concurrency: 2, profile: 'cards', cardMode: 'cold', durationMs: 60_000 }),
      { fetch, ...fastThink() },
    ).run(cold);
    const coldCalls = calls.filter((c) => c.url.includes('/cards/species/'));
    expect(coldCalls.map((c) => new URL(c.url).pathname + new URL(c.url).search).sort()).toEqual(
      [
        '/api/v1/cards/species/alpha?level=49&width=512',
        '/api/v1/cards/species/alpha?level=50&width=512',
        '/api/v1/cards/species/beta?level=50&width=512',
      ],
    );
    expect(summary.cards.coldRequested).toBe(3);
    expect(summary.cards.coldPlanned).toBe(3);
    expect(summary.cards.coldExhausted).toBeGreaterThan(0);
  });

  it('skips card requests entirely when the server has no card routes', async () => {
    const { fetch, calls } = recordingFetch();
    const engine = new LoadEngine(plan({ profile: 'mixed', cardsAvailable: false, concurrency: 20, durationMs: 60_000 }), {
      fetch,
      ...fastThink(),
    });
    await engine.prime();
    await engine.run([]);
    expect(calls.some((c) => c.url.includes('/card'))).toBe(false);
  });
});

describe('think time and stopping', () => {
  it('idles between actions: one player makes a handful of actions a minute, not hundreds', async () => {
    // Real clock, 1.5 s: with a 3 s minimum think time, one action at most.
    const { fetch } = recordingFetch();
    const engine = new LoadEngine(plan({ concurrency: 1, profile: 'normal', durationMs: 1_500 }), { fetch });
    const summary = await engine.run([]);
    expect(summary.actions).toBe(1);
  });

  it('stop ends every loop promptly and cancelled requests are not failures', async () => {
    const { fetch } = recordingFetch(
      (_url, _h) =>
        new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('{}')), 5_000)),
    );
    // A fetch that honours the abort signal, like the real one.
    const abortable: FetchLike = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        void fetch(url, init).then(resolve, reject);
      });
    const engine = new LoadEngine(plan({ concurrency: 5, durationMs: 60_000 }), { fetch: abortable });
    const running = engine.run([]);
    await new Promise((r) => setTimeout(r, 100));
    const stoppedAt = Date.now();
    engine.stop();
    const summary = await running;
    expect(Date.now() - stoppedAt).toBeLessThan(500);
    expect(summary.activePlayers).toBe(0);
    expect(summary.canceled).toBeGreaterThan(0);
    expect(summary.failures.total).toBe(0);
  });

  it('staggers player start over the ramp rather than all at once', async () => {
    const first: number[] = [];
    const seen = new Set<string>();
    const { fetch } = recordingFetch((_url, headers) => {
      const cookie = headers.cookie!;
      if (!seen.has(cookie)) {
        seen.add(cookie);
        first.push(Date.now());
      }
      return new Response('{}');
    });
    // 10 s run → 1 s ramp over 10 players.
    const engine = new LoadEngine(plan({ concurrency: 10, durationMs: 10_000 }), { fetch });
    const running = engine.run([]);
    await new Promise((r) => setTimeout(r, 1_200));
    engine.stop();
    await running;
    expect(first).toHaveLength(10);
    expect(first[9]! - first[0]!).toBeGreaterThan(700);
  });
});
