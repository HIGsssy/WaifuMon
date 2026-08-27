/**
 * Migration 0017 — that the tables the application relies on actually exist,
 * with the constraints it delegates its correctness to.
 *
 * Every assertion here is against `information_schema` / `pg_indexes` rather
 * than against the drizzle schema object, because the point is to catch the
 * two failure modes the drizzle model cannot see: a hand-written migration
 * that drifted from `schema.ts`, and a journal entry whose `when` was set below
 * the previous one, which makes the migrator skip the file silently.
 */
import { sql } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bossEncounters, bossParticipations, guilds } from '../../src/db/schema';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;

beforeAll(async () => {
  // `createTestDb` runs the real migrations to head, so simply reaching this
  // point proves 0017 applied.
  t = await createTestDb();
});
afterAll(async () => {
  await t.cleanup();
});

async function columnsOf(table: string): Promise<Map<string, { type: string; nullable: string }>> {
  const result = await t.db.execute(
    sql`select column_name, data_type, is_nullable
        from information_schema.columns
        where table_name = ${table}`,
  );
  return new Map(
    (result.rows as { column_name: string; data_type: string; is_nullable: string }[]).map(
      (r) => [r.column_name, { type: r.data_type, nullable: r.is_nullable }],
    ),
  );
}

async function indexesOf(table: string): Promise<Map<string, string>> {
  const result = await t.db.execute(
    sql`select indexname, indexdef from pg_indexes where tablename = ${table}`,
  );
  return new Map(
    (result.rows as { indexname: string; indexdef: string }[]).map((r) => [
      r.indexname,
      r.indexdef,
    ]),
  );
}

describe('the migration applied', () => {
  it('created all three boss tables', async () => {
    for (const table of ['guild_boss_state', 'boss_encounters', 'boss_participations']) {
      expect((await columnsOf(table)).size, table).toBeGreaterThan(0);
    }
  });

  it('added the boss channel column to guilds', async () => {
    const columns = await columnsOf('guilds');
    expect(columns.get('boss_channel_id')).toEqual({ type: 'text', nullable: 'YES' });
  });

  it('gave existing guild rows a null boss channel — bosses off by default', async () => {
    const [row] = await t.db
      .insert(guilds)
      .values({ discordGuildId: 'g-migration' })
      .returning();
    expect(row!.bossChannelId).toBeNull();
  });
});

describe('boss_encounters', () => {
  it('carries every lifecycle timestamp the scheduler persists', async () => {
    const columns = await columnsOf('boss_encounters');
    for (const column of [
      'scheduled_at',
      'scouting_started_at',
      'deadline_at',
      'resolving_at',
      'resolved_at',
      'next_spawn_at',
    ]) {
      expect(columns.has(column), column).toBe(true);
    }
    // Only the scheduled appearance is mandatory; the rest are stamped as the
    // lifecycle advances.
    expect(columns.get('scheduled_at')!.nullable).toBe('NO');
    expect(columns.get('deadline_at')!.nullable).toBe('YES');
  });

  it('carries the content and calculation snapshot', async () => {
    const columns = await columnsOf('boss_encounters');
    for (const column of [
      'boss_id',
      'boss_name',
      'boss_affinity',
      'boss_artwork',
      'reward_table',
      'reward_table_version',
      'calc_version',
      'affinity_version',
      'region',
      'channel_id',
      'message_id',
      'participant_count',
      'total_damage',
      'resolution_reason',
      'forced',
    ]) {
      expect(columns.has(column), column).toBe(true);
    }
  });

  it('enforces one active encounter per guild with a partial unique index', async () => {
    const indexes = await indexesOf('boss_encounters');
    const definition = indexes.get('boss_encounters_active_guild_uq');
    expect(definition).toBeDefined();
    expect(definition).toContain('UNIQUE');
    // The partial predicate is what lets a guild have any number of *finished*
    // encounters while holding at most one live one.
    expect(definition).toContain("status");
    expect(definition).toContain('scheduled');
    expect(definition).toContain('scouting');
    expect(definition).toContain('resolving');
  });

  it('rejects an unknown lifecycle status', async () => {
    await expect(
      t.db.execute(sql`
        insert into boss_encounters
          (guild_id, region, boss_id, boss_name, boss_affinity, reward_table,
           reward_table_version, calc_version, affinity_version, status, scheduled_at)
        select id, 'waifu-valley', 'x', 'X', 'primal', 't', 'v', 1, 1, 'exploding', now()
        from guilds limit 1
      `),
    ).rejects.toThrow();
  });

  it('rejects an unknown resolution reason', async () => {
    await expect(
      t.db.execute(sql`
        insert into boss_encounters
          (guild_id, region, boss_id, boss_name, boss_affinity, reward_table,
           reward_table_version, calc_version, affinity_version, status,
           scheduled_at, resolution_reason)
        select id, 'waifu-valley', 'x', 'X', 'primal', 't', 'v', 1, 1, 'resolved', now(), 'vibes'
        from guilds limit 1
      `),
    ).rejects.toThrow();
  });

  it('rejects negative damage and participant counts', async () => {
    for (const column of ['total_damage', 'participant_count']) {
      await expect(
        t.db.execute(sql`
          insert into boss_encounters
            (guild_id, region, boss_id, boss_name, boss_affinity, reward_table,
             reward_table_version, calc_version, affinity_version, status,
             scheduled_at, ${sql.raw(column)})
          select id, 'waifu-valley', 'x', 'X', 'primal', 't', 'v', 1, 1, 'resolved', now(), -1
          from guilds limit 1
        `),
        column,
      ).rejects.toThrow();
    }
  });
});

describe('boss_participations', () => {
  it('carries every snapshot field the damage formula reads', async () => {
    const columns = await columnsOf('boss_participations');
    for (const column of [
      'waifu_id',
      'species_id',
      'species_slug',
      'waifu_name',
      'level',
      'base_sp',
      'current_sp',
      'rarity',
      'affinity',
      'race',
      'affection',
      'committed_at',
      'response_bonus',
      'affinity_bonus',
      'discord_user_id',
      'trainer_name',
    ]) {
      expect(columns.has(column), column).toBe(true);
      expect(columns.get(column)!.nullable, column).toBe('NO');
    }
  });

  it('leaves every resolution field nullable — nothing is known at commitment', async () => {
    const columns = await columnsOf('boss_participations');
    for (const column of [
      'performance_percent',
      'attack_count',
      'total_damage',
      'xp_awarded',
      'reward_items',
      'resolved_at',
    ]) {
      expect(columns.get(column)!.nullable, column).toBe('YES');
    }
    // …except the delivery flag, which must always have a definite value.
    expect(columns.get('reward_status')!.nullable).toBe('NO');
  });

  it('enforces one participation per player per encounter', async () => {
    const indexes = await indexesOf('boss_participations');
    const definition = indexes.get('boss_participations_encounter_player_uq');
    expect(definition).toBeDefined();
    expect(definition).toContain('UNIQUE');
    expect(definition).toContain('encounter_id');
    expect(definition).toContain('player_id');
  });

  it('keeps waifu_id free of a foreign key so a released copy keeps its history', async () => {
    const result = await t.db.execute(sql`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'boss_participations'::regclass and contype = 'f'
    `);
    const definitions = (result.rows as { def: string }[]).map((r) => r.def);
    // The encounter and the player are referential; the owned copy deliberately
    // is not — releasing her must not take a battle result with her.
    expect(definitions.some((d) => d.includes('boss_encounters'))).toBe(true);
    expect(definitions.some((d) => d.includes('players'))).toBe(true);
    expect(definitions.some((d) => d.includes('waifu_id'))).toBe(false);
  });

  it('rejects an unknown reward status', async () => {
    // Asserted against the constraint itself rather than by attempting a bad
    // write: the table is empty here, so an UPDATE would match zero rows and
    // succeed without ever exercising the CHECK.
    const result = await t.db.execute(sql`
      select pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'boss_participations'::regclass
        and conname = 'boss_participations_reward_status_check'
    `);
    const def = (result.rows as { def: string }[])[0]?.def ?? '';
    expect(def).toContain('pending');
    expect(def).toContain('applied');
  });
});

describe('guild_boss_state', () => {
  it('holds the shuffle bag, the next appearance and the pause/suspend flags', async () => {
    const columns = await columnsOf('guild_boss_state');
    expect(columns.get('bag_state')!.type).toBe('jsonb');
    expect(columns.has('next_spawn_at')).toBe(true);
    expect(columns.has('paused')).toBe(true);
    expect(columns.has('suspended_reason')).toBe(true);
    expect(columns.has('suspended_at')).toBe(true);
  });

  it('rejects a region outside the canonical set', async () => {
    await expect(
      t.db.execute(sql`
        insert into guild_boss_state (guild_id, region)
        select id, 'atlantis' from guilds limit 1
      `),
    ).rejects.toThrow();
  });
});

describe('the migration journal', () => {
  it('stamps 0017 above 0016 so the migrator does not skip it', () => {
    // The node-postgres migrator skips any entry whose folder timestamp is not
    // greater than the last applied one, and this repository's hand-written
    // entries carry far-future values that `Date.now()` would fall below.
    const journal = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'drizzle', 'meta', '_journal.json'),
        'utf8',
      ),
    ) as { entries: { idx: number; tag: string; when: number }[] };

    const entry = journal.entries.find((e) => e.tag === '0017_boss_encounters');
    expect(entry).toBeDefined();
    const previous = journal.entries.find((e) => e.idx === entry!.idx - 1);
    expect(entry!.when).toBeGreaterThan(previous!.when);
  });

  it('keeps every journal entry strictly ascending', () => {
    const journal = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'drizzle', 'meta', '_journal.json'),
        'utf8',
      ),
    ) as { entries: { idx: number; when: number }[] };
    const sorted = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.when, `entry ${sorted[i]!.idx}`).toBeGreaterThan(sorted[i - 1]!.when);
    }
  });

  it('has a SQL file for every journal entry', () => {
    const dir = path.resolve(__dirname, '..', '..', 'drizzle');
    const journal = JSON.parse(
      fs.readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    for (const entry of journal.entries) {
      expect(fs.existsSync(path.join(dir, `${entry.tag}.sql`)), entry.tag).toBe(true);
    }
  });
});

describe('the drizzle model matches the migrated database', () => {
  it('every modelled boss column exists in Postgres', async () => {
    for (const [table, model] of [
      ['boss_encounters', bossEncounters],
      ['boss_participations', bossParticipations],
    ] as const) {
      const actual = await columnsOf(table);
      for (const [key, column] of Object.entries(model)) {
        // The table object carries non-column members (`enableRLS` and
        // friends); a real column is the one that reports a SQL type.
        const candidate = column as { name?: unknown; columnType?: unknown };
        if (typeof candidate.name !== 'string' || typeof candidate.columnType !== 'string') {
          continue;
        }
        expect(actual.has(candidate.name), `${table}.${key} (${candidate.name})`).toBe(true);
      }
    }
  });
});
