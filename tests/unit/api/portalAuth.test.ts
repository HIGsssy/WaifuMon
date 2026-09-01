import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import {
  PORTAL_CSRF_COOKIE,
  PORTAL_CSRF_HEADER,
  PORTAL_OAUTH_STATE_COOKIE,
  PORTAL_SESSION_COOKIE,
  type PortalSession,
  type PortalSessionService,
} from '../../../src/api/portalSession';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
} from '../../helpers/platformApiFixtures';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const PORTAL_CONFIG = {
  publicUrl: 'https://portal.playwaifumon.online',
  forwardedProto: 'https' as const,
  discordClientId: 'client-id',
  discordClientSecret: 'client-secret',
  sessionSecret: 'x'.repeat(64),
  sessionTtlSeconds: 604800,
};

const PLAYER = {
  id: 7,
  guildId: 3,
  discordUserId: '111',
  xp: 0,
  level: 1,
  buddyWaifuId: null,
  showcase: null,
  lastHuntAt: null,
  careModeStartedAt: null,
  careModeLastTickAt: null,
  careModeWaifuId: null,
  currentRegion: 'waifu-valley',
  settings: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const ELIGIBLE = {
  discordGuildId: '222',
  guildDbId: 3,
  playerId: 7,
  name: 'Waifu Server',
  iconUrl: null,
};

function portalSession(overrides: Partial<PortalSession> = {}): PortalSession {
  return {
    sessionDigest: 'digest',
    discordUserId: '111',
    discordUsername: 'Tester',
    discordAvatarUrl: null,
    selectedDiscordGuildId: '222',
    selectedGuildDbId: 3,
    playerId: 7,
    eligibleGuilds: [ELIGIBLE],
    csrfToken: 'csrf-token',
    expiresAt: new Date('2026-09-08T00:00:00.000Z'),
    ...overrides,
  };
}

function fakeSessions(session: PortalSession | null = portalSession()): PortalSessionService {
  return {
    createOAuthState: vi.fn(async () => 'state-123'),
    consumeOAuthState: vi.fn(async (state: string) => state === 'state-123'),
    completeOAuth: vi.fn(async () => ({ token: 'session-token', session: portalSession() })),
    getSession: vi.fn(async (token?: string) => (token === 'session-token' ? session : null)),
    logout: vi.fn(async () => {}),
    selectGuild: vi.fn(async (_s, guildId: string) => (guildId === '222' ? portalSession() : null)),
    toBrowserSession: vi.fn((s: PortalSession | null) =>
      s
        ? {
            authenticated: true,
            discordUser: { id: '111', displayName: 'Tester', avatarUrl: null },
            selectedGuild: s.playerId ? ELIGIBLE : null,
            playerId: s.playerId,
            eligibleGuilds: s.eligibleGuilds,
            needsGuildSelection: s.playerId === null && s.eligibleGuilds.length > 1,
            noProfile: s.eligibleGuilds.length === 0,
            csrfToken: s.csrfToken,
          }
        : { authenticated: false },
    ),
    safeEquals: (a: string, b: string) => a === b,
  } as unknown as PortalSessionService;
}

async function build(sessions = fakeSessions()): Promise<ZodFastify> {
  return createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3120, token: TEST_TOKEN },
    portalAuth: { config: PORTAL_CONFIG, sessions },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: createApiContext({
      services: {
        players: { getById: async (id: number) => (id === 7 ? PLAYER : { ...PLAYER, id }) },
      },
    }),
  });
}

let app: ZodFastify | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('Portal OAuth/session routes', () => {
  it('generates state and redirects to Discord with identify and guilds scopes', async () => {
    const sessions = fakeSessions();
    app = await build(sessions);
    const res = await app.inject({ method: 'GET', url: '/auth/discord' });

    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(location.searchParams.get('client_id')).toBe('client-id');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://portal.playwaifumon.online/auth/discord/callback',
    );
    expect(location.searchParams.get('scope')).toBe('identify guilds');
    expect(location.searchParams.get('state')).toBe('state-123');
    expect(String(res.headers['set-cookie'])).toContain(PORTAL_OAUTH_STATE_COOKIE);
  });

  it('rejects state mismatch before exchanging the code', async () => {
    const sessions = fakeSessions();
    app = await build(sessions);
    const res = await app.inject({
      method: 'GET',
      url: '/auth/discord/callback?code=abc&state=query-state',
      cookies: { [PORTAL_OAUTH_STATE_COOKIE]: 'cookie-state' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('OAUTH_STATE_INVALID');
    expect(sessions.completeOAuth).not.toHaveBeenCalled();
  });

  it('rejects expired or replayed state', async () => {
    const sessions = fakeSessions();
    vi.mocked(sessions.consumeOAuthState).mockResolvedValue(false);
    app = await build(sessions);
    const res = await app.inject({
      method: 'GET',
      url: '/auth/discord/callback?code=abc&state=state-123',
      cookies: { [PORTAL_OAUTH_STATE_COOKIE]: 'state-123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('OAUTH_STATE_INVALID');
    expect(sessions.completeOAuth).not.toHaveBeenCalled();
  });

  it('handles Discord denial without creating a session', async () => {
    const sessions = fakeSessions();
    app = await build(sessions);
    const res = await app.inject({ method: 'GET', url: '/auth/discord/callback?error=access_denied' });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toBe('https://portal.playwaifumon.online/select-player?auth=denied');
    expect(sessions.completeOAuth).not.toHaveBeenCalled();
  });

  it('creates a session cookie with HttpOnly, Secure and SameSite=Lax', async () => {
    app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/discord/callback?code=abc&state=state-123',
      cookies: { [PORTAL_OAUTH_STATE_COOKIE]: 'state-123' },
    });
    expect(res.statusCode).toBe(302);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain(`${PORTAL_SESSION_COOKIE}=session-token`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('returns unauthenticated session state without a cookie', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/auth/session' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authenticated: false });
  });

  it('logs out by invalidating the session and clearing cookies', async () => {
    const sessions = fakeSessions();
    app = await build(sessions);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [PORTAL_SESSION_COOKIE]: 'session-token', [PORTAL_CSRF_COOKIE]: 'csrf-token' },
      headers: { [PORTAL_CSRF_HEADER]: 'csrf-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(sessions.logout).toHaveBeenCalledWith('session-token');
    expect(String(res.headers['set-cookie'])).toContain(`${PORTAL_SESSION_COOKIE}=`);
  });

  it('allows only server-derived guild selection', async () => {
    app = await build();
    const allowed = await app.inject({
      method: 'POST',
      url: '/auth/guild',
      cookies: { [PORTAL_SESSION_COOKIE]: 'session-token', [PORTAL_CSRF_COOKIE]: 'csrf-token' },
      headers: { [PORTAL_CSRF_HEADER]: 'csrf-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ discordGuildId: '222' }),
    });
    expect(allowed.statusCode).toBe(200);

    const denied = await app.inject({
      method: 'POST',
      url: '/auth/guild',
      cookies: { [PORTAL_SESSION_COOKIE]: 'session-token', [PORTAL_CSRF_COOKIE]: 'csrf-token' },
      headers: { [PORTAL_CSRF_HEADER]: 'csrf-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ discordGuildId: '999' }),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('rejects expired sessions on API requests', async () => {
    app = await build(fakeSessions(null));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/7',
      cookies: { [PORTAL_SESSION_COOKIE]: 'session-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('prevents player-id URL manipulation for Portal sessions', async () => {
    app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/8',
      cookies: { [PORTAL_SESSION_COOKIE]: 'session-token' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('Not found.');
  });

  it('keeps bearer-token clients working as before', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/players/8', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(8);
  });
});
