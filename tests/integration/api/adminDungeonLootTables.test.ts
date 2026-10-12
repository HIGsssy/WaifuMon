/** T4 HTTP contracts and permissions over real, disposable catalogue storage. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import type {
  PortalAuthorizationService,
  PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import {
  createDungeonLootTableService,
  type DungeonLootTableService,
} from '../../../src/modules/dungeons/dungeonLootTableService';
import type { DungeonLootTable } from '../../../src/api/schemas/dungeonLootTables';
import { createDungeonWorld, type DungeonWorld } from '../../helpers/dungeonWorld';
import { testDungeonInput } from '../../helpers/dungeonFixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';

let w: DungeonWorld;
let api: ZodFastify;
let tables: DungeonLootTableService;
const CSRF = 'loot-csrf';
const grants: Record<string, PortalPermission[]> = {
  reader: ['dungeons.read'],
  writer: ['dungeons.write'],
  author: ['dungeons.read', 'dungeons.write'],
  rewards: ['rewards.write'],
};
const session = (role: string): PortalSession => ({
  sessionDigest: role,
  discordUserId: role,
  discordUsername: null,
  discordAvatarUrl: null,
  selectedDiscordGuildId: null,
  selectedGuildDbId: null,
  playerId: null,
  eligibleGuilds: [],
  csrfToken: CSRF,
  expiresAt: new Date(Date.now() + 3600000),
});
beforeAll(async () => {
  w = await createDungeonWorld();
  tables = createDungeonLootTableService({ db: w.t.db });
  const authorization = {
    has: async (s: PortalSession | null, p: PortalPermission) =>
      !!s && !!grants[s.discordUserId]?.includes(p),
  } as PortalAuthorizationService;
  const sessions = {
    getSession: async (token?: string) => (token && grants[token] ? session(token) : null),
    safeEquals: (a: string, b: string) => a === b,
  } as unknown as PortalSessionService;
  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3135, token: TEST_TOKEN },
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
      sessions,
      authorization,
    },
    ctx: {
      services: {
        ...w.app,
        dungeonContent: w.content,
        dungeonLootTables: tables,
        progressionCurrency: w.currencies,
        dungeonAllowance: w.allowance,
      },
      getContent: () => w.app.content,
      portalAuthorization: authorization,
    },
  });
});
afterAll(async () => {
  await api?.close();
  await w?.cleanup();
});
const base = '/api/v1/admin/dungeons/loot-tables';
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const call = (method: Method, path = '', payload?: unknown, role = 'author') =>
  api.inject({
    method,
    url: base + path,
    cookies: { wm_portal_session: role, wm_portal_csrf: CSRF },
    headers: { 'x-portal-csrf': CSRF },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const body = {
  guaranteed: [
    { id: 'shards', grant: { type: 'currency', currency: 'shards', amount: { min: 2, max: 4 } } },
  ],
  chances: [],
  pools: [],
};
let sequence = 0;
async function create(tier: 'rare' | null = 'rare') {
  const key = `api_hoard_${++sequence}`;
  const response = await call('POST', '', {
    key,
    name: `Hoard ${sequence}`,
    description: 'Readable dungeon loot',
    tier,
    body,
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as DungeonLootTable;
}
const reads: [Method, string, unknown?][] = [
  ['GET', ''],
  ['GET', '/missing'],
  ['GET', '/missing/where-used'],
  ['GET', '/missing/history'],
  ['POST', '/validate', { body }],
];
const writes: [Method, string, unknown?][] = [
  ['POST', '', { key: 'permitted_create', name: 'Permitted', body }],
  ['PUT', '/missing', { expectedRevision: 1, name: 'Updated' }],
  ['POST', '/missing/archive', { expectedRevision: 1 }],
  ['POST', '/missing/restore', { expectedRevision: 1 }],
  ['DELETE', '/missing', { expectedRevision: 1 }],
  ['POST', '/missing/duplicate', { key: 'permitted_copy' }],
];

describe('dungeon loot-table admin API', () => {
  it.each([...reads, ...writes])(
    'requires authentication for %s %s',
    async (method, path, payload) => {
      const res = await api.inject({
        method,
        url: base + path,
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
      expect(res.statusCode).toBe(401);
    },
  );
  it.each(reads)('uses dungeons.read for %s %s', async (method, path, payload) => {
    expect((await call(method, path, payload, 'reader')).statusCode).toBe(
      path === '/missing' || path === '/missing/where-used' ? 404 : 200,
    );
    for (const role of ['writer', 'rewards'])
      expect((await call(method, path, payload, role)).statusCode).toBe(403);
  });
  it.each(writes)('uses dungeons.write for %s %s', async (method, path, payload) => {
    expect((await call(method, path, payload, 'writer')).statusCode).toBe(path === '' ? 201 : 404);
    for (const role of ['reader', 'rewards'])
      expect((await call(method, path, payload, role)).statusCode).toBe(403);
  });
  it('keeps the shared bearer credential non-administrative by default', async () => {
    expect(
      (
        await api.inject({
          method: 'GET',
          url: base,
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('creates, gets and filters by tier, literal search and archived status', async () => {
    const row = await create();
    expect(row).toMatchObject({
      name: `Hoard ${sequence}`,
      description: 'Readable dungeon loot',
      revision: 1,
      createdBy: 'author',
      updatedBy: 'author',
      archivedAt: null,
      origin: 'portal',
      body,
    });
    expect(row.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.createdAt).toMatch(/Z$/);
    expect((await call('GET', `/${row.key}`)).json().data).toEqual(row);
    expect((await call('GET', `?tier=rare&search=${row.key}`)).json().data.tables).toEqual([row]);
    expect((await call('GET', `?tier=boss&search=${row.key}`)).json().data.tables).toEqual([]);
    const untiered = await create(null);
    expect((await call('GET', `?tier=null&search=${untiered.key}`)).json().data.tables).toEqual([
      untiered,
    ]);
    await call('POST', `/${row.key}/archive`, { expectedRevision: 1 });
    expect(
      (await call('GET', `?search=${row.key}&includeArchived=false`)).json().data.tables,
    ).toEqual([]);
    expect(
      (await call('GET', `?search=${row.key}&includeArchived=true`)).json().data.tables[0]
        .archivedAt,
    ).toBeTruthy();
  });
  it('round-trips a schema-valid selector body larger than the default API ceiling', async () => {
    const largeBody = {
      guaranteed: [],
      chances: [],
      pools: Array.from({ length: 6 }, (_, pool) => ({
        id: `pool_${pool}`,
        name: `Pool ${pool}`,
        draws: 1,
        entries: Array.from({ length: 40 }, (_, entry) => ({
          id: `entry_${entry}`,
          weight: 1,
          grant: {
            type: 'equipment',
            selector: {
              definitionKeys: Array.from(
                { length: 50 },
                (_, key) => `definition_${'x'.repeat(40)}_${key}`,
              ),
            },
          },
        })),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(largeBody))).toBeGreaterThan(65536);
    const validation = await call('POST', '/validate', { body: largeBody });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().data.valid).toBe(false);
    expect(validation.json().data.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'reward_equipment_empty', severity: 'error' }),
      ]),
    );
    const created = await call('POST', '', {
      key: 'large_selector_body',
      name: 'Large selectors',
      body: largeBody,
    });
    expect(created.statusCode).toBe(201);
    const update = await call('PUT', '/large_selector_body', {
      expectedRevision: 1,
      body: created.json().data.body,
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.body).toEqual(largeBody);
    const tooLarge = await call('POST', '/validate', { body: 'x'.repeat(2 * 1024 * 1024) });
    expect(tooLarge.statusCode).toBe(413);
  });
  it('returns typed taken-key and missing-table errors', async () => {
    const row = await create();
    const duplicate = await call('POST', '', { key: row.key, name: 'Different', body });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('DUNGEON_LOOT_TABLE_KEY_TAKEN');
    for (const [method, path, payload] of [...reads, ...writes].filter(
      ([, p]) => p.startsWith('/missing') && !p.endsWith('/history'),
    )) {
      const res = await call(method, path, payload);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('DUNGEON_LOOT_TABLE_NOT_FOUND');
    }
    expect((await call('GET', '/missing/history')).json().data).toEqual({ events: [] });
  });
  it('rejects invalid payloads and filters without mutating a record or audit history', async () => {
    const row = await create();
    const originalEvents = await tables.history(row.key);
    const invalid: [Method, string, unknown?][] = [
      ['POST', '', { key: 'Bad Key', name: 'Bad', body }],
      ['POST', '', { key: 'invalid_body', name: 'Bad', body: {} }],
      ['PUT', `/${row.key}`, { expectedRevision: 1 }],
      ['PUT', `/${row.key}`, { expectedRevision: 1, key: 'new_key', name: 'Bad' }],
      [
        'PUT',
        `/${row.key}`,
        {
          expectedRevision: 1,
          body: { ...body, guaranteed: [...body.guaranteed, ...body.guaranteed] },
        },
      ],
      ['POST', `/${row.key}/archive`, {}],
      ['POST', `/${row.key}/restore`, { expectedRevision: 0 }],
      ['DELETE', `/${row.key}`, {}],
      ['POST', `/${row.key}/duplicate`, { key: 'invalid-copy' }],
      ['GET', '?includeArchived=banana'],
      ['GET', '?tier=unusual'],
      ['GET', `/${row.key}/history?limit=0`],
    ];
    for (const [method, path, payload] of invalid) {
      const res = await call(method, path, payload);
      expect(res.statusCode, `${method} ${path}`).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(res.json().error.details.issues.length).toBeGreaterThan(0);
    }
    expect((await call('GET', `/${row.key}`)).json().data).toEqual(row);
    expect(await tables.history(row.key)).toEqual(originalEvents);
  });
  it('updates metadata and reports stale editor details on every revision-guarded operation', async () => {
    const row = await create();
    const updated = await call('PUT', `/${row.key}`, { expectedRevision: 1, name: 'Latest name' });
    expect(updated.statusCode).toBe(200);
    const latest = updated.json().data;
    expect(latest).toMatchObject({
      revision: 2,
      name: 'Latest name',
      contentHash: row.contentHash,
    });
    const before = await tables.history(row.key);
    for (const [method, path, payload] of [
      ['PUT', `/${row.key}`, { expectedRevision: 1, name: 'Unsaved edit' }],
      ['POST', `/${row.key}/archive`, { expectedRevision: 1 }],
      ['POST', `/${row.key}/restore`, { expectedRevision: 1 }],
      ['DELETE', `/${row.key}`, { expectedRevision: 1 }],
    ] as [Method, string, unknown][]) {
      const res = await call(method, path, payload);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'DUNGEON_LOOT_TABLE_STALE',
        details: {
          key: row.key,
          expectedRevision: 1,
          currentRevision: 2,
          updatedBy: 'author',
          updatedAt: latest.updatedAt,
        },
      });
    }
    expect((await call('GET', `/${row.key}`)).json().data).toEqual(latest);
    expect(await tables.history(row.key)).toEqual(before);
  });
  it('archives, restores, duplicates and deletes while retaining readable history', async () => {
    const row = await create();
    const refusal = await call('DELETE', `/${row.key}`, { expectedRevision: 1 });
    expect(refusal.statusCode).toBe(409);
    expect(refusal.json().error.details.reason).toBe('not_archived');
    const archived = (await call('POST', `/${row.key}/archive`, { expectedRevision: 1 })).json()
      .data;
    expect(archived).toMatchObject({ revision: 2, contentHash: row.contentHash });
    const restored = (await call('POST', `/${row.key}/restore`, { expectedRevision: 2 })).json()
      .data;
    expect(restored).toMatchObject({ revision: 3, archivedAt: null });
    const copyRes = await call('POST', `/${row.key}/duplicate`, {
      key: `${row.key}_copy`,
      name: 'Copy hoard',
    });
    expect(copyRes.statusCode).toBe(201);
    const copy = copyRes.json().data;
    expect(copy).toMatchObject({
      revision: 1,
      name: 'Copy hoard',
      body,
      description: row.description,
      archivedAt: null,
      contentHash: row.contentHash,
    });
    expect((await call('GET', `/${copy.key}/history`)).json().data.events[0]).toMatchObject({
      action: 'duplicated',
      details: { sourceKey: row.key, sourceRevision: 3 },
    });
    await call('POST', `/${row.key}/archive`, { expectedRevision: 3 });
    expect((await call('DELETE', `/${row.key}`, { expectedRevision: 4 })).json().data).toEqual({
      deleted: true,
    });
    expect((await call('GET', `/${row.key}`)).statusCode).toBe(404);
    const history = (await call('GET', `/${row.key}/history`)).json().data.events;
    expect(history.map((e: { action: string }) => e.action)).toEqual([
      'deleted',
      'archived',
      'restored',
      'archived',
      'created',
    ]);
    expect(history[0]).toMatchObject({ tableKey: row.key, actor: 'author', newContentHash: null });
    expect((await call('GET', `/${row.key}/history?limit=1`)).json().data.events).toHaveLength(1);
  });
  it('reports draft and immutable revision usage and refuses referenced deletion', async () => {
    const row = await create();
    const dungeon = testDungeonInput('loot_api_usage');
    dungeon.rooms[0]!.actions!.push({
      id: 'table_cache',
      type: 'reward',
      rewards: { guaranteed: [], chances: [], tables: [{ id: 'hoard', table: row.key, draws: 1 }] },
    });
    await w.content.create({ definition: dungeon }, 'author');
    const published = await w.content.publish(dungeon.key, { expectedRevision: 1 }, 'author');
    expect((await call('GET', `/${row.key}/where-used`)).json().data).toMatchObject({
      drafts: [{ dungeonKey: dungeon.key, name: dungeon.name }],
      published: [
        {
          dungeonKey: dungeon.key,
          revisionId: published.revision.revisionId,
          current: true,
          // T6: publication embeds the table, so the revision no longer needs the catalogue row.
          snapshotStatus: 'embedded',
        },
      ],
    });
    await call('POST', `/${row.key}/archive`, { expectedRevision: 1 });
    const refusal = await call('DELETE', `/${row.key}`, { expectedRevision: 2 });
    expect(refusal.statusCode).toBe(409);
    expect(refusal.json().error).toMatchObject({
      code: 'DUNGEON_LOOT_TABLE_DELETE_REFUSED',
      details: {
        reason: 'in_use',
        usage: { drafts: [{ dungeonKey: dungeon.key }], published: [{ dungeonKey: dungeon.key }] },
      },
    });
    expect(refusal.json().error.message).toContain(dungeon.name);
    expect((await tables.get(row.key))?.revision).toBe(2);
  });
  it('validates shape at the static route without catalogue or audit writes', async () => {
    const before = await tables.list({ includeArchived: true });
    const histories = await Promise.all(before.map((t) => tables.history(t.key)));
    const valid = await call('POST', '/validate', { body });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().data).toMatchObject({ valid: true, body, issues: [] });
    const invalid = await call('POST', '/validate', {
      body: { ...body, pools: [{ id: 'bad', name: 'Bad', draws: 0, entries: [] }] },
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().data).toMatchObject({ valid: false, body: null, contentHash: null });
    expect(invalid.json().data.issues.length).toBeGreaterThan(0);
    expect((await call('POST', '/validate', {})).statusCode).toBe(400);
    expect(await tables.list({ includeArchived: true })).toEqual(before);
    expect(await Promise.all(before.map((t) => tables.history(t.key)))).toEqual(histories);
  });
  it('extends reference metadata additively without writes, preserving existing authoring endpoints', async () => {
    const row = await create();
    await tables.archive(row.key, { expectedRevision: 1 }, 'author');
    const before = await tables.list({ includeArchived: true });
    const oldReference = await w.content.reference();
    const ref = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/dungeons/reference',
      cookies: { wm_portal_session: 'reader' },
    });
    expect(ref.statusCode).toBe(200);
    expect(ref.json().data).toMatchObject(oldReference);
    expect(ref.json().data.lootTables).toContainEqual({
      key: row.key,
      name: row.name,
      tier: row.tier,
      archived: true,
      contentHash: row.contentHash,
    });
    const item = w.app.content.items[0]!;
    expect(ref.json().data.items).toContainEqual({
      slug: item.slug,
      name: item.name,
      category: item.category,
      enabled: item.enabled,
      maxOwned: item.maxOwned ?? null,
    });
    expect(await tables.list({ includeArchived: true })).toEqual(before);
    const oldList = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/dungeons/definitions',
      cookies: { wm_portal_session: 'reader' },
    });
    expect(oldList.statusCode).toBe(200);
    expect(oldList.json().data.dungeons.length).toBeGreaterThan(0);
  });
  it('returns dependency errors on save and validate, then accepts an authorized repair without validation writes', async () => {
    const invalidBody = {
      guaranteed: [
        {
          id: 'charm',
          grant: { type: 'item', item: 'missing_catalogue_charm', quantity: { min: 1, max: 1 } },
        },
      ],
      chances: [],
      pools: [],
    };
    const created = await call('POST', '', {
      key: 'repair_api',
      name: 'Repair API Hoard',
      body: invalidBody,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.issues).toContainEqual(
      expect.objectContaining({ code: 'reward_item_missing', severity: 'error' }),
    );
    const before = await tables.get('repair_api');
    const events = await tables.history('repair_api');
    const validation = await call('POST', '/validate', { body: invalidBody }, 'reader');
    expect(validation.statusCode).toBe(200);
    expect(validation.json().data).toMatchObject({
      valid: false,
      body: invalidBody,
      contentHash: before!.contentHash,
    });
    expect(validation.json().data.issues).toContainEqual(
      expect.objectContaining({ code: 'reward_item_missing', severity: 'error' }),
    );
    expect(await tables.get('repair_api')).toEqual(before);
    expect(await tables.history('repair_api')).toEqual(events);
    expect(
      (await call('PUT', '/repair_api', { expectedRevision: 1, body }, 'reader')).statusCode,
    ).toBe(403);
    const repaired = await call('PUT', '/repair_api', { expectedRevision: 1, body }, 'writer');
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().data).toMatchObject({
      revision: 2,
      body,
      issues: [],
      equipmentPools: {},
    });
    const warning = await call('POST', '/validate', {
      body: { guaranteed: [], chances: [], pools: [] },
    });
    expect(warning.json().data).toMatchObject({
      valid: true,
      issues: [{ code: 'reward_empty', severity: 'warning' }],
    });
  });
  it('documents catalogue operations and read-only test-roll with request and response schemas', async () => {
    const spec = (await api.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    for (const [path, method] of [
      ['', 'get'],
      ['', 'post'],
      ['/{key}', 'get'],
      ['/{key}', 'put'],
      ['/{key}', 'delete'],
      ['/{key}/archive', 'post'],
      ['/{key}/restore', 'post'],
      ['/{key}/duplicate', 'post'],
      ['/{key}/where-used', 'get'],
      ['/{key}/history', 'get'],
      ['/validate', 'post'],
    ]) {
      const op = spec.paths[base + path][method!];
      expect(
        op.responses[
          method === 'post' && (path === '' || path === '/{key}/duplicate') ? '201' : '200'
        ].content['application/json'].schema,
      ).toBeTruthy();
      if (method !== 'get') expect(op.requestBody.content['application/json'].schema).toBeTruthy();
    }
    const preview = spec.paths[`${base}/test-roll`].post;
    expect(preview.requestBody.content['application/json'].schema).toBeTruthy();
    expect(preview.responses['200'].content['application/json'].schema).toBeTruthy();
  });
});
