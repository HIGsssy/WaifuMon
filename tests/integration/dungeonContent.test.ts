/**
 * Dungeon authoring against a real database: drafts and their optimistic
 * lock, explicit publication, immutable revisions, rollback, audit, export.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dungeonContentEvents, dungeonDefinitions, dungeonRevisions, dungeonRuns, equipmentDefinitions, items, rewardTables } from '../../src/db/schema';
import { rewardTableHash } from '../../src/modules/rewardTables/rewardTableCore';
import { dungeonContentHash, readDungeonPackage, serializeDungeonPackage } from '../../src/modules/dungeons/package/dungeonPackage';
import {
  DungeonDraftStaleError,
  DungeonInvalidError,
  DungeonKeyTakenError,
  DungeonNotFoundError,
  DungeonRevisionNotFoundError,
  EnemyInUseError,
} from '../../src/shared/errors';
import { singleRoomDungeon, testDungeon, testDungeonInput } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import { CURRENCY } from '../helpers/dungeonFixtures';

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
  it('repairs an existing None currency draft without changing published content or active runs', async () => {
    const key = fresh();
    const definition = singleRoomDungeon([{ id: 'fight', type: 'combat', waves: [{ enemy: { key: 'grunt' } }],
      rewards: { guaranteed: [], chances: [], tables: [] } }], d => {
      d.key = key;
      d.settings = { progressionCurrency: null, defeatCurrencyRetentionBasisPoints: 5000, abandonCurrencyRetentionBasisPoints: 0 };
    });
    const created = await w.content.create({ definition, layout: { rooms: { hall: { x: 12, y: 34 } } } }, 'author');
    const publication = await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
    const player = await w.player();
    const start = await w.runs.start(player.playerId, key);
    const originalRevisions = await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, key));
    const originalRun = (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, start.id)))[0]!;
    const loot = await createDungeonLootTableService({ db: w.t.db }).create({ key: `${key}_shards`, name: 'Basic run', body: {
      guaranteed: [{ id: 'shards', grant: { type: 'currency', currency: 'shards', amount: { min: 5, max: 5 } } }], chances: [], pools: [],
    } }, 'author');
    const broken = structuredClone(created.draft);
    const fight = broken.rooms[0]!.actions[0]!;
    if (fight.type !== 'combat') throw new Error('Missing test combat');
    fight.rewards!.tables = [{ id: 'basic', table: loot.key, draws: 1 }];
    const attached = await w.content.saveDraft(key, { definition: broken, expectedRevision: 1 }, 'author');
    expect(attached.issues).toContainEqual(expect.objectContaining({ code: 'reward_shards_unset', message: expect.stringContaining('Dungeon Settings') }));
    await expect(w.content.publish(key, { expectedRevision: attached.draftRevision }, 'publisher')).rejects.toBeInstanceOf(DungeonInvalidError);
    const repaired = { ...attached.draft, settings: { ...attached.draft.settings, progressionCurrency: CURRENCY } };
    expect((await w.content.validate(repaired)).issues.filter(issue => issue.severity === 'error')).toEqual([]);
    const saved = await w.content.saveDraft(key, { definition: repaired, expectedRevision: attached.draftRevision }, 'author');
    const reloaded = (await w.content.get(key))!;
    expect(reloaded.draft).toEqual(repaired);
    expect(reloaded.layout).toEqual(created.layout);
    expect(reloaded.draft.rooms).toEqual(attached.draft.rooms);
    expect(reloaded.draft.settings).toEqual({ ...definition.settings, progressionCurrency: CURRENCY });
    expect(reloaded.issues.filter(issue => issue.code === 'reward_shards_unset')).toEqual([]);
    expect(reloaded.published?.revisionId).toBe(publication.revision.revisionId);
    expect(await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, key))).toEqual(originalRevisions);
    const next = await w.content.publish(key, { expectedRevision: saved.draftRevision }, 'publisher');
    expect(next.revision.number).toBe(2);
    const current = await w.content.published(w.t.db, key);
    if (typeof current === 'string') throw new Error('Missing published dungeon');
    expect(current.definition.settings.progressionCurrency).toBe(CURRENCY);
    expect((await w.content.revision(key, 1))!.content.settings.progressionCurrency).toBeNull();
    expect((await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, start.id)))[0]).toEqual(originalRun);
  });

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

describe('legacy reward publication integrity', () => {
  const table = async (id: string, groups: unknown[], enabled = true) => {
    const definition = { id, enabled, groups };
    await w.t.db.insert(rewardTables).values({ kind: 'expedition', tableId: id, enabled, definition, contentHash: rewardTableHash('expedition', definition) });
    return definition;
  };
  const lootGroup = (slug: string) => ({ id: 'item', entries: [{ itemId: slug, weight: 1, quantity: 1 }] });
  const gearGroup = (selector: Record<string, unknown>) => ({ id: 'gear', entries: [], equipment: [{ ...selector, weight: 1 }] });
  const dungeon = (key: string, reward: { rewardTable?: string; equipmentRewardTable?: string }) => singleRoomDungeon([
    { id: 'loot', type: 'reward', reward },
    { id: 'rest', type: 'rest' },
  ], (d) => { d.key = key; d.name = `Dungeon ${key}`; });
  const stored = async (key: string) => ({
    definitions: await w.t.db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key)),
    revisions: await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, key)).orderBy(dungeonRevisions.id),
    events: await w.t.db.select().from(dungeonContentEvents).where(eq(dungeonContentEvents.dungeonKey, key)).orderBy(dungeonContentEvents.id),
    runs: await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.dungeonKey, key)).orderBy(dungeonRuns.id),
  });

  it.each(['rewardTable', 'equipmentRewardTable'] as const)('refuses capped items through %s without moving a published pointer', async (field) => {
    const key = fresh();
    const slug = `capped_${key}`;
    await w.t.db.insert(items).values({ slug, name: 'Capped prize', category: 'material', maxOwned: 1 });
    const id = `rewards-${key}`;
    await table(id, [lootGroup(slug)]);
    await w.publish(dungeon(key, {}));
    const saved = await w.content.saveDraft(key, { definition: dungeon(key, { [field]: id }), expectedRevision: 1 }, 'admin');
    const before = await stored(key);
    const error = await w.content.publish(key, { expectedRevision: saved.draftRevision }, 'admin').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DungeonInvalidError);
    expect((error as DungeonInvalidError).issues).toContainEqual(expect.objectContaining({
      code: 'reward_item_capped', severity: 'error', message: expect.stringContaining(slug),
    }));
    expect((error as Error).message).toContain(key);
    expect((error as Error).message).toContain(id);
    expect(await stored(key)).toEqual(before);
  });

  it.each(['rewardTable', 'equipmentRewardTable'] as const)('refuses missing inventory items through %s', async (field) => {
    const key = fresh();
    const id = `rewards-${key}`;
    await table(id, [lootGroup('missing_prize')]);
    const created = await w.content.create({ definition: dungeon(key, { [field]: id }) }, 'admin');
    const before = await stored(key);
    const error = await w.content.publish(key, { expectedRevision: created.draftRevision }, 'admin').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DungeonInvalidError);
    expect((error as DungeonInvalidError).issues).toContainEqual(expect.objectContaining({ code: 'item_missing', severity: 'error', message: expect.stringContaining('missing_prize') }));
    expect((error as Error).message).toContain(id);
    expect((error as Error).message).toContain(key);
    expect(await stored(key)).toEqual(before);
  });

  it.each([
    { definitionKeys: ['missing_gear'] },
    { definitionKeys: ['rusty_pipe'], slot: 'defense' },
    { definitionKeys: ['rusty_pipe'], rarity: 'R' },
    { slot: 'attack', rarity: 'SR' },
  ])('refuses an invalid or empty equipment selection %j', async (selector) => {
    const key = fresh();
    const id = `rewards-${key}`;
    await table(id, [gearGroup(selector)]);
    // The last selector is made empty against the live database.
    const disabled = 'definitionKeys' in selector ? [] : await w.t.db.update(equipmentDefinitions).set({ enabled: false })
      .where(sql`${equipmentDefinitions.slot} = 'attack' and ${equipmentDefinitions.rarity} = 'SR' and ${equipmentDefinitions.enabled} = true`).returning();
    try {
      const created = await w.content.create({ definition: dungeon(key, { equipmentRewardTable: id }) }, 'admin');
      const before = await stored(key);
      const error = await w.content.publish(key, { expectedRevision: created.draftRevision }, 'admin').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DungeonInvalidError);
      expect((error as DungeonInvalidError).issues).toContainEqual(expect.objectContaining({ code: 'reward_dependency_invalid', severity: 'error', path: expect.stringContaining('.equipment[0]') }));
      expect((error as Error).message).toContain(id);
      expect((error as Error).message).toContain(key);
      expect(await stored(key)).toEqual(before);
    } finally {
      for (const row of disabled) await w.t.db.update(equipmentDefinitions).set({ enabled: true }).where(eq(equipmentDefinitions.key, row.key));
    }
  });

  it('rejects a malformed equipment selector as a typed dependency error', async () => {
    const key = fresh();
    const id = `rewards-${key}`;
    await w.t.db.insert(rewardTables).values({ kind: 'expedition', tableId: id, enabled: true, contentHash: 'invalid', definition: { id, groups: [gearGroup({ definitionKeys: [] })] } });
    const created = await w.content.create({ definition: dungeon(key, { rewardTable: id }) }, 'admin');
    const before = await stored(key);
    await expect(w.content.publish(key, { expectedRevision: created.draftRevision }, 'admin')).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'reward_dependency_invalid', path: expect.stringContaining('definitionKeys'), message: expect.stringContaining(id) })],
    });
    expect(await stored(key)).toEqual(before);
  });

  it('publishes valid rewards without changing hashes and preserves disabled-table no-payout semantics', async () => {
    const key = fresh();
    const id = `rewards-${key}`;
    await table(id, [lootGroup('sticky_joystick'), gearGroup({ definitionKeys: ['rusty_pipe'] })]);
    const definition = dungeon(key, { rewardTable: id, equipmentRewardTable: id });
    const published = await w.publish(definition);
    expect(published.revision.contentHash).toBe(dungeonContentHash(definition));
    expect(published.revision.number).toBe(1);
    expect((await w.content.revision(key, 1))!.content).toEqual(definition);
    expect(await w.content.publish(key, { expectedRevision: 1 }, 'admin')).toMatchObject({ unchanged: true, revision: { revisionId: published.revision.revisionId } });
    const disabledKey = fresh();
    const disabledId = `rewards-${disabledKey}`;
    await table(disabledId, [lootGroup('sticky_joystick')], false);
    const off = await w.publish(dungeon(disabledKey, { rewardTable: disabledId }));
    expect(off.dungeon.issues).toContainEqual(expect.objectContaining({ code: 'reward_table_disabled', severity: 'warning' }));
  });

  it.each(['missing', 'boss'] as const)('rejects a %s expedition table with dungeon and table context', async (kind) => {
    const key = fresh();
    const id = `rewards-${key}`;
    if (kind === 'boss') {
      const definition = { id, buddyXp: 10, groups: [lootGroup('sticky_joystick')] };
      await w.t.db.insert(rewardTables).values({ kind, tableId: id, enabled: true, definition, contentHash: rewardTableHash(kind, definition) });
    }
    const created = await w.content.create({ definition: dungeon(key, { rewardTable: id }) }, 'admin');
    const before = await stored(key);
    await expect(w.content.publish(key, { expectedRevision: created.draftRevision }, 'admin')).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'reward_table_missing', message: expect.stringContaining(`(${key}), reward table "${id}"`) })],
    });
    expect(await stored(key)).toEqual(before);
  });

  it('revalidates unchanged publication and rollback requests without modifying an already published revision', async () => {
    const key = fresh();
    const slug = `prize_${key}`;
    await w.t.db.insert(items).values({ slug, name: 'Prize', category: 'material' });
    const id = `rewards-${key}`;
    await table(id, [lootGroup(slug)]);
    await w.publish(dungeon(key, { rewardTable: id }));
    await w.t.db.update(items).set({ maxOwned: 1 }).where(eq(items.slug, slug));
    const before = await stored(key);
    await expect(w.content.publish(key, { expectedRevision: 1 }, 'admin')).rejects.toBeInstanceOf(DungeonInvalidError);
    await expect(w.content.rollback(key, { revision: 1 }, 'admin')).rejects.toBeInstanceOf(DungeonInvalidError);
    expect(await stored(key)).toEqual(before);
  });

  it('holds dependency locks through publication and releases them at commit', async () => {
    const key = fresh();
    const slug = `locked_${key}`;
    await w.t.db.insert(items).values({ slug, name: 'Locked prize', category: 'material' });
    const id = `rewards-${key}`;
    await table(id, [lootGroup(slug), gearGroup({ definitionKeys: ['rusty_pipe'] })]);
    const created = await w.content.create({ definition: dungeon(key, { rewardTable: id }) }, 'admin');
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const validating = new Promise<void>((resolve) => { entered = resolve; });
    const original = w.enemies.definitions.bind(w.enemies);
    // General dungeon validation follows reward validation, while its locks
    // must still be held before the immutable revision/pointer are written.
    const hold = vi.spyOn(w.enemies, 'definitions').mockImplementationOnce(async (tx) => {
      entered();
      await paused;
      return original(tx);
    });
    const publishing = w.content.publish(key, { expectedRevision: created.draftRevision }, 'admin');
    const writes = [
      sql`select 1 from ${rewardTables} where ${rewardTables.kind} = 'expedition' and ${rewardTables.tableId} = ${id} for update nowait`,
      sql`select 1 from ${items} where ${items.slug} = ${slug} for update nowait`,
      sql`select 1 from ${equipmentDefinitions} where ${equipmentDefinitions.key} = 'rusty_pipe' for update nowait`,
    ];
    try {
      await Promise.race([validating, publishing.then(() => { throw new Error('publication did not pause during validation'); })]);
      for (const query of writes) {
        await expect(w.t.db.transaction((tx) => tx.execute(query))).rejects.toMatchObject({ code: '55P03' });
      }
    } finally {
      release();
      hold.mockRestore();
      await publishing;
    }
    expect(await publishing).toMatchObject({ unchanged: false, revision: { number: 1 } });
    for (const query of writes) await w.t.db.transaction((tx) => tx.execute(query));
  });

  it.each(['cap', 'missing_item', 'disabled_gear'] as const)('rejects re-publication and historical rollback after %s changes, preserving revisions and active runs', async (change) => {
    const key = fresh();
    const id = `rewards-${key}`;
    const slug = `prize_${key}`;
    const [item] = await w.t.db.insert(items).values({ slug, name: 'Uncapped prize', category: 'material' }).returning();
    await table(id, [lootGroup(slug), gearGroup({ definitionKeys: ['rusty_pipe'] })]);
    const definition = dungeon(key, { rewardTable: id });
    await w.publish(definition);
    const { playerId } = await w.player();
    await w.runs.start(playerId, key, { seed: 43 });
    await w.republish(dungeon(key, {}));
    if (change === 'cap') await w.t.db.update(items).set({ maxOwned: 1 }).where(eq(items.id, item!.id));
    else if (change === 'missing_item') await w.t.db.delete(items).where(eq(items.id, item!.id));
    else await w.t.db.update(equipmentDefinitions).set({ enabled: false }).where(eq(equipmentDefinitions.key, 'rusty_pipe'));
    try {
      const before = await stored(key);
      await expect(w.content.rollback(key, { revision: 1 }, 'admin')).rejects.toBeInstanceOf(DungeonInvalidError);
      expect(await stored(key)).toEqual(before);
      const saved = await w.content.saveDraft(key, { definition, expectedRevision: 2 }, 'admin');
      const beforePublish = await stored(key);
      await expect(w.content.publish(key, { expectedRevision: saved.draftRevision }, 'admin')).rejects.toBeInstanceOf(DungeonInvalidError);
      expect(await stored(key)).toEqual(beforePublish);
      expect((await w.content.revisions(key))!.map((r) => [r.number, r.current])).toEqual([[2, true], [1, false]]);
    } finally {
      if (change === 'disabled_gear') await w.t.db.update(equipmentDefinitions).set({ enabled: true }).where(eq(equipmentDefinitions.key, 'rusty_pipe'));
    }
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
      ['disabled', 'ops'],
      ['published', 'publisher'],
      ['draft_saved', 'editor'],
      ['created', 'author'],
    ]);
    expect(history.find((e) => e.action === 'published')!.details).toMatchObject({ revision: 1, draftRevision: 2, previousRevision: null });
    expect(history.find((e) => e.action === 'draft_saved')!.details).toMatchObject({ contentChanged: true, layoutChanged: false });
    // The trail is its own table and survives on its own key.
    const rows = await w.t.db.select().from(dungeonContentEvents).where(eq(dungeonContentEvents.dungeonKey, key));
    expect(rows).toHaveLength(4);
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

  it('stores the expected dungeon foundation and authoring catalogue tables', async () => {
    const tables = await w.t.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'dungeon%' order by 1`,
    );
    expect((tables.rows as { table_name: string }[]).map((r) => r.table_name)).toEqual([
      'dungeon_content_events',
      'dungeon_daily_usage',
      'dungeon_definitions',
      'dungeon_import_history',
      'dungeon_loot_table_events',
      'dungeon_loot_tables',
      'dungeon_revisions',
      'dungeon_run_events',
      'dungeon_run_events_prototype',
      'dungeon_runs',
      'dungeon_runs_prototype',
      'dungeon_scene_sprite_events',
      'dungeon_scene_sprites',
      'dungeon_settings',
      'dungeon_species_acquisitions',
      'dungeon_zones_prototype',
    ]);
    expect(await w.t.db.select({ key: dungeonDefinitions.dungeonKey }).from(dungeonDefinitions)).not.toHaveLength(0);
  });
});
