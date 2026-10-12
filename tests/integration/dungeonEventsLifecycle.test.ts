import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { dungeonRuns, items, playerEquipment, playerWaifus } from '../../src/db/schema';
import { DungeonDefinitionSchema } from '../../src/modules/dungeons/content/dungeonDefinition';
import { readDungeonRewardSnapshot } from '../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { DungeonLootTableBodySchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import { rollEventCheck } from '../../src/modules/dungeons/engine/eventChecks';
import { resolveRewardBundle } from '../../src/modules/dungeons/engine/lootResolver';
import { rewardResolverSnapshot } from '../../src/modules/dungeons/engine/rewards';
import { createDungeonSandbox } from '../../src/modules/dungeons/engine/sandbox';
import { dungeonRngSource } from '../../src/modules/dungeons/engine/seeds';
import { startDungeonRun } from '../../src/modules/dungeons/engine/step';
import { DungeonPackageV3Schema, readDungeonPackage } from '../../src/modules/dungeons/package/dungeonPackage';
import { eventContext, eventDungeonInput } from '../helpers/dungeonEventFixtures';
import { testDependencies } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';

let source: DungeonWorld;
let target: DungeonWorld;
beforeAll(async () => { source = await createDungeonWorld(); target = await createDungeonWorld(); });
afterAll(async () => { await target?.cleanup(); await source?.cleanup(); });

it('ports event rewards, plays a pinned random and checked event, rolls back a final grant, retries concurrently and settles once', async () => {
  expect(source.t.pool.options.connectionString).not.toBe(target.t.pool.options.connectionString);
  for (const world of [source, target]) {
    await world.t.db.insert(items).values({ slug: 'vault_key', name: 'Vault Key', category: 'material', enabled: true });
  }
  const sourceLoot = createDungeonLootTableService({ db: source.t.db });
  const targetLoot = createDungeonLootTableService({ db: target.t.db });
  const coins = (amount: number) => DungeonLootTableBodySchema.parse({ guaranteed: [
    { id: 'coins', grant: { type: 'currency', currency: 'waifubux', amount: { min: amount, max: amount } } },
  ], chances: [], pools: [] });
  const salvage = DungeonLootTableBodySchema.parse({ guaranteed: [
    { id: 'scrap', grant: { type: 'item', item: 'sticky_joystick', quantity: { min: 2, max: 2 } } },
  ], chances: [], pools: [{ id: 'extra', name: 'Extra salvage', draws: 1, entries: [
    { id: 'scrap', weight: 3, grant: { type: 'item', item: 'sticky_joystick', quantity: { min: 1, max: 1 } } },
    { id: 'none', weight: 1, nothing: true },
  ] }] });
  for (const [key, body] of [['c6_missing', salvage], ['c6_identical', coins(5)], ['c6_copy', coins(7)], ['c6_existing', coins(11)]] as const) {
    await sourceLoot.create({ key, name: key, body }, 'source');
  }
  for (const [key, amount] of [['c6_identical', 5], ['c6_copy', 88], ['c6_existing', 99]] as const) {
    await targetLoot.create({ key, name: key, body: coins(amount) }, 'target');
  }
  const input = eventDungeonInput('c6_event_lifecycle');
  const bundle = {
    guaranteed: [
      { id: 'shards', grant: { type: 'currency' as const, currency: 'shards' as const, amount: { min: 45, max: 45 } } },
      { id: 'bux', grant: { type: 'currency' as const, currency: 'waifubux' as const, amount: { min: 501, max: 501 } } },
      { id: 'essence', grant: { type: 'currency' as const, currency: 'essence' as const, amount: { min: 7, max: 7 } } },
      { id: 'gear', grant: { type: 'equipment' as const, selector: { definitionKeys: ['rusty_pipe'] } } },
      { id: 'bond', grant: { type: 'affection' as const, amount: { min: 3, max: 3 } } },
    ], chances: [], tables: ['missing', 'identical', 'copy', 'existing'].map(id => ({ id, table: `c6_${id}`, draws: 1 })),
  };
  input.events![0]!.choices[0]!.outcome!.rewards = bundle;
  const checked = input.events![0]!.choices[1]!;
  checked.items = [{ item: 'vault_key', quantity: 1, consume: true }];
  checked.success!.rewards = bundle;
  checked.failure!.rewards = bundle;
  checked.success!.then = { type: 'room_complete' };
  input.events![1]!.choices[0]!.outcome!.effects = [{ type: 'damage', basisPoints: 2000 }];
  input.rooms[1]!.actions = [input.rooms[1]!.actions![0]!];
  input.connections!.push({ id: 'c_early', from: 'hall', to: 'out', requires: { type: 'flag', flag: 'vault_opened' } });
  const definition = DungeonDefinitionSchema.parse(input);
  expect((await source.content.validate(definition)).issues.filter(i => i.severity === 'error')).toEqual([]);
  await source.publish(definition);
  const pkg = DungeonPackageV3Schema.parse(await source.content.exportPackage(definition.key, 'published', 'source'));
  expect(readDungeonPackage(pkg).ok).toBe(true);
  expect(pkg.dependencies.requiredItems).toEqual(['vault_key']);
  await sourceLoot.update('c6_copy', { expectedRevision: 1, body: coins(1000) }, 'source');
  const frozen = DungeonPackageV3Schema.parse(await source.content.exportPackage(definition.key, 'published', 'source'));
  expect(frozen.rewardSnapshot).toEqual(pkg.rewardSnapshot);
  expect(frozen.dungeon).toEqual(pkg.dungeon);

  const choices = { c6_copy: { action: 'copy' as const, key: 'c6_copied' }, c6_existing: { action: 'use_existing' as const } };
  const plan = await target.content.planImport(pkg, choices);
  expect(plan.lootTables!.map(t => t.status)).toEqual(expect.arrayContaining(['missing', 'identical', 'different']));
  const receipt = await target.content.applyImport({ package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash!, expectedRevision: null,
    decisions: { dungeon: 'create', enemies: {}, lootTables: choices, allowMissingDependencies: false } }, 'target');
  expect(receipt).toMatchObject({ publishable: true, tableKeyChanges: { c6_copy: 'c6_copied' } });
  const imported = (await target.content.get(definition.key))!;
  expect(imported).toMatchObject({ enabled: false, published: null });
  expect((await targetLoot.get('c6_copy'))!.body).toEqual(coins(88));
  expect((await targetLoot.get('c6_copied'))!.body).toEqual(coins(7));
  const importedChoice = imported.draft.events![0]!.choices[1]!;
  for (const outcome of [importedChoice.success!, importedChoice.failure!]) {
    expect(outcome.rewards!.tables).toContainEqual({ id: 'copy', table: 'c6_copied', draws: 1 });
  }
  expect((await target.content.validate(imported.draft)).issues.filter(i => i.severity === 'error')).toEqual([]);
  await target.content.publish(definition.key, { expectedRevision: imported.draftRevision }, 'publisher');
  await target.content.setEnabled(definition.key, true, 'publisher');
  const targetPackage = DungeonPackageV3Schema.parse(await target.content.exportPackage(definition.key, 'published', 'target'));
  expect(targetPackage.rewardSnapshot!.tables.c6_existing!.body).toEqual(coins(99));
  expect(readDungeonPackage(targetPackage).ok).toBe(true);

  const { playerId, buddyId } = await target.player();
  const [key] = await target.t.db.select().from(items).where(eq(items.slug, 'vault_key'));
  const [scrap] = await target.t.db.select().from(items).where(eq(items.slug, 'sticky_joystick'));
  await target.app.inventory.addItem(target.t.db, playerId, key!.id, 1);
  const walletBefore = await target.app.currency.getBalances(playerId);
  const check = importedChoice.check!;
  const place = { roomId: 'vault', actionId: 'door', choiceId: 'pick_lock' };
  let seed = 0;
  while (seed < 5000) {
    const state = startDungeonRun(eventContext(imported.draft, { rewards: null }), seed).state;
    if (state.events!['hall:find']!.eventId === 'buried_crate' && rollEventCheck(check, 185, place, dungeonRngSource(seed)).success) break;
    seed++;
  }
  expect(seed).toBeLessThan(5000);
  const start = await target.runs.start(playerId, definition.key, { seed });
  expect(start.fighter.currentSp).toBe(185);
  const rowOf = async () => (await target.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, start.id)))[0]!;
  const selected = (await rowOf()).eventStates['hall:find'];
  expect(selected).toMatchObject({ eventId: 'buried_crate', status: 'offered', pool: { poolId: 'scrapheap_finds' } });
  expect((await target.restartedRuns().run(playerId, start.id)).core.action!.event).toEqual(start.core.action!.event);
  expect((await rowOf()).eventStates['hall:find']).toEqual(selected);
  const snapshot = readDungeonRewardSnapshot(targetPackage.rewardSnapshot)!;
  const sandbox = createDungeonSandbox({ definition: imported.draft, dependencies: testDependencies(), rewards: snapshot,
    fighter: start.fighter, seed, inventory: { vault_key: 1 } });
  await sandbox.input({ type: 'choose', choiceId: 'dig' });
  const hall = (await target.act(playerId, start, { type: 'choose', choiceId: 'dig' })).run;
  expect((await target.act(playerId, hall, { type: 'move', connectionId: 'c_early' })).status).toBe('refused');
  const offered = (await target.act(playerId, hall, { type: 'move', connectionId: 'c_vault' })).run;
  await sandbox.input({ type: 'move', connectionId: 'c_vault' });
  expect(offered.core.action!.event).toEqual(sandbox.view.action!.event);
  await targetLoot.update('c6_missing', { expectedRevision: 1, body: coins(10000) }, 'target');
  await target.content.publish(definition.key, { expectedRevision: imported.draftRevision }, 'publisher');

  const playerState = async () => ({ row: await rowOf(), history: await target.runs.history(start.id),
    wallet: await target.app.currency.getBalances(playerId), key: await target.app.inventory.getQuantity(playerId, key!.id),
    scrap: await target.app.inventory.getQuantity(playerId, scrap!.id),
    gear: await target.t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId)),
    copy: (await target.t.db.select().from(playerWaifus).where(eq(playerWaifus.id, buddyId!)))[0]!,
  });
  const before = await playerState();
  const finalGrant = vi.spyOn(target.app.collection, 'awardCopyAffection').mockRejectedValueOnce(new Error('C6 final grant failure'));
  try {
    await expect(target.act(playerId, offered, { type: 'choose', choiceId: 'pick_lock' })).rejects.toMatchObject({ code: 'DUNGEON_REWARD_GRANT_FAILED' });
  } finally { finalGrant.mockRestore(); }
  expect(await playerState()).toEqual(before);
  await sandbox.input({ type: 'choose', choiceId: 'pick_lock' });
  const retry = await Promise.all([1, 2].map(() => target.act(playerId, offered, { type: 'choose', choiceId: 'pick_lock' })));
  expect(retry.map(r => r.status).sort()).toEqual(['applied', 'refused']);
  expect(retry.find(r => r.status === 'refused')!.refusal).toBe('stale');
  const won = retry.find(r => r.status === 'applied')!.run;
  const expectedCheck = rollEventCheck(check, start.fighter.currentSp, place, dungeonRngSource(seed));
  const expected = resolveRewardBundle(importedChoice.success!.rewards!, rewardResolverSnapshot(snapshot), seed, place);
  const paid = await playerState();
  expect(paid.row.revisionId).toBe(before.row.revisionId);
  expect(paid.row.eventStates['vault:door']).toMatchObject({ status: 'resolved', resolution: { branch: 'success', check: expectedCheck } });
  expect(paid.row.rewardClaims[`run:${start.id}:vault:door`]).toEqual(expected);
  expect(paid.row.eventStates).toEqual(sandbox.state.events);
  expect(won.core.flags).toEqual(sandbox.state.flags);
  expect(won.core.hp).toBe(sandbox.state.hp);
  expect(won.core.hp).toBeGreaterThan(offered.core.hp);
  expect(won.core.flags).toEqual({ vault_opened: true });
  expect(expected.atRisk).toEqual({ shards: 45, waifubux: 612 });
  expect(paid.key).toBe(0);
  expect(paid.scrap).toBe(before.scrap + expected.secured.items[0]!.quantity);
  expect(paid.gear).toHaveLength(before.gear.length + 1);
  expect(paid.copy.affection).toBe(before.copy.affection + 3);
  expect(paid.wallet).toMatchObject({ waifubux: walletBefore.waifubux, essence: walletBefore.essence + 7 });
  expect(paid.history.filter(e => e.type === 'items_consumed')).toHaveLength(1);
  // Shards-only crate loot is claimed in engine state; only the vault needs a secured grant receipt.
  expect(Object.keys(paid.row.rewardClaims)).toHaveLength(2);
  expect(paid.history.filter(e => e.type === 'rewards_granted')).toHaveLength(1);
  expect((await target.act(playerId, offered, { type: 'choose', choiceId: 'pick_lock' })).refusal).toBe('stale');
  expect(await playerState()).toEqual(paid);
  const back = (await target.act(playerId, won, { type: 'move', connectionId: 'c_back' })).run;
  // The same route rejected before the event now completes and banks both kinds of at-risk currency.
  const ended = (await target.act(playerId, back, { type: 'move', connectionId: 'c_early' })).run;
  expect(ended.status).toBe('completed');
  expect(ended.settlement).toMatchObject({ earned: 47, banked: 47, lost: 0, waifubux: { earned: 612, banked: 612, lost: 0 } });
  expect(await target.balance(playerId)).toBe(47);
  expect(await target.app.currency.getBalances(playerId)).toMatchObject({ waifubux: walletBefore.waifubux + 612, essence: walletBefore.essence + 7 });
  expect((await playerState()).key).toBe(0);
  expect((await playerState()).gear).toEqual(paid.gear);
  expect((await target.act(playerId, ended, { type: 'move', connectionId: 'c_early' })).refusal).toBe('run_over');
  expect((await target.runs.history(start.id)).filter(e => e.type === 'rewards_granted')).toHaveLength(1);
});

it('bounds constraint lock waits and retains the exclusive history lock until the migration transaction ends', async () => {
  const statements = fs.readFileSync(path.resolve(__dirname, '../../drizzle/0065_dungeon_events.sql'), 'utf8')
    .split('--> statement-breakpoint').map(s => s.trim()).filter(s => s.includes('dungeon_run_events'));
  expect(statements).toHaveLength(2);
  const reader = await target.t.pool.connect();
  const migrator = await target.t.pool.connect();
  try {
    await reader.query('BEGIN');
    const before = (await reader.query('SELECT * FROM dungeon_run_events ORDER BY id')).rows;
    await migrator.query('BEGIN');
    await migrator.query("SET LOCAL lock_timeout = '100ms'");
    await expect(migrator.query(statements[0]!)).rejects.toMatchObject({ code: '55P03' });
    await migrator.query('ROLLBACK');
    await reader.query('ROLLBACK');
    await migrator.query('BEGIN');
    for (const statement of statements) await migrator.query(statement);
    const locks = await migrator.query("SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND relation='dungeon_run_events'::regclass AND granted");
    expect(locks.rows).toContainEqual({ mode: 'AccessExclusiveLock' });
    await reader.query('BEGIN');
    await reader.query("SET LOCAL lock_timeout = '100ms'");
    await expect(reader.query('SELECT * FROM dungeon_run_events LIMIT 1')).rejects.toMatchObject({ code: '55P03' });
    await reader.query('ROLLBACK');
    await migrator.query('ROLLBACK');
    expect((await reader.query('SELECT * FROM dungeon_run_events ORDER BY id')).rows).toEqual(before);
    expect((await reader.query("SELECT convalidated FROM pg_constraint WHERE conname='dungeon_run_events_type_check' AND conrelid='dungeon_run_events'::regclass")).rows).toEqual([{ convalidated: true }]);
  } finally {
    await reader.query('ROLLBACK');
    await migrator.query('ROLLBACK');
    reader.release(); migrator.release();
  }
});
