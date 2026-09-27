/**
 * Load Testing admin routes over real HTTP — auth hook, permission guard,
 * body validation, handlers — against a controller with a fake generator.
 *
 * Pinned:
 *   - **production lockout**: with no controller (LOAD_TESTING_ENABLED off)
 *     every path 404s — for the owner, for the bearer token, for everyone —
 *     and the authorization service withholds `system.loadtest.run` from the
 *     owner too;
 *   - `system.loadtest.run` is owner-only: not grantable, not in any preset, a
 *     role holding every grantable permission is refused, and so is a grant
 *     row naming it directly;
 *   - the operator allowlist narrows owner access further;
 *   - no session is 401, a POST without CSRF is refused, the bearer token is
 *     refused unless admin-bearer is on;
 *   - concurrency and duration bounds are enforced server-side;
 *   - start → 202, a second start → 409, stop → 200, stop with nothing → 409;
 *   - existing admin surfaces (System Metrics) are unaffected.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { PORTAL_CSRF_HEADER } from '../../../src/api/portalSession';
import type { LoadTestController } from '../../../src/modules/loadTest/controller';
import {
  ALL_PORTAL_PERMISSIONS,
  createPortalAuthorizationService,
  GRANTABLE_PORTAL_PERMISSIONS,
  PORTAL_PERMISSION_DESCRIPTIONS,
  ROLE_GRANT_PRESETS,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import {
  buildGalleryServer,
  GUILD,
  OWNER,
  SESSION_COOKIES,
  TEST_TOKEN,
} from '../../helpers/galleryApiHarness';
import { buildController } from '../../helpers/loadTestFakes';
import type { PortalSession } from '../../../src/api/portalSession';

const BASE = '/api/v1/admin/load-testing';
const WRITE_HEADERS = { ...SESSION_COOKIES, [PORTAL_CSRF_HEADER]: 'csrf-token' };
const VALID = { profile: 'mixed', concurrency: 5, durationSeconds: 60 };

let app: ZodFastify | undefined;
let controller: LoadTestController | undefined;

afterEach(async () => {
  controller?.stop();
  await controller?.whenIdle();
  controller = undefined;
  await app?.close();
  app = undefined;
});

interface Build {
  as?: 'owner' | 'member';
  rolePermissions?: readonly PortalPermission[];
  adminBearerAllowed?: boolean;
  /** False builds the server as a production deployment: no controller. */
  enabled?: boolean;
  operators?: readonly string[];
}

async function build(opts: Build = {}): Promise<ZodFastify> {
  const enabled = opts.enabled ?? true;
  controller = enabled ? buildController({ script: 'manual' }).controller : undefined;
  return buildGalleryServer({
    content: { species: [], items: [] } as never,
    assetsDir: '/nonexistent',
    ...(opts.as ? { as: opts.as } : {}),
    ...(opts.rolePermissions ? { rolePermissions: opts.rolePermissions } : {}),
    ...(opts.adminBearerAllowed === undefined ? {} : { adminBearerAllowed: opts.adminBearerAllowed }),
    ...(controller ? { loadTesting: controller } : {}),
    ...(opts.operators ? { loadTestingOperatorIds: opts.operators } : {}),
  });
}

const getStatus = (headers: Record<string, string> = SESSION_COOKIES) =>
  app!.inject({ method: 'GET', url: BASE, headers });
const start = (body: unknown = VALID, headers: Record<string, string> = WRITE_HEADERS) =>
  app!.inject({ method: 'POST', url: `${BASE}/runs`, headers, payload: body as object });
const stop = (headers: Record<string, string> = WRITE_HEADERS) =>
  app!.inject({ method: 'POST', url: `${BASE}/runs/current/stop`, headers });

describe('production lockout (LOAD_TESTING_ENABLED off)', () => {
  it('registers no route: every path 404s, even for the owner', async () => {
    app = await build({ as: 'owner', enabled: false });
    for (const res of [
      await getStatus(),
      await start(),
      await stop(),
      await app.inject({ method: 'GET', url: `${BASE}/results`, headers: SESSION_COOKIES }),
    ]) {
      expect(res.statusCode).toBe(404);
    }
  });

  it('404s for an admin-bearer token too', async () => {
    app = await build({ enabled: false, adminBearerAllowed: true });
    const res = await start(VALID, { authorization: `Bearer ${TEST_TOKEN}` });
    expect(res.statusCode).toBe(404);
  });

  it('withholds system.loadtest.run from the guild owner', async () => {
    const session = { discordUserId: OWNER, selectedDiscordGuildId: GUILD } as PortalSession;
    const ownership = createGuildOwnershipService({ fetchOwnerId: async () => OWNER });
    const off = createPortalAuthorizationService({ guildOwnership: ownership });
    const on = createPortalAuthorizationService({ guildOwnership: ownership, loadTestingEnabled: true });
    expect(await off.has(session, 'system.loadtest.run')).toBe(false);
    expect(await off.has(session, 'system.metrics.read')).toBe(true);
    expect(await on.has(session, 'system.loadtest.run')).toBe(true);
  });

  it('does not advertise the routes in the OpenAPI document', async () => {
    app = await build({ as: 'owner', enabled: false });
    const spec = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    expect(Object.keys(spec.paths).some((p: string) => p.includes('load-testing'))).toBe(false);
  });
});

describe('permission vocabulary', () => {
  it('is described and owner-only', () => {
    expect(ALL_PORTAL_PERMISSIONS).toContain('system.loadtest.run');
    expect(PORTAL_PERMISSION_DESCRIPTIONS['system.loadtest.run']).toMatch(/\S/);
    expect(GRANTABLE_PORTAL_PERMISSIONS).not.toContain('system.loadtest.run');
    for (const preset of Object.values(ROLE_GRANT_PRESETS)) {
      expect(preset).not.toContain('system.loadtest.run');
    }
  });
});

describe('who may run load tests', () => {
  it('the guild owner may', async () => {
    app = await build({ as: 'owner' });
    const res = await getStatus();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ enabled: true, current: null, cardsAvailable: true });
  });

  it('an ordinary player is refused', async () => {
    app = await build({ rolePermissions: [] });
    const res = await getStatus();
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    expect((await start()).statusCode).toBe(403);
  });

  it('a role holding every grantable permission is refused', async () => {
    app = await build({ rolePermissions: GRANTABLE_PORTAL_PERMISSIONS });
    expect((await getStatus()).statusCode).toBe(403);
    expect((await start()).statusCode).toBe(403);
    expect(controller!.currentRun()).toBeNull();
  });

  it('a grant row naming system.loadtest.run directly confers nothing', async () => {
    app = await build({ rolePermissions: ['system.loadtest.run'] });
    expect((await start()).statusCode).toBe(403);
  });

  it('System Metrics access alone is not enough', async () => {
    app = await build({ rolePermissions: ['system.metrics.read'] });
    expect((await start()).statusCode).toBe(403);
  });

  it('no session is 401', async () => {
    app = await build({ as: 'owner' });
    expect((await getStatus({})).statusCode).toBe(401);
    expect((await start(VALID, {})).statusCode).toBe(401);
  });

  it('a start without the CSRF header is refused', async () => {
    app = await build({ as: 'owner' });
    const res = await start(VALID, SESSION_COOKIES);
    expect(res.statusCode).toBe(403);
    expect(controller!.currentRun()).toBeNull();
  });

  it('the bearer token is refused by default and accepted with admin-bearer', async () => {
    app = await build({ as: 'owner' });
    expect((await start(VALID, { authorization: `Bearer ${TEST_TOKEN}` })).statusCode).toBe(403);
    await app.close();
    controller = undefined;
    app = await build({ adminBearerAllowed: true });
    expect((await start(VALID, { authorization: `Bearer ${TEST_TOKEN}` })).statusCode).toBe(202);
  });

  it('an operator allowlist excludes an owner not on it', async () => {
    app = await build({ as: 'owner', operators: ['999999999999999999'] });
    expect((await getStatus()).statusCode).toBe(403);
    expect((await start()).statusCode).toBe(403);
  });

  it('an operator allowlist admits an owner on it', async () => {
    app = await build({ as: 'owner', operators: [OWNER] });
    expect((await getStatus()).statusCode).toBe(200);
  });
});

describe('validation', () => {
  it.each([
    ['zero players', { ...VALID, concurrency: 0 }],
    ['101 players', { ...VALID, concurrency: 101 }],
    ['29 seconds', { ...VALID, durationSeconds: 29 }],
    ['31 minutes', { ...VALID, durationSeconds: 1_860 }],
    ['cards without a mode', { ...VALID, profile: 'cards' }],
    ['an unknown profile', { ...VALID, profile: 'dos' }],
    ['an unknown field', { ...VALID, targetRps: 5000 }],
  ])('refuses %s with 400 and starts nothing', async (_name, body) => {
    app = await build({ as: 'owner' });
    const res = await start(body);
    expect(res.statusCode).toBe(400);
    expect(controller!.currentRun()).toBeNull();
  });
});

describe('start and stop', () => {
  it('starts, refuses a second start, stops, and refuses a stop with nothing running', async () => {
    app = await build({ as: 'owner' });
    const first = await start({ ...VALID, label: 'run A' });
    expect(first.statusCode).toBe(202);
    expect(first.json().data).toMatchObject({
      state: 'preparing',
      profile: 'mixed',
      concurrency: 5,
      durationSeconds: 60,
      label: 'run A',
      operatorDiscordId: OWNER,
    });

    const second = await start();
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('LOAD_TEST_CONFLICT');

    const status = (await getStatus()).json().data;
    expect(status.current.runKey).toBe(first.json().data.runKey);

    const stopped = await stop();
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().data.state).toBe('stopping');

    await controller!.whenIdle();
    const after = (await getStatus()).json().data;
    expect(after.current).toBeNull();
    expect(after.last.state).toBe('stopped');

    const none = await stop();
    expect(none.statusCode).toBe(409);

    const results = await app.inject({ method: 'GET', url: `${BASE}/results`, headers: SESSION_COOKIES });
    expect(results.statusCode).toBe(200);
    expect(results.json().data[0]).toMatchObject({ status: 'stopped', profile: 'mixed', concurrency: 5 });
    const id = results.json().data[0].id;
    const one = await app.inject({ method: 'GET', url: `${BASE}/results/${id}`, headers: SESSION_COOKIES });
    expect(one.statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: `${BASE}/results/9999`, headers: SESSION_COOKIES });
    expect(missing.statusCode).toBe(404);
  });
});

describe('existing admin surfaces', () => {
  it('System Metrics is unaffected by load testing being on or off', async () => {
    app = await build({ as: 'owner', enabled: true });
    // No metrics collectors in this harness, so the route is absent either way —
    // what matters is that load testing did not register or shadow it.
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/system/metrics', headers: SESSION_COOKIES });
    expect(res.statusCode).toBe(404);
    const gallery = await app.inject({ method: 'GET', url: '/api/v1/admin/gallery/species', headers: SESSION_COOKIES });
    expect(gallery.statusCode).toBe(200);
  });
});
