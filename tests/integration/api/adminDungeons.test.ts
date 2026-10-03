/**
 * Portal admin — dungeon zones, the progression currency and the generation
 * preview over HTTP, against a real database. Pins the contract the editor
 * depends on: permission gating, the 400 `DUNGEON_ZONE_INVALID` with per-path
 * issues, the 409 `DUNGEON_ZONE_STALE` with the current revision, the
 * immutable keys, and a preview that reproduces from its seed and persists
 * nothing.
 *
 * Driven with the bearer token under `adminBearer: true`, like
 * `adminRewardTables.test.ts`; permission is checked with a non-owner session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { dungeonRuns } from '../../../src/db/schema';
import { createDungeonAllowanceService } from '../../../src/modules/dungeons/dungeonAllowanceService';
import { createDungeonZoneService } from '../../../src/modules/dungeons/dungeonZoneService';
import { loadShippedDungeonZones, seedDungeonZones } from '../../../src/modules/dungeons/dungeonZoneStore';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import { createProgressionCurrencyService } from '../../../src/modules/progressionCurrency/progressionCurrencyService';
import { loadShippedRewardTables, seedRewardTables } from '../../../src/modules/rewardTables/rewardTableStore';
import { CONTENT_DIR, bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555999';
const OWNER_ID = '777888999000111555';
const NON_OWNER_ID = '999999999999999996';
const NON_OWNER_TOKEN = 'token-non-owner';
const ZONE = 'scrapheap_gauntlet';
const CURRENCY = 'ascension_currency';

let t: TestDb;
let app: App;
let api: ZodFastify;
/** A small assets tree: one deployed zone image, and a file in another area's folder. */
const assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-admin-assets-'));
const assetsDir = path.join(assetsRoot, 'assets');
for (const [file, bytes] of [
  ['dungeons/zones/deployed.webp', 'webp-bytes'],
  ['dungeons/backgrounds/.keep', ''],
  ['results/secret.webp', 'not for this picker'],
] as const) {
  fs.mkdirSync(path.join(assetsDir, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, file), bytes);
}
fs.writeFileSync(path.join(assetsRoot, 'outside.webp'), 'outside the assets root');

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  await provisionPlayer(app, GUILD_ID, OWNER_ID);
  await provisionPlayer(app, GUILD_ID, NON_OWNER_ID);
  await seedRewardTables(t.db, loadShippedRewardTables(CONTENT_DIR));
  const shipped = loadShippedDungeonZones(CONTENT_DIR);
  await seedDungeonZones(t.db, shipped);
  const dungeonZones = createDungeonZoneService({ db: t.db, getContent: () => app.content, getShipped: () => shipped });
  const progressionCurrency = createProgressionCurrencyService(t.db);
  const dungeonAllowance = createDungeonAllowanceService({ db: t.db, timezone: 'UTC' });

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
    config: { enabled: true, host: '127.0.0.1', port: 3135, token: TEST_TOKEN, adminBearer: true },
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
      assetsDir,
      services: { ...app, dungeonZones, progressionCurrency, dungeonAllowance },
      getContent: () => app.content,
      portalAuthorization,
      adminBearerAllowed: true,
    },
  });
});

afterAll(async () => {
  fs.rmSync(assetsRoot, { recursive: true, force: true });
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

type Zone = Record<string, any>;
interface Detail {
  key: string;
  name: string;
  enabled: boolean;
  revision: number;
  origin: string;
  zone: Zone;
  issues: { path: string; severity: string; message: string }[];
}
interface ErrorBody {
  error: { code: string; details?: { issues?: { path: string; severity: string }[]; currentRevision?: number } & Record<string, unknown> };
}
const data = <T>(res: { json(): unknown }) => (res.json() as { data: T }).data;
const errorOf = (res: { json(): unknown }) => (res.json() as ErrorBody).error;
const errorPaths = (res: { json(): unknown }) =>
  (errorOf(res).details?.issues ?? []).filter((i) => i.severity === 'error').map((i) => i.path);
const getZone = async (key = ZONE) => data<Detail>(await call('GET', `/admin/dungeons/zones/${key}`));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A draft based on the shipped zone, under a new key. */
const draft = async (key: string, mutate: (zone: Zone) => void = () => {}) => {
  const zone = clone((await getZone()).zone);
  zone.key = key;
  zone.name = `Draft ${key}`;
  zone.order = 50;
  mutate(zone);
  return zone;
};

/** Create is refused with 400, nothing is stored; returns the error paths. */
const rejected = async (key: string, mutate: (zone: Zone) => void) => {
  const res = await call('POST', '/admin/dungeons/zones', { zone: await draft(key, mutate) });
  expect(res.statusCode, key).toBe(400);
  expect(errorOf(res).code).toBe('DUNGEON_ZONE_INVALID');
  expect((await call('GET', `/admin/dungeons/zones/${key}`)).statusCode).toBe(404);
  return errorPaths(res);
};

describe('permissions', () => {
  it('refuses without auth, and a portal user without dungeon permissions', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/v1/admin/dungeons/zones' })).statusCode).toBe(401);
    const cookies = { wm_portal_session: NON_OWNER_TOKEN, wm_portal_csrf: 'csrf-token' };
    const headers = { 'x-csrf-token': 'csrf-token' };
    for (const url of ['/admin/dungeons/zones', '/admin/dungeons/currencies', '/admin/dungeons/reference', '/admin/dungeons/settings']) {
      expect((await api.inject({ method: 'GET', url: `/api/v1${url}`, cookies })).statusCode).toBe(403);
    }
    const writes: [string, string, unknown][] = [
      ['PUT', `/admin/dungeons/zones/${ZONE}`, { zone: {}, expectedRevision: 1 }],
      ['PUT', `/admin/dungeons/zones/${ZONE}/enabled`, { enabled: false, expectedRevision: 1 }],
      ['POST', '/admin/dungeons/zones', { zone: {} }],
      ['POST', '/admin/dungeons/preview', { key: ZONE }],
      ['PUT', `/admin/dungeons/currencies/${CURRENCY}`, { singularName: 'X', pluralName: 'Xs', enabled: true, expectedRevision: 1 }],
      ['PUT', '/admin/dungeons/settings', { dailyRunLimit: 9 }],
    ];
    for (const [method, url, payload] of writes) {
      const res = await api.inject({ method: method as 'PUT', url: `/api/v1${url}`, cookies, headers, payload: payload as object });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await getZone()).revision).toBe(1);
  });
});

describe('zone list and detail', () => {
  it('lists zones with name, enabled, node range, pool counts, revision and last update', async () => {
    const list = data<{ zones: Record<string, unknown>[] }>(await call('GET', '/admin/dungeons/zones'));
    const zone = list.zones.find((z) => z.key === ZONE)!;
    expect(zone).toMatchObject({
      name: 'Scrapheap Gauntlet',
      enabled: true,
      minNodes: 6,
      maxNodes: 9,
      poolCount: 4,
      poolEntryCount: 8,
      rewardBandCount: 6,
      revision: 1,
      origin: 'shipped',
      matchesShipped: true,
      updatedBy: 'seed',
    });
    expect(Number.isNaN(Date.parse(zone.updatedAt as string))).toBe(false);
  });

  it('gets one zone with its whole document and no issues, and 404s an unknown key', async () => {
    const detail = await getZone();
    expect(detail.issues).toEqual([]);
    expect(detail.zone.generation.minNodes).toBe(6);
    expect(detail.zone.pools.boss).toHaveLength(1);
    expect(detail.zone.rewards.defeatCurrencyRetentionBasisPoints).toBe(2500);
    expect((await call('GET', '/admin/dungeons/zones/nowhere')).statusCode).toBe(404);
    expect((await call('GET', '/admin/dungeons/zones/Not%20A%20Key')).statusCode).toBe(400);
  });

  it('serves the pickers from authoritative data', async () => {
    const ref = data<{
      nodeTypes: string[];
      enemies: { key: string }[];
      events: { key: string }[];
      rewardTables: { id: string }[];
      currencies: { key: string }[];
    }>(await call('GET', '/admin/dungeons/reference'));
    expect(ref.nodeTypes).toEqual(['combat', 'elite', 'event', 'reward', 'rest', 'miniboss', 'boss', 'exit']);
    expect(ref.enemies.map((e) => e.key)).toEqual(app.content.combatEnemies!.map((e) => e.key));
    expect(ref.events.map((e) => e.key)).toEqual(app.content.dungeonEvents!.map((e) => e.key));
    expect(ref.rewardTables).toHaveLength(app.content.expeditionRewards.length);
    expect(ref.currencies.map((c) => c.key)).toEqual([CURRENCY]);
  });

  it('exports the live zones in the shipped file format', async () => {
    const exported = data<{ file: string; document: { format: string; version: number; zones: Zone[] } }>(
      await call('GET', '/admin/dungeons/export'),
    );
    expect(exported.file).toBe('dungeons/zones.json');
    expect(exported.document).toMatchObject({ format: 'waifumon-dungeon-zones', version: 1 });
    expect(exported.document.zones.find((z) => z.key === ZONE)).toEqual((await getZone()).zone);
  });
});

describe('create, edit, disable', () => {
  it('creates a zone, edits it, and bumps the revision each time', async () => {
    const created = await call('POST', '/admin/dungeons/zones', { zone: await draft('rust_warrens') });
    expect(created.statusCode).toBe(200);
    expect(data<Detail>(created)).toMatchObject({ key: 'rust_warrens', revision: 1, origin: 'custom' });

    const zone = data<Detail>(created).zone;
    zone.name = 'Rust Warrens';
    zone.description = 'Deeper, wetter, worse.';
    zone.tags = ['organic', 'initial_tuning'];
    zone.generation.maxNodes = 12;
    zone.generation.branching = { minBranches: 0, maxBranches: 2, chanceBasisPoints: 4500, maxLength: 2 };
    zone.generation.extraction.minDepth = 3;
    zone.generation.nodeWeights.combat = 80;
    zone.rewards.defeatCurrencyRetentionBasisPoints = 4000;
    zone.artworkPath = 'dungeons/zones/rust_warrens.webp';
    zone.backgroundArtworkPath = 'dungeons/backgrounds/rust_warrens.webp';
    const saved = await call('PUT', '/admin/dungeons/zones/rust_warrens', { zone, expectedRevision: 1 });
    expect(saved.statusCode).toBe(200);
    const detail = data<Detail>(saved);
    expect(detail).toMatchObject({ name: 'Rust Warrens', revision: 2 });
    expect(detail.zone).toEqual(zone);
    expect((await getZone('rust_warrens')).zone.rewards.defeatCurrencyRetentionBasisPoints).toBe(4000);
  });

  it('refuses a taken key, a reserved key and a changed key', async () => {
    const taken = await call('POST', '/admin/dungeons/zones', { zone: await draft(ZONE) });
    expect(taken.statusCode).toBe(409);
    expect(errorOf(taken).code).toBe('DUNGEON_ZONE_KEY_TAKEN');

    const reserved = await call('POST', '/admin/dungeons/zones', { zone: await draft('preview') });
    expect(reserved.statusCode).toBe(400);
    expect(errorPaths(reserved)).toEqual(['key']);

    const current = await getZone();
    const renamed = await call('PUT', `/admin/dungeons/zones/${ZONE}`, {
      zone: { ...current.zone, key: 'renamed_zone' },
      expectedRevision: current.revision,
    });
    expect(renamed.statusCode).toBe(400);
    expect(errorPaths(renamed)).toEqual(['key']);
    expect((await call('GET', '/admin/dungeons/zones/renamed_zone')).statusCode).toBe(404);
  });

  it('refuses a stale revision with the current one, and writes nothing', async () => {
    const current = await getZone();
    const first = await call('PUT', `/admin/dungeons/zones/${ZONE}`, {
      zone: { ...current.zone, description: 'First admin.' },
      expectedRevision: current.revision,
    });
    expect(first.statusCode).toBe(200);

    const second = await call('PUT', `/admin/dungeons/zones/${ZONE}`, {
      zone: { ...current.zone, description: 'Second admin, working from the old copy.' },
      expectedRevision: current.revision,
    });
    expect(second.statusCode).toBe(409);
    expect(errorOf(second)).toMatchObject({
      code: 'DUNGEON_ZONE_STALE',
      details: { expectedRevision: current.revision, currentRevision: current.revision + 1 },
    });
    expect((await getZone()).zone.description).toBe('First admin.');
    expect((await getZone()).origin).toBe('edited');
  });

  it('disables and re-enables a zone, refusing a stale toggle', async () => {
    const current = await getZone();
    const off = await call('PUT', `/admin/dungeons/zones/${ZONE}/enabled`, {
      enabled: false,
      expectedRevision: current.revision,
    });
    expect(data<Detail>(off)).toMatchObject({ enabled: false, revision: current.revision + 1 });
    const list = data<{ zones: { key: string; enabled: boolean }[] }>(await call('GET', '/admin/dungeons/zones'));
    expect(list.zones.find((z) => z.key === ZONE)!.enabled).toBe(false);

    const stale = await call('PUT', `/admin/dungeons/zones/${ZONE}/enabled`, {
      enabled: true,
      expectedRevision: current.revision,
    });
    expect(stale.statusCode).toBe(409);
    const on = await call('PUT', `/admin/dungeons/zones/${ZONE}/enabled`, {
      enabled: true,
      expectedRevision: current.revision + 1,
    });
    expect(data<Detail>(on)).toMatchObject({ enabled: true, revision: current.revision + 2 });
    expect((await call('PUT', '/admin/dungeons/zones/nowhere/enabled', { enabled: false, expectedRevision: 1 })).statusCode).toBe(404);
  });

  it('has no delete route', async () => {
    expect((await call('DELETE', `/admin/dungeons/zones/${ZONE}`)).statusCode).toBe(404);
  });
});

describe('validation', () => {
  it('rejects minNodes above maxNodes', async () => {
    expect(await rejected('bad_nodes', (z) => (z.generation.minNodes = 12))).toContain('generation.minNodes');
  });

  it('rejects negative weights and all-zero weights', async () => {
    expect(await rejected('bad_weight', (z) => (z.generation.nodeWeights.combat = -1))).toContain(
      'generation.nodeWeights.combat',
    );
    expect(await rejected('bad_pool_weight', (z) => (z.pools.combat[0].weight = -1))).toContain('pools.combat[0].weight');
    expect(
      await rejected('zero_weights', (z) => {
        for (const type of Object.keys(z.generation.nodeWeights)) z.generation.nodeWeights[type] = 0;
      }),
    ).toContain('generation.nodeWeights');
  });

  it('rejects a required boss with no candidates', async () => {
    expect(await rejected('no_boss', (z) => (z.pools.boss = []))).toContain('pools.boss');
  });

  it('rejects impossible depth ranges', async () => {
    expect(await rejected('bad_entry_depth', (z) => Object.assign(z.pools.combat[0], { minDepth: 5, maxDepth: 2 }))).toContain(
      'pools.combat[0].maxDepth',
    );
    expect(await rejected('bad_type_depth', (z) => (z.generation.depthRanges.rest = { minDepth: 30, maxDepth: null }))).toContain(
      'generation.depthRanges.rest.minDepth',
    );
  });

  it('rejects a required node type with no eligible pool', async () => {
    expect(
      await rejected('no_miniboss', (z) => z.generation.required.push({ types: ['miniboss'], min: 1 })),
    ).toContain('generation.required[1]');
  });

  it('rejects an extraction depth outside the run', async () => {
    expect(await rejected('bad_extract', (z) => (z.generation.extraction.minDepth = 20))).toContain(
      'generation.extraction.minDepth',
    );
  });

  it('rejects impossible constraints, and accepts the same zone disabled with a warning', async () => {
    const jam = (z: Zone) => {
      z.generation.nodeWeights = { combat: 0, elite: 0, event: 0, reward: 0, rest: 10, miniboss: 0, exit: 0 };
      z.generation.required = [];
      z.generation.limits = [];
    };
    expect(await rejected('jammed', jam)).toEqual(['generation']);

    const disabled = await call('POST', '/admin/dungeons/zones', {
      zone: await draft('jammed_off', (z) => {
        jam(z);
        z.enabled = false;
      }),
    });
    expect(disabled.statusCode).toBe(200);
    expect(data<Detail>(disabled).issues).toMatchObject([{ path: 'generation', severity: 'warning' }]);
    // …and it cannot be switched on until it is fixed.
    const on = await call('PUT', '/admin/dungeons/zones/jammed_off/enabled', { enabled: true, expectedRevision: 1 });
    expect(on.statusCode).toBe(400);
    expect(errorPaths(on)).toEqual(['generation']);
  });

  it('rejects duplicate pool ids', async () => {
    expect(await rejected('dupe_pool', (z) => z.pools.combat.push({ ...z.pools.combat[0] }))).toContain('pools.combat[3].id');
  });

  it('rejects missing enemy, event, reward table and currency references', async () => {
    expect(await rejected('ghost_enemy', (z) => (z.pools.combat[0].enemyKey = 'ghost'))).toContain('pools.combat[0].enemyKey');
    expect(await rejected('ghost_event', (z) => (z.pools.event[0].eventKey = 'ghost'))).toContain('pools.event[0].eventKey');
    expect(await rejected('ghost_table', (z) => (z.rewards.bands[0].rewardTable = 'ghost'))).toContain(
      'rewards.bands[0].rewardTable',
    );
    expect(await rejected('ghost_currency', (z) => (z.rewards.currencyKey = 'doubloons'))).toContain('rewards.currencyKey');
  });

  it('rejects an unsafe artwork path on either field, and accepts one for a file that does not exist', async () => {
    expect(await rejected('bad_art', (z) => (z.artworkPath = '../../etc/passwd.png'))).toContain('artworkPath');
    expect(await rejected('bad_bg', (z) => (z.backgroundArtworkPath = 'https://evil.test/x.webp'))).toContain(
      'backgroundArtworkPath',
    );
    expect(await rejected('bad_ext', (z) => (z.artworkPath = 'dungeons/zones/x.svg'))).toContain('artworkPath');
    const ok = await call('POST', '/admin/dungeons/zones', {
      zone: await draft('art_later', (z) => (z.artworkPath = 'dungeons/zones/art_later.webp')),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('accepts a real reward table on a depth band and edits pool depth ranges', async () => {
    const tableId = app.content.expeditionRewards[0]!.id;
    const res = await call('POST', '/admin/dungeons/zones', {
      zone: await draft('banded', (z) => {
        z.rewards.bands[1].rewardTable = tableId;
        z.rewards.bands[1].equipmentRewardTable = tableId;
        z.pools.combat[0] = { ...z.pools.combat[0], minDepth: 1, maxDepth: 3, weight: 70, enabled: true };
        z.pools.elite.push({ id: 'bruiser_elite', enemyKey: 'alley_bruiser', weight: 5, minDepth: 5, maxDepth: 8, tags: ['organic'] });
      }),
    });
    expect(res.statusCode).toBe(200);
    const zone = data<Detail>(res).zone;
    expect(zone.rewards.bands[1]).toMatchObject({ rewardTable: tableId, equipmentRewardTable: tableId });
    expect(zone.pools.combat[0]).toMatchObject({ maxDepth: 3, weight: 70 });
    expect(zone.pools.elite[1]).toMatchObject({ id: 'bruiser_elite', enabled: true, minDepth: 5, maxDepth: 8 });
  });

  it('validates a draft without writing it', async () => {
    const zone = await draft('dry_run', (z) => (z.pools.boss = []));
    const res = data<{ issues: { path: string; severity: string }[] }>(await call('POST', '/admin/dungeons/validate', { zone }));
    expect(res.issues).toMatchObject([{ path: 'pools.boss', severity: 'error' }]);
    expect((await call('GET', '/admin/dungeons/zones/dry_run')).statusCode).toBe(404);
    const clean = data<{ issues: unknown[] }>(await call('POST', '/admin/dungeons/validate', { zone: await draft('dry_ok') }));
    expect(clean.issues).toEqual([]);
  });
});

describe('Delve settings', () => {
  interface Settings {
    dailyRunLimit: number;
    dailyRunLimitMin: number;
    dailyRunLimitMax: number;
    updatedAt: string | null;
    updatedBy: string | null;
  }
  const getSettings = async () => data<Settings>(await call('GET', '/admin/dungeons/settings'));

  it('reads the shared daily run limit with its bounds, and was not changed by a refused write', async () => {
    expect(await getSettings()).toMatchObject({ dailyRunLimit: 3, dailyRunLimitMin: 0, dailyRunLimitMax: 50, updatedBy: null });
  });

  it('saves a new limit, which the allowance then uses', async () => {
    const res = await call('PUT', '/admin/dungeons/settings', { dailyRunLimit: 5 });
    expect(res.statusCode).toBe(200);
    expect(data<Settings>(res)).toMatchObject({ dailyRunLimit: 5 });
    expect((await getSettings()).dailyRunLimit).toBe(5);
    const allowance = createDungeonAllowanceService({ db: t.db, timezone: 'UTC' });
    expect(await allowance.status(1)).toMatchObject({ limit: 5, used: 0, remaining: 5 });
    // 0 is accepted: it closes Delve to new runs.
    expect(data<Settings>(await call('PUT', '/admin/dungeons/settings', { dailyRunLimit: 0 }))).toMatchObject({ dailyRunLimit: 0 });
    expect(await allowance.status(1)).toMatchObject({ limit: 0, remaining: 0 });
    await call('PUT', '/admin/dungeons/settings', { dailyRunLimit: 3 });
  });

  it('refuses a fraction, a negative, a value past the cap, a string and an unknown field — and keeps the old value', async () => {
    for (const dailyRunLimit of [2.5, -1, 51]) {
      const res = await call('PUT', '/admin/dungeons/settings', { dailyRunLimit });
      expect(res.statusCode, String(dailyRunLimit)).toBe(400);
      expect(errorOf(res).code).toBe('DUNGEON_SETTINGS_INVALID');
    }
    expect((await call('PUT', '/admin/dungeons/settings', { dailyRunLimit: '4' })).statusCode).toBe(400);
    expect((await call('PUT', '/admin/dungeons/settings', { dailyRunLimit: 4, perZone: true })).statusCode).toBe(400);
    expect((await call('PUT', '/admin/dungeons/settings', {})).statusCode).toBe(400);
    expect((await getSettings()).dailyRunLimit).toBe(3);
  });
});

describe('progression currency', () => {
  interface Currency {
    key: string;
    singularName: string;
    pluralName: string;
    description: string;
    icon: string | null;
    enabled: boolean;
    revision: number;
  }
  const getCurrency = async () =>
    data<{ currencies: Currency[] }>(await call('GET', '/admin/dungeons/currencies')).currencies[0]!;

  it('edits the display metadata and keeps the key', async () => {
    const before = await getCurrency();
    expect(before.key).toBe(CURRENCY);
    const res = await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, {
      singularName: 'Star Shard',
      pluralName: 'Star Shards',
      description: 'Spent on Ascension.',
      icon: '✨',
      enabled: true,
      expectedRevision: before.revision,
    });
    expect(res.statusCode).toBe(200);
    expect(await getCurrency()).toMatchObject({
      key: CURRENCY,
      singularName: 'Star Shard',
      pluralName: 'Star Shards',
      description: 'Spent on Ascension.',
      icon: '✨',
      revision: before.revision + 1,
    });
    // Zones still reference the same key, and still validate.
    expect((await getZone()).zone.rewards.currencyKey).toBe(CURRENCY);
    expect((await getZone()).issues).toEqual([]);
  });

  it('refuses a key in the body, a stale revision, an empty name and an unknown currency', async () => {
    const current = await getCurrency();
    const body = { singularName: 'A', pluralName: 'As', enabled: true, expectedRevision: current.revision };
    expect((await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, { ...body, key: 'renamed' })).statusCode).toBe(400);
    const stale = await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, { ...body, expectedRevision: current.revision + 5 });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale)).toMatchObject({ code: 'PROGRESSION_CURRENCY_STALE', details: { currentRevision: current.revision } });
    const empty = await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, { ...body, pluralName: '   ' });
    expect(empty.statusCode).toBe(400);
    expect(errorOf(empty).code).toBe('PROGRESSION_CURRENCY_INVALID');
    expect((await call('PUT', '/admin/dungeons/currencies/doubloons', body)).statusCode).toBe(404);
    expect(await getCurrency()).toEqual(current);
  });

  it('warns on zones when the currency is disabled, without blocking them', async () => {
    const current = await getCurrency();
    const body = { singularName: current.singularName, pluralName: current.pluralName, expectedRevision: current.revision };
    await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, { ...body, enabled: false });
    expect((await getZone()).issues).toMatchObject([{ path: 'rewards.currencyKey', severity: 'warning' }]);
    await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, { ...body, enabled: true, expectedRevision: current.revision + 1 });
    expect((await getZone()).issues).toEqual([]);
  });
});

describe('regions', () => {
  it('offers the region catalogue as reference data: stable ids and display names', async () => {
    const ref = data<{ regions: { id: string; name: string; enabled: boolean }[] }>(await call('GET', '/admin/dungeons/reference'));
    expect(ref.regions.map((r) => r.id)).toEqual(expect.arrayContaining(['waifu-valley', 'flaccid-foothills', 'thirstlands']));
    expect(ref.regions.find((r) => r.id === 'flaccid-foothills')).toEqual({ id: 'flaccid-foothills', name: 'Flaccid Foothills', enabled: true });
  });

  it('ships Scrapheap in Flaccid Foothills, on the list and in the document', async () => {
    const zone = await getZone();
    expect(zone.zone.availableRegions).toEqual(['flaccid-foothills']);
    const list = data<{ zones: { key: string; availableRegions: string[] }[] }>(await call('GET', '/admin/dungeons/zones'));
    expect(list.zones.find((z) => z.key === ZONE)!.availableRegions).toEqual(['flaccid-foothills']);
  });

  it('saves several regions and returns them', async () => {
    const zone = await draft('multi_region', (z) => (z.availableRegions = ['waifu-valley', 'flaccid-foothills', 'thirstlands']));
    const created = await call('POST', '/admin/dungeons/zones', { zone });
    expect(created.statusCode).toBe(200);
    expect(data<Detail>(created).zone.availableRegions).toEqual(['waifu-valley', 'flaccid-foothills', 'thirstlands']);
  });

  it('refuses an unknown region, a duplicate and an enabled zone with none, by path', async () => {
    expect(await rejected('region_unknown', (z) => (z.availableRegions = ['flaccid-foothills', 'sunken-mall']))).toEqual(['availableRegions[1]']);
    expect(await rejected('region_duplicate', (z) => (z.availableRegions = ['thirstlands', 'thirstlands']))).toEqual(['availableRegions[1]']);
    expect(await rejected('region_none', (z) => (z.availableRegions = []))).toEqual(['availableRegions']);
    // A disabled draft with none saves, with a warning.
    const zone = await draft('region_none_draft', (z) => Object.assign(z, { availableRegions: [], enabled: false }));
    const res = await call('POST', '/admin/dungeons/zones', { zone });
    expect(res.statusCode).toBe(200);
    expect(data<Detail>(res).issues).toContainEqual(expect.objectContaining({ path: 'availableRegions', severity: 'warning' }));
  });
});

describe('rest rules', () => {
  it('ships Scrapheap with its rest rules, and saves an edit to them', async () => {
    const current = await getZone();
    expect(current.zone.generation.rest).toEqual({ minNodes: 1, maxNodes: 2, minDepth: 2, maxDepth: null, beforeBoss: true });
    const zone = await draft('rest_edit', (z) => (z.generation.rest = { minNodes: 1, maxNodes: 1, minDepth: 3, maxDepth: null, beforeBoss: true }));
    const res = await call('POST', '/admin/dungeons/zones', { zone });
    expect(res.statusCode).toBe(200);
    expect(data<Detail>(res).zone.generation.rest).toEqual({ minNodes: 1, maxNodes: 1, minDepth: 3, maxDepth: null, beforeBoss: true });
  });

  it('refuses impossible rest rules with a path the editor can show them at', async () => {
    expect(await rejected('rest_min_max', (z) => Object.assign(z.generation.rest, { minNodes: 3, maxNodes: 2 }))).toEqual(['generation.rest.minNodes']);
    expect(await rejected('rest_depths', (z) => Object.assign(z.generation.rest, { minDepth: 6, maxDepth: 3 }))).toContain('generation.rest.maxDepth');
    expect(await rejected('rest_no_boss', (z) => (z.generation.boss.required = false))).toContain('generation.rest.beforeBoss');
    expect(await rejected('rest_none_allowed', (z) => Object.assign(z.generation.rest, { minNodes: 0, maxNodes: 0 }))).toContain('generation.rest.maxNodes');
    // Runs end at depth 5–9, so the rest before the boss sits at 4–8: a latest depth of 6 excludes 7 and 8.
    const res = await call('POST', '/admin/dungeons/validate', { zone: await draft('rest_range', (z) => (z.generation.rest.maxDepth = 6)) });
    const issue = data<{ issues: { path: string; message: string; severity: string }[] }>(res).issues.find((i) => i.path === 'generation.rest.beforeBoss')!;
    expect(issue).toMatchObject({ severity: 'error' });
    expect(issue.message).toMatch(/sits at depth 4–8; the rest depth range excludes depth 7, 8/);
  });
});

describe('zone artwork', () => {
  it('refuses unsafe artwork paths on both fields, and a leading assets/', async () => {
    for (const bad of ['../secrets.webp', '/etc/passwd.webp', 'dungeons/zones/x.exe', 'https://example.com/x.webp', 'assets/dungeons/zones/x.webp']) {
      expect(await rejected('art_bad_main', (z) => (z.artworkPath = bad)), bad).toEqual(['artworkPath']);
      expect(await rejected('art_bad_bg', (z) => (z.backgroundArtworkPath = bad)), bad).toEqual(['backgroundArtworkPath']);
    }
  });

  it('saves the conventional paths whether or not the files exist yet', async () => {
    const zone = await draft('art_ok', (z) => {
      z.artworkPath = 'dungeons/zones/art_ok.webp';
      z.backgroundArtworkPath = 'dungeons/backgrounds/art_ok.webp';
    });
    const res = await call('POST', '/admin/dungeons/zones', { zone });
    expect(res.statusCode).toBe(200);
    expect(data<Detail>(res).zone).toMatchObject({ artworkPath: 'dungeons/zones/art_ok.webp', backgroundArtworkPath: 'dungeons/backgrounds/art_ok.webp' });
  });

  it('serves the bytes of a deployed file, 404s a missing one and 400s an unsafe path', async () => {
    const ok = await call('GET', '/admin/dungeons/artwork?path=dungeons/zones/deployed.webp');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/webp');
    expect(ok.body).toBe('webp-bytes');
    expect((await call('GET', '/admin/dungeons/artwork?path=dungeons/zones/not_there.webp')).statusCode).toBe(404);
    expect((await call('GET', `/admin/dungeons/artwork?path=${encodeURIComponent('../outside.webp')}`)).statusCode).toBe(400);
    expect((await call('GET', '/admin/dungeons/artwork?path=dungeons/zones/deployed.exe')).statusCode).toBe(400);
    expect((await call('GET', '/admin/dungeons/artwork')).statusCode).toBe(400);
  });

  it('browses and searches the dungeon folders only — never the rest of the assets tree', async () => {
    interface Listing { path: string; directories: { path: string }[]; files: { path: string }[] }
    const top = data<Listing>(await call('GET', '/admin/dungeons/artwork/browse'));
    expect(top.path).toBe('dungeons');
    expect(top.directories.map((d) => d.path).sort()).toEqual(['dungeons/backgrounds', 'dungeons/zones']);
    const zonesFolder = data<Listing>(await call('GET', '/admin/dungeons/artwork/browse?path=dungeons/zones'));
    expect(zonesFolder.files.map((f) => f.path)).toEqual(['dungeons/zones/deployed.webp']);
    // Another area's folder is not this picker's to list.
    expect((await call('GET', '/admin/dungeons/artwork/browse?path=results')).statusCode).toBe(400);
    expect((await call('GET', `/admin/dungeons/artwork/browse?path=${encodeURIComponent('dungeons/../results')}`)).statusCode).toBe(400);
    const found = data<{ results: { path: string }[] }>(await call('GET', '/admin/dungeons/artwork/search?q=deployed'));
    expect(found.results.map((r) => r.path)).toEqual(['dungeons/zones/deployed.webp']);
    expect(data<{ results: unknown[] }>(await call('GET', '/admin/dungeons/artwork/search?q=secret')).results).toEqual([]);
  });

  it('gates the artwork routes behind dungeons.read', async () => {
    const cookies = { wm_portal_session: NON_OWNER_TOKEN, wm_portal_csrf: 'csrf-token' };
    for (const url of ['/admin/dungeons/artwork?path=dungeons/zones/deployed.webp', '/admin/dungeons/artwork/browse', '/admin/dungeons/artwork/search?q=x']) {
      expect((await api.inject({ method: 'GET', url: `/api/v1${url}` })).statusCode, url).toBe(401);
      expect((await api.inject({ method: 'GET', url: `/api/v1${url}`, cookies })).statusCode, url).toBe(403);
    }
  });
});

describe('generation preview', () => {
  interface Preview {
    zoneKey: string;
    seed: number;
    graph: { nodes: { id: string; type: string; depth: number; boss: boolean; extraction: boolean; content: { key: string } | null }[]; edges: unknown[] };
    names: { enemies: Record<string, string>; events: Record<string, string> };
    structure: {
      availableRegions: { id: string; name: string | null }[];
      artworkPath: string | null;
      backgroundArtworkPath: string | null;
      restNodes: { id: string; depth: number; extraction: boolean }[];
      extractionNodes: { id: string; depth: number; type: string }[];
      bossNodeId: string | null;
      restBeforeBoss: { required: boolean; satisfied: boolean };
    };
  }

  it('reports what each generated run did with the structural rules — Rest → Boss holds on every seed', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const preview = data<Preview>(await call('POST', '/admin/dungeons/preview', { key: ZONE, seed }));
      const { nodes } = preview.graph;
      const boss = nodes.find((n) => n.boss)!;
      const { structure } = preview;
      expect(structure.availableRegions).toEqual([{ id: 'flaccid-foothills', name: 'Flaccid Foothills' }]);
      expect(structure.artworkPath).toBe('dungeons/zones/scrapheap_gauntlet.webp');
      expect(structure.bossNodeId).toBe(boss.id);
      expect(structure.restBeforeBoss, `seed ${seed}`).toEqual({ required: true, satisfied: true });
      // Read off the graph, not assumed: the lists match the nodes.
      expect(structure.restNodes.map((n) => n.id)).toEqual(nodes.filter((n) => n.type === 'rest').map((n) => n.id));
      expect(structure.extractionNodes.map((n) => n.id)).toEqual(nodes.filter((n) => n.extraction).map((n) => n.id));
      expect(nodes.filter((n) => n.depth === boss.depth - 1).map((n) => n.type)).toEqual(['rest']);
    }
  });

  it('previews a draft with the rule switched off as not required, and with regions it does not know as unnamed', async () => {
    const zone = await draft('preview_off', (z) => {
      z.generation.rest.beforeBoss = false;
      z.availableRegions = ['thirstlands'];
    });
    const preview = data<Preview>(await call('POST', '/admin/dungeons/preview', { zone, seed: 3 }));
    expect(preview.structure.restBeforeBoss.required).toBe(false);
    expect(preview.structure.availableRegions).toEqual([{ id: 'thirstlands', name: 'Thirstlands' }]);
  });

  it('simulates 1,000 runs and reports rest and extraction spread and the Rest → Boss rate', async () => {
    const report = data<{
      invalid: number;
      valid: number;
      restBeforeBossRate: number;
      restCountDistribution: Record<string, number>;
      extractionCountDistribution: Record<string, number>;
      branchRate: number;
    }>(await call('POST', '/admin/dungeons/simulate', { key: ZONE, runs: 1000, firstSeed: 1 }));
    expect(report).toMatchObject({ invalid: 0, valid: 1000, restBeforeBossRate: 1 });
    expect(Object.keys(report.restCountDistribution).sort()).toEqual(['1', '2']);
    expect(Object.values(report.restCountDistribution).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(Object.values(report.extractionCountDistribution).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(report.extractionCountDistribution['0']).toBeUndefined();
  });

  it('reproduces the same graph from an explicit seed', async () => {
    const a = data<Preview>(await call('POST', '/admin/dungeons/preview', { key: ZONE, seed: 2026 }));
    const b = data<Preview>(await call('POST', '/admin/dungeons/preview', { key: ZONE, seed: 2026 }));
    expect(a.seed).toBe(2026);
    expect(b).toEqual(a);
    const other = data<Preview>(await call('POST', '/admin/dungeons/preview', { key: ZONE, seed: 2027 }));
    expect(other.graph).not.toEqual(a.graph);
  });

  it('shows nodes, types, depth, branch structure, the boss, extraction points and content names', async () => {
    const preview = data<Preview>(await call('POST', '/admin/dungeons/preview', { key: ZONE, seed: 2026 }));
    const { nodes, edges } = preview.graph;
    expect(nodes.length).toBeGreaterThanOrEqual(6);
    expect(edges.length).toBeGreaterThanOrEqual(nodes.length - 1);
    const boss = nodes.filter((n) => n.boss);
    expect(boss).toHaveLength(1);
    expect(preview.names.enemies[boss[0]!.content!.key]).toBe('Scrapheap Colossus');
    expect(nodes.some((n) => n.extraction)).toBe(true);
    expect(nodes.map((n) => n.depth)).toEqual([...nodes.map((n) => n.depth)].sort((x, y) => x - y));
  });

  it('draws a seed when none is given and returns it, so the preview can be repeated', async () => {
    const first = data<Preview>(await call('POST', '/admin/dungeons/preview', { key: ZONE }));
    expect(Number.isInteger(first.seed)).toBe(true);
    const again = data<Preview>(await call('POST', '/admin/dungeons/preview', { key: ZONE, seed: first.seed }));
    expect(again.graph).toEqual(first.graph);
  });

  it('previews an unsaved draft, and persists neither the draft nor a run', async () => {
    const zone = await draft('unsaved_draft', (z) => Object.assign(z.generation, { minNodes: 9, maxNodes: 9 }));
    const preview = data<Preview>(await call('POST', '/admin/dungeons/preview', { zone, seed: 3 }));
    expect(preview.zoneKey).toBe('unsaved_draft');
    expect(preview.graph.nodes).toHaveLength(9);
    expect((await call('GET', '/admin/dungeons/zones/unsaved_draft')).statusCode).toBe(404);
    expect(await t.db.select().from(dungeonRuns)).toEqual([]);
  });

  it('shows the problem when the rules cannot produce a run', async () => {
    const zone = await draft('broken_draft', (z) => (z.pools.boss = []));
    const res = await call('POST', '/admin/dungeons/preview', { zone, seed: 3 });
    expect(res.statusCode).toBe(422);
    expect(errorOf(res)).toMatchObject({ code: 'DUNGEON_GENERATION_FAILED', details: { seed: 3, zoneKey: 'broken_draft' } });
    expect(String(errorOf(res).details!.lastFailure)).toMatch(/no eligible boss/);
  });

  it('refuses a malformed request', async () => {
    expect((await call('POST', '/admin/dungeons/preview', {})).statusCode).toBe(400);
    expect((await call('POST', '/admin/dungeons/preview', { key: ZONE, zone: {} })).statusCode).toBe(400);
    expect((await call('POST', '/admin/dungeons/preview', { key: ZONE, seed: -1 })).statusCode).toBe(400);
    expect((await call('POST', '/admin/dungeons/preview', { key: 'nowhere' })).statusCode).toBe(404);
    const shapeless = await call('POST', '/admin/dungeons/preview', { zone: { key: 'x' } });
    expect(shapeless.statusCode).toBe(400);
    expect(errorOf(shapeless).code).toBe('DUNGEON_ZONE_INVALID');
  });

  it('simulates many runs and summarises them', async () => {
    const report = data<Record<string, any>>(await call('POST', '/admin/dungeons/simulate', { key: ZONE, runs: 300 }));
    expect(report).toMatchObject({ runs: 300, valid: 300, invalid: 0, invalidRate: 0, bossRate: 1, restRate: 1 });
    expect(report.averageNodeCount).toBeGreaterThanOrEqual(6);
    expect(report.nodeTypeShare.combat).toBeGreaterThan(0.3);
    expect(report.enemies.length).toBeGreaterThan(0);
    expect((await call('POST', '/admin/dungeons/simulate', { key: ZONE, runs: 1_000_000 })).statusCode).toBe(400);
    expect(await t.db.select().from(dungeonRuns)).toEqual([]);
  });
});
