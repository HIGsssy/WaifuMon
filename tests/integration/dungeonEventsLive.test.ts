/**
 * Dungeon events in live runs, against a real database: migration 0065,
 * persisted selections, transactional item use and rewards, retries,
 * published-revision pinning, settlement, publication and Reward Health —
 * and explicit event package versioning.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { and, asc, eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { DUNGEON_RUN_EVENT_TYPES, dungeonDefinitions, dungeonRevisions, dungeonRuns, items, playerInventory } from '../../src/db/schema';
import { DungeonDefinitionSchema, type DungeonDefinition, type DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import { readDungeonRewardSnapshot } from '../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonRunService';
import { rollEventCheck } from '../../src/modules/dungeons/engine/eventChecks';
import { resolveRewardBundle } from '../../src/modules/dungeons/engine/lootResolver';
import { rewardResolverSnapshot } from '../../src/modules/dungeons/engine/rewards';
import { createDungeonSandbox } from '../../src/modules/dungeons/engine/sandbox';
import { dungeonRngSource } from '../../src/modules/dungeons/engine/seeds';
import { startDungeonRun } from '../../src/modules/dungeons/engine/step';
import { buildDungeonPackage, dungeonContentHash } from '../../src/modules/dungeons/package/dungeonPackage';
import { DungeonEventItemUnavailableError, DungeonInvalidError, DungeonRewardGrantError } from '../../src/shared/errors';
import { VAULT_HOARD, eventContext, eventDungeonInput } from '../helpers/dungeonEventFixtures';
import { testDependencies, testDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';

let w: DungeonWorld;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let n = 0;
let itemIds: Record<string, number> = {};

beforeAll(async () => {
  w = await createDungeonWorld({ logger });
  await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
  const rows = await w.t.db.insert(items).values([
    { slug: 'vault_key', name: 'Vault Key', category: 'material', enabled: true },
    { slug: 'scrap_parts', name: 'Scrap Parts', category: 'material', enabled: true },
  ]).returning();
  itemIds = Object.fromEntries(rows.map((r) => [r.slug, r.id]));
  await createDungeonLootTableService({ db: w.t.db }).create({ key: 'vault_hoard', name: 'Vault hoard', body: VAULT_HOARD }, 'test');
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await w?.cleanup(); });

async function publishEvents(patch: (d: DungeonDefinitionInput) => void = () => {}): Promise<DungeonDefinition> {
  const input = eventDungeonInput(`ev_live_${++n}`);
  patch(input);
  await w.publish(input);
  return DungeonDefinitionSchema.parse(input);
}
/** The first seed whose opening hall draw is `eventId` (null: nothing). Selection needs no database. */
function seedWhereHallDraws(definition: DungeonDefinition, eventId: string | null, accept: (seed: number) => boolean = () => true): number {
  const ctx = eventContext(definition, { rewards: null });
  for (let seed = 0; seed < 5000; seed++) {
    if (startDungeonRun(ctx, seed).state.events!['hall:find']!.eventId === eventId && accept(seed)) return seed;
  }
  throw new Error(`no seed draws ${eventId}`);
}
const give = (playerId: number, slug: string, quantity: number) => w.app.inventory.addItem(w.t.db, playerId, itemIds[slug]!, quantity);
const held = async (playerId: number, slug: string) =>
  (await w.t.db.select().from(playerInventory).where(and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, itemIds[slug]!))))[0]?.quantity ?? 0;
const rowOf = async (runId: number) => (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!;
const historyTypes = async (runId: number) => (await w.runs.history(runId)).map((e) => e.type);
const choose = (playerId: number, run: DungeonRunView, choiceId: string) => w.act(playerId, run, { type: 'choose', choiceId });
const move = async (playerId: number, run: DungeonRunView, connectionId: string) => (await w.act(playerId, run, { type: 'move', connectionId })).run;
const choices = (run: DungeonRunView) => Object.fromEntries(run.core.action!.event!.choices.map((c) => [c.id, c]));

/** A player standing in front of the Sealed Vault, the hall behind them quiet. */
async function atVault(definition: DungeonDefinition, opts: { keys?: number; accept?: (seed: number) => boolean } = {}) {
  const { playerId } = await w.player();
  if (opts.keys) await give(playerId, 'vault_key', opts.keys);
  const seed = seedWhereHallDraws(definition, null, opts.accept);
  const start = await w.runs.start(playerId, definition.key, { seed });
  const run = await move(playerId, start, 'c_vault');
  expect(run.core.action).toMatchObject({ id: 'door', type: 'event', event: { eventId: 'sealed_vault' } });
  return { playerId, seed, start, run };
}

describe('migration 0065', () => {
  it('upgrades a database with a run in progress, leaving its row untouched but for the new column', async () => {
    const folder = path.resolve(__dirname, '../../drizzle');
    const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-0065-upgrade-'));
    fs.mkdirSync(path.join(temporary, 'meta'));
    const earlier = journal.entries.filter((e: { idx: number }) => e.idx < 65);
    fs.writeFileSync(path.join(temporary, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: earlier }));
    for (const entry of earlier) fs.copyFileSync(path.join(folder, `${entry.tag}.sql`), path.join(temporary, `${entry.tag}.sql`));
    const databaseName = `waifumon_0065_upgrade_${randomBytes(6).toString('hex')}`;
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
      await pool.query("INSERT INTO dungeon_definitions (dungeon_key,draft,draft_hash) VALUES ('upgrade','{}','hash')");
      const revision = (await pool.query("INSERT INTO dungeon_revisions (dungeon_key,content,number,content_hash,draft_revision) VALUES ('upgrade','{}',1,'hash',1) RETURNING id")).rows[0].id;
      const run = (await pool.query(
        "INSERT INTO dungeon_runs (player_id,dungeon_key,revision_id,seed,cursor,current_hp,fighter,dependency_snapshot,flags,unbanked_currency) VALUES ($1,'upgrade',$2,42,'{\"roomId\":\"a\"}',100,'{}','{}','{\"lever\":true}',45) RETURNING id",
        [player, revision],
      )).rows[0].id;
      await pool.query("INSERT INTO dungeon_run_events (run_id,player_id,step,type) VALUES ($1,$2,0,'run_started'),($1,$2,1,'rewards_granted')", [run, player]);
      // The types this migration adds are not accepted before it.
      await expect(pool.query("INSERT INTO dungeon_run_events (run_id,player_id,step,type) VALUES ($1,$2,2,'event_selected')", [run, player]))
        .rejects.toMatchObject({ constraint: 'dungeon_run_events_type_check' });
      const before = (await pool.query('SELECT xmin::text AS version,to_jsonb(r)::text AS row FROM dungeon_runs r')).rows;
      const historyBefore = (await pool.query('SELECT xmin::text AS version,to_jsonb(e)::text AS row FROM dungeon_run_events e ORDER BY id')).rows;

      await runMigrations(db, w.t.logger, folder);
      // Same row version, same content: the active run was not rewritten.
      expect((await pool.query("SELECT xmin::text AS version,(to_jsonb(r)-'event_states')::text AS row FROM dungeon_runs r")).rows).toEqual(before);
      expect((await pool.query('SELECT xmin::text AS version,to_jsonb(e)::text AS row FROM dungeon_run_events e ORDER BY id')).rows).toEqual(historyBefore);
      expect((await pool.query('SELECT status,flags,event_states FROM dungeon_runs')).rows).toEqual([{ status: 'active', flags: { lever: true }, event_states: {} }]);
      await pool.query("INSERT INTO dungeon_run_events (run_id,player_id,step,type) VALUES ($1,$2,2,'event_selected'),($1,$2,2,'items_consumed')", [run, player]);
      await expect(pool.query("INSERT INTO dungeon_run_events (run_id,player_id,step,type) VALUES ($1,$2,3,'bogus')", [run, player]))
        .rejects.toMatchObject({ constraint: 'dungeon_run_events_type_check' });
      // Applying it again is a no-op.
      await runMigrations(db, w.t.logger, folder);
      expect((await pool.query('SELECT event_states FROM dungeon_runs')).rows).toEqual([{ event_states: {} }]);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('is the next journal entry, and the schema matches what it creates', async () => {
    const journal = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../drizzle/meta/_journal.json'), 'utf8'));
    const entry = journal.entries.find((e: { tag: string }) => e.tag === '0065_dungeon_events');
    const previous = journal.entries.find((e: { tag: string }) => e.tag === '0064_dungeon_unbanked_waifubux');
    expect(entry).toMatchObject({ idx: 65, version: '7', breakpoints: true });
    expect(entry.when).toBeGreaterThan(previous.when);
    expect(journal.entries.map((e: { idx: number }) => e.idx)).toEqual(journal.entries.map((_: unknown, i: number) => i));
    const { rows } = await w.t.pool.query("SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='dungeon_runs' AND column_name='event_states'");
    expect(rows).toEqual([{ data_type: 'jsonb', is_nullable: 'NO', column_default: "'{}'::jsonb" }]);
    expect(getTableConfig(dungeonRuns).columns.find((c) => c.name === 'event_states')).toMatchObject({ notNull: true, default: {} });
    const { rows: check } = await w.t.pool.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='dungeon_run_events_type_check' AND conrelid='dungeon_run_events'::regclass");
    for (const type of DUNGEON_RUN_EVENT_TYPES) expect(check[0].def).toContain(`'${type}'`);
    expect(DUNGEON_RUN_EVENT_TYPES).toEqual(expect.arrayContaining(['event_selected', 'items_consumed']));
  });
});

describe('selection is persisted', () => {
  it('stores the entrance draw in the start transaction and shows it at once', async () => {
    const definition = await publishEvents();
    const { playerId } = await w.player();
    const seed = seedWhereHallDraws(definition, 'buried_crate');
    const start = await w.runs.start(playerId, definition.key, { seed });
    expect(start.core.action).toMatchObject({ id: 'find', type: 'event', event: { eventId: 'buried_crate', title: 'A Buried Crate' } });
    const row = await rowOf(start.id);
    expect(row.step).toBe(0);
    expect(row.eventStates).toMatchObject({ 'hall:find': { eventId: 'buried_crate', status: 'offered', selectedStep: 0, pool: { poolId: 'scrapheap_finds', entryId: 'e_crate', totalWeight: 100 } } });
    const history = await w.runs.history(start.id);
    expect(history.filter((e) => e.type === 'event_selected')).toEqual([
      expect.objectContaining({ step: 0, roomId: 'hall', actionId: 'find', payload: expect.objectContaining({ eventId: 'buried_crate', status: 'offered' }) }),
    ]);
    // On a first arrival there is nowhere to walk back to.
    expect(choices(start).leave).toMatchObject({ available: false, unavailableReason: 'no_way_back' });
  });

  it('survives a restart, a disconnect, a walk-away and a return, and is never drawn again', async () => {
    const definition = await publishEvents();
    const { playerId, run } = await atVault(definition);
    const stored = (await rowOf(run.id)).eventStates;
    expect(Object.keys(stored)).toEqual(['hall:find', 'vault:door']);

    // A new process, and plain re-reads, see the same event.
    const restarted = w.restartedRuns();
    expect((await restarted.run(playerId, run.id)).core.action!.event).toEqual(run.core.action!.event);
    expect((await restarted.activeRun(playerId))!.core.action!.event!.eventId).toBe('sealed_vault');
    expect((await w.runs.home(playerId)).activeRun!.core.action!.event!.eventId).toBe('sealed_vault');

    const away = await choose(playerId, run, 'leave');
    expect(away).toMatchObject({ status: 'applied', run: { core: { room: { id: 'hall' }, phase: 'connections' } } });
    expect((await rowOf(run.id)).eventStates).toEqual(stored);
    const back = await move(playerId, away.run, 'c_vault');
    expect(back.core.action!.event).toEqual(run.core.action!.event);
    expect((await rowOf(run.id)).eventStates).toEqual(stored);
    // One selection per event action, however often the room was entered or the run read.
    expect((await historyTypes(run.id)).filter((t) => t === 'event_selected')).toHaveLength(2);
  });

  it('never draws an event a second time in the same run', async () => {
    const definition = await publishEvents();
    let checked = 0;
    for (const first of ['buried_crate', 'scavenger_trader']) {
      const { playerId } = await w.player();
      const start = await w.runs.start(playerId, definition.key, { seed: seedWhereHallDraws(definition, first) });
      let run = (await choose(playerId, start, first === 'buried_crate' ? 'dig' : 'carry_on')).run;
      run = await move(playerId, run, 'c_vault');
      run = (await choose(playerId, run, 'force')).run;
      run = (await w.act(playerId, run, { type: 'advance' })).run;
      run = await move(playerId, run, 'c_heap');
      const heap = (await rowOf(run.id)).eventStates['heap:find'] as { eventId: string | null; pool: { eligible: string[] } };
      expect(heap.eventId).not.toBe(first);
      expect(heap.pool.eligible).not.toContain(first === 'buried_crate' ? 'e_crate' : 'e_trader');
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});

describe('one choice, one transaction', () => {
  it('spends the item, sets the flag and pays the reward together', async () => {
    const definition = await publishEvents();
    const { playerId, run, seed } = await atVault(definition, { keys: 2 });
    expect(choices(run).use_key).toMatchObject({ available: true, consumesOnSelect: true, items: [{ item: 'vault_key', quantity: 1, consume: true, owned: 2 }] });
    expect(run.eventItemNames).toEqual({ vault_key: 'Vault Key' });

    const result = await choose(playerId, run, 'use_key');
    expect(result.status).toBe('applied');
    expect(await held(playerId, 'vault_key')).toBe(1);
    expect(await held(playerId, 'scrap_parts')).toBe(2);
    const row = await rowOf(run.id);
    expect(row.flags).toEqual({ vault_opened: true });
    expect(row.unbankedCurrency).toBe(5);
    expect(row.eventStates['vault:door']).toMatchObject({ status: 'resolved', resolution: { choiceId: 'use_key', branch: 'outcome', step: run.step } });
    // The Phase 2 plan, from the pinned snapshot, under the existing claim key.
    const [revision] = await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, definition.key));
    const snapshot = readDungeonRewardSnapshot(revision!.rewardSnapshot)!;
    const bundle = definition.events![0]!.choices[0]!.outcome!.rewards!;
    const plan = resolveRewardBundle(bundle, rewardResolverSnapshot(snapshot), seed, { roomId: 'vault', actionId: 'door' });
    expect(row.rewardClaims).toEqual({ [`run:${run.id}:vault:door`]: plan });
    expect(result.run.latestSecured).toEqual([expect.objectContaining({ kind: 'item', slug: 'scrap_parts', quantity: 2 })]);
    expect(result.run.latestEvents).toEqual([{ roomId: 'vault', actionId: 'door', eventTitle: 'The Sealed Vault', choiceLabel: 'Use the Vault Key', text: 'The door rolls aside.', tone: 'good' }]);
    const history = (await w.runs.history(run.id)).filter((e) => e.step === row.step);
    expect(history.map((e) => e.type)).toEqual(expect.arrayContaining(['action_completed', 'items_consumed', 'rewards_granted']));
    expect(history.find((e) => e.type === 'items_consumed')!.payload).toEqual({ key: `run:${run.id}:vault:door:consume`, items: [{ item: 'vault_key', quantity: 1 }] });
    // The breather exists because the flag is set.
    expect(result.run.core.action).toMatchObject({ id: 'breather', type: 'rest' });
  });

  it('lets one of two racing choices win and refuses the other as stale', async () => {
    const definition = await publishEvents();
    const { playerId, run } = await atVault(definition, { keys: 1 });
    const results = await Promise.all([
      w.runs.act(playerId, run.id, { type: 'choose', choiceId: 'use_key', expectedStep: run.step }),
      w.runs.act(playerId, run.id, { type: 'choose', choiceId: 'force', expectedStep: run.step }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['applied', 'refused']);
    expect(results.find((r) => r.status === 'refused')!.refusal).toBe('stale');
    const row = await rowOf(run.id);
    const winner = (row.eventStates['vault:door'] as { resolution: { choiceId: string } }).resolution.choiceId;
    expect(row.step).toBe(run.step + 1);
    // Exactly the winner's consequences, none of the loser's.
    expect(await held(playerId, 'vault_key')).toBe(winner === 'use_key' ? 0 : 1);
    expect(row.currentHp).toBe(winner === 'force' ? run.core.hp - Math.trunc(run.core.maxHp * 0.25) : run.core.hp);
    expect(Object.keys(row.rewardClaims)).toHaveLength(winner === 'use_key' ? 1 : 0);
  });

  it('does not spend or pay twice when the same press arrives twice', async () => {
    const definition = await publishEvents();
    const { playerId, run } = await atVault(definition, { keys: 3 });
    const press = () => w.runs.act(playerId, run.id, { type: 'choose', choiceId: 'use_key', expectedStep: run.step });
    const results = await Promise.all([press(), press(), press()]);
    expect(results.map((r) => r.status).sort()).toEqual(['applied', 'refused', 'refused']);
    expect((await press()).refusal).toBe('stale');
    expect(await held(playerId, 'vault_key')).toBe(2);
    expect(await held(playerId, 'scrap_parts')).toBe(2);
    const row = await rowOf(run.id);
    expect(row.unbankedCurrency).toBe(5);
    expect(row.securedRewards).toHaveLength(1);
    const types = await historyTypes(run.id);
    expect(types.filter((t) => t === 'items_consumed')).toHaveLength(1);
    expect(types.filter((t) => t === 'rewards_granted')).toHaveLength(1);
    // A refused press repaints the committed result.
    expect(results.find((r) => r.status === 'refused')!.run.latestEvents![0]).toMatchObject({ choiceLabel: 'Use the Vault Key' });
  });

  it('refuses a choice whose item is gone before the press, changing nothing', async () => {
    const definition = await publishEvents();
    const { playerId, run } = await atVault(definition, { keys: 1 });
    await w.app.inventory.consumeItem(w.t.db, playerId, itemIds.vault_key!, 1);
    const before = await rowOf(run.id);
    const result = await choose(playerId, run, 'use_key');
    expect(result).toMatchObject({ status: 'refused', refusal: 'choice_unavailable' });
    expect(choices(result.run).use_key).toMatchObject({ available: false, unavailableReason: 'items', items: [{ owned: 0 }] });
    expect(await rowOf(run.id)).toEqual(before);
  });

  it('rolls the whole step back when the item is spent elsewhere mid-step, and stays playable', async () => {
    const definition = await publishEvents();
    const { playerId, run } = await atVault(definition, { keys: 1 });
    const before = { row: await rowOf(run.id), history: await w.runs.history(run.id) };
    const real = w.app.inventory.consumeItem.bind(w.app.inventory);
    // Another purchase lands between the engine's read and this step's own decrement.
    vi.spyOn(w.app.inventory, 'consumeItem').mockImplementationOnce(async (tx, player, itemId, quantity) => {
      await real(w.t.db, player, itemId, quantity);
      return real(tx, player, itemId, quantity);
    });
    const error = await choose(playerId, run, 'use_key').then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(DungeonEventItemUnavailableError);
    expect(error).toMatchObject({ code: 'DUNGEON_EVENT_ITEM_UNAVAILABLE', slug: 'vault_key', quantity: 1 });
    expect((error as DungeonEventItemUnavailableError).userMessage).toMatch(/Nothing was used and nothing changed/);
    expect(await rowOf(run.id)).toEqual(before.row);
    expect(await w.runs.history(run.id)).toEqual(before.history);
    expect(await held(playerId, 'scrap_parts')).toBe(0);

    // The event is still open, with that choice now unavailable and the others working.
    const again = await w.runs.run(playerId, run.id);
    expect(choices(again).use_key).toMatchObject({ available: false, unavailableReason: 'items' });
    expect((await choose(playerId, again, 'force')).status).toBe('applied');
  });

  it('rolls back the item, flag, HP, claim and event state when a reward cannot be delivered, then retries identically', async () => {
    // The lock check now pays a secured item on success, so a checked choice can fail in delivery.
    const definition = await publishEvents((d) => {
      const pick = d.events![0]!.choices[1]!;
      pick.items = [{ item: 'vault_key', quantity: 1, consume: true }];
      pick.success!.rewards = { guaranteed: [{ id: 'bolt', grant: { type: 'item', item: 'scrap_parts', quantity: { min: 1, max: 3 } } }], chances: [], tables: [] };
    });
    const sp = 185;
    const succeeds = (seed: number) =>
      rollEventCheck({ type: 'sp', baseChanceBasisPoints: 5500, maxSpModifierBasisPoints: 1500 }, sp, { roomId: 'vault', actionId: 'door', choiceId: 'pick_lock' }, dungeonRngSource(seed)).success;
    const { playerId, run, seed, start } = await atVault(definition, { keys: 1, accept: succeeds });
    expect(start.fighter.currentSp).toBe(sp);
    expect(choices(run).pick_lock).toMatchObject({ check: { chanceBasisPoints: 5350, sp }, consumesOnSelect: true });
    const expected = rollEventCheck({ type: 'sp', baseChanceBasisPoints: 5500, maxSpModifierBasisPoints: 1500 }, sp, { roomId: 'vault', actionId: 'door', choiceId: 'pick_lock' }, dungeonRngSource(seed));

    const before = { row: await rowOf(run.id), history: await w.runs.history(run.id), wallet: await w.app.currency.getBalances(playerId) };
    vi.spyOn(w.app.inventory, 'addItem').mockRejectedValueOnce(new Error('inventory is down'));
    await expect(choose(playerId, run, 'pick_lock')).rejects.toBeInstanceOf(DungeonRewardGrantError);
    // Everything the step did is gone: the key is back, nothing is flagged, healed, claimed or resolved.
    expect(await held(playerId, 'vault_key')).toBe(1);
    expect(await held(playerId, 'scrap_parts')).toBe(0);
    expect(await rowOf(run.id)).toEqual(before.row);
    expect(await w.runs.history(run.id)).toEqual(before.history);
    expect(await w.app.currency.getBalances(playerId)).toEqual(before.wallet);

    // The same press, once delivery works: the same roll and the same plan.
    const retried = await choose(playerId, run, 'pick_lock');
    expect(retried.status).toBe('applied');
    const row = await rowOf(run.id);
    expect((row.eventStates['vault:door'] as { resolution: unknown }).resolution).toEqual({ choiceId: 'pick_lock', branch: 'success', step: run.step, check: expected });
    const [revision] = await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, definition.key));
    const plan = resolveRewardBundle(definition.events![0]!.choices[1]!.success!.rewards!, rewardResolverSnapshot(readDungeonRewardSnapshot(revision!.rewardSnapshot)!), seed, { roomId: 'vault', actionId: 'door' });
    expect(row.rewardClaims).toEqual({ [`run:${run.id}:vault:door`]: plan });
    expect(await held(playerId, 'vault_key')).toBe(0);
    expect(await held(playerId, 'scrap_parts')).toBe(plan.secured.items[0]!.quantity);
    expect(row.flags).toEqual({ vault_opened: true });
  });

  it('spends the item even when the check fails', async () => {
    const definition = await publishEvents((d) => { d.events![0]!.choices[1]!.items = [{ item: 'vault_key', quantity: 1, consume: true }]; });
    const fails = (seed: number) =>
      !rollEventCheck({ type: 'sp', baseChanceBasisPoints: 5500, maxSpModifierBasisPoints: 1500 }, 185, { roomId: 'vault', actionId: 'door', choiceId: 'pick_lock' }, dungeonRngSource(seed)).success;
    const { playerId, run } = await atVault(definition, { keys: 1, accept: fails });
    const result = await choose(playerId, run, 'pick_lock');
    expect((await rowOf(run.id)).eventStates['vault:door']).toMatchObject({ resolution: { branch: 'failure', check: { success: false } } });
    expect(await held(playerId, 'vault_key')).toBe(0);
    expect((await rowOf(run.id)).flags).toEqual({ alarm_triggered: true });
    expect(result.run.core.recent).toContainEqual(expect.objectContaining({ kind: 'event', branch: 'failure', consumed: [{ item: 'vault_key', quantity: 1 }] }));
  });

  it('gives the same selection and check in the sandbox as in the live run', async () => {
    const definition = await publishEvents();
    const { playerId, run, seed, start } = await atVault(definition, { keys: 1 });
    const live = await choose(playerId, run, 'pick_lock');
    const sandbox = createDungeonSandbox({
      definition, dependencies: testDependencies(), rewards: eventContext(definition).rewards, seed,
      fighter: { waifuId: 0, name: 'Sandbox', attack: start.fighter.attack, defense: start.fighter.defense, maxHp: start.fighter.maxHp, currentSp: start.fighter.currentSp },
      inventory: { vault_key: 1 },
    });
    await sandbox.input({ type: 'move', connectionId: 'c_vault' });
    expect(sandbox.view.action!.event).toEqual(run.core.action!.event);
    await sandbox.input({ type: 'choose', choiceId: 'pick_lock' });
    expect(sandbox.state.events).toEqual((await rowOf(run.id)).eventStates);
    expect(sandbox.state.flags).toEqual(live.run.core.flags);
    expect(sandbox.state.hp).toBe(live.run.core.hp);
  });
});

describe('pinning and settlement', () => {
  it('keeps a run on the event it started with across draft edits and republication', async () => {
    const definition = await publishEvents();
    const { playerId, run } = await atVault(definition);
    const changed = eventDungeonInput(definition.key);
    changed.events![0]!.title = 'The Open Vault';
    changed.events![0]!.choices = changed.events![0]!.choices.filter((c) => c.id !== 'force');
    await w.republish(changed);

    const pinned = await w.runs.run(playerId, run.id);
    expect(pinned.dungeon.revision).toBe(1);
    expect(pinned.core.action!.event).toEqual(run.core.action!.event);
    const forced = await choose(playerId, pinned, 'force');
    expect(forced.status).toBe('applied');
    expect(forced.run.latestEvents![0]).toMatchObject({ eventTitle: 'The Sealed Vault', choiceLabel: 'Force it' });

    const fresh = await atVault(DungeonDefinitionSchema.parse(changed));
    expect(fresh.run.dungeon.revision).toBe(2);
    expect(fresh.run.core.action!.event).toMatchObject({ title: 'The Open Vault' });
    expect(Object.keys(choices(fresh.run))).not.toContain('force');
  });

  it('holds event currency at risk and settles it by the Phase 2 rules', async () => {
    const definition = await publishEvents();
    // Abandon: the dungeon keeps half on defeat, and abandoning follows that.
    const abandoning = await atVault(definition, { keys: 1 });
    const opened = (await choose(abandoning.playerId, abandoning.run, 'use_key')).run;
    expect(opened.atRisk).toEqual({ shards: 5, waifubux: 0 });
    expect(await w.balance(abandoning.playerId)).toBe(0);
    const abandoned = (await w.act(abandoning.playerId, opened, { type: 'abandon' })).run;
    expect(abandoned.settlement).toMatchObject({ outcome: 'abandoned', earned: 5, banked: 2, lost: 3 });
    expect(await w.balance(abandoning.playerId)).toBe(2);
    // Items it paid were secured when the choice was made and stay.
    expect(await held(abandoning.playerId, 'scrap_parts')).toBe(2);

    // Completing banks all of it.
    const finishing = await atVault(definition, { keys: 1 });
    let run = (await choose(finishing.playerId, finishing.run, 'use_key')).run;
    for (let guard = 0; run.status === 'active' && guard < 20; guard++) {
      const offered = run.core.action?.event;
      if (offered) run = (await choose(finishing.playerId, run, offered.choices.find((c) => c.available && !c.walksAway && c.id !== 'shut_down')!.id)).run;
      else if (run.core.phase === 'action') run = (await w.act(finishing.playerId, run, { type: 'advance' })).run;
      else run = await move(finishing.playerId, run, run.core.connections.find((c) => c.id === 'c_heap' || c.id === 'c_lift')!.id);
    }
    expect(run.status).toBe('completed');
    expect(run.settlement).toMatchObject({ outcome: 'completed', retentionBasisPoints: 10_000, lost: 0 });
    expect(run.settlement!.banked).toBe(run.settlement!.earned);
    expect(run.settlement!.earned).toBeGreaterThanOrEqual(5);
    expect(await w.balance(finishing.playerId)).toBe(run.settlement!.banked);

    // An outcome that ends the run settles in the same step.
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, definition.key, { seed: seedWhereHallDraws(definition, 'sparking_drone') });
    const ended = await choose(playerId, start, 'shut_down');
    expect(ended.run).toMatchObject({ status: 'completed', settlement: { outcome: 'completed', cause: 'scripted' } });
    expect((await rowOf(start.id)).eventStates['hall:find']).toMatchObject({ status: 'resolved' });
  });
});

describe('publication', () => {
  it('publishes an event dungeon, pinning what its reachable events need and nothing an unused one does', async () => {
    const definition = await publishEvents();
    const [revision] = await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, definition.key));
    expect(revision!.number).toBe(1);
    const snapshot = readDungeonRewardSnapshot(revision!.rewardSnapshot)!;
    // Reached only through an event; the shelved event's missing table did not block publishing.
    expect(Object.keys(snapshot.tables)).toEqual(['vault_hoard']);
    expect(Object.keys(snapshot.items)).toEqual(['scrap_parts']);
    expect(revision!.gameplayHash).toMatch(/^sha256:/);
    expect(revision!.contentHash).toBe(dungeonContentHash(definition));
    const detail = (await w.content.get(definition.key))!;
    expect(detail.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(detail.issues.map((i) => i.code)).toContain('event_unused');

    // The loot table knows the dungeon uses it, though only an event names it.
    const usage = await createDungeonLootTableService({ db: w.t.db }).whereUsed('vault_hoard');
    expect(JSON.stringify(usage)).toContain(definition.key);
  });

  it('refuses to publish while a reachable event needs something this server lacks', async () => {
    const input = eventDungeonInput(`ev_live_${++n}`);
    input.eventPools![0]!.entries.push({ id: 'e_shelf', weight: 1, eventId: 'shelved_idea' });
    input.events![0]!.choices[0]!.items = [{ item: 'no_such_item', quantity: 1, consume: true }];
    const created = await w.content.create({ definition: input }, 'test');
    const error = await w.content.publish(input.key, { expectedRevision: created.draftRevision }, 'test').then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(DungeonInvalidError);
    const blockers = (error as DungeonInvalidError).issues.filter((i) => i.severity === 'error').map((i) => `${i.code} ${i.path}`);
    expect(blockers).toEqual(expect.arrayContaining([
      'event_item_missing events[0].choices[0].items[0].item',
      'reward_table_missing events[4].choices[0].outcome.rewards.tables[0]',
    ]));
    expect(await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, input.key))).toEqual([]);
  });

  it('rolls back to an event revision', async () => {
    const definition = await publishEvents();
    const changed = eventDungeonInput(definition.key);
    changed.name = 'Second';
    await w.republish(changed);
    const rolled = await w.content.rollback(definition.key, { revision: 1 }, 'test');
    expect(rolled.revision.number).toBe(1);
    expect((await atVault(definition)).run.dungeon.revision).toBe(1);
  });

  it('reports a missing or disabled required item as a notice, never as broken rewards', async () => {
    const [temporary] = await w.t.db.insert(items).values({ slug: 'rh_pass', name: 'Old Pass', category: 'material', enabled: true }).returning();
    const definition = await publishEvents((d) => {
      d.events![0]!.choices[2]!.items = [{ item: 'rh_pass', quantity: 1, consume: false }];
    });
    const entry = async () => (await w.content.rewardHealth()).dungeons.find((d) => d.key === definition.key)!;
    expect(await entry()).toMatchObject({ status: 'healthy', problems: [], notices: [] });

    await w.t.db.update(items).set({ enabled: false }).where(eq(items.id, temporary!.id));
    expect(await entry()).toMatchObject({
      status: 'healthy', problems: [],
      notices: [{ type: 'event_item', reason: 'item_disabled', key: 'rh_pass', name: 'Old Pass' }],
    });
    // A run in progress on it is counted, and its notice follows the revision it is pinned to.
    const { playerId, run } = await atVault(definition);
    await w.t.db.delete(items).where(eq(items.id, temporary!.id));
    const missing = await entry();
    expect(missing).toMatchObject({ status: 'healthy', problems: [], activeRuns: 1, notices: [{ reason: 'item_missing', key: 'rh_pass' }] });
    expect(missing.notices[0]!.message).toContain('no longer exists');
    // In play that choice is simply unavailable; the others work.
    const live = await w.runs.run(playerId, run.id);
    expect(choices(live).force).toMatchObject({ available: false, unavailableReason: 'items' });
    expect((await choose(playerId, live, 'pick_lock')).status).toBe('applied');
  });
});

describe('event packages require v3', () => {
  it('exports v3 drafts and publications but refuses disguised legacy imports', async () => {
    const definition = await publishEvents();
    for (const origin of ['draft', 'published', { revision: 1 }] as const) {
      expect((await w.content.exportPackage(definition.key, origin, 'admin')).schemaVersion).toBe(3);
    }
    expect(() => buildDungeonPackage({ definition, source: { environment: 'test', origin: 'draft', draftRevision: 1, publishedRevision: 1 } })).toThrow(/snapshot/);
    // A hand-made v1 envelope around an event dungeon is refused by the importer's plan.
    const legacy = buildDungeonPackage({ definition: testDungeon(), source: { environment: 'test', origin: 'draft', draftRevision: 1, publishedRevision: null } });
    const forged = { ...legacy, dungeon: definition, contentHash: dungeonContentHash(definition), source: { ...legacy.source, dungeonKey: definition.key } };
    const plan = await w.content.planImport(forged);
    expect(plan.validPackage).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain('package_schema_version');
    // An event-free dungeon exports as it always did.
    await w.publish(testDungeon(`ev_plain_${++n}`));
    expect((await w.content.exportPackage(`ev_plain_${n}`, 'published', 'admin')).schemaVersion).toBe(1);
  });

  it('leaves existing dungeons and their runs as they were', async () => {
    const key = `ev_plain_${++n}`;
    await w.publish(testDungeon(key));
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, key, { seed: 1 });
    expect(start.core.action).toMatchObject({ id: 'guards', type: 'combat' });
    expect(start.core.action!.event).toBeUndefined();
    const fought = (await w.act(playerId, start, { type: 'advance' })).run;
    const row = await rowOf(start.id);
    expect(row.eventStates).toEqual({});
    expect(fought.latestEvents).toBeUndefined();
    expect(fought.eventItemNames).toBeUndefined();
    expect(await historyTypes(start.id)).not.toContain('event_selected');
    const [definitionRow] = await w.t.db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
    expect(definitionRow!.draftHash).toBe(dungeonContentHash(testDungeon(key)));
  });
});
