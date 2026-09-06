/**
 * Promotion over HTTP: who may export, preview and apply.
 *
 * The permission split is the point of this suite. Export is a read, preview
 * is an authoring action that writes nothing, and apply changes what every
 * player sees at once — so they carry `encounters.read`, `encounters.write`
 * and `encounters.publish` respectively. An Encounter Editor must be able to
 * prepare and check a promotion without being able to perform one, and that
 * is asserted against a *real* role grant rather than a hand-built session.
 *
 * `adminBearer` is off, matching production's default, so the shared API token
 * is not a way to publish content either.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { guildAdminRoleGrants, worldEncounterImportLog, worldEncounters } from '../../../src/db/schema';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createGuildRoleService } from '../../../src/modules/portalAuth/guildRoleService';
import { createAdminRoleGrantService } from '../../../src/modules/portalAuth/adminRoleGrantService';
import {
  ROLE_GRANT_PRESETS,
  createPortalAuthorizationService,
} from '../../../src/modules/portalAuth/portalAuthService';
import { createEncounterPromotionService } from '../../../src/modules/worldEncounters/encounterImportService';

const GUILD_ID = '111222333444555666';
const OWNER_ID = '777888999000111222';
const EDITOR_ID = '999999999999999999';
const PLAIN_ID = '888888888888888888';
const EDITOR_ROLE = '100000000000000001';
const CSRF = 'csrf-token';

let t: TestDb;
let app: App;
let api: ZodFastify;
let sessions: StubSessions;
let memberRoles: Record<string, readonly string[] | null>;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  await provisionPlayer(app, GUILD_ID, OWNER_ID);
  await provisionPlayer(app, GUILD_ID, EDITOR_ID);
  await provisionPlayer(app, GUILD_ID, PLAIN_ID);

  const guildOwnership = createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID });
  const guildRoles = createGuildRoleService({
    fetchMemberRoleIds: async (g, u) => memberRoles[`${g}:${u}`] ?? null,
    fetchGuildRoles: async () => [],
    memberTtlMs: 0,
    rolesTtlMs: 0,
  });
  const adminRoleGrants = createAdminRoleGrantService(t.db);
  const portalAuthorization = createPortalAuthorizationService({
    guildOwnership,
    guildRoles,
    roleGrants: adminRoleGrants,
  });
  const encounterPromotion = createEncounterPromotionService({
    db: t.db,
    getContent: () => app.content,
  });

  sessions = makeStubSessions();
  api = await createPlatformApiServer({
    config: {
      enabled: true,
      host: '127.0.0.1',
      port: 3132,
      token: TEST_TOKEN,
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
      services: { ...app, adminRoleGrants, guildRoles, encounterPromotion },
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
  await t.db.delete(worldEncounterImportLog);
  memberRoles = {
    [`${GUILD_ID}:${EDITOR_ID}`]: [EDITOR_ROLE],
    [`${GUILD_ID}:${PLAIN_ID}`]: [],
    [`${GUILD_ID}:${OWNER_ID}`]: [],
  };
  sessions.reset();
  // The Editor role gets authoring permissions but never `encounters.publish`.
  await t.db.insert(guildAdminRoleGrants).values({
    discordGuildId: GUILD_ID,
    roleId: EDITOR_ROLE,
    permissions: [...ROLE_GRANT_PRESETS.encounter_editor],
  });
});

interface StubSessions {
  register(token: string, session: PortalSession): void;
  reset(): void;
  getSession: (token: string | undefined) => Promise<PortalSession | null>;
  toBrowserSession: (s: PortalSession | null) => Record<string, unknown>;
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
    toBrowserSession: (s) => (s ? { authenticated: true, csrfToken: s.csrfToken } : { authenticated: false }),
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

function login(discordUserId: string) {
  const token = `token-${discordUserId}`;
  sessions.register(token, {
    sessionDigest: 'digest',
    discordUserId,
    discordUsername: null,
    discordAvatarUrl: null,
    selectedDiscordGuildId: GUILD_ID,
    selectedGuildDbId: 1,
    playerId: 1,
    eligibleGuilds: [],
    csrfToken: CSRF,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return {
    cookies: { wm_portal_session: token, wm_portal_csrf: CSRF },
    headers: { 'x-portal-csrf': CSRF },
  };
}

function post(who: string, url: string, payload: Record<string, unknown>) {
  const jar = login(who);
  return api.inject({ method: 'POST', url, cookies: jar.cookies, headers: jar.headers, payload });
}

const NEW_ENCOUNTER = {
  slug: 'imp_http_new',
  name: 'HTTP Imported',
  description: '',
  type: 'decision',
  rarity: 'common',
  weight: 10,
  lifecycle: 'active',
  huntEligible: true,
  travelEligible: false,
  cooldownSeconds: 0,
  artworkPath: null,
  chainedEncounterSlug: null,
  choicesRequired: true,
  regions: [],
  routes: [],
  choices: [
    {
      label: 'Go',
      emoji: null,
      requirements: {},
      check: { type: 'none' },
      successEffects: [],
      failureEffects: [],
    },
  ],
  metadata: {},
};

const PACKAGE = {
  format: 'waifumon-world-encounters',
  version: 1,
  exportedAt: '2026-09-05T00:00:00.000Z',
  label: 'staging',
  vendors: [],
  encounters: [NEW_ENCOUNTER],
};

async function slugExists(slug: string): Promise<boolean> {
  const rows = await t.db.select({ slug: worldEncounters.slug }).from(worldEncounters);
  return rows.some((r) => r.slug === slug);
}

describe('export requires encounters.read', () => {
  it('serves an owner a downloadable package', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters/export',
      cookies: login(OWNER_ID).cookies,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { format: string; encounters: unknown[] } };
    expect(body.data.format).toBe('waifumon-world-encounters');
    expect(body.data.encounters.length).toBeGreaterThan(0);
    // The saved file is the bare package — no envelope, no ids.
    expect(JSON.stringify(body.data)).not.toContain('"id"');
  });

  it('serves an Encounter Editor, who holds encounters.read', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters/export',
      cookies: login(EDITOR_ID).cookies,
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses an ordinary member', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters/export',
      cookies: login(PLAIN_ID).cookies,
    });
    expect(res.statusCode).toBe(403);
  });

  it('exports only the requested slugs', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/encounters/export?slugs=tv_bandit_ambush',
      cookies: login(OWNER_ID).cookies,
    });
    const body = res.json() as { data: { encounters: Array<{ slug: string }> } };
    expect(body.data.encounters.map((e) => e.slug)).toEqual(['tv_bandit_ambush']);
  });
});

describe('preview requires encounters.write', () => {
  it('lets an Encounter Editor dry-run a package', async () => {
    const res = await post(EDITOR_ID, '/api/v1/admin/encounters/import/preview', {
      package: PACKAGE,
      sourceFilename: 'staging.json',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { ok: boolean; counts: { created: number } } };
    expect(body.data.ok).toBe(true);
    expect(body.data.counts.created).toBe(1);
    // Dry run: nothing landed.
    expect(await slugExists('imp_http_new')).toBe(false);
  });

  it('refuses an ordinary member', async () => {
    const res = await post(PLAIN_ID, '/api/v1/admin/encounters/import/preview', {
      package: PACKAGE,
    });
    expect(res.statusCode).toBe(403);
  });

  it('reports a bad package as a readable plan, not a schema dump', async () => {
    const res = await post(EDITOR_ID, '/api/v1/admin/encounters/import/preview', {
      package: { ...PACKAGE, version: 99 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { ok: boolean; issues: Array<{ code: string }> } };
    expect(body.data.ok).toBe(false);
    expect(body.data.issues.map((i) => i.code)).toContain('unsupported_version');
  });
});

describe('apply requires encounters.publish', () => {
  it('refuses an Encounter Editor, who can preview but not promote', async () => {
    const res = await post(EDITOR_ID, '/api/v1/admin/encounters/import/apply', {
      package: PACKAGE,
    });

    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'PORTAL_PERMISSION_DENIED',
    );
    expect(await slugExists('imp_http_new')).toBe(false);
  });

  it('lets an owner apply, and records the actor from the session', async () => {
    const res = await post(OWNER_ID, '/api/v1/admin/encounters/import/apply', {
      package: PACKAGE,
      sourceFilename: 'staging.json',
    });

    expect(res.statusCode).toBe(200);
    expect(await slugExists('imp_http_new')).toBe(true);

    const [log] = await t.db.select().from(worldEncounterImportLog);
    expect(log).toMatchObject({
      actorDiscordUserId: OWNER_ID,
      sourceFilename: 'staging.json',
      packageLabel: 'staging',
      createdCount: 1,
    });
  });

  it('lets a Publisher-granted role apply', async () => {
    await t.db.delete(guildAdminRoleGrants);
    await t.db.insert(guildAdminRoleGrants).values({
      discordGuildId: GUILD_ID,
      roleId: EDITOR_ROLE,
      permissions: [...ROLE_GRANT_PRESETS.encounter_publisher],
    });

    const res = await post(EDITOR_ID, '/api/v1/admin/encounters/import/apply', {
      package: { ...PACKAGE, encounters: [{ ...NEW_ENCOUNTER, slug: 'imp_http_pub' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(await slugExists('imp_http_pub')).toBe(true);
    const [log] = await t.db.select().from(worldEncounterImportLog);
    expect(log!.actorDiscordUserId).toBe(EDITOR_ID);
  });

  it('rejects an invalid package with a 400 and writes nothing', async () => {
    const res = await post(OWNER_ID, '/api/v1/admin/encounters/import/apply', {
      package: {
        ...PACKAGE,
        encounters: [{ ...NEW_ENCOUNTER, slug: 'imp_http_bad', chainedEncounterSlug: 'nope' }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'ENCOUNTER_IMPORT_REJECTED',
    );
    expect(await slugExists('imp_http_bad')).toBe(false);
    expect(await t.db.select().from(worldEncounterImportLog)).toHaveLength(0);
  });
});

describe('CSRF and bearer', () => {
  it('rejects a preview with no CSRF token', async () => {
    const jar = login(EDITOR_ID);
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/encounters/import/preview',
      cookies: { wm_portal_session: jar.cookies.wm_portal_session },
      payload: { package: PACKAGE },
    });

    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PORTAL_CSRF_INVALID');
  });

  it('rejects an apply whose CSRF header does not match, and writes nothing', async () => {
    // A slug unique to this test: an earlier test in the file applies a
    // package successfully, so asserting on a shared slug would be asserting
    // about that test's writes rather than this one's.
    const jar = login(OWNER_ID);
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/encounters/import/apply',
      cookies: jar.cookies,
      headers: { 'x-portal-csrf': 'wrong' },
      payload: {
        package: { ...PACKAGE, encounters: [{ ...NEW_ENCOUNTER, slug: 'imp_http_csrf' }] },
      },
    });

    expect(res.statusCode).toBe(403);
    expect(await slugExists('imp_http_csrf')).toBe(false);
  });

  it('the shared API token cannot publish content', async () => {
    // `adminBearer` is off — production's default.
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/encounters/import/apply',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: {
        package: { ...PACKAGE, encounters: [{ ...NEW_ENCOUNTER, slug: 'imp_http_bearer' }] },
      },
    });

    expect(res.statusCode).toBe(403);
    expect(await slugExists('imp_http_bearer')).toBe(false);
  });

  it('unauthenticated requests are refused before anything is parsed', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/encounters/import/apply',
      payload: { package: PACKAGE },
    });
    expect(res.statusCode).toBe(401);
  });
});
