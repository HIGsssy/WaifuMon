/**
 * Platform API skeleton (plan §12 Phase 1 verification).
 *
 * Auth, the error envelope, health/readiness and the OpenAPI surface — driven
 * with Fastify's `inject()`, so nothing binds a real port here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformApiServer, isPrivateBind } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
  type CapturedLogger,
  type ProbeOverrides,
} from '../../helpers/platformApiFixtures';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

let log: CapturedLogger;
let app: ZodFastify;

async function build(probes: ProbeOverrides = {}): Promise<ZodFastify> {
  log = createCapturedLogger();
  return createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3120, token: TEST_TOKEN },
    logger: log.logger,
    probes: createProbes(probes),
    ctx: createApiContext(),
  });
}

beforeEach(async () => {
  app = await build();
});

afterEach(async () => {
  await app.close();
});

describe('construction', () => {
  it('refuses to build without a token', async () => {
    await expect(
      createPlatformApiServer({
        config: { enabled: true, host: '127.0.0.1', port: 3120, token: '  ' },
        logger: createCapturedLogger().logger,
        probes: createProbes(),
        ctx: createApiContext(),
      }),
    ).rejects.toThrow(/non-empty platform API token/);
  });
});

describe('GET /health', () => {
  it('answers 200 without a token and checks nothing', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('stays up even when every dependency is down', async () => {
    await app.close();
    app = await build({
      pingDatabase: async () => {
        throw new Error('connection refused');
      },
      describeContent: () => null,
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /ready', () => {
  it('reports every component and returns 200 when all are healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(Object.keys(body.components).sort()).toEqual([
      'content',
      'database',
      'discordClient',
      'platformApi',
    ]);
    expect(body.components.database).toMatchObject({ status: 'ok', detail: 'SELECT 1 succeeded' });
    expect(body.components.content).toMatchObject({
      status: 'ok',
      detail: 'snapshot loaded (49 species, 7 items)',
    });
    expect(body.components.platformApi.detail).toBe('listening on 127.0.0.1:3120');
    expect(Date.parse(body.checkedAt)).not.toBeNaN();
  });

  it('returns 503 with the same shape when the database is unreachable', async () => {
    await app.close();
    app = await build({
      pingDatabase: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('down');
    expect(body.components.database.status).toBe('down');
    expect(body.components.database.detail).toContain('connection refused');
    // Unaffected components still report honestly.
    expect(body.components.content.status).toBe('ok');
  });

  it('returns 503 when no content snapshot is loaded', async () => {
    await app.close();
    app = await build({ describeContent: () => null });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().components.content).toMatchObject({
      status: 'down',
      detail: 'no content snapshot loaded',
    });
  });

  it('keeps readiness green when only the Discord gateway is down (advisory in v1)', async () => {
    await app.close();
    app = await build({
      describeDiscord: () => ({ status: 'down', detail: 'gateway not connected' }),
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().components.discordClient.status).toBe('down');
  });
});

describe('authentication', () => {
  it('rejects a missing token with 401 and the error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/foo' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(res.json().requestId).toBeTruthy();
  });

  it('rejects a wrong token with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/foo',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a non-bearer scheme', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/foo',
      headers: { authorization: `Basic ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers 401 before routing, so an unknown path never leaks as a 404', async () => {
    const unauthed = await app.inject({ method: 'POST', url: '/api/v1/does-not-exist' });
    expect(unauthed.statusCode).toBe(401);

    const authed = await app.inject({
      method: 'POST',
      url: '/api/v1/does-not-exist',
      headers: AUTH,
    });
    expect(authed.statusCode).toBe(404);
    expect(authed.json().error.code).toBe('NOT_FOUND');
  });

  it('leaves /health, /ready, the docs and the spec public', async () => {
    for (const url of ['/health', '/ready', '/api/v1/docs', '/api/v1/openapi.json']) {
      const res = await app.inject({ method: 'GET', url });
      expect([200, 302]).toContain(res.statusCode);
    }
  });

  it('never writes the bearer token to the log', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/foo', headers: AUTH });
    await app.inject({
      method: 'GET',
      url: '/api/v1/foo',
      headers: { authorization: 'Bearer a-wrong-but-secret-value' },
    });
    expect(log.text()).not.toContain(TEST_TOKEN);
    expect(log.text()).not.toContain('a-wrong-but-secret-value');
    expect(log.text().toLowerCase()).not.toContain('bearer ');
    // The rejection itself is still recorded, path and method only.
    expect(log.text()).toContain('unauthorized');
  });
});

describe('response headers', () => {
  it('stamps the API version and a generated request id on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-waifumon-api-version']).toBe('1');
    expect(String(res.headers['x-request-id'])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a caller-supplied request id and reuses it in the error body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nope',
      headers: { ...AUTH, 'x-request-id': 'client-abc_123' },
    });
    expect(res.headers['x-request-id']).toBe('client-abc_123');
    expect(res.json().requestId).toBe('client-abc_123');
  });

  it('replaces an unusable caller-supplied request id rather than echoing it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'not ok\r\ninjected: header' },
    });
    expect(res.headers['x-request-id']).not.toContain('injected');
    expect(String(res.headers['x-request-id'])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets helmet defaults without a CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

describe('error handling', () => {
  it('returns the error envelope for malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/anything',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().requestId).toBeTruthy();
  });

  it('rejects a body over the 64 KB cap', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/anything',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ blob: 'x'.repeat(70 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBeTruthy();
  });

  it('accepts an empty JSON body, so idempotent POSTs need no payload', async () => {
    // No v1 POST route exists yet — reaching the 404 handler proves the body
    // parser accepted the empty payload instead of rejecting it as malformed.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/anything',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('OpenAPI', () => {
  it('serves the spec at a stable versioned path', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(spec.info.title).toBe('Waifumon Platform API');
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('documents /health and /ready but not the spec route itself', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/health', '/ready']));
    expect(spec.paths['/api/v1/openapi.json']).toBeUndefined();
  });

  it('warns clients that v1 mutations do not emit Game Events', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    expect(spec.info.description).toContain('do not emit Game Events');
  });

  it('serves the Swagger UI', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('advertises the configured public URL as the only server', async () => {
    const configured = await createPlatformApiServer({
      config: {
        enabled: true,
        host: '0.0.0.0',
        port: 3120,
        token: TEST_TOKEN,
        publicUrl: 'https://api.waifumon.com',
      },
      logger: createCapturedLogger().logger,
      probes: createProbes(),
      ctx: createApiContext(),
    });
    try {
      const spec = (await configured.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
      expect(spec.servers).toHaveLength(1);
      expect(spec.servers[0].url).toBe('https://api.waifumon.com');
    } finally {
      await configured.close();
    }
  });

  it('never advertises the wildcard bind — Swagger "Try it out" cannot dial it', async () => {
    const dockerLike = await createPlatformApiServer({
      config: { enabled: true, host: '0.0.0.0', port: 3120, token: TEST_TOKEN },
      logger: createCapturedLogger().logger,
      probes: createProbes(),
      ctx: createApiContext(),
    });
    try {
      const spec = (await dockerLike.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
      expect(spec.servers[0].url).toBe('http://127.0.0.1:3120');
    } finally {
      await dockerLike.close();
    }
  });
});

describe('isPrivateBind', () => {
  it('accepts loopback and Tailscale addresses', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '100.64.0.1', '100.127.255.255']) {
      expect(isPrivateBind(host)).toBe(true);
    }
  });

  it('rejects public and wildcard binds', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', '100.63.255.255', '100.128.0.1', '203.0.113.5']) {
      expect(isPrivateBind(host)).toBe(false);
    }
  });
});
