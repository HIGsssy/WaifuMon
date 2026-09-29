/**
 * 0043 — does every player who could reach the Assteroid Belt before the
 * Transporter Beacon still reach it after?
 *
 * Before 0043, Belt access was exactly one fact: a `player_unlocked_routes`
 * row for `assteroid-belt` (bought for 3,000 WaifuBux, or granted by an
 * admin). After it, access is holding a `transporter_beacon`. Every other test
 * starts from a fully-migrated, freshly-seeded database and so cannot see the
 * hand-over; this file migrates to 0042 and stops, writes the old world by
 * hand, applies 0043 alone, and asserts who came out holding a beacon.
 *
 * It applies SQL by hand rather than through `runMigrations`, for the same
 * reason as `salvageSlugMigration.test.ts`: the migrator cannot stop part-way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { inject } from 'vitest';

const DRIZZLE = path.resolve(__dirname, '..', '..', 'drizzle');
const MIGRATION = '0043_transporter_beacon.sql';

let adminUrl: string;
const databases: { name: string; pool: Pool }[] = [];

async function freshDatabase(): Promise<Pool> {
  const name = `waifumon_beacon_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  databases.push({ name, pool });
  return pool;
}

async function applyStatements(pool: Pool, file: string) {
  const sql = fs.readFileSync(path.join(DRIZZLE, file), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) await pool.query(statement);
  }
}

async function applyUpTo(pool: Pool, lastTag: string) {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    await applyStatements(pool, `${entry.tag}.sql`);
    if (entry.tag === lastTag) return;
  }
}

async function insertPlayer(pool: Pool, tag: string, region = 'waifu-valley'): Promise<number> {
  const { rows: g } = await pool.query(
    `insert into guilds (discord_guild_id) values ($1) returning id`,
    [`g-${tag}`],
  );
  const { rows: p } = await pool.query(
    `insert into players (discord_user_id, guild_id, current_region) values ($1, $2, $3) returning id`,
    [`u-${tag}`, g[0].id, region],
  );
  return Number(p[0].id);
}

async function route(pool: Pool, playerId: number, regionId: string, source = 'purchase') {
  await pool.query(
    `insert into player_unlocked_routes (player_id, region_id, source) values ($1, $2, $3)`,
    [playerId, regionId, source],
  );
}

async function beacons(pool: Pool): Promise<Map<number, number>> {
  const { rows } = await pool.query(
    `select pi.player_id, pi.quantity from player_inventory pi
       join items i on i.id = pi.item_id where i.slug = 'transporter_beacon'`,
  );
  return new Map(rows.map((r) => [Number(r.player_id), Number(r.quantity)]));
}

async function audits(pool: Pool) {
  const { rows } = await pool.query(
    `select player_id, recipe_id, source, waifubux_spent, inputs, balance_after
       from key_item_constructions order by player_id`,
  );
  return rows.map((r) => ({ ...r, player_id: Number(r.player_id) }));
}

beforeAll(() => {
  adminUrl = inject('adminDatabaseUrl');
});

afterAll(async () => {
  for (const { name, pool } of databases) {
    await pool.end();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});

describe('0043 Transporter Beacon backfill', () => {
  it('grants exactly one beacon to every player who already had Belt access, and to no one else', async () => {
    const pool = await freshDatabase();
    await applyUpTo(pool, '0042_assteroid_belt_region');

    // ── The old world ──
    // Bought the Belt route the normal way, and is standing in it.
    const buyer = await insertPlayer(pool, 'buyer', 'assteroid-belt');
    await route(pool, buyer, 'twin-peeks');
    await route(pool, buyer, 'base-80085');
    await route(pool, buyer, 'assteroid-belt');
    await pool.query(
      `insert into travel_transactions (player_id, kind, pass_id, region_id, amount, balance_after)
       values ($1, 'route', 'caravan_pass', 'assteroid-belt', 3000, 120)`,
      [buyer],
    );
    // Granted the Belt route by an admin — also legitimate access.
    const granted = await insertPlayer(pool, 'granted');
    await route(pool, granted, 'assteroid-belt', 'admin');
    // Owns every *other* route, but never the Belt.
    const almost = await insertPlayer(pool, 'almost');
    for (const r of ['twin-peeks', 'flaccid-foothills', 'thirstlands', 'base-80085']) {
      await route(pool, almost, r);
    }
    // Standing in the Belt with no route row — only an admin edit does this.
    // Not evidence of access; the player can still leave by travelling.
    const stray = await insertPlayer(pool, 'stray', 'assteroid-belt');
    // A brand-new player.
    const fresh = await insertPlayer(pool, 'fresh');

    const routesBefore = (
      await pool.query(`select player_id, region_id, source from player_unlocked_routes order by 1, 2`)
    ).rows;

    await applyStatements(pool, MIGRATION);

    const held = await beacons(pool);
    expect(held.get(buyer)).toBe(1);
    expect(held.get(granted)).toBe(1);
    expect(held.has(almost)).toBe(false);
    expect(held.has(stray)).toBe(false);
    expect(held.has(fresh)).toBe(false);
    expect(held.size).toBe(2);

    // Audited as migration grants: nothing charged, nothing consumed.
    expect(await audits(pool)).toEqual(
      [buyer, granted].sort((a, b) => a - b).map((player_id) => ({
        player_id,
        recipe_id: 'transporter_beacon',
        source: 'migration',
        waifubux_spent: 0,
        inputs: [],
        balance_after: null,
      })),
    );

    // Route rows are left exactly as they were — inert history now.
    expect(
      (await pool.query(`select player_id, region_id, source from player_unlocked_routes order by 1, 2`))
        .rows,
    ).toEqual(routesBefore);
    // Nobody was moved.
    const { rows: regions } = await pool.query(
      `select id, current_region from players where id = any($1) order by id`,
      [[buyer, stray]],
    );
    expect(regions.map((r) => r.current_region)).toEqual(['assteroid-belt', 'assteroid-belt']);

    // The item row it created is the capped key item the seeder expects.
    const { rows: item } = await pool.query(
      `select category, max_owned, buy_price, sell_value, shop_regions from items where slug = 'transporter_beacon'`,
    );
    expect(item[0]).toEqual({
      category: 'key',
      max_owned: 1,
      buy_price: null,
      sell_value: null,
      shop_regions: [],
    });
  });

  it('is idempotent: a second run grants nothing and audits nothing', async () => {
    const pool = await freshDatabase();
    await applyUpTo(pool, '0042_assteroid_belt_region');
    const buyer = await insertPlayer(pool, 'again');
    await route(pool, buyer, 'assteroid-belt');

    await applyStatements(pool, MIGRATION);
    const afterFirst = { held: await beacons(pool), audits: await audits(pool) };
    await applyStatements(pool, MIGRATION);
    expect(await beacons(pool)).toEqual(afterFirst.held);
    expect(await audits(pool)).toEqual(afterFirst.audits);
    expect(afterFirst.held.get(buyer)).toBe(1);
  });

  it('never stacks a second beacon on a player who already holds one', async () => {
    const pool = await freshDatabase();
    await applyUpTo(pool, '0042_assteroid_belt_region');
    // The item row exists already (as if new content had been seeded first),
    // one player holds a beacon, another has an emptied (zero) stack.
    await pool.query(
      `insert into items (slug, name, category, description) values ('transporter_beacon', 'Transporter Beacon', 'key', '')`,
    );
    const { rows } = await pool.query(`select id from items where slug = 'transporter_beacon'`);
    const beaconId = Number(rows[0].id);
    const holder = await insertPlayer(pool, 'holder');
    const emptied = await insertPlayer(pool, 'emptied');
    for (const p of [holder, emptied]) await route(pool, p, 'assteroid-belt');
    await pool.query(
      `insert into player_inventory (player_id, item_id, quantity) values ($1, $3, 1), ($2, $3, 0)`,
      [holder, emptied, beaconId],
    );

    await applyStatements(pool, MIGRATION);

    const held = await beacons(pool);
    expect(held.get(holder)).toBe(1);
    expect(held.get(emptied)).toBe(1);
    // Only the player whose stack actually changed is audited.
    expect((await audits(pool)).map((a) => a.player_id)).toEqual([emptied]);
  });
});
