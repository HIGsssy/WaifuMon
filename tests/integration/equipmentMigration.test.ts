/**
 * 0045 — does the equipment foundation apply to a live server that is already
 * at 0044, exactly the way a deploy would apply it?
 *
 * Every other test starts from a database migrated in one go. This one runs
 * the real migrator against a copy of the migration folder whose journal stops
 * at 0044, writes the kind of data a live server holds, then runs the real
 * migrator again with the full journal — which is precisely a production
 * deploy. That also proves the journal's `when` for 0045 is newer than 0044's:
 * the node-postgres migrator silently skips an entry that is not.
 *
 * 0045 is purely additive, so the assertions are: the new tables exist, the
 * existing rows are untouched, nothing was seeded or granted, and re-running
 * the file by hand is a no-op.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { silentLogger } from '../helpers/testDb';

const DRIZZLE = path.resolve(__dirname, '..', '..', 'drizzle');
const LAST_BEFORE = '0044_retire_teleporter_wreck';
const MIGRATION = '0045_equipment_foundation';

const NEW_TABLES = [
  'equipment_definitions',
  'player_equipment',
  'player_loadouts',
  'player_loadout_slots',
  'equipment_events',
  'equipment_import_log',
  'player_feature_unlocks',
];

let adminUrl: string;
let dbName: string;
let pool: Pool;
let partialFolder: string;

/** A copy of the migration folder whose journal ends at `lastTag`. */
function truncatedMigrations(lastTag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-mig-'));
  fs.mkdirSync(path.join(dir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((e) => e.tag === lastTag);
  if (cut < 0) throw new Error(`${lastTag} is not in the journal`);
  const entries = journal.entries.slice(0, cut + 1);
  fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    fs.copyFileSync(path.join(DRIZZLE, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query(`select to_regclass($1) is not null as present`, [`public.${name}`]);
  return rows[0].present;
}

beforeAll(async () => {
  adminUrl = inject('adminDatabaseUrl');
  dbName = `waifumon_equipment_mig_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  pool = new Pool({ connectionString: url.toString(), max: 4 });
  partialFolder = truncatedMigrations(LAST_BEFORE);
});

afterAll(async () => {
  await pool?.end();
  if (partialFolder) fs.rmSync(partialFolder, { recursive: true, force: true });
  if (dbName) {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
});

describe('0045 on a server at 0044', () => {
  let playerId: number;
  let before: { players: unknown[]; inventory: unknown[]; items: number };

  it('starts from the 0044 state, with no equipment tables', async () => {
    await runMigrations(createDb(pool), silentLogger(), partialFolder);
    for (const table of NEW_TABLES) expect(await tableExists(table)).toBe(false);

    // The kind of data a live server holds.
    const { rows: g } = await pool.query(`insert into guilds (discord_guild_id) values ('g-live') returning id`);
    const { rows: p } = await pool.query(
      `insert into players (guild_id, discord_user_id, level, xp) values ($1, 'u-live', 12, 3400) returning id`,
      [g[0].id],
    );
    playerId = Number(p[0].id);
    const { rows: i } = await pool.query(
      `insert into items (slug, name, category) values ('basic_charm', 'Basic Charm', 'capture') returning id`,
    );
    await pool.query(`insert into player_inventory (player_id, item_id, quantity) values ($1, $2, 7)`, [
      playerId,
      i[0].id,
    ]);
    before = {
      players: (await pool.query(`select * from players order by id`)).rows,
      inventory: (await pool.query(`select * from player_inventory order by player_id, item_id`)).rows,
      items: (await pool.query(`select count(*)::int as n from items`)).rows[0].n,
    };
  });

  it('applies through the real migrator, as a deploy would', async () => {
    await runMigrations(createDb(pool), silentLogger(), DRIZZLE);
    for (const table of NEW_TABLES) expect(await tableExists(table)).toBe(true);
    const { rows } = await pool.query(
      `select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8'));
    expect(rows[0].n).toBe(journal.entries.length);
    const { rows: idx } = await pool.query(
      `select indexdef from pg_indexes where schemaname = 'public' and indexname = 'equipment_events_loadout_idx'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/ON public\.equipment_events USING btree \(loadout_id\)/);
  });

  it('leaves existing rows untouched and seeds or grants nothing', async () => {
    expect((await pool.query(`select * from players order by id`)).rows).toEqual(before.players);
    expect((await pool.query(`select * from player_inventory order by player_id, item_id`)).rows).toEqual(before.inventory);
    expect((await pool.query(`select count(*)::int as n from items`)).rows[0].n).toBe(before.items);
    for (const table of NEW_TABLES) {
      const { rows } = await pool.query(`select count(*)::int as n from ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  it('is safe to re-run by hand', async () => {
    const sql = fs.readFileSync(path.join(DRIZZLE, `${MIGRATION}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await pool.query(statement);
    }
    for (const table of NEW_TABLES) expect(await tableExists(table)).toBe(true);
  });

  it('works for an existing player straight away', async () => {
    const { rows: d } = await pool.query(
      `insert into equipment_definitions (key, name, slot, rarity, attack_bp) values ('training_ring', 'Training Ring', 'attack', 'N', 5000) returning id`,
    );
    const { rows: e } = await pool.query(
      `insert into player_equipment (player_id, definition_id, slot, source_type) values ($1, $2, 'attack', 'admin') returning id`,
      [playerId, d[0].id],
    );
    const { rows: l } = await pool.query(
      `insert into player_loadouts (player_id, is_active) values ($1, true) returning id`,
      [playerId],
    );
    await pool.query(
      `insert into player_loadout_slots (loadout_id, player_id, slot, equipment_id) values ($1, $2, 'attack', $3)`,
      [l[0].id, playerId, e[0].id],
    );
    await pool.query(
      `insert into player_feature_unlocks (player_id, feature_key, source) values ($1, 'equipment', 'migration')`,
      [playerId],
    );
    const { rows } = await pool.query(`select count(*)::int as n from player_loadout_slots`);
    expect(rows[0].n).toBe(1);
  });
});
