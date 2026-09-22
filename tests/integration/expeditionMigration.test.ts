/**
 * 0039 — does regional concurrency arrive without disturbing what is in flight?
 *
 * The one thing a deployment of this change must not do is cost a player the
 * eighteen hours they already committed. Every other expedition test starts
 * from a fully-migrated database and therefore cannot see this: the question
 * is specifically about a row written under **0038's** rules meeting 0039.
 *
 * So this file migrates to 0038 and stops, writes an active mission the way
 * the old service wrote one, applies 0039 alone, and asserts the row comes
 * out byte for byte identical — the resolution-plan snapshot, the finish line,
 * the persisted chances and the state — while the new rule takes effect
 * around it.
 *
 * It applies the SQL by hand rather than through `runMigrations`, because the
 * migrator has no notion of stopping part-way. That is the cost of testing an
 * intermediate state at all, and it is paid once, here.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { inject } from 'vitest';
import fs from 'node:fs';

let pool: Pool;
let dbName: string;
let adminUrl: string;

const DRIZZLE = path.resolve(__dirname, '..', '..', 'drizzle');

async function applyUpTo(client: Pool, lastTag: string) {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    const sql = fs.readFileSync(path.join(DRIZZLE, `${entry.tag}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.query(statement);
    }
    if (entry.tag === lastTag) return;
  }
}

beforeAll(async () => {
  adminUrl = inject('adminDatabaseUrl');
  dbName = `waifumon_mig_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  pool = new Pool({ connectionString: url.toString(), max: 4 });
});

afterAll(async () => {
  await pool.end();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

it('carries an in-flight 0038 mission through 0039 untouched', async () => {
  await applyUpTo(pool, '0038_expeditions');

  const { rows: guildRows } = await pool.query(
    `insert into guilds (discord_guild_id) values ('g-mig') returning id`,
  );
  const { rows: playerRows } = await pool.query(
    `insert into players (discord_user_id, guild_id) values ('u-mig', $1) returning id`,
    [guildRows[0].id],
  );
  const playerId = playerRows[0].id;

  const plan = JSON.stringify({ planVersion: 1, definition: { key: 'old_run' } });
  const { rows: before } = await pool.query(
    `insert into player_expeditions
       (player_id, slot_index, expedition_key, region, waifu_id, completes_at,
        success_chance, exceptional_chance, suitability_band, resolution_plan, logic_version)
     values ($1, 1, 'old_run', 'waifu-valley', 4242, now() + interval '6 hours',
             0.62, 0.07, 'STRONG_MATCH', $2::jsonb, 1)
     returning *`,
    [playerId, plan],
  );

  // The old index is the one in force at this point.
  const { rows: oldIdx } = await pool.query(
    `select indexname from pg_indexes where tablename = 'player_expeditions'`,
  );
  expect(oldIdx.map((r) => r.indexname)).toContain('player_expeditions_player_slot_active_uq');

  // Apply 0039.
  const sql = fs.readFileSync(
    path.join(DRIZZLE, '0039_expedition_regional_concurrency.sql'),
    'utf8',
  );
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) await pool.query(statement);
  }

  const { rows: after } = await pool.query(
    `select * from player_expeditions where id = $1`,
    [before[0].id],
  );
  // Byte for byte: the snapshot, the finish line, the chances, the state.
  expect(after[0]).toEqual(before[0]);

  const { rows: idx } = await pool.query(
    `select indexname from pg_indexes where tablename = 'player_expeditions'`,
  );
  expect(idx.map((r) => r.indexname)).toContain('player_expeditions_player_region_active_uq');
  expect(idx.map((r) => r.indexname)).not.toContain('player_expeditions_player_slot_active_uq');

  // The new rule is live: same region refused, different region allowed —
  // and the old mission is what refuses it.
  await expect(
    pool.query(
      `insert into player_expeditions
         (player_id, slot_index, expedition_key, region, waifu_id, completes_at,
          success_chance, exceptional_chance, suitability_band)
       values ($1, 2, 'old_run', 'waifu-valley', 9999, now() + interval '1 hour',
               0.5, 0.05, 'WEAK_MATCH')`,
      [playerId],
    ),
  ).rejects.toThrow(/player_expeditions_player_region_active_uq/);

  await pool.query(
    `insert into player_expeditions
       (player_id, slot_index, expedition_key, region, waifu_id, completes_at,
        success_chance, exceptional_chance, suitability_band)
     values ($1, 1, 'peeks_run', 'twin-peeks', 9999, now() + interval '1 hour',
             0.5, 0.05, 'WEAK_MATCH')`,
    [playerId],
  );

  const { rows: count } = await pool.query(
    `select count(*)::int as n from player_expeditions where player_id = $1 and status = 'active'`,
    [playerId],
  );
  expect(count[0].n).toBe(2);
});
