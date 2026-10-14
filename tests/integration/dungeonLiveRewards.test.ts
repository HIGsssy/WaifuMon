import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { asc, eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { mapAppErrorToStatus, toErrorBody } from '../../src/api/errors';
import {
  dungeonRunEvents, dungeonRuns, equipmentDefinitions, equipmentEvents, items,
  playerEquipment, playerInventory, playerWaifus, players,
  progressionCurrencies, progressionCurrencyLedger, species as speciesTable,
} from '../../src/db/schema';
import type { DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonRewardBundleSchema, DungeonLootTableBodySchema, type DungeonRewardBundle } from '../../src/modules/dungeons/content/dungeonRewards';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonRunService';
import { resolveRewardBundle } from '../../src/modules/dungeons/engine/lootResolver';
import { rewardResolverSnapshot } from '../../src/modules/dungeons/engine/rewards';
import { EquipmentCombatBonusFileSchema, combatBonusCatalogueFromFile, EQUIPMENT_COMBAT_BONUS_FILE } from '../../src/modules/equipment/combatBonuses';
import { createEquipmentRewardService } from '../../src/modules/equipment/equipmentRewardService';
import { DungeonInvalidError, DungeonRewardGrantError } from '../../src/shared/errors';
import { CURRENCY, FIXED_RULES, singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { CONTENT_DIR, insertOwnedWaifu } from '../helpers/fixtures';

const bonuses = combatBonusCatalogueFromFile(EquipmentCombatBonusFileSchema.parse(
  JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, EQUIPMENT_COMBAT_BONUS_FILE), 'utf8')),
));
let w: DungeonWorld;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const gearKey = 't10_reward_gear';
const rewardSlugs = ['t10_charm', 't10_material', 't10_salvage'];
const currency = (currency: 'shards' | 'waifubux' | 'essence', amount: number) => ({
  type: 'currency' as const, currency, amount: { min: amount, max: amount },
});
const full = (): DungeonRewardBundle => DungeonRewardBundleSchema.parse({ chances: [], tables: [], guaranteed: [
  { id: 'shards', grant: currency('shards', 45) },
  { id: 'bux', grant: currency('waifubux', 501) },
  { id: 'essence', grant: currency('essence', 7) },
  { id: 'bond', grant: { type: 'affection', amount: { min: 3, max: 3 } } },
  ...[...rewardSlugs].reverse().map((item) => ({ id: item, grant: { type: 'item', item, quantity: { min: 2, max: 2 } } })),
  ...['z_gear', 'a_gear'].map((id) => ({ id, grant: { type: 'equipment', selector: { definitionKeys: [gearKey] } } })),
] });
type Actions = NonNullable<DungeonDefinitionInput['rooms'][number]['actions']>;
const treasure = (rewards = full()): Actions[number] => ({ id: 'pay', type: 'reward', rewards });
const fight = (type: 'combat' | 'boss', enemies = ['grunt'], extra: Record<string, unknown> = {}): Actions[number] => ({
  id: 'fight', type, waves: enemies.map((key) => ({ enemy: { key } })), rewards: full(), ...extra,
});
let n = 0;
async function publish(actions: Actions = [treasure()], patch: (d: DungeonDefinitionInput) => void = () => {}) {
  const definition = singleRoomDungeon(actions, (d) => {
    d.key = `t10_${++n}`;
    d.rooms[0]!.extraction = true;
    d.settings!.defeatCurrencyRetentionBasisPoints = 5000;
    patch(d);
  });
  await w.publish(definition);
  return definition;
}
const rowOf = async (runId: number) => (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!;
const wallet = (playerId: number) => w.app.currency.getBalances(playerId);
const gearRows = (playerId: number) => w.t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId)).orderBy(asc(playerEquipment.id));
const gearProps = (g: { rolledMultiplierBp: number; affixKey?: string | null | undefined; combatBonuses?: unknown[] | undefined }) => ({
  rolledMultiplierBp: g.rolledMultiplierBp, affixKey: g.affixKey, combatBonuses: g.combatBonuses,
});
async function databaseState(playerId: number, runId: number) {
  return {
    run: await rowOf(runId), wallet: await wallet(playerId), equipment: await gearRows(playerId),
    equipmentEvents: await w.t.db.select().from(equipmentEvents).where(eq(equipmentEvents.playerId, playerId)).orderBy(asc(equipmentEvents.id)),
    inventory: await w.t.db.select().from(playerInventory).where(eq(playerInventory.playerId, playerId)).orderBy(asc(playerInventory.itemId)),
    copies: await w.t.db.select().from(playerWaifus).where(eq(playerWaifus.playerId, playerId)).orderBy(asc(playerWaifus.id)),
    history: await w.runs.history(runId),
    ledger: await w.t.db.select().from(progressionCurrencyLedger).where(eq(progressionCurrencyLedger.playerId, playerId)).orderBy(asc(progressionCurrencyLedger.id)),
  };
}
async function begin(actions: Actions = [treasure()], patch: (d: DungeonDefinitionInput) => void = () => {}) {
  const definition = await publish(actions, patch);
  const { playerId, buddyId } = await w.player();
  const start = await w.runs.start(playerId, definition.key, { seed: 42 });
  return { definition, playerId, buddyId: buddyId!, start };
}
const advance = async (playerId: number, run: DungeonRunView) => (await w.act(playerId, run, { type: 'advance' })).run;

beforeAll(async () => {
  w = await createDungeonWorld({ logger, equipment: { combatBonuses: () => bonuses }, combatRules: { ...FIXED_RULES, maxRounds: 5 } });
  await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
  await w.svc.definitions.create({ key: gearKey, name: 'T10 Gear', slot: 'attack', rarity: 'SR', multiplierMinBp: 4000, multiplierMaxBp: 6000, multiplierStepBp: 500 });
  for (const [i, slug] of rewardSlugs.entries()) {
    await w.t.db.insert(items).values({ slug, name: slug, category: ['capture', 'material', 'salvage'][i]!, enabled: true });
  }
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await w?.cleanup(); });

describe('committed v2 activity rewards', () => {
  it.each(['combat', 'boss', 'treasure'] as const)('%s grants every secured type in order, leaving both currencies at risk', async (type) => {
    const { playerId, buddyId, start } = await begin([type === 'treasure' ? treasure() : fight(type)]);
    const before = await databaseState(playerId, start.id);
    const order: string[] = [];
    const essence = w.app.currency.grantEssence.bind(w.app.currency);
    const item = w.app.inventory.addItem.bind(w.app.inventory);
    const gear = w.svc.equipment.grantEquipment.bind(w.svc.equipment);
    const bond = w.app.collection.awardCopyAffection.bind(w.app.collection);
    vi.spyOn(w.app.currency, 'grantEssence').mockImplementation(async (...args) => { order.push('essence'); return essence(...args); });
    vi.spyOn(w.app.inventory, 'addItem').mockImplementation(async (...args) => { order.push(`item:${args[2]}`); return item(...args); });
    vi.spyOn(w.svc.equipment, 'grantEquipment').mockImplementation(async (...args) => { order.push(`gear:${args[1].grantKey}`); return gear(...args); });
    vi.spyOn(w.app.collection, 'awardCopyAffection').mockImplementation(async (...args) => { order.push('affection'); return bond(...args); });
    const run = await advance(playerId, start);
    const stored = await rowOf(run.id);
    const claimKey = `run:${run.id}:hall:${type === 'treasure' ? 'pay' : 'fight'}`;
    const plan = stored.rewardClaims[claimKey];
    expect(plan).toMatchObject({ v: 2, atRisk: { shards: 45, waifubux: 501 } });
    expect(run.core).toMatchObject({ unbankedCurrency: 45, unbankedWaifubux: 501 });
    expect(await wallet(playerId)).toMatchObject({ waifubux: before.wallet.waifubux, essence: before.wallet.essence + 7 });
    expect(await w.balance(playerId)).toBe(0);
    expect(order[0]).toBe('essence');
    expect(order.at(-1)).toBe('affection');
    const itemRows = await w.t.db.select().from(items).where(eq(items.enabled, true));
    expect(order.slice(1, 4)).toEqual(rewardSlugs.map((slug) => `item:${itemRows.find((r) => r.slug === slug)!.id}`));
    expect(order.slice(4, 6)).toEqual([`gear:dungeon:${claimKey}:g:a_gear`, `gear:dungeon:${claimKey}:g:z_gear`]);
    for (const slug of rewardSlugs) expect(await w.app.inventory.getQuantity(playerId, itemRows.find((r) => r.slug === slug)!.id)).toBe(2);
    const securedGear = run.secured.filter((r) => r.kind === 'equipment');
    expect(securedGear).toHaveLength(2);
    expect(securedGear[0]!.rollSeed).not.toBe(securedGear[1]!.rollSeed);
    expect(securedGear.every((r) => r.combatBonuses?.length === 2)).toBe(true);
    expect(run.secured).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'essence', granted: 7, bonus: 'pinned' }),
      expect.objectContaining({ kind: 'affection', waifuId: buddyId, granted: 3, affectionAfter: before.copies[0]!.affection + 3 }),
    ]));
    const after = await databaseState(playerId, run.id);
    expect(after.equipment).toHaveLength(before.equipment.length + 2);
    expect(after.equipmentEvents).toHaveLength(before.equipmentEvents.length + 2);
    expect(after.copies[0]).toMatchObject({ affection: before.copies[0]!.affection + 3, level: before.copies[0]!.level, xp: before.copies[0]!.xp });
    const history = after.history.filter((e) => e.type === 'rewards_granted');
    expect(history).toHaveLength(1);
    expect(history[0]!.payload).toMatchObject({ v: 2, claimKey, atRisk: { shards: 45, waifubux: 501 }, essence: { granted: 7 }, affection: { waifuId: buddyId } });
    expect((await w.act(playerId, start, { type: 'advance' })).refusal).toBe('stale');
    expect(await databaseState(playerId, run.id)).toEqual(after);
    const reloaded = await w.restartedRuns().run(playerId, run.id);
    expect(reloaded.core).toEqual(run.core);
    expect(reloaded.secured).toEqual(run.secured);
  });

  it.each(['combat', 'boss'] as const)('%s uses every reward mode from its embedded table after edit/archive and republish', async (type) => {
    const tables = createDungeonLootTableService({ db: w.t.db });
    const body = DungeonLootTableBodySchema.parse({ chances: [],
      pools: [{ id: 'salvage_pool', name: 'Salvage', draws: 1, entries: [{ id: 'salvage', weight: 1, grant: { type: 'item', item: rewardSlugs[2], quantity: { min: 1, max: 1 } } }] }],
      guaranteed: [{ id: 'essence', grant: currency('essence', 9) }],
    });
    const table = await tables.create({ key: `t10_table_${++n}`, name: 'Pinned', body }, 'test');
    const rewards = DungeonRewardBundleSchema.parse({
      guaranteed: full().guaranteed.filter((g) => g.grant.type !== 'currency' || g.grant.currency === 'shards'),
      chances: [{ id: 'bux', chanceBasisPoints: 9999, grant: currency('waifubux', 501) }, { id: 'miss', chanceBasisPoints: 1, grant: currency('essence', 99) }],
      tables: [{ id: 'loot', table: table.key, draws: 1 }],
    });
    const { playerId, definition, start } = await begin([fight(type, ['grunt'], { rewards })]);
    await tables.update(table.key, { expectedRevision: table.revision, body: DungeonLootTableBodySchema.parse({ chances: [], pools: [], guaranteed: [{ id: 'essence', grant: currency('essence', 90) }] }) }, 'test');
    await w.republish(definition);
    await tables.archive(table.key, { expectedRevision: table.revision + 1 }, 'test');
    const before = await wallet(playerId);
    const run = await advance(playerId, start);
    expect(run.dungeon.revision).toBe(1);
    expect((await wallet(playerId)).essence).toBe(before.essence + 9);
    expect(run.core).toMatchObject({ unbankedCurrency: 45, unbankedWaifubux: 501 });
    expect(run.atRisk).toEqual({ shards: 45, waifubux: 501 });
    expect(run.secured).toHaveLength(7);
    const plan = (await rowOf(run.id)).rewardClaims[`run:${run.id}:hall:fight`];
    expect(plan).toMatchObject({ lines: expect.arrayContaining([expect.objectContaining({ dropId: 'c:miss', hit: false, missReason: 'chance_missed' })]) });
    expect(plan).toMatchObject({ lines: expect.arrayContaining([expect.objectContaining({ mode: 'pool', source: 'table', hit: true })]) });
  });

  it.each(['essence_gain', 'affection_gain'] as const)('pins %s despite Buddy switching and later bonus edits', async (effectId) => {
    const { playerId, buddyId } = await w.player();
    const [copy] = await w.t.db.select().from(playerWaifus).where(eq(playerWaifus.id, buddyId!));
    const [meta] = await w.t.db.select().from(speciesTable).where(eq(speciesTable.id, copy!.speciesId));
    const species = w.app.content.species.find((s) => s.slug === meta!.slug)!;
    const original = species.buddyBonus;
    species.buddyBonus = { name: 'Pinned bonus', flavorText: '', effectId, value: 25 };
    try {
      const definition = await publish();
      const start = await w.runs.start(playerId, definition.key, { seed: 42 });
      const other = await insertOwnedWaifu(w.t.db, { playerId, speciesId: copy!.speciesId });
      await w.app.collection.setBuddy(playerId, other.id);
      species.buddyBonus = { name: 'Edited', flavorText: '', effectId, value: 100 };
      const before = await wallet(playerId);
      const run = await advance(playerId, start);
      expect(run.secured.find((r) => r.kind === 'essence')).toMatchObject({ granted: effectId === 'essence_gain' ? 9 : 7 });
      expect((await wallet(playerId)).essence).toBe(before.essence + (effectId === 'essence_gain' ? 9 : 7));
      expect(run.secured.find((r) => r.kind === 'affection')).toMatchObject({ waifuId: buddyId, granted: effectId === 'affection_gain' ? 4 : 3 });
      expect((await w.t.db.select().from(playerWaifus).where(eq(playerWaifus.id, other.id)))[0]!.affection).toBe(other.affection);
    } finally { species.buddyBonus = original; }
  });

  it('uses base amounts and not_pinned receipts on a historical fighter snapshot', async () => {
    const { playerId, start } = await begin();
    const fighter = { ...start.fighter };
    delete fighter.rewardBonuses;
    await w.t.db.update(dungeonRuns).set({ fighter: fighter as unknown as Record<string, unknown> }).where(eq(dungeonRuns.id, start.id));
    const run = await advance(playerId, start);
    expect(run.secured.find((r) => r.kind === 'essence')).toMatchObject({ granted: 7, bonus: 'not_pinned', bonusPercent: 0 });
    expect(run.secured.find((r) => r.kind === 'affection')).toMatchObject({ granted: 3, bonus: 'not_pinned', bonusPercent: 0 });
  });

  it('replays a committed equipment grant key as the original stored instance', async () => {
    const { playerId, start } = await begin();
    const run = await advance(playerId, start);
    const original = run.secured.find((r) => r.kind === 'equipment')!;
    const rewards = createEquipmentRewardService({ equipment: w.svc.equipment, getAffixes: w.svc.getAffixes, featureUnlocks: w.svc.featureUnlocks });
    const before = await databaseState(playerId, run.id);
    const replay = await w.t.db.transaction((tx) => rewards.grantChosenEquipmentReward(tx, {
      playerId, definitionKey: 'missing_on_replay', rollSeed: 123,
      source: { type: 'dungeon', key: run.dungeon.key }, grantKey: `dungeon:run:${run.id}:hall:pay:${original.dropId}`,
    }));
    expect(replay).toMatchObject({ equipmentId: original.equipmentId, alreadyGranted: true, ...gearProps(original) });
    expect(await databaseState(playerId, run.id)).toEqual(before);
  });
});

describe('atomic failures and deterministic retry', () => {
  it.each(['essence', 'item', 'equipment', 'affection'] as const)('failure after the %s write rolls back every database effect', async (stage) => {
    const { playerId, start } = await begin();
    const before = await databaseState(playerId, start.id);
    const originalGear = w.svc.equipment.grantEquipment.bind(w.svc.equipment);
    const rolled: ReturnType<typeof gearProps>[] = [];
    vi.spyOn(w.svc.equipment, 'grantEquipment').mockImplementation(async (...args) => {
      const result = await originalGear(...args);
      rolled.push(...result.instances.map(gearProps));
      if (stage === 'equipment' && rolled.length === 1) throw new Error('injected after equipment');
      return result;
    });
    if (stage === 'essence') {
      const original = w.app.currency.grantEssence.bind(w.app.currency);
      vi.spyOn(w.app.currency, 'grantEssence').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('injected after essence'); });
    } else if (stage === 'item') {
      const original = w.app.inventory.addItem.bind(w.app.inventory);
      vi.spyOn(w.app.inventory, 'addItem').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('injected after item'); });
    } else if (stage === 'affection') {
      const original = w.app.collection.awardCopyAffection.bind(w.app.collection);
      vi.spyOn(w.app.collection, 'awardCopyAffection').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('injected after affection'); });
    }
    await expect(advance(playerId, start)).rejects.toBeInstanceOf(DungeonRewardGrantError);
    expect(await databaseState(playerId, start.id)).toEqual(before);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ tag: 'dungeons/reward-grant-failed', runId: start.id, claimKey: `run:${start.id}:hall:pay`, dependency: expect.any(String) }), expect.any(String));
    const expectedRolls = [...rolled];
    vi.restoreAllMocks();
    const retry = await advance(playerId, start);
    const received = retry.secured.filter((r) => r.kind === 'equipment').map(gearProps);
    expect(received.slice(0, expectedRolls.length)).toEqual(expectedRolls);
    expect(retry.core).toMatchObject({ unbankedCurrency: 45, unbankedWaifubux: 501 });
    expect((await w.runs.history(start.id)).filter((r) => r.type === 'rewards_granted')).toHaveLength(1);
    const pinned = await w.content.revisionById(w.t.db, before.run.revisionId);
    expect((await rowOf(start.id)).rewardClaims[`run:${start.id}:hall:pay`]).toEqual(resolveRewardBundle(full(), rewardResolverSnapshot(pinned!.rewards!), 42, { roomId: 'hall', actionId: 'pay' }));
  });

  it.each(['missing_item', 'deleted_item', 'capped_item', 'deleted_equipment', 'released_copy', 'missing_copy'] as const)('%s aborts atomically and can be repaired for retry', async (problem) => {
    const rewards = full();
    const slug = problem === 'deleted_item' ? `t10_deleted_item_${++n}` : rewardSlugs[0]!;
    const definitionKey = problem === 'deleted_equipment' ? `t10_deleted_gear_${++n}` : gearKey;
    if (problem === 'deleted_item') {
      await w.t.db.insert(items).values({ slug, name: 'Deleted Prize', category: 'material' });
      for (const g of rewards.guaranteed) if (g.grant.type === 'item' && g.grant.item === rewardSlugs[0]) g.grant.item = slug;
    }
    if (problem === 'deleted_equipment') {
      await w.svc.definitions.create({ key: definitionKey, name: 'Deleted Gear', slot: 'attack', rarity: 'SR', multiplierMinBp: 4000, multiplierMaxBp: 6000, multiplierStepBp: 500 });
      for (const g of rewards.guaranteed) if (g.grant.type === 'equipment') g.grant.selector.definitionKeys = [definitionKey];
    }
    const { playerId, buddyId, start } = await begin([treasure(rewards)]);
    const [item] = await w.t.db.select().from(items).where(eq(items.slug, slug));
    const [gear] = await w.t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, definitionKey));
    const [copy] = await w.t.db.select().from(playerWaifus).where(eq(playerWaifus.id, buddyId));
    if (problem === 'missing_item') await w.t.db.update(items).set({ slug: `${slug}_removed` }).where(eq(items.id, item!.id));
    if (problem === 'capped_item') await w.t.db.update(items).set({ maxOwned: 999 }).where(eq(items.id, item!.id));
    if (problem === 'deleted_equipment') await w.t.db.delete(equipmentDefinitions).where(eq(equipmentDefinitions.id, gear!.id));
    if (problem === 'deleted_item') await w.t.db.delete(items).where(eq(items.id, item!.id));
    if (problem === 'released_copy') await w.t.db.update(playerWaifus).set({ releasedAt: new Date() }).where(eq(playerWaifus.id, buddyId));
    if (problem === 'missing_copy') await w.t.db.update(dungeonRuns).set({ fighter: { ...start.fighter, waifuId: 99999999 } }).where(eq(dungeonRuns.id, start.id));
    const before = await databaseState(playerId, start.id);
    try {
      const err = await advance(playerId, start).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DungeonRewardGrantError);
      if (!(err instanceof DungeonRewardGrantError)) throw err;
      expect(err).toMatchObject({ userMessage: expect.stringContaining('progress has not advanced') });
      expect(mapAppErrorToStatus(err)).toBe(503);
      expect(toErrorBody(err, 503, 'retry')).toMatchObject({ error: { code: 'DUNGEON_REWARD_GRANT_FAILED', message: expect.stringContaining('progress has not advanced') } });
      expect(await databaseState(playerId, start.id)).toEqual(before);
    } finally {
      if (problem === 'missing_item') await w.t.db.update(items).set({ slug }).where(eq(items.id, item!.id));
      if (problem === 'capped_item') await w.t.db.update(items).set({ maxOwned: null }).where(eq(items.id, item!.id));
      if (problem === 'deleted_equipment') {
        const { id: _id, ...data } = gear!;
        await w.t.db.insert(equipmentDefinitions).values(data);
      }
      if (problem === 'deleted_item') {
        const { id: _id, ...data } = item!;
        await w.t.db.insert(items).values(data);
      }
      if (problem === 'released_copy') await w.t.db.update(playerWaifus).set({ releasedAt: copy!.releasedAt }).where(eq(playerWaifus.id, buddyId));
      if (problem === 'missing_copy') await w.t.db.update(dungeonRuns).set({ fighter: start.fighter as unknown as Record<string, unknown> }).where(eq(dungeonRuns.id, start.id));
    }
    expect((await advance(playerId, start)).secured).toHaveLength(7);
  });

  it.each(['missing', 'invalid_hash', 'incompatible', 'gameplay_mismatch', 'stored_schema_invalid'] as const)('%s snapshot cannot advance or grant', async (problem) => {
    const { playerId, start } = await begin();
    const before = await databaseState(playerId, start.id);
    const original = w.content.revisionById.bind(w.content);
    vi.spyOn(w.content, 'revisionById').mockImplementation(async (...args) => {
      if (problem === 'stored_schema_invalid') throw new DungeonInvalidError([
        { code: 'reward_snapshot_invalid', path: 'rewardSnapshot.resolverVersion', severity: 'error', message: 'stored version is incompatible' },
      ]);
      const result = (await original(...args))!;
      return { ...result,
        ...(problem === 'gameplay_mismatch' ? { revision: { ...result.revision, gameplayHash: 'invalid' } } : {}),
        rewards: problem === 'missing' ? null : {
        ...result.rewards!, ...(problem === 'invalid_hash' ? { hash: `sha256:${'0'.repeat(64)}` } : problem === 'incompatible' ? { resolverVersion: 2 } : {}),
      } as typeof result.rewards };
    });
    await expect(advance(playerId, start)).rejects.toMatchObject({ code: 'DUNGEON_REWARD_GRANT_FAILED', dependency: 'reward_snapshot' });
    expect(await databaseState(playerId, start.id)).toEqual(before);
    vi.restoreAllMocks();
    expect((await advance(playerId, start)).step).toBe(start.step + 1);
  });
});

describe('settlement and concurrency', () => {
  it.each([
    ['extract', undefined, 45, 501], ['complete', undefined, 45, 501],
    ['defeat', undefined, 22, 250], ['stalemate', undefined, 22, 250], ['scripted', undefined, 22, 250],
    ['abandon', 0, 0, 0], ['abandon', 2000, 9, 100], ['abandon', undefined, 22, 250],
  ] as const)('%s (abandon=%s) banks only earned currency at the configured rate', async (outcome, abandon, shards, bux) => {
    const endAction: Actions[number] = outcome === 'scripted'
      ? { id: 'end', type: 'gate', requires: { type: 'flag', flag: 'lever' }, outcomes: { blocked: { type: 'end_run', outcome: 'defeated' } } }
      : fight('combat', [outcome === 'stalemate' ? 'wall' : 'brute']);
    const { playerId, start } = await begin([treasure(), endAction], (d) => {
      if (abandon !== undefined) d.settings!.abandonCurrencyRetentionBasisPoints = abandon;
      if (outcome === 'complete') d.rooms[0]!.actions = [treasure({ ...full() }), { id: 'finish', type: 'reward', rewards: DungeonRewardBundleSchema.parse({ guaranteed: [], chances: [], tables: [] }), outcomes: { claimed: { type: 'end_run', outcome: 'completed' } } }];
      if (outcome === 'extract' || outcome === 'abandon') d.rooms[0]!.actions = [treasure()];
    });
    await w.t.db.transaction(async (tx) => {
      await w.app.currency.grantWaifubux(tx, playerId, 1234);
      await w.currencies.grant(tx, { playerId, currencyKey: CURRENCY, amount: 100, reason: 'admin_grant', requestKey: `baseline:${playerId}` });
    });
    const balance = (await wallet(playerId)).waifubux;
    let run = await advance(playerId, start);
    const secured = run.secured;
    if (run.status === 'active') {
      expect((await wallet(playerId)).waifubux).toBe(balance);
      run = (await w.act(playerId, run, { type: outcome === 'extract' ? 'extract' : outcome === 'abandon' ? 'abandon' : 'advance' })).run;
    }
    expect(run.settlement).toMatchObject({ earned: 45, banked: shards, lost: 45 - shards, waifubux: { earned: 501, banked: bux, lost: 501 - bux } });
    expect((await wallet(playerId)).waifubux).toBe(balance + bux);
    expect(await w.balance(playerId)).toBe(100 + shards);
    expect(run.core).toMatchObject({ unbankedCurrency: 0, unbankedWaifubux: 0 });
    expect(run.secured).toEqual(secured);
    const before = await databaseState(playerId, run.id);
    for (let i = 0; i < 2; i++) expect((await w.act(playerId, run, { type: 'abandon' })).refusal).toBe('run_over');
    expect(await databaseState(playerId, run.id)).toEqual(before);
    if (shards > 0) expect(before.ledger.find((l) => l.requestKey === `dungeon_run:v1:${run.id}:settlement`)).toMatchObject({ delta: shards });
  });

  it.each(['shards', 'waifubux'] as const)('failure after %s banking rolls back both wallets and the ending transition', async (stage) => {
    const { playerId, start } = await begin();
    const run = await advance(playerId, start);
    const before = await databaseState(playerId, run.id);
    if (stage === 'shards') {
      const original = w.currencies.grant.bind(w.currencies);
      vi.spyOn(w.currencies, 'grant').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('injected shards'); });
    } else {
      const original = w.app.currency.grantWaifubux.bind(w.app.currency);
      vi.spyOn(w.app.currency, 'grantWaifubux').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('injected bux'); });
    }
    await expect(w.act(playerId, run, { type: 'extract' })).rejects.toMatchObject({ code: 'DUNGEON_REWARD_GRANT_FAILED' });
    expect(await databaseState(playerId, run.id)).toEqual(before);
    vi.restoreAllMocks();
    expect((await w.act(playerId, run, { type: 'extract' })).run.settlement).toMatchObject({ banked: 45, waifubux: { banked: 501 } });
  });

  it('grant and settlement in the same victory transaction roll back together', async () => {
    const { playerId, start } = await begin([fight('boss', ['grunt'], { outcomes: { victory: { type: 'end_run', outcome: 'completed' } } })]);
    const before = await databaseState(playerId, start.id);
    vi.spyOn(w.app.currency, 'grantWaifubux').mockRejectedValueOnce(new Error('settlement unavailable'));
    await expect(advance(playerId, start)).rejects.toBeInstanceOf(DungeonRewardGrantError);
    expect(await databaseState(playerId, start.id)).toEqual(before);
    vi.restoreAllMocks();
    const end = await advance(playerId, start);
    expect(end.settlement).toMatchObject({ banked: 45, waifubux: { banked: 501 } });
    expect(end.secured).toHaveLength(7);
  });

  it('concurrent same-step rewards and concurrent settlements pay once', async () => {
    const { playerId, start } = await begin();
    const before = await wallet(playerId);
    const rewards = await Promise.all(Array.from({ length: 4 }, () => w.act(playerId, start, { type: 'advance' })));
    expect(rewards.filter((r) => r.status === 'applied')).toHaveLength(1);
    const run = rewards.find((r) => r.status === 'applied')!.run;
    const ends = await Promise.all(Array.from({ length: 4 }, () => w.act(playerId, run, { type: 'extract' })));
    expect(ends.filter((r) => r.status === 'applied')).toHaveLength(1);
    expect(await wallet(playerId)).toMatchObject({ essence: before.essence + 7, waifubux: before.waifubux + 501 });
    expect(await w.balance(playerId)).toBe(45);
    expect((await w.runs.history(run.id)).filter((e) => e.type === 'rewards_granted')).toHaveLength(1);
    expect(await w.t.db.select().from(progressionCurrencyLedger).where(eq(progressionCurrencyLedger.requestKey, `dungeon_run:v1:${run.id}:settlement`))).toHaveLength(1);
  });

  it('retreat, re-entry and restart never remint rewards or bank an idle run', async () => {
    const { playerId, start } = await begin([], (d) => {
      d.rooms.push({ id: 'loot', actions: [{ ...treasure(), outcomes: { claimed: { type: 'retreat' } } }] });
      d.connections!.push({ id: 'to_loot', from: 'hall', to: 'loot' });
    });
    let run = (await w.act(playerId, start, { type: 'move', connectionId: 'to_loot' })).run;
    run = await advance(playerId, run);
    const after = await databaseState(playerId, run.id);
    for (let i = 0; i < 3; i++) {
      run = await w.restartedRuns().run(playerId, run.id);
      run = (await w.act(playerId, run, { type: 'move', connectionId: 'to_loot' })).run;
      run = await advance(playerId, run);
    }
    const end = await databaseState(playerId, run.id);
    expect(end.wallet).toEqual(after.wallet);
    expect(end.equipment).toEqual(after.equipment);
    expect(end.copies).toEqual(after.copies);
    expect(end.run.rewardClaims).toEqual(after.run.rewardClaims);
    expect(end.run).toMatchObject({ status: 'active', unbankedCurrency: 45, unbankedWaifubux: 501, settlement: null });
    expect(end.ledger).toEqual([]);
    expect(end.history.filter((e) => e.type === 'rewards_granted')).toHaveLength(1);
  });

  it('keeps the missing/disabled progression policy while banking independent WaifuBux', async () => {
    const { playerId, start } = await begin();
    const run = await advance(playerId, start);
    const before = await wallet(playerId);
    await w.t.db.update(progressionCurrencies).set({ enabled: false }).where(eq(progressionCurrencies.currencyKey, CURRENCY));
    try {
      const end = (await w.act(playerId, run, { type: 'extract' })).run;
      expect(end.settlement).toMatchObject({ bankingSkipped: 'currency_disabled', banked: 0, lost: 45, waifubux: { banked: 501, lost: 0 } });
      expect((await wallet(playerId)).waifubux).toBe(before.waifubux + 501);
    } finally { await w.t.db.update(progressionCurrencies).set({ enabled: true }).where(eq(progressionCurrencies.currencyKey, CURRENCY)); }
  });
});

describe('wave eligibility and promised definitions', () => {
  it.each(['combat', 'boss'] as const)('%s intermediate waves do not grant; final wave does', async (type) => {
    const { playerId, start } = await begin([fight(type, ['grunt', 'grunt'], { advance: 'confirm' })]);
    const before = await wallet(playerId);
    const intermediate = await advance(playerId, start);
    expect(intermediate.secured).toEqual([]);
    expect((await rowOf(start.id)).rewardClaims).toEqual({});
    expect(await wallet(playerId)).toEqual(before);
    expect((await advance(playerId, intermediate)).secured).toHaveLength(7);
  });
  it.each(['brute', 'wall'])('%s loses after a won wave without claiming', async (enemy) => {
    const { playerId, start } = await begin([fight('boss', ['grunt', enemy], { advance: 'auto' })]);
    const before = await wallet(playerId);
    const end = await advance(playerId, start);
    expect(end.status).toBe('defeated');
    expect(end.secured).toEqual([]);
    expect((await rowOf(start.id)).rewardClaims).toEqual({});
    expect(await wallet(playerId)).toEqual(before);
  });
  it('honors disabled items and equipment promised by the pinned snapshot', async () => {
    const { playerId, start } = await begin();
    await w.t.db.update(equipmentDefinitions).set({ enabled: false }).where(eq(equipmentDefinitions.key, gearKey));
    await w.t.db.update(items).set({ enabled: false }).where(eq(items.slug, rewardSlugs[0]!));
    try { expect((await advance(playerId, start)).secured).toHaveLength(7); }
    finally {
      await w.t.db.update(equipmentDefinitions).set({ enabled: true }).where(eq(equipmentDefinitions.key, gearKey));
      await w.t.db.update(items).set({ enabled: true }).where(eq(items.slug, rewardSlugs[0]!));
    }
  });
});

describe('migration 0064 schema', () => {
  it('upgrades a real 0063 run to zero WaifuBux without rewriting its row or wallet', async () => {
    const folder = path.resolve(__dirname, '../../drizzle');
    const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-t10-upgrade-'));
    fs.mkdirSync(path.join(temporary, 'meta'));
    const earlier = journal.entries.filter((e: { idx: number }) => e.idx < 64);
    fs.writeFileSync(path.join(temporary, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: earlier }));
    for (const entry of earlier) fs.copyFileSync(path.join(folder, `${entry.tag}.sql`), path.join(temporary, `${entry.tag}.sql`));
    const databaseName = `waifumon_t10_upgrade_${randomBytes(6).toString('hex')}`;
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
      const guild = (await pool.query("INSERT INTO guilds (discord_guild_id) VALUES ('upgrade') RETURNING id")).rows[0].id;
      const player = (await pool.query("INSERT INTO players (guild_id,discord_user_id) VALUES ($1,'upgrade') RETURNING id", [guild])).rows[0].id;
      await pool.query('INSERT INTO player_currencies (player_id,waifubux,essence) VALUES ($1,12345,678)', [player]);
      await pool.query("INSERT INTO dungeon_definitions (dungeon_key,draft,draft_hash) VALUES ('upgrade','{}','hash')");
      const revision = (await pool.query("INSERT INTO dungeon_revisions (dungeon_key,content,number,content_hash,draft_revision) VALUES ('upgrade','{}',1,'hash',1) RETURNING id")).rows[0].id;
      await pool.query("INSERT INTO dungeon_runs (player_id,dungeon_key,revision_id,seed,cursor,current_hp,fighter,dependency_snapshot,unbanked_currency) VALUES ($1,'upgrade',$2,42,'{}',100,'{}','{}',45)", [player, revision]);
      const before = (await pool.query('SELECT xmin::text AS version,to_jsonb(r)::text AS row FROM dungeon_runs r')).rows;
      const walletBefore = (await pool.query('SELECT xmin::text AS version,to_jsonb(w)::text AS row FROM player_currencies w')).rows;
      await runMigrations(db, w.t.logger, folder);
      expect((await pool.query("SELECT xmin::text AS version,(to_jsonb(r)-'unbanked_waifubux'-'event_states'-'encounter_states')::text AS row FROM dungeon_runs r")).rows).toEqual(before);
      expect((await pool.query('SELECT xmin::text AS version,to_jsonb(w)::text AS row FROM player_currencies w')).rows).toEqual(walletBefore);
      expect((await pool.query('SELECT unbanked_currency,unbanked_waifubux FROM dungeon_runs')).rows).toEqual([{ unbanked_currency: 45, unbanked_waifubux: 0 }]);
      await runMigrations(db, w.t.logger, folder);
      expect((await pool.query('SELECT unbanked_waifubux FROM dungeon_runs')).rows).toEqual([{ unbanked_waifubux: 0 }]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it('adds the next journal entry with integer default zero, NOT NULL and nonnegative check', async () => {
    const journal = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../drizzle/meta/_journal.json'), 'utf8'));
    // No longer the newest migration (0065 follows it), so it is found by its own index.
    const head = journal.entries[64];
    expect(head).toMatchObject({ idx: 64, tag: '0064_dungeon_unbanked_waifubux' });
    expect(head.when).toBeGreaterThan(journal.entries[63].when);
    const { rows } = await w.t.pool.query("SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='dungeon_runs' AND column_name='unbanked_waifubux'");
    expect(rows).toEqual([{ data_type: 'integer', is_nullable: 'NO', column_default: '0' }]);
    const config = getTableConfig(dungeonRuns);
    expect(config.columns.find((c) => c.name === 'unbanked_waifubux')).toMatchObject({ notNull: true, default: 0 });
    expect(config.checks.map((c) => c.name)).toContain('dungeon_runs_unbanked_waifubux_check');
    const { playerId, start } = await begin();
    expect((await rowOf(start.id)).unbankedWaifubux).toBe(0);
    await expect(w.t.pool.query('UPDATE dungeon_runs SET unbanked_waifubux=-1 WHERE id=$1', [start.id])).rejects.toMatchObject({ constraint: 'dungeon_runs_unbanked_waifubux_check' });
    expect((await w.runs.run(playerId, start.id)).core.unbankedWaifubux).toBe(0);
    const { rows: grantKeys } = await w.t.pool.query("SELECT data_type,character_maximum_length FROM information_schema.columns WHERE table_name='player_equipment' AND column_name='grant_key'");
    expect(grantKeys).toEqual([{ data_type: 'text', character_maximum_length: null }]);
  });
});
