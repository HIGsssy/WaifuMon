/**
 * The Portal admin authorization boundary, exercised over real HTTP.
 *
 * These run through `app.inject()` against a fully-registered Platform API, so
 * every layer that a browser would actually traverse is in play: the
 * `onRequest` auth hook, the CSRF double-submit check, the permission guard,
 * and the route handler. That matters — a unit test of
 * `requirePortalPermission` proves the helper works, not that the helper is
 * reached, and CSRF in particular is enforced *before* the guard by a
 * completely different piece of code.
 *
 * The service double throws on any method that is not stubbed, which is what
 * makes "the handler was never reached" an assertion rather than an
 * assumption: a request that should have been rejected but was not would
 * either return the stub's data or blow up loudly.
 *
 * No database and no Discord gateway. Guild ownership is a closure the test
 * controls, which is exactly how the real service takes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  PORTAL_CSRF_COOKIE,
  PORTAL_CSRF_HEADER,
  PORTAL_SESSION_COOKIE,
  type PortalSession,
  type PortalSessionService,
} from '../../../src/api/portalSession';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
} from '../../helpers/platformApiFixtures';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

const OWNER_DISCORD_ID = '111';
const STRANGER_DISCORD_ID = '999';
const GUILD_A = '222';
const GUILD_B = '333';
const CSRF = 'csrf-token';
const SESSION_TOKEN = 'session-token';

const PORTAL_CONFIG = {
  publicUrl: 'https://portal.playwaifumon.online',
  forwardedProto: 'https' as const,
  discordClientId: 'client-id',
  discordClientSecret: 'client-secret',
  sessionSecret: 'x'.repeat(64),
  sessionTtlSeconds: 604800,
};

/** One shipped encounter, enough for a list/update round trip. */
const ENCOUNTER = {
  id: 5,
  slug: 'tv_bandit_ambush',
  name: 'Bandit Ambush',
  description: 'Rough company on the road.',
  type: 'combat' as const,
  rarity: 'common' as const,
  weight: 10,
  lifecycle: 'active' as const,
  huntEligible: true,
  travelEligible: true,
  cooldownSeconds: 900,
  artworkPath: null,
  chainedEncounterSlug: null,
  choicesRequired: true,
  regions: ['waifu-valley'],
  routes: [],
  metadata: {},
  choices: [
    {
      id: 51,
      sortOrder: 0,
      label: 'Fight',
      emoji: null,
      requirements: {},
      check: { type: 'sp' as const, difficulty: 30 },
      successEffects: [{ type: 'waifubux_gain' as const, amount: 100 }],
      failureEffects: [{ type: 'waifubux_loss' as const, amount: 50 }],
    },
  ],
};

/** The settings the double reports as live. */
const SETTINGS = {
  huntChance: 0.35,
  travelChance: 0.2,
  defaultExpirySeconds: 600,
  forceTrigger: false,
  updatedAt: null,
  updatedBy: null,
};

function portalSession(overrides: Partial<PortalSession> = {}): PortalSession {
  return {
    sessionDigest: 'digest',
    discordUserId: OWNER_DISCORD_ID,
    discordUsername: 'Tester',
    discordAvatarUrl: null,
    selectedDiscordGuildId: GUILD_A,
    selectedGuildDbId: 3,
    playerId: 7,
    eligibleGuilds: [
      {
        discordGuildId: GUILD_A,
        guildDbId: 3,
        playerId: 7,
        name: 'Guild A',
        iconUrl: null,
      },
      {
        discordGuildId: GUILD_B,
        guildDbId: 4,
        playerId: 8,
        name: 'Guild B',
        iconUrl: null,
      },
    ],
    csrfToken: CSRF,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function fakeSessions(session: PortalSession | null): PortalSessionService {
  return {
    createOAuthState: vi.fn(async () => 'state-123'),
    consumeOAuthState: vi.fn(async () => true),
    completeOAuth: vi.fn(),
    getSession: vi.fn(async (token?: string) => (token === SESSION_TOKEN ? session : null)),
    logout: vi.fn(async () => {}),
    // Guild switching swaps the selected guild on the session it returns —
    // the same thing the real service does, which is what makes the
    // recomputed-permissions assertion meaningful.
    selectGuild: vi.fn(async (s: PortalSession, guildId: string) =>
      s.eligibleGuilds.some((g) => g.discordGuildId === guildId)
        ? portalSession({ selectedDiscordGuildId: guildId })
        : null,
    ),
    toBrowserSession: vi.fn((s: PortalSession | null) =>
      s
        ? {
            authenticated: true,
            discordUser: { id: s.discordUserId, displayName: 'Tester', avatarUrl: null },
            selectedGuild: s.eligibleGuilds.find(
              (g) => g.discordGuildId === s.selectedDiscordGuildId,
            ),
            playerId: s.playerId,
            eligibleGuilds: s.eligibleGuilds,
            csrfToken: s.csrfToken,
          }
        : { authenticated: false },
    ),
    safeEquals: (a: string, b: string) => a === b,
  } as unknown as PortalSessionService;
}

/** Ownership oracle: `owns` maps guild id → owner's Discord id. */
function authorizationFor(owns: Record<string, string | null>, opts: { fail?: boolean } = {}) {
  return createPortalAuthorizationService({
    guildOwnership: createGuildOwnershipService({
      fetchOwnerId: async (guildId) => {
        if (opts.fail) throw new Error('discord unreachable');
        return owns[guildId] ?? null;
      },
    }),
  });
}

interface BuildOpts {
  session?: PortalSession | null;
  owns?: Record<string, string | null>;
  ownershipFails?: boolean;
  adminBearerAllowed?: boolean;
  /** Wire no permission oracle at all — the bot-less deployment shape. */
  noAuthorization?: boolean;
  upsert?: (input: never) => Promise<typeof ENCOUNTER>;
  updateSettings?: (patch: unknown, actor: string | null) => Promise<typeof SETTINGS>;
}

async function build(opts: BuildOpts = {}): Promise<ZodFastify> {
  const sessions = fakeSessions(opts.session === undefined ? portalSession() : opts.session);
  const authorization = authorizationFor(opts.owns ?? { [GUILD_A]: OWNER_DISCORD_ID }, {
    ...(opts.ownershipFails ? { fail: true } : {}),
  });
  return createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3120, token: TEST_TOKEN },
    portalAuth: { config: PORTAL_CONFIG, sessions, authorization },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: createApiContext({
      services: {
        worldEncounterSettings: {
          get: async () => SETTINGS,
          getCached: () => SETTINGS,
          invalidate: () => {},
          update: opts.updateSettings ?? (async () => SETTINGS),
        },
        worldEncounterAdmin: {
          list: async () => [ENCOUNTER],
          get: async (id: number) => (id === ENCOUNTER.id ? ENCOUNTER : null),
          ...(opts.upsert ? { upsert: opts.upsert } : {}),
        },
      },
      ...(opts.noAuthorization ? {} : { portalAuthorization: authorization }),
      ...(opts.adminBearerAllowed === undefined
        ? {}
        : { adminBearerAllowed: opts.adminBearerAllowed }),
    }),
  });
}

/** Cookie header for an authenticated Portal browser session. */
function browserCookies(csrf: string | null = CSRF): string {
  const parts = [`${PORTAL_SESSION_COOKIE}=${SESSION_TOKEN}`];
  if (csrf !== null) parts.push(`${PORTAL_CSRF_COOKIE}=${csrf}`);
  return parts.join('; ');
}

const VALID_ENCOUNTER_BODY = {
  slug: 'tv_bandit_ambush',
  name: 'Bandit Ambush',
  description: 'Rough company on the road.',
  type: 'combat',
  rarity: 'common',
  weight: 10,
  lifecycle: 'draft',
  huntEligible: true,
  travelEligible: true,
  cooldownSeconds: 900,
  choicesRequired: true,
  regions: ['waifu-valley'],
  routes: [],
  choices: [
    {
      label: 'Fight',
      check: { type: 'sp', difficulty: 30 },
      successEffects: [{ type: 'waifubux_gain', amount: 100 }],
      failureEffects: [],
    },
  ],
};

let app: ZodFastify | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('admin encounters: bearer trust boundary', () => {
  it('denies a bearer request by default — the API token is not an admin credential', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/encounters', headers: AUTH });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
  });

  it('allows a bearer request only when the operator opted in', async () => {
    app = await build({ adminBearerAllowed: true });
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/encounters', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.encounters).toHaveLength(1);
  });

  it('rejects a request carrying no credential at all', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/encounters' });

    expect(res.statusCode).toBe(401);
  });
});

describe('admin encounters: guild-scoped authorization', () => {
  it('allows the owner of the currently selected guild', async () => {
    app = await build({ owns: { [GUILD_A]: OWNER_DISCORD_ID } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      headers: { cookie: browserCookies() },
    });

    expect(res.statusCode).toBe(200);
  });

  it('denies someone who is merely a member of the selected guild', async () => {
    app = await build({ owns: { [GUILD_A]: STRANGER_DISCORD_ID } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      headers: { cookie: browserCookies() },
    });

    expect(res.statusCode).toBe(403);
  });

  it('denies the owner of guild A while guild B is the selected one', async () => {
    // The session user owns A. They have B selected. Owning *something* is
    // not the question the guard asks.
    app = await build({
      session: portalSession({ selectedDiscordGuildId: GUILD_B }),
      owns: { [GUILD_A]: OWNER_DISCORD_ID, [GUILD_B]: STRANGER_DISCORD_ID },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      headers: { cookie: browserCookies() },
    });

    expect(res.statusCode).toBe(403);
  });

  it('denies when the ownership lookup is unavailable', async () => {
    app = await build({ ownershipFails: true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      headers: { cookie: browserCookies() },
    });

    expect(res.statusCode).toBe(403);
  });

  it('denies when no permission oracle is wired at all (bot-less deployment)', async () => {
    app = await build({ noAuthorization: true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      headers: { cookie: browserCookies() },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('admin encounters: CSRF on cookie-authenticated mutations', () => {
  it('rejects a mutation with no CSRF token, before the handler runs', async () => {
    const upsert = vi.fn(async () => ENCOUNTER);
    app = await build({ upsert });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/encounters',
      headers: { cookie: browserCookies(null) },
      payload: { input: VALID_ENCOUNTER_BODY },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_CSRF_INVALID');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a mutation whose CSRF header does not match the cookie', async () => {
    const upsert = vi.fn(async () => ENCOUNTER);
    app = await build({ upsert });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/encounters',
      headers: {
        cookie: browserCookies(),
        [PORTAL_CSRF_HEADER]: 'not-the-right-token',
      },
      payload: { input: VALID_ENCOUNTER_BODY },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_CSRF_INVALID');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a mutation whose CSRF cookie is missing even though the header is right', async () => {
    const upsert = vi.fn(async () => ENCOUNTER);
    app = await build({ upsert });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/encounters',
      headers: { cookie: browserCookies(null), [PORTAL_CSRF_HEADER]: CSRF },
      payload: { input: VALID_ENCOUNTER_BODY },
    });

    expect(res.statusCode).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reaches the authorized handler with a valid double-submit token', async () => {
    const upsert = vi.fn(async () => ENCOUNTER);
    app = await build({ upsert });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/encounters',
      headers: { cookie: browserCookies(), [PORTAL_CSRF_HEADER]: CSRF },
      payload: { input: VALID_ENCOUNTER_BODY },
    });

    expect(res.statusCode).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('still refuses a valid CSRF token from a session that is not the guild owner', async () => {
    // CSRF and authorization are independent gates; passing one must not
    // imply the other.
    const upsert = vi.fn(async () => ENCOUNTER);
    app = await build({ upsert, owns: { [GUILD_A]: STRANGER_DISCORD_ID } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/encounters',
      headers: { cookie: browserCookies(), [PORTAL_CSRF_HEADER]: CSRF },
      payload: { input: VALID_ENCOUNTER_BODY },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('global encounter settings: the same boundary as the rest of the namespace', () => {
  it('serves the effective values, with bounds, to the guild owner', async () => {
    app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters/settings',
      headers: { cookie: browserCookies() },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.huntChance).toBe(0.35);
    expect(body.forceTrigger).toBe(false);
    // Bounds ship with the values so the panel does not hard-code its own.
    expect(body.bounds.chance).toEqual({ min: 0, max: 1 });
    expect(body.bounds.expirySeconds).toEqual({ min: 30, max: 86400 });
  });

  it('refuses a read from a non-owner', async () => {
    app = await build({ owns: { [GUILD_A]: STRANGER_DISCORD_ID } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters/settings',
      headers: { cookie: browserCookies() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a bearer read by default, like every other admin route', async () => {
    app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters/settings',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a save with no CSRF token, before the handler runs', async () => {
    const updateSettings = vi.fn(async (_patch: unknown, _actor: string | null) => SETTINGS);
    app = await build({ updateSettings });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/encounters/settings',
      headers: { cookie: browserCookies(null) },
      payload: { huntChance: 0.5 },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_CSRF_INVALID');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('reaches the handler with a valid CSRF token, and takes the actor from the session', async () => {
    const updateSettings = vi.fn(async (_patch: unknown, _actor: string | null) => SETTINGS);
    app = await build({ updateSettings });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/encounters/settings',
      headers: { cookie: browserCookies(), [PORTAL_CSRF_HEADER]: CSRF },
      payload: { huntChance: 0.5, forceTrigger: true },
    });

    expect(res.statusCode).toBe(200);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0]![0]).toEqual({ huntChance: 0.5, forceTrigger: true });
    // Identity comes from the authenticated session, never from the body.
    expect(updateSettings.mock.calls[0]![1]).toBe(OWNER_DISCORD_ID);
  });

  it('refuses a save from a non-owner even with a valid CSRF token', async () => {
    const updateSettings = vi.fn(async (_patch: unknown, _actor: string | null) => SETTINGS);
    app = await build({ updateSettings, owns: { [GUILD_A]: STRANGER_DISCORD_ID } });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/encounters/settings',
      headers: { cookie: browserCookies(), [PORTAL_CSRF_HEADER]: CSRF },
      payload: { huntChance: 0.5 },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('rejects out-of-range values before reaching the service', async () => {
    const updateSettings = vi.fn(async (_patch: unknown, _actor: string | null) => SETTINGS);
    app = await build({ updateSettings });
    for (const payload of [
      { huntChance: 1.5 },
      { travelChance: -0.1 },
      { defaultExpirySeconds: 5 },
      { defaultExpirySeconds: 999_999 },
      {},
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/admin/encounters/settings',
        headers: { cookie: browserCookies(), [PORTAL_CSRF_HEADER]: CSRF },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe('guild switching recomputes permissions', () => {
  it('drops every permission when the session switches to a guild the user does not own', async () => {
    app = await build({
      owns: { [GUILD_A]: OWNER_DISCORD_ID, [GUILD_B]: STRANGER_DISCORD_ID },
    });

    const initial = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: browserCookies() },
    });
    expect(initial.json().permissions).toContain('admin.access');

    const switched = await app.inject({
      method: 'POST',
      url: '/auth/guild',
      headers: { cookie: browserCookies(), [PORTAL_CSRF_HEADER]: CSRF },
      payload: { discordGuildId: GUILD_B },
    });

    expect(switched.statusCode).toBe(200);
    // The payload *replaces* the previous permissions rather than omitting the
    // field — an omitted field would leave a cached React session holding the
    // old guild's rights.
    expect(switched.json().permissions).toEqual([]);
  });
});
