/** Rehearse the actual 0068 runner on populated 0067, never a shared environment. */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { startDungeonRun } from '../../src/modules/dungeons/engine/step';
import { singleRoomDungeon, testDependencies, TEST_FIGHTER } from '../helpers/dungeonFixtures';
import { silentLogger } from '../helpers/testDb';

const directory = path.resolve(__dirname, '../../drizzle');
const tag = '0068_dungeon_encounters';
let pool: Pool, dbName: string, folder: string;
let oldRuns: unknown[], oldHistory: unknown[];
const logger = silentLogger();
const journal = JSON.parse(fs.readFileSync(path.join(directory, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; when: number; tag: string }[];
};
const entry = journal.entries.find((e) => e.tag === tag)!;
const sqlFile = fs.readFileSync(path.join(directory, `${tag}.sql`), 'utf8');
const statements = sqlFile
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);
const runs = async (): Promise<Record<string, unknown>[]> =>
  (await pool.query('SELECT to_jsonb(r) AS row FROM dungeon_runs r ORDER BY id')).rows.map(
    (r) => r.row,
  );
const history = async () =>
  (await pool.query('SELECT to_jsonb(e) AS row FROM dungeon_run_events e ORDER BY id')).rows.map(
    (r) => r.row,
  );

beforeAll(async () => {
  const admin = new Client({ connectionString: inject('adminDatabaseUrl') });
  await admin.connect();
  dbName = `waifumon_test_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(inject('adminDatabaseUrl'));
  url.pathname = `/${dbName}`;
  pool = new Pool({
    connectionString: url.toString(),
    max: 4,
    options: '-c lock_timeout=500ms -c statement_timeout=30000ms',
  });
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-p4d2-migrate-'));
  fs.mkdirSync(path.join(folder, 'meta'));
  const kept = journal.entries.filter((e) => e.idx < 68);
  expect(kept.at(-1)!.idx).toBe(67);
  fs.writeFileSync(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: kept }),
  );
  for (const e of kept)
    fs.copyFileSync(path.join(directory, `${e.tag}.sql`), path.join(folder, `${e.tag}.sql`));
  await runMigrations(createDb(pool), logger, folder);
  await pool.query("INSERT INTO guilds(discord_guild_id) VALUES ('p4d2_migration')");
  await pool.query(
    "INSERT INTO players(guild_id, discord_user_id) SELECT id, u FROM guilds CROSS JOIN unnest(ARRAY['active','completed']) u WHERE discord_guild_id='p4d2_migration'",
  );
  const definition = singleRoomDungeon([], (d) => {
    d.key = 'p4d2_migration';
  });
  const state = startDungeonRun(
    { definition, dependencies: testDependencies(), fighter: TEST_FIGHTER, runKey: 'migration' },
    17,
  ).state;
  await pool.query(
    'INSERT INTO dungeon_definitions(dungeon_key,draft,draft_hash) VALUES ($1,$2,$3)',
    [definition.key, definition, 'fixture'],
  );
  await pool.query(
    'INSERT INTO dungeon_revisions(dungeon_key,number,content,content_hash,draft_revision) VALUES ($1,1,$2,$3,1)',
    [definition.key, definition, 'fixture'],
  );
  for (const status of ['active', 'completed'])
    await pool.query(
      `
    INSERT INTO dungeon_runs(player_id,dungeon_key,revision_id,seed,status,step,cursor,current_hp,flags,room_states,fighter,dependency_snapshot,event_states,completed_at,settlement)
    SELECT p.id,r.dungeon_key,r.id,17,$1,3,$2,300,$3,$4,$5,$6,$7,
      CASE WHEN $1='active' THEN NULL ELSE now() END,
      CASE WHEN $1='active' THEN NULL ELSE '{"outcome":"completed","banked":7}'::jsonb END
    FROM players p CROSS JOIN dungeon_revisions r WHERE p.discord_user_id=$1`,
      [
        status,
        state.cursor,
        { repaired: true },
        state.rooms,
        TEST_FIGHTER,
        testDependencies(),
        {
          'hall:repair': {
            eventId: 'repair',
            status: 'resolved',
            resolution: { branch: 'outcome' },
          },
        },
      ],
    );
  await pool.query(`INSERT INTO dungeon_run_events(run_id,player_id,step,type,room_id,action_id,payload)
    SELECT r.id,r.player_id,n,CASE n%3 WHEN 0 THEN 'event_selected' WHEN 1 THEN 'items_consumed' ELSE 'run_started' END,
      'hall','repair',jsonb_build_object('fixture',n) FROM dungeon_runs r CROSS JOIN generate_series(1,1000) n`);
  oldRuns = await runs();
  oldHistory = await history();
});
afterAll(async () => {
  await pool?.end();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  const admin = new Client({ connectionString: inject('adminDatabaseUrl') });
  await admin.connect();
  if (dbName) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

it('times out behind a history reader and rolls back the new column and migration tracking', async () => {
  const reader = await pool.connect();
  try {
    await reader.query('BEGIN');
    await reader.query('SELECT * FROM dungeon_run_events LIMIT 1');
    await expect(runMigrations(createDb(pool), logger, directory)).rejects.toMatchObject({
      code: '55P03',
    });
  } finally {
    await reader.query('ROLLBACK');
    reader.release();
  }
  expect(
    (
      await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='dungeon_runs' AND column_name='encounter_states'",
      )
    ).rows,
  ).toEqual([]);
  expect(
    (await pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows,
  ).toEqual([{ n: 68 }]);
  expect(await runs()).toEqual(oldRuns);
  expect(await history()).toEqual(oldHistory);
});

it('holds AccessExclusiveLock on both run/history tables for the migration transaction', async () => {
  const migrator = await pool.connect(),
    reader = await pool.connect();
  try {
    await migrator.query('BEGIN');
    for (const statement of statements) await migrator.query(statement);
    const locks = await migrator.query(
      "SELECT relation::regclass::text AS name, mode FROM pg_locks WHERE pid=pg_backend_pid() AND granted AND relation IN ('dungeon_runs'::regclass,'dungeon_run_events'::regclass)",
    );
    for (const name of ['dungeon_runs', 'dungeon_run_events'])
      expect(locks.rows).toContainEqual({ name, mode: 'AccessExclusiveLock' });
    await expect(reader.query('SELECT * FROM dungeon_run_events LIMIT 1')).rejects.toMatchObject({
      code: '55P03',
    });
  } finally {
    await migrator.query('ROLLBACK');
    reader.release();
    migrator.release();
  }
});

it('applies through the real ordered runner, preserves 2 runs/2000 history rows, initializes {}, and is tracked once', async () => {
  expect(entry.idx).toBe(68);
  expect(entry.when).toBeGreaterThan(journal.entries[67]!.when);
  const heap = (
    await pool.query("SELECT relfilenode FROM pg_class WHERE oid='dungeon_runs'::regclass")
  ).rows;
  await runMigrations(createDb(pool), logger, directory);
  expect((await runs()).map(({ encounter_states: _new, ...old }) => old)).toEqual(oldRuns);
  expect((await runs()).map((r) => r.encounter_states)).toEqual([{}, {}]);
  expect(await history()).toEqual(oldHistory);
  expect(
    (await pool.query("SELECT relfilenode FROM pg_class WHERE oid='dungeon_runs'::regclass")).rows,
  ).toEqual(heap);
  const hash = createHash('sha256').update(sqlFile).digest('hex');
  const tracked = (
    await pool.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations WHERE hash=$1', [
      hash,
    ])
  ).rows;
  expect(tracked).toEqual([{ hash, created_at: String(entry.when) }]);
  await runMigrations(createDb(pool), logger, directory);
  expect(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE hash=$1',
        [hash],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
  expect(
    (
      await pool.query(
        "SELECT convalidated FROM pg_constraint WHERE conname='dungeon_run_events_type_check' AND conrelid='dungeon_run_events'::regclass",
      )
    ).rows,
  ).toEqual([{ convalidated: true }]);
});

it('accepts the new history types, refuses unknown types, and installs ledger uniqueness, mode and foreign-key constraints', async () => {
  for (const type of ['encounter_selected', 'capture_attempted', 'waifu_acquired'])
    await pool.query(
      'INSERT INTO dungeon_run_events(run_id,player_id,step,type) SELECT id,player_id,4,$1 FROM dungeon_runs LIMIT 1',
      [type],
    );
  await expect(
    pool.query(
      "INSERT INTO dungeon_run_events(run_id,player_id,step,type) SELECT id,player_id,4,'unknown' FROM dungeon_runs LIMIT 1",
    ),
  ).rejects.toMatchObject({ code: '23514' });
  const constraints = (
    await pool.query(
      "SELECT conname,contype FROM pg_constraint WHERE conrelid='dungeon_species_acquisitions'::regclass",
    )
  ).rows;
  expect(constraints.filter((c) => c.contype === 'f')).toHaveLength(4);
  expect(constraints).toContainEqual({
    conname: 'dungeon_species_acquisitions_mode_check',
    contype: 'c',
  });
  const indexes = (
    await pool.query(
      "SELECT indexname,indexdef FROM pg_indexes WHERE tablename='dungeon_species_acquisitions'",
    )
  ).rows;
  expect(indexes.filter((i) => i.indexdef.startsWith('CREATE UNIQUE INDEX'))).toHaveLength(3);
  expect(indexes).toContainEqual(
    expect.objectContaining({
      indexname: 'dungeon_species_acquisitions_player_dungeon_species_idx',
      indexdef: expect.stringContaining('(player_id, dungeon_key, species_id)'),
    }),
  );
  await expect(
    pool.query(
      "INSERT INTO dungeon_species_acquisitions(player_id,species_id,dungeon_key,run_id,room_id,action_id,mode,waifu_id,grant_key) VALUES(-1,-1,'x',-1,'r','a','capture',-1,'x')",
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    pool.query(
      "INSERT INTO dungeon_species_acquisitions(player_id,species_id,dungeon_key,run_id,room_id,action_id,mode,waifu_id,grant_key) VALUES(-1,-1,'x',-1,'r','a','invalid',-1,'x')",
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
