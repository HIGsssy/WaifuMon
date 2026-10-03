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
      services: { ...app, dungeonZones, progressionCurrency, dungeonAllowance },
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
  const rejected = async (key: string, mutate: (zone: Zone) => void) => {
    const res = await call('POST', '/admin/dungeons/zones', { zone: await draft(key, mutate) });
    expect(res.statusCode, key).toBe(400);
    expect(errorOf(res).code).toBe('DUNGEON_ZONE_INVALID');
    expect((await call('GET', `/admin/dungeons/zones/${key}`)).statusCode).toBe(404);
    return errorPaths(res);
  };

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
    ).toContain('generation.required[2]');
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

describe('generation preview', () => {
  interface Preview {
    zoneKey: string;
    seed: number;
    graph: { nodes: { id: string; type: string; depth: number; boss: boolean; extraction: boolean; content: { key: string } | null }[]; edges: unknown[] };
    names: { enemies: Record<string, string>; events: Record<string, string> };
  }

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
