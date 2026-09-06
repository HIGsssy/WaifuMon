/**
 * Delegated Portal Admin access, end to end over HTTP and a real database.
 *
 * Two things are proved here that the unit tests cannot:
 *
 *   1. **The grant table is the one an authorization actually reads.** A grant
 *      written through the API changes what a *different* session is allowed to
 *      do on its next request — no restart, no cache flush, no redeploy.
 *   2. **The management surface is owner-only in practice**, not just by
 *      intent: a role-granted admin with full encounter permissions is refused
 *      by every route in this namespace, so they cannot widen their own access.
 *
 * `adminBearer` is deliberately **false** in this suite, unlike the encounter
 * admin suite. These routes are about who may become an admin, so the shared
 * API token must not be a way in — and the bearer path is asserted denied.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { guildAdminRoleGrants } from '../../../src/db/schema';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createGuildRoleService } from '../../../src/modules/portalAuth/guildRoleService';
import { createAdminRoleGrantService } from '../../../src/modules/portalAuth/adminRoleGrantService';
import {
  ROLE_GRANT_PRESETS,
  createPortalAuthorizationService,
} from '../../../src/modules/portalAuth/portalAuthService';

const GUILD_ID = '111222333444555666';
const OTHER_GUILD_ID = '222333444555666777';
const OWNER_ID = '777888999000111222';
const EDITOR_ID = '999999999999999999';
const PLAIN_ID = '888888888888888888';

const EDITOR_ROLE = '100000000000000001';
const PUBLISHER_ROLE = '100000000000000002';

let t: TestDb;
let app: App;
let api: ZodFastify;
let sessions: StubSessions;
/** Mutable: tests change who holds which role and re-authorize. */
let memberRoles: Record<string, readonly string[] | null>;
let roleFetchThrows = false;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  await provisionPlayer(app, GUILD_ID, OWNER_ID);
  await provisionPlayer(app, GUILD_ID, EDITOR_ID);
  await provisionPlayer(app, GUILD_ID, PLAIN_ID);

  const guildOwnership = createGuildOwnershipService({
    fetchOwnerId: async (guildId) => (guildId === GUILD_ID ? OWNER_ID : 'someone-else'),
  });
  const guildRoles = createGuildRoleService({
    fetchMemberRoleIds: async (guildId, userId) => {
      if (roleFetchThrows) throw new Error('gateway down');
      return memberRoles[`${guildId}:${userId}`] ?? null;
    },
    fetchGuildRoles: async () => [
      { id: EDITOR_ROLE, name: 'Encounter Devs', color: 0x5865f2, position: 5, managed: false },
      { id: PUBLISHER_ROLE, name: 'Leads', color: 0, position: 6, managed: false },
      { id: GUILD_ID, name: '@everyone', color: 0, position: 0, managed: false },
      { id: '300000000000000003', name: 'BotRole', color: 0, position: 9, managed: true },
    ],
    // No caching between assertions: these tests change role membership and
    // then immediately re-authorize, and a TTL would make that a race.
    memberTtlMs: 0,
    rolesTtlMs: 0,
  });
  const adminRoleGrants = createAdminRoleGrantService(t.db);
  const portalAuthorization = createPortalAuthorizationService({
    guildOwnership,
    guildRoles,
    roleGrants: adminRoleGrants,
  });

  sessions = makeStubSessions();

  api = await createPlatformApiServer({
    config: {
      enabled: true,
      host: '127.0.0.1',
      port: 3131,
      token: TEST_TOKEN,
      // Deliberately off — see the file header.
      adminBearer: false,
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
      sessions: sessions as unknown as PortalSessionService,
      authorization: portalAuthorization,
    },
    ctx: {
      services: { ...app, adminRoleGrants, guildRoles },
      getContent: () => app.content,
      portalAuthorization,
      adminBearerAllowed: false,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(guildAdminRoleGrants);
  memberRoles = {
    [`${GUILD_ID}:${EDITOR_ID}`]: [EDITOR_ROLE],
    [`${GUILD_ID}:${PLAIN_ID}`]: [],
    [`${GUILD_ID}:${OWNER_ID}`]: [],
  };
  roleFetchThrows = false;
  sessions.reset();
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
    register: (token, session) => void store.set(token, session),
    reset: () => store.clear(),
    async getSession(token) {
      return token ? (store.get(token) ?? null) : null;
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
    safeEquals: (a, b) => a === b,
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

const CSRF = 'csrf-token';

function sessionFor(discordUserId: string, discordGuildId = GUILD_ID): PortalSession {
  return {
    sessionDigest: 'digest',
    discordUserId,
    discordUsername: null,
    discordAvatarUrl: null,
    selectedDiscordGuildId: discordGuildId,
    selectedGuildDbId: 1,
    playerId: 1,
    eligibleGuilds: [],
    csrfToken: CSRF,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

/** Register a session and return the cookie jar for it. */
function login(discordUserId: string, guildId = GUILD_ID) {
  const token = `token-${discordUserId}-${guildId}`;
  sessions.register(token, sessionFor(discordUserId, guildId));
  return {
    cookies: { wm_portal_session: token, wm_portal_csrf: CSRF },
    headers: { 'x-portal-csrf': CSRF },
  };
}

/**
 * A mutation as the browser sends it: session cookie + matching CSRF pair.
 *
 * `payload` is always passed (defaulting to `{}`) rather than spread in
 * conditionally — a conditional spread widens the inject options into a union
 * Fastify's overloads cannot resolve, and a DELETE with an empty body is
 * exactly what the browser sends anyway.
 */
function mutate(
  who: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload: Record<string, unknown> = {},
) {
  const jar = login(who);
  return api.inject({
    method,
    url,
    cookies: jar.cookies,
    headers: jar.headers,
    payload,
  });
}

async function grantEditorRole(): Promise<void> {
  const res = await mutate(OWNER_ID, 'POST', '/api/v1/admin/access/grants', {
    roleId: EDITOR_ROLE,
    permissions: [...ROLE_GRANT_PRESETS.encounter_editor],
  });
  expect(res.statusCode).toBe(200);
}

/* ───────────────────────── owner management ───────────────────────── */

describe('the guild owner manages grants', () => {
  it('creates, lists, updates and deletes a grant', async () => {
    const created = await mutate(OWNER_ID, 'POST', '/api/v1/admin/access/grants', {
      roleId: EDITOR_ROLE,
      permissions: [...ROLE_GRANT_PRESETS.encounter_editor],
    });
    expect(created.statusCode).toBe(200);
    expect((created.json() as { data: { preset: string } }).data.preset).toBe('encounter_editor');

    const listed = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/access/grants',
      cookies: login(OWNER_ID).cookies,
    });
    expect(listed.statusCode).toBe(200);
    const list = listed.json() as {
      data: { grants: Array<{ roleId: string }>; grantablePermissions: string[] };
    };
    expect(list.data.grants.map((g) => g.roleId)).toEqual([EDITOR_ROLE]);
    // The management permission is never offered as something to delegate.
    expect(list.data.grantablePermissions).not.toContain('admin.roles.manage');

    const patched = await mutate(
      OWNER_ID,
      'PATCH',
      `/api/v1/admin/access/grants/${EDITOR_ROLE}`,
      { permissions: [...ROLE_GRANT_PRESETS.encounter_publisher] },
    );
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { data: { preset: string } }).data.preset).toBe(
      'encounter_publisher',
    );

    const deleted = await mutate(
      OWNER_ID,
      'DELETE',
      `/api/v1/admin/access/grants/${EDITOR_ROLE}`,
    );
    expect(deleted.statusCode).toBe(200);
    const rows = await t.db.select().from(guildAdminRoleGrants);
    expect(rows).toHaveLength(0);
  });

  it('lists the guild roles, hiding @everyone and managed roles', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/access/roles',
      cookies: login(OWNER_ID).cookies,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { roles: Array<{ id: string; name: string }>; available: boolean };
    };
    expect(body.data.available).toBe(true);
    const ids = body.data.roles.map((r) => r.id);
    expect(ids).toContain(EDITOR_ROLE);
    // `@everyone` shares the guild id and would grant access to the whole
    // server; a managed role cannot be assigned by hand.
    expect(ids).not.toContain(GUILD_ID);
    expect(ids).not.toContain('300000000000000003');
  });

  it('refuses a permission that cannot be delegated', async () => {
    const res = await mutate(OWNER_ID, 'POST', '/api/v1/admin/access/grants', {
      roleId: EDITOR_ROLE,
      permissions: ['admin.access', 'admin.roles.manage'],
    });
    // Rejected by the route schema before it ever reaches the service.
    expect(res.statusCode).toBe(400);
    expect(await t.db.select().from(guildAdminRoleGrants)).toHaveLength(0);
  });

  it('404s when editing a grant that is not there', async () => {
    const res = await mutate(
      OWNER_ID,
      'PATCH',
      `/api/v1/admin/access/grants/${PUBLISHER_ROLE}`,
      { permissions: ['admin.access', 'encounters.read'] },
    );
    expect(res.statusCode).toBe(404);
  });
});

/* ───────────────────── authorization takes effect ───────────────────── */

describe('a grant changes what another session may do', () => {
  it('an ordinary member has no permissions', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      cookies: login(PLAIN_ID).cookies,
    });
    expect(res.statusCode).toBe(403);
  });

  it('takes effect on the next request, with no restart', async () => {
    // Before: the role exists and the member holds it, but nothing is granted.
    const before = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      cookies: login(EDITOR_ID).cookies,
    });
    expect(before.statusCode).toBe(403);

    await grantEditorRole();

    const after = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      cookies: login(EDITOR_ID).cookies,
    });
    expect(after.statusCode).toBe(200);
  });

  it('the session endpoint reports the role-derived permission set', async () => {
    await grantEditorRole();
    const res = await api.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: login(EDITOR_ID).cookies,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { permissions: string[] };
    expect([...body.permissions].sort()).toEqual([...ROLE_GRANT_PRESETS.encounter_editor].sort());
    expect(body.permissions).not.toContain('encounters.publish');
    expect(body.permissions).not.toContain('admin.roles.manage');
  });

  it('an editor cannot publish, a publisher can', async () => {
    await grantEditorRole();
    const asEditor = await api.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: login(EDITOR_ID).cookies,
    });
    expect((asEditor.json() as { permissions: string[] }).permissions).not.toContain(
      'encounters.publish',
    );

    await mutate(OWNER_ID, 'PATCH', `/api/v1/admin/access/grants/${EDITOR_ROLE}`, {
      permissions: [...ROLE_GRANT_PRESETS.encounter_publisher],
    });

    const asPublisher = await api.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: login(EDITOR_ID).cookies,
    });
    expect((asPublisher.json() as { permissions: string[] }).permissions).toContain(
      'encounters.publish',
    );
  });

  it('revoking the grant removes access again', async () => {
    await grantEditorRole();
    await mutate(OWNER_ID, 'DELETE', `/api/v1/admin/access/grants/${EDITOR_ROLE}`);

    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      cookies: login(EDITOR_ID).cookies,
    });
    expect(res.statusCode).toBe(403);
  });

  it('losing the Discord role removes access, with the grant left in place', async () => {
    await grantEditorRole();
    memberRoles[`${GUILD_ID}:${EDITOR_ID}`] = [];

    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      cookies: login(EDITOR_ID).cookies,
    });
    expect(res.statusCode).toBe(403);
    expect(await t.db.select().from(guildAdminRoleGrants)).toHaveLength(1);
  });

  it('a Discord lookup failure fails closed', async () => {
    await grantEditorRole();
    roleFetchThrows = true;

    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      cookies: login(EDITOR_ID).cookies,
    });
    expect(res.statusCode).toBe(403);
  });

  it('the owner keeps full access regardless of the grant table', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: login(OWNER_ID).cookies,
    });
    const permissions = (res.json() as { permissions: string[] }).permissions;
    expect(permissions).toContain('admin.roles.manage');
    expect(permissions).toContain('encounters.publish');
  });
});

/* ───────────────────────── escalation and scope ───────────────────────── */

describe('a role-granted admin cannot manage grants', () => {
  beforeEach(grantEditorRole);

  it('is refused every route in the access namespace', async () => {
    const jar = login(EDITOR_ID);
    const reads = await Promise.all([
      api.inject({ method: 'GET', url: '/api/v1/admin/access/grants', cookies: jar.cookies }),
      api.inject({ method: 'GET', url: '/api/v1/admin/access/roles', cookies: jar.cookies }),
    ]);
    for (const res of reads) expect(res.statusCode).toBe(403);

    const writes = await Promise.all([
      mutate(EDITOR_ID, 'POST', '/api/v1/admin/access/grants', {
        roleId: PUBLISHER_ROLE,
        permissions: [...ROLE_GRANT_PRESETS.encounter_publisher],
      }),
      mutate(EDITOR_ID, 'PATCH', `/api/v1/admin/access/grants/${EDITOR_ROLE}`, {
        permissions: [...ROLE_GRANT_PRESETS.encounter_publisher],
      }),
      mutate(EDITOR_ID, 'DELETE', `/api/v1/admin/access/grants/${EDITOR_ROLE}`),
    ]);
    for (const res of writes) expect(res.statusCode).toBe(403);

    // Nothing was written or widened by any of that.
    const rows = await t.db.select().from(guildAdminRoleGrants);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.permissions).not.toContain('encounters.publish');
  });

  it('cannot escalate even while holding every encounter permission', async () => {
    await mutate(OWNER_ID, 'PATCH', `/api/v1/admin/access/grants/${EDITOR_ROLE}`, {
      permissions: [...ROLE_GRANT_PRESETS.encounter_publisher],
    });
    // Full encounter authority, and still no route into access management.
    const res = await mutate(EDITOR_ID, 'POST', '/api/v1/admin/access/grants', {
      roleId: PUBLISHER_ROLE,
      permissions: [...ROLE_GRANT_PRESETS.encounter_publisher],
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('guild scope and CSRF', () => {
  it('a grant in another guild cannot authorize this session', async () => {
    // Written directly, because the API has no way to address another guild —
    // which is itself the point: there is no guildId parameter to abuse.
    await t.db.insert(guildAdminRoleGrants).values({
      discordGuildId: OTHER_GUILD_ID,
      roleId: EDITOR_ROLE,
      permissions: [...ROLE_GRANT_PRESETS.encounter_publisher],
    });

    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters',
      cookies: login(EDITOR_ID).cookies,
    });
    expect(res.statusCode).toBe(403);
  });

  it('the owner of one guild cannot manage another guild’s grants', async () => {
    // Owner of GUILD_ID, but with OTHER_GUILD_ID selected: ownership is
    // resolved for the *selected* guild, so they hold nothing there.
    const token = 'token-owner-other-guild';
    sessions.register(token, sessionFor(OWNER_ID, OTHER_GUILD_ID));
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/access/grants',
      cookies: { wm_portal_session: token, wm_portal_csrf: CSRF },
      headers: { 'x-portal-csrf': CSRF },
      payload: { roleId: EDITOR_ROLE, permissions: ['admin.access', 'encounters.read'] },
    });
    expect(res.statusCode).toBe(403);
    expect(await t.db.select().from(guildAdminRoleGrants)).toHaveLength(0);
  });

  it('rejects a mutation with no CSRF token', async () => {
    const jar = login(OWNER_ID);
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/access/grants',
      cookies: { wm_portal_session: jar.cookies.wm_portal_session },
      payload: { roleId: EDITOR_ROLE, permissions: ['admin.access', 'encounters.read'] },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PORTAL_CSRF_INVALID');
    expect(await t.db.select().from(guildAdminRoleGrants)).toHaveLength(0);
  });

  it('rejects a mutation whose CSRF header does not match the cookie', async () => {
    const jar = login(OWNER_ID);
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/access/grants',
      cookies: { ...jar.cookies, wm_portal_csrf: CSRF },
      headers: { 'x-portal-csrf': 'not-the-token' },
      payload: { roleId: EDITOR_ROLE, permissions: ['admin.access', 'encounters.read'] },
    });
    expect(res.statusCode).toBe(403);
    expect(await t.db.select().from(guildAdminRoleGrants)).toHaveLength(0);
  });

  it('the shared API token is not a way into access management', async () => {
    // `adminBearer` is false in this suite, matching production's default.
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/access/grants',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
