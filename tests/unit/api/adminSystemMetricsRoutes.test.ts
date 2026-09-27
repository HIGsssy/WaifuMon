/**
 * Admin System Metrics route — the authorization boundary over real HTTP (auth
 * hook, permission guard, handler), with real collectors and no database.
 *
 * Pinned:
 *   - `system.metrics.read` is in the vocabulary, described, and NOT grantable:
 *     the live guild owner holds it and no role can;
 *   - a role holding every grantable permission is refused, and so is one whose
 *     grant row names `system.metrics.read` directly (filtered on read);
 *   - no session is 401; the bearer token is refused unless admin-bearer is on;
 *   - the owner receives the same report `/metrics` serves, in the envelope,
 *     and the bearer token appears nowhere in it;
 *   - there is no Portal-reachable reset, and the route is absent when metrics
 *     are disabled.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { MetricsSources } from '../../../src/api/routes/metrics';
import { PORTAL_CSRF_HEADER } from '../../../src/api/portalSession';
import {
  ALL_PORTAL_PERMISSIONS,
  GRANTABLE_PORTAL_PERMISSIONS,
  PORTAL_PERMISSION_DESCRIPTIONS,
  ROLE_GRANT_PRESETS,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { EventLoopMonitor, LatencyRecorder, SystemSampler } from '../../../src/shared/metrics';
import { buildGalleryServer, SESSION_COOKIES, TEST_TOKEN } from '../../helpers/galleryApiHarness';

const URL = '/api/v1/admin/system/metrics';

function makeSources(): MetricsSources {
  const eventLoop = new EventLoopMonitor(5);
  eventLoop.start();
  const system = new SystemSampler({ platform: 'darwin', readText: () => null, exists: () => false });
  system.sample();
  return {
    eventLoop,
    system,
    http: new LatencyRecorder(),
    describeDatabasePool: () => ({ totalCount: 4, idleCount: 1, waitingCount: 0, max: 10 }),
    describeCardRenderer: () => ({
      active: false,
      masterRenders: null,
      derivativeRenders: null,
      cacheHits: null,
      dedupedRenders: null,
      poolSize: null,
      workers: null,
    }),
  };
}

let app: ZodFastify | undefined;
let sources: MetricsSources | undefined;

afterEach(async () => {
  sources?.eventLoop.stop();
  sources = undefined;
  await app?.close();
  app = undefined;
});

interface Build {
  as?: 'owner' | 'member';
  rolePermissions?: readonly PortalPermission[];
  adminBearerAllowed?: boolean;
  metrics?: boolean;
}

async function build(opts: Build = {}): Promise<ZodFastify> {
  sources = opts.metrics === false ? undefined : makeSources();
  // No gallery content is needed; the harness only requires the shape.
  return buildGalleryServer({
    content: { species: [], items: [] } as never,
    assetsDir: '/nonexistent',
    ...(opts.as ? { as: opts.as } : {}),
    ...(opts.rolePermissions ? { rolePermissions: opts.rolePermissions } : {}),
    ...(opts.adminBearerAllowed === undefined ? {} : { adminBearerAllowed: opts.adminBearerAllowed }),
    ...(sources ? { metrics: sources } : {}),
  });
}

const get = (headers: Record<string, string> = SESSION_COOKIES) =>
  app!.inject({ method: 'GET', url: URL, headers });

describe('permission vocabulary', () => {
  it('adds system.metrics.read, described, and held by the owner set', () => {
    expect(ALL_PORTAL_PERMISSIONS).toContain('system.metrics.read');
    expect(PORTAL_PERMISSION_DESCRIPTIONS['system.metrics.read']).toMatch(/\S/);
  });

  it('keeps it out of the grantable set and every preset', () => {
    // Owner-only by vocabulary, not by a route check — the same place the
    // role-management exclusion lives, so no grant path can ever carry it.
    expect(GRANTABLE_PORTAL_PERMISSIONS).not.toContain('system.metrics.read');
    for (const preset of Object.values(ROLE_GRANT_PRESETS)) {
      expect(preset).not.toContain('system.metrics.read');
    }
  });

  it('leaves role management owner-only as well', () => {
    expect(GRANTABLE_PORTAL_PERMISSIONS).not.toContain('admin.roles.manage');
  });
});

describe('who may read system metrics', () => {
  it('the guild owner may', async () => {
    app = await build({ as: 'owner' });
    expect((await get()).statusCode).toBe(200);
  });

  it('an ordinary player is refused', async () => {
    app = await build({ rolePermissions: [] });
    const res = await get();
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
  });

  it('a role holding every grantable permission is still refused', async () => {
    app = await build({ rolePermissions: GRANTABLE_PORTAL_PERMISSIONS });
    expect((await get()).statusCode).toBe(403);
  });

  it('a grant row naming system.metrics.read directly confers nothing', async () => {
    // The row could only exist if written around the grant service. The
    // authorization service intersects with the grantable set on read, so
    // even then it grants nothing — the belt to the vocabulary's braces.
    app = await build({ rolePermissions: ['system.metrics.read'] });
    expect((await get()).statusCode).toBe(403);
  });

  it('no session at all is 401', async () => {
    app = await build({ as: 'owner' });
    expect((await get({})).statusCode).toBe(401);
  });

  it('the bearer token is refused by default', async () => {
    app = await build({ as: 'owner' });
    const res = await get({ authorization: `Bearer ${TEST_TOKEN}` });
    expect(res.statusCode).toBe(403);
  });

  it('the bearer token is accepted when admin-bearer is deliberately enabled', async () => {
    app = await build({ as: 'owner', adminBearerAllowed: true });
    expect((await get({ authorization: `Bearer ${TEST_TOKEN}` })).statusCode).toBe(200);
  });
});

describe('what the owner receives', () => {
  it('is the /metrics report inside the data envelope', async () => {
    app = await build({ as: 'owner' });
    const body = (await get()).json();
    expect(body.meta.requestId).toBeTruthy();
    const d = body.data;
    // Every section the dashboard renders.
    for (const key of ['process', 'eventLoop', 'system', 'http', 'database', 'cards']) {
      expect(d).toHaveProperty(key);
    }
    expect(d.database.pool).toEqual({ totalCount: 4, idleCount: 1, waitingCount: 0, max: 10 });
    expect(d.system.platform).toBe('darwin');
  });

  it('never contains the platform API token', async () => {
    app = await build({ as: 'owner' });
    const res = await get();
    expect(res.body).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(res.headers)).not.toContain(TEST_TOKEN);
  });

  it('matches what /metrics serves to the bearer token', async () => {
    app = await build({ as: 'owner' });
    const portal = (await get()).json().data;
    const direct = (
      await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      })
    ).json();
    // Same builder, same schema — the two surfaces cannot drift. Volatile
    // fields (timestamps, live memory, the requests themselves) aside.
    expect(Object.keys(portal).sort()).toEqual(Object.keys(direct).sort());
    expect(portal.database).toEqual(direct.database);
    expect(portal.cards).toEqual(direct.cards);
    expect(Object.keys(portal.system).sort()).toEqual(Object.keys(direct.system).sort());
  });
});

describe('what the Portal cannot do', () => {
  it('has no reset: a dashboard must not disturb a load-test window', async () => {
    app = await build({ as: 'owner' });
    // A fully valid owner mutation — session cookie *and* matching CSRF header —
    // so the 404 below is "no such route", not the CSRF check refusing first.
    const headers = { ...SESSION_COOKIES, [PORTAL_CSRF_HEADER]: 'csrf-token' };
    for (const url of [`${URL}/reset`, URL]) {
      const res = await app.inject({ method: 'POST', url, headers });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('cannot reach the bearer-only /metrics with the owner session', async () => {
    app = await build({ as: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: SESSION_COOKIES });
    expect(res.statusCode).toBe(403);
  });

  it('does not exist when metrics are disabled', async () => {
    app = await build({ as: 'owner', metrics: false });
    expect((await get()).statusCode).toBe(404);
  });
});
