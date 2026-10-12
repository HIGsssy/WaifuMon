/** T15B real API + PostgreSQL: legacy treasure conversion (plan, apply, retry, races) and published reward health. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { and, eq } from 'drizzle-orm';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import type { PortalAuthorizationService, PortalPermission } from '../../../src/modules/portalAuth/portalAuthService';
import { createDungeonLootTableService, type DungeonLootTableService } from '../../../src/modules/dungeons/dungeonLootTableService';
import { dungeonContentEvents, dungeonDefinitions, dungeonLootTableEvents, dungeonLootTables, dungeonRevisions, dungeonRuns, equipmentDefinitions, items, rewardTables } from '../../../src/db/schema';
import { rewardTableHash } from '../../../src/modules/rewardTables/rewardTableCore';
import { seedRewardTables } from '../../../src/modules/rewardTables/rewardTableStore';
import type { DungeonDefinition } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonRewardBundleSchema } from '../../../src/modules/dungeons/content/dungeonRewards';
import { dungeonContentHash } from '../../../src/modules/dungeons/package/dungeonPackage';
import { createDungeonWorld, GEAR_TABLE, LOOT_TABLE, type DungeonWorld } from '../../helpers/dungeonWorld';
import { singleRoomDungeon } from '../../helpers/dungeonFixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';

let w: DungeonWorld;
let api: ZodFastify;
let tables: DungeonLootTableService;
const CSRF = 'conversion-csrf';
const grants: Record<string, PortalPermission[]> = {
  reader: ['dungeons.read'],
  author: ['dungeons.read', 'dungeons.write'],
  publisher: ['dungeons.publish'],
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
const RICH_TABLE = 'test-conversion-rich';
const RICH = {
  id: RICH_TABLE,
  enabled: true,
  waifubux: { min: 0, max: 30 },
  essence: { min: 4, max: 6 },
  playerXp: 25,
  groups: [
    { id: 'salvage', enabled: true, rolls: 2, chanceBasisPoints: 2500, entries: [{ itemId: 'sticky_joystick', weight: 3, quantity: 2, enabled: true }, { itemId: 'sticky_joystick', weight: 9, quantity: 5, enabled: false }], equipment: [{ slot: 'attack', rarity: 'N', weight: 1 }] },
    { id: 'off', enabled: false, rolls: 1, chanceBasisPoints: 10_000, entries: [{ itemId: 'sticky_joystick', weight: 1, quantity: 1, enabled: true }] },
  ],
};
beforeAll(async () => {
  w = await createDungeonWorld();
  await seedRewardTables(w.t.db, [{ kind: 'expedition' as const, id: RICH_TABLE, definition: RICH, hash: rewardTableHash('expedition', RICH), position: 20_000 }]);
  tables = createDungeonLootTableService({ db: w.t.db });
  const authorization = {
    has: async (s: PortalSession | null, p: PortalPermission) => !!s && !!grants[s.discordUserId]?.includes(p),
  } as PortalAuthorizationService;
  const sessions = {
    getSession: async (token?: string) => (token && grants[token] ? session(token) : null),
    safeEquals: (a: string, b: string) => a === b,
  } as unknown as PortalSessionService;
  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3136, token: TEST_TOKEN },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    portalAuth: {
      config: { publicUrl: 'http://localhost', forwardedProto: 'http', discordClientId: 'x', discordClientSecret: 'x', sessionSecret: 'x', sessionTtlSeconds: 3600 },
      sessions,
      authorization,
    },
    ctx: {
      services: { ...w.app, dungeonContent: w.content, dungeonLootTables: tables, progressionCurrency: w.currencies, dungeonAllowance: w.allowance, dungeonRuns: w.runs, enemies: w.enemies, equipment: w.svc.equipment },
      getContent: () => w.app.content,
      portalAuthorization: authorization,
    },
  });
});
afterAll(async () => {
  await api?.close();
  await w?.cleanup();
});

const root = '/api/v1/admin/dungeons';
const request = (method: 'GET' | 'POST', url: string, payload?: unknown, role: string | null = 'author') =>
  api.inject({
    method,
    url: `${root}${url}`,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    ...(role ? { cookies: { wm_portal_session: role, wm_portal_csrf: CSRF }, headers: { 'x-portal-csrf': CSRF } } : {}),
  });
const TARGET = { roomId: 'hall', actionId: 'chest' };
type Reward = { rewardTable: string | null; equipmentRewardTable: string | null; currency: { min: number; max: number } };
async function legacy(key: string, reward: Reward, publish = false) {
  const definition = singleRoomDungeon([{ id: 'chest', type: 'reward', reward }], (d) => {
    d.key = key;
    d.name = `Legacy ${key}`;
  });
  const created = await w.content.create({ definition }, 'test');
  if (publish) await w.content.publish(key, { expectedRevision: created.draftRevision }, 'test');
  return definition;
}
async function plan(key: string, role = 'author') {
  const response = await request('POST', `/definitions/${key}/treasure-conversion/plan`, TARGET, role);
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data;
}
const apply = (key: string, planned: { draftRevision: number; planHash: string }, role = 'author') =>
  request('POST', `/definitions/${key}/treasure-conversion/apply`, { ...TARGET, expectedRevision: planned.draftRevision, expectedPlanHash: planned.planHash }, role);
const chest = (definition: DungeonDefinition) => definition.rooms[0]!.actions[0]! as { reward?: Reward; rewards?: { guaranteed: unknown[]; tables: { table: string; draws: number }[] } };
const lootKeys = async () => (await w.t.db.select({ key: dungeonLootTables.tableKey }).from(dungeonLootTables)).map((r) => r.key).sort();
async function dbImage() {
  const names = await w.t.pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' order by tablename");
  const result: Record<string, unknown> = {};
  for (const { tablename } of names.rows) {
    const name = tablename.replaceAll('"', '""');
    result[tablename] = (await w.t.pool.query(`select coalesce(jsonb_agg(row_data order by row_data::text), '[]'::jsonb) as rows from (select to_jsonb(t) as row_data from "${name}" t) s`)).rows[0].rows;
  }
  return result;
}

describe('conversion preview', () => {
  it('describes the whole conversion for both legacy table fields and writes nothing', async () => {
    await legacy('plan_both', { rewardTable: RICH_TABLE, equipmentRewardTable: GEAR_TABLE, currency: { min: 4, max: 9 } });
    const before = await dbImage();
    const planned = await plan('plan_both');
    expect(await dbImage()).toEqual(before);
    expect(planned).toMatchObject({
      dungeonKey: 'plan_both',
      roomId: 'hall',
      actionId: 'chest',
      roomName: 'Hall',
      draftRevision: 1,
      legacy: { rewardTable: RICH_TABLE, equipmentRewardTable: GEAR_TABLE, currency: { min: 4, max: 9 } },
      blockers: [],
      waifubuxAtRisk: true,
      retention: { defeatBasisPoints: 2500, abandonBasisPoints: 2500 },
    });
    expect(planned.rewards).toEqual({
      guaranteed: [{ id: 'g_shards', grant: { type: 'currency', currency: 'shards', amount: { min: 4, max: 9 } } }],
      chances: [],
      tables: [
        { id: 't_1', table: 'converted_test_conversion_rich', draws: 1 },
        { id: 't_2', table: 'converted_test_dungeon_gear', draws: 1 },
      ],
    });
    expect(planned.tables.map((t: { action: string; key: string; sourceTable: string }) => [t.sourceTable, t.action, t.key])).toEqual([
      [RICH_TABLE, 'create', 'converted_test_conversion_rich'],
      [GEAR_TABLE, 'create', 'converted_test_dungeon_gear'],
    ]);
    // WaifuBux 0..30 exactly; 25% × (3 : 1) with Nothing for the rest; the disabled entry and group are gone.
    expect(planned.tables[0].body).toEqual({
      guaranteed: [],
      chances: [],
      pools: [
        { id: 'waifubux', name: 'WaifuBux', draws: 1, entries: [
          { id: 'amount', weight: 30, grant: { type: 'currency', currency: 'waifubux', amount: { min: 1, max: 30 } } },
          { id: 'none', weight: 1, nothing: true },
        ] },
        { id: 'g1', name: 'salvage', draws: 2, entries: [
          { id: 'i1', weight: 3, grant: { type: 'item', item: 'sticky_joystick', quantity: { min: 2, max: 2 } } },
          { id: 'e1', weight: 1, grant: { type: 'equipment', selector: { slot: 'attack', rarity: 'N' } } },
          { id: 'none', weight: 12, nothing: true },
        ] },
      ],
    });
    expect(planned.omitted.map((o: { reason: string; text: string }) => [o.reason, o.text])).toEqual([
      ['never_paid', '4–6 Essence'],
      ['never_paid', '25 player XP'],
      ['disabled', '5 × sticky_joystick in group "salvage" is switched off.'],
      ['disabled', 'Group "off" is switched off.'],
    ]);
    expect(planned.issues.filter((i: { severity: string }) => i.severity === 'error')).toEqual([]);
    expect(planned.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The same catalogues give the same plan.
    expect((await plan('plan_both')).planHash).toBe(planned.planHash);
  });

  it('needs dungeons.write, and reports blockers and non-legacy activities without writing', async () => {
    await legacy('plan_blocked', { rewardTable: null, equipmentRewardTable: null, currency: { min: 0, max: 7 } });
    for (const role of ['reader', 'publisher', 'rewards']) {
      expect((await request('POST', '/definitions/plan_blocked/treasure-conversion/plan', TARGET, role)).statusCode).toBe(403);
      expect((await request('POST', '/definitions/plan_blocked/treasure-conversion/apply', { ...TARGET, expectedRevision: 1, expectedPlanHash: 'x' }, role)).statusCode).toBe(403);
    }
    expect((await request('POST', '/definitions/plan_blocked/treasure-conversion/plan', TARGET, null)).statusCode).toBe(401);
    const before = await dbImage();
    const planned = await plan('plan_blocked');
    expect(planned.rewards).toBeNull();
    expect(planned.blockers).toEqual([expect.objectContaining({ code: 'conversion_currency_min_zero', table: null })]);
    const refused = await apply('plan_blocked', planned);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'DUNGEON_CONVERSION_BLOCKED', details: { blockers: [expect.objectContaining({ code: 'conversion_currency_min_zero' })] } });
    const missing = await request('POST', '/definitions/plan_blocked/treasure-conversion/plan', { roomId: 'hall', actionId: 'nope' });
    expect(missing.json().error.code).toBe('DUNGEON_CONVERSION_UNAVAILABLE');
    expect((await request('POST', '/definitions/no_such_dungeon/treasure-conversion/plan', TARGET)).statusCode).toBe(404);
    expect(await dbImage()).toEqual(before);
  });
});

describe('applying a conversion', () => {
  it('creates the tables, rewrites only that treasure, records history, and publishes nothing', async () => {
    const definition = await legacy('apply_ok', { rewardTable: LOOT_TABLE, equipmentRewardTable: LOOT_TABLE, currency: { min: 2, max: 2 } }, true);
    const untouched = await legacy('apply_bystander', { rewardTable: LOOT_TABLE, equipmentRewardTable: null, currency: { min: 1, max: 1 } });
    const publishedBefore = (await w.content.get('apply_ok'))!.published!;
    const planned = await plan('apply_ok');
    const response = await apply('apply_ok', planned);
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json().data;
    expect(result).toMatchObject({ createdTables: ['converted_test_dungeon_loot'], reusedTables: [], replayed: false });

    // The draft: one step newer, the treasure in the new shape, everything else as it was.
    expect(result.dungeon.draftRevision).toBe(planned.draftRevision + 1);
    const converted = chest(result.dungeon.draft);
    expect(converted.reward).toBeUndefined();
    expect(converted.rewards).toEqual({
      guaranteed: [{ id: 'g_shards', grant: { type: 'currency', currency: 'shards', amount: { min: 2, max: 2 } } }],
      chances: [],
      // Both legacy fields named the table, so it is rolled twice.
      tables: [{ id: 't_1', table: 'converted_test_dungeon_loot', draws: 2 }],
    });
    expect({ ...result.dungeon.draft, rooms: [] }).toEqual({ ...definition, rooms: [] });
    expect(result.dungeon.issues.filter((i: { severity: string }) => i.severity === 'error')).toEqual([]);

    // Still what was published before: the old revision, with the legacy treasure in it.
    expect(result.dungeon.published).toMatchObject({ number: publishedBefore.number, contentHash: publishedBefore.contentHash });
    expect(result.dungeon.draftDiffers).toBe(true);
    const revisions = await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, 'apply_ok'));
    expect(revisions).toHaveLength(1);
    expect(chest(revisions[0]!.content as unknown as DungeonDefinition).reward).toBeDefined();
    expect(revisions[0]!.rewardSnapshot).toBeNull();

    // The catalogue: a converted table, with its own history.
    const created = (await tables.get('converted_test_dungeon_loot'))!;
    expect(created).toMatchObject({ origin: 'converted', revision: 1, archivedAt: null, createdBy: 'author', name: `${LOOT_TABLE} (converted)` });
    expect(created.body.guaranteed).toEqual([{ id: 'waifubux', grant: { type: 'currency', currency: 'waifubux', amount: { min: 11, max: 11 } } }]);
    expect(created.issues).toEqual([]);
    const tableEvents = await w.t.db.select().from(dungeonLootTableEvents).where(eq(dungeonLootTableEvents.tableKey, created.key));
    expect(tableEvents).toMatchObject([{ action: 'converted', actor: 'author', origin: 'converted', newContentHash: created.contentHash, details: { sourceTable: LOOT_TABLE, dungeonKey: 'apply_ok', roomId: 'hall', actionId: 'chest' } }]);
    const [audit] = await w.t.db.select().from(dungeonContentEvents).where(and(eq(dungeonContentEvents.dungeonKey, 'apply_ok'), eq(dungeonContentEvents.action, 'draft_saved')));
    expect(audit).toMatchObject({ actor: 'author', details: { contentChanged: true, conversion: { roomId: 'hall', actionId: 'chest', planHash: planned.planHash, createdTables: ['converted_test_dungeon_loot'], reusedTables: [] } } });

    // The expedition table and the other dungeon are exactly as they were.
    const [source] = await w.t.db.select().from(rewardTables).where(and(eq(rewardTables.kind, 'expedition'), eq(rewardTables.tableId, LOOT_TABLE)));
    expect(source!.revision).toBe(1);
    const bystander = (await w.content.get('apply_bystander'))!;
    expect(bystander.draftHash).toBe(dungeonContentHash(untouched));
    expect(bystander.draftRevision).toBe(1);

    // Publishing is its own, later act, and pins the converted table.
    const published = await w.content.publish('apply_ok', { expectedRevision: result.dungeon.draftRevision }, 'test');
    expect(published.unchanged).toBe(false);
    const revision = await w.content.revision('apply_ok', published.revision.number);
    expect(Object.keys(revision!.rewardSnapshot!.tables)).toEqual(['converted_test_dungeon_loot']);
  });

  it('answers a retry of the same request without writing again', async () => {
    await legacy('apply_retry', { rewardTable: GEAR_TABLE, equipmentRewardTable: null, currency: { min: 0, max: 0 } });
    const planned = await plan('apply_retry');
    const first = (await apply('apply_retry', planned)).json().data;
    expect(first).toMatchObject({ createdTables: ['converted_test_dungeon_gear'], replayed: false });
    const before = await dbImage();
    const again = await apply('apply_retry', planned);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data).toMatchObject({ createdTables: ['converted_test_dungeon_gear'], reusedTables: [], replayed: true });
    expect(again.json().data.dungeon.draftRevision).toBe(first.dungeon.draftRevision);
    expect(await dbImage()).toEqual(before);
    // A new plan for it finds no legacy treasure left.
    expect((await request('POST', '/definitions/apply_retry/treasure-conversion/plan', TARGET)).json().error.code).toBe('DUNGEON_CONVERSION_UNAVAILABLE');
  });

  it('reuses an identical converted table for another dungeon', async () => {
    await legacy('apply_reuse', { rewardTable: null, equipmentRewardTable: GEAR_TABLE, currency: { min: 0, max: 0 } });
    const keys = await lootKeys();
    const planned = await plan('apply_reuse');
    expect(planned.tables.map((t: { action: string; key: string }) => [t.action, t.key])).toEqual([['reuse', 'converted_test_dungeon_gear']]);
    const result = (await apply('apply_reuse', planned)).json().data;
    expect(result).toMatchObject({ createdTables: [], reusedTables: ['converted_test_dungeon_gear'], replayed: false });
    expect(await lootKeys()).toEqual(keys);
    expect((await tables.get('converted_test_dungeon_gear'))!.revision).toBe(1);
  });

  it('refuses a plan the draft has moved on from', async () => {
    const definition = await legacy('stale_draft', { rewardTable: RICH_TABLE, equipmentRewardTable: null, currency: { min: 1, max: 3 } });
    const planned = await plan('stale_draft');
    await w.content.saveDraft('stale_draft', { definition: { ...definition, description: 'Edited meanwhile.' }, expectedRevision: 1 }, 'someone');
    const before = await dbImage();
    const refused = await apply('stale_draft', planned);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'DUNGEON_DRAFT_STALE', details: { expectedRevision: 1, currentRevision: 2 } });
    expect(await dbImage()).toEqual(before);
    // A plan hash from another draft revision is refused even when the revision number is right.
    const stale = await request('POST', '/definitions/stale_draft/treasure-conversion/apply', { ...TARGET, expectedRevision: 2, expectedPlanHash: planned.planHash });
    expect(stale.json().error.code).toBe('DUNGEON_CONVERSION_STALE');
    expect(await dbImage()).toEqual(before);
  });

  it('refuses a plan whose source table changed, and one whose table key was taken meanwhile', async () => {
    const id = 'test-conversion-moving';
    const moving = { id, enabled: true, waifubux: { min: 5, max: 5 }, groups: [{ id: 'g', enabled: true, rolls: 1, chanceBasisPoints: 10_000, entries: [{ itemId: 'sticky_joystick', weight: 1, quantity: 1, enabled: true }] }] };
    await seedRewardTables(w.t.db, [{ kind: 'expedition' as const, id, definition: moving, hash: rewardTableHash('expedition', moving), position: 20_001 }]);
    await legacy('stale_source', { rewardTable: id, equipmentRewardTable: null, currency: { min: 0, max: 0 } });
    const planned = await plan('stale_source');
    const edited = { ...moving, waifubux: { min: 50, max: 50 } };
    await w.t.db.update(rewardTables).set({ definition: edited, contentHash: rewardTableHash('expedition', edited), revision: 2 }).where(and(eq(rewardTables.kind, 'expedition'), eq(rewardTables.tableId, id)));
    let before = await dbImage();
    const refused = await apply('stale_source', planned);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('DUNGEON_CONVERSION_STALE');
    expect(await dbImage()).toEqual(before);

    // Someone creates a table under the planned key before the author confirms: it is never replaced.
    const replanned = await plan('stale_source');
    expect(replanned.tables[0]).toMatchObject({ action: 'create', key: 'converted_test_conversion_moving' });
    const theirs = await tables.create({ key: 'converted_test_conversion_moving', name: 'Hand made', body: { guaranteed: [], chances: [], pools: [] } }, 'someone');
    before = await dbImage();
    const raced = await apply('stale_source', replanned);
    expect(raced.json().error.code).toBe('DUNGEON_CONVERSION_STALE');
    expect(await dbImage()).toEqual(before);
    // A fresh plan steps around it.
    const third = await plan('stale_source');
    expect(third.tables[0]).toMatchObject({ action: 'create', key: 'converted_test_conversion_moving_2' });
    const done = await apply('stale_source', third);
    expect(done.statusCode, done.body).toBe(200);
    expect(await tables.get('converted_test_conversion_moving')).toMatchObject({ name: 'Hand made', revision: 1, contentHash: theirs.contentHash, origin: 'portal' });
    expect((await tables.get('converted_test_conversion_moving_2'))!.body.guaranteed).toEqual([{ id: 'waifubux', grant: { type: 'currency', currency: 'waifubux', amount: { min: 50, max: 50 } } }]);
  });

  it('leaves no table and no draft change behind when the conversion fails part-way', async () => {
    const id = 'test-conversion-failing';
    const failing = { id, enabled: true, waifubux: { min: 7, max: 7 }, groups: [] };
    await seedRewardTables(w.t.db, [{ kind: 'expedition' as const, id, definition: failing, hash: rewardTableHash('expedition', failing), position: 20_002 }]);
    await legacy('apply_fails', { rewardTable: id, equipmentRewardTable: null, currency: { min: 0, max: 0 } });
    const planned = await plan('apply_fails');
    // The draft write, which comes after the table is inserted, is made to fail.
    await w.t.pool.query(`
      create function t15b_fail() returns trigger as $$ begin raise exception 't15b forced failure'; end $$ language plpgsql;
      create trigger t15b_fail_trg before update on dungeon_definitions for each row when (new.dungeon_key = 'apply_fails') execute function t15b_fail();
    `);
    try {
      const before = await dbImage();
      const failed = await apply('apply_fails', planned);
      expect(failed.statusCode).toBe(500);
      expect(await dbImage()).toEqual(before);
      expect(await tables.get('converted_test_conversion_failing')).toBeNull();
    } finally {
      await w.t.pool.query('drop trigger t15b_fail_trg on dungeon_definitions; drop function t15b_fail();');
    }
    // The same plan still applies once the fault is gone.
    const done = await apply('apply_fails', planned);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().data.createdTables).toEqual(['converted_test_conversion_failing']);
  });
});

describe('published reward health', () => {
  const health = async (role = 'reader') => {
    const response = await request('GET', '/reward-health', undefined, role);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data.dungeons as Array<{ key: string; status: string; revision: number | null; draftErrors: number; problems: Array<Record<string, unknown>> }>;
  };
  const of = async (key: string) => (await health()).find((d) => d.key === key)!;
  let gearKey: string;

  async function withRevisionEdit(run: () => Promise<void>) {
    await w.t.pool.query('alter table dungeon_revisions disable trigger dungeon_revisions_immutable_trg');
    try {
      await run();
    } finally {
      await w.t.pool.query('alter table dungeon_revisions enable trigger dungeon_revisions_immutable_trg');
    }
  }

  beforeAll(async () => {
    await w.t.db.insert(items).values([
      { slug: 'health_prize', name: 'Health Prize', category: 'material', enabled: true },
      { slug: 'health_trophy', name: 'Health Trophy', category: 'material', enabled: true },
    ]);
    const [template] = await w.t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.rarity, 'N')).limit(1);
    const { id: _id, ...gear } = template!;
    gearKey = 'health_blade';
    await w.t.db.insert(equipmentDefinitions).values({ ...gear, key: gearKey, name: 'Health Blade' });
    await tables.create({ key: 'health_table', name: 'Health Table', body: { guaranteed: [{ id: 'trophy', grant: { type: 'item', item: 'health_trophy', quantity: { min: 1, max: 1 } } }], chances: [], pools: [] } }, 'test');
    const rewards = DungeonRewardBundleSchema.parse({
      guaranteed: [
        { id: 'g_prize', grant: { type: 'item', item: 'health_prize', quantity: { min: 1, max: 2 } } },
        { id: 'g_gear', grant: { type: 'equipment', selector: { definitionKeys: [gearKey] } } },
        { id: 'g_gear2', grant: { type: 'equipment', selector: { slot: template!.slot, definitionKeys: [gearKey] } } },
      ],
      chances: [],
      tables: [{ id: 't_1', table: 'health_table', draws: 1 }],
    });
    for (const key of ['health_v2', 'health_snapshot']) {
      await w.publish(singleRoomDungeon([{ id: 'chest', type: 'reward', rewards }], (d) => {
        d.key = key;
        d.name = `Health ${key}`;
      }));
    }
    await legacy('health_legacy', { rewardTable: LOOT_TABLE, equipmentRewardTable: null, currency: { min: 1, max: 1 } }, true);
    // A draft-only problem: the published revision is fine, the draft names a loot table that does not exist.
    const good = singleRoomDungeon([{ id: 'chest', type: 'reward', rewards: { guaranteed: [{ id: 'g_prize', grant: { type: 'item', item: 'health_prize', quantity: { min: 1, max: 1 } } }], chances: [], tables: [] } }], (d) => {
      d.key = 'health_draft';
      d.name = 'Health draft';
    });
    const published = await w.publish(good);
    const broken = structuredClone(good);
    (broken.rooms[0]!.actions[0] as { rewards: { tables: unknown[] } }).rewards.tables = [{ id: 't_1', table: 'no_such_table', draws: 1 }];
    await w.content.saveDraft('health_draft', { definition: broken, expectedRevision: published.dungeon.draftRevision }, 'test');
  });

  it('needs dungeons.read and changes nothing', async () => {
    expect((await request('GET', '/reward-health', undefined, null)).statusCode).toBe(401);
    for (const role of ['rewards', 'publisher']) expect((await request('GET', '/reward-health', undefined, role)).statusCode).toBe(403);
    const before = await dbImage();
    await health();
    await health('author');
    expect(await dbImage()).toEqual(before);
  });

  it('tells healthy rewards, legacy revisions, unpublished dungeons and draft-only errors apart', async () => {
    expect(await of('health_v2')).toMatchObject({ status: 'healthy', revision: 1, problems: [], draftErrors: 0 });
    expect(await of('health_legacy')).toMatchObject({ status: 'no_rewards', revision: 1, problems: [] });
    expect(await of('plan_both')).toMatchObject({ status: 'unpublished', revision: null, problems: [] });
    // The draft is broken; what players get is not.
    const draft = await of('health_draft');
    expect(draft).toMatchObject({ status: 'healthy', problems: [] });
    expect(draft.draftErrors).toBeGreaterThan(0);
  });

  it('does not call an edited, archived or changed loot table broken: the revision holds its own copy', async () => {
    const table = (await tables.get('health_table'))!;
    await tables.update('health_table', { expectedRevision: table.revision, body: { guaranteed: [{ id: 'prize', grant: { type: 'item', item: 'health_prize', quantity: { min: 9, max: 9 } } }], chances: [], pools: [] } }, 'test');
    await tables.archive('health_table', { expectedRevision: table.revision + 1 }, 'test');
    expect(await of('health_v2')).toMatchObject({ status: 'healthy', problems: [] });
    // It is a loot change, reported where loot changes are reported.
    expect((await w.content.get('health_v2'))!.dependencyChanges).toEqual([expect.objectContaining({ kind: 'table', tableKey: 'health_table', status: 'archived' })]);
  });

  it('reports an item that gained a per-player limit, and one that was deleted', async () => {
    await w.t.db.update(items).set({ maxOwned: 1 }).where(eq(items.slug, 'health_prize'));
    await w.t.db.delete(items).where(eq(items.slug, 'health_trophy'));
    const broken = await of('health_v2');
    expect(broken.status).toBe('broken');
    expect(broken.problems).toEqual([
      { type: 'item', reason: 'item_capped', key: 'health_prize', name: 'Health Prize', message: '"Health Prize" is now limited to 1 per player, so it cannot be dungeon loot.', hint: expect.stringContaining('Remove the per-player limit') },
      { type: 'item', reason: 'item_missing', key: 'health_trophy', name: 'Health Trophy', message: 'Item "Health Trophy" (health_trophy) no longer exists, so this revision\'s loot cannot be paid.', hint: expect.stringContaining('Create the item again') },
    ]);
    // Other dungeons are judged on their own.
    expect((await of('health_legacy')).status).toBe('no_rewards');
    await w.t.db.update(items).set({ maxOwned: null }).where(eq(items.slug, 'health_prize'));
    await w.t.db.insert(items).values({ slug: 'health_trophy', name: 'Health Trophy', category: 'material', enabled: true });
    expect((await of('health_v2')).status).toBe('healthy');
  });

  it('reports a deleted equipment definition once, however many rewards use it', async () => {
    await w.t.db.delete(equipmentDefinitions).where(eq(equipmentDefinitions.key, gearKey));
    const broken = await of('health_v2');
    expect(broken.status).toBe('broken');
    expect(broken.problems).toEqual([
      { type: 'equipment', reason: 'equipment_missing', key: gearKey, name: 'Health Blade', message: 'Gear "Health Blade" (health_blade) no longer exists, so this revision\'s loot cannot be paid.', hint: expect.stringContaining('Publish the draft again') },
    ]);
  });

  it('reports a missing, damaged or unsupported frozen copy without failing the whole check', async () => {
    const [revision] = await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, 'health_snapshot'));
    const original = revision!.rewardSnapshot as Record<string, unknown>;
    const stored = async (snapshot: Record<string, unknown>) =>
      withRevisionEdit(async () => {
        await w.t.db.update(dungeonRevisions).set({ rewardSnapshot: snapshot }).where(eq(dungeonRevisions.id, revision!.id));
      });
    const reasons = async () => (await of('health_snapshot')).problems.map((p) => [p.type, p.reason]);

    await stored({ ...original, hash: `sha256:${'0'.repeat(64)}` });
    expect(await reasons()).toEqual([['snapshot', 'snapshot_corrupt']]);
    await stored({ ...original, items: { tampered: { name: 'Tampered', category: 'material' } } });
    expect(await reasons()).toEqual([['snapshot', 'snapshot_corrupt']]);
    await stored({ ...original, resolverVersion: 2 });
    expect(await reasons()).toEqual([['snapshot', 'snapshot_unsupported']]);
    await stored({ ...original, tables: 'not a map' });
    expect(await reasons()).toEqual([['snapshot', 'snapshot_unreadable']]);
    const report = await of('health_snapshot');
    expect(report).toMatchObject({ status: 'broken', revision: 1 });
    expect(report.problems[0]).toMatchObject({ key: null, name: 'Revision 1', hint: expect.stringContaining('Publish the draft again') });
    // The check still answers for every other dungeon.
    expect((await of('health_legacy')).status).toBe('no_rewards');

    await withRevisionEdit(async () => {
      await w.t.pool.query('alter table dungeon_revisions drop constraint dungeon_revisions_reward_snapshot_check');
      await w.t.db.update(dungeonRevisions).set({ rewardSnapshot: null }).where(eq(dungeonRevisions.id, revision!.id));
    });
    expect(await reasons()).toEqual([['snapshot', 'snapshot_missing']]);
    // Nothing about the dungeon row was touched by any of this.
    const [row] = await w.t.db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, 'health_snapshot'));
    expect(row!.publishedRevisionId).toBe(revision!.id);
  });
});

describe('reward health for runs in progress on older revisions', () => {
  type Entry = {
    key: string;
    status: string;
    revision: number | null;
    activeRuns: number;
    problems: unknown[];
    activeRevisions: Array<{ revision: number; activeRuns: number; status: string; problems: Array<Record<string, unknown>> }>;
  };
  const report = async (role = 'reader') => {
    const response = await request('GET', '/reward-health', undefined, role);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data.dungeons as Entry[];
  };
  const of = async (key: string) => (await report()).find((d) => d.key === key)!;
  const paying = (key: string, item: string) =>
    singleRoomDungeon([{ id: 'chest', type: 'reward', rewards: DungeonRewardBundleSchema.parse({ guaranteed: [{ id: 'g_prize', grant: { type: 'item', item, quantity: { min: 1, max: 1 } } }], chances: [], tables: [] }) }], (d) => {
      d.key = key;
      d.name = `Runs ${key}`;
    });
  const start = async (key: string) => {
    const { playerId } = await w.player();
    return w.runs.start(playerId, key, { seed: 7 });
  };

  beforeAll(async () => {
    await w.t.db.insert(items).values([
      { slug: 'run_old_prize', name: 'Old Prize', category: 'material', enabled: true },
      { slug: 'run_new_prize', name: 'New Prize', category: 'material', enabled: true },
    ]);
    // Revision 1 pays the old prize and is being played; revision 2, now published, pays the new one.
    await w.publish(paying('runs_pinned', 'run_old_prize'));
    await start('runs_pinned');
    await start('runs_pinned');
    await start('runs_pinned');
    await w.republish(paying('runs_pinned', 'run_new_prize'));
    await start('runs_pinned');
    // The same history with nobody left on revision 1.
    await w.publish(paying('runs_none', 'run_old_prize'));
    await w.republish(paying('runs_none', 'run_new_prize'));
  });

  it('lists an older revision only while runs are on it, with a count and nothing about who', async () => {
    const pinned = await of('runs_pinned');
    expect(pinned).toMatchObject({ status: 'healthy', revision: 2, activeRuns: 1, problems: [] });
    // Three runs on one revision are one line, not three.
    expect(pinned.activeRevisions).toEqual([{ revision: 1, activeRuns: 3, status: 'healthy', problems: [] }]);
    expect(await of('runs_none')).toMatchObject({ status: 'healthy', revision: 2, activeRuns: 0, activeRevisions: [] });
    // Dungeons from the earlier tests, with no runs at all, read as they did.
    expect(await of('health_legacy')).toMatchObject({ status: 'no_rewards', activeRuns: 0, activeRevisions: [] });
    expect(JSON.stringify(pinned)).not.toMatch(/playerId|player_id|discord/i);
  });

  it('reports a broken older revision with active runs while the current publication stays healthy', async () => {
    await w.t.db.update(items).set({ maxOwned: 1 }).where(eq(items.slug, 'run_old_prize'));
    try {
      const pinned = await of('runs_pinned');
      // What is published now does not use the capped item.
      expect(pinned).toMatchObject({ status: 'healthy', revision: 2, problems: [] });
      expect(pinned.activeRevisions).toEqual([{
        revision: 1,
        activeRuns: 3,
        status: 'broken',
        problems: [{
          type: 'item',
          reason: 'item_capped',
          key: 'run_old_prize',
          name: 'Old Prize',
          message: '"Old Prize" is now limited to 1 per player, so it cannot be dungeon loot.',
          hint: expect.stringContaining('Publishing again does not change a run in progress'),
        }],
      }]);
      // The same broken revision with nobody on it is outside this check.
      expect(await of('runs_none')).toMatchObject({ status: 'healthy', activeRevisions: [] });

      // A run that ends stops counting; when the last one ends, the revision drops out.
      const [one] = await w.t.db.select({ id: dungeonRuns.id }).from(dungeonRuns).where(and(eq(dungeonRuns.dungeonKey, 'runs_pinned'), eq(dungeonRuns.status, 'active'))).orderBy(dungeonRuns.id).limit(1);
      await w.t.db.update(dungeonRuns).set({ status: 'abandoned', completedAt: new Date() }).where(eq(dungeonRuns.id, one!.id));
      expect((await of('runs_pinned')).activeRevisions).toMatchObject([{ revision: 1, activeRuns: 2, status: 'broken' }]);
    } finally {
      await w.t.db.update(items).set({ maxOwned: null }).where(eq(items.slug, 'run_old_prize'));
    }
    expect((await of('runs_pinned')).activeRevisions).toMatchObject([{ revision: 1, activeRuns: 2, status: 'healthy', problems: [] }]);
  });

  it('reports a broken current publication and a broken older revision separately', async () => {
    await w.t.db.update(items).set({ maxOwned: 1 }).where(eq(items.slug, 'run_new_prize'));
    await w.t.db.delete(items).where(eq(items.slug, 'run_old_prize'));
    try {
      const pinned = await of('runs_pinned');
      expect(pinned.status).toBe('broken');
      expect(pinned.problems).toMatchObject([{ reason: 'item_capped', key: 'run_new_prize', hint: expect.stringContaining('publish again') }]);
      expect(pinned.activeRevisions).toMatchObject([{ revision: 1, status: 'broken', problems: [{ reason: 'item_missing', key: 'run_old_prize', hint: expect.stringContaining('Create the item again under the same key so these runs can be paid') }] }]);
    } finally {
      await w.t.db.update(items).set({ maxOwned: null }).where(eq(items.slug, 'run_new_prize'));
      await w.t.db.insert(items).values({ slug: 'run_old_prize', name: 'Old Prize', category: 'material', enabled: true });
    }
  });

  it('keeps its permission, writes nothing, and asks the same number of questions however many runs there are', async () => {
    for (const role of ['rewards', 'publisher']) expect((await request('GET', '/reward-health', undefined, role)).statusCode).toBe(403);
    expect((await request('GET', '/reward-health', undefined, null)).statusCode).toBe(401);
    const before = await dbImage();
    await report();
    expect(await dbImage()).toEqual(before);

    const counted = async () => {
      const spy = vi.spyOn(Client.prototype, 'query');
      try {
        await w.content.rewardHealth();
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    const queries = await counted();
    // More runs, on more revisions of more dungeons.
    await w.publish(paying('runs_more', 'run_old_prize'));
    for (let n = 0; n < 4; n++) await start('runs_more');
    await w.republish(paying('runs_more', 'run_new_prize'));
    for (let n = 0; n < 3; n++) await start('runs_more');
    await start('runs_none');
    await w.republish(paying('runs_none', 'run_old_prize'));
    expect(await counted()).toBe(queries);
    expect(await of('runs_more')).toMatchObject({ activeRuns: 3, activeRevisions: [{ revision: 1, activeRuns: 4, status: 'healthy' }] });
    expect(await of('runs_none')).toMatchObject({ revision: 3, activeRuns: 0, activeRevisions: [{ revision: 2, activeRuns: 1, status: 'healthy' }] });
  });
});
