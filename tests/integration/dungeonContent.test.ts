/**
 * Dungeon authoring against a real database: drafts and their optimistic
 * lock, explicit publication, immutable revisions, rollback, audit, export.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonContentEvents, dungeonDefinitions, dungeonRevisions } from '../../src/db/schema';
import { dungeonContentHash, readDungeonPackage, serializeDungeonPackage } from '../../src/modules/dungeons/package/dungeonPackage';
import {
  DungeonDraftStaleError,
  DungeonInvalidError,
  DungeonKeyTakenError,
  DungeonNotFoundError,
  DungeonRevisionNotFoundError,
  EnemyInUseError,
} from '../../src/shared/errors';
import { testDungeon, testDungeonInput } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';

let w: DungeonWorld;
beforeAll(async () => {
  w = await createDungeonWorld();
});
afterAll(async () => {
  await w.cleanup();
});

let n = 0;
const fresh = () => `dungeon_${++n}`;

describe('drafts', () => {
  it('creates an unpublished draft that players cannot see', async () => {
    const key = fresh();
    const created = await w.content.create({ definition: testDungeonInput(key), layout: { rooms: { gate: { x: 1, y: 2 } } } }, 'admin-1');
    expect(created).toMatchObject({
      key,
      draftRevision: 1,
      published: null,
      draftDiffers: true,
      open: false,
      enabled: true,
      roomCount: 5,
      updatedBy: 'admin-1',
      issues: [],
      layout: { rooms: { gate: { x: 1, y: 2 } }, notes: [] },
    });
    expect(created.draftHash).toBe(dungeonContentHash(testDungeon(key)));
    expect((await w.content.openDungeons()).map((d) => d.row.dungeonKey)).not.toContain(key);
    expect(await w.content.published(w.t.db, key)).toBe('unpublished');
  });

  it('refuses a second dungeon under the same key, and a reserved key', async () => {
    const key = fresh();
    await w.content.create({ definition: testDungeonInput(key) }, 'admin');
    await expect(w.content.create({ definition: testDungeonInput(key) }, 'admin')).rejects.toBeInstanceOf(DungeonKeyTakenError);
    await expect(w.content.create({ definition: testDungeonInput('reference') }, 'admin')).rejects.toBeInstanceOf(DungeonInvalidError);
  });

  it('saves a draft that has validation errors — it is work in progress — but not one with an unreadable shape', async () => {
    const key = fresh();
    const created = await w.content.create({ definition: testDungeonInput(key) }, 'admin');
    const broken = testDungeonInput(key);
    broken.entranceRoomId = 'nowhere';
    const saved = await w.content.saveDraft(key, { definition: broken, expectedRevision: created.draftRevision }, 'admin');
    expect(saved.draftRevision).toBe(2);
    expect(saved.issues.map((i) => i.code)).toContain('entrance_missing');

    await expect(
      w.content.saveDraft(key, { definition: { ...testDungeonInput(key), rooms: 'oops' }, expectedRevision: 2 }, 'admin'),
    ).rejects.toBeInstanceOf(DungeonInvalidError);
    await expect(
      w.content.saveDraft(key, { definition: testDungeonInput('renamed'), expectedRevision: 2 }, 'admin'),
    ).rejects.toBeInstanceOf(DungeonInvalidError);
    expect((await w.content.get(key))!.draftRevision).toBe(2);
  });

  it('refuses a save that names a stale revision, and changes nothing', async () => {
    const key = fresh();
    const created = await w.content.create({ definition: testDungeonInput(key) }, 'alice');
    const first = testDungeonInput(key);
    first.name = 'Alice was here';
    await w.content.saveDraft(key, { definition: first, expectedRevision: created.draftRevision }, 'alice');

    const second = testDungeonInput(key);
    second.name = 'Bob was here';
    const err = await w.content.saveDraft(key, { definition: second, expectedRevision: created.draftRevision }, 'bob').catch((e) => e);
    expect(err).toBeInstanceOf(DungeonDraftStaleError);
    expect(err).toMatchObject({ expectedRevision: 1, currentRevision: 2, updatedBy: 'alice' });
    expect((await w.content.get(key))!.name).toBe('Alice was here');
  });

  it('lets exactly one of two concurrent saves of the same revision win', async () => {
    const key = fresh();
    const created = await w.content.create({ definition: testDungeonInput(key) }, 'admin');
    const attempt = (name: string) => {
      const definition = testDungeonInput(key);
      definition.name = name;
      return w.content.saveDraft(key, { definition, expectedRevision: created.draftRevision }, name);
    };
    const results = await Promise.allSettled([attempt('one'), attempt('two'), attempt('three')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DungeonDraftStaleError);
    expect((await w.content.get(key))!.draftRevision).toBe(2);
  });

  it('keeps layout apart from gameplay: a layout-only save bumps the lock, not the content hash', async () => {
    const key = fresh();
    const created = await w.content.create({ definition: testDungeonInput(key) }, 'admin');
    const moved = await w.content.saveDraft(key, { layout: { rooms: { gate: { x: 50, y: 60 }, ghost: { x: 1, y: 1 } } }, expectedRevision: 1 }, 'admin');
    expect(moved.draftRevision).toBe(2);
    expect(moved.draftHash).toBe(created.draftHash);
    // A position for a room the dungeon does not have is dropped.
    expect(moved.layout.rooms).toEqual({ gate: { x: 50, y: 60 } });
    // Saving exactly what is stored is not a new revision.
    const same = await w.content.saveDraft(key, { definition: testDungeonInput(key), layout: moved.layout, expectedRevision: 2 }, 'admin');
    expect(same.draftRevision).toBe(2);
  });

  it('answers a missing dungeon plainly', async () => {
    expect(await w.content.get('nope')).toBeNull();
    await expect(w.content.saveDraft('nope', { expectedRevision: 1 }, 'admin')).rejects.toBeInstanceOf(DungeonNotFoundError);
    await expect(w.content.publish('nope', { expectedRevision: 1 }, 'admin')).rejects.toBeInstanceOf(DungeonNotFoundError);
  });
});

describe('publication', () => {
  it('publishes only on an explicit publish, as revision 1, and opens the dungeon', async () => {
    const key = fresh();
    const created = await w.content.create({ definition: testDungeonInput(key) }, 'author');
    const published = await w.content.publish(key, { expectedRevision: created.draftRevision }, 'publisher');
    expect(published).toMatchObject({
      unchanged: false,
      revision: { number: 1, current: true, source: 'editor', draftRevision: 1, publishedBy: 'publisher', activeRuns: 0 },
      dungeon: { open: true, draftDiffers: false, published: { number: 1, contentHash: created.draftHash } },
    });
    expect((await w.content.openDungeons()).map((d) => d.row.dungeonKey)).toContain(key);
  });

  it('refuses to publish a draft with errors, naming them, and writes no revision', async () => {
    const key = fresh();
    const broken = testDungeonInput(key);
    broken.rooms[1]!.actions![0] = { id: 'bruiser', type: 'combat', waves: [{ enemy: { key: 'dragon' } }] };
    const created = await w.content.create({ definition: broken }, 'admin');
    const err = await w.content.publish(key, { expectedRevision: created.draftRevision }, 'admin').catch((e) => e);
    expect(err).toBeInstanceOf(DungeonInvalidError);
    expect((err as DungeonInvalidError).issues).toContainEqual(expect.objectContaining({ code: 'enemy_missing', severity: 'error' }));
    expect(await w.content.revisions(key)).toEqual([]);
    expect(await w.content.published(w.t.db, key)).toBe('unpublished');
  });

  it('refuses to publish a draft that changed under the reviewer', async () => {
    const key = fresh();
    const created = await w.content.create({ definition: testDungeonInput(key) }, 'admin');
    const edited = testDungeonInput(key);
    edited.name = 'Changed after review';
    await w.content.saveDraft(key, { definition: edited, expectedRevision: 1 }, 'someone-else');
    await expect(w.content.publish(key, { expectedRevision: created.draftRevision }, 'admin')).rejects.toBeInstanceOf(DungeonDraftStaleError);
    expect(await w.content.revisions(key)).toEqual([]);
  });

  it('numbers revisions per dungeon and does not write one for an unchanged draft', async () => {
    const key = fresh();
    await w.publish(testDungeonInput(key));
    const again = await w.content.publish(key, { expectedRevision: 1 }, 'admin');
    expect(again).toMatchObject({ unchanged: true, revision: { number: 1 } });

    const edited = testDungeonInput(key);
    edited.name = 'Second Cut';
    const second = await w.republish(edited);
    expect(second.revision).toMatchObject({ number: 2, current: true });
    expect((await w.content.revisions(key))!.map((r) => [r.number, r.current])).toEqual([[2, true], [1, false]]);
    // Another dungeon starts from 1 again.
    expect((await w.publish(testDungeonInput(fresh()))).revision.number).toBe(1);
  });

  it('keeps a published revision exactly as it was when the draft moves on', async () => {
    const key = fresh();
    const first = await w.publish(testDungeonInput(key));
    const edited = testDungeonInput(key);
    edited.name = 'Draft Only';
    edited.rooms[0]!.actions = [];
    const current = (await w.content.get(key))!;
    const saved = await w.content.saveDraft(key, { definition: edited, expectedRevision: current.draftRevision }, 'admin');
    expect(saved).toMatchObject({ draftDiffers: true, published: { number: 1 } });

    const revision = (await w.content.revision(key, 1))!;
    expect(revision.content).toEqual(testDungeon(key));
    expect(revision.contentHash).toBe(first.revision.contentHash);
    const live = await w.content.published(w.t.db, key);
    expect(typeof live === 'object' && live.definition.name).toBe('Test Tunnels');
  });

  it('makes a published revision immutable in the database itself', async () => {
    const key = fresh();
    const { revision } = await w.publish(testDungeonInput(key));
    await expect(
      w.t.db.update(dungeonRevisions).set({ content: { hacked: true } }).where(eq(dungeonRevisions.id, revision.revisionId)),
    ).rejects.toThrow(/immutable/);
    await expect(w.t.db.delete(dungeonRevisions).where(eq(dungeonRevisions.id, revision.revisionId))).rejects.toThrow(/immutable/);
    expect((await w.content.revision(key, 1))!.content).toEqual(testDungeon(key));
  });

  it('takes a dungeon away from new runs when disabled, without unpublishing it', async () => {
    const key = fresh();
    await w.publish(testDungeonInput(key));
    const off = await w.content.setEnabled(key, false, 'admin');
    expect(off).toMatchObject({ enabled: false, open: false, published: { number: 1 } });
    expect(await w.content.published(w.t.db, key)).toBe('disabled');
    const on = await w.content.setEnabled(key, true, 'admin');
    expect(on.open).toBe(true);
  });
});

describe('rollback', () => {
  it('points new runs back at an earlier revision without copying or changing content', async () => {
    const key = fresh();
    await w.publish(testDungeonInput(key));
    const edited = testDungeonInput(key);
    edited.name = 'Version Two';
    await w.republish(edited);

    const rolled = await w.content.rollback(key, { revision: 1 }, 'admin');
    expect(rolled).toMatchObject({ unchanged: false, revision: { number: 1, current: true }, dungeon: { published: { number: 1 }, draftDiffers: true } });
    // The draft is untouched, and no third revision appeared.
    expect((await w.content.get(key))!.name).toBe('Version Two');
    expect((await w.content.revisions(key))!.map((r) => [r.number, r.current])).toEqual([[2, false], [1, true]]);
    const live = await w.content.published(w.t.db, key);
    expect(typeof live === 'object' && live.definition.name).toBe('Test Tunnels');

    // Forward again is just another pointer move.
    expect((await w.content.rollback(key, { revision: 2 }, 'admin')).revision).toMatchObject({ number: 2, current: true });
    expect(await w.content.rollback(key, { revision: 2 }, 'admin')).toMatchObject({ unchanged: true });
  });

  it('refuses a revision the dungeon does not have', async () => {
    const key = fresh();
    await w.publish(testDungeonInput(key));
    await expect(w.content.rollback(key, { revision: 7 }, 'admin')).rejects.toBeInstanceOf(DungeonRevisionNotFoundError);
  });
});

describe('audit and export', () => {
  it('records who did what, newest first', async () => {
    const key = fresh();
    await w.content.create({ definition: testDungeonInput(key) }, 'author');
    const edited = testDungeonInput(key);
    edited.name = 'Edited';
    await w.content.saveDraft(key, { definition: edited, expectedRevision: 1 }, 'editor');
    await w.content.publish(key, { expectedRevision: 2 }, 'publisher');
    await w.content.setEnabled(key, false, 'ops');
    await w.content.exportPackage(key, 'draft', 'exporter');
    const history = await w.content.history(key);
    expect(history.map((e) => [e.action, e.actor])).toEqual([
      ['exported', 'exporter'],
      ['disabled', 'ops'],
      ['published', 'publisher'],
      ['draft_saved', 'editor'],
      ['created', 'author'],
    ]);
    expect(history.find((e) => e.action === 'published')!.details).toMatchObject({ revision: 1, draftRevision: 2, previousRevision: null });
    expect(history.find((e) => e.action === 'draft_saved')!.details).toMatchObject({ contentChanged: true, layoutChanged: false });
    // The trail is its own table and survives on its own key.
    const rows = await w.t.db.select().from(dungeonContentEvents).where(eq(dungeonContentEvents.dungeonKey, key));
    expect(rows).toHaveLength(5);
  });

  it('exports the draft as a package that reads back, with this server’s enemies bundled', async () => {
    const key = fresh();
    const created = await w.content.create({ definition: testDungeonInput(key), layout: { rooms: { den: { x: 9, y: 9 } } } }, 'admin');
    const pkg = await w.content.exportPackage(key, 'draft', 'admin');
    expect(pkg).toMatchObject({
      source: { environment: 'test', dungeonKey: key, origin: 'draft', draftRevision: 1, publishedRevision: null },
      contentHash: created.draftHash,
      editor: { layout: { rooms: { den: { x: 9, y: 9 } } } },
    });
    expect(pkg.bundled.enemies.map((e) => e.key)).toEqual(['grunt', 'overlord', 'sentinel', 'warden']);
    const read = readDungeonPackage(serializeDungeonPackage(pkg));
    expect(read).toMatchObject({ ok: true, issues: [] });
    expect(read.package!.dungeon).toEqual(created.draft);
  });

  it('round-trips through a second environment: export, create from the package, export again — same hash', async () => {
    const key = fresh();
    await w.publish(testDungeonInput(key));
    const exported = await w.content.exportPackage(key, 'published', 'admin');
    expect(exported.source).toMatchObject({ origin: 'revision', publishedRevision: 1, draftRevision: null });

    const other = await createDungeonWorld();
    try {
      const read = readDungeonPackage(serializeDungeonPackage(exported)).package!;
      const landed = await other.content.create({ definition: read.dungeon, layout: read.editor.layout }, 'importer');
      // Arriving in an environment never publishes.
      expect(landed).toMatchObject({ published: null, open: false, draftHash: exported.contentHash });
      const again = await other.content.exportPackage(key, 'draft', 'importer');
      expect(again.contentHash).toBe(exported.contentHash);
      expect(again.dungeon).toEqual(exported.dungeon);
      expect(again.dependencies).toEqual(exported.dependencies);
    } finally {
      await other.cleanup();
    }
  });

  it('exports a named revision, and refuses one that does not exist', async () => {
    const key = fresh();
    await w.publish(testDungeonInput(key));
    const edited = testDungeonInput(key);
    edited.name = 'Two';
    await w.republish(edited);
    expect((await w.content.exportPackage(key, { revision: 1 }, 'admin')).dungeon.name).toBe('Test Tunnels');
    expect((await w.content.exportPackage(key, 'published', 'admin')).dungeon.name).toBe('Two');
    await expect(w.content.exportPackage(key, { revision: 9 }, 'admin')).rejects.toBeInstanceOf(DungeonRevisionNotFoundError);
    await expect(w.content.exportPackage(fresh(), 'draft', 'admin')).rejects.toBeInstanceOf(DungeonNotFoundError);
  });
});

describe('what dungeons hold on to', () => {
  it('lists a dungeon among an enemy’s uses and blocks deleting the enemy', async () => {
    const key = fresh();
    await w.publish(testDungeonInput(key));
    const references = (await w.enemies.references('warden'))!.filter((r) => r.key === key);
    expect(references.map((r) => r.usage)).toEqual([
      'draft: room "Bulkhead" combat "sentry"',
      'published: room "Bulkhead" combat "sentry"',
    ]);
    const pooled = (await w.enemies.references('sentinel'))!.filter((r) => r.key === key && r.usage.startsWith('draft'));
    expect(pooled.map((r) => r.usage)).toEqual(['draft: room "Gate" combat "guards", wave 2 (pool)', 'draft: room "Pump Room" combat "bruiser"']);
    const warden = (await w.enemies.get('warden'))!;
    await expect(w.enemies.delete('warden', { expectedRevision: warden.revision }, 'admin')).rejects.toBeInstanceOf(EnemyInUseError);
  });

  it('stores nothing but the definition tables this phase added', async () => {
    const tables = await w.t.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'dungeon%' order by 1`,
    );
    expect((tables.rows as { table_name: string }[]).map((r) => r.table_name)).toEqual([
      'dungeon_content_events',
      'dungeon_daily_usage',
      'dungeon_definitions',
      'dungeon_import_history',
      'dungeon_revisions',
      'dungeon_run_events',
      'dungeon_run_events_prototype',
      'dungeon_runs',
      'dungeon_runs_prototype',
      'dungeon_settings',
      'dungeon_zones_prototype',
    ]);
    expect(await w.t.db.select({ key: dungeonDefinitions.dungeonKey }).from(dungeonDefinitions)).not.toHaveLength(0);
  });
});
