/** T5 save/repair and publication rejection, using migrated disposable storage. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  dungeonLootTables,
  progressionCurrencies,
  dungeonDefinitions,
  dungeonRevisions,
  dungeonContentEvents,
  items,
  equipmentDefinitions,
} from '../../src/db/schema';
import {
  createDungeonLootTableService,
  type DungeonLootTableService,
} from '../../src/modules/dungeons/dungeonLootTableService';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { testDungeonInput } from '../helpers/dungeonFixtures';

let w: DungeonWorld;
let tables: DungeonLootTableService;
beforeAll(async () => {
  w = await createDungeonWorld();
  tables = createDungeonLootTableService({ db: w.t.db });
});
afterAll(async () => {
  await w?.cleanup();
});
const itemBody = (slug: string) => ({
  guaranteed: [{ id: 'item', grant: { type: 'item', item: slug, quantity: { min: 1, max: 2 } } }],
  chances: [],
  pools: [],
});
const gearBody = (key: string) => ({
  guaranteed: [{ id: 'gear', grant: { type: 'equipment', selector: { definitionKeys: [key] } } }],
  chances: [],
  pools: [],
});
let count = 0;
async function dungeon(table: string) {
  const d = testDungeonInput(`reward_validation_${++count}`);
  d.rooms[0]!.actions!.push({
    id: 'hoard',
    type: 'reward',
    rewards: { guaranteed: [], chances: [], tables: [{ id: 'loot', table, draws: 1 }] },
  });
  return w.content.create({ definition: d }, 'author');
}
async function state(key: string) {
  return {
    definitions: await w.t.db
      .select()
      .from(dungeonDefinitions)
      .where(eq(dungeonDefinitions.dungeonKey, key)),
    revisions: await w.t.db
      .select()
      .from(dungeonRevisions)
      .where(eq(dungeonRevisions.dungeonKey, key)),
    events: await w.t.db
      .select()
      .from(dungeonContentEvents)
      .where(eq(dungeonContentEvents.dungeonKey, key)),
  };
}
async function refuses(key: string, revision: number, code: string) {
  const before = await state(key);
  await expect(
    w.content.publish(key, { expectedRevision: revision }, 'publisher'),
  ).rejects.toMatchObject({
    code: 'DUNGEON_INVALID',
    issues: expect.arrayContaining([expect.objectContaining({ code, severity: 'error' })]),
  });
  expect(await state(key)).toEqual(before);
}
describe('T5 catalogue and publication validation', () => {
  it('reports missing and archived dedicated loot tables and blocks publication without writes', async () => {
    const missing = await dungeon('does_not_exist');
    expect(missing.issues.map((i) => i.code)).toContain('reward_table_missing');
    await refuses(missing.key, 1, 'reward_table_missing');
    await tables.create(
      {
        key: 'archived_hoard',
        name: 'Archived hoard',
        body: { guaranteed: [], chances: [], pools: [] },
      },
      'author',
    );
    await tables.archive('archived_hoard', { expectedRevision: 1 }, 'author');
    const archived = await dungeon('archived_hoard');
    await refuses(archived.key, 1, 'reward_table_archived');
  });
  it('allows broken dependency drafts to open, validate without writes, and repair before publication', async () => {
    const broken = await tables.create(
      { key: 'repairable', name: 'Repairable Hoard', body: itemBody('missing_prize') as never },
      'author',
    );
    expect(broken.issues).toContainEqual(expect.objectContaining({ code: 'reward_item_missing' }));
    expect((await tables.get(broken.key))?.issues).toEqual(broken.issues);
    const d = await dungeon(broken.key);
    await refuses(d.key, 1, 'reward_item_missing');
    const before = await tables.get(broken.key);
    const history = await tables.history(broken.key);
    const validation = await tables.validate(before!.body);
    expect(validation).toMatchObject({
      valid: false,
      body: before!.body,
      contentHash: before!.contentHash,
    });
    expect(await tables.get(broken.key)).toEqual(before);
    expect(await tables.history(broken.key)).toEqual(history);
    await w.t.db
      .insert(items)
      .values({ slug: 'repair_prize', name: 'Repair Prize', category: 'material', enabled: true });
    const repaired = await tables.update(
      broken.key,
      { expectedRevision: 1, body: itemBody('repair_prize') as never },
      'author',
    );
    expect(repaired.issues).toEqual([]);
    expect(repaired.revision).toBe(2);
    expect((await w.content.publish(d.key, { expectedRevision: 1 }, 'publisher')).unchanged).toBe(
      false,
    );
  });
  it.each(['disabled', 'capped'] as const)(
    'uses authoritative inventory metadata to block %s transitive rewards',
    async (state) => {
      const slug = `reward_${state}`;
      await w.t.db.insert(items).values({
        slug,
        name: `Prize ${state}`,
        category: 'material',
        enabled: state !== 'disabled',
        maxOwned: state === 'capped' ? 1 : null,
      });
      const table = await tables.create(
        { key: `table_${state}`, name: 'Bad Prize', body: itemBody(slug) as never },
        'author',
      );
      expect(table.issues.map((i) => i.code)).toContain(
        state === 'capped' ? 'reward_item_capped' : 'reward_item_disabled',
      );
      const d = await dungeon(table.key);
      await refuses(d.key, 1, state === 'capped' ? 'reward_item_capped' : 'reward_item_disabled');
    },
  );
  it('exposes actual equipment candidates and notices a definition becoming disabled', async () => {
    const [candidate] = await w.t.db
      .select()
      .from(equipmentDefinitions)
      .where(eq(equipmentDefinitions.rarity, 'R'));
    expect(candidate).toBeTruthy();
    const created = await tables.create(
      { key: 'gear_candidates', name: 'Gear choices', body: gearBody(candidate!.key) as never },
      'author',
    );
    expect(created.issues).toEqual([]);
    expect(Object.values(created.equipmentPools).flat()).toMatchObject([
      { key: candidate!.key, name: candidate!.name, enabled: true },
    ]);
    const d = await dungeon(created.key);
    await w.t.db
      .update(equipmentDefinitions)
      .set({ enabled: false })
      .where(eq(equipmentDefinitions.id, candidate!.id));
    expect((await tables.get(created.key))!.issues.map((i) => i.code)).toContain(
      'reward_equipment_empty',
    );
    await refuses(d.key, 1, 'reward_equipment_empty');
  });
  it('holds v2 table, item, equipment and configured currency locks through publication', async () => {
    await w.t.db
      .insert(items)
      .values({ slug: 'locked_v2_prize', name: 'Locked v2 prize', category: 'material' });
    const table = await tables.create(
      {
        key: 'locked_v2_table',
        name: 'Locked v2 table',
        body: itemBody('locked_v2_prize') as never,
      },
      'author',
    );
    const d = await dungeon(table.key);
    let entered!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = w.enemies.definitions.bind(w.enemies);
    const spy = vi.spyOn(w.enemies, 'definitions').mockImplementationOnce(async (tx) => {
      entered();
      await gate;
      return original(tx);
    });
    const publishing = w.content.publish(d.key, { expectedRevision: 1 }, 'publisher');
    const queries = [
      sql`select 1 from ${dungeonLootTables} where ${dungeonLootTables.tableKey} = ${table.key} for update nowait`,
      sql`select 1 from ${items} where ${items.slug} = 'locked_v2_prize' for update nowait`,
      sql`select 1 from ${equipmentDefinitions} for update nowait`,
      sql`select 1 from ${progressionCurrencies} for update nowait`,
    ];
    try {
      await Promise.race([
        holding,
        publishing.then(() => {
          throw new Error('publication did not pause');
        }),
      ]);
      for (const query of queries)
        await expect(w.t.db.transaction((tx) => tx.execute(query))).rejects.toMatchObject({
          code: '55P03',
        });
    } finally {
      release();
      spy.mockRestore();
      await publishing;
    }
    for (const query of queries) await w.t.db.transaction((tx) => tx.execute(query));
  });
  it('keeps warnings editable and publishable', async () => {
    const table = await tables.create(
      {
        key: 'nothing_pool',
        name: 'Nothing pool',
        body: {
          guaranteed: [],
          chances: [],
          pools: [
            {
              id: 'none',
              name: 'No drop',
              draws: 1,
              entries: [{ id: 'nothing', weight: 1, nothing: true }],
            },
          ],
        },
      },
      'author',
    );
    expect(table.issues).toMatchObject([{ code: 'reward_pool_all_nothing', severity: 'warning' }]);
    expect((await tables.validate(table.body)).valid).toBe(true);
    const d = await dungeon(table.key);
    expect((await w.content.publish(d.key, { expectedRevision: 1 }, 'publisher')).unchanged).toBe(
      false,
    );
  });
});
