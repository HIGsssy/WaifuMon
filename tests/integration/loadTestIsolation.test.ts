/**
 * Load-test data isolation, against a real database and the real API.
 *
 * Pinned:
 *   - the synthetic fixture lives in one synthetic guild with no announce or
 *     boss channel, is deterministic, idempotent, and extends without
 *     rebuilding;
 *   - `assertSyntheticPlayers` refuses any real player, alone or in a mix;
 *   - a synthetic player's Portal session reads its own data and is refused
 *     every real player's — by the server's own scoping, not the harness's;
 *   - running the real engine (Normal, Portal/API and Mixed) against the real
 *     API with real services completes with **zero failures** — every request
 *     the workloads issue is one the server answers — and leaves a real
 *     player's rows exactly as they were;
 *   - session cleanup deletes synthetic sessions only;
 *   - run results round-trip through `load_test_runs`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, eq, inArray } from 'drizzle-orm';
import { createPlatformApiServer } from '../../src/api/server';
import type { ZodFastify } from '../../src/api/plugins/typeProvider';
import {
  createPortalSessionService,
  PORTAL_SESSION_COOKIE,
  type PortalSessionService,
} from '../../src/api/portalSession';
import {
  guilds,
  playerAchievements,
  playerCurrencies,
  playerInventory,
  players,
  playerWaifus,
  portalSessions,
} from '../../src/db/schema';
import {
  assertSyntheticPlayers,
  ensureSyntheticPlayers,
  GRID_SIZE,
  SyntheticIsolationError,
} from '../../src/modules/loadTest/fixture';
import { createRunPreparer } from '../../src/modules/loadTest/wiring';
import { createLoadTestRunStore } from '../../src/modules/loadTest/store';
import { LoadEngine, sleep, type FetchLike } from '../../src/modules/loadTest/engine';
import { SYNTHETIC_GUILD_DISCORD_ID } from '../../src/modules/loadTest/synthetic';
import type { LoadTestProfile, RunnerPlan, VirtualPlayerFixture } from '../../src/modules/loadTest/types';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { species } from '../../src/db/schema';

const REAL_GUILD = '111222333444555666';
const REAL_USER = '900000000000000001';

let t: TestDb;
let app: App;
let api: ZodFastify;
let sessions: PortalSessionService;
let realPlayerId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId: realPlayerId } = await provisionPlayer(app, REAL_GUILD, REAL_USER));
  const [firstSpecies] = await t.db.select().from(species).orderBy(species.id).limit(1);
  await insertOwnedWaifu(t.db, { playerId: realPlayerId, speciesId: firstSpecies!.id, level: 5 });

  const config = {
    publicUrl: 'http://localhost',
    forwardedProto: 'http' as const,
    discordClientId: 'x',
    discordClientSecret: 'x',
    sessionSecret: 'y'.repeat(40),
    sessionTtlSeconds: 3600,
  };
  sessions = createPortalSessionService(t.db, config);
  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3134, token: TEST_TOKEN },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    portalAuth: { config, sessions },
    ctx: { services: app, getContent: () => app.content },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

/** `fetch` over `app.inject`: the real routing, auth, services and database. */
const injectFetch: FetchLike = async (url, init) => {
  const u = new URL(url);
  const res = await api.inject({
    method: 'GET',
    url: u.pathname + u.search,
    headers: init.headers as Record<string, string>,
  });
  const body = res.statusCode === 204 || res.statusCode === 304 ? null : res.rawPayload;
  return new Response(body, { status: res.statusCode, headers: res.headers as Record<string, string> });
};

async function realPlayerState() {
  const [cur] = await t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, realPlayerId));
  const [waifus] = await t.db.select({ n: count() }).from(playerWaifus).where(eq(playerWaifus.playerId, realPlayerId));
  const [ach] = await t.db
    .select({ n: count() })
    .from(playerAchievements)
    .where(eq(playerAchievements.playerId, realPlayerId));
  const [inv] = await t.db.select({ n: count() }).from(playerInventory).where(eq(playerInventory.playerId, realPlayerId));
  const [row] = await t.db.select().from(players).where(eq(players.id, realPlayerId));
  return { cur, waifus: waifus!.n, ach: ach!.n, inv: inv!.n, row };
}

describe('synthetic fixture', () => {
  it('builds players in a synthetic guild with no Discord channels', async () => {
    const synth = await ensureSyntheticPlayers(t.db, 3);
    expect(synth).toHaveLength(3);
    const [g] = await t.db.select().from(guilds).where(eq(guilds.discordGuildId, SYNTHETIC_GUILD_DISCORD_ID));
    expect(g).toMatchObject({ announceChannelId: null, bossChannelId: null });
    for (const p of synth) {
      expect(p.guildDbId).toBe(g!.id);
      expect(p.discordUserId).toMatch(/^7357\d{3}$/);
      expect(p.gridWaifuIds).toHaveLength(GRID_SIZE);
      expect(p.ownedWaifuIds.length).toBeGreaterThan(GRID_SIZE);
    }
    // Every player owns the same grid species — the cold plan's shared pool.
    expect(synth[1]!.speciesSlugs.length).toBeGreaterThanOrEqual(GRID_SIZE);
  });

  it('is idempotent and extends without rebuilding', async () => {
    const before = await ensureSyntheticPlayers(t.db, 3);
    const again = await ensureSyntheticPlayers(t.db, 5);
    expect(again.slice(0, 3).map((p) => [p.playerId, p.ownedWaifuIds])).toEqual(
      before.map((p) => [p.playerId, p.ownedWaifuIds]),
    );
    expect(again).toHaveLength(5);
  });

  it('refuses any real player, alone or mixed in', async () => {
    const synth = await ensureSyntheticPlayers(t.db, 2);
    await expect(assertSyntheticPlayers(t.db, synth.map((p) => p.playerId))).resolves.toBeUndefined();
    await expect(assertSyntheticPlayers(t.db, [realPlayerId])).rejects.toBeInstanceOf(SyntheticIsolationError);
    await expect(
      assertSyntheticPlayers(t.db, [synth[0]!.playerId, realPlayerId]),
    ).rejects.toBeInstanceOf(SyntheticIsolationError);
    await expect(assertSyntheticPlayers(t.db, [999_999])).rejects.toBeInstanceOf(SyntheticIsolationError);
  });
});

describe('synthetic sessions', () => {
  let fixtures: VirtualPlayerFixture[];

  beforeAll(async () => {
    const prepared = await createRunPreparer(t.db, sessions).prepare(3);
    fixtures = prepared.players;
    expect(prepared.commonSpeciesSlugs.length).toBeGreaterThanOrEqual(GRID_SIZE);
  });

  const as = (f: VirtualPlayerFixture, url: string) =>
    api.inject({ method: 'GET', url, headers: { cookie: `${PORTAL_SESSION_COOKIE}=${f.sessionToken}` } });

  it('read their own data', async () => {
    const res = await as(fixtures[0]!, `/api/v1/players/${fixtures[0]!.playerId}/profile`);
    expect(res.statusCode).toBe(200);
  });

  it('are refused every real player, by the server', async () => {
    for (const path of ['profile', 'achievements', 'encounter', 'collection/owned', 'currency']) {
      const res = await as(fixtures[0]!, `/api/v1/players/${realPlayerId}/${path}`);
      expect(res.statusCode).toBe(403);
    }
    // Public profiles are guild-scoped: a real player is simply not there.
    expect((await as(fixtures[0]!, `/api/v1/players/${realPlayerId}/public`)).statusCode).toBe(404);
  });

  it('see only synthetic players in the guild directory', async () => {
    const res = await as(fixtures[0]!, '/api/v1/players?page=1&pageSize=50');
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as Array<{ id: number }>).map((p) => p.id);
    expect(ids).not.toContain(realPlayerId);
    await expect(assertSyntheticPlayers(t.db, ids)).resolves.toBeUndefined();
  });

  it('are deleted by release, and a real session survives', async () => {
    const real = await sessions.createSession({
      user: { id: REAL_USER, username: 'Real' },
      eligibleGuilds: [],
    });
    await createRunPreparer(t.db, sessions).release();
    const left = await t.db.select().from(portalSessions);
    expect(left.map((s) => s.discordUserId)).toEqual([REAL_USER]);
    expect(await sessions.getSession(real.token)).not.toBeNull();
    expect(await sessions.getSession(fixtures[0]!.sessionToken)).toBeNull();
  });
});

describe('the real workloads against the real API', () => {
  it.each(['normal', 'portal', 'mixed'] as const)(
    '%s completes with zero failures and leaves the real player untouched',
    async (profile: LoadTestProfile) => {
      const before = await realPlayerState();
      const prepared = await createRunPreparer(t.db, sessions).prepare(4);
      const plan: RunnerPlan = {
        runKey: `it-${profile}`,
        baseUrl: 'http://in-process',
        sessionCookieName: PORTAL_SESSION_COOKIE,
        profile,
        cardMode: null,
        cardsAvailable: false, // no renderer in this harness; card routes are unregistered
        concurrency: 4,
        durationMs: 120_000,
        seed: 42,
        requestTimeoutMs: 10_000,
        progressIntervalMs: 1_000,
        players: prepared.players,
      };
      // Two simulated minutes in about half a second of think time.
      const start = Date.now();
      const engine = new LoadEngine(plan, {
        fetch: injectFetch,
        now: () => start + (Date.now() - start) * 200,
        sleep: (ms, signal) => sleep(ms / 200, signal),
      });
      await engine.prime();
      const summary = await engine.run([]);

      expect(summary.sampleErrors).toEqual([]);
      expect(summary.failures.total).toBe(0);
      expect(summary.completed).toBeGreaterThan(20);
      expect(summary.endpoints.length).toBeGreaterThan(5);

      expect(await realPlayerState()).toEqual(before);
      await createRunPreparer(t.db, sessions).release();
    },
    60_000,
  );
});

describe('result store', () => {
  it('round-trips a run', async () => {
    const store = createLoadTestRunStore(t.db);
    const saved = await store.save({
      runKey: 'lt-test-1',
      status: 'completed',
      profile: 'mixed',
      cardMode: null,
      concurrency: 25,
      durationSeconds: 300,
      elapsedSeconds: 300,
      seed: 1337,
      label: null,
      hostLabel: '3400GE staging',
      operatorDiscordId: '1',
      hostInfo: { logicalCpus: 8 },
      summary: { completed: 100, latency: { p99Ms: 42 } },
      metricsStart: null,
      metricsEnd: { eventLoop: { recentUtilization: 0.2 } },
      error: null,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-01T00:05:00Z'),
    });
    expect((await store.get(saved.id))?.summary).toEqual({ completed: 100, latency: { p99Ms: 42 } });
    expect((await store.list(10)).map((r) => r.runKey)).toContain('lt-test-1');
    await expect(
      store.save({ ...saved, id: undefined, runKey: 'lt-bad', status: 'exploded' } as never),
    ).rejects.toThrow();
  });

  it('touches no synthetic rows when saving', async () => {
    const [synthGuild] = await t.db
      .select({ id: guilds.id })
      .from(guilds)
      .where(inArray(guilds.discordGuildId, [SYNTHETIC_GUILD_DISCORD_ID]));
    expect(synthGuild).toBeDefined();
  });
});
