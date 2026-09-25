/**
 * 0040 — do the 25 salvage items keep their identity through the slug rename?
 *
 * The one thing this migration must not do is cost a player a stack of
 * salvage. Every other test starts from a fully-migrated database seeded with
 * the *new* content and therefore cannot see this: the question is about rows
 * written under the old slugs meeting 0040.
 *
 * So this file migrates to 0039 and stops, writes the old world by hand —
 * items on their old slugs, inventory and shop history against those ids, an
 * in-flight expedition snapshot, an unclaimed payout, a gift, an effect and
 * admin-authored world-encounter JSON — applies 0040 alone, and asserts that
 * every id, owner and quantity is exactly where it was while every slug has
 * moved.
 *
 * It applies the SQL by hand rather than through `runMigrations`, for the same
 * reason as `expeditionMigration.test.ts`: the migrator cannot stop part-way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { inject } from 'vitest';
import fs from 'node:fs';

const DRIZZLE = path.resolve(__dirname, '..', '..', 'drizzle');

/** The approved mapping, spelled out so the test does not trust the SQL's copy. */
const RENAMES: readonly (readonly [string, string])[] = [
  ['bent_arcade_token', 'sticky_joystick'],
  ['cracked_shrine_charm', 'cracked_butt_plug'],
  ['dropped_setlist', 'cum_stained_evening_dress'],
  ['last_train_ticket', 'glory_hole_ticket'],
  ['moonlit_perfume_vial', 'chewed_gag_ball'],
  ['neon_sign_filament', 'still_buzzing_wand'],
  ['smudged_love_letter', 'crusted_magazine'],
  ['bathhouse_locker_token', 'stained_damp_towel'],
  ['chipped_enamel_pie_plate', 'licked_clean_pie_tin'],
  ['geothermal_core_sample', 'threadworn_love_glove'],
  ['ridge_road_postcard', 'frozen_cum_rag'],
  ['snapped_board_binding', 'ripped_leggings'],
  ['survey_flag_bundle', 'thawed_onahole'],
  ['leaning_cairn_stone', 'broken_penis_pump'],
  ['orchard_brandy_jar', 'sweat_stained_leather_harness'],
  ['quarry_grit_pouch', 'weighted_ball_stretcher'],
  ['skyfreight_ballast_weight', 'dropped_chastity_cage'],
  ['split_fence_rail', 'rusted_anal_beads'],
  ['undelivered_wax_seal', 'snapped_cock_ring'],
  ['canyon_cut_gemstone', 'sun_cracked_flogger'],
  ['dust_choked_rig_filter', 'dust_caked_blindfold'],
  ['sand_scoured_bearing', 'sand_scoured_nipple_clamps'],
  ['spent_blasting_cap', 'blown_out_fleshlight'],
  ['strongbox_hinge_plate', 'dried_up_lube_bottle'],
  ['surveyors_brass_dial', 'sun_bleached_strap_on'],
];
const OLD = RENAMES.map(([o]) => o);
const NEW = RENAMES.map(([, n]) => n);

let adminUrl: string;
const databases: { name: string; pool: Pool }[] = [];

async function freshDatabase(): Promise<Pool> {
  const name = `waifumon_salv_${randomBytes(6).toString('hex')}`;
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

/** A salvage row as the seeder would have written it, with a filler item beside it. */
async function insertItem(pool: Pool, slug: string, sellValue: number): Promise<number> {
  const { rows } = await pool.query(
    `insert into items (slug, name, category, sell_value, description, emoji)
     values ($1, $1, 'salvage', $2, 'old text', '⚙️') returning id`,
    [slug, sellValue],
  );
  return Number(rows[0].id);
}

async function insertPlayer(pool: Pool, tag: string): Promise<number> {
  const { rows: g } = await pool.query(
    `insert into guilds (discord_guild_id) values ($1) returning id`,
    [`g-${tag}`],
  );
  const { rows: p } = await pool.query(
    `insert into players (discord_user_id, guild_id) values ($1, $2) returning id`,
    [`u-${tag}`, g[0].id],
  );
  return Number(p[0].id);
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

describe('0040 salvage slug rename', () => {
  it('renames all 25 items in place and carries every owned stack and frozen reference with them', async () => {
    const pool = await freshDatabase();
    await applyUpTo(pool, '0039_expedition_regional_concurrency');

    // ── The old world ──
    const idBySlug = new Map<string, number>();
    for (const [i, slug] of OLD.entries()) idBySlug.set(slug, await insertItem(pool, slug, 10 + i));
    const bystander = await insertItem(pool, 'basic_charm_stand_in', 99);

    const alice = await insertPlayer(pool, 'alice');
    const bob = await insertPlayer(pool, 'bob');
    // Every salvage item owned by someone, at distinct quantities, plus a bystander stack.
    for (const [i, slug] of OLD.entries()) {
      await pool.query(
        `insert into player_inventory (player_id, item_id, quantity) values ($1, $2, $3)`,
        [i % 2 === 0 ? alice : bob, idBySlug.get(slug), i + 1],
      );
    }
    await pool.query(
      `insert into player_inventory (player_id, item_id, quantity) values ($1, $2, 7)`,
      [alice, bystander],
    );
    await pool.query(
      `insert into shop_transactions (player_id, item_id, kind, quantity, unit_price, total_price, balance_after)
       values ($1, $2, 'sale', 3, 12, 36, 100)`,
      [alice, idBySlug.get('neon_sign_filament')],
    );

    const inventoryBefore = (
      await pool.query(`select player_id, item_id, quantity from player_inventory order by player_id, item_id`)
    ).rows;
    const shopBefore = (await pool.query(`select * from shop_transactions order by id`)).rows;

    // An in-flight mission whose reward snapshot names old slugs, and an
    // unclaimed payout that names one.
    const plan = {
      planVersion: 1,
      definition: { key: 'valley_stockroom_squeeze', name: 'Stockroom Squeeze' },
      successTable: {
        id: 'valley-corner-store-success-v4',
        groups: [
          {
            id: 'back-room-scrap',
            rolls: 2,
            chanceBasisPoints: 8500,
            entries: [
              { itemId: 'bent_arcade_token', weight: 80, quantity: 1, enabled: true },
              { itemId: 'smudged_love_letter', weight: 20, quantity: 1, enabled: true },
            ],
          },
        ],
      },
      bonusTable: null,
      failureTable: null,
    };
    const { rows: active } = await pool.query(
      `insert into player_expeditions
         (player_id, slot_index, expedition_key, region, waifu_id, completes_at,
          success_chance, exceptional_chance, suitability_band, resolution_plan, logic_version)
       values ($1, 1, 'valley_stockroom_squeeze', 'waifu-valley', 4242, now() + interval '6 hours',
               0.62, 0.07, 'STRONG_MATCH', $2::jsonb, 1)
       returning id`,
      [alice, JSON.stringify(plan)],
    );
    const { rows: resolved } = await pool.query(
      `insert into player_expeditions
         (player_id, slot_index, expedition_key, region, waifu_id, completes_at,
          success_chance, exceptional_chance, suitability_band, status, outcome, resolved_at, rewards)
       values ($1, 1, 'peeks_on_her_knees', 'twin-peeks', 4343, now() - interval '1 hour',
               0.5, 0.05, 'WEAK_MATCH', 'resolved', 'success', now(), $2::jsonb)
       returning id`,
      [bob, JSON.stringify({ waifubux: 4, items: [{ slug: 'bathhouse_locker_token', quantity: 2 }] })],
    );

    await pool.query(
      `insert into affection_gifts
         (player_id, waifu_id, item_slug, quantity, affection_at_generation, tier_at_generation, source, reset_date)
       values ($1, 4242, 'last_train_ticket', 1, 50, 'mid', 'random', current_date)`,
      [alice],
    );
    await pool.query(
      `insert into player_active_effects (player_id, effect_type, source_item_slug)
       values ($1, 'capture_bonus_charges', 'geothermal_core_sample')`,
      [bob],
    );

    // Admin-authored world-encounter data naming salvage — including one that
    // mentions a slug only inside prose, which must be left alone.
    const { rows: enc } = await pool.query(
      `insert into world_encounters (slug, name, type, rarity) values ('scrap_trader', 'Scrap Trader', 'vendor', 'common') returning id`,
    );
    await pool.query(
      `insert into world_encounter_choices (encounter_id, label, success_effects_json, failure_effects_json)
       values ($1, 'Trade', $2::jsonb, '[]'::jsonb)`,
      [enc[0].id, JSON.stringify([{ type: 'grant_item', itemSlug: 'canyon_cut_gemstone', quantity: 1 }])],
    );
    await pool.query(
      `insert into world_encounter_vendors (vendor_key, name, stock_template_json) values ('scrap', 'Scrap', $1::jsonb)`,
      [JSON.stringify([{ itemSlug: 'spent_blasting_cap', price: 30 }, { note: 'say "spent_blasting_cap" twice' }])],
    );

    // ── Apply 0040 alone ──
    await applyStatements(pool, '0040_salvage_slug_rename.sql');

    // Every id preserved, under exactly one row with the new slug, and no old slug left.
    for (const [oldSlug, newSlug] of RENAMES) {
      const { rows } = await pool.query(`select id, slug from items where slug = any($1)`, [[oldSlug, newSlug]]);
      expect(rows, `${oldSlug} → ${newSlug}`).toHaveLength(1);
      expect(rows[0].slug).toBe(newSlug);
      expect(Number(rows[0].id)).toBe(idBySlug.get(oldSlug));
    }
    const { rows: oldLeft } = await pool.query(`select slug from items where slug = any($1)`, [OLD]);
    expect(oldLeft).toEqual([]);
    const { rows: dupes } = await pool.query(
      `select slug from items where slug = any($1) group by slug having count(*) > 1`,
      [NEW],
    );
    expect(dupes).toEqual([]);
    const { rows: itemCount } = await pool.query(`select count(*)::int n from items`);
    expect(itemCount[0].n).toBe(26);
    // Nothing but the slug moved on those rows.
    const { rows: untouched } = await pool.query(
      `select count(*)::int n from items where slug = any($1) and name <> slug and sell_value between 10 and 34`,
      [NEW],
    );
    expect(untouched[0].n).toBe(25);

    // Inventory: same rows, same item ids, same owners, same quantities.
    const inventoryAfter = (
      await pool.query(`select player_id, item_id, quantity from player_inventory order by player_id, item_id`)
    ).rows;
    expect(inventoryAfter).toEqual(inventoryBefore);
    expect((await pool.query(`select * from shop_transactions order by id`)).rows).toEqual(shopBefore);

    // Frozen JSON now names the new slugs; everything else in it is unchanged.
    const { rows: a } = await pool.query(`select resolution_plan from player_expeditions where id = $1`, [active[0].id]);
    const expectedPlan = JSON.parse(
      JSON.stringify(plan)
        .replace('"bent_arcade_token"', '"sticky_joystick"')
        .replace('"smudged_love_letter"', '"crusted_magazine"'),
    );
    expect(a[0].resolution_plan).toEqual(expectedPlan);
    const { rows: r } = await pool.query(`select rewards from player_expeditions where id = $1`, [resolved[0].id]);
    expect(r[0].rewards).toEqual({ waifubux: 4, items: [{ slug: 'stained_damp_towel', quantity: 2 }] });

    expect((await pool.query(`select item_slug from affection_gifts`)).rows).toEqual([{ item_slug: 'glory_hole_ticket' }]);
    expect((await pool.query(`select source_item_slug from player_active_effects`)).rows).toEqual([
      { source_item_slug: 'threadworn_love_glove' },
    ]);
    const { rows: choice } = await pool.query(`select success_effects_json from world_encounter_choices`);
    expect(choice[0].success_effects_json).toEqual([{ type: 'grant_item', itemSlug: 'sun_cracked_flogger', quantity: 1 }]);
    const { rows: vendor } = await pool.query(`select stock_template_json from world_encounter_vendors`);
    expect(vendor[0].stock_template_json).toEqual([
      { itemSlug: 'blown_out_fleshlight', price: 30 },
      { note: 'say "spent_blasting_cap" twice' },
    ]);

    // Meeting it a second time is a no-op, not an error.
    await applyStatements(pool, '0040_salvage_slug_rename.sql');
    expect(
      (await pool.query(`select player_id, item_id, quantity from player_inventory order by player_id, item_id`)).rows,
    ).toEqual(inventoryBefore);
  });

  it('refuses — and writes nothing — when an old slug and its new slug both already exist', async () => {
    const pool = await freshDatabase();
    await applyUpTo(pool, '0039_expedition_regional_concurrency');

    const oldId = await insertItem(pool, 'moonlit_perfume_vial', 20);
    const clashId = await insertItem(pool, 'chewed_gag_ball', 20);
    const otherId = await insertItem(pool, 'bent_arcade_token', 10);
    const player = await insertPlayer(pool, 'carol');
    await pool.query(
      `insert into player_inventory (player_id, item_id, quantity) values ($1, $2, 3), ($1, $3, 5)`,
      [player, oldId, clashId],
    );

    await expect(applyStatements(pool, '0040_salvage_slug_rename.sql')).rejects.toThrow(
      /refused: both "moonlit_perfume_vial".*"chewed_gag_ball".*will not merge/,
    );

    // Rolled back whole: not even the unaffected pair was renamed.
    const { rows } = await pool.query(`select id, slug from items order by id`);
    expect(rows.map((x) => [Number(x.id), x.slug])).toEqual([
      [oldId, 'moonlit_perfume_vial'],
      [clashId, 'chewed_gag_ball'],
      [otherId, 'bent_arcade_token'],
    ]);
    const { rows: inv } = await pool.query(
      `select item_id, quantity from player_inventory order by item_id`,
    );
    expect(inv.map((x) => [Number(x.item_id), x.quantity])).toEqual([
      [oldId, 3],
      [clashId, 5],
    ]);
  });
});
