/**
 * Migration 0059 on a database that already holds prototype Delve data.
 *
 * Every other test migrates an empty database straight to head, where the
 * cleanup steps have nothing to do. This one stops at 0058, plants a
 * prototype zone and runs, and only then applies 0059 — the path staging
 * actually takes.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { silentLogger } from '../helpers/testDb';

const DRIZZLE = path.resolve(__dirname, '..', '..', 'drizzle');
const TAG = '0059_dungeon_overhaul_foundation';

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

let db: Db;
let pool: Pool;
let dbName: string;
let before: string;
const rows = async <T>(query: ReturnType<typeof sql>): Promise<T[]> => (await db.execute(query)).rows as T[];

beforeAll(async () => {
  const adminUrl = inject('adminDatabaseUrl');
  dbName = `waifumon_test_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  pool = new Pool({ connectionString: url.toString(), max: 4 });
  db = createDb(pool);

  // The same files, with a journal that ends just before this migration.
  before = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-migrate-'));
  fs.mkdirSync(path.join(before, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((e) => e.tag !== TAG);
  expect(kept).toHaveLength(journal.entries.length - 1);
  fs.writeFileSync(path.join(before, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  for (const entry of kept) fs.copyFileSync(path.join(DRIZZLE, `${entry.tag}.sql`), path.join(before, `${entry.tag}.sql`));
  await runMigrations(db, silentLogger(), before);

  // Prototype data, as the old code wrote it.
  await db.execute(sql`insert into guilds (discord_guild_id) values ('g-mig')`);
  await db.execute(sql`
    insert into players (guild_id, discord_user_id)
    select id, u from guilds, unnest(array['u-active','u-holder','u-done','u-orphan']) as u where discord_guild_id = 'g-mig'`);
  await db.execute(sql`
    insert into dungeon_zones (zone_key, enabled, definition, content_hash)
    values ('scrapheap_gauntlet', true, '{"key":"scrapheap_gauntlet","name":"Scrapheap Gauntlet"}'::jsonb, 'abc')`);
  const snapshot = (currencyKey: string) => JSON.stringify({ zone: { rewards: { currencyKey } } });
  const run = (user: string, status: string, unbanked: number, currencyKey: string, done: boolean) => sql`
    insert into dungeon_runs (player_id, zone_key, zone_revision, seed, generator_version, status, graph, zone_snapshot, unbanked_currency, completed_at, settlement)
    select id, 'scrapheap_gauntlet', 1, 7, 1, ${status}, '{}'::jsonb, ${snapshot(currencyKey)}::jsonb, ${unbanked},
           ${done ? sql`now()` : sql`null`}, ${done ? sql`'{"outcome":"defeated"}'::jsonb` : sql`null`}
    from players where discord_user_id = ${user}`;
  await db.execute(run('u-active', 'active', 9, 'ascension_currency', false));
  await db.execute(run('u-holder', 'active', 4, 'ascension_currency', false));
  await db.execute(run('u-done', 'defeated', 0, 'ascension_currency', true));
  // A run whose zone named a currency this server does not have.
  await db.execute(run('u-orphan', 'active', 5, 'no_such_currency', false));
  // One of them already holds some of the currency.
  await db.execute(sql`
    insert into player_progression_balances (player_id, currency_key, balance)
    select id, 'ascension_currency', 10 from players where discord_user_id = 'u-holder'`);
  await db.execute(sql`
    insert into dungeon_run_events (run_id, player_id, type) select id, player_id, 'run_started' from dungeon_runs`);
  await db.execute(sql`
    insert into dungeon_daily_usage (player_id, period_key, runs_started) select id, '2026-10-01', 2 from players where discord_user_id = 'u-active'`);
  await db.execute(sql`update dungeon_settings set daily_run_limit = 7`);

  await runMigrations(db, silentLogger(), DRIZZLE);
});

afterAll(async () => {
  await pool.end();
  fs.rmSync(before, { recursive: true, force: true });
  const admin = new Client({ connectionString: inject('adminDatabaseUrl') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('migration 0059 over prototype data', () => {
  it('follows 0058 in the journal by `when`, which is what the migrator orders on', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as Journal;
    const entry = journal.entries.find((e) => e.tag === TAG)!;
    const others = journal.entries.filter((e) => e.tag !== TAG);
    expect(entry.when).toBeGreaterThan(Math.max(...others.map((e) => e.when)));
    expect(entry.idx).toBe(journal.entries.length - 1);
  });

  it('settles every active prototype run as an extraction and banks its currency in full, through the ledger', async () => {
    const runs = await rows<{ user: string; status: string; unbanked: number; cause: string | null; done: boolean }>(sql`
      select p.discord_user_id as "user", r.status, r.unbanked_currency as unbanked, r.settlement->>'cause' as cause, r.completed_at is not null as done
      from dungeon_runs_prototype r join players p on p.id = r.player_id order by 1`);
    expect(runs).toEqual([
      { user: 'u-active', status: 'extracted', unbanked: 0, cause: 'prototype_retired', done: true },
      { user: 'u-done', status: 'defeated', unbanked: 0, cause: null, done: true },
      { user: 'u-holder', status: 'extracted', unbanked: 0, cause: 'prototype_retired', done: true },
      { user: 'u-orphan', status: 'extracted', unbanked: 0, cause: 'prototype_retired', done: true },
    ]);
    const balances = await rows<{ user: string; balance: number }>(sql`
      select p.discord_user_id as "user", b.balance from player_progression_balances b join players p on p.id = b.player_id order by 1`);
    expect(balances).toEqual([{ user: 'u-active', balance: 9 }, { user: 'u-holder', balance: 14 }]);
    const ledger = await rows<{ user: string; delta: number; after: number; reason: string; key: string }>(sql`
      select p.discord_user_id as "user", l.delta, l.balance_after as after, l.reason, l.request_key as key
      from progression_currency_ledger l join players p on p.id = l.player_id order by 1`);
    expect(ledger).toEqual([
      { user: 'u-active', delta: 9, after: 9, reason: 'dungeon_extraction', key: expect.stringMatching(/^dungeon_run:\d+:settlement$/) },
      { user: 'u-holder', delta: 4, after: 14, reason: 'dungeon_extraction', key: expect.stringMatching(/^dungeon_run:\d+:settlement$/) },
    ]);
  });

  it('moves the prototype tables aside intact and leaves the new ones empty', async () => {
    const count = async (table: string) => Number((await rows<{ n: string }>(sql.raw(`select count(*) as n from "${table}"`)))[0]!.n);
    expect(await count('dungeon_zones_prototype')).toBe(1);
    expect(await count('dungeon_runs_prototype')).toBe(4);
    expect(await count('dungeon_run_events_prototype')).toBe(4);
    for (const table of ['dungeon_definitions', 'dungeon_revisions', 'dungeon_runs', 'dungeon_run_events', 'dungeon_content_events']) {
      expect(await count(table), table).toBe(0);
    }
    const old = await rows<{ table_name: string }>(sql`
      select table_name from information_schema.tables where table_schema = 'public' and table_name = 'dungeon_zones'`);
    expect(old).toEqual([]);
  });

  it('touches nothing that is not prototype dungeon data', async () => {
    expect(await rows(sql`select daily_run_limit from dungeon_settings`)).toEqual([{ daily_run_limit: 7 }]);
    expect(await rows(sql`select runs_started from dungeon_daily_usage`)).toEqual([{ runs_started: 2 }]);
    expect(Number((await rows<{ n: string }>(sql`select count(*) as n from players`))[0]!.n)).toBe(4);
    expect(Number((await rows<{ n: string }>(sql`select count(*) as n from progression_currencies`))[0]!.n)).toBeGreaterThan(0);
  });

  it('adds nullable, unique-when-set provenance columns to player_waifus', async () => {
    const columns = await rows<{ column_name: string; is_nullable: string }>(sql`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'player_waifus' and column_name in ('acquired_via','grant_key') order by 1`);
    expect(columns).toEqual([
      { column_name: 'acquired_via', is_nullable: 'YES' },
      { column_name: 'grant_key', is_nullable: 'YES' },
    ]);
    const index = await rows<{ indexdef: string }>(sql`select indexdef from pg_indexes where indexname = 'player_waifus_grant_key_uq'`);
    expect(index[0]!.indexdef).toMatch(/UNIQUE INDEX.*grant_key.*WHERE \(grant_key IS NOT NULL\)/);
  });

  it('is a no-op when applied again', async () => {
    const statements = fs.readFileSync(path.join(DRIZZLE, `${TAG}.sql`), 'utf8').split('--> statement-breakpoint');
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(Number((await rows<{ n: string }>(sql`select count(*) as n from dungeon_runs_prototype`))[0]!.n)).toBe(4);
    expect(Number((await rows<{ n: string }>(sql`select count(*) as n from progression_currency_ledger`))[0]!.n)).toBe(2);
    expect(Number((await rows<{ n: string }>(sql`select count(*) as n from dungeon_runs`))[0]!.n)).toBe(0);
  });
});
