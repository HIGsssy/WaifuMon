/**
 * 0046 — does turning fixed-multiplier definitions into rolled instances apply
 * to a live server that is already at 0045, without changing anyone's gear?
 *
 * Runs the real migrator against a journal that stops at 0045, writes the kind
 * of equipment a staging server holds under the old model (starters at their
 * seeded values, a hand-tuned starter, admin-authored gear, removed and
 * equipped copies), then runs the full journal exactly as a deploy would.
 *
 * The promises under test:
 *   - every existing instance keeps exactly its effective multiplier;
 *   - no existing instance gains an affix;
 *   - starters still at their seeded value get their ranges, anything else
 *     becomes a single-value range at its old multiplier;
 *   - the old columns are gone, so nothing can read the definition's value;
 *   - re-running the file by hand changes nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { buildEquipmentServices } from '../helpers/equipmentFixtures';
import { silentLogger } from '../helpers/testDb';

const DRIZZLE = path.resolve(__dirname, '..', '..', 'drizzle');
const LAST_BEFORE = '0045_equipment_foundation';
const MIGRATION = '0046_equipment_rolled_instances';

let adminUrl: string;
let dbName: string;
let pool: Pool;
let partialFolder: string;

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

async function columns(table: string): Promise<string[]> {
  const { rows } = await pool.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return rows.map((r) => r.column_name as string).sort();
}

beforeAll(async () => {
  adminUrl = inject('adminDatabaseUrl');
  dbName = `waifumon_equipment_roll_mig_${randomBytes(6).toString('hex')}`;
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

/** Old-model definitions: key → [slot, attack, defense, health]. */
const OLD_DEFINITIONS: Record<string, [string, number, number, number]> = {
  rusty_pipe: ['attack', 4500, 0, 0], // seeded value — gets its range
  scrap_plate: ['defense', 0, 3600, 0], // hand-tuned on staging — left single-value
  dented_lunchbox: ['health', 0, 0, 20000], // seeded value — gets its range
  plasma_coil_ring: ['attack', 8600, 0, 0], // admin-authored
  tactical_corset: ['health', 0, 0, 31000], // admin-authored
};

describe('0046 on a server at 0045', () => {
  let playerId: number;
  let otherId: number;
  /** instance id → the multiplier combat used before the migration. */
  const effectiveBefore = new Map<number, number>();
  let equippedPipe: number;

  it('starts from 0045 with fixed-multiplier gear owned and equipped', async () => {
    await runMigrations(createDb(pool), silentLogger(), partialFolder);
    expect(await columns('equipment_definitions')).toContain('attack_bp');

    const { rows: g } = await pool.query(`insert into guilds (discord_guild_id) values ('g-roll') returning id`);
    const player = async (tag: string) =>
      Number(
        (await pool.query(`insert into players (guild_id, discord_user_id) values ($1, $2) returning id`, [g[0].id, tag]))
          .rows[0].id,
      );
    playerId = await player('u-roll-1');
    otherId = await player('u-roll-2');

    const ids = new Map<string, number>();
    for (const [key, [slot, a, d, h]] of Object.entries(OLD_DEFINITIONS)) {
      const { rows } = await pool.query(
        `insert into equipment_definitions (key, name, slot, rarity, attack_bp, defense_bp, health_bp)
         values ($1, $1, $2, 'N', $3, $4, $5) returning id`,
        [key, slot, a, d, h],
      );
      ids.set(key, Number(rows[0].id));
    }
    const own = async (owner: number, key: string, opts: { removed?: boolean; grantKey?: string } = {}) => {
      const [slot, a, d, h] = OLD_DEFINITIONS[key]!;
      const { rows } = await pool.query(
        `insert into player_equipment (player_id, definition_id, slot, source_type, grant_key, removed_at, removed_reason)
         values ($1, $2, $3, 'onboarding', $4, $5, $6) returning id`,
        [owner, ids.get(key), slot, opts.grantKey ?? null, opts.removed ? new Date() : null, opts.removed ? 'test' : null],
      );
      const id = Number(rows[0].id);
      effectiveBefore.set(id, slot === 'attack' ? a : slot === 'defense' ? d : h);
      return id;
    };
    equippedPipe = await own(playerId, 'rusty_pipe', { grantKey: `onboarding:equipment:${playerId}:attack:0` });
    await own(playerId, 'scrap_plate', { grantKey: `onboarding:equipment:${playerId}:defense:0` });
    await own(playerId, 'dented_lunchbox', { grantKey: `onboarding:equipment:${playerId}:health:0` });
    await own(playerId, 'plasma_coil_ring');
    await own(playerId, 'plasma_coil_ring', { removed: true });
    await own(otherId, 'tactical_corset');
    await own(otherId, 'rusty_pipe');

    const { rows: l } = await pool.query(
      `insert into player_loadouts (player_id, is_active) values ($1, true) returning id`,
      [playerId],
    );
    await pool.query(
      `insert into player_loadout_slots (loadout_id, player_id, slot, equipment_id) values ($1, $2, 'attack', $3)`,
      [l[0].id, playerId, equippedPipe],
    );
  });

  it('applies through the real migrator, as a deploy would', async () => {
    await runMigrations(createDb(pool), silentLogger(), DRIZZLE);
    const { rows } = await pool.query(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8'));
    expect(rows[0].n).toBe(journal.entries.length);
  });

  it('keeps every existing instance at exactly its effective multiplier, unaffixed', async () => {
    const { rows } = await pool.query(`select id, rolled_multiplier_bp, affix_key from player_equipment order by id`);
    expect(rows).toHaveLength(effectiveBefore.size);
    for (const row of rows) {
      expect(row.rolled_multiplier_bp, `instance ${row.id}`).toBe(effectiveBefore.get(Number(row.id)));
      expect(row.affix_key, `instance ${row.id}`).toBeNull();
    }
  });

  it('gives seeded starters their ranges and everything else a single-value range', async () => {
    const { rows } = await pool.query(
      `select key, multiplier_min_bp as min, multiplier_max_bp as max, multiplier_step_bp as step
       from equipment_definitions order by key`,
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, { min: r.min, max: r.max, step: r.step }]));
    expect(byKey).toEqual({
      rusty_pipe: { min: 4000, max: 6000, step: 500 },
      dented_lunchbox: { min: 18000, max: 26000, step: 2000 },
      // Hand-tuned away from the seed value: left exactly as it was.
      scrap_plate: { min: 3600, max: 3600, step: 100 },
      plasma_coil_ring: { min: 8600, max: 8600, step: 100 },
      tactical_corset: { min: 31000, max: 31000, step: 100 },
    });
  });

  it('drops the definition-owned multiplier columns', async () => {
    const defs = await columns('equipment_definitions');
    for (const gone of ['attack_bp', 'defense_bp', 'health_bp']) expect(defs).not.toContain(gone);
    expect(defs).toEqual(expect.arrayContaining(['multiplier_min_bp', 'multiplier_max_bp', 'multiplier_step_bp']));
    expect(await columns('player_equipment')).toEqual(expect.arrayContaining(['rolled_multiplier_bp', 'affix_key']));
  });

  it('reads the migrated roll through the service, equipped copy included', async () => {
    const svc = buildEquipmentServices(createDb(pool));
    const pipe = await svc.equipment.getOwned(playerId, equippedPipe);
    expect(pipe).toMatchObject({ rolledMultiplierBp: 4500, affixKey: null, displayName: 'rusty_pipe', equipped: true });
    const loadout = await svc.equipment.getActiveLoadout(playerId);
    expect(loadout.slots.attack?.id).toBe(equippedPipe);
  });

  it('is safe to re-run by hand', async () => {
    const before = (await pool.query(`select * from player_equipment order by id`)).rows;
    const defsBefore = (await pool.query(`select * from equipment_definitions order by id`)).rows;
    const sql = fs.readFileSync(path.join(DRIZZLE, `${MIGRATION}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await pool.query(statement);
    }
    expect((await pool.query(`select * from player_equipment order by id`)).rows).toEqual(before);
    expect((await pool.query(`select * from equipment_definitions order by id`)).rows).toEqual(defsBefore);
  });
});
