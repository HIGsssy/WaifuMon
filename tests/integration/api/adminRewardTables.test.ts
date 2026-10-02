/**
 * Portal admin — boss and expedition reward tables over HTTP, against a real
 * database. Pins the contract the editor depends on: permission gating, the
 * 400 `REWARD_TABLE_INVALID` with per-path issues, the 409
 * `REWARD_TABLE_STALE` with the current revision, refused deletes, previews,
 * and the export → plan → apply round trip.
 *
 * Driven with the bearer token under `adminBearer: true`, like
 * `adminVendors.test.ts`; permission is checked with a non-owner session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../../src/modules/equipment/seed';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import { createRewardTableService } from '../../../src/modules/rewardTables/rewardTableService';
import { loadShippedRewardTables, seedRewardTables } from '../../../src/modules/rewardTables/rewardTableStore';
import { CONTENT_DIR, bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555888';
const OWNER_ID = '777888999000111444';
const NON_OWNER_ID = '999999999999999997';
const NON_OWNER_TOKEN = 'token-non-owner';
const BOSS_TABLE = 'standard-scouting-v1';

let t: TestDb;
let app: App;
let api: ZodFastify;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  await provisionPlayer(app, GUILD_ID, OWNER_ID);
  await provisionPlayer(app, GUILD_ID, NON_OWNER_ID);
  await seedEquipmentDefinitions(t.db, { mode: 'insert-missing', catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  const shipped = loadShippedRewardTables(CONTENT_DIR);
  await seedRewardTables(t.db, shipped);
  const rewardTables = createRewardTableService({ db: t.db, getContent: () => app.content, getShipped: () => shipped });

  const guildOwnership = createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID });
  const portalAuthorization = createPortalAuthorizationService({ guildOwnership });
  const nonOwner: PortalSession = {
    sessionDigest: 'digest',
    discordUserId: NON_OWNER_ID,
    discordUsername: null,
    discordAvatarUrl: null,
    selectedDiscordGuildId: GUILD_ID,
    selectedGuildDbId: 1,
    playerId: 1,
    eligibleGuilds: [],
    csrfToken: 'csrf-token',
    expiresAt: new Date(Date.now() + 60_000),
  };
  const sessions = {
    getSession: async (token: string | undefined) => (token === NON_OWNER_TOKEN ? nonOwner : null),
    toBrowserSession: () => ({ authenticated: false }),
    safeEquals: (a: string, b: string) => a === b,
    logout: async () => {},
    selectGuild: async () => null,
    completeOAuth: async () => {
      throw new Error('not stubbed');
    },
    createOAuthState: async () => 'state',
    consumeOAuthState: async () => true,
  };

  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3134, token: TEST_TOKEN, adminBearer: true },
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
      services: { ...app, rewardTables },
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

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    headers: AUTH_BEARER,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

interface Detail {
  id: string;
  revision: number;
  origin: string;
  table: Record<string, unknown> & { groups: unknown[] };
  issues: { path: string; severity: string }[];
}
const data = <T>(res: { json(): unknown }) => (res.json() as { data: T }).data;

describe('permissions', () => {
  it('refuses without auth, and a portal user without rewards permissions', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/v1/admin/reward-tables' })).statusCode).toBe(401);
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/reward-tables',
      cookies: { wm_portal_session: NON_OWNER_TOKEN },
    });
    expect(res.statusCode).toBe(403);
    const write = await api.inject({
      method: 'PUT',
      url: `/api/v1/admin/reward-tables/boss/${BOSS_TABLE}`,
      cookies: { wm_portal_session: NON_OWNER_TOKEN, wm_portal_csrf: 'csrf-token' },
      headers: { 'x-csrf-token': 'csrf-token' },
      payload: { table: {}, expectedRevision: 1 },
    });
    expect(write.statusCode).toBe(403);
  });
});

describe('reads', () => {
  it('lists both kinds and gets one with its revision', async () => {
    const list = data<{ tables: { kind: string; id: string }[] }>(await call('GET', '/admin/reward-tables'));
    expect(list.tables.some((x) => x.kind === 'boss')).toBe(true);
    expect(list.tables.some((x) => x.kind === 'expedition')).toBe(true);
    const boss = data<{ tables: unknown[] }>(await call('GET', '/admin/reward-tables?kind=boss'));
    expect(boss.tables).toHaveLength(app.content.bossRewards.length);
    const detail = data<Detail>(await call('GET', `/admin/reward-tables/boss/${BOSS_TABLE}`));
    expect(detail).toMatchObject({ id: BOSS_TABLE, origin: 'shipped' });
    expect((await call('GET', '/admin/reward-tables/boss/missing')).statusCode).toBe(404);
    expect((await call('GET', '/admin/reward-tables/nonsense/x')).statusCode).toBe(400);
  });

  it('serves the editor reference data', async () => {
    const ref = data<{ items: { slug: string }[]; equipmentDefinitions: { key: string }[] }>(
      await call('GET', '/admin/reward-tables/reference'),
    );
    expect(ref.items.some((i) => i.slug === 'basic_charm')).toBe(true);
    expect(ref.equipmentDefinitions.some((d) => d.key === 'combat_knife')).toBe(true);
  });

  it('previews Equipment selectors from the database', async () => {
    const res = data<{ previews: { eligible: { slot: string }[]; issues: unknown[] }[] }>(
      await call('POST', '/admin/reward-tables/equipment-preview', {
        selectors: [{ slot: 'attack', rarity: 'R' }, { rarity: 'UR' }],
      }),
    );
    expect(res.previews[0]!.eligible.length).toBeGreaterThan(0);
    expect(res.previews[1]!.issues).not.toEqual([]);
  });
});

describe('writes', () => {
  it('saves, then refuses a stale save with 409 and the current revision', async () => {
    const detail = data<Detail>(await call('GET', `/admin/reward-tables/boss/${BOSS_TABLE}`));
    const saved = await call('PUT', `/admin/reward-tables/boss/${BOSS_TABLE}`, {
      table: { ...detail.table, buddyXp: 66 },
      expectedRevision: detail.revision,
    });
    expect(saved.statusCode).toBe(200);
    expect(data<Detail>(saved)).toMatchObject({ revision: detail.revision + 1, origin: 'edited' });

    const stale = await call('PUT', `/admin/reward-tables/boss/${BOSS_TABLE}`, {
      table: { ...detail.table, buddyXp: 67 },
      expectedRevision: detail.revision,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        code: 'REWARD_TABLE_STALE',
        details: { expectedRevision: detail.revision, currentRevision: detail.revision + 1 },
      },
    });
  });

  it('refuses an invalid table with 400 and per-path issues', async () => {
    const detail = data<Detail>(await call('GET', `/admin/reward-tables/boss/${BOSS_TABLE}`));
    const res = await call('PUT', `/admin/reward-tables/boss/${BOSS_TABLE}`, {
      table: {
        ...detail.table,
        groups: [{ id: 'gear', entries: [], equipment: [{ definitionKeys: ['does_not_exist'], weight: 1 }] }],
      },
      expectedRevision: detail.revision,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: {
        code: 'REWARD_TABLE_INVALID',
        details: {
          issues: [
            expect.objectContaining({ path: 'groups[0].equipment[0].definitionKeys[0]', severity: 'error' }),
          ],
        },
      },
    });
  });

  it('validates without writing', async () => {
    const res = data<{ issues: { path: string }[] }>(
      await call('POST', '/admin/reward-tables/expedition/validate', {
        table: { id: 'x', groups: [{ id: 'g', entries: [{ itemId: 'nope', weight: 1 }] }] },
      }),
    );
    expect(res.issues.map((i) => i.path)).toEqual(['groups[0].entries[0].itemId']);
  });

  it('creates, refuses deleting a referenced or shipped table, deletes a scratch one', async () => {
    const created = await call('POST', '/admin/reward-tables/expedition', { table: { id: 'scratch', groups: [] } });
    expect(created.statusCode).toBe(200);
    expect((await call('POST', '/admin/reward-tables/expedition', { table: { id: 'scratch', groups: [] } })).statusCode).toBe(409);
    const refused = await call('DELETE', `/admin/reward-tables/boss/${BOSS_TABLE}?expectedRevision=2`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'REWARD_TABLE_DELETE_REFUSED' } });
    expect((await call('DELETE', '/admin/reward-tables/expedition/scratch?expectedRevision=1')).statusCode).toBe(200);
  });

  it('resets an edited table to shipped', async () => {
    const detail = data<Detail>(await call('GET', `/admin/reward-tables/boss/${BOSS_TABLE}`));
    const res = await call('POST', `/admin/reward-tables/boss/${BOSS_TABLE}/reset`, { expectedRevision: detail.revision });
    expect(res.statusCode).toBe(200);
    expect(data<Detail>(res)).toMatchObject({ origin: 'shipped' });
  });
});

describe('export and import', () => {
  it('round-trips an export through plan and apply', async () => {
    const exported = data<{ file: string; tables: Record<string, unknown>[] }>(
      await call('GET', '/admin/reward-tables/expedition/export'),
    );
    expect(exported.file).toBe('expeditionRewards.json');
    const pkg = [{ ...exported.tables[0]!, playerXp: 3 }, ...exported.tables.slice(1)];
    const planRes = await call('POST', '/admin/reward-tables/expedition/import/plan', { tables: pkg });
    expect(planRes.statusCode, planRes.body.slice(0, 300)).toBe(200);
    const plan = data<{ canApply: boolean; entries: { id: string; action: string; currentRevision: number | null }[] }>(
      await call('POST', '/admin/reward-tables/expedition/import/plan', { tables: pkg }),
    );
    expect(plan.canApply).toBe(true);
    expect(plan.entries.filter((e) => e.action === 'update')).toHaveLength(1);
    const expectedRevisions = Object.fromEntries(plan.entries.map((e) => [e.id, e.currentRevision]));
    const applied = await call('POST', '/admin/reward-tables/expedition/import/apply', { tables: pkg, expectedRevisions });
    expect(applied.statusCode).toBe(200);
    expect(data<{ updated: string[] }>(applied).updated).toEqual([String(exported.tables[0]!.id)]);
    // Applying the same reviewed plan again is stale: the revision moved.
    const again = await call('POST', '/admin/reward-tables/expedition/import/apply', { tables: pkg, expectedRevisions });
    expect(again.statusCode).toBe(409);
  });
});
