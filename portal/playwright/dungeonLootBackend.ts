/**
 * A stand-in Dungeon Loot catalogue API for browser tests that keeps the parts
 * that matter real: table bodies are checked by the server's own
 * `validateDungeonLootTableBody`, and Test Roll and the odds come from the
 * server's own resolver and analyser (`testRollDungeonRewards`). So a body the
 * real API would refuse is refused here, and every figure on screen is one the
 * game would produce.
 *
 * Like `dungeonBackend.ts`, the bot modules are loaded by path when a test
 * runs and never statically imported.
 */
import type { Page } from '@playwright/test';
import type {
  DungeonLootTable,
  DungeonLootTableBody,
  DungeonLootTableUsage,
} from '@/api/adminDungeonLootTables';
import type { DungeonIssue } from '@/api/adminDungeons';

export const ITEMS = [
  { slug: 'bent_gear', name: 'Bent Gear', category: 'salvage', enabled: true, maxOwned: null },
  { slug: 'founders_badge', name: 'Founder’s Badge', category: 'key', enabled: true, maxOwned: 1 },
  { slug: 'old_token', name: 'Old Token', category: 'consumable', enabled: false, maxOwned: null },
  {
    slug: 'velvet_charm',
    name: 'Velvet Charm',
    category: 'capture',
    enabled: true,
    maxOwned: null,
  },
];
export const GEAR = [
  { key: 'bolt_cutter', name: 'Bolt Cutter', slot: 'attack', rarity: 'R', enabled: true },
  { key: 'heart_locket', name: 'Heart Locket', slot: 'health', rarity: 'SR', enabled: true },
  { key: 'iron_plate', name: 'Iron Plate', slot: 'defense', rarity: 'R', enabled: true },
  { key: 'rusted_wrench', name: 'Rusted Wrench', slot: 'attack', rarity: 'N', enabled: true },
];

interface Inspection {
  body: DungeonLootTableBody | null;
  issues: DungeonIssue[];
  equipmentPools: DungeonLootTable['equipmentPools'];
}
const VALIDATION = '../../src/modules/dungeons/validation/dungeonRewardValidation';
const PREVIEW = '../../src/modules/dungeons/dungeonRewardPreview';
const SELECTOR = '../../src/modules/equipment/rewardSelector';
let modules:
  | Promise<{
      validateDungeonLootTableBody: (raw: unknown, ctx: unknown) => Inspection;
      DungeonTestRollRequestSchema: { parse: (raw: unknown) => unknown };
      testRollDungeonRewards: (input: unknown, ctx: unknown) => unknown;
      context: unknown;
    }>
  | undefined;
async function server() {
  modules ??= (async () => {
    const [validation, preview, selector] = await Promise.all([
      import(VALIDATION),
      import(PREVIEW),
      import(SELECTOR),
    ]);
    return {
      validateDungeonLootTableBody: validation.validateDungeonLootTableBody,
      DungeonTestRollRequestSchema: preview.DungeonTestRollRequestSchema,
      testRollDungeonRewards: preview.testRollDungeonRewards,
      // What the real service loads: the item catalogue and the game's own selector rules.
      context: {
        items: new Map(ITEMS.map(({ slug, ...item }) => [slug, item])),
        lootTables: new Map(),
        resolveEquipmentSelector: (s: unknown) => selector.eligibleRewardDefinitions(s, GEAR),
      },
    };
  })();
  return modules;
}
export async function inspect(body: unknown): Promise<Inspection> {
  const { validateDungeonLootTableBody, context } = await server();
  return validateDungeonLootTableBody(body, context);
}
/**
 * What the real services load to check and roll a dungeon's rewards: the item
 * catalogue, the game's selector rules, and the loot catalogue as it stands.
 */
export async function rewardContext(tables: readonly DungeonLootTable[]) {
  const { context } = await server();
  return {
    ...(context as object),
    lootTables: new Map(
      tables.map((t) => [
        t.key,
        {
          name: t.name,
          archivedAt: t.archivedAt,
          body: t.body,
          tier: t.tier,
          revision: t.revision,
        },
      ]),
    ),
  };
}

const NOW = '2026-10-10T00:00:00.000Z';
export async function lootTable(
  key: string,
  name: string,
  body: DungeonLootTableBody,
  extra: Partial<DungeonLootTable> = {},
): Promise<DungeonLootTable> {
  const report = await inspect(body);
  return {
    key,
    name,
    description: '',
    tier: null,
    body,
    contentHash: 'sha256:stub',
    revision: 1,
    archivedAt: null,
    origin: 'portal',
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'author',
    updatedBy: 'author',
    issues: report.issues,
    equipmentPools: report.equipmentPools,
    ...extra,
  };
}

/**
 * `scope: 'loot-tables'` answers only the catalogue routes, for a spec that
 * serves the dungeon itself from `dungeonBackend.ts` (register this one last).
 */
export async function serveLoot(
  page: Page,
  tables: DungeonLootTable[] = [],
  usage: Record<string, DungeonLootTableUsage> = {},
  scope: 'all' | 'loot-tables' = 'all',
) {
  const state = {
    tables,
    /** Every write the catalogue accepted. */
    saves: 0,
    testRolls: [] as Array<{
      target: { tableBody: DungeonLootTableBody; draws: number; bundle?: unknown };
      progressionCurrency?: string | null;
    }>,
    /** Any request that would publish or roll back a dungeon. */
    publishes: 0,
  };
  const routes =
    scope === 'all'
      ? /\/api\/v1\/admin\/dungeons(\/|\?|$)/
      : /\/api\/v1\/admin\/dungeons\/loot-tables(\/|\?|$)/;
  await page.route(routes, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/admin\/dungeons/, '');
    const method = request.method();
    const meta = { requestId: 'loot-backend' };
    const ok = (data: unknown, status = 200) => route.fulfill({ status, json: { data, meta } });
    const fail = (status: number, code: string, message: string, details?: unknown) =>
      route.fulfill({ status, json: { error: { code, message, details }, meta } });
    const input = () => request.postDataJSON() as Record<string, unknown>;
    if (/\/(publish|rollback)$/.test(path)) state.publishes++;

    // The dungeon list page this area is reached from.
    if (path === '') return ok({ dungeons: [] });
    if (path === '/settings')
      return ok({
        dailyRunLimit: 3,
        dailyRunLimitMin: 0,
        dailyRunLimitMax: 50,
        updatedAt: null,
        updatedBy: null,
      });
    if (path === '/currencies') return ok({ currencies: [] });
    if (path.endsWith('/import-history')) return ok({ imports: [] });
    if (path === '/reference')
      return ok({
        lootTables: state.tables.map((t) => ({
          key: t.key,
          name: t.name,
          tier: t.tier,
          archived: t.archivedAt !== null,
          contentHash: t.contentHash,
        })),
        items: ITEMS,
        actionTypes: [],
        reservedActionTypes: {},
        enemies: [],
        rewardTables: [],
        currencies: [],
        regions: [],
      });
    if (!path.startsWith('/loot-tables')) return fail(404, 'NOT_FOUND', 'Not found.');

    const rest = path.slice('/loot-tables'.length);
    if (rest === '/validate') {
      const report = await inspect(input().body);
      return ok({
        ...report,
        valid: report.body !== null && !report.issues.some((i) => i.severity === 'error'),
        contentHash: report.body ? 'sha256:stub' : null,
      });
    }
    if (rest === '/test-roll') {
      const { DungeonTestRollRequestSchema, testRollDungeonRewards } = await server();
      state.testRolls.push(input() as (typeof state.testRolls)[number]);
      return ok(
        testRollDungeonRewards(
          DungeonTestRollRequestSchema.parse(input()),
          await rewardContext(state.tables),
        ),
      );
    }
    if (rest === '' && method === 'GET') {
      const search = url.searchParams.get('search')?.toLowerCase() ?? '';
      const tier = url.searchParams.get('tier');
      const archived = url.searchParams.get('includeArchived') === 'true';
      return ok({
        tables: state.tables.filter(
          (t) =>
            (archived || t.archivedAt === null) &&
            (!tier || t.tier === tier) &&
            t.name.toLowerCase().includes(search),
        ),
      });
    }
    /** The real service stores only a body whose shape parses; dependency issues are returned. */
    const stored = async (body: unknown) => {
      const report = await inspect(body);
      if (!report.body) {
        await fail(400, 'DUNGEON_LOOT_TABLE_INVALID', 'Fix the dungeon loot table fields.', {
          issues: report.issues,
        });
        return null;
      }
      return report as Inspection & { body: DungeonLootTableBody };
    };
    if (rest === '' && method === 'POST') {
      const body = input();
      if (state.tables.some((t) => t.key === body.key))
        return fail(409, 'DUNGEON_LOOT_TABLE_KEY_TAKEN', 'Another table already uses that key.');
      const report = await stored(body.body);
      if (!report) return;
      const created = await lootTable(body.key as string, body.name as string, report.body, {
        description: (body.description as string) ?? '',
        tier: (body.tier as DungeonLootTable['tier']) ?? null,
      });
      state.tables.push(created);
      state.saves++;
      return ok(created, 201);
    }

    const [, key = '', operation = ''] = rest.split('/');
    const index = state.tables.findIndex((t) => t.key === decodeURIComponent(key));
    const current = state.tables[index];
    if (!current)
      return fail(404, 'DUNGEON_LOOT_TABLE_NOT_FOUND', 'That table could not be found.');
    if (operation === 'where-used') return ok(usage[current.key] ?? { drafts: [], published: [] });
    if (operation === 'history') return ok({ events: [] });
    if (method === 'GET') return ok(current);
    if (operation !== 'duplicate' && input().expectedRevision !== current.revision)
      return fail(409, 'DUNGEON_LOOT_TABLE_STALE', 'This loot table changed since you opened it.', {
        key: current.key,
        expectedRevision: input().expectedRevision,
        currentRevision: current.revision,
        updatedBy: current.updatedBy,
        updatedAt: current.updatedAt,
      });
    const put = (next: DungeonLootTable) => {
      state.tables[index] = { ...next, revision: current.revision + 1 };
      state.saves++;
      return ok(state.tables[index]);
    };
    if (method === 'PUT') {
      const body = input();
      const report = await stored(body.body ?? current.body);
      if (!report) return;
      return put({
        ...current,
        name: (body.name as string) ?? current.name,
        description: (body.description as string) ?? current.description,
        tier: body.tier === undefined ? current.tier : (body.tier as DungeonLootTable['tier']),
        body: report.body,
        issues: report.issues,
        equipmentPools: report.equipmentPools,
      });
    }
    if (operation === 'archive') return put({ ...current, archivedAt: NOW });
    if (operation === 'restore') return put({ ...current, archivedAt: null });
    if (operation === 'duplicate') {
      const copy = await lootTable(
        input().key as string,
        (input().name as string) ?? current.name,
        current.body,
        { description: current.description, tier: current.tier },
      );
      state.tables.push(copy);
      state.saves++;
      return ok(copy, 201);
    }
    if (method === 'DELETE') {
      state.tables.splice(index, 1);
      state.saves++;
      return ok({ deleted: true });
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  });
  return state;
}
