/**
 * Seductive Power against real Postgres — persistence, the migration's
 * deterministic backfill, and the database invariants.
 *
 * The property under test throughout is *permanence*: a Base SP is written
 * once, by the capture that created the copy, and nothing afterwards — a
 * level-up, a restart, a content reload, a re-run migration — may change it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  captureAttempts,
  encounters,
  playerWaifus,
  species,
  RARITIES,
  type EncounterRow,
  type SpeciesRow,
} from '../../src/db/schema';
import { createCaptureService } from '../../src/modules/capture/captureService';
import { seedContent } from '../../src/modules/content/seeder';
import {
  currentSeductivePower,
  DEFAULT_SP_RANGES_BY_RARITY,
  isValidBaseSeductivePower,
  rangeForRarity,
  SP_BACKFILL_SALT,
} from '../../src/modules/power/seductivePower';
import {
  backfillHash,
  deterministicBaseSeductivePower,
} from '../../src/modules/power/seductivePowerBackfill';
import type { Rng } from '../../src/shared/random';
import {
  bootstrapApp,
  getItemBySlug,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-sp', 'u-1'));
});
afterAll(async () => {
  await t.cleanup();
});

/**
 * An Rng whose `intInclusive` is pinned, so a capture's SP roll is exactly
 * predictable. `next()` drives the capture chance separately.
 */
function pinnedRng(pick: 'min' | 'max' | number, chance = 0): Rng {
  return {
    next: () => chance,
    intInclusive(min, max) {
      if (pick === 'min') return min;
      if (pick === 'max') return max;
      return Math.min(max, Math.max(min, pick));
    },
  };
}

function captureService(rng: Rng) {
  return createCaptureService({
    db: t.db,
    inventory: app.inventory,
    progression: app.progression,
    progressionConfig: app.content.tables.progression,
    captureConfig: app.content.tables.capture,
    buddyAffinityConfig: app.content.tables.buddyAffinity,
    seductivePowerConfig: app.content.tables.seductivePower,
    collection: app.collection,
    quests: app.quests,
    effects: app.effects,
    appearance: app.appearance,
    logger: t.logger,
    rng,
  });
}

async function speciesOfRarity(rarity: string): Promise<SpeciesRow> {
  const [row] = await t.db
    .select()
    .from(species)
    .where(and(eq(species.rarity, rarity), eq(species.enabled, true)))
    .limit(1);
  if (!row) throw new Error(`no enabled ${rarity} species seeded`);
  return row;
}

async function createEncounter(speciesRow: SpeciesRow): Promise<EncounterRow> {
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
  const [row] = await t.db
    .insert(encounters)
    .values({
      playerId,
      speciesId: speciesRow.id,
      channelId: 'chan-sp',
      state: 'active',
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  return row!;
}

async function grant(slug: string, qty: number): Promise<void> {
  const item = await getItemBySlug(t.db, slug);
  await app.inventory.addItem(t.db, playerId, item.id, qty);
}

/** A guaranteed capture of one species, with SP pinned by `rng`. */
async function captureWith(speciesRow: SpeciesRow, rng: Rng) {
  await grant('mythic_contract', 1);
  const encounter = await createEncounter(speciesRow);
  return captureService(rng).attemptCapture(playerId, encounter.id, 'mythic_contract');
}

beforeEach(async () => {
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
});

// ─────────────────────────── capture persistence ─────────────────────────

describe('capture writes Base SP', () => {
  it('stores an in-band value for every rarity present in the roster', async () => {
    for (const rarity of RARITIES) {
      const rows = await t.db
        .select()
        .from(species)
        .where(and(eq(species.rarity, rarity), eq(species.enabled, true)))
        .limit(1);
      if (!rows[0]) continue; // EX ships no species yet; covered below.
      const result = await captureWith(rows[0], pinnedRng('min'));
      const baseSp = result.newWaifu!.baseSp;
      expect(isValidBaseSeductivePower(baseSp, rarity), `${rarity} -> ${baseSp}`).toBe(true);
      expect(baseSp).toBe(rangeForRarity(rarity).min);
    }
  });

  it('rolls the inclusive maximum when the rng says so', async () => {
    const speciesRow = await speciesOfRarity('R');
    const result = await captureWith(speciesRow, pinnedRng('max'));
    expect(result.newWaifu!.baseSp).toBe(rangeForRarity('R').max);
  });

  it('supports EX even though the roster has none — the ladder is what matters', async () => {
    // Temporarily promote a species to EX: the first EX Waifumon to ship must
    // roll like everyone else rather than trip an unknown-rarity error.
    const victim = await speciesOfRarity('N');
    await t.db.update(species).set({ rarity: 'EX' }).where(eq(species.id, victim.id));
    try {
      const [promoted] = await t.db.select().from(species).where(eq(species.id, victim.id));
      const result = await captureWith(promoted!, pinnedRng('min'));
      expect(result.newWaifu!.baseSp).toBe(180);
      expect(isValidBaseSeductivePower(result.newWaifu!.baseSp, 'EX')).toBe(true);
    } finally {
      await t.db.update(species).set({ rarity: 'N' }).where(eq(species.id, victim.id));
    }
  });

  it('gives duplicate captures of one species independent permanent values', async () => {
    const speciesRow = await speciesOfRarity('N');
    const first = await captureWith(speciesRow, pinnedRng('min'));
    const second = await captureWith(speciesRow, pinnedRng('max'));

    expect(first.newWaifu!.speciesId).toBe(second.newWaifu!.speciesId);
    expect(first.newWaifu!.baseSp).toBe(90);
    expect(second.newWaifu!.baseSp).toBe(100);

    // And they stay apart on re-read — neither is derived from the species.
    const rows = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.playerId, playerId));
    expect(rows.map((r) => r.baseSp).sort((a, b) => a - b)).toEqual([90, 100]);
  });

  it('never recomputes on read, on level change, or on a content reload', async () => {
    const speciesRow = await speciesOfRarity('SR');
    const captured = await captureWith(speciesRow, pinnedRng(127));
    const waifuId = captured.newWaifu!.id;
    expect(captured.newWaifu!.baseSp).toBe(127);

    // Level her up through the real service, then re-read.
    await app.currency.grantEssence(t.db, playerId, 5000);
    await app.collection.investEssenceBatch(playerId, waifuId, 20);
    const entry = await app.collection.getOwned(playerId, waifuId);
    expect(entry.waifu.level).toBeGreaterThan(1);
    expect(entry.waifu.baseSp).toBe(127);

    // A re-seed is what a content reload does to the species rows.
    await seedContent(t.db, app.content, t.logger);
    const after = await app.collection.getOwned(playerId, waifuId);
    expect(after.waifu.baseSp).toBe(127);
  });

  it('a rolled-back capture leaves no copy and therefore no SP', async () => {
    const speciesRow = await speciesOfRarity('N');
    const encounter = await createEncounter(speciesRow);
    // No charm owned: the transaction aborts at `consumeItem`, after the
    // encounter lock and before the insert.
    await expect(
      captureService(pinnedRng('min')).attemptCapture(playerId, encounter.id, 'mythic_contract'),
    ).rejects.toThrow();

    const rows = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.playerId, playerId));
    expect(rows).toHaveLength(0);
    expect(
      await t.db
        .select()
        .from(captureAttempts)
        .where(eq(captureAttempts.encounterId, encounter.id)),
    ).toHaveLength(0);
  });

  it('a refused retry cannot leave a second copy or reroll the first', async () => {
    const speciesRow = await speciesOfRarity('N');
    await grant('mythic_contract', 2);
    const encounter = await createEncounter(speciesRow);
    const service = captureService(pinnedRng('min'));

    const first = await service.attemptCapture(playerId, encounter.id, 'mythic_contract', {
      expectedAttemptCount: 0,
    });
    const baseSp = first.newWaifu!.baseSp;

    // The encounter is resolved; a re-fired interaction must not create a
    // second copy, and must not touch the first one's roll.
    await expect(
      service.attemptCapture(playerId, encounter.id, 'mythic_contract', {
        expectedAttemptCount: 0,
      }),
    ).rejects.toThrow();

    const rows = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.playerId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.baseSp).toBe(baseSp);
  });
});

// ────────────────────────── database invariants ──────────────────────────

describe('database invariants', () => {
  it('refuses an insert that omits base_sp', async () => {
    const speciesRow = await speciesOfRarity('N');
    await expect(
      t.db.execute(
        sql`insert into player_waifus (player_id, species_id) values (${playerId}, ${speciesRow.id})`,
      ),
    ).rejects.toThrow(/base_sp/i);
  });

  it('refuses a non-positive base_sp', async () => {
    const speciesRow = await speciesOfRarity('N');
    await expect(
      t.db.execute(
        sql`insert into player_waifus (player_id, species_id, base_sp) values (${playerId}, ${speciesRow.id}, 0)`,
      ),
    ).rejects.toThrow(/player_waifus_base_sp_check/i);
  });

  it('has no database default — the column cannot be filled in by accident', async () => {
    const result = await t.db.execute(sql`
      select column_default, is_nullable
      from information_schema.columns
      where table_name = 'player_waifus' and column_name = 'base_sp'
    `);
    const row = (result.rows as Array<{ column_default: string | null; is_nullable: string }>)[0];
    expect(row?.column_default).toBeNull();
    expect(row?.is_nullable).toBe('NO');
  });
});

// ──────────────────────── the deterministic backfill ─────────────────────

describe('historical backfill', () => {
  /** The migration's own SQL expression, run against this database. */
  async function sqlBackfillValue(waifuId: number, rarity: string): Promise<number> {
    const { min, max } = rangeForRarity(rarity);
    const span = max - min + 1;
    const result = await t.db.execute(sql`
      select ${min} + (
        ('x' || substr(md5(${String(waifuId)} || ':' || ${SP_BACKFILL_SALT}), 1, 8))::bit(32)::bigint
        % ${span}
      ) as value
    `);
    return Number((result.rows as Array<{ value: string }>)[0]!.value);
  }

  it('the TypeScript and SQL implementations agree across a wide id sweep', async () => {
    // The migration runs in SQL; `seductivePowerBackfill.ts` reproduces it so
    // the behaviour is testable and re-derivable. If these drift, a re-run of
    // the migration would silently disagree with the documented algorithm.
    for (const rarity of RARITIES) {
      for (const id of [1, 2, 3, 7, 42, 99, 1000, 65_535, 1_000_003]) {
        expect(await sqlBackfillValue(id, rarity), `${rarity}#${id}`).toBe(
          deterministicBaseSeductivePower(id, rarity),
        );
      }
    }
  });

  it('is deterministic — the same id always yields the same value', () => {
    for (let id = 1; id <= 200; id++) {
      const first = deterministicBaseSeductivePower(id, 'SR');
      expect(deterministicBaseSeductivePower(id, 'SR')).toBe(first);
      expect(deterministicBaseSeductivePower(id, 'SR')).toBe(first);
    }
  });

  it('always lands inside the rarity band', () => {
    for (const rarity of RARITIES) {
      for (let id = 1; id <= 500; id++) {
        expect(isValidBaseSeductivePower(deterministicBaseSeductivePower(id, rarity), rarity)).toBe(
          true,
        );
      }
    }
  });

  it('reaches every integer in the band, and does not pile onto the midpoint', () => {
    for (const rarity of RARITIES) {
      const { min, max } = rangeForRarity(rarity);
      const span = max - min + 1;
      const counts = new Map<number, number>();
      const sample = 8_000;
      for (let id = 1; id <= sample; id++) {
        const v = deterministicBaseSeductivePower(id, rarity);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      // Every value reachable...
      expect(counts.size).toBe(span);
      // ...and roughly uniform: no value takes more than double its share,
      // which a midpoint default (or a truncated range) would blow past.
      const expectedShare = sample / span;
      for (const [value, count] of counts) {
        expect(count, `${rarity} value ${value}`).toBeGreaterThan(expectedShare * 0.5);
        expect(count, `${rarity} value ${value}`).toBeLessThan(expectedShare * 2);
      }
    }
  });

  it('gives duplicate copies of one species different values', () => {
    // Consecutive ids are what two duplicates actually get.
    const values = [11, 12, 13, 14, 15, 16].map((id) =>
      deterministicBaseSeductivePower(id, 'N'),
    );
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it('raises rather than guessing for a rarity outside the ladder', () => {
    expect(() => deterministicBaseSeductivePower(1, 'SSS')).toThrow(/No Seductive Power range/);
  });

  it('changing the salt changes the result — the frozen salt is load-bearing', () => {
    expect(deterministicBaseSeductivePower(1, 'N', DEFAULT_SP_RANGES_BY_RARITY, 'other')).not.toBe(
      backfillHash(1) % 11, // sanity: the salted hash is not the raw id
    );
    const withShippedSalt = deterministicBaseSeductivePower(1, 'N');
    const withOtherSalt = deterministicBaseSeductivePower(
      1,
      'N',
      DEFAULT_SP_RANGES_BY_RARITY,
      'waifumon.sp.backfill.v2',
    );
    expect(withShippedSalt).not.toBe(withOtherSalt);
  });

  it('re-running the backfill statement is a no-op on already-filled rows', async () => {
    const speciesRow = await speciesOfRarity('SR');
    const waifu = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: speciesRow.id,
      baseSp: 121,
    });

    // The migration's UPDATE is guarded by `base_sp IS NULL`, so replaying it
    // cannot touch a row that already has a value.
    await t.db.execute(sql`
      UPDATE player_waifus AS w
      SET base_sp = 999
      FROM species AS s
      WHERE w.species_id = s.id AND w.base_sp IS NULL
    `);
    const [after] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, waifu.id));
    expect(after!.baseSp).toBe(121);
  });

  it('the migration already filled every row this database has', async () => {
    // Fresh test databases run the real migration chain, so this asserts the
    // post-migration invariant rather than a hypothetical.
    const result = await t.db.execute(
      sql`select count(*)::int as n from player_waifus where base_sp is null`,
    );
    expect(Number((result.rows as Array<{ n: number }>)[0]!.n)).toBe(0);
  });
});

// ─────────────────────── derived Current SP over real rows ───────────────

describe('Current SP over persisted rows', () => {
  it('is derived from the stored base and the live level, never stored', async () => {
    const columns = await t.db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'player_waifus'
    `);
    const names = (columns.rows as Array<{ column_name: string }>).map((r) => r.column_name);
    expect(names).toContain('base_sp');
    // Current SP is a pure function of two stored values; a third column would
    // only be something that can drift from them.
    expect(names).not.toContain('current_sp');
  });

  it('tracks level changes without the base moving', async () => {
    const speciesRow = await speciesOfRarity('SR');
    const waifu = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: speciesRow.id,
      baseSp: 120,
      level: 1,
    });
    expect(currentSeductivePower(waifu.baseSp, 1)).toBe(120);

    await t.db.update(playerWaifus).set({ level: 50 }).where(eq(playerWaifus.id, waifu.id));
    const [after] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, waifu.id));
    expect(after!.baseSp).toBe(120);
    expect(currentSeductivePower(after!.baseSp, after!.level)).toBe(267);
  });
});
