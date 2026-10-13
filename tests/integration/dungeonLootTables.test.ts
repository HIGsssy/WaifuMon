/** T3 catalogue, audit and real PostgreSQL concurrency. No gameplay or shared reward service. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '../../src/db/client';
import {
  dungeonLootTables,
  dungeonLootTableEvents,
  dungeonDefinitions,
  dungeonRevisions,
  rewardTables,
  DUNGEON_LOOT_TABLE_TIERS,
  DUNGEON_LOOT_TABLE_ORIGINS,
  DUNGEON_LOOT_TABLE_EVENT_ACTIONS,
  type DungeonDefinitionRow,
} from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrate';
import {
  createDungeonLootTableService,
  dungeonLootTableContentHash,
  DungeonLootTableInvalidError,
  DungeonLootTableKeyTakenError,
  DungeonLootTableStaleError,
  DungeonLootTableDeleteRefusedError,
  DungeonLootTableNotFoundError,
  type DungeonLootTableService,
} from '../../src/modules/dungeons/dungeonLootTableService';
import {
  DungeonDefinitionSchema,
  type DungeonDefinition,
} from '../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonLootTableBodySchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { dungeonContentHash } from '../../src/modules/dungeons/package/dungeonPackage';
import { canonicalJson } from '../../src/modules/rewardTables/rewardTableCore';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let service: DungeonLootTableService;
beforeAll(async () => {
  t = await createTestDb();
  service = createDungeonLootTableService({ db: t.db });
});
afterAll(async () => {
  await t?.cleanup();
});
let n = 0;
const fresh = (prefix = 'hoard') => `${prefix}_${++n}`;
const body = (quantity = 2) =>
  DungeonLootTableBodySchema.parse({
    guaranteed: [
      {
        id: 'z-charm',
        grant: {
          type: 'item',
          item: 'unresolved_charm',
          quantity: { min: quantity, max: quantity + 1 },
        },
      },
      {
        id: 'a-shards',
        grant: { type: 'currency', currency: 'shards', amount: { min: 10, max: 30 } },
      },
      { id: 'bond', grant: { type: 'affection', amount: { min: 1, max: 3 } } },
    ],
    chances: [
      {
        id: 'maybe-bux',
        chanceBasisPoints: 1250,
        grant: { type: 'currency', currency: 'waifubux', amount: { min: 100, max: 200 } },
      },
    ],
    pools: [
      {
        id: 'gear',
        name: 'Gear or Nothing',
        draws: 2,
        entries: [
          {
            id: 'piece',
            weight: 1,
            grant: {
              type: 'equipment',
              selector: { slot: 'attack', rarity: 'R', definitionKeys: ['unresolved_pipe'] },
            },
          },
          { id: 'none', weight: 3, nothing: true },
        ],
      },
    ],
  });
const create = (key = fresh()) =>
  service.create(
    { key, name: `Hoard ${key}`, description: 'A dungeon-only hoard', tier: 'boss', body: body() },
    'alice',
  );
const refBundle = (table: string) => ({
  guaranteed: [],
  chances: [],
  tables: [{ id: 'table-ref', table, draws: 1 }],
});
const definition = (
  key: string,
  table: string,
  activity: 'combat' | 'boss' | 'reward' | 'legacy' = 'combat',
) =>
  DungeonDefinitionSchema.parse({
    key,
    name: `Dungeon ${key}`,
    entranceRoomId: 'hall',
    rooms: [
      {
        id: 'hall',
        actions:
          activity === 'legacy'
            ? [
                {
                  id: 'treasure',
                  type: 'reward',
                  reward: { rewardTable: table, equipmentRewardTable: table },
                },
              ]
            : activity === 'reward'
              ? [{ id: 'treasure', type: 'reward', rewards: refBundle(table) }]
              : [
                  {
                    id: 'fight',
                    type: activity,
                    waves: [{ enemy: { key: 'unresolved_enemy' } }],
                    rewards: refBundle(table),
                  },
                ],
      },
    ],
  });
async function storeDraft(
  content: DungeonDefinition,
  enabled = true,
): Promise<DungeonDefinitionRow> {
  const [row] = await t.db
    .insert(dungeonDefinitions)
    .values({
      dungeonKey: content.key,
      draft: content,
      draftHash: dungeonContentHash(content),
      enabled,
    })
    .returning();
  return row!;
}
async function storeRevision(
  dungeon: DungeonDefinitionRow,
  content: DungeonDefinition,
  number: number,
  current = true,
) {
  const [row] = await t.db
    .insert(dungeonRevisions)
    .values({
      dungeonKey: dungeon.dungeonKey,
      number,
      content,
      contentHash: dungeonContentHash(content),
      source: 'editor',
      draftRevision: dungeon.draftRevision,
      publishedBy: 'publisher',
    })
    .returning();
  if (current)
    await t.db
      .update(dungeonDefinitions)
      .set({ publishedRevisionId: row!.id })
      .where(eq(dungeonDefinitions.dungeonKey, dungeon.dungeonKey));
  return row!;
}

describe('catalogue authoring and optimistic writes', () => {
  it('creates and reads a typed, revision-1 record with timestamps, actor and canonical body hash', async () => {
    const record = await create();
    expect(record).toMatchObject({
      key: record.key,
      tier: 'boss',
      revision: 1,
      archivedAt: null,
      origin: 'portal',
      createdBy: 'alice',
      updatedBy: 'alice',
      body: body(),
    });
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.updatedAt).toBeInstanceOf(Date);
    expect(record.contentHash).toBe(
      createHash('sha256').update(canonicalJson(body())).digest('hex'),
    );
    expect(await service.get(record.key)).toEqual(record);
    expect(record.body.guaranteed.map((e) => e.id)).toEqual(['z-charm', 'a-shards', 'bond']);
    expect(record.body.pools[0]!.entries.map((e) => e.id)).toEqual(['piece', 'none']);
    expect(await service.history(record.key)).toMatchObject([
      {
        action: 'created',
        actor: 'alice',
        revision: 1,
        previousContentHash: null,
        newContentHash: record.contentHash,
        origin: 'portal',
      },
    ]);
  });
  it('hashes canonical object keys but preserves authored array order', async () => {
    const record = await create();
    const reorderedObject = Object.fromEntries(Object.entries(body()).reverse());
    expect(dungeonLootTableContentHash(reorderedObject as typeof record.body)).toBe(
      record.contentHash,
    );
    const authored = body();
    authored.guaranteed.reverse();
    const changed = await service.update(
      record.key,
      { expectedRevision: 1, body: authored },
      'bob',
    );
    expect(changed.contentHash).not.toBe(record.contentHash);
    expect(changed.body.guaranteed.map((e) => e.id)).toEqual(['bond', 'a-shards', 'z-charm']);
  });
  it('increments revision on metadata-only edits while preserving the body hash and origin', async () => {
    const before = await create();
    const after = await service.update(
      before.key,
      {
        expectedRevision: 1,
        name: 'Renamed',
        description: 'Updated description',
        tier: 'legendary',
      },
      'bob',
    );
    expect(after).toMatchObject({
      revision: 2,
      name: 'Renamed',
      description: 'Updated description',
      tier: 'legendary',
      contentHash: before.contentHash,
      body: before.body,
      origin: 'portal',
      createdBy: 'alice',
      updatedBy: 'bob',
      createdAt: before.createdAt,
    });
    const [event] = await service.history(before.key);
    expect(event).toMatchObject({
      action: 'updated',
      actor: 'bob',
      revision: 2,
      previousContentHash: before.contentHash,
      newContentHash: before.contentHash,
      details: { fields: ['name', 'description', 'tier'] },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });
  it('changes the hash on a body edit and allows a tier to be explicitly cleared', async () => {
    const before = await create();
    const after = await service.update(
      before.key,
      { expectedRevision: 1, body: body(5), tier: null },
      'bob',
    );
    expect(after).toMatchObject({ revision: 2, tier: null, body: body(5) });
    expect(after.contentHash).not.toBe(before.contentHash);
    expect((await service.history(before.key))[0]).toMatchObject({
      previousContentHash: before.contentHash,
      newContentHash: after.contentHash,
    });
  });
  it('rejects stale saves with the current revision and editor, without any write or event', async () => {
    const before = await create();
    const current = await service.update(
      before.key,
      { expectedRevision: 1, name: 'Alice changed it' },
      'alice',
    );
    await expect(
      service.update(before.key, { expectedRevision: 1, name: 'Bob would overwrite it' }, 'bob'),
    ).rejects.toMatchObject({
      code: 'DUNGEON_LOOT_TABLE_STALE',
      expectedRevision: 1,
      currentRevision: 2,
      updatedBy: 'alice',
      updatedAt: current.updatedAt,
    });
    expect(await service.get(before.key)).toEqual(current);
    expect(await service.history(before.key)).toHaveLength(2);
  });
  it('lets exactly one concurrent save of the same revision commit', async () => {
    const before = await create();
    const results = await Promise.allSettled(
      ['alice', 'bob', 'carol'].map((actor) =>
        service.update(before.key, { expectedRevision: 1, name: actor }, actor),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DungeonLootTableStaleError);
    expect((await service.get(before.key))!.revision).toBe(2);
    expect(await service.history(before.key)).toHaveLength(2);
  });
  it('returns a clear key conflict for duplicate and concurrent creation', async () => {
    const key = fresh();
    const results = await Promise.allSettled([create(key), create(key), create(key)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DungeonLootTableKeyTakenError);
    await expect(create(key)).rejects.toBeInstanceOf(DungeonLootTableKeyTakenError);
    expect(await service.history(key)).toHaveLength(1);
  });
  it('answers missing records and rejects writes against missing keys', async () => {
    const key = fresh('missing');
    expect(await service.get(key)).toBeNull();
    expect(await service.history(key)).toEqual([]);
    expect(await service.whereUsed(key)).toEqual({ drafts: [], published: [] });
    for (const operation of [
      () => service.update(key, { expectedRevision: 1, name: 'Name' }, null),
      () => service.archive(key, { expectedRevision: 1 }, null),
      () => service.restore(key, { expectedRevision: 1 }, null),
      () => service.delete(key, { expectedRevision: 1 }, null),
      () => service.duplicate(key, { key: fresh('copy') }, null),
    ])
      await expect(operation()).rejects.toBeInstanceOf(DungeonLootTableNotFoundError);
  });
  it.each([
    ['portal', 'created'],
    ['seed', 'created'],
    ['import', 'imported'],
    ['converted', 'converted'],
  ] as const)('records %s origin with a %s event', async (origin, action) => {
    const record = await service.create(
      { key: fresh(), name: 'Origin test', body: body(), origin },
      null,
    );
    expect(record.origin).toBe(origin);
    expect(await service.history(record.key)).toMatchObject([
      { action, origin, actor: null, revision: 1 },
    ]);
  });
});

describe('archive, restore, selection and retained history', () => {
  it('hides archived tables by default, preserves definitions, and restores with new revisions', async () => {
    const before = await create();
    const archived = await service.archive(before.key, { expectedRevision: 1 }, 'archiver');
    expect(archived).toMatchObject({
      revision: 2,
      contentHash: before.contentHash,
      body: before.body,
    });
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect((await service.list()).map((r) => r.key)).not.toContain(before.key);
    expect((await service.list({ includeArchived: true })).map((r) => r.key)).toContain(before.key);
    expect(await service.get(before.key)).toEqual(archived);
    expect(await service.archive(before.key, { expectedRevision: 2 }, 'again')).toEqual(archived);
    const restored = await service.restore(before.key, { expectedRevision: 2 }, 'restorer');
    expect(restored).toMatchObject({
      archivedAt: null,
      revision: 3,
      contentHash: before.contentHash,
    });
    expect((await service.list()).map((r) => r.key)).toContain(before.key);
    expect(await service.restore(before.key, { expectedRevision: 3 }, 'again')).toEqual(restored);
    expect((await service.history(before.key)).map((e) => e.action)).toEqual([
      'restored',
      'archived',
      'created',
    ]);
    await expect(service.archive(before.key, { expectedRevision: 2 }, null)).rejects.toBeInstanceOf(
      DungeonLootTableStaleError,
    );
  });
  it('filters tiers and literal search strings without treating SQL wildcard characters as search wildcards', async () => {
    const exact = await service.create(
      {
        key: fresh('search'),
        name: 'Literal 100%_hoard',
        description: 'needle',
        tier: 'rare',
        body: body(),
      },
      null,
    );
    await service.create(
      { key: fresh('search'), name: 'Literal 100Xhoard', tier: 'rare', body: body() },
      null,
    );
    expect((await service.list({ tier: 'rare', search: '100%_' })).map((r) => r.key)).toEqual([
      exact.key,
    ]);
    expect((await service.list({ search: 'NEEDLE' })).map((r) => r.key)).toContain(exact.key);
    expect(
      (await service.list({ tier: 'boss', search: 'needle' })).map((r) => r.key),
    ).not.toContain(exact.key);
    const unlabelled = await service.create(
      { key: fresh('no_tier'), name: 'No tier', body: body() },
      null,
    );
    expect((await service.list({ tier: null })).map((r) => r.key)).toContain(unlabelled.key);
  });
  it('requires archive before deletion and rejects stale delete requests', async () => {
    const before = await create();
    await expect(service.delete(before.key, { expectedRevision: 1 }, null)).rejects.toMatchObject({
      reason: 'not_archived',
    });
    expect(await service.get(before.key)).toEqual(before);
    expect(await service.history(before.key)).toHaveLength(1);
    const archived = await service.archive(before.key, { expectedRevision: 1 }, null);
    await expect(service.delete(before.key, { expectedRevision: 1 }, null)).rejects.toBeInstanceOf(
      DungeonLootTableStaleError,
    );
    expect(await service.get(before.key)).toEqual(archived);
  });
  it('deletes archived unreferenced tables, retaining audit history even when the key is reused', async () => {
    const before = await create();
    await service.archive(before.key, { expectedRevision: 1 }, 'archiver');
    expect(await service.delete(before.key, { expectedRevision: 2 }, 'deleter')).toBe(true);
    expect(await service.get(before.key)).toBeNull();
    expect((await service.history(before.key)).map((e) => e.action)).toEqual([
      'deleted',
      'archived',
      'created',
    ]);
    expect((await service.history(before.key))[0]).toMatchObject({
      revision: 2,
      actor: 'deleter',
      previousContentHash: before.contentHash,
      newContentHash: null,
    });
    await create(before.key);
    expect((await service.history(before.key)).map((e) => e.action)).toEqual([
      'created',
      'deleted',
      'archived',
      'created',
    ]);
    expect(await service.history(before.key, 2)).toHaveLength(2);
  });
  it('enforces key immutability and audit append-only behavior in PostgreSQL itself', async () => {
    const before = await create();
    const [event] = await service.history(before.key);
    await expect(
      t.db
        .update(dungeonLootTables)
        .set({ tableKey: fresh('renamed') })
        .where(eq(dungeonLootTables.tableKey, before.key)),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.db
        .update(dungeonLootTableEvents)
        .set({ actor: 'rewriter' })
        .where(eq(dungeonLootTableEvents.id, event!.id)),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.db.delete(dungeonLootTableEvents).where(eq(dungeonLootTableEvents.id, event!.id)),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(t.db.execute(sql`TRUNCATE dungeon_loot_table_events`)).rejects.toMatchObject({
      code: '23514',
    });
    expect(await service.history(before.key)).toEqual([event]);
  });
});

describe('where-used and transitional deletion protection', () => {
  it.each(['combat', 'boss', 'reward'] as const)(
    'finds %s references in enabled and disabled drafts, and permits archive without changing them',
    async (activity) => {
      const table = await create();
      const active = await storeDraft(definition(fresh('active_dungeon'), table.key, activity));
      const disabled = await storeDraft(
        definition(fresh('disabled_dungeon'), table.key, activity),
        false,
      );
      const expected = [active, disabled].sort((a, b) => (a.dungeonKey < b.dungeonKey ? -1 : 1));
      const usage = await service.whereUsed(table.key);
      expect(usage.published).toEqual([]);
      expect(usage.drafts.map((r) => r.dungeonKey)).toEqual(expected.map((r) => r.dungeonKey));
      expect(usage.drafts.find((r) => r.dungeonKey === disabled.dungeonKey)!.enabled).toBe(false);
      await service.archive(table.key, { expectedRevision: 1 }, 'archiver');
      const refusal = await service
        .delete(table.key, { expectedRevision: 2 }, 'deleter')
        .catch((e) => e);
      expect(refusal).toBeInstanceOf(DungeonLootTableDeleteRefusedError);
      expect(refusal.usage).toEqual(usage);
      expect(refusal.userMessage).toContain(active.dungeonKey);
      expect(refusal.userMessage).toContain(disabled.dungeonKey);
      expect(
        await t.db
          .select()
          .from(dungeonDefinitions)
          .where(eq(dungeonDefinitions.dungeonKey, active.dungeonKey)),
      ).toEqual([active]);
      expect(
        await t.db
          .select()
          .from(dungeonDefinitions)
          .where(eq(dungeonDefinitions.dungeonKey, disabled.dungeonKey)),
      ).toEqual([disabled]);
      expect((await service.history(table.key)).map((e) => e.action)).toEqual([
        'archived',
        'created',
      ]);
    },
  );
  it('deduplicates repeated activity references within one draft and ignores legacy expedition references', async () => {
    const table = await create();
    const doc = definition(fresh('multi_dungeon'), table.key);
    doc.rooms[0]!.actions.push({ ...doc.rooms[0]!.actions[0]!, id: 'second' });
    await storeDraft(doc);
    expect((await service.whereUsed(table.key)).drafts).toHaveLength(1);
    const legacyTable = await create();
    await storeDraft(definition(fresh('legacy_dungeon'), legacyTable.key, 'legacy'));
    expect(await service.whereUsed(legacyTable.key)).toEqual({ drafts: [], published: [] });
    await service.archive(legacyTable.key, { expectedRevision: 1 }, null);
    expect(await service.delete(legacyTable.key, { expectedRevision: 2 }, null)).toBe(true);
  });
  it('reports current and superseded published revisions, and blocks both without claiming embedded bodies exist', async () => {
    const historicalTable = await create();
    const currentTable = await create();
    const doc = definition(fresh('published_dungeon'), historicalTable.key, 'boss');
    const dungeon = await storeDraft(doc, false);
    const oldRevision = await storeRevision(dungeon, doc, 1);
    const currentDoc = definition(doc.key, currentTable.key, 'reward');
    const currentRevision = await storeRevision(dungeon, currentDoc, 2);
    // The current draft no longer needs either table. The immutable revisions still do.
    const noRewards = DungeonDefinitionSchema.parse({
      ...currentDoc,
      rooms: [{ id: 'hall', actions: [] }],
    });
    await t.db
      .update(dungeonDefinitions)
      .set({ draft: noRewards, draftHash: dungeonContentHash(noRewards), draftRevision: 2 })
      .where(eq(dungeonDefinitions.dungeonKey, doc.key));
    for (const [table, revision, current] of [
      [historicalTable, oldRevision, false],
      [currentTable, currentRevision, true],
    ] as const) {
      const usage = await service.whereUsed(table.key);
      expect(usage.drafts).toEqual([]);
      expect(usage.published).toMatchObject([
        {
          kind: 'published',
          dungeonKey: doc.key,
          enabled: false,
          revisionId: revision.id,
          revision: revision.number,
          current,
          snapshotStatus: 'not_embedded',
        },
      ]);
      await service.archive(table.key, { expectedRevision: 1 }, null);
      await expect(service.delete(table.key, { expectedRevision: 2 }, null)).rejects.toMatchObject({
        reason: 'in_use',
        usage,
      });
      expect(
        await t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.id, revision.id)),
      ).toEqual([revision]);
    }
  });
  it('fails closed on unreadable persisted documents instead of silently overlooking dependencies', async () => {
    const table = await create();
    const key = fresh('unreadable_dungeon');
    await t.db
      .insert(dungeonDefinitions)
      .values({ dungeonKey: key, draft: { bad: 'not a dungeon' }, draftHash: 'unreadable' });
    try {
      await service.archive(table.key, { expectedRevision: 1 }, null);
      await expect(service.whereUsed(table.key)).rejects.toBeInstanceOf(
        DungeonLootTableInvalidError,
      );
      await expect(service.delete(table.key, { expectedRevision: 2 }, null)).rejects.toBeInstanceOf(
        DungeonLootTableInvalidError,
      );
      expect(await service.get(table.key)).not.toBeNull();
    } finally {
      await t.db.delete(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
    }
  });
  it('waits for a concurrent draft insert, then refuses deletion when that reference commits', async () => {
    const table = await create();
    await service.archive(table.key, { expectedRevision: 1 }, null);
    const client = await t.pool.connect();
    const doc = definition(fresh('concurrent_dungeon'), table.key);
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO dungeon_definitions (dungeon_key,draft,draft_hash) VALUES ($1,$2,$3)',
        [doc.key, JSON.stringify(doc), dungeonContentHash(doc)],
      );
      const deletion = service.delete(table.key, { expectedRevision: 2 }, 'deleter').then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      // Prove it is waiting on a real table lock, not merely unfinished JavaScript.
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        const { rows } = await t.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE dungeon_definitions%' ",
        );
        waiting = rows.length > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      await client.query('COMMIT');
      const result = await deletion;
      expect('error' in result ? result.error : undefined).toBeInstanceOf(
        DungeonLootTableDeleteRefusedError,
      );
      expect(await service.get(table.key)).not.toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('duplication, validation and transactional audit', () => {
  it('duplicates an archived source into an independent active revision-1 record, preserving body IDs', async () => {
    const source = await service.create(
      {
        key: fresh(),
        name: 'Original',
        description: 'Copy this description',
        tier: 'rare',
        body: body(),
        origin: 'import',
      },
      'importer',
    );
    const archived = await service.archive(source.key, { expectedRevision: 1 }, 'archiver');
    const copy = await service.duplicate(source.key, { key: fresh('copy') }, 'copier');
    expect(copy).toMatchObject({
      name: source.name,
      description: source.description,
      tier: source.tier,
      body: source.body,
      contentHash: source.contentHash,
      revision: 1,
      archivedAt: null,
      origin: 'portal',
      createdBy: 'copier',
      updatedBy: 'copier',
    });
    expect(await service.get(source.key)).toEqual(archived);
    expect(await service.history(copy.key)).toMatchObject([
      {
        action: 'duplicated',
        revision: 1,
        actor: 'copier',
        previousContentHash: null,
        newContentHash: copy.contentHash,
        details: {
          sourceKey: source.key,
          sourceRevision: 2,
          sourceContentHash: source.contentHash,
          sourceOrigin: 'import',
        },
      },
    ]);
    const changed = await service.update(
      copy.key,
      { expectedRevision: 1, name: 'Independent copy', body: body(7) },
      'copier',
    );
    expect(changed.contentHash).not.toBe(source.contentHash);
    expect(await service.get(source.key)).toEqual(archived);
    await expect(service.duplicate(source.key, { key: copy.key }, null)).rejects.toBeInstanceOf(
      DungeonLootTableKeyTakenError,
    );
  });
  it('rejects invalid metadata, immutable-key changes, bodies and revisions without any mutation', async () => {
    const key = fresh('invalid');
    const valid = { key, name: 'Valid', body: body() };
    const malformedBodies = [
      {
        ...body(),
        guaranteed: [
          { id: 'bad', grant: { type: 'item', item: 'x', quantity: { min: 2, max: 1 } } },
        ],
      },
      { ...body(), guaranteed: [body().guaranteed[0]!, body().guaranteed[0]!] },
      {
        ...body(),
        pools: [{ ...body().pools[0]!, entries: [{ id: 'bad', weight: 0, nothing: true }] }],
      },
    ];
    for (const input of [
      { ...valid, key: 'Bad-key' },
      { ...valid, key: 'x'.repeat(65) },
      { ...valid, name: ' ' },
      { ...valid, name: 'x'.repeat(101) },
      { ...valid, description: 'x'.repeat(601) },
      { ...valid, tier: 'epic' },
      { ...valid, origin: 'boss' },
      { ...valid, extra: true },
      ...malformedBodies.map((body) => ({ ...valid, body })),
    ])
      await expect(service.create(input as never, null)).rejects.toBeInstanceOf(
        DungeonLootTableInvalidError,
      );
    expect(await service.get(key)).toBeNull();
    expect(await service.history(key)).toEqual([]);
    const record = await create();
    for (const input of [
      { expectedRevision: 1, key: 'renamed' },
      { expectedRevision: 1, origin: 'seed' },
      { expectedRevision: 1 },
      { expectedRevision: 0, name: 'Valid' },
      { expectedRevision: 1.5, name: 'Valid' },
      { expectedRevision: 1, name: '' },
    ])
      await expect(service.update(record.key, input as never, null)).rejects.toBeInstanceOf(
        DungeonLootTableInvalidError,
      );
    await expect(
      service.update(record.key, { expectedRevision: 1, name: 'Valid' }, ' '),
    ).rejects.toBeInstanceOf(DungeonLootTableInvalidError);
    expect(await service.get(record.key)).toEqual(record);
    expect(await service.history(record.key)).toHaveLength(1);
  });
  it('does not validate or grant external item/equipment dependencies in T3', async () => {
    // No item/equipment rows were seeded into this disposable database.
    const record = await create();
    expect(record.body).toEqual(body());
  });
  it('rolls back every catalogue mutation when its event insertion fails', async () => {
    const updated = await create(fresh('atomic_update'));
    const archived = await create(fresh('atomic_archive'));
    const restored = await create(fresh('atomic_restore'));
    const deleted = await create(fresh('atomic_delete'));
    await service.archive(restored.key, { expectedRevision: 1 }, null);
    await service.archive(deleted.key, { expectedRevision: 1 }, null);
    const beforeRows = await t.db
      .select()
      .from(dungeonLootTables)
      .orderBy(dungeonLootTables.tableKey);
    const beforeEvents = await t.db
      .select()
      .from(dungeonLootTableEvents)
      .orderBy(dungeonLootTableEvents.id);
    await t.db.execute(
      sql`CREATE FUNCTION t3_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.table_key LIKE 'atomic_%' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END; $$`,
    );
    await t.db.execute(
      sql`CREATE TRIGGER t3_reject_event BEFORE INSERT ON dungeon_loot_table_events FOR EACH ROW EXECUTE FUNCTION t3_reject_event()`,
    );
    try {
      const attempts = [
        () => create(fresh('atomic_create')),
        () =>
          service.update(updated.key, { expectedRevision: 1, name: 'Must roll back' }, 'writer'),
        () => service.archive(archived.key, { expectedRevision: 1 }, 'writer'),
        () => service.restore(restored.key, { expectedRevision: 2 }, 'writer'),
        () => service.delete(deleted.key, { expectedRevision: 2 }, 'writer'),
        () => service.duplicate(updated.key, { key: fresh('atomic_copy') }, 'writer'),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toThrow('injected audit failure');
        expect(
          await t.db.select().from(dungeonLootTables).orderBy(dungeonLootTables.tableKey),
        ).toEqual(beforeRows);
        expect(
          await t.db.select().from(dungeonLootTableEvents).orderBy(dungeonLootTableEvents.id),
        ).toEqual(beforeEvents);
      }
    } finally {
      await t.db.execute(sql`DROP TRIGGER t3_reject_event ON dungeon_loot_table_events`);
      await t.db.execute(sql`DROP FUNCTION t3_reject_event()`);
    }
  });
  it('leaves the existing expedition and boss catalogue completely untouched', async () => {
    await t.db.insert(rewardTables).values([
      {
        kind: 'expedition',
        tableId: 'shared_expedition',
        enabled: true,
        definition: { legacy: 'expedition' },
        contentHash: 'a'.repeat(64),
      },
      {
        kind: 'boss',
        tableId: 'shared_boss',
        enabled: false,
        definition: { legacy: 'boss' },
        contentHash: 'b'.repeat(64),
      },
    ]);
    const before = await t.db.select().from(rewardTables).orderBy(rewardTables.tableId);
    const table = await create();
    await service.update(table.key, { expectedRevision: 1, body: body(5) }, null);
    await service.duplicate(table.key, { key: fresh('copy') }, null);
    await service.archive(table.key, { expectedRevision: 2 }, null);
    await service.restore(table.key, { expectedRevision: 3 }, null);
    await service.archive(table.key, { expectedRevision: 4 }, null);
    await service.delete(table.key, { expectedRevision: 5 }, null);
    expect(await t.db.select().from(rewardTables).orderBy(rewardTables.tableId)).toEqual(before);
  });
});

describe('migration and Drizzle consistency', () => {
  it('upgrades a real 0061 database without altering existing catalogues, dungeon drafts or immutable revisions', async () => {
    const folder = path.resolve(__dirname, '../../drizzle');
    const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
    // Everything before 0062, whatever has been added after it since.
    const previous = {
      ...journal,
      entries: journal.entries.slice(
        0,
        journal.entries.findIndex((e: { tag: string }) => e.tag === '0062_dungeon_loot_tables'),
      ),
    };
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-t3-before-'));
    fs.mkdirSync(path.join(temporary, 'meta'));
    fs.writeFileSync(path.join(temporary, 'meta/_journal.json'), JSON.stringify(previous));
    for (const entry of previous.entries)
      fs.copyFileSync(
        path.join(folder, `${entry.tag}.sql`),
        path.join(temporary, `${entry.tag}.sql`),
      );
    const databaseName = `waifumon_t3_upgrade_${randomBytes(6).toString('hex')}`;
    const adminUrl = inject('adminDatabaseUrl');
    const admin = new Client({ connectionString: adminUrl });
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    const pool = new Pool({ connectionString: url.toString(), max: 2 });
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const db = createDb(pool);
      await runMigrations(db, t.logger, temporary);
      await db.insert(rewardTables).values([
        {
          kind: 'expedition',
          tableId: 'upgrade_expedition',
          enabled: true,
          definition: { unchanged: 'expedition' },
          contentHash: 'a'.repeat(64),
        },
        {
          kind: 'boss',
          tableId: 'upgrade_boss',
          enabled: false,
          definition: { unchanged: 'boss' },
          contentHash: 'b'.repeat(64),
        },
      ]);
      const legacy = definition('upgrade_dungeon', 'upgrade_expedition', 'legacy');
      await db
        .insert(dungeonDefinitions)
        .values({ dungeonKey: legacy.key, draft: legacy, draftHash: dungeonContentHash(legacy) });
      // Raw SQL: this database predates columns the Drizzle table has since gained (0063).
      await pool.query(
        'INSERT INTO dungeon_revisions (dungeon_key,content,number,content_hash,draft_revision) VALUES ($1,$2,1,$3,1)',
        [legacy.key, JSON.stringify(legacy), dungeonContentHash(legacy)],
      );
      const storedRevisions = async () =>
        (
          await pool.query(
            "SELECT to_jsonb(r) - 'reward_snapshot' - 'gameplay_hash' - 'scene_sprite_snapshot' AS row FROM dungeon_revisions r ORDER BY id",
          )
        ).rows;
      const before = {
        rewards: await db.select().from(rewardTables).orderBy(rewardTables.tableId),
        drafts: await db.select().from(dungeonDefinitions),
        revisions: await storedRevisions(),
      };
      await runMigrations(db, t.logger, folder);
      expect(await db.select().from(rewardTables).orderBy(rewardTables.tableId)).toEqual(
        before.rewards,
      );
      expect(await db.select().from(dungeonDefinitions)).toEqual(before.drafts);
      expect(await storedRevisions()).toEqual(before.revisions);
      expect(await db.select().from(dungeonLootTables)).toEqual([]);
      expect(await db.select().from(dungeonLootTableEvents)).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it('registers the next migration with a timestamp newer than every previous entry, and is repeatable', async () => {
    const journal = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../drizzle/meta/_journal.json'), 'utf8'),
    );
    const at = journal.entries.findIndex((e: { idx: number }) => e.idx === 62);
    const entry = journal.entries[at];
    expect(entry).toMatchObject({ idx: 62, tag: '0062_dungeon_loot_tables' });
    expect(entry.when).toBeGreaterThan(
      Math.max(...journal.entries.slice(0, at).map((e: { when: number }) => e.when)),
    );
    await runMigrations(t.db, t.logger, path.resolve(__dirname, '../../drizzle'));
    const rows = await t.db.execute(
      sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1`,
    );
    expect(Number(rows.rows[0]!.created_at)).toBe(journal.entries.at(-1).when);
  });
  it('matches Drizzle columns, nullability, checks, indexes and append-only/immutable triggers in PostgreSQL', async () => {
    for (const table of [dungeonLootTables, dungeonLootTableEvents]) {
      const config = getTableConfig(table);
      const columns = await t.pool.query(
        'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',
        ['public', config.name],
      );
      expect(
        columns.rows.map((c) => ({
          name: c.column_name,
          type: c.data_type,
          notNull: c.is_nullable === 'NO',
        })),
      ).toEqual(
        config.columns.map((c) => ({ name: c.name, type: c.getSQLType(), notNull: c.notNull })),
      );
      const checks = await t.pool.query(
        "SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c' ORDER BY conname",
        [config.name],
      );
      expect(checks.rows.map((c) => c.conname)).toEqual(config.checks.map((c) => c.name).sort());
      const indexes = await t.pool.query(
        'SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname',
        ['public', config.name],
      );
      expect(indexes.rows.map((i) => i.indexname)).toEqual(
        [...config.indexes.map((i) => i.config.name), `${config.name}_pkey`].sort(),
      );
    }
    const triggers = await t.pool.query(
      "SELECT tgname FROM pg_trigger WHERE tgrelid IN ('dungeon_loot_tables'::regclass,'dungeon_loot_table_events'::regclass) AND NOT tgisinternal ORDER BY tgname",
    );
    expect(triggers.rows.map((r) => r.tgname)).toEqual([
      'dungeon_loot_table_events_append_only',
      'dungeon_loot_table_events_no_truncate',
      'dungeon_loot_tables_immutable_key',
    ]);
    const foreignKeys = await t.pool.query(
      "SELECT conname FROM pg_constraint WHERE conrelid='dungeon_loot_table_events'::regclass AND contype='f'",
    );
    expect(foreignKeys.rows).toEqual([]);
  });
  it('enforces metadata, vocabulary, revision, hash and JSON-object checks directly in the database', async () => {
    const base = {
      tableKey: fresh('db_check'),
      name: 'Name',
      body: body(),
      contentHash: 'a'.repeat(64),
    };
    for (const values of [
      { ...base, tableKey: 'Invalid' },
      { ...base, tableKey: 'x'.repeat(65) },
      { ...base, name: '' },
      { ...base, description: 'x'.repeat(601) },
      { ...base, tier: 'invalid' },
      { ...base, origin: 'invalid' },
      { ...base, revision: 0 },
      { ...base, contentHash: 'bad' },
      { ...base, body: [] },
    ])
      await expect(t.db.insert(dungeonLootTables).values(values as never)).rejects.toMatchObject({
        code: '23514',
      });
    for (const tier of DUNGEON_LOOT_TABLE_TIERS)
      await service.create({ key: fresh('tier'), name: 'Tier', tier, body: body() }, null);
    expect(DUNGEON_LOOT_TABLE_ORIGINS).toEqual(['portal', 'import', 'converted', 'seed']);
    expect(DUNGEON_LOOT_TABLE_EVENT_ACTIONS).toEqual([
      'created',
      'updated',
      'archived',
      'restored',
      'deleted',
      'duplicated',
      'imported',
      'converted',
    ]);
  });
});
