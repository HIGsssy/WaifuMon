/**
 * Staging Test Controls, end to end over HTTP and a real database.
 *
 * Two API instances share one database:
 *
 *   - `api`      — a staging deployment: the service is built, the permission
 *                  is issued. Its config object is shared with the service by
 *                  reference, so a test can flip it to production mid-flight
 *                  and prove the *per-request* check refuses on its own.
 *   - `offApi`   — the flag is off: no service, no routes, no permission.
 *
 * Refusal paths are weighted as heavily as the happy ones: these routes move
 * balances and entitlements on a real account.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  bootstrapApp,
  forceRegion,
  getItemBySlug,
  provisionPlayer,
  type App,
} from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import {
  guildAdminRoleGrants,
  playerCurrencies,
  playerInventory,
  playerProgressionEvents,
  playerTravelPasses,
  playerUnlockedRoutes,
  players,
  worldEncounterCooldowns,
  worldEncounters,
} from '../../../src/db/schema';
import { seedWorldEncounters } from '../../../src/modules/worldEncounters/seed';
import { EncounterInputSchema } from '../../../src/modules/worldEncounters/types';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createGuildRoleService } from '../../../src/modules/portalAuth/guildRoleService';
import { createAdminRoleGrantService } from '../../../src/modules/portalAuth/adminRoleGrantService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import {
  createStagingTestControlsService,
  STAGING_BOOST,
  TEST_CONTROL_ACTIONS,
  TestControlsDisabledError,
} from '../../../src/modules/testControls/stagingTestControlsService';
import type { TestAdminControlsConfig } from '../../../src/config/config';
import { ADMIN_ACTION_EVENT } from '../../../src/modules/admin/adminActionAudit';
import { buildEquipmentServices } from '../../helpers/equipmentFixtures';
import { createDungeonAllowanceService } from '../../../src/modules/dungeons/dungeonAllowanceService';

const GUILD_ID = '311222333444555666';
const OTHER_GUILD_ID = '322333444555666777';
const OWNER_ID = '377888999000111222';
const ADMIN_ID = '399999999999999999';
const PLAIN_ID = '388888888888888888';
const TESTER_ID = '366666666666666666';
const OUTSIDER_ID = '355555555555555555';
const TESTER_ROLE = '300000000000000001';

const BELT = 'assteroid-belt';
const BEACON = 'transporter_beacon';
const COMPONENTS = ['cracked_teleport_core', 'quantum_stabilizer', 'phase_coupler', 'astral_power_cell'];
const STANDARD_ROUTES = ['base-80085', 'flaccid-foothills', 'thirstlands', 'twin-peeks'];

let t: TestDb;
let app: App;
let api: ZodFastify;
let offApi: ZodFastify;
let sessions: StubSessions;
let guildDbId: number;
let testerId: number;
let outsiderId: number;
/** Shared by reference with the enabled service — see the file header. */
const controlsConfig: TestAdminControlsConfig = { enabled: true, deploymentEnv: 'staging' };

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ guildDbId } = await provisionPlayer(app, GUILD_ID, OWNER_ID));
  await provisionPlayer(app, GUILD_ID, ADMIN_ID);
  await provisionPlayer(app, GUILD_ID, PLAIN_ID);
  ({ playerId: testerId } = await provisionPlayer(app, GUILD_ID, TESTER_ID));
  ({ playerId: outsiderId } = await provisionPlayer(app, OTHER_GUILD_ID, OUTSIDER_ID));

  const guildOwnership = createGuildOwnershipService({
    fetchOwnerId: async (guildId) => (guildId === GUILD_ID ? OWNER_ID : 'someone-else'),
  });
  const guildRoles = createGuildRoleService({
    fetchMemberRoleIds: async (guildId, userId) => {
      if (guildId !== GUILD_ID) return [];
      return userId === ADMIN_ID ? [TESTER_ROLE] : [];
    },
    fetchGuildRoles: async () => [
      { id: TESTER_ROLE, name: 'Testers', color: 0, position: 3, managed: false },
    ],
    memberTtlMs: 0,
    rolesTtlMs: 0,
  });
  const roleGrants = createAdminRoleGrantService(t.db);
  sessions = makeStubSessions();

  const build = async (enabled: boolean): Promise<ZodFastify> => {
    const authorization = createPortalAuthorizationService({
      guildOwnership,
      guildRoles,
      roleGrants,
      testControlsEnabled: enabled,
    });
    const testControls = enabled
      ? createStagingTestControlsService({
          db: t.db,
          currency: app.currency,
          inventory: app.inventory,
          travel: app.travel,
          progression: app.progression,
          getContent: () => app.content,
          logger: t.logger,
          config: controlsConfig,
          ...(() => {
            const equipmentServices = buildEquipmentServices(t.db);
            return { equipment: equipmentServices.equipment, featureUnlocks: equipmentServices.featureUnlocks };
          })(),
          dungeonAllowance: createDungeonAllowanceService({ db: t.db, timezone: 'UTC' }),
        })
      : undefined;
    return createPlatformApiServer({
      config: {
        enabled: true,
        host: '127.0.0.1',
        port: 3131,
        token: TEST_TOKEN,
        // On, deliberately: even an administrative bearer token must not
        // reach these routes (no one to name in the audit row).
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
        sessions: sessions as unknown as PortalSessionService,
        authorization,
      },
      ctx: {
        services: { ...app, adminRoleGrants: roleGrants, guildRoles },
        getContent: () => app.content,
        portalAuthorization: authorization,
        adminBearerAllowed: true,
        ...(testControls ? { testControls } : {}),
      },
    });
  };
  api = await build(true);
  offApi = await build(false);
});

afterAll(async () => {
  await api?.close();
  await offApi?.close();
  await t.cleanup();
});

beforeEach(async () => {
  controlsConfig.enabled = true;
  controlsConfig.deploymentEnv = 'staging';
  sessions.reset();
  await resetTester();
  // The delegated admin holds the permission through a role grant — the
  // ordinary Role Access mechanism, not a hard-coded id.
  await t.db.delete(guildAdminRoleGrants);
  await t.db.insert(guildAdminRoleGrants).values({
    discordGuildId: GUILD_ID,
    roleId: TESTER_ROLE,
    permissions: ['players.testcontrols'],
  });
});

/* ───────────────────────────── harness ───────────────────────────── */

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
      return { authenticated: true, playerId: session.playerId, csrfToken: session.csrfToken };
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

function login(discordUserId: string) {
  const token = `token-${discordUserId}`;
  sessions.register(token, {
    sessionDigest: 'digest',
    discordUserId,
    discordUsername: null,
    discordAvatarUrl: null,
    selectedDiscordGuildId: GUILD_ID,
    selectedGuildDbId: guildDbId,
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

const base = (playerId: number) => `/api/v1/admin/test-controls/players/${playerId}`;

function post(
  path: string,
  payload: Record<string, unknown> = {},
  who = OWNER_ID,
  server: ZodFastify = api,
) {
  const jar = login(who);
  return server.inject({ method: 'POST', url: path, cookies: jar.cookies, headers: jar.headers, payload });
}

function get(path: string, who = OWNER_ID, server: ZodFastify = api) {
  return server.inject({ method: 'GET', url: path, cookies: login(who).cookies });
}

interface ResultBody {
  data: {
    action: string;
    changed: boolean;
    message: string;
    changes: { field: string; before: unknown; after: unknown }[];
    state: { level: number; waifubux: number; energy: number; maxEnergy: number; currentRegion: string };
  };
}

async function tester() {
  const [p] = await t.db.select().from(players).where(eq(players.id, testerId));
  const [c] = await t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, testerId));
  return { player: p!, currencies: c! };
}

async function qty(slug: string, playerId = testerId): Promise<number> {
  const item = await getItemBySlug(t.db, slug);
  const [row] = await t.db
    .select({ q: playerInventory.quantity })
    .from(playerInventory)
    .where(and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, item.id)));
  return row?.q ?? 0;
}

async function setQty(slug: string, quantity: number): Promise<void> {
  const item = await getItemBySlug(t.db, slug);
  await t.db
    .insert(playerInventory)
    .values({ playerId: testerId, itemId: item.id, quantity })
    .onConflictDoUpdate({
      target: [playerInventory.playerId, playerInventory.itemId],
      set: { quantity },
    });
}

async function routeIds(): Promise<string[]> {
  const rows = await t.db
    .select({ r: playerUnlockedRoutes.regionId })
    .from(playerUnlockedRoutes)
    .where(eq(playerUnlockedRoutes.playerId, testerId));
  return rows.map((r) => r.r).sort();
}

/**
 * A disabled encounter that still awards a Belt component — what a live server
 * holds after migration 0044 retired the Teleporter Wreck. Nothing shipped
 * awards a component any more, so the reset's cooldown sweep needs one made.
 */
const RETIRED_WRECK = EncounterInputSchema.parse({
  slug: 'b8_teleporter_wreck',
  name: 'The Teleporter Wreck',
  type: 'discovery',
  rarity: 'rare',
  lifecycle: 'disabled',
  cooldownSeconds: 6 * 3600,
  regions: ['base-80085'],
  choices: [
    {
      label: 'Pry the core loose',
      check: { type: 'none' },
      successEffects: [{ type: 'give_item', slug: 'cracked_teleport_core', quantity: 1 }],
    },
  ],
});

async function encounterId(slug: string): Promise<number> {
  const [row] = await t.db.select({ id: worldEncounters.id }).from(worldEncounters).where(eq(worldEncounters.slug, slug));
  if (!row) throw new Error(`missing encounter ${slug}`);
  return row.id;
}

async function resetTester(): Promise<void> {
  await t.db.update(players).set({ level: 1, xp: 0, currentRegion: 'waifu-valley' }).where(eq(players.id, testerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 0, huntEnergy: 0 })
    .where(eq(playerCurrencies.playerId, testerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, testerId));
  await t.db.delete(playerUnlockedRoutes).where(eq(playerUnlockedRoutes.playerId, testerId));
  await t.db.delete(playerTravelPasses).where(eq(playerTravelPasses.playerId, testerId));
  await t.db.delete(worldEncounterCooldowns).where(eq(worldEncounterCooldowns.playerId, testerId));
}

/* ──────────────────────── environment & access ──────────────────────── */

describe('availability and access', () => {
  it('does not exist when the flag is off: routes 404 and the permission is not issued', async () => {
    expect((await get('/api/v1/admin/test-controls', OWNER_ID, offApi)).statusCode).toBe(404);
    const res = await post(`${base(testerId)}/level`, { level: 10 }, OWNER_ID, offApi);
    expect(res.statusCode).toBe(404);
    expect((await tester()).player.level).toBe(1);

    const auth = createPortalAuthorizationService({
      guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID }),
    });
    const perms = await auth.computePermissionsFor({
      discordUserId: OWNER_ID,
      selectedDiscordGuildId: GUILD_ID,
    } as PortalSession);
    expect(perms.permissions).not.toContain('players.testcontrols');
  });

  it('never issues the permission to a role grant when disabled, even if a grant row names it', async () => {
    const auth = createPortalAuthorizationService({
      guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID }),
      guildRoles: createGuildRoleService({
        fetchMemberRoleIds: async () => [TESTER_ROLE],
        fetchGuildRoles: async () => [],
        memberTtlMs: 0,
        rolesTtlMs: 0,
      }),
      roleGrants: createAdminRoleGrantService(t.db),
      testControlsEnabled: false,
    });
    const perms = await auth.computePermissionsFor({
      discordUserId: ADMIN_ID,
      selectedDiscordGuildId: GUILD_ID,
    } as PortalSession);
    expect(perms.permissions).not.toContain('players.testcontrols');
  });

  it('is available to the owner and to a role-granted admin', async () => {
    expect((await get('/api/v1/admin/test-controls', OWNER_ID)).statusCode).toBe(200);
    const res = await get(base(testerId), ADMIN_ID);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { playerId: number } }).data.playerId).toBe(testerId);
  });

  it('refuses a member without the permission', async () => {
    const res = await post(`${base(testerId)}/level`, { level: 10 }, PLAIN_ID);
    expect(res.statusCode).toBe(403);
    expect((await get(base(testerId), PLAIN_ID)).statusCode).toBe(403);
    expect((await tester()).player.level).toBe(1);
  });

  it('refuses the bearer token even with admin-bearer on', async () => {
    const res = await api.inject({
      method: 'POST',
      url: `${base(testerId)}/level`,
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: { level: 10 },
    });
    expect(res.statusCode).toBe(403);
    expect((await tester()).player.level).toBe(1);
  });

  it('refuses a mutation without the CSRF header', async () => {
    const jar = login(OWNER_ID);
    const res = await api.inject({
      method: 'POST',
      url: `${base(testerId)}/level`,
      cookies: jar.cookies,
      payload: { level: 10 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('answers 404 for a player in another guild, and for an unknown id', async () => {
    expect((await post(`${base(outsiderId)}/level`, { level: 10 })).statusCode).toBe(404);
    expect((await get(base(outsiderId))).statusCode).toBe(404);
    expect((await post(`${base(999_999)}/level`, { level: 10 })).statusCode).toBe(404);
  });

  it('refuses at request time once the deployment reads as production', async () => {
    controlsConfig.deploymentEnv = 'production';
    const res = await post(`${base(testerId)}/level`, { level: 10 });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('TEST_CONTROLS_DISABLED');
    expect((await tester()).player.level).toBe(1);

    controlsConfig.deploymentEnv = 'staging';
    controlsConfig.enabled = false;
    expect((await post(`${base(testerId)}/waifubux/add`, { amount: 5 })).statusCode).toBe(403);
    expect((await tester()).currencies.waifubux).toBe(0);
  });

  it('cannot be constructed for production', () => {
    expect(() =>
      createStagingTestControlsService({
        db: t.db,
        currency: app.currency,
        inventory: app.inventory,
        travel: app.travel,
        progression: app.progression,
        getContent: () => app.content,
        logger: t.logger,
        config: { enabled: true, deploymentEnv: 'production' },
      }),
    ).toThrow(TestControlsDisabledError);
  });
});

/* ───────────────────────────── progression ───────────────────────────── */

describe('Set Player Level', () => {
  it('sets level and XP consistently with the level curve', async () => {
    const res = await post(`${base(testerId)}/level`, { level: 25 });
    expect(res.statusCode).toBe(200);
    const { player } = await tester();
    expect(player.level).toBe(25);
    expect(player.xp).toBe(app.progression.cumulativeXpForLevel(25));
    // The stored level agrees with the level derived from XP — no faking.
    expect(app.progression.levelFromXp(player.xp)).toBe(25);
    expect((res.json() as ResultBody).data.changes).toContainEqual({ field: 'level', before: 1, after: 25 });
  });

  it('trims Energy to the new maximum when the level goes down', async () => {
    await post(`${base(testerId)}/level`, { level: 45 });
    const high = app.progression.computeMaxEnergy(45);
    await post(`${base(testerId)}/energy`, { energy: high });
    await post(`${base(testerId)}/level`, { level: 1 });
    expect((await tester()).currencies.huntEnergy).toBe(app.progression.computeMaxEnergy(1));
  });

  it('rejects levels outside 1..maxLevel and non-integers', async () => {
    const max = app.progression.maxLevel();
    for (const level of [0, -3, max + 1, 12.5]) {
      const res = await post(`${base(testerId)}/level`, { level });
      expect(res.statusCode, `level ${level}`).toBe(400);
    }
    expect((await post(`${base(testerId)}/level`, { level: '10' })).statusCode).toBe(400);
    expect((await tester()).player.level).toBe(1);
  });
});

/* ───────────────────────────── WaifuBux ───────────────────────────── */

describe('WaifuBux', () => {
  it('adds and removes', async () => {
    expect((await post(`${base(testerId)}/waifubux/add`, { amount: 5000 })).statusCode).toBe(200);
    expect((await tester()).currencies.waifubux).toBe(5000);
    expect((await post(`${base(testerId)}/waifubux/remove`, { amount: 1200 })).statusCode).toBe(200);
    expect((await tester()).currencies.waifubux).toBe(3800);
  });

  it('never goes below zero', async () => {
    await post(`${base(testerId)}/waifubux/add`, { amount: 100 });
    const res = await post(`${base(testerId)}/waifubux/remove`, { amount: 101 });
    expect(res.statusCode).toBe(422);
    expect((await tester()).currencies.waifubux).toBe(100);
  });

  it('serializes simultaneous removals so the balance cannot go negative', async () => {
    await post(`${base(testerId)}/waifubux/add`, { amount: 100 });
    const results = await Promise.all([
      post(`${base(testerId)}/waifubux/remove`, { amount: 60 }),
      post(`${base(testerId)}/waifubux/remove`, { amount: 60 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    expect((await tester()).currencies.waifubux).toBe(40);
  });

  it('rejects zero, negative and non-integer amounts', async () => {
    for (const amount of [0, -5, 1.5]) {
      expect((await post(`${base(testerId)}/waifubux/add`, { amount })).statusCode).toBe(400);
    }
  });
});

/* ───────────────────────────── Energy ───────────────────────────── */

describe('Energy', () => {
  it('sets Energy within 0..max for the player level', async () => {
    const max = app.progression.computeMaxEnergy(1);
    expect((await post(`${base(testerId)}/energy`, { energy: max })).statusCode).toBe(200);
    expect((await tester()).currencies.huntEnergy).toBe(max);
    expect((await post(`${base(testerId)}/energy`, { energy: 0 })).statusCode).toBe(200);
    expect((await tester()).currencies.huntEnergy).toBe(0);
  });

  it('rejects over-cap and negative Energy', async () => {
    const max = app.progression.computeMaxEnergy(1);
    expect((await post(`${base(testerId)}/energy`, { energy: max + 1 })).statusCode).toBe(400);
    expect((await post(`${base(testerId)}/energy`, { energy: -1 })).statusCode).toBe(400);
    expect((await tester()).currencies.huntEnergy).toBe(0);
  });
});

/* ───────────────────────────── Beacon ───────────────────────────── */

describe('Transporter Beacon', () => {
  it('reports the Belt with no level requirement, and standard routes with theirs', async () => {
    const res = await get(base(testerId));
    expect(res.statusCode).toBe(200);
    const state = (
      res.json() as {
        data: {
          beacon: { slug: string; requiredLevel: number | null } | null;
          routes: { regionId: string; requiredLevel: number | null }[];
        };
      }
    ).data;
    expect(state.beacon!.slug).toBe(BEACON);
    expect(state.beacon!.requiredLevel).toBeNull();
    expect(state.routes.map((r) => [r.regionId, r.requiredLevel])).toEqual([
      ['twin-peeks', 15],
      ['flaccid-foothills', 20],
      ['thirstlands', 25],
      ['base-80085', 30],
    ]);
  });

  it('grants one beacon', async () => {
    const res = await post(`${base(testerId)}/beacon/grant`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as ResultBody).data.changed).toBe(true);
    expect(await qty(BEACON)).toBe(1);
  });

  it('treats a duplicate grant as a harmless no-op, including concurrent clicks', async () => {
    await post(`${base(testerId)}/beacon/grant`);
    const again = await post(`${base(testerId)}/beacon/grant`);
    expect(again.statusCode).toBe(200);
    expect((again.json() as ResultBody).data.changed).toBe(false);
    expect(await qty(BEACON)).toBe(1);

    await resetTester();
    const burst = await Promise.all([1, 2, 3].map(() => post(`${base(testerId)}/beacon/grant`)));
    expect(burst.every((r) => r.statusCode === 200)).toBe(true);
    expect(burst.filter((r) => (r.json() as ResultBody).data.changed)).toHaveLength(1);
    expect(await qty(BEACON)).toBe(1);
  });

  it('revokes the beacon', async () => {
    await post(`${base(testerId)}/beacon/grant`);
    const res = await post(`${base(testerId)}/beacon/revoke`);
    expect(res.statusCode).toBe(200);
    expect(await qty(BEACON)).toBe(0);
    // Revoking what is not there is informational, not an error.
    const again = await post(`${base(testerId)}/beacon/revoke`);
    expect(again.statusCode).toBe(200);
    expect((again.json() as ResultBody).data.changed).toBe(false);
  });

  it('returns a player standing in the Belt to Waifu Valley when revoking', async () => {
    await post(`${base(testerId)}/beacon/grant`);
    await forceRegion(t.db, testerId, BELT);
    const res = await post(`${base(testerId)}/beacon/revoke`);
    expect(res.statusCode).toBe(200);
    expect((await tester()).player.currentRegion).toBe('waifu-valley');
    expect((res.json() as ResultBody).data.changes).toContainEqual({
      field: 'currentRegion',
      before: BELT,
      after: 'waifu-valley',
    });
  });
});

/* ───────────────────────────── Travel ───────────────────────────── */

describe('Grant All Standard Travel Access', () => {
  it('grants every pass/route destination and the pass, but not the Beacon or the Belt', async () => {
    const res = await post(`${base(testerId)}/travel/grant-standard`);
    expect(res.statusCode).toBe(200);
    expect(await routeIds()).toEqual(STANDARD_ROUTES);
    const passes = await t.db.select().from(playerTravelPasses).where(eq(playerTravelPasses.playerId, testerId));
    expect(passes.map((p) => p.passId)).toEqual(['caravan_pass']);
    expect(await qty(BEACON)).toBe(0);
    expect(await routeIds()).not.toContain(BELT);
  });

  it('is idempotent — a repeat creates no duplicate state', async () => {
    await post(`${base(testerId)}/travel/grant-standard`);
    const again = await post(`${base(testerId)}/travel/grant-standard`);
    expect((again.json() as ResultBody).data.changed).toBe(false);
    expect(await routeIds()).toEqual(STANDARD_ROUTES);
  });
});

/* ───────────────────────────── Staging Boost ───────────────────────────── */

describe('Prepare Player for Current Content', () => {
  it('sets level 40, adds 10,000 WaifuBux, refills Energy and grants standard travel — and nothing else', async () => {
    await post(`${base(testerId)}/waifubux/add`, { amount: 250 });
    await setQty('basic_charm', 3);

    const res = await post(`${base(testerId)}/staging-boost`);
    expect(res.statusCode).toBe(200);
    const { player, currencies } = await tester();
    expect(player.level).toBe(STAGING_BOOST.level);
    expect(player.level).toBe(40);
    expect(currencies.waifubux).toBe(250 + 10_000);
    expect(currencies.huntEnergy).toBe(app.progression.computeMaxEnergy(40));
    expect(await routeIds()).toEqual(STANDARD_ROUTES);

    // Not granted: the Beacon, any Belt component. Untouched: other inventory.
    expect(await qty(BEACON)).toBe(0);
    for (const slug of COMPONENTS) expect(await qty(slug)).toBe(0);
    expect(await qty('basic_charm')).toBe(3);

    // The report says exactly what changed.
    const fields = (res.json() as ResultBody).data.changes.map((c) => c.field);
    expect(fields).toEqual(expect.arrayContaining(['level', 'xp', 'waifubux', 'energy', 'passes', 'routes']));
  });

  it('writes one audit row with structured per-step metadata', async () => {
    await post(`${base(testerId)}/staging-boost`);
    const [row] = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(
        and(
          eq(playerProgressionEvents.playerId, testerId),
          eq(playerProgressionEvents.eventType, ADMIN_ACTION_EVENT),
          sql`${playerProgressionEvents.metadata}->>'action' = 'test_staging_boost'`,
        ),
      )
      .orderBy(sql`${playerProgressionEvents.id} desc`)
      .limit(1);
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.adminDiscordId).toBe(OWNER_ID);
    expect(meta.steps).toMatchObject({
      level: { target: 40 },
      waifubux: { added: 10_000 },
      travel: {},
      energy: {},
    });
    // The XP column records the real movement, so the ledger reconciles.
    expect(row!.xpDelta).toBe(app.progression.cumulativeXpForLevel(40));
  });
});

/* ───────────────────────────── Belt reset ───────────────────────────── */

describe('Reset Assteroid Belt Unlock Test State', () => {
  async function dirtyBeltState(): Promise<{ wreck: number; other: number }> {
    await post(`${base(testerId)}/level`, { level: 38 });
    await post(`${base(testerId)}/waifubux/add`, { amount: 4321 });
    await setQty(BEACON, 1);
    for (const slug of COMPONENTS) await setQty(slug, 2);
    await setQty('basic_charm', 5);
    // A legacy pre-beacon route row for the Belt, plus an ordinary route.
    await t.db.insert(playerUnlockedRoutes).values([
      { playerId: testerId, regionId: BELT, source: 'purchase' },
      { playerId: testerId, regionId: 'twin-peeks', source: 'purchase' },
    ]);
    await seedWorldEncounters(t.db, { catalogue: [RETIRED_WRECK] });
    const wreck = await encounterId(RETIRED_WRECK.slug);
    const other = await encounterId('tv_bandit_ambush');
    const later = new Date(Date.now() + 3_600_000);
    await t.db.insert(worldEncounterCooldowns).values([
      { playerId: testerId, encounterId: wreck, expiresAt: later },
      { playerId: testerId, encounterId: other, expiresAt: later },
    ]);
    await forceRegion(t.db, testerId, BELT);
    return { wreck, other };
  }

  it('removes the Beacon, components, legacy route and component-encounter cooldowns, and returns the player home', async () => {
    const { wreck, other } = await dirtyBeltState();

    const res = await post(`${base(testerId)}/reset-assteroid-belt`);
    expect(res.statusCode).toBe(200);

    expect(await qty(BEACON)).toBe(0);
    for (const slug of COMPONENTS) expect(await qty(slug), slug).toBe(0);
    expect(await routeIds()).toEqual(['twin-peeks']);
    expect((await tester()).player.currentRegion).toBe('waifu-valley');

    const cooldowns = await t.db
      .select({ id: worldEncounterCooldowns.encounterId })
      .from(worldEncounterCooldowns)
      .where(eq(worldEncounterCooldowns.playerId, testerId));
    expect(cooldowns.map((c) => c.id)).toEqual([other]);
    expect(cooldowns.map((c) => c.id)).not.toContain(wreck);
  });

  it('does not touch unrelated inventory, currency or progression', async () => {
    await dirtyBeltState();
    const before = await tester();
    await post(`${base(testerId)}/reset-assteroid-belt`);
    const after = await tester();
    expect(after.player.level).toBe(before.player.level);
    expect(after.player.xp).toBe(before.player.xp);
    expect(after.currencies.waifubux).toBe(before.currencies.waifubux);
    expect(after.currencies.huntEnergy).toBe(before.currencies.huntEnergy);
    expect(await qty('basic_charm')).toBe(5);
  });

  it('is safe when the target state is already absent', async () => {
    const first = await post(`${base(testerId)}/reset-assteroid-belt`);
    expect(first.statusCode).toBe(200);
    expect((first.json() as ResultBody).data.changed).toBe(false);
  });

  it('leaves the player able to build the Beacon from scratch again', async () => {
    await dirtyBeltState();
    await post(`${base(testerId)}/reset-assteroid-belt`);
    const progress = await app.keyItems.getProgress(testerId, 'transporter_beacon');
    expect(progress.outputOwned).toBe(false);
    expect(progress.components.every((c) => c.owned === 0)).toBe(true);
  });
});

/* ───────────────────────────── audit ───────────────────────────── */

describe('audit', () => {
  it('writes an admin_player_action row for every action, naming the admin and before/after', async () => {
    await t.db.delete(playerProgressionEvents).where(eq(playerProgressionEvents.playerId, testerId));
    const calls: [string, Record<string, unknown>][] = [
      ['level', { level: 5 }],
      ['waifubux/add', { amount: 50 }],
      ['waifubux/remove', { amount: 10 }],
      ['energy', { energy: 3 }],
      ['beacon/grant', {}],
      ['beacon/revoke', {}],
      ['travel/grant-standard', {}],
      ['staging-boost', {}],
      ['reset-assteroid-belt', {}],
      ['reset-equipment-onboarding', {}],
      ['reset-delve-usage', {}],
    ];
    for (const [path, body] of calls) {
      const res = await post(`${base(testerId)}/${path}`, body, ADMIN_ID);
      expect(res.statusCode, path).toBe(200);
    }
    const rows = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(
        and(
          eq(playerProgressionEvents.playerId, testerId),
          eq(playerProgressionEvents.eventType, ADMIN_ACTION_EVENT),
        ),
      );
    const metas = rows.map((r) => r.metadata as Record<string, unknown>);
    expect(metas.map((m) => m.action).sort()).toEqual([...TEST_CONTROL_ACTIONS].sort());
    for (const m of metas) {
      expect(m.adminDiscordId).toBe(ADMIN_ID);
      expect(m.targetDiscordId).toBe(TESTER_ID);
      expect(m.guildId).toBe(GUILD_ID);
      expect(m.deploymentEnv).toBe('staging');
      expect(m).toHaveProperty('before');
      expect(m).toHaveProperty('after');
      // Never a secret: no session token or CSRF value in the row.
      expect(JSON.stringify(m)).not.toContain(CSRF);
      expect(JSON.stringify(m)).not.toContain('token-');
    }
    const level = metas.find((m) => m.action === 'test_set_player_level')!;
    expect(level.before).toMatchObject({ level: 1 });
    expect(level.after).toMatchObject({ level: 5 });
  });

  it('writes nothing when an action is refused', async () => {
    await t.db.delete(playerProgressionEvents).where(eq(playerProgressionEvents.playerId, testerId));
    await post(`${base(testerId)}/waifubux/remove`, { amount: 1 });
    await post(`${base(testerId)}/level`, { level: 0 });
    const rows = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(eq(playerProgressionEvents.playerId, testerId));
    expect(rows).toHaveLength(0);
  });
});
