/**
 * The integration credential's boundary, over HTTP with no database.
 *
 * The property under test is that an `Integration` key is a *narrow*
 * credential: it reads opted-in integration routes and nothing else, whatever
 * route exists today or is added later. Two probe routes stand in for the real
 * integration endpoint so these tests do not depend on it; the sweep across
 * every route in the OpenAPI document is what keeps "nothing else" true as the
 * API grows.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { IntegrationApiConfig } from '../../../src/config/config';
import { parseIntegrationConfig } from '../../../src/config/config';
import {
  createIntegrationRateLimiter,
  parseIntegrationCredential,
} from '../../../src/api/integrationAuth';
import { isPublicPath } from '../../../src/api/auth';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { PORTAL_SESSION_COOKIE, type PortalSessionService } from '../../../src/api/portalSession';
import { ConfigError } from '../../../src/shared/errors';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
  type CapturedLogger,
} from '../../helpers/platformApiFixtures';

const GUILD = '111111111111111111';
const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const INTEGRATION: IntegrationApiConfig = {
  guildId: GUILD,
  keys: [
    { keyId: 'gallery-2026a', secretSha256: sha(SECRET_A) },
    { keyId: 'gallery-2026b', secretSha256: sha(SECRET_B) },
  ],
};

const KEY_A = { authorization: `Integration gallery-2026a.${SECRET_A}` };
const KEY_B = { authorization: `Integration gallery-2026b.${SECRET_B}` };
const BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const PORTAL = { cookie: `${PORTAL_SESSION_COOKIE}=player-session` };

/** A session store that knows exactly one cookie. */
const sessions = {
  async getSession(token: string | undefined) {
    if (token !== 'player-session') return null;
    return {
      sessionDigest: token,
      discordUserId: '900000000000000001',
      discordUsername: 'Mika',
      discordAvatarUrl: null,
      selectedDiscordGuildId: GUILD,
      selectedGuildDbId: 1,
      playerId: 1,
      eligibleGuilds: [],
      csrfToken: 'csrf',
      expiresAt: new Date(Date.now() + 60_000),
    };
  },
  toBrowserSession: (session: unknown) => ({ authenticated: session !== null }),
} as unknown as PortalSessionService;

let api: ZodFastify;
let log: CapturedLogger;

/** `null` = no integration configured (an explicit value, so the default does not apply). */
async function build(
  integration: IntegrationApiConfig | null = INTEGRATION,
  limiter = createIntegrationRateLimiter({ burst: 10_000, perMinute: 60_000 }),
): Promise<ZodFastify> {
  log = createCapturedLogger();
  const app = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3198, token: TEST_TOKEN },
    integration: integration ?? undefined,
    integrationRateLimiter: limiter,
    logger: log.logger,
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
      sessions,
    },
    ctx: createApiContext(),
  });
  // Stand-ins for the real integration routes: one opted in, one under the
  // prefix that did not opt in. Added before `ready`, like any plugin route.
  app.get(
    '/api/v1/integrations/__probe',
    { config: { integrationRoute: true }, schema: { querystring: z.object({}).passthrough() } },
    async () => ({ data: { ok: true } }),
  );
  app.post(
    '/api/v1/integrations/__probe',
    { config: { integrationRoute: true } },
    async () => ({ data: { wrote: true } }),
  );
  app.get('/api/v1/integrations/__not_opted_in', async () => ({ data: { leaked: true } }));
  return app;
}

beforeEach(async () => {
  api = await build();
});

afterEach(async () => {
  await api?.close();
});

describe('integration credential', () => {
  it('admits a valid key on an opted-in GET route', async () => {
    const res = await api.inject({ method: 'GET', url: '/api/v1/integrations/__probe', headers: KEY_A });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { ok: true } });
  });

  it('admits HEAD on the same route', async () => {
    const res = await api.inject({ method: 'HEAD', url: '/api/v1/integrations/__probe', headers: KEY_A });
    expect(res.statusCode).toBe(200);
  });

  it('accepts every configured key during rotation', async () => {
    for (const headers of [KEY_A, KEY_B]) {
      const res = await api.inject({ method: 'GET', url: '/api/v1/integrations/__probe', headers });
      expect(res.statusCode).toBe(200);
    }
  });

  it('refuses a revoked key once its entry is removed', async () => {
    await api.close();
    api = await build({ guildId: GUILD, keys: [INTEGRATION.keys[1]!] });
    const revoked = await api.inject({ method: 'GET', url: '/api/v1/integrations/__probe', headers: KEY_A });
    expect(revoked.statusCode).toBe(401);
    const current = await api.inject({ method: 'GET', url: '/api/v1/integrations/__probe', headers: KEY_B });
    expect(current.statusCode).toBe(200);
  });

  it('answers every bad credential with the same 401 body', async () => {
    const bad = [
      'Integration gallery-2026a.wrong-secret',
      `Integration unknown-key.${SECRET_A}`,
      `Integration gallery-2026a.${SECRET_B}`,
      'Integration gallery-2026a',
      'Integration .secret',
      'Integration gallery-2026a.',
      'Integration ',
      `Integration ${sha(SECRET_A)}`,
    ];
    const bodies = new Set<string>();
    for (const authorization of bad) {
      const res = await api.inject({
        method: 'GET',
        url: '/api/v1/integrations/__probe',
        headers: { authorization },
      });
      expect(res.statusCode, authorization).toBe(401);
      const { requestId: _id, ...body } = res.json() as { requestId: string };
      bodies.add(JSON.stringify(body));
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } })]);
  });

  it('refuses every key when no integration is configured', async () => {
    await api.close();
    api = await build(null);
    const res = await api.inject({ method: 'GET', url: '/api/v1/integrations/__probe', headers: KEY_A });
    expect(res.statusCode).toBe(401);
  });

  it('never falls back to a Portal session when the integration credential is bad', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/integrations/__probe',
      headers: { authorization: 'Integration gallery-2026a.nope', ...PORTAL },
    });
    expect(res.statusCode).toBe(401);
  });

  it('never logs the secret or the presented header', async () => {
    await api.inject({ method: 'GET', url: '/api/v1/integrations/__probe', headers: KEY_A });
    await api.inject({
      method: 'GET',
      url: '/api/v1/integrations/__probe',
      headers: { authorization: `Integration gallery-2026a.${SECRET_B}` },
    });
    await api.inject({ method: 'GET', url: '/api/v1/players/1', headers: KEY_A });
    expect(log.text()).not.toContain(SECRET_A);
    expect(log.text()).not.toContain(SECRET_B);
  });
});

describe('integration allowlist', () => {
  it('refuses writes even on an opted-in route', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await api.inject({ method, url: '/api/v1/integrations/__probe', headers: KEY_A, payload: {} });
      expect(res.statusCode, method).toBe(403);
      expect(res.json().error.code).toBe('INTEGRATION_FORBIDDEN');
    }
  });

  it('refuses an integration-prefixed route that did not opt in', async () => {
    const res = await api.inject({ method: 'GET', url: '/api/v1/integrations/__not_opted_in', headers: KEY_A });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('leaked');
  });

  it('refuses unknown paths rather than leaking a 404 map', async () => {
    const res = await api.inject({ method: 'GET', url: '/api/v1/integrations/nope', headers: KEY_A });
    expect(res.statusCode).toBe(403);
  });

  it('refuses path tricks that try to leave the prefix', async () => {
    for (const url of [
      '/api/v1/integrations/../players/1',
      '/api/v1/integrations/%2e%2e/players/1',
      '/api/v1//integrations/__probe',
      '/API/V1/INTEGRATIONS/__probe',
    ]) {
      const res = await api.inject({ method: 'GET', url, headers: KEY_A });
      expect(res.statusCode, url).toBe(403);
    }
  });

  /**
   * The sweep. Every operation in the OpenAPI document, every method it
   * declares, with sample path parameters: an integration key gets 403 on all
   * of them. A route added later is covered without editing this test.
   */
  it('refuses every documented player, admin and system route', async () => {
    const spec = (await api.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const tried: string[] = [];
    for (const [rawPath, operations] of Object.entries(spec.paths)) {
      // Integration routes are the allowed surface; the OAuth and health paths
      // are public to everyone and never read a credential at all.
      if (rawPath.startsWith('/api/v1/integrations/') || isPublicPath(rawPath)) continue;
      const url = rawPath.replace(/\{[^}]+\}/g, '1');
      for (const method of Object.keys(operations)) {
        const verb = method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        const res = await api.inject({ method: verb, url, headers: KEY_A, ...(verb === 'GET' ? {} : { payload: {} }) });
        tried.push(`${verb} ${url}`);
        if (res.statusCode !== 403) throw new Error(`${verb} ${url} answered ${res.statusCode}`);
      }
    }
    // Sanity: the sweep really did cover the admin and player surfaces.
    expect(tried.some((t) => t.includes('/admin/'))).toBe(true);
    expect(tried.some((t) => t.startsWith('PUT '))).toBe(true);
    expect(tried.some((t) => t.startsWith('POST '))).toBe(true);
    expect(tried.length).toBeGreaterThan(100);
  });

  it('refuses /metrics', async () => {
    const res = await api.inject({ method: 'GET', url: '/metrics', headers: KEY_A });
    expect(res.statusCode).toBe(403);
  });

  it('leaves the bearer token and Portal session working on their own routes', async () => {
    const bearer = await api.inject({ method: 'GET', url: '/api/v1/openapi.json', headers: BEARER });
    expect(bearer.statusCode).toBe(200);
    const session = await api.inject({ method: 'GET', url: '/auth/session', headers: PORTAL });
    expect(session.statusCode).toBe(200);
  });
});

describe('integration rate limit', () => {
  it('answers 429 with Retry-After once a key spends its burst, per key', async () => {
    let now = 0;
    await api.close();
    api = await build(INTEGRATION, createIntegrationRateLimiter({ burst: 3, perMinute: 30, now: () => now }));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await api.inject({ method: 'GET', url: '/api/v1/integrations/__probe', headers: KEY_A })).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await api.inject({ method: 'GET', url: '/api/v1/integrations/__probe', headers: KEY_A });
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBe('2');
    // Another key has its own bucket.
    expect((await api.inject({ method: 'GET', url: '/api/v1/integrations/__probe', headers: KEY_B })).statusCode).toBe(200);
    // 30/min refills one token every 2 s.
    now += 2_000;
    expect((await api.inject({ method: 'GET', url: '/api/v1/integrations/__probe', headers: KEY_A })).statusCode).toBe(200);
  });
});

describe('parseIntegrationCredential', () => {
  it('splits at the first dot and rejects anything else', () => {
    expect(parseIntegrationCredential('k.s.with.dots')).toEqual({ keyId: 'k', secret: 's.with.dots' });
    expect(parseIntegrationCredential('nodot')).toBeNull();
    expect(parseIntegrationCredential('.s')).toBeNull();
    expect(parseIntegrationCredential('k.')).toBeNull();
    expect(parseIntegrationCredential('k .s')).toBeNull();
  });
});

describe('parseIntegrationConfig', () => {
  const ok = `gallery-2026a:${sha(SECRET_A)}, gallery-2026b:${sha(SECRET_B).toUpperCase()}`;

  it('is off when both variables are unset', () => {
    expect(parseIntegrationConfig(undefined, undefined, true)).toBeUndefined();
    expect(parseIntegrationConfig('  ', '', false)).toBeUndefined();
  });

  it('parses keys, lowercases hashes, and keeps the guild', () => {
    expect(parseIntegrationConfig(ok, GUILD, true)).toEqual({
      guildId: GUILD,
      keys: [
        { keyId: 'gallery-2026a', secretSha256: sha(SECRET_A) },
        { keyId: 'gallery-2026b', secretSha256: sha(SECRET_B) },
      ],
    });
  });

  it.each([
    ['API disabled', ok, GUILD, false, /PLATFORM_API_ENABLED/],
    ['keys without guild', ok, undefined, true, /GUILD_ID is empty/],
    ['guild without keys', undefined, GUILD, true, /KEYS is empty/],
    ['bad guild', ok, 'not-a-guild', true, /snowflake/],
    ['missing colon', 'gallery-2026a', GUILD, true, /key id/],
    ['short hash', 'gallery-2026a:abcd', GUILD, true, /64 hex/],
    ['plaintext secret', `gallery-2026a:${SECRET_A}x`, GUILD, true, /64 hex/],
    ['bad key id', `bad id:${sha('x')}`, GUILD, true, /key id/],
    ['duplicate key id', `k:${sha('x')},k:${sha('y')}`, GUILD, true, /more than once/],
  ])('refuses %s', (_label, keys, guild, enabled, message) => {
    expect(() => parseIntegrationConfig(keys, guild, enabled)).toThrow(ConfigError);
    expect(() => parseIntegrationConfig(keys, guild, enabled)).toThrow(message);
  });

  it('never echoes a hash in an error', () => {
    try {
      parseIntegrationConfig(`k:${sha('x')},k:${sha('y')}`, GUILD, true);
    } catch (err) {
      expect(String(err)).not.toContain(sha('x'));
    }
  });
});
