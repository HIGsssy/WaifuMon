/**
 * `/metrics` and `/metrics/reset` over the real server, with doubles beneath.
 *
 * The load-bearing group here is the authentication one. The global auth hook
 * accepts either the shared bearer token or a Portal session cookie, and a
 * Portal session is a *player's* browser login — so "a logged-in player cannot
 * read RSS, query latency and pool saturation" is a security property, not a
 * detail, and it is the one a future refactor is most likely to erase by
 * accident. It is asserted from both directions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { CardMetrics, MetricsSources } from '../../../src/api/routes/metrics';
import { EventLoopMonitor, LatencyRecorder } from '../../../src/shared/metrics';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
} from '../../helpers/platformApiFixtures';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

const NO_RENDERER: CardMetrics = {
  active: false,
  masterRenders: null,
  derivativeRenders: null,
  cacheHits: null,
  dedupedRenders: null,
  workers: null,
};

let api: ZodFastify;
let sources: MetricsSources;
let cards: CardMetrics;
let pool: MetricsSources extends { describeDatabasePool: () => infer P } ? P : never;

async function build(opts: { metrics?: boolean } = {}): Promise<ZodFastify> {
  cards = NO_RENDERER;
  pool = { totalCount: 3, idleCount: 2, waitingCount: 0, max: 10 };
  const eventLoop = new EventLoopMonitor(1);
  eventLoop.start();
  sources = {
    eventLoop,
    http: new LatencyRecorder(),
    describeDatabasePool: () => pool,
    describeCardRenderer: () => cards,
  };
  return createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3199, token: TEST_TOKEN },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: createApiContext(),
    ...(opts.metrics === false ? {} : { metrics: sources }),
  });
}

beforeEach(async () => {
  api = await build();
});

afterEach(async () => {
  sources?.eventLoop.stop();
  await api?.close();
});

describe('authentication', () => {
  it('serves metrics to the bearer token', async () => {
    const res = await api.inject({ method: 'GET', url: '/metrics', headers: AUTH });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an anonymous request with 401', async () => {
    // `/metrics` must not be in `isPublicPath` — the global hook is the first
    // of the two layers guarding it.
    const res = await api.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong bearer token', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a Portal session with 403 even though the global hook accepts it', async () => {
    // The security property this whole file exists for: a player's browser
    // login IS a valid Platform API credential, and must still not read RSS,
    // query latency or pool saturation.
    //
    // Driven through the real auth hook by giving the server a session service
    // that resolves a cookie into a session — so the hook genuinely sets
    // `apiAuth = 'portal'` and the route genuinely refuses it. Stubbing
    // `req.apiAuth` from a later hook would not work and would prove nothing:
    // hooks run in registration order, so one added after `registerAuth` runs
    // *after* it has already answered 401.
    const session = {
      sessionDigest: 'digest',
      discordUserId: '777888999000111222',
      discordUsername: 'player',
      discordAvatarUrl: null,
      selectedDiscordGuildId: null,
      selectedGuildDbId: null,
      playerId: 1,
      eligibleGuilds: [],
      csrfToken: 'csrf-token',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const sessionOnly = await createPlatformApiServer({
      config: { enabled: true, host: '127.0.0.1', port: 3198, token: TEST_TOKEN },
      logger: createCapturedLogger('silent').logger,
      probes: createProbes(),
      ctx: createApiContext(),
      metrics: sources,
      portalAuth: {
        sessions: { getSession: async () => session },
        config: { enabled: true, publicUrl: 'http://127.0.0.1:3130' },
      } as unknown as NonNullable<Parameters<typeof createPlatformApiServer>[0]['portalAuth']>,
    });

    const res = await sessionOnly.inject({
      method: 'GET',
      url: '/metrics',
      cookies: { wm_portal_session: 'any-value' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('METRICS_FORBIDDEN');

    // And the same session is refused on the reset route.
    const reset = await sessionOnly.inject({
      method: 'POST',
      url: '/metrics/reset',
      cookies: { wm_portal_session: 'any-value' },
    });
    expect(reset.statusCode).toBe(403);

    await sessionOnly.close();
  });

  it('guards the reset route the same way', async () => {
    expect((await api.inject({ method: 'POST', url: '/metrics/reset' })).statusCode).toBe(401);
    const ok = await api.inject({ method: 'POST', url: '/metrics/reset', headers: AUTH });
    expect(ok.statusCode).toBe(200);
  });
});

describe('when metrics are disabled', () => {
  it('registers no routes and no timing hooks', async () => {
    const off = await build({ metrics: false });
    // 404, not 401: the route does not exist rather than being hidden.
    expect((await off.inject({ method: 'GET', url: '/metrics', headers: AUTH })).statusCode).toBe(404);
    expect(
      (await off.inject({ method: 'POST', url: '/metrics/reset', headers: AUTH })).statusCode,
    ).toBe(404);
    await off.close();
  });
});

describe('the payload', () => {
  it('reports process memory, event loop, pool and card state', async () => {
    const body = (await api.inject({ method: 'GET', url: '/metrics', headers: AUTH })).json();

    expect(body.process.memory.rssBytes).toBeGreaterThan(0);
    // Present so the rss/heap gap is not misread as purely native allocation.
    expect(body.process.memory.heapScope).toBe('main-thread');
    expect(body.eventLoop.enabled).toBe(true);
    expect(body.eventLoop.resolutionMs).toBe(1);
    expect(body.database.pool).toEqual({
      totalCount: 3,
      idleCount: 2,
      waitingCount: 0,
      max: 10,
    });
    expect(body.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports the renderer as inactive without pretending it has counters', async () => {
    const body = (await api.inject({ method: 'GET', url: '/metrics', headers: AUTH })).json();
    // "No card has been drawn in this process" is the useful signal, and null
    // is how it is said — a zero would claim the renderer ran and did nothing.
    expect(body.cards).toEqual(NO_RENDERER);
  });

  it('reports renderer and worker-pool counters when a render has happened', async () => {
    cards = {
      active: true,
      masterRenders: 4,
      derivativeRenders: 9,
      cacheHits: 120,
      dedupedRenders: 2,
      workers: {
        workers: 1,
        spawned: 2,
        replaced: 1,
        queued: 3,
        peakQueued: 7,
        peakConcurrent: 1,
        dispatched: 13,
      },
    };
    const body = (await api.inject({ method: 'GET', url: '/metrics', headers: AUTH })).json();

    expect(body.cards.masterRenders).toBe(4);
    expect(body.cards.cacheHits).toBe(120);
    // peakQueued and replaced are the two the capacity test actually reads:
    // how deep a burst got, and whether a worker crashed under it.
    expect(body.cards.workers.peakQueued).toBe(7);
    expect(body.cards.workers.replaced).toBe(1);
  });

  it('surfaces pool saturation when queries are waiting', async () => {
    pool = { totalCount: 10, idleCount: 0, waitingCount: 6, max: 10 };
    const body = (await api.inject({ method: 'GET', url: '/metrics', headers: AUTH })).json();
    // The reading that would justify raising `max` — reported next to the
    // ceiling so it can be read as a fraction of it.
    expect(body.database.pool.waitingCount).toBe(6);
    expect(body.database.pool.totalCount).toBe(body.database.pool.max);
  });
});

describe('request instrumentation', () => {
  it('counts and times requests it served, keyed by route pattern', async () => {
    await api.inject({ method: 'GET', url: '/health' });
    await api.inject({ method: 'GET', url: '/health' });

    const body = (await api.inject({ method: 'GET', url: '/metrics', headers: AUTH })).json();
    expect(body.http.counts.total).toBeGreaterThanOrEqual(2);
    expect(body.http.latency.count).toBeGreaterThanOrEqual(2);
    expect(body.http.latency.p99Ms).not.toBeNull();

    const health = body.http.routes.find((r: { route: string }) => r.route === '/health');
    expect(health).toBeDefined();
    expect(health.counts.total).toBe(2);
  });

  it('records requests the auth hook refused', async () => {
    // Timing starts before auth, so a 401 is in the distribution. An instrument
    // that only timed successful requests would look healthiest exactly when the
    // system had started refusing work.
    await api.inject({ method: 'GET', url: '/api/v1/content/species' });

    const body = (await api.inject({ method: 'GET', url: '/metrics', headers: AUTH })).json();
    expect(body.http.counts.byStatusClass['4xx']).toBeGreaterThanOrEqual(1);
    expect(body.http.counts.errors).toBeGreaterThanOrEqual(1);
  });

  it('folds unmatched requests under one key rather than the raw URL', async () => {
    await api.inject({ method: 'GET', url: '/no/such/path', headers: AUTH });

    const body = (await api.inject({ method: 'GET', url: '/metrics', headers: AUTH })).json();
    const routes = body.http.routes.map((r: { route: string }) => r.route);
    expect(routes).toContain('<unrouted>');
    expect(routes).not.toContain('/no/such/path');
  });

  it('leaves nothing in flight once responses are sent', async () => {
    await api.inject({ method: 'GET', url: '/health' });
    const body = (await api.inject({ method: 'GET', url: '/metrics', headers: AUTH })).json();
    // The /metrics request itself is still in flight while its handler runs, so
    // 1 is the floor here, not 0.
    expect(body.http.inFlight).toBeLessThanOrEqual(1);
  });
});

describe('reset', () => {
  it('clears the window and reports the new start time', async () => {
    await api.inject({ method: 'GET', url: '/health' });
    await api.inject({ method: 'GET', url: '/health' });

    const reset = await api.inject({ method: 'POST', url: '/metrics/reset', headers: AUTH });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().reset).toBe(true);
    expect(reset.json().windowStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const body = (await api.inject({ method: 'GET', url: '/metrics', headers: AUTH })).json();
    // Only the reset call and this scrape survive the window boundary; the two
    // /health calls must be gone.
    const health = body.http.routes.find((r: { route: string }) => r.route === '/health');
    expect(health).toBeUndefined();
  });
});
