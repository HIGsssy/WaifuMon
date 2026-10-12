/**
 * T6: publication pins reward dependencies in an immutable snapshot and a
 * gameplay hash. Real PostgreSQL: migration, locking, triggers and rollback.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import {
  dungeonContentEvents,
  dungeonDefinitions,
  dungeonLootTables,
  dungeonRevisions,
  dungeonRuns,
  equipmentDefinitions,
  items,
} from '../../src/db/schema';
import type { DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import {
  dungeonGameplayHash,
  dungeonRewardSnapshotHash,
  readDungeonRewardSnapshot,
  type DungeonRewardSnapshot,
} from '../../src/modules/dungeons/content/dungeonRewardSnapshot';
import {
  createDungeonLootTableService,
  dungeonLootTableContentHash,
  DungeonLootTableDeleteRefusedError,
  type DungeonLootTableService,
} from '../../src/modules/dungeons/dungeonLootTableService';
import { dungeonContentHash } from '../../src/modules/dungeons/package/dungeonPackage';
import { equipmentSelectorKey } from '../../src/modules/equipment/rewardSelector';
import { singleRoomDungeon, testDungeon, testDungeonInput } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';

let w: DungeonWorld;
let tables: DungeonLootTableService;
beforeAll(async () => {
  w = await createDungeonWorld();
  tables = createDungeonLootTableService({ db: w.t.db });
});
afterAll(async () => {
  await w?.cleanup();
});

type Actions = NonNullable<DungeonDefinitionInput['rooms'][number]['actions']>;
let n = 0;
const fresh = (prefix: string) => `${prefix}_${++n}`;
const itemBody = (slug: string, quantity = 1) => ({
  guaranteed: [
    { id: 'prize', grant: { type: 'item', item: slug, quantity: { min: quantity, max: quantity } } },
  ],
  chances: [],
  pools: [],
});
const gearBody = (selector: Record<string, unknown>) => ({
  guaranteed: [{ id: 'gear', grant: { type: 'equipment', selector } }],
  chances: [],
  pools: [],
});
const hoard = (table: string): Actions[number] => ({
  id: 'hoard',
  type: 'reward',
  rewards: { guaranteed: [], chances: [], tables: [{ id: 'loot', table, draws: 1 }] },
});
const fight: Actions[number] = { id: 'fight', type: 'combat', waves: [{ enemy: { key: 'grunt' } }] };

async function item(name = 'Prize'): Promise<string> {
  const slug = fresh('snapshot_item');
  await w.t.db.insert(items).values({ slug, name, category: 'material', enabled: true });
  return slug;
}
async function table(body: unknown, name = 'Snapshot hoard') {
  return tables.create({ key: fresh('snapshot_table'), name, body: body as never }, 'author');
}
/** A dungeon whose only reward is one draw from `tableKey`, created and published as revision 1. */
async function published(tableKey: string, actions: (key: string) => Actions = (t) => [hoard(t)]) {
  const key = fresh('snapshot_dungeon');
  const definition = singleRoomDungeon(actions(tableKey), (d) => void (d.key = key));
  await w.content.create({ definition }, 'author');
  const result = await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
  return { key, definition, result };
}
const revisionRows = (key: string) =>
  w.t.db
    .select()
    .from(dungeonRevisions)
    .where(eq(dungeonRevisions.dungeonKey, key))
    .orderBy(asc(dungeonRevisions.number));
const snapshotOf = async (key: string, number: number): Promise<DungeonRewardSnapshot> => {
  const revision = await w.content.revision(key, number);
  if (!revision?.rewardSnapshot) throw new Error(`revision ${number} of ${key} has no snapshot`);
  return revision.rewardSnapshot;
};
/** Wait until some backend is blocked on a lock by a statement matching `like`. */
async function waitForLockWait(like: string): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await w.t.pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1",
      [like],
    );
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe('publication', () => {
  it('pins the reward dependencies on first publication and writes nothing when republished unchanged', async () => {
    const slug = await item('First Prize');
    const loot = await table(itemBody(slug, 2));
    const { key, definition, result } = await published(loot.key);

    const [row] = await revisionRows(key);
    const snapshot = readDungeonRewardSnapshot(row!.rewardSnapshot);
    expect(snapshot).toMatchObject({
      format: 'waifumon-dungeon-reward-snapshot',
      version: 1,
      resolverVersion: 1,
      tables: {
        [loot.key]: {
          key: loot.key,
          name: 'Snapshot hoard',
          tier: null,
          sourceRevision: 1,
          contentHash: loot.contentHash,
          body: loot.body,
        },
      },
      equipmentPools: {},
      items: { [slug]: { name: 'First Prize', category: 'material' } },
    });
    // The content hash still covers the definition alone; the gameplay hash is separate.
    expect(row!.contentHash).toBe(dungeonContentHash(definition));
    expect(row!.gameplayHash).toBe(dungeonGameplayHash(row!.contentHash, snapshot!.hash));
    expect(result).toMatchObject({
      unchanged: false,
      revision: { number: 1, contentHash: row!.contentHash, gameplayHash: row!.gameplayHash },
      dungeon: {
        draftDiffers: false,
        draftGameplayHash: row!.gameplayHash,
        dependenciesDiffer: false,
        dependencyChanges: [],
        published: { number: 1, contentHash: row!.contentHash, gameplayHash: row!.gameplayHash },
      },
    });
    const [event] = await w.t.db
      .select()
      .from(dungeonContentEvents)
      .where(and(eq(dungeonContentEvents.dungeonKey, key), eq(dungeonContentEvents.action, 'published')));
    expect(event!.details).toMatchObject({
      contentHash: row!.contentHash,
      gameplayHash: row!.gameplayHash,
      rewardSnapshotHash: snapshot!.hash,
    });

    const again = await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
    expect(again).toMatchObject({ unchanged: true, revision: { number: 1 } });
    expect(await revisionRows(key)).toEqual([row]);
  });

  it('writes a new revision when a referenced table body changes though the definition has not', async () => {
    const slug = await item();
    const loot = await table(itemBody(slug, 1));
    const { key } = await published(loot.key);
    const [first] = await revisionRows(key);

    const edited = await tables.update(loot.key, { expectedRevision: 1, body: itemBody(slug, 5) as never }, 'author');
    const expected = {
      draftDiffers: false,
      dependenciesDiffer: true,
      dependencyChanges: [
        {
          kind: 'table',
          tableKey: loot.key,
          name: 'Snapshot hoard',
          status: 'changed',
          publishedHash: loot.contentHash,
          currentHash: edited.contentHash,
        },
      ],
    };
    const detail = (await w.content.get(key))!;
    expect(detail).toMatchObject(expected);
    expect(detail.draftGameplayHash).not.toBe(first!.gameplayHash);
    expect((await w.content.list()).find((d) => d.key === key)).toMatchObject(expected);

    const result = await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
    expect(result).toMatchObject({
      unchanged: false,
      revision: { number: 2, current: true, contentHash: first!.contentHash, gameplayHash: detail.draftGameplayHash },
      dungeon: { draftDiffers: false, dependenciesDiffer: false, dependencyChanges: [] },
    });
    const rows = await revisionRows(key);
    expect(rows).toHaveLength(2);
    // Revision 1 is exactly as it was written.
    expect(rows[0]).toEqual(first);
    expect(rows[1]).toMatchObject({ contentHash: first!.contentHash, content: first!.content, draftRevision: 1 });
    expect((await snapshotOf(key, 1)).tables[loot.key]!.body).toEqual(loot.body);
    expect((await snapshotOf(key, 2)).tables[loot.key]).toMatchObject({ body: edited.body, sourceRevision: 2 });
    expect((await w.content.publish(key, { expectedRevision: 1 }, 'publisher')).unchanged).toBe(true);
  });

  it('does not write a revision for metadata-only changes to a table, an item or a piece of gear', async () => {
    const slug = await item('Old Name');
    const [gear] = await w.t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.rarity, 'R')).limit(1);
    const loot = await table({
      ...itemBody(slug),
      chances: [{ id: 'gear', chanceBasisPoints: 100, grant: { type: 'equipment', selector: { definitionKeys: [gear!.key] } } }],
    });
    const { key } = await published(loot.key);
    const [first] = await revisionRows(key);
    try {
      const renamed = await tables.update(
        loot.key,
        { expectedRevision: 1, name: 'Renamed hoard', description: 'Now described.', tier: 'boss' },
        'author',
      );
      expect(renamed).toMatchObject({ revision: 2, contentHash: loot.contentHash });
      await w.t.db.update(items).set({ name: 'New Name' }).where(eq(items.slug, slug));
      await w.t.db.update(equipmentDefinitions).set({ name: `${gear!.name} (renamed)` }).where(eq(equipmentDefinitions.id, gear!.id));

      expect(await w.content.get(key)).toMatchObject({
        draftDiffers: false,
        dependenciesDiffer: false,
        dependencyChanges: [],
        draftGameplayHash: first!.gameplayHash,
      });
      expect(await w.content.publish(key, { expectedRevision: 1 }, 'publisher')).toMatchObject({
        unchanged: true,
        revision: { number: 1 },
      });
      expect(await revisionRows(key)).toEqual([first]);
      // The pinned snapshot keeps the display metadata it was published with.
      const pinned = await snapshotOf(key, 1);
      const selectorKey = equipmentSelectorKey({ definitionKeys: [gear!.key] });
      expect(pinned.tables[loot.key]).toMatchObject({ name: 'Snapshot hoard', tier: null, sourceRevision: 1 });
      expect(pinned.items[slug]).toEqual({ name: 'Old Name', category: 'material' });
      expect(pinned.equipmentPools[selectorKey]).toMatchObject([{ key: gear!.key, name: gear!.name }]);

      // A later gameplay change publishes revision 2 with today's metadata; revision 1 is not retouched.
      await tables.update(loot.key, { expectedRevision: 2, body: { ...loot.body, guaranteed: itemBody(slug, 2).guaranteed } as never }, 'author');
      const second = await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
      expect(second).toMatchObject({ unchanged: false, revision: { number: 2 } });
      const current = await snapshotOf(key, 2);
      expect(current.tables[loot.key]).toMatchObject({ name: 'Renamed hoard', tier: 'boss', sourceRevision: 3 });
      expect(current.items[slug]).toEqual({ name: 'New Name', category: 'material' });
      expect(current.equipmentPools[selectorKey]).toMatchObject([{ key: gear!.key, name: `${gear!.name} (renamed)` }]);
      expect(await snapshotOf(key, 1)).toEqual(pinned);
      expect((await revisionRows(key))[0]).toEqual(first);
    } finally {
      await w.t.db.update(equipmentDefinitions).set({ name: gear!.name }).where(eq(equipmentDefinitions.id, gear!.id));
    }
  });

  it('writes a new gameplay hash when equipment eligibility changes, freezing identities only', async () => {
    const selector = { slot: 'attack', rarity: 'N' };
    const selectorKey = equipmentSelectorKey(selector as never);
    const eligible = await w.t.db
      .select()
      .from(equipmentDefinitions)
      .where(and(eq(equipmentDefinitions.slot, 'attack'), eq(equipmentDefinitions.rarity, 'N'), eq(equipmentDefinitions.enabled, true)))
      .orderBy(asc(equipmentDefinitions.key));
    expect(eligible.length).toBeGreaterThanOrEqual(2);
    const dropped = eligible[0]!;
    const loot = await table(gearBody(selector));
    const { key } = await published(loot.key);
    const [first] = await revisionRows(key);
    const pinned = (await snapshotOf(key, 1)).equipmentPools[selectorKey]!;
    expect(pinned.map((c) => c.key)).toEqual(eligible.map((d) => d.key));
    // Identities, not roll inputs: no multiplier range, affix or bonus data is frozen.
    expect(Object.keys(pinned[0]!).sort()).toEqual(['key', 'name', 'rarity', 'slot']);

    try {
      await w.t.db.update(equipmentDefinitions).set({ enabled: false }).where(eq(equipmentDefinitions.id, dropped.id));
      const detail = (await w.content.get(key))!;
      expect(detail).toMatchObject({
        draftDiffers: false,
        dependenciesDiffer: true,
        dependencyChanges: [
          { kind: 'equipment', selectorKey, status: 'changed', added: [], removed: [dropped.key] },
        ],
      });
      const second = await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
      expect(second).toMatchObject({ unchanged: false, revision: { number: 2, contentHash: first!.contentHash } });
      expect(second.revision.gameplayHash).not.toBe(first!.gameplayHash);
      expect((await snapshotOf(key, 2)).equipmentPools[selectorKey]!.map((c) => c.key)).toEqual(
        eligible.slice(1).map((d) => d.key),
      );
      // The earlier revision still pays what it promised.
      expect((await snapshotOf(key, 1)).equipmentPools[selectorKey]).toEqual(pinned);
    } finally {
      await w.t.db.update(equipmentDefinitions).set({ enabled: true }).where(eq(equipmentDefinitions.id, dropped.id));
    }
    expect(await w.content.get(key)).toMatchObject({
      dependenciesDiffer: true,
      dependencyChanges: [{ kind: 'equipment', status: 'changed', added: [dropped.key], removed: [] }],
    });
    // Eligible again as first published: revision 3 carries revision 1's gameplay hash, as a new immutable row.
    const third = await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
    expect(third).toMatchObject({ unchanged: false, revision: { number: 3, gameplayHash: first!.gameplayHash } });
  });

  it('refuses to publish, and writes nothing, while a referenced table is archived or missing', async () => {
    const loot = await table(itemBody(await item()));
    const { key } = await published(loot.key);
    const before = await revisionRows(key);
    await tables.archive(loot.key, { expectedRevision: 1 }, 'author');
    expect(await w.content.get(key)).toMatchObject({
      draftGameplayHash: null,
      dependenciesDiffer: true,
      dependencyChanges: [
        { kind: 'table', tableKey: loot.key, status: 'archived', publishedHash: loot.contentHash, currentHash: loot.contentHash },
      ],
    });
    await expect(w.content.publish(key, { expectedRevision: 1 }, 'publisher')).rejects.toMatchObject({
      code: 'DUNGEON_INVALID',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'reward_table_archived' })]),
    });
    expect(await revisionRows(key)).toEqual(before);
    // The published revision is still what new runs get.
    expect(await w.content.published(w.t.db, key)).toMatchObject({ revision: { number: 1 }, rewards: { hash: expect.any(String) } });

    const ghost = fresh('snapshot_dungeon');
    await w.content.create({ definition: singleRoomDungeon([hoard('never_created_table')], (d) => void (d.key = ghost)) }, 'author');
    const expected = {
      published: null,
      draftGameplayHash: null,
      dependenciesDiffer: false,
      dependencyChanges: [
        { kind: 'table', tableKey: 'never_created_table', name: 'never_created_table', status: 'missing', publishedHash: null, currentHash: null },
      ],
    };
    expect(await w.content.get(ghost)).toMatchObject(expected);
    expect((await w.content.list()).find((d) => d.key === ghost)).toMatchObject(expected);
  });
});

describe('legacy-only dungeons', () => {
  it('publish with no snapshot, no gameplay hash and the content-hash comparison they always had', async () => {
    const key = fresh('legacy_dungeon');
    const created = await w.content.create({ definition: testDungeonInput(key) }, 'author');
    expect(created).toMatchObject({ draftGameplayHash: null, dependenciesDiffer: false, dependencyChanges: [] });
    const first = await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
    const [row] = await revisionRows(key);
    expect(row).toMatchObject({
      rewardSnapshot: null,
      gameplayHash: null,
      contentHash: dungeonContentHash(testDungeon(key)),
    });
    expect(first).toMatchObject({
      unchanged: false,
      revision: { number: 1, gameplayHash: null },
      dungeon: { draftDiffers: false, draftGameplayHash: null, dependenciesDiffer: false, dependencyChanges: [], published: { gameplayHash: null } },
    });
    const [event] = await w.t.db
      .select()
      .from(dungeonContentEvents)
      .where(and(eq(dungeonContentEvents.dungeonKey, key), eq(dungeonContentEvents.action, 'published')));
    expect(Object.keys(event!.details).sort()).toEqual(
      ['contentHash', 'draftRevision', 'previousRevision', 'revision', 'revisionId', 'warnings'].sort(),
    );

    // Churn in the dungeon loot catalogue is nothing to a dungeon that names none of it.
    await table(itemBody(await item()));
    expect(await w.content.publish(key, { expectedRevision: 1 }, 'publisher')).toMatchObject({ unchanged: true, revision: { number: 1 } });
    expect((await w.content.list()).find((d) => d.key === key)).toMatchObject({ dependenciesDiffer: false, dependencyChanges: [] });
    expect(await w.content.revisionById(w.t.db, row!.id)).toMatchObject({ rewards: null, revision: { id: row!.id } });
    expect((await w.content.revision(key, 1))!.rewardSnapshot).toBeNull();

    // A definition change still makes revision 2, compared by content hash alone; rollback is as before.
    const next = testDungeonInput(key);
    next.description = 'Changed.';
    const second = await w.republish(next);
    expect(second).toMatchObject({ unchanged: false, revision: { number: 2, gameplayHash: null } });
    expect(await w.content.rollback(key, { revision: 1 }, 'publisher')).toMatchObject({
      unchanged: false,
      revision: { number: 1, current: true, contentHash: row!.contentHash },
    });
    expect((await revisionRows(key))[0]).toEqual(row);
  });
});

describe('immutability of what was published', () => {
  it('keeps historical snapshots through edits, archiving and deletion of the table', async () => {
    const slug = await item();
    const loot = await table(itemBody(slug, 1));
    const { key, definition } = await published(loot.key);
    const edited = await tables.update(loot.key, { expectedRevision: 1, body: itemBody(slug, 7) as never }, 'author');
    await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
    const before = await revisionRows(key);
    expect(before.map((r) => r.number)).toEqual([1, 2]);

    // The draft still names the table: deletion stays blocked whatever the revisions embed.
    const archived = await tables.archive(loot.key, { expectedRevision: 2 }, 'author');
    const usage = await tables.whereUsed(loot.key);
    expect(usage.drafts).toMatchObject([{ dungeonKey: key }]);
    expect(usage.published).toMatchObject([
      { revision: 1, current: false, snapshotStatus: 'embedded' },
      { revision: 2, current: true, snapshotStatus: 'embedded' },
    ]);
    await expect(tables.delete(loot.key, { expectedRevision: archived.revision }, 'author')).rejects.toMatchObject({
      reason: 'in_use',
    });
    expect(await revisionRows(key)).toEqual(before);

    // Once no draft needs it, complete embedded snapshots let it go.
    await w.content.saveDraft(key, { definition: { ...definition, rooms: [{ id: 'hall', name: 'Hall', actions: [fight] }, definition.rooms[1]!] }, expectedRevision: 1 }, 'author');
    expect(await tables.delete(loot.key, { expectedRevision: archived.revision }, 'author')).toBe(true);
    expect(await tables.get(loot.key)).toBeNull();

    expect(await revisionRows(key)).toEqual(before);
    expect((await snapshotOf(key, 1)).tables[loot.key]!.body).toEqual(loot.body);
    expect((await snapshotOf(key, 2)).tables[loot.key]!.body).toEqual(edited.body);
    for (const row of before) {
      const snapshot = readDungeonRewardSnapshot(row.rewardSnapshot)!;
      expect(snapshot.hash).toBe(dungeonRewardSnapshotHash(snapshot));
      expect(row.gameplayHash).toBe(dungeonGameplayHash(row.contentHash, snapshot.hash));
    }
    // New runs of the published revision still have their loot.
    expect(await w.content.published(w.t.db, key)).toMatchObject({
      revision: { number: 2 },
      rewards: { tables: { [loot.key]: { body: edited.body } } },
    });
  });

  it('still refuses to delete a table a revision without an embedded snapshot depends on', async () => {
    const loot = await table(itemBody(await item()));
    const key = fresh('snapshot_dungeon');
    const definition = singleRoomDungeon([hoard(loot.key)], (d) => void (d.key = key));
    const plain = singleRoomDungeon([fight], (d) => void (d.key = key));
    // As published before reward snapshots existed: v2 rewards, nothing pinned.
    await w.t.db.insert(dungeonDefinitions).values({ dungeonKey: key, draft: plain, draftHash: dungeonContentHash(plain) });
    await w.t.db.insert(dungeonRevisions).values({ dungeonKey: key, number: 1, content: definition, contentHash: dungeonContentHash(definition), draftRevision: 1 });
    await tables.archive(loot.key, { expectedRevision: 1 }, 'author');
    expect((await tables.whereUsed(loot.key)).published).toMatchObject([{ dungeonKey: key, snapshotStatus: 'not_embedded' }]);
    await expect(tables.delete(loot.key, { expectedRevision: 2 }, 'author')).rejects.toBeInstanceOf(DungeonLootTableDeleteRefusedError);
    expect(await tables.get(loot.key)).not.toBeNull();
  });

  it('keeps an active run on the revision and snapshot it started with', async () => {
    const slug = await item();
    const loot = await table(itemBody(slug, 1));
    const { key, result } = await published(loot.key, (t) => [fight, hoard(t)]);
    const original = await snapshotOf(key, 1);
    const early = await w.player();
    const run = await w.runs.start(early.playerId, key);

    await tables.update(loot.key, { expectedRevision: 1, body: itemBody(slug, 9) as never }, 'author');
    const second = await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
    expect(second.revision).toMatchObject({ number: 2, activeRuns: 0 });
    await tables.archive(loot.key, { expectedRevision: 2 }, 'author');

    const [stored] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, run.id));
    expect(stored!.revisionId).toBe(result.revision.revisionId);
    expect(await w.content.revisionById(w.t.db, stored!.revisionId)).toMatchObject({ revision: { number: 1 }, rewards: original });
    expect(await w.runs.run(early.playerId, run.id)).toMatchObject({ status: 'active', dungeon: { revision: 1 }, core: { action: { id: 'fight' } } });

    const late = await w.player();
    const fresher = await w.runs.start(late.playerId, key);
    const [laterStored] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, fresher.id));
    expect((await w.content.revisionById(w.t.db, laterStored!.revisionId))!.rewards!.tables[loot.key]!.body).toEqual(itemBody(slug, 9));
    expect((await w.content.revisions(key))!.map((r) => [r.number, r.current, r.activeRuns])).toEqual([[2, true, 1], [1, false, 1]]);
  });

  it('is enforced by the database: a revision row and its snapshot cannot be updated or deleted', async () => {
    const { key } = await published((await table(itemBody(await item()))).key);
    const [row] = await revisionRows(key);
    for (const statement of [
      sql`update dungeon_revisions set reward_snapshot = '{}'::jsonb where id = ${row!.id}`,
      sql`update dungeon_revisions set reward_snapshot = null, gameplay_hash = null where id = ${row!.id}`,
      sql`update dungeon_revisions set gameplay_hash = ${`sha256:${'0'.repeat(64)}`} where id = ${row!.id}`,
      sql`update dungeon_revisions set content_hash = 'x' where id = ${row!.id}`,
      sql`delete from dungeon_revisions where id = ${row!.id}`,
    ]) {
      await expect(w.t.db.execute(statement)).rejects.toMatchObject({ message: expect.stringContaining('immutable') });
    }
    expect(await revisionRows(key)).toEqual([row]);
    // A snapshot and its hash are written together or not at all, in the stored format.
    const insert = (snapshot: string | null, hash: string | null) =>
      w.t.pool.query(
        'INSERT INTO dungeon_revisions (dungeon_key,number,content,content_hash,draft_revision,reward_snapshot,gameplay_hash) VALUES ($1,99,$2,$3,1,$4,$5)',
        [key, JSON.stringify(row!.content), row!.contentHash, snapshot, hash],
      );
    await expect(insert('{}', null)).rejects.toMatchObject({ constraint: 'dungeon_revisions_reward_snapshot_check' });
    await expect(insert(null, row!.gameplayHash)).rejects.toMatchObject({ constraint: 'dungeon_revisions_reward_snapshot_check' });
    await expect(insert('[]', row!.gameplayHash)).rejects.toMatchObject({ constraint: 'dungeon_revisions_reward_snapshot_check' });
    await expect(insert('{}', 'not-a-hash')).rejects.toMatchObject({ constraint: 'dungeon_revisions_gameplay_hash_check' });
  });
});

describe('rollback', () => {
  it("brings back the target revision's own snapshot, never one rebuilt from today's catalogue", async () => {
    const slug = await item();
    const loot = await table(itemBody(slug, 1));
    const { key, definition } = await published(loot.key);
    await tables.update(loot.key, { expectedRevision: 1, body: itemBody(slug, 4) as never }, 'author');
    await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
    // The live table moves on again, then disappears altogether.
    await tables.update(loot.key, { expectedRevision: 2, body: itemBody(slug, 8) as never }, 'author');
    await w.content.saveDraft(key, { definition: { ...definition, rooms: [{ id: 'hall', name: 'Hall', actions: [fight] }, definition.rooms[1]!] }, expectedRevision: 1 }, 'author');
    await tables.archive(loot.key, { expectedRevision: 3 }, 'author');
    await tables.delete(loot.key, { expectedRevision: 4 }, 'author');
    const before = await revisionRows(key);

    const rolled = await w.content.rollback(key, { revision: 1 }, 'publisher');
    expect(rolled).toMatchObject({
      unchanged: false,
      revision: { number: 1, current: true, gameplayHash: before[0]!.gameplayHash },
      dungeon: { published: { number: 1, gameplayHash: before[0]!.gameplayHash } },
    });
    expect(await revisionRows(key)).toEqual(before);
    const live = await w.content.published(w.t.db, key);
    expect(live).toMatchObject({ revision: { number: 1 }, rewards: { tables: { [loot.key]: { body: loot.body, sourceRevision: 1 } } } });
    const [event] = await w.t.db
      .select()
      .from(dungeonContentEvents)
      .where(and(eq(dungeonContentEvents.dungeonKey, key), eq(dungeonContentEvents.action, 'rolled_back')));
    expect(event!.details).toMatchObject({ revision: 1, gameplayHash: before[0]!.gameplayHash });
    // And forward again, to the other pinned body.
    await w.content.rollback(key, { revision: 2 }, 'publisher');
    expect(await w.content.published(w.t.db, key)).toMatchObject({ rewards: { tables: { [loot.key]: { body: itemBody(slug, 4) } } } });
    expect(await revisionRows(key)).toEqual(before);
  });

  it('refuses while a pinned item or piece of gear can no longer be paid, and moves nothing', async () => {
    const slug = await item('Fragile Prize');
    const [template] = await w.t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.rarity, 'R')).limit(1);
    const { id: _id, ...copy } = template!;
    const gearKey = fresh('snapshot_gear');
    await w.t.db.insert(equipmentDefinitions).values({ ...copy, key: gearKey, name: 'Fragile Gear' });
    const loot = await table({
      ...itemBody(slug),
      chances: [{ id: 'gear', chanceBasisPoints: 100, grant: { type: 'equipment', selector: { definitionKeys: [gearKey] } } }],
    });
    const { key, definition } = await published(loot.key);
    await w.republish({ ...definition, rooms: [{ id: 'hall', name: 'Hall', actions: [fight] }, definition.rooms[1]!] });
    const state = async () => ({
      revisions: await revisionRows(key),
      pointer: (await w.t.db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key)))[0]!.publishedRevisionId,
      events: await w.t.db.select().from(dungeonContentEvents).where(eq(dungeonContentEvents.dungeonKey, key)),
    });
    const before = await state();
    const refused = async (code: string) => {
      await expect(w.content.rollback(key, { revision: 1 }, 'publisher')).rejects.toMatchObject({
        code: 'DUNGEON_INVALID',
        issues: expect.arrayContaining([expect.objectContaining({ code, severity: 'error' })]),
      });
      expect(await state()).toEqual(before);
    };

    await w.t.db.update(items).set({ maxOwned: 1 }).where(eq(items.slug, slug));
    await refused('reward_item_capped');
    await w.t.db.update(items).set({ maxOwned: null }).where(eq(items.slug, slug));

    await w.t.db.delete(items).where(eq(items.slug, slug));
    await refused('reward_item_missing');
    await w.t.db.insert(items).values({ slug, name: 'Fragile Prize', category: 'material', enabled: true });

    await w.t.db.delete(equipmentDefinitions).where(eq(equipmentDefinitions.key, gearKey));
    await refused('reward_equipment_missing');
    await w.t.db.insert(equipmentDefinitions).values({ ...copy, key: gearKey, name: 'Fragile Gear', enabled: false });

    // Whole again. Disabled gear and an edited table are no obstacle: the promise was pinned.
    await tables.update(loot.key, { expectedRevision: 1, body: itemBody(slug, 3) as never }, 'author');
    const rolled = await w.content.rollback(key, { revision: 1 }, 'publisher');
    expect(rolled).toMatchObject({ unchanged: false, revision: { number: 1, current: true } });
    expect((await w.content.published(w.t.db, key) as { rewards: DungeonRewardSnapshot }).rewards.tables[loot.key]!.body).toEqual(loot.body);
  });

  it('refuses a revision whose v2 rewards were never pinned or whose snapshot was not what was hashed', async () => {
    const loot = await table(itemBody(await item()));
    const { key, definition } = await published(loot.key);
    const [first] = await revisionRows(key);
    const snapshot = readDungeonRewardSnapshot(first!.rewardSnapshot)!;
    const forged = { ...snapshot, tables: { [loot.key]: { ...snapshot.tables[loot.key]!, body: itemBody('forged_item', 99) } } };
    await w.t.db.insert(dungeonRevisions).values([
      { dungeonKey: key, number: 2, content: definition, contentHash: first!.contentHash, draftRevision: 1 },
      { dungeonKey: key, number: 3, content: definition, contentHash: first!.contentHash, draftRevision: 1, rewardSnapshot: forged, gameplayHash: first!.gameplayHash },
    ]);
    await w.republish({ ...definition, rooms: [{ id: 'hall', name: 'Hall', actions: [fight] }, definition.rooms[1]!] });
    for (const revision of [2, 3]) {
      await expect(w.content.rollback(key, { revision }, 'publisher')).rejects.toMatchObject({
        code: 'DUNGEON_INVALID',
        issues: expect.arrayContaining([expect.objectContaining({ code: 'reward_snapshot_missing' })]),
      });
    }
    expect((await w.content.get(key))!.published).toMatchObject({ number: 4 });
    expect((await w.content.rollback(key, { revision: 1 }, 'publisher')).revision).toMatchObject({ number: 1, current: true });
  });
});

describe('concurrent catalogue changes', () => {
  it('waits for an in-flight table edit and pins the body that committed', async () => {
    const slug = await item();
    const loot = await table(itemBody(slug, 1));
    const key = fresh('snapshot_dungeon');
    await w.content.create({ definition: singleRoomDungeon([hoard(loot.key)], (d) => void (d.key = key)) }, 'author');
    const next = itemBody(slug, 6);
    const client = await w.t.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE dungeon_loot_tables SET body = $1, content_hash = $2, revision = revision + 1 WHERE table_key = $3',
        [JSON.stringify(next), dungeonLootTableContentHash(next as never), loot.key],
      );
      const publishing = w.content.publish(key, { expectedRevision: 1 }, 'publisher');
      expect(await waitForLockWait('%dungeon_loot_tables%for share%')).toBe(true);
      await client.query('COMMIT');
      const result = await publishing;
      expect(result).toMatchObject({ unchanged: false, dungeon: { dependenciesDiffer: false, dependencyChanges: [] } });
      expect((await snapshotOf(key, 1)).tables[loot.key]).toMatchObject({
        body: next,
        sourceRevision: 2,
        contentHash: dungeonLootTableContentHash(next as never),
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('holds the validated catalogue rows until the revision commits, so the snapshot is what was validated', async () => {
    const slug = await item();
    const selector = { slot: 'defense', rarity: 'N' };
    const withGear = (quantity: number) => ({
      ...itemBody(slug, quantity),
      chances: [{ id: 'gear', chanceBasisPoints: 100, grant: { type: 'equipment', selector } }],
    });
    const loot = await table(withGear(1));
    const key = fresh('snapshot_dungeon');
    await w.content.create({ definition: singleRoomDungeon([hoard(loot.key)], (d) => void (d.key = key)) }, 'author');
    const [gear] = await w.t.db
      .select()
      .from(equipmentDefinitions)
      .where(and(eq(equipmentDefinitions.slot, 'defense'), eq(equipmentDefinitions.rarity, 'N'), eq(equipmentDefinitions.enabled, true)))
      .limit(1);

    let entered!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => void (entered = resolve));
    const gate = new Promise<void>((resolve) => void (release = resolve));
    const original = w.enemies.definitions.bind(w.enemies);
    // Publication reads enemies after it has locked and read its reward dependencies.
    const spy = vi.spyOn(w.enemies, 'definitions').mockImplementationOnce(async (tx) => {
      entered();
      await gate;
      return original(tx);
    });
    const publishing = w.content.publish(key, { expectedRevision: 1 }, 'publisher');
    let editing: Promise<unknown> | undefined;
    let disabling: Promise<unknown> | undefined;
    try {
      await Promise.race([holding, publishing.then(() => Promise.reject(new Error('publication did not pause')))]);
      editing = tables.update(loot.key, { expectedRevision: 1, body: withGear(6) as never }, 'author');
      expect(await waitForLockWait('%dungeon_loot_tables%for update%')).toBe(true);
      // A Drizzle builder runs each time it is awaited: take one real promise from it.
      disabling = w.t.db.update(equipmentDefinitions).set({ enabled: false }).where(eq(equipmentDefinitions.id, gear!.id)).then(() => undefined);
      expect(await waitForLockWait('update "equipment_definitions"%')).toBe(true);
    } finally {
      release();
      spy.mockRestore();
    }
    try {
      const result = await publishing;
      await editing;
      await disabling;
      // The revision holds the catalogue as publication validated it, not the edits that were queued behind it.
      const pinned = await snapshotOf(key, 1);
      expect(pinned.tables[loot.key]).toMatchObject({ body: loot.body, sourceRevision: 1 });
      expect(pinned.equipmentPools[equipmentSelectorKey(selector as never)]!.map((c) => c.key)).toContain(gear!.key);
      expect(result.revision.gameplayHash).toBe(dungeonGameplayHash(result.revision.contentHash, pinned.hash));
      // Both edits landed afterwards and are reported against it.
      expect((await w.content.get(key))!.dependencyChanges).toEqual([
        expect.objectContaining({ kind: 'table', tableKey: loot.key, status: 'changed' }),
        expect.objectContaining({ kind: 'equipment', status: 'changed', removed: [gear!.key] }),
      ]);
    } finally {
      await w.t.db.update(equipmentDefinitions).set({ enabled: true }).where(eq(equipmentDefinitions.id, gear!.id));
    }
  });

  it('gives two publishers racing on one dungeon a single revision', async () => {
    const loot = await table(itemBody(await item()));
    const key = fresh('snapshot_dungeon');
    await w.content.create({ definition: singleRoomDungeon([hoard(loot.key)], (d) => void (d.key = key)) }, 'author');
    const results = await Promise.all([1, 2, 3].map(() => w.content.publish(key, { expectedRevision: 1 }, 'publisher')));
    expect(results.map((r) => r.unchanged).sort()).toEqual([false, true, true]);
    expect(await revisionRows(key)).toHaveLength(1);
  });
});

describe('migration 0063', () => {
  const folder = path.resolve(__dirname, '../../drizzle');
  const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  const at = journal.entries.findIndex((e) => e.tag === '0063_dungeon_reward_snapshots');

  it('is journalled after every earlier migration', () => {
    expect(journal.entries[at]).toMatchObject({ idx: 63, tag: '0063_dungeon_reward_snapshots' });
    expect(journal.entries[at - 1]).toMatchObject({ idx: 62, tag: '0062_dungeon_loot_tables' });
    expect(journal.entries[at]!.when).toBeGreaterThan(Math.max(...journal.entries.slice(0, at).map((e) => e.when)));
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });

  it('adds two null columns to a real 0062 database and leaves every stored revision byte-identical', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-t6-before-'));
    fs.mkdirSync(path.join(temporary, 'meta'));
    const previous = journal.entries.slice(0, at);
    fs.writeFileSync(path.join(temporary, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: previous }));
    for (const entry of previous) fs.copyFileSync(path.join(folder, `${entry.tag}.sql`), path.join(temporary, `${entry.tag}.sql`));
    const databaseName = `waifumon_t6_upgrade_${randomBytes(6).toString('hex')}`;
    const adminUrl = inject('adminDatabaseUrl');
    const admin = new Client({ connectionString: adminUrl });
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    const pool = new Pool({ connectionString: url.toString(), max: 2 });
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const db = createDb(pool);
      await runMigrations(db, w.t.logger, temporary);
      const legacy = testDungeon('upgrade_legacy');
      const modern = singleRoomDungeon([hoard('upgrade_table')], (d) => void (d.key = 'upgrade_modern'));
      for (const definition of [legacy, modern]) {
        await pool.query('INSERT INTO dungeon_definitions (dungeon_key,draft,draft_hash) VALUES ($1,$2,$3)', [
          definition.key,
          JSON.stringify(definition),
          dungeonContentHash(definition),
        ]);
        await pool.query(
          'INSERT INTO dungeon_revisions (dungeon_key,content,number,content_hash,draft_revision) VALUES ($1,$2,1,$3,1)',
          [definition.key, JSON.stringify(definition), dungeonContentHash(definition)],
        );
      }
      const rows = async (query: string) => (await pool.query(query)).rows;
      const stored = "SELECT xmin::text AS version, to_jsonb(r)::text AS row FROM dungeon_revisions r ORDER BY id";
      const drafts = 'SELECT xmin::text AS version, to_jsonb(d)::text AS row FROM dungeon_definitions d ORDER BY dungeon_key';
      const before = { revisions: await rows(stored), drafts: await rows(drafts) };

      await runMigrations(db, w.t.logger, folder);

      const strip = "SELECT xmin::text AS version, (to_jsonb(r) - 'reward_snapshot' - 'gameplay_hash')::text AS row FROM dungeon_revisions r ORDER BY id";
      // Same row versions: no stored revision was rewritten, only described with two more columns.
      expect(await rows(strip)).toEqual(before.revisions);
      expect(await rows(drafts)).toEqual(before.drafts);
      expect(await rows('SELECT reward_snapshot, gameplay_hash FROM dungeon_revisions')).toEqual([
        { reward_snapshot: null, gameplay_hash: null },
        { reward_snapshot: null, gameplay_hash: null },
      ]);
      // Existing rows keep their hashes and read back through the new code as legacy revisions.
      const read = await db.select().from(dungeonRevisions).orderBy(asc(dungeonRevisions.id));
      expect(read.map((r) => [r.contentHash, r.rewardSnapshot, r.gameplayHash])).toEqual([
        [dungeonContentHash(legacy), null, null],
        [dungeonContentHash(modern), null, null],
      ]);
      await expect(pool.query("UPDATE dungeon_revisions SET gameplay_hash = 'x'")).rejects.toMatchObject({
        message: expect.stringContaining('immutable'),
      });
      // Repeatable.
      await runMigrations(db, w.t.logger, folder);
      expect(await rows(strip)).toEqual(before.revisions);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('matches the Drizzle table: columns, nullability, checks and the immutability trigger', async () => {
    const config = getTableConfig(dungeonRevisions);
    const columns = await w.t.db.execute(
      sql`select column_name, is_nullable, data_type from information_schema.columns where table_schema = 'public' and table_name = 'dungeon_revisions'`,
    );
    expect(Object.fromEntries(columns.rows.map((c) => [c.column_name, c.is_nullable === 'NO']))).toEqual(
      Object.fromEntries(config.columns.map((c) => [c.name, c.notNull])),
    );
    expect(columns.rows.filter((c) => ['reward_snapshot', 'gameplay_hash'].includes(String(c.column_name))).map((c) => [c.column_name, c.data_type]).sort()).toEqual([
      ['gameplay_hash', 'text'],
      ['reward_snapshot', 'jsonb'],
    ]);
    const checks = await w.t.db.execute(
      sql`select conname from pg_constraint where conrelid = 'dungeon_revisions'::regclass and contype = 'c' order by 1`,
    );
    expect(checks.rows.map((c) => c.conname)).toEqual(config.checks.map((c) => c.name).sort());
    const triggers = await w.t.db.execute(
      sql`select tgname from pg_trigger where tgrelid = 'dungeon_revisions'::regclass and not tgisinternal`,
    );
    expect(triggers.rows.map((t) => t.tgname)).toEqual(['dungeon_revisions_immutable_trg']);
  });
});
