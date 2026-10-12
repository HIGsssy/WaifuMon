import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { dungeonRuns, items, playerEquipment, playerWaifus } from '../../src/db/schema';
import { readDungeonRewardSnapshot } from '../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { DungeonLootTableBodySchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import { resolveRewardBundle } from '../../src/modules/dungeons/engine/lootResolver';
import { rewardResolverSnapshot } from '../../src/modules/dungeons/engine/rewards';
import { DungeonPackageV2Schema, readDungeonPackage } from '../../src/modules/dungeons/package/dungeonPackage';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';

let source: DungeonWorld;
let target: DungeonWorld;
beforeAll(async () => { source = await createDungeonWorld(); target = await createDungeonWorld(); });
afterAll(async () => { await target?.cleanup(); await source?.cleanup(); });

it('exports a frozen publication, reviews conflicts in another database, publishes, pays and settles a pinned run atomically', async () => {
  expect(source.t.pool.options.connectionString).not.toBe(target.t.pool.options.connectionString);
  const sourceLoot = createDungeonLootTableService({ db: source.t.db });
  const targetLoot = createDungeonLootTableService({ db: target.t.db });
  const coins = (amount: number) => DungeonLootTableBodySchema.parse({ guaranteed: [
    { id: 'coins', grant: { type: 'currency', currency: 'waifubux', amount: { min: amount, max: amount } } },
  ], chances: [], pools: [] });
  const sharedBody = DungeonLootTableBodySchema.parse({
    guaranteed: [{ id: 'item', grant: { type: 'item', item: 'sticky_joystick', quantity: { min: 2, max: 2 } } }],
    chances: [{ id: 'bonus', chanceBasisPoints: 2500, grant: { type: 'currency', currency: 'essence', amount: { min: 2, max: 4 } } }],
    pools: [{ id: 'pick', name: 'Extra salvage', draws: 2, entries: [
      { id: 'item', weight: 3, grant: { type: 'item', item: 'sticky_joystick', quantity: { min: 1, max: 1 } } },
      { id: 'none', weight: 1, nothing: true },
    ] }],
  });
  for (const [key, body] of [['t18_missing', sharedBody], ['t18_identical', coins(5)], ['t18_copy', coins(7)], ['t18_existing', coins(11)]] as const) {
    await sourceLoot.create({ key, name: key, body }, 'source');
  }
  await targetLoot.create({ key: 't18_identical', name: 'Identical', body: coins(5) }, 'target');
  await targetLoot.create({ key: 't18_copy', name: 'Keep me', body: coins(88) }, 'target');
  await targetLoot.create({ key: 't18_existing', name: 'Target choice', body: coins(99) }, 'target');
  const definition = singleRoomDungeon([{
    id: 'boss', type: 'boss', waves: [{ enemy: { key: 'grunt' } }, { enemy: { key: 'sentinel' } }],
    rewards: {
      guaranteed: [
        { id: 'shards', grant: { type: 'currency', currency: 'shards', amount: { min: 45, max: 45 } } },
        { id: 'bux', grant: { type: 'currency', currency: 'waifubux', amount: { min: 501, max: 501 } } },
        { id: 'essence', grant: { type: 'currency', currency: 'essence', amount: { min: 7, max: 7 } } },
        { id: 'gear', grant: { type: 'equipment', selector: { definitionKeys: ['rusty_pipe'] } } },
        { id: 'bond', grant: { type: 'affection', amount: { min: 3, max: 3 } } },
      ], chances: [], tables: ['missing', 'identical', 'copy', 'existing'].map(id => ({ id, table: `t18_${id}`, draws: id === 'missing' ? 2 : 1 })),
    },
  }], d => { d.key = 't18_round_trip'; d.rooms[0]!.extraction = true; d.settings!.defeatCurrencyRetentionBasisPoints = 5000; d.settings!.abandonCurrencyRetentionBasisPoints = 0; });
  await source.publish(definition);
  const original = DungeonPackageV2Schema.parse(await source.content.exportPackage(definition.key, 'published', 'source'));
  await sourceLoot.update('t18_copy', { expectedRevision: 1, body: coins(1000) }, 'source');
  const pkg = DungeonPackageV2Schema.parse(await source.content.exportPackage(definition.key, 'published', 'source'));
  expect(readDungeonPackage(pkg).ok).toBe(true);
  expect(pkg.rewardSnapshot).toEqual(original.rewardSnapshot);
  expect(pkg.bundled.dungeonLootTables.find(t => t.key === 't18_copy')!.body).toEqual(coins(7));
  expect((await source.content.get(definition.key))!.dependenciesDiffer).toBe(true);

  const choices = { t18_copy: { action: 'copy' as const, key: 't18_copied' }, t18_existing: { action: 'use_existing' as const } };
  const plan = await target.content.planImport(pkg, choices);
  expect(plan.lootTables!.map(t => t.status)).toEqual(expect.arrayContaining(['missing', 'identical', 'different']));
  expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'loot_table_rewards_differ', severity: 'warning' }));
  const receipt = await target.content.applyImport({ package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash!, expectedRevision: null,
    decisions: { dungeon: 'create', enemies: {}, lootTables: choices, allowMissingDependencies: false } }, 'target');
  expect(receipt).toMatchObject({ publishable: true, tableKeyChanges: { t18_copy: 't18_copied' } });
  const imported = (await target.content.get(definition.key))!;
  expect(imported).toMatchObject({ enabled: false, published: null });
  expect((await targetLoot.get('t18_copy'))!.body).toEqual(coins(88));
  expect((await targetLoot.get('t18_copied'))!.body).toEqual(coins(7));
  const publication = await target.content.publish(definition.key, { expectedRevision: imported.draftRevision }, 'publisher');
  expect(publication.unchanged).toBe(false);
  const publishedPackage = DungeonPackageV2Schema.parse(await target.content.exportPackage(definition.key, 'published', 'target'));
  expect(publishedPackage.rewardSnapshot.tables.t18_existing!.body).toEqual(coins(99));
  await target.content.setEnabled(definition.key, true, 'publisher');
  const { playerId, buddyId } = await target.player();
  const beforeWallet = await target.app.currency.getBalances(playerId);
  const beforeCopy = (await target.t.db.select().from(playerWaifus).where(eq(playerWaifus.id, buddyId!)))[0]!;
  const beforeGear = await target.t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
  const [item] = await target.t.db.select().from(items).where(eq(items.slug, 'sticky_joystick'));
  const beforeItems = await target.app.inventory.getQuantity(playerId, item!.id);
  const start = await target.runs.start(playerId, definition.key, { seed: 42 });
  const first = (await target.act(playerId, start, { type: 'advance' })).run;
  expect(first.secured).toEqual([]);
  expect(first.core).toMatchObject({ unbankedCurrency: 0, unbankedWaifubux: 0 });
  await targetLoot.update('t18_missing', { expectedRevision: 1, body: coins(10000) }, 'target');
  expect((await target.content.get(definition.key))!.dependenciesDiffer).toBe(true);
  expect((await target.content.rewardHealth()).dungeons.find(d => d.key === definition.key)!.status).toBe('healthy');
  const republished = await target.content.publish(definition.key, { expectedRevision: imported.draftRevision }, 'publisher');
  expect(republished.revision.number).toBe(2);
  const snapshot = readDungeonRewardSnapshot(publishedPackage.rewardSnapshot)!;
  const action = imported.draft.rooms[0]!.actions[0]!;
  if (!('rewards' in action) || !action.rewards) throw new Error('Missing imported boss rewards');
  const expected = resolveRewardBundle(action.rewards, rewardResolverSnapshot(snapshot), 42, { roomId: 'hall', actionId: 'boss' });
  const beforeRow = (await target.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, first.id)))[0]!;
  const beforeHistory = await target.runs.history(first.id);
  const fail = vi.spyOn(target.app.collection, 'awardCopyAffection').mockRejectedValueOnce(new Error('T18 final grant failure'));
  try {
    await expect(target.act(playerId, first, { type: 'advance' })).rejects.toMatchObject({ code: 'DUNGEON_REWARD_GRANT_FAILED' });
  } finally { fail.mockRestore(); }
  expect((await target.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, first.id)))[0]).toEqual(beforeRow);
  expect(await target.runs.history(first.id)).toEqual(beforeHistory);
  expect(await target.app.currency.getBalances(playerId)).toEqual(beforeWallet);
  expect(await target.t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId))).toEqual(beforeGear);
  expect(await target.app.inventory.getQuantity(playerId, item!.id)).toBe(beforeItems);
  expect((await target.t.db.select().from(playerWaifus).where(eq(playerWaifus.id, buddyId!)))[0]).toEqual(beforeCopy);
  const won = (await target.act(playerId, first, { type: 'advance' })).run;
  const stored = (await target.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, won.id)))[0]!;
  expect(stored.revisionId).toBe(beforeRow.revisionId);
  expect(stored.rewardClaims[`run:${won.id}:hall:boss`]).toEqual(expected);
  expect(expected.atRisk).toEqual({ shards: 45, waifubux: 612 });
  expect(won.secured).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'affection', waifuId: buddyId, granted: 3 }),
    expect.objectContaining({ kind: 'essence', granted: expected.secured.essence }),
    expect.objectContaining({ kind: 'equipment', definitionKey: 'rusty_pipe' }),
    expect.objectContaining({ kind: 'item', quantity: expected.secured.items[0]!.quantity }),
  ]));
  expect((await target.t.db.select().from(playerWaifus).where(eq(playerWaifus.id, buddyId!)))[0]!.affection).toBe(beforeCopy.affection + 3);
  expect(await target.app.inventory.getQuantity(playerId, item!.id)).toBe(beforeItems + expected.secured.items[0]!.quantity);
  expect(await target.t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId))).toHaveLength(beforeGear.length + 1);
  expect(await target.app.currency.getBalances(playerId)).toMatchObject({ waifubux: beforeWallet.waifubux, essence: beforeWallet.essence + expected.secured.essence });
  expect((await target.act(playerId, first, { type: 'advance' })).refusal).toBe('stale');
  const ended = (await target.act(playerId, won, { type: 'extract' })).run;
  expect(ended.settlement).toMatchObject({ earned: 45, banked: 45, lost: 0, waifubux: { earned: 612, banked: 612, lost: 0 } });
  expect(await target.balance(playerId)).toBe(45);
  expect((await target.app.currency.getBalances(playerId)).waifubux).toBe(beforeWallet.waifubux + 612);
  expect(ended.secured).toEqual(won.secured);
  expect((await target.act(playerId, ended, { type: 'extract' })).refusal).toBe('run_over');
  expect((await target.runs.history(ended.id)).filter(e => e.type === 'rewards_granted')).toHaveLength(1);
  await target.content.rollback(definition.key, { revision: 1 }, 'publisher');
  expect(DungeonPackageV2Schema.parse(await target.content.exportPackage(definition.key, 'published', 'target')).rewardSnapshot).toEqual(publishedPackage.rewardSnapshot);
});
