/**
 * The 0016 backfill against a database that genuinely predates the column.
 *
 * The other SP tests run on databases migrated to head before any owned copy
 * exists, so they never exercise the interesting case. This one migrates to
 * 0015, mints owned Waifumon the way production had them, and *then* applies
 * 0016 — which is the only way to prove the backfill does what the deploy will
 * do, including on a re-run.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../../src/db/client';
import { playerWaifus, RARITIES } from '../../src/db/schema';
import {
  isValidBaseSeductivePower,
  rangeForRarity,
} from '../../src/modules/power/seductivePower';
import { deterministicBaseSeductivePower } from '../../src/modules/power/seductivePowerBackfill';

const DRIZZLE_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

let adminUrl: string;
let dbName: string;
let pool: Pool;
let db: Db;

/** Applies one migration file, honouring drizzle's statement breakpoints. */
async function applyMigration(tag: string): Promise<void> {
  const sqlText = fs.readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8');
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await pool.query(trimmed);
  }
}

/** Every migration up to but excluding `stopBefore`. */
async function migrateUpTo(stopBefore: string): Promise<void> {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) {
    if (entry.tag === stopBefore) return;
    await applyMigration(entry.tag);
  }
}

beforeAll(async () => {
  adminUrl = inject('adminDatabaseUrl');
  dbName = `waifumon_sp_mig_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  pool = new Pool({ connectionString: url.toString(), max: 4 });
  db = createDb(pool);

  await migrateUpTo('0016_seductive_power');
});

afterAll(async () => {
  await pool.end();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

/** Owned copies as they existed before the column — one per rarity, plus dups. */
async function seedLegacyData(): Promise<Map<number, string>> {
  await pool.query(
    `INSERT INTO guilds (discord_guild_id) VALUES ('g-mig') ON CONFLICT DO NOTHING`,
  );
  const guild = await pool.query<{ id: string }>(
    `SELECT id FROM guilds WHERE discord_guild_id = 'g-mig'`,
  );
  const player = await pool.query<{ id: string }>(
    `INSERT INTO players (guild_id, discord_user_id) VALUES ($1, 'u-mig') RETURNING id`,
    [guild.rows[0]!.id],
  );
  const playerId = player.rows[0]!.id;

  const rarityByWaifuId = new Map<number, string>();
  for (const rarity of RARITIES) {
    const speciesRow = await pool.query<{ id: string }>(
      `INSERT INTO species (slug, name, rarity, archetype, content_rating, image_path)
       VALUES ($1, $1, $2, 'demi-human', 'suggestive', 'x.png') RETURNING id`,
      [`mig_${rarity.toLowerCase()}`, rarity],
    );
    // Three duplicates each, so "duplicates may differ" is actually testable.
    for (let i = 0; i < 3; i++) {
      const owned = await pool.query<{ id: string }>(
        `INSERT INTO player_waifus (player_id, species_id, level) VALUES ($1, $2, $3) RETURNING id`,
        [playerId, speciesRow.rows[0]!.id, 1 + i],
      );
      rarityByWaifuId.set(Number(owned.rows[0]!.id), rarity);
    }
  }
  return rarityByWaifuId;
}

describe('0016 backfill on a pre-existing database', () => {
  let rarityByWaifuId: Map<number, string>;

  beforeAll(async () => {
    rarityByWaifuId = await seedLegacyData();
    // Sanity: the column genuinely does not exist yet.
    const before = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'player_waifus' AND column_name = 'base_sp'`,
    );
    expect(before.rowCount).toBe(0);

    await applyMigration('0016_seductive_power');
  });

  it('gives every pre-existing copy a valid Base SP for its own rarity', async () => {
    const rows = await db.select().from(playerWaifus);
    expect(rows.length).toBe(rarityByWaifuId.size);
    expect(rows.length).toBe(RARITIES.length * 3);
    for (const row of rows) {
      const rarity = rarityByWaifuId.get(row.id)!;
      expect(
        isValidBaseSeductivePower(row.baseSp, rarity),
        `#${row.id} (${rarity}) got ${row.baseSp}`,
      ).toBe(true);
    }
  });

  it('matches the TypeScript derivation exactly, id for id', async () => {
    const rows = await db.select().from(playerWaifus);
    for (const row of rows) {
      const rarity = rarityByWaifuId.get(row.id)!;
      expect(row.baseSp, `#${row.id}`).toBe(deterministicBaseSeductivePower(row.id, rarity));
    }
  });

  it('does not default everyone to the midpoint', async () => {
    const rows = await db.select().from(playerWaifus);
    const offMidpoint = rows.filter((row) => {
      const { min, max } = rangeForRarity(rarityByWaifuId.get(row.id)!);
      return row.baseSp !== Math.round((min + max) / 2);
    });
    // With 21 copies over 11-wide bands, all-midpoint would be a ~1-in-10^21
    // coincidence; anything short of "most differ" means the backfill is inert.
    expect(offMidpoint.length).toBeGreaterThan(rows.length / 2);
  });

  it('gives duplicate copies of one species different values', async () => {
    const rows = await db.select().from(playerWaifus);
    const bySpecies = new Map<number, number[]>();
    for (const row of rows) {
      bySpecies.set(row.speciesId, [...(bySpecies.get(row.speciesId) ?? []), row.baseSp]);
    }
    // At least one species' three copies must not be identical — the id, not
    // the species, is what the derivation keys on.
    const anyDiffer = [...bySpecies.values()].some((vals) => new Set(vals).size > 1);
    expect(anyDiffer).toBe(true);
  });

  it('is idempotent — re-running the backfill statement changes nothing', async () => {
    const before = await db.select().from(playerWaifus).orderBy(playerWaifus.id);
    // The migration's UPDATE verbatim, minus the DDL that cannot be re-run.
    const sqlText = fs.readFileSync(
      path.join(DRIZZLE_DIR, '0016_seductive_power.sql'),
      'utf8',
    );
    const updateStatement = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .find((s) => s.startsWith('UPDATE'))!;
    await pool.query(updateStatement);

    const after = await db.select().from(playerWaifus).orderBy(playerWaifus.id);
    expect(after.map((r) => r.baseSp)).toEqual(before.map((r) => r.baseSp));
  });

  it('leaves the column NOT NULL, checked, and without a default', async () => {
    const info = await pool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'player_waifus' AND column_name = 'base_sp'`,
    );
    expect(info.rows[0]!.is_nullable).toBe('NO');
    expect(info.rows[0]!.column_default).toBeNull();

    const constraint = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'player_waifus_base_sp_check'`,
    );
    expect(constraint.rowCount).toBe(1);

    // And the invariant bites: post-migration inserts cannot omit it.
    await expect(
      db.execute(
        sql`insert into player_waifus (player_id, species_id)
            select player_id, species_id from player_waifus limit 1`,
      ),
    ).rejects.toThrow(/base_sp/i);
  });

  it('raises rather than guessing when a species carries an unsupported rarity', async () => {
    // Runs the migration's *own* UPDATE and DO block against a row whose
    // species rarity is outside the ladder. The UPDATE's LATERAL join matches
    // nothing, the row stays NULL, and the guard must turn that into a loud
    // failure rather than a silently wrong permanent stat.
    const sqlText = fs.readFileSync(
      path.join(DRIZZLE_DIR, '0016_seductive_power.sql'),
      'utf8',
    );
    const statements = sqlText.split('--> statement-breakpoint').map((x) => x.trim());
    const updateStatement = statements.find((x) => x.startsWith('UPDATE'))!;
    const guardStatement = statements.find((x) => x.startsWith('DO $$'))!;

    // Corrupt one species the way bad data would, and give it an owned copy
    // with no base_sp — which needs the NOT NULL lifted for the duration.
    await pool.query(`ALTER TABLE species DROP CONSTRAINT species_rarity_check`);
    const bogus = await pool.query<{ id: string }>(
      `INSERT INTO species (slug, name, rarity, archetype, content_rating, image_path)
       VALUES ('mig_bogus', 'Bogus', 'MYTHIC', 'demi-human', 'suggestive', 'x.png')
       RETURNING id`,
    );
    await pool.query(`ALTER TABLE player_waifus ALTER COLUMN base_sp DROP NOT NULL`);
    const orphan = await pool.query<{ id: string }>(
      `INSERT INTO player_waifus (player_id, species_id, base_sp)
       SELECT player_id, $1, NULL FROM player_waifus LIMIT 1 RETURNING id`,
      [bogus.rows[0]!.id],
    );

    try {
      // The backfill cannot reach it — no matching band.
      await pool.query(updateStatement);
      const still = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM player_waifus WHERE base_sp IS NULL`,
      );
      expect(Number(still.rows[0]!.n)).toBe(1);

      // ...and the guard refuses to let the migration finish.
      await expect(pool.query(guardStatement)).rejects.toThrow(
        /without a base_sp|outside the configured ladder/,
      );
    } finally {
      await pool.query(`DELETE FROM player_waifus WHERE id = $1`, [orphan.rows[0]!.id]);
      await pool.query(`DELETE FROM species WHERE slug = 'mig_bogus'`);
      await pool.query(`ALTER TABLE player_waifus ALTER COLUMN base_sp SET NOT NULL`);
    }
  });

  it('the guard passes once every copy has a value', async () => {
    const sqlText = fs.readFileSync(
      path.join(DRIZZLE_DIR, '0016_seductive_power.sql'),
      'utf8',
    );
    const guardStatement = sqlText
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .find((x) => x.startsWith('DO $$'))!;
    await expect(pool.query(guardStatement)).resolves.toBeTruthy();
  });
});
