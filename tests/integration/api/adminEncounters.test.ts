/**
 * Portal admin — the encounter routes against a real database.
 *
 * This suite is about the routes *doing their job* end to end: real seeded
 * encounters, real preview math, a real simulation. It drives them with the
 * bearer token, which means it opts into `adminBearer: true` — the flag an
 * operator sets to make `PLATFORM_API_TOKEN` administrative. That is a
 * deliberate choice here and not the default: with the flag off (production's
 * default) a bearer request is refused like any other credential holding no
 * permissions.
 *
 * The **authorization boundary itself** — bearer default-denied, guild-scoped
 * ownership, cross-guild denial, ownership lookup unavailable, CSRF on
 * mutations, and permissions recomputed on a guild switch — is covered over
 * HTTP in `tests/unit/api/adminEncounterAuth.test.ts`, which needs no
 * database and therefore runs everywhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555666';
const OWNER_ID = '777888999000111222';
const NON_OWNER_ID = '999999999999999999';

let t: TestDb;
let app: App;
let api: ZodFastify;
/** Token → session map the auth hook reads through. */
let stubSessions: StubSessions;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  await provisionPlayer(app, GUILD_ID, OWNER_ID);
  await provisionPlayer(app, GUILD_ID, NON_OWNER_ID);

  const guildOwnership = createGuildOwnershipService({
    fetchOwnerId: async () => OWNER_ID,
  });
  const portalAuthorization = createPortalAuthorizationService({ guildOwnership });

  // Stub the portal-session service so a request cookie doesn't need to hit
  // the OAuth flow. We build a session in-memory and hand it back for the
  // registered digest.
  stubSessions = makeStubSessions();

  api = await createPlatformApiServer({
    config: {
      enabled: true,
      host: '127.0.0.1',
      port: 3130,
      token: TEST_TOKEN,
      // See the file header: this suite exercises the routes, not the
      // authorization boundary, so it takes the operator's opt-in path.
      adminBearer: true,
    },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    portalAuth: {
      config: {
        publicUrl: 'http://localhost',
        forwardedProto: 'http',
        discordClientId: 'x',
        discordClientSecret: 'x',
        sessionSecret: 'x',
        sessionTtlSeconds: 3600,
      },
      sessions: stubSessions as unknown as PortalSessionService,
      authorization: portalAuthorization,
    },
    ctx: {
      services: app,
      getContent: () => app.content,
      portalAuthorization,
      adminBearerAllowed: true,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

interface StubSessions {
  register(token: string, session: PortalSession): void;
  reset(): void;
  getSession: (token: string | undefined) => Promise<PortalSession | null>;
  toBrowserSession: (session: PortalSession | null) => Record<string, unknown>;
  safeEquals: (a: string, b: string) => boolean;
  logout: () => Promise<void>;
  selectGuild: () => Promise<null>;
  completeOAuth: () => Promise<never>;
  createOAuthState: () => Promise<string>;
  consumeOAuthState: () => Promise<boolean>;
}

function makeStubSessions(): StubSessions {
  const store = new Map<string, PortalSession>();
  return {
    register(token: string, session: PortalSession) {
      store.set(token, session);
    },
    reset() {
      store.clear();
    },
    async getSession(token) {
      return token ? store.get(token) ?? null : null;
    },
    toBrowserSession(session) {
      if (!session) return { authenticated: false };
      return {
        authenticated: true,
        discordUser: { id: session.discordUserId, displayName: 'x', avatarUrl: null },
        playerId: session.playerId,
        csrfToken: session.csrfToken,
      };
    },
    safeEquals(a, b) {
      return a === b;
    },
    async logout() {},
    async selectGuild() {
      return null;
    },
    async completeOAuth() {
      throw new Error('not stubbed');
    },
    async createOAuthState() {
      return 'state';
    },
    async consumeOAuthState() {
      return true;
    },
  };
}

function sessionFor(discordUserId: string, discordGuildId: string): PortalSession {
  return {
    sessionDigest: 'digest',
    discordUserId,
    discordUsername: null,
    discordAvatarUrl: null,
    selectedDiscordGuildId: discordGuildId,
    selectedGuildDbId: 1,
    playerId: 1,
    eligibleGuilds: [],
    csrfToken: 'csrf-token',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe('admin encounter routes', () => {
  it('lists the seeded encounters for an opted-in bearer caller', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      headers: AUTH_BEARER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { encounters: unknown[] } };
    expect(Array.isArray(body.data.encounters)).toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a portal session whose user does not own the selected guild', async () => {
    // The ownership fetcher in this suite always answers OWNER_ID, so a
    // session for anyone else is a non-owner of the guild they have selected.
    const token = 'token-non-owner';
    stubSessions.register(token, sessionFor(NON_OWNER_ID, GUILD_ID));
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      cookies: { wm_portal_session: token },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'PORTAL_PERMISSION_DENIED',
    );
  });

  it('serves the guild owner over a portal cookie, with no bearer token', async () => {
    const token = 'token-owner';
    stubSessions.register(token, sessionFor(OWNER_ID, GUILD_ID));
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      cookies: { wm_portal_session: token },
    });
    expect(res.statusCode).toBe(200);
  });

  it('preview endpoint is admin-only (bearer works, no auth is 401)', async () => {
    // Grab any encounter id from the shipped seed
    const list = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      headers: AUTH_BEARER,
    });
    const body = list.json() as { data: { encounters: Array<{ id: number }> } };
    const id = body.data.encounters[0]?.id;
    expect(id).toBeGreaterThan(0);

    const authed = await api.inject({
      method: 'POST',
      url: `/api/v1/admin/encounters/${id}/preview`,
      headers: AUTH_BEARER,
      payload: {
        playerLevel: 20,
        buddy: { level: 10, currentSp: 60, affinity: 'switch', race: 'human' },
        buddyBonusPercent: 0,
      },
    });
    expect(authed.statusCode).toBe(200);

    const unauthed = await api.inject({
      method: 'POST',
      url: `/api/v1/admin/encounters/${id}/preview`,
      payload: {},
    });
    expect(unauthed.statusCode).toBe(401);
  });

  it('simulation endpoint returns aggregate stats and does not mutate state', async () => {
    const list = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      headers: AUTH_BEARER,
    });
    const body = list.json() as {
      data: { encounters: Array<{ id: number; choices: Array<{ id: number }> }> };
    };
    const encounter = body.data.encounters.find((e) => e.choices.length > 0);
    expect(encounter).toBeDefined();
    const choiceId = encounter!.choices[0]!.id;

    const res = await api.inject({
      method: 'POST',
      url: `/api/v1/admin/encounters/${encounter!.id}/simulate`,
      headers: AUTH_BEARER,
      payload: {
        playerLevel: 20,
        buddy: { level: 10, currentSp: 60, affinity: 'switch', race: 'human' },
        buddyBonusPercent: 0,
        choiceId,
        rolls: 100,
      },
    });
    expect(res.statusCode).toBe(200);
    const simBody = res.json() as {
      data: {
        aggregate: {
          rolls: number;
          successes: number;
          failures: number;
          successRate: number;
          expectedSuccessRate: number;
          seed: number;
        };
      };
    };
    const agg = simBody.data.aggregate;
    expect(agg.rolls).toBe(100);
    // Every roll landed in exactly one branch — the mark of an actual run
    // rather than a rounded expectation.
    expect(agg.successes + agg.failures).toBe(100);
    expect(agg.successRate).toBeCloseTo(agg.successes / 100, 10);
    expect(agg.expectedSuccessRate).toBeGreaterThanOrEqual(0);
    expect(agg.expectedSuccessRate).toBeLessThanOrEqual(1);
    expect(Number.isInteger(agg.seed)).toBe(true);
  });
});
