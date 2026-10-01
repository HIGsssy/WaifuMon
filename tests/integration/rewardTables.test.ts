/**
 * Database-backed boss and expedition reward tables: the startup seed's
 * insert / update-untouched / preserve-edited rule, the admin service's
 * validation and optimistic concurrency, and export/import.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rewardTables } from '../../src/db/schema';
import type { LoadedContent } from '../../src/modules/content/schemas';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { rewardTableHash, type RewardTableKind } from '../../src/modules/rewardTables/rewardTableCore';
import {
  createRewardTableService,
  type RewardTableService,
} from '../../src/modules/rewardTables/rewardTableService';
import {
  databaseRewardTableSource,
  loadShippedRewardTables,
  seedRewardTables,
  type ShippedRewardTable,
} from '../../src/modules/rewardTables/rewardTableStore';
import {
  RewardTableDeleteRefusedError,
  RewardTableIdTakenError,
  RewardTableInvalidError,
  RewardTableStaleError,
} from '../../src/shared/errors';
import { CONTENT_DIR, bootstrapApp, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let shipped: ShippedRewardTable[];
let service: RewardTableService;

const ADMIN = '111111111111111111';

function shippedTable(kind: RewardTableKind, definition: Record<string, unknown>, position = 0): ShippedRewardTable {
  return { kind, id: String(definition.id), definition, hash: rewardTableHash(kind, definition), position };
}

const simpleBoss = (id: string, buddyXp = 10, extra: Record<string, unknown> = {}) => ({
  id,
  buddyXp,
  groups: [{ id: 'items', entries: [{ itemId: 'basic_charm', weight: 1, quantity: 1 }] }],
  ...extra,
});

async function row(kind: RewardTableKind, id: string) {
  const [r] = await t.db
    .select()
    .from(rewardTables)
    .where(and(eq(rewardTables.kind, kind), eq(rewardTables.tableId, id)));
  return r;
}

/** The real content, plus a boss that pays from `custom-referenced` for the reference rules. */
let content: Pick<LoadedContent, 'items' | 'bosses' | 'expeditions'>;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  await seedEquipmentDefinitions(t.db, { mode: 'insert-missing', catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  shipped = loadShippedRewardTables(CONTENT_DIR);
  content = {
    items: app.content.items,
    bosses: [
      ...app.content.bosses,
      { ...app.content.bosses[0]!, id: 'test-boss', name: 'Test Boss', rewardTable: 'custom-referenced' },
    ],
    expeditions: app.content.expeditions,
  };
  service = createRewardTableService({ db: t.db, getContent: () => content, getShipped: () => shipped });
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await t.db.delete(rewardTables);
  await seedRewardTables(t.db, shipped);
});

describe('loadShippedRewardTables', () => {
  it('reads every shipped boss and expedition table, raw and in file order', () => {
    const bosses = shipped.filter((s) => s.kind === 'boss');
    const expeditions = shipped.filter((s) => s.kind === 'expedition');
    expect(bosses.map((s) => s.id)).toEqual(app.content.bossRewards.map((x) => x.id));
    expect(expeditions.map((s) => s.id)).toEqual(app.content.expeditionRewards.map((x) => x.id));
    expect(expeditions.map((s) => s.position)).toEqual(expeditions.map((_, i) => i));
  });
});

describe('seedRewardTables', () => {
  it('inserts every shipped table once, marked as shipped, and is idempotent', async () => {
    const all = await t.db.select().from(rewardTables);
    expect(all).toHaveLength(shipped.length);
    for (const r of all) expect(r.contentHash).toBe(r.seedHash);
    const again = await seedRewardTables(t.db, shipped);
    expect(again).toMatchObject({ created: [], updated: [], adopted: [], diverged: [] });
    expect(again.unchanged).toBe(shipped.length);
  });

  it('updates an untouched row when the shipped table changes', async () => {
    await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('seeded', 10))]);
    const before = (await row('boss', 'seeded'))!;
    const result = await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('seeded', 25))]);
    expect(result.updated).toEqual(['boss/seeded']);
    const after = (await row('boss', 'seeded'))!;
    expect(after.definition).toMatchObject({ buddyXp: 25 });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.contentHash).toBe(after.seedHash);
    expect(after.updatedBy).toBe('seed');
  });

  it('never overwrites a Portal-edited row, and reports the divergence', async () => {
    await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('seeded', 10))]);
    await service.update('boss', 'seeded', { table: simpleBoss('seeded', 99), expectedRevision: 1 }, ADMIN);

    // Git unchanged: the edit is kept, nothing to warn about beyond the divergence.
    const same = await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('seeded', 10))]);
    expect(same.diverged).toEqual([
      { kind: 'boss', id: 'seeded', shippedChanged: false, updatedBy: ADMIN, revision: 2 },
    ]);

    // Git changed too: still kept, and the seed says the shipped change was not applied.
    const changed = await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('seeded', 40))]);
    expect(changed.updated).toEqual([]);
    expect(changed.diverged[0]).toMatchObject({ shippedChanged: true });
    expect((await row('boss', 'seeded'))!.definition).toMatchObject({ buddyXp: 99 });
  });

  it('adopts an edited row once Git ships the same table (the edit was exported and committed)', async () => {
    await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('seeded', 10))]);
    await service.update('boss', 'seeded', { table: simpleBoss('seeded', 99), expectedRevision: 1 }, ADMIN);
    const result = await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('seeded', 99))]);
    expect(result.adopted).toEqual(['boss/seeded']);
    const r = (await row('boss', 'seeded'))!;
    expect(r.contentHash).toBe(r.seedHash);
    expect(r.revision).toBe(2);
    // …and from then on follows Git again.
    expect((await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('seeded', 7))])).updated).toEqual([
      'boss/seeded',
    ]);
  });

  it('decides on content, not on who saved: saving the shipped table back is not a divergence', async () => {
    await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('seeded', 10))]);
    // An admin saves it unchanged (spelled-out defaults hash the same).
    await service.update(
      'boss',
      'seeded',
      { table: { ...simpleBoss('seeded', 10), enabled: true }, expectedRevision: 1 },
      ADMIN,
    );
    const result = await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('seeded', 12))]);
    expect(result.updated).toEqual(['boss/seeded']);
  });

  it('leaves a Portal-created table alone when Git later ships a different one with that id', async () => {
    await service.create('boss', simpleBoss('later-shipped', 3), ADMIN);
    const result = await seedRewardTables(t.db, [shippedTable('boss', simpleBoss('later-shipped', 4))]);
    expect(result.diverged).toEqual([expect.objectContaining({ id: 'later-shipped', shippedChanged: true })]);
    expect((await row('boss', 'later-shipped'))!.definition).toMatchObject({ buddyXp: 3 });
  });
});

describe('databaseRewardTableSource', () => {
  it('reads the live row, parsed, and nothing for a missing id', async () => {
    const bossId = shipped.find((s) => s.kind === 'boss')!.id;
    const table = await databaseRewardTableSource.bossTable(t.db, bossId);
    expect(table).toEqual(app.content.bossRewards.find((x) => x.id === bossId));
    expect(await databaseRewardTableSource.expeditionTable(t.db, bossId)).toBeUndefined();
    expect(await databaseRewardTableSource.bossTable(t.db, 'missing')).toBeUndefined();
  });
});

describe('RewardTableService — reads', () => {
  it('lists with origin, references and counts', async () => {
    const [boss] = await service.list('boss');
    expect(boss).toMatchObject({ kind: 'boss', origin: 'shipped', matchesShipped: true, revision: 1 });
    expect(boss!.references.length).toBeGreaterThan(0);
    expect(boss!.groupCount).toBe(app.content.bossRewards[0]!.groups.length);
    expect((await service.list('expedition')).length).toBe(app.content.expeditionRewards.length);
  });

  it('gets the stored document and its current issues', async () => {
    const id = shipped.find((s) => s.kind === 'expedition')!.id;
    const detail = (await service.get('expedition', id))!;
    expect(detail.table).toEqual(shipped.find((s) => s.kind === 'expedition' && s.id === id)!.definition);
    expect(detail.issues).toEqual([]);
    expect(await service.get('expedition', 'missing')).toBeNull();
  });
});

describe('RewardTableService — writes', () => {
  const bossId = () => shipped.find((s) => s.kind === 'boss')!.id;

  it('saves a valid edit, bumps the revision and records the actor', async () => {
    const current = (await service.get('boss', bossId()))!;
    const table = { ...current.table, buddyXp: 77 };
    const saved = (await service.update('boss', bossId(), { table, expectedRevision: current.revision }, ADMIN))!;
    expect(saved).toMatchObject({ revision: current.revision + 1, updatedBy: ADMIN, origin: 'edited', matchesShipped: false });
    expect(saved.table).toMatchObject({ buddyXp: 77 });
  });

  it('refuses a stale save with the current revision, and writes nothing', async () => {
    const current = (await service.get('boss', bossId()))!;
    await service.update('boss', bossId(), { table: { ...current.table, buddyXp: 1 }, expectedRevision: 1 }, 'first');
    const stale = service.update('boss', bossId(), { table: { ...current.table, buddyXp: 2 }, expectedRevision: 1 }, 'second');
    await expect(stale).rejects.toBeInstanceOf(RewardTableStaleError);
    await expect(stale).rejects.toMatchObject({ currentRevision: 2, expectedRevision: 1, updatedBy: 'first' });
    expect((await row('boss', bossId()))!.definition).toMatchObject({ buddyXp: 1 });
  });

  it('lets exactly one of two concurrent saves of the same revision win', async () => {
    const current = (await service.get('boss', bossId()))!;
    const results = await Promise.allSettled(
      [5, 6].map((xp) =>
        service.update('boss', bossId(), { table: { ...current.table, buddyXp: xp }, expectedRevision: 1 }, `a${xp}`),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(RewardTableStaleError);
    expect((await row('boss', bossId()))!.revision).toBe(2);
  });

  it('refuses an invalid table with every issue by path, and writes nothing', async () => {
    const current = (await service.get('boss', bossId()))!;
    const groups = [
      { id: 'items', entries: [{ itemId: 'ghost_item', weight: 1, quantity: 1 }] },
      { id: 'gear', entries: [], equipment: [{ slot: 'defense', definitionKeys: ['combat_knife'], weight: 1 }] },
    ];
    const err = await service
      .update('boss', bossId(), { table: { ...current.table, groups }, expectedRevision: 1 }, ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RewardTableInvalidError);
    expect((err as RewardTableInvalidError).issues.map((i) => i.path)).toEqual([
      'groups[0].entries[0].itemId',
      'groups[1].equipment[0].definitionKeys[0]',
    ]);
    expect((await row('boss', bossId()))!.revision).toBe(1);
  });

  it('refuses a selector naming a disabled definition, but lets the row be saved disabled', async () => {
    await app.gear.definitions.setEnabled('combat_knife', false);
    try {
      const current = (await service.get('boss', bossId()))!;
      const gear = (enabled: boolean) => ({
        ...current.table,
        groups: [
          ...(current.table.groups as unknown[]),
          { id: 'gear', entries: [], equipment: [{ definitionKeys: ['combat_knife'], weight: 1, enabled }] },
        ],
      });
      await expect(
        service.update('boss', bossId(), { table: gear(true), expectedRevision: 1 }, ADMIN),
      ).rejects.toBeInstanceOf(RewardTableInvalidError);
      const saved = (await service.update('boss', bossId(), { table: gear(false), expectedRevision: 1 }, ADMIN))!;
      expect(saved.issues).toEqual([expect.objectContaining({ severity: 'warning' })]);
    } finally {
      await app.gear.definitions.setEnabled('combat_knife', true);
    }
  });

  it('keeps the id immutable', async () => {
    const current = (await service.get('boss', bossId()))!;
    await expect(
      service.update('boss', bossId(), { table: { ...current.table, id: 'renamed' }, expectedRevision: 1 }, ADMIN),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ path: 'id' })] });
  });

  it('allows disabling a referenced table, with a warning', async () => {
    const current = (await service.get('boss', bossId()))!;
    const saved = (await service.update(
      'boss',
      bossId(),
      { table: { ...current.table, enabled: false }, expectedRevision: 1 },
      ADMIN,
    ))!;
    expect(saved.enabled).toBe(false);
    expect(saved.issues.some((i) => i.severity === 'warning' && /stop spawning/.test(i.message))).toBe(true);
  });

  it('creates a new table, appended after the shipped ones, and refuses a taken id', async () => {
    const created = await service.create('expedition', { id: 'portal-made', groups: [] }, ADMIN);
    expect(created).toMatchObject({ origin: 'custom', matchesShipped: null, revision: 1 });
    const exported = await service.export('expedition');
    expect(exported.tables.at(-1)).toEqual({ id: 'portal-made', groups: [] });
    await expect(service.create('expedition', { id: 'portal-made', groups: [] }, ADMIN)).rejects.toBeInstanceOf(
      RewardTableIdTakenError,
    );
    await expect(service.create('expedition', { id: 'new', groups: [] }, ADMIN)).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: 'id', message: expect.stringMatching(/reserved/) })],
    });
  });

  it('resets an edited table to shipped, so later deploys update it again', async () => {
    const current = (await service.get('boss', bossId()))!;
    await service.update('boss', bossId(), { table: { ...current.table, buddyXp: 1 }, expectedRevision: 1 }, ADMIN);
    const reset = (await service.resetToShipped('boss', bossId(), 2, ADMIN))!;
    expect(reset).toMatchObject({ origin: 'shipped', matchesShipped: true, revision: 3 });
    await expect(service.resetToShipped('boss', bossId(), 2, ADMIN)).rejects.toBeInstanceOf(RewardTableStaleError);
  });

  it('deletes only an unreferenced table that Git does not ship', async () => {
    await expect(service.delete('boss', bossId(), 1)).rejects.toBeInstanceOf(RewardTableDeleteRefusedError);
    await service.create('boss', simpleBoss('custom-referenced'), ADMIN);
    await expect(service.delete('boss', 'custom-referenced', 1)).rejects.toThrow(/used by boss "test-boss"/);
    await service.create('boss', simpleBoss('scratch'), ADMIN);
    await expect(service.delete('boss', 'scratch', 9)).rejects.toBeInstanceOf(RewardTableStaleError);
    expect(await service.delete('boss', 'scratch', 1)).toBe(true);
    expect(await row('boss', 'scratch')).toBeUndefined();
  });
});

describe('RewardTableService — equipment preview', () => {
  it('lists the eligible definitions from the database, or why there are none', async () => {
    const [ok, bad] = await service.previewEquipment([{ slot: 'attack', rarity: 'R' }, { definitionKeys: ['nope'] }]);
    expect(ok!.issues).toEqual([]);
    expect(ok!.eligible.length).toBeGreaterThan(0);
    expect(ok!.eligible.every((d) => d.slot === 'attack' && d.rarity === 'R')).toBe(true);
    expect(bad!.eligible).toEqual([]);
    expect(bad!.issues[0]!.message).toMatch(/not an equipment definition/);
  });

  it('follows a definition being disabled', async () => {
    const [before] = await service.previewEquipment([{ slot: 'attack', rarity: 'R' }]);
    await app.gear.definitions.setEnabled('combat_knife', false);
    try {
      const [after] = await service.previewEquipment([{ slot: 'attack', rarity: 'R' }]);
      expect(after!.eligible.map((d) => d.key)).toEqual(before!.eligible.map((d) => d.key).filter((k) => k !== 'combat_knife'));
    } finally {
      await app.gear.definitions.setEnabled('combat_knife', true);
    }
  });
});

describe('export and import', () => {
  it('exports the shipped file back exactly when nothing was edited', async () => {
    for (const kind of ['boss', 'expedition'] as const) {
      const exported = await service.export(kind);
      expect(exported.file).toBe(kind === 'boss' ? 'bossRewards.json' : 'expeditionRewards.json');
      expect(exported.tables).toEqual(shipped.filter((s) => s.kind === kind).map((s) => s.definition));
    }
  });

  it('plans create / update / unchanged / invalid, then applies all-or-nothing', async () => {
    const exported = await service.export('boss');
    const edited: Record<string, unknown> = { ...exported.tables[0]!, buddyXp: 5 };
    const pkg = [edited, simpleBoss('imported')];
    const plan = await service.planImport('boss', pkg);
    expect(plan.canApply).toBe(true);
    expect(plan.entries.map((e) => [e.id, e.action, e.currentRevision])).toEqual([
      [edited.id, 'update', 1],
      ['imported', 'create', null],
    ]);
    const expectedRevisions = Object.fromEntries(plan.entries.map((e) => [e.id, e.currentRevision]));
    const applied = await service.applyImport('boss', pkg, expectedRevisions, `import:${ADMIN}`);
    expect(applied).toEqual({ created: ['imported'], updated: [String(edited.id)], unchanged: [] });
    expect((await row('boss', String(edited.id)))!.definition).toMatchObject({ buddyXp: 5 });

    // The same package again is a no-op.
    const replan = await service.planImport('boss', pkg);
    expect(replan.entries.map((e) => e.action)).toEqual(['unchanged', 'unchanged']);
  });

  it('refuses an import whose plan has gone stale, writing nothing', async () => {
    const exported = await service.export('boss');
    const pkg = [{ ...exported.tables[0]!, buddyXp: 5 }, simpleBoss('imported-2')];
    const plan = await service.planImport('boss', pkg);
    const expected = Object.fromEntries(plan.entries.map((e) => [e.id, e.currentRevision]));
    const current = (await service.get('boss', String(exported.tables[0]!.id)))!;
    await service.update('boss', current.id, { table: { ...current.table, buddyXp: 8 }, expectedRevision: 1 }, ADMIN);
    await expect(service.applyImport('boss', pkg, expected, ADMIN)).rejects.toBeInstanceOf(RewardTableStaleError);
    expect(await row('boss', 'imported-2')).toBeUndefined();
  });

  it('refuses an invalid package and reports it per table', async () => {
    const pkg = [simpleBoss('good'), { id: 'bad', buddyXp: 1, groups: [{ id: 'g', entries: [{ itemId: 'nope', weight: 1, quantity: 1 }] }] }, simpleBoss('good')];
    const plan = await service.planImport('boss', pkg);
    expect(plan.canApply).toBe(false);
    expect(plan.entries[1]).toMatchObject({ id: 'bad', action: 'invalid' });
    expect(plan.issues[0]!.message).toMatch(/appears twice/);
    await expect(service.applyImport('boss', pkg, { good: null, bad: null }, ADMIN)).rejects.toBeInstanceOf(
      RewardTableInvalidError,
    );
    expect(await row('boss', 'good')).toBeUndefined();
    expect((await service.planImport('boss', { not: 'an array' })).issues[0]!.path).toBe('tables');
  });
});
