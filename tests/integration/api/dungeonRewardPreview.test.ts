/** T12 real API + PostgreSQL: exact previews, isolated sandbox, and absence of writes. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
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

import { createDungeonWorld, type DungeonWorld } from '../../helpers/dungeonWorld';
import { singleRoomDungeon, CURRENCY } from '../../helpers/dungeonFixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { items, equipmentDefinitions } from '../../../src/db/schema';
import { DungeonLootTableBodySchema, DungeonRewardBundleSchema, type DungeonRewardBundle, type DungeonRewardGrant } from '../../../src/modules/dungeons/content/dungeonRewards';
import { TEST_ROLL_ACTIVITY, type DungeonTestRollResult } from '../../../src/modules/dungeons/dungeonRewardPreview';
import { loadDungeonRewardContext } from '../../../src/modules/dungeons/dungeonRewardContext';
import { resolveDungeonRewardDependencies } from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { analyseRewardBundle, resolveRewardBundle } from '../../../src/modules/dungeons/engine/lootResolver';
import { rewardResolverSnapshot } from '../../../src/modules/dungeons/engine/rewards';
import { deriveDungeonSeed } from '../../../src/modules/dungeons/engine/seeds';
import { autoPlayDungeonSandbox, createDungeonSandbox } from '../../../src/modules/dungeons/engine/sandbox';

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
        dungeonRuns: w.runs,
        enemies: w.enemies,
        equipment: w.svc.equipment,
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
afterEach(() => vi.restoreAllMocks());
const base = '/api/v1/admin/dungeons/loot-tables/test-roll';
const call = (payload: unknown, role = 'reader', url = base) => api.inject({
  method: 'POST', url, payload: payload as Record<string, unknown>,
  cookies: { wm_portal_session: role, wm_portal_csrf: CSRF }, headers: { 'x-portal-csrf': CSRF },
});
const currency = (currency: 'shards' | 'waifubux' | 'essence', min = 1, max = min): DungeonRewardGrant => ({
  type: 'currency', currency, amount: { min, max },
});
const bundle = (over: Partial<DungeonRewardBundle> = {}) => DungeonRewardBundleSchema.parse({ guaranteed: [], chances: [], tables: [], ...over });
const table = DungeonLootTableBodySchema.parse({
  guaranteed: [{ id: 'cash', grant: currency('waifubux', 2, 10) }],
  chances: [{ id: 'essence', chanceBasisPoints: 5000, grant: currency('essence', 3, 9) }],
  pools: [{ id: 'pick', name: 'Charm or Nothing', draws: 2, entries: [
    { id: 'charm', weight: 1, grant: { type: 'item', item: 'sticky_joystick', quantity: { min: 1, max: 3 } } },
    { id: 'nothing', weight: 3, nothing: true },
  ] }],
});
const money = bundle({ guaranteed: [{ id: 'cash', grant: currency('waifubux', 500) }, { id: 'shards', grant: currency('shards', 40) }] });
const targetTable = { target: { tableBody: table, draws: 2 }, seed: 123 };
const preview = async (payload: unknown): Promise<DungeonTestRollResult> => {
  const response = await call(payload);
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data;
};
const play = async (payload: unknown) => {
  const response = await call(payload, 'reader', '/api/v1/admin/dungeons/sandbox');
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data;
};
let sequence = 0;
async function saved(body = table) {
  return tables.create({ key: `preview_table_${++sequence}`, name: 'Preview table', body }, 'test');
}
async function dbImage() {
  const names = await w.t.pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' order by tablename");
  const result: Record<string, unknown> = {};
  for (const { tablename } of names.rows) {
    const name = tablename.replaceAll('"', '""');
    result[tablename] = (await w.t.pool.query(`select coalesce(jsonb_agg(row_data order by row_data::text), '[]'::jsonb) as rows from (select to_jsonb(t) as row_data from "${name}" t) s`)).rows[0].rows;
  }
  return result;
}

describe('Test Roll read-only API', () => {
  it('accepts an unsaved standalone table and reports guaranteed, chance, pool and Nothing lines', async () => {
    const result = await preview(targetTable);
    expect(result.issues).toEqual([]);
    expect(result.roll!.lines.filter((l) => l.mode === 'guaranteed')).toHaveLength(2);
    expect(result.roll!.lines.filter((l) => l.mode === 'guaranteed').every((l) => l.hit)).toBe(true);
    expect(result.roll!.lines.filter((l) => l.mode === 'chance')).toHaveLength(2);
    expect(result.roll!.lines.filter((l) => l.mode === 'pool')).toHaveLength(4);
    expect(result.analysis!.noRewardChance).toBe(0);
    expect(result.items.sticky_joystick?.name).toBeTruthy();
  });
  it('accepts inline bundle grants of every type and selects equipment without generating stats', async () => {
    const rewards = bundle({ guaranteed: [
      ...money.guaranteed,
      { id: 'essence', grant: currency('essence', 7) },
      { id: 'love', grant: { type: 'affection', amount: { min: 3, max: 3 } } },
      { id: 'charm', grant: { type: 'item', item: 'sticky_joystick', quantity: { min: 2, max: 2 } } },
      { id: 'gear', grant: { type: 'equipment', selector: { definitionKeys: ['rusty_pipe'] } } },
    ] });
    const result = await preview({ target: { bundle: rewards }, seed: 99, simulate: 5 });
    expect(result.roll).toMatchObject({ atRisk: { shards: 40, waifubux: 500 }, secured: { essence: 7, affection: 3, items: [{ item: 'sticky_joystick', quantity: 2 }] } });
    expect(result.roll!.secured.equipment[0]).toEqual({ definitionKey: 'rusty_pipe', dropId: expect.any(String), rollSeed: expect.any(Number) });
    expect(Object.values(result.equipmentPools)[0]?.[0]).toMatchObject({ key: 'rusty_pipe', name: expect.any(String) });
    expect(result.simulation!.averages).toEqual(result.analysis!.rewards.map((entry) => ({
      reward: entry.reward, riskClass: entry.riskClass, averageQuantity: entry.expectedQuantity,
    })));
  });
  it('matches T2 resolution and exact analysis byte-for-byte', async () => {
    const row = await saved();
    const rewards = bundle({ tables: [{ id: 'loot', table: row.key, draws: 3 }] });
    const snapshot = resolveDungeonRewardDependencies(singleRoomDungeon([{ id: 'reward', type: 'reward', rewards }]), await loadDungeonRewardContext(w.t.db)).snapshot!;
    const result = await preview({ target: { bundle: rewards }, seed: 4 });
    expect(result.roll).toEqual(resolveRewardBundle(rewards, rewardResolverSnapshot(snapshot), 4, TEST_ROLL_ACTIVITY));
    expect(result.analysis).toEqual(JSON.parse(JSON.stringify(analyseRewardBundle(rewards, rewardResolverSnapshot(snapshot)))));
  });
  it('repeats the same seed and can reproduce a generated seed', async () => {
    const first = await preview(targetTable);
    expect(await preview(targetTable)).toEqual(first);
    const generated = await preview({ target: targetTable.target });
    expect(generated.seed).toBeGreaterThanOrEqual(0);
    expect(await preview({ target: targetTable.target, seed: generated.seed })).toEqual(generated);
  });
  it('distinct seeds produce distinct rolls', async () => {
    const rolls = await Promise.all([1, 2, 3, 4].map(async (seed) => (await preview({ ...targetTable, seed })).roll));
    expect(new Set(rolls.map((r) => JSON.stringify(r))).size).toBeGreaterThan(1);
  });
  it('represents all-Nothing outcomes and empty rewards without pretending they are errors', async () => {
    const nothing = DungeonLootTableBodySchema.parse({ guaranteed: [], chances: [], pools: [{ id: 'empty', name: 'Nothing', draws: 1, entries: [{ id: 'nothing', weight: 1, nothing: true }] }] });
    const result = await preview({ target: { tableBody: nothing }, simulate: 10, seed: 1 });
    expect(result.roll!.lines[0]).toMatchObject({ hit: false, missReason: 'nothing' });
    expect(result.analysis!.noRewardChance).toBe(1);
    expect(result.simulation).toMatchObject({ kind: 'observed', nothingRate: 1, nothingResults: 10 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'reward_pool_all_nothing', severity: 'warning' }));
    const empty = await preview({ target: { bundle: bundle() }, seed: 2 });
    expect(empty.roll!.lines).toEqual([]);
    expect(empty.issues.some((i) => i.severity === 'error')).toBe(false);
  });
  it('honours unsaved overrides, including archived rows, without modifying any catalogue row', async () => {
    const row = await saved();
    await tables.archive(row.key, { expectedRevision: 1 }, 'test');
    const before = await tables.get(row.key);
    const rewards = bundle({ tables: [{ id: 'loot', table: row.key, draws: 1 }] });
    const override = { guaranteed: [{ id: 'replacement', grant: currency('waifubux', 999) }], chances: [], pools: [] };
    const result = await preview({ target: { bundle: rewards }, tables: { [row.key]: override }, seed: 42 });
    expect(result.roll!.atRisk.waifubux).toBe(999);
    expect(result.analysis!.rewards[0]!.expectedQuantity).toBe(999);
    expect(await tables.get(row.key)).toEqual(before);
  });
  it('uses unsaved tables that do not exist in the catalogue', async () => {
    const result = await preview({ target: { bundle: bundle({ tables: [{ id: 'new', table: 'unsaved_only', draws: 1 }] }) }, tables: { unsaved_only: table }, seed: 1 });
    expect(result.roll).not.toBeNull();
    expect(await tables.get('unsaved_only')).toBeNull();
  });
  it('observed simulation exactly agrees with repeatedly calling the actual resolver', async () => {
    const row = await saved();
    const rewards = bundle({ tables: [{ id: 'loot', table: row.key, draws: 1 }] });
    const snapshot = resolveDungeonRewardDependencies(singleRoomDungeon([{ id: 'reward', type: 'reward', rewards }]), await loadDungeonRewardContext(w.t.db)).snapshot!;
    const payload = { target: { bundle: rewards }, seed: 33, simulate: 100 };
    const result = await preview(payload);
    const plans = Array.from({ length: 100 }, (_, i) => resolveRewardBundle(rewards, rewardResolverSnapshot(snapshot), deriveDungeonSeed(33, ['test-roll', 'simulation', i]), TEST_ROLL_ACTIVITY));
    expect(result.simulation!.averages.find((a) => a.reward.type === 'currency' && a.reward.currency === 'waifubux')!.averageQuantity).toBe(plans.reduce((a, p) => a + p.atRisk.waifubux, 0) / 100);
    expect(result.simulation!.averages.find((a) => a.reward.type === 'item')!.averageQuantity).toBe(plans.reduce((a, p) => a + (p.secured.items[0]?.quantity ?? 0), 0) / 100);
    expect(result.simulation!.nothingRate).toBe(plans.filter((p) => p.lines.every((l) => !l.hit)).length / 100);
    expect(result.simulation!.nothingResults).toBe(plans.flatMap((p) => p.lines).filter((l) => l.missReason === 'nothing').length);
    expect(await preview(payload)).toEqual(result);
  });
  it('accepts the 10,000 simulation boundary and omits simulation for zero', async () => {
    const payload = { target: { bundle: bundle({ guaranteed: [{ id: 'cash', grant: currency('waifubux', 7) }] }) }, seed: 1 };
    expect((await preview({ ...payload, simulate: 10_000 })).simulation).toMatchObject({ runs: 10_000, nothingRate: 0, averages: [{ averageQuantity: 7 }] });
    expect((await preview({ ...payload, simulate: 0 })).simulation).toBeUndefined();
  });
  it.each([-1, 1.5, 10_001])('rejects invalid simulation count %s', async (simulate) => {
    expect((await call({ ...targetTable, simulate })).statusCode).toBe(400);
  });
  it.each([-1, 0x1_0000_0000, 1.2, '123', null])('rejects invalid seed %s', async (seed) => {
    expect((await call({ ...targetTable, seed })).statusCode).toBe(400);
  });
  it('enforces combined simulation work bounds', async () => {
    const heavy = { guaranteed: [], chances: [], pools: Array.from({ length: 6 }, (_, i) => ({ id: `pool_${i}`, name: 'Nothing', draws: 10, entries: [{ id: 'nothing', weight: 1, nothing: true }] })) };
    const result = await preview({ target: { tableBody: heavy, draws: 2 }, simulate: 10_000, seed: 1 });
    expect(result.roll).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ path: 'simulate', code: 'reward_too_many_draws', severity: 'error' }));
  });
  it('reports activity work violations and malformed structures/overrides', async () => {
    const heavy = { guaranteed: [], chances: [], pools: Array.from({ length: 6 }, (_, i) => ({ id: `pool_${i}`, name: 'Nothing', draws: 10, entries: [{ id: 'nothing', weight: 1, nothing: true }] })) };
    const result = await preview({ target: { tableBody: heavy, draws: 10 }, seed: 1 });
    expect(result.roll).toBeNull();
    expect(result.issues.some((i) => i.code === 'reward_too_many_draws')).toBe(true);
    for (const payload of [{ target: { bundle: { guaranteed: [] } } }, { target: { tableBody: { pools: [] } } }, { ...targetTable, tables: { broken: {} } }]) {
      const invalid = await preview(payload);
      expect(invalid.roll).toBeNull();
      expect(invalid.issues.some((i) => i.code === 'schema')).toBe(true);
    }
  });
  it('reports missing and archived tables rather than a rolled-Nothing result', async () => {
    const row = await saved();
    await tables.archive(row.key, { expectedRevision: 1 }, 'test');
    for (const [key, code] of [['missing_table', 'reward_table_missing'], [row.key, 'reward_table_archived']] as const) {
      const result = await preview({ target: { bundle: bundle({ tables: [{ id: 'loot', table: key, draws: 1 }] }) }, seed: 1 });
      expect(result.roll).toBeNull();
      expect(result.analysis).toBeNull();
      expect(result.issues).toContainEqual(expect.objectContaining({ code, severity: 'error' }));
    }
  });
  it('reports missing items and empty equipment selectors', async () => {
    for (const [grant, code] of [
      [{ type: 'item', item: 'nonexistent_item', quantity: { min: 1, max: 1 } }, 'reward_item_missing'],
      [{ type: 'equipment', selector: { definitionKeys: ['nonexistent_gear'] } }, 'reward_equipment_empty'],
    ] as const) {
      const result = await preview({ target: { bundle: { guaranteed: [{ id: 'bad', grant }], chances: [], tables: [] } } });
      expect(result.roll).toBeNull();
      expect(result.issues).toContainEqual(expect.objectContaining({ code }));
    }
  });
  it('uses live item eligibility and live equipment eligibility', async () => {
    const [item] = await w.t.db.select().from(items).where(eq(items.slug, 'sticky_joystick'));
    const [gear] = await w.t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, 'rusty_pipe'));
    try {
      await w.t.db.update(items).set({ enabled: false, maxOwned: 1 }).where(eq(items.slug, item!.slug));
      await w.t.db.update(equipmentDefinitions).set({ enabled: false }).where(eq(equipmentDefinitions.key, gear!.key));
      const result = await preview({ target: { bundle: { guaranteed: [
        { id: 'item', grant: { type: 'item', item: item!.slug, quantity: { min: 1, max: 1 } } },
        { id: 'gear', grant: { type: 'equipment', selector: { definitionKeys: [gear!.key] } } },
      ], chances: [], tables: [] } } });
      expect(result.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['reward_item_disabled', 'reward_item_capped', 'reward_equipment_empty']));
      expect(result.roll).toBeNull();
    } finally {
      await w.t.db.update(items).set({ enabled: item!.enabled, maxOwned: item!.maxOwned }).where(eq(items.slug, item!.slug));
      await w.t.db.update(equipmentDefinitions).set({ enabled: gear!.enabled }).where(eq(equipmentDefinitions.key, gear!.key));
    }
  });
  it('checks supplied Shards configuration and defers it outside a containing dungeon', async () => {
    expect((await preview({ target: { bundle: money }, progressionCurrency: null })).issues.some((i) => i.code === 'reward_shards_unset')).toBe(true);
    expect((await preview({ target: { bundle: money }, progressionCurrency: 'missing_currency' })).roll).toBeNull();
    expect((await preview({ target: { bundle: money }, progressionCurrency: CURRENCY })).roll).not.toBeNull();
    expect((await preview({ target: { bundle: money } })).roll).not.toBeNull();
  });
  it('enforces dungeons.read, authentication and CSRF', async () => {
    for (const role of ['writer', 'rewards']) expect((await call(targetTable, role)).statusCode).toBe(403);
    expect((await api.inject({ method: 'POST', url: base, payload: targetTable })).statusCode).toBe(401);
    expect((await api.inject({ method: 'POST', url: base, payload: targetTable, cookies: { wm_portal_session: 'reader' } })).statusCode).toBe(403);
    expect((await api.inject({ method: 'POST', url: base, payload: targetTable, headers: { authorization: `Bearer ${TEST_TOKEN}` } })).statusCode).toBe(403);
  });
  it('runs inside a PostgreSQL read-only repeatable-read transaction', async () => {
    const original = w.t.db.transaction.bind(w.t.db);
    const modes: unknown[] = [];
    vi.spyOn(w.t.db, 'transaction').mockImplementation((callback, config) => original(async (tx) => {
      modes.push((await tx.execute(sql`show transaction_read_only`)).rows[0]);
      modes.push((await tx.execute(sql`show transaction_isolation`)).rows[0]);
      return callback(tx);
    }, config));
    await preview(targetTable);
    expect(modes).toEqual([{ transaction_read_only: 'on' }, { transaction_isolation: 'repeatable read' }]);
  });
  it('cannot call grants or run mutation services and repeated previews leave every database row unchanged', async () => {
    await w.player();
    const spies = [
      vi.spyOn(w.app.inventory, 'addItem'), vi.spyOn(w.svc.equipment, 'grantEquipment'),
      vi.spyOn(w.app.currency, 'grantWaifubux'), vi.spyOn(w.app.currency, 'grantEssence'),
      vi.spyOn(w.app.essenceAward, 'awardEssence'), vi.spyOn(w.currencies, 'grant'),
      vi.spyOn(w.app.collection, 'awardBuddyAffection'), vi.spyOn(w.app.collection, 'awardCopyAffection'),
      vi.spyOn(w.runs, 'start'), vi.spyOn(w.runs, 'act'),
    ];
    for (const spy of spies) spy.mockImplementation(() => { throw new Error('Preview reached a mutation service'); });
    const rewards = bundle({ guaranteed: [
      ...money.guaranteed, { id: 'essence', grant: currency('essence', 7) },
      { id: 'love', grant: { type: 'affection', amount: { min: 3, max: 3 } } },
      { id: 'charm', grant: { type: 'item', item: 'sticky_joystick', quantity: { min: 2, max: 2 } } },
      { id: 'gear', grant: { type: 'equipment', selector: { definitionKeys: ['rusty_pipe'] } } },
    ] });
    const before = await dbImage();
    for (let seed = 0; seed < 3; seed++) {
      expect((await preview({ target: { bundle: rewards }, seed, simulate: 10 })).roll).not.toBeNull();
      await play({ definition: singleRoomDungeon([{ id: 'treasure', type: 'reward', rewards }]), seed, autoPlay: true });
    }
    expect(await dbImage()).toEqual(before);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('sandbox reward snapshots', () => {
  it.each(['combat', 'boss', 'reward'] as const)('draft %s rewards match the T9 sandbox engine', async (type) => {
    const rewards = bundle({ guaranteed: [...money.guaranteed, { id: 'essence', grant: currency('essence', 5) }] });
    const definition = singleRoomDungeon([type === 'reward'
      ? { id: 'reward', type, rewards }
      : { id: 'reward', type, waves: [{ enemy: { key: 'grunt' } }, { enemy: { key: 'sentinel' } }], rewards }]);
    const snapshot = resolveDungeonRewardDependencies(definition, await loadDungeonRewardContext(w.t.db)).snapshot!;
    const fighter = { attack: 1000, defense: 1000, maxHp: 10000 };
    const expected = createDungeonSandbox({ definition, rewards: snapshot,
      dependencies: { enemies: Object.fromEntries((await w.enemies.definitions()).map((e) => [e.key, e])), rewardTables: {} },
      fighter: { waifuId: 0, name: 'Sandbox Buddy', ...fighter }, seed: 42 });
    await autoPlayDungeonSandbox(expected);
    const result = await play({ definition, seed: 42, fighter, autoPlay: true });
    expect(result.state).toEqual(expected.state);
    expect(result.effects).toEqual(expected.effects);
    expect(result.state.end).toMatchObject({ banked: 40, waifubux: { earned: 500, banked: 500, lost: 0 } });
    expect(result.effects.filter((e: { type: string }) => e.type === 'grant_rewards')).toHaveLength(1);
  });
  it('saved drafts and unsaved table overrides accumulate risk and record abandon settlement', async () => {
    const row = await saved();
    const rewards = bundle({ tables: [{ id: 'loot', table: row.key, draws: 1 }] });
    const definition = singleRoomDungeon([{ id: 'reward', type: 'reward', rewards }]);
    definition.key = 'draft_reward_sandbox';
    const created = await w.content.create({ definition }, 'test');
    const overrides = { [row.key]: { guaranteed: money.guaranteed, chances: [], pools: [] } };
    const result = await play({ key: created.key, tables: overrides, seed: 1, inputs: [{ type: 'advance' }, { type: 'abandon' }] });
    expect(result.state.end).toMatchObject({ outcome: 'abandoned', earned: 40, banked: 10, lost: 30, waifubux: { earned: 500, banked: 125, lost: 375 } });
    expect(result.state.rewardClaims).toBeTruthy();
    expect((await tables.get(row.key))!.body).toEqual(table);
  });
  it('published sandbox uses immutable pinned rewards after catalogue edits/archive', async () => {
    const row = await saved({ guaranteed: money.guaranteed, chances: [], pools: [] });
    const rewards = bundle({ tables: [{ id: 'loot', table: row.key, draws: 1 }] });
    const definition = singleRoomDungeon([{ id: 'reward', type: 'reward', rewards }]);
    definition.key = 'published_reward_sandbox';
    await w.publish(definition);
    const before = await play({ key: definition.key, source: 'published', autoPlay: true, seed: 1 });
    await tables.update(row.key, { expectedRevision: 1, body: table }, 'test');
    await tables.archive(row.key, { expectedRevision: 2 }, 'test');
    const after = await play({ key: definition.key, source: 'published', autoPlay: true, seed: 1 });
    expect(after).toEqual(before);
    expect((await call({ key: definition.key, autoPlay: true }, 'reader', '/api/v1/admin/dungeons/sandbox')).statusCode).toBe(400);
    expect((await call({ key: definition.key, source: 'published', tables: { [row.key]: table } }, 'reader', '/api/v1/admin/dungeons/sandbox')).statusCode).toBe(400);
  });
  it('rejects unsupported pinned resolver snapshot versions with a readable error', async () => {
    const definition = singleRoomDungeon([{ id: 'reward', type: 'reward', rewards: money }]);
    definition.key = 'unsupported_reward_sandbox';
    await w.publish(definition);
    const original = w.content.revision.bind(w.content);
    vi.spyOn(w.content, 'revision').mockImplementation(async (...args) => {
      const revision = (await original(...args))!;
      return { ...revision, rewardSnapshot: { ...revision.rewardSnapshot!, resolverVersion: 2 } } as unknown as typeof revision;
    });
    const response = await call({ key: definition.key, source: 'published' }, 'reader', '/api/v1/admin/dungeons/sandbox');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.issues).toContainEqual(expect.objectContaining({ code: 'reward_snapshot_invalid', message: expect.stringContaining('unsupported') }));
  });
  it('sandbox always validates its containing Shards configuration', async () => {
    const definition = singleRoomDungeon([{ id: 'reward', type: 'reward', rewards: money }]);
    definition.settings.progressionCurrency = null;
    const response = await call({ definition }, 'reader', '/api/v1/admin/dungeons/sandbox');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.issues.some((i: { code: string }) => i.code === 'reward_shards_unset')).toBe(true);
  });
  it('legacy sandbox retains currency-only reward outcomes', async () => {
    const definition = singleRoomDungeon([{ id: 'legacy', type: 'reward', reward: { currency: { min: 7, max: 7 }, rewardTable: 'test-dungeon-loot' } }]);
    const fighter = { attack: 83, defense: 65, maxHp: 370 };
    const result = await play({ definition, autoPlay: true, seed: 7, fighter });
    const expected = createDungeonSandbox({ definition, dependencies: { enemies: {}, rewardTables: {} }, fighter: { waifuId: 0, name: 'Sandbox Buddy', ...fighter }, seed: 7 });
    await autoPlayDungeonSandbox(expected);
    expect(result.state).toEqual(expected.state);
    expect(result.effects).toEqual(expected.effects);
    expect(result.state.end.banked).toBe(7);
  });
});
