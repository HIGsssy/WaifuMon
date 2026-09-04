/**
 * CollectionService integration — real Postgres.
 * Covers pagination + rarity sort, dex stats, inspect ownership, duplicate
 * conversion + Essence grant, release (favorite guard, force override), and
 * favorite toggle.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  encounters,
  items,
  playerWaifus,
  species,
  type PlayerWaifuRow,
  type SpeciesRow,
} from '../../src/db/schema';
import {
  NotADuplicateError,
  WaifuAlreadyReleasedError,
  WaifuIsFavoriteError,
  WaifuNotOwnedError,
} from '../../src/shared/errors';
import {
  bootstrapApp,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
});
afterAll(async () => {
  await t.cleanup();
});

async function grantWaifus(
  playerId: number,
  entries: Array<{ slug: string; count?: number; isFavorite?: boolean }>,
): Promise<PlayerWaifuRow[]> {
  const speciesRows = await t.db.select().from(species);
  const bySlug = new Map(speciesRows.map((s) => [s.slug, s]));
  const created: PlayerWaifuRow[] = [];
  for (const e of entries) {
    const sp = bySlug.get(e.slug);
    if (!sp) throw new Error(`missing species ${e.slug}`);
    const count = e.count ?? 1;
    for (let i = 0; i < count; i++) {
      const row = await insertOwnedWaifu(t.db, {
        playerId,
        speciesId: sp.id,
        ...(e.isFavorite ? { isFavorite: true } : {}),
      });
      created.push(row!);
    }
  }
  return created;
}

async function cleanPlayer(playerId: number): Promise<void> {
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
}

describe('CollectionService — listing & dex', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-collection-list', 'u-1'));
  });
  beforeEach(async () => {
    await cleanPlayer(playerId);
  });

  it('lists owned waifus sorted rarity-desc then name, filtering released copies', async () => {
    await grantWaifus(playerId, [
      { slug: 'neko_barista' }, // N
      { slug: 'gym_oni' }, // N
      { slug: 'library_ghost' }, // N
      { slug: 'arcade_succubus' }, // R
      { slug: 'neon_kitsune' }, // SR
      { slug: 'eclipse_valkyrie' }, // SSR
      { slug: 'void_empress' }, // UR
    ]);

    const page = await app.collection.listOwned(playerId, { page: 1, pageSize: 25 });
    expect(page.totalOwned).toBe(7);
    // First entry must be the highest rarity (UR > SSR > SR > R > N).
    expect(page.entries[0]!.species.rarity).toBe('UR');
    expect(page.entries[1]!.species.rarity).toBe('SSR');
    expect(page.entries[2]!.species.rarity).toBe('SR');
    expect(page.entries[3]!.species.rarity).toBe('R');
    // Within N (last three), alphabetical by species name.
    const rarityNames = page.entries.slice(4).map((e) => e.species.name);
    expect(rarityNames).toEqual([...rarityNames].sort());
  });

  it('paginates and clamps out-of-range pages', async () => {
    await grantWaifus(playerId, [
      { slug: 'neko_barista', count: 3 },
      { slug: 'gym_oni', count: 3 },
    ]);
    const page1 = await app.collection.listOwned(playerId, { page: 1, pageSize: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.page).toBe(1);
    expect(page1.totalPages).toBe(3);
    const page2 = await app.collection.listOwned(playerId, { page: 2, pageSize: 2 });
    expect(page2.entries).toHaveLength(2);
    const way = await app.collection.listOwned(playerId, { page: 99, pageSize: 2 });
    expect(way.page).toBe(3);
    expect(way.entries).toHaveLength(2);
  });

  /**
   * The two orders must *disagree* for this to test anything, so the fixture is
   * built to make them disagree: the rarest copy is the oldest. Under the browse
   * order she leads; under `newest` she comes last.
   */
  it('orders newest-first by caughtAt without disturbing the browse order', async () => {
    const speciesRows = await t.db.select().from(species);
    const bySlug = new Map(speciesRows.map((sp) => [sp.slug, sp]));

    const oldestRarest = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: bySlug.get('void_empress')!.id, // UR
      caughtAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newestCommonest = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: bySlug.get('neko_barista')!.id, // N
      caughtAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    const newest = await app.collection.listOwned(playerId, { sort: 'newest', pageSize: 25 });
    expect(newest.entries.map((e) => e.waifu.id)).toEqual([
      newestCommonest.id,
      oldestRarest.id,
    ]);

    // Omitting `sort` is byte-for-byte what it always was - rarest first.
    const browse = await app.collection.listOwned(playerId, { pageSize: 25 });
    expect(browse.entries.map((e) => e.waifu.id)).toEqual([oldestRarest.id, newestCommonest.id]);
  });

  /**
   * The point of the sort: a caller wanting the five most recent reads one
   * short page, not every page. The ordering has to happen in SQL, before the
   * limit - sorting a page after the fact would return the newest *of the
   * rarest*, which is a different and wrong answer.
   */
  it('applies the newest ordering before the limit, not after', async () => {
    const speciesRows = await t.db.select().from(species);
    const commonId = speciesRows.find((sp) => sp.slug === 'neko_barista')!.id;
    const rareId = speciesRows.find((sp) => sp.slug === 'void_empress')!.id;

    // The rare copy is the oldest of six; a page of three must exclude her.
    await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: rareId,
      caughtAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    for (let day = 1; day <= 5; day++) {
      await insertOwnedWaifu(t.db, {
        playerId,
        speciesId: commonId,
        caughtAt: new Date(`2026-08-0${day}T00:00:00.000Z`),
      });
    }

    const page = await app.collection.listOwned(playerId, { sort: 'newest', pageSize: 3 });
    expect(page.entries).toHaveLength(3);
    expect(page.totalOwned).toBe(6);
    expect(page.entries.map((e) => e.species.rarity)).toEqual(['N', 'N', 'N']);

    const caughtAt = page.entries.map((e) => e.waifu.caughtAt.getTime());
    expect(caughtAt).toEqual([...caughtAt].sort((a, b) => b - a));
  });

  it('dex stats count distinct species (duplicates don\'t inflate)', async () => {
    await grantWaifus(playerId, [
      { slug: 'neko_barista', count: 3 },
      { slug: 'gym_oni', count: 1 },
    ]);
    const stats = await app.collection.getDexStats(playerId);
    expect(stats.owned).toBe(4);
    expect(stats.distinctSpecies).toBe(2);
    expect(stats.totalSpecies).toBeGreaterThan(0);
  });

  it('lists exclude released copies', async () => {
    const [row] = await grantWaifus(playerId, [{ slug: 'neko_barista' }]);
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, row!.id));
    const stats = await app.collection.getDexStats(playerId);
    expect(stats.owned).toBe(0);
    const page = await app.collection.listOwned(playerId);
    expect(page.entries).toHaveLength(0);
  });

  it('searchByName matches on species name substring', async () => {
    await grantWaifus(playerId, [
      { slug: 'neon_kitsune' },
      { slug: 'gym_oni' },
    ]);
    const matches = await app.collection.searchByName(playerId, 'neon');
    expect(matches.map((m) => m.species.slug)).toContain('neon_kitsune');
    const empty = await app.collection.searchByName(playerId, 'zzz_no_match');
    expect(empty).toHaveLength(0);
  });
});

describe('CollectionService — inspect, favorite, convert, release', () => {
  let playerId: number;
  let otherId: number;
  let hunterSlug: SpeciesRow;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-collection-actions', 'u-1'));
    ({ playerId: otherId } = await provisionPlayer(app, 'g-collection-actions', 'u-2'));
    const [row] = await t.db.select().from(species).where(eq(species.slug, 'neko_barista'));
    hunterSlug = row!;
  });
  beforeEach(async () => {
    await cleanPlayer(playerId);
    await cleanPlayer(otherId);
    // Reset essence to zero between tests.
    const bal = await app.currency.getBalances(playerId);
    if (bal.essence > 0) {
      await t.db.execute(
        sql`update player_currencies set essence = 0 where player_id = ${playerId}`,
      );
    }
  });

  it('getOwned returns the entry and rejects on non-ownership', async () => {
    const [mine] = await grantWaifus(playerId, [{ slug: 'neko_barista' }]);
    const entry = await app.collection.getOwned(playerId, mine!.id);
    expect(entry.species.slug).toBe('neko_barista');
    await expect(app.collection.getOwned(otherId, mine!.id)).rejects.toBeInstanceOf(
      WaifuNotOwnedError,
    );
  });

  it('toggleFavorite flips the flag', async () => {
    const [mine] = await grantWaifus(playerId, [{ slug: 'neko_barista' }]);
    const after1 = await app.collection.toggleFavorite(playerId, mine!.id);
    expect(after1.isFavorite).toBe(true);
    const after2 = await app.collection.toggleFavorite(playerId, mine!.id);
    expect(after2.isFavorite).toBe(false);
  });

  it('convertDuplicateToEssence grants the full essence value and soft-releases one copy', async () => {
    // Two copies of the same species → converting the second is allowed
    // because the first still exists (it is a real duplicate).
    const [keep, dupCopy] = await grantWaifus(playerId, [
      { slug: 'neko_barista' },
      { slug: 'neko_barista' },
    ]);
    const before = await app.currency.getBalances(playerId);
    const result = await app.collection.convertDuplicateToEssence(playerId, dupCopy!.id);
    expect(result.essenceGranted).toBe(app.content.tables.duplicate.essenceByRarity.N);
    expect(result.balanceAfter).toBe(before.essence + result.essenceGranted);
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, dupCopy!.id));
    expect(row?.releasedAt).not.toBeNull();
    // The other copy is untouched.
    const [remaining] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, keep!.id));
    expect(remaining?.releasedAt).toBeNull();
    // Second conversion is rejected.
    await expect(
      app.collection.convertDuplicateToEssence(playerId, dupCopy!.id),
    ).rejects.toBeInstanceOf(WaifuAlreadyReleasedError);
  });

  it('convertDuplicateToEssence rejects a unique copy (NotADuplicateError) with no essence granted', async () => {
    const [only] = await grantWaifus(playerId, [{ slug: 'neko_barista' }]);
    const before = await app.currency.getBalances(playerId);
    await expect(
      app.collection.convertDuplicateToEssence(playerId, only!.id),
    ).rejects.toBeInstanceOf(NotADuplicateError);
    // Nothing changed.
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, only!.id));
    expect(row?.releasedAt).toBeNull();
    const after = await app.currency.getBalances(playerId);
    expect(after.essence).toBe(before.essence);
  });

  it('convertDuplicate refuses a favorite without force, allows with force', async () => {
    const [orig, fav] = await grantWaifus(playerId, [
      { slug: 'neko_barista' },
      { slug: 'neko_barista', isFavorite: true },
    ]);
    await expect(
      app.collection.convertDuplicateToEssence(playerId, fav!.id),
    ).rejects.toBeInstanceOf(WaifuIsFavoriteError);
    // Force override succeeds.
    const result = await app.collection.convertDuplicateToEssence(playerId, fav!.id, {
      force: true,
    });
    expect(result.essenceGranted).toBe(app.content.tables.duplicate.essenceByRarity.N);
    // The non-favorite original stays intact.
    const [orig2] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, orig!.id));
    expect(orig2?.releasedAt).toBeNull();
  });

  it('hasOtherActiveCopies is true for duplicates, false for uniques, and ignores released', async () => {
    const [a, b] = await grantWaifus(playerId, [
      { slug: 'neko_barista' },
      { slug: 'neko_barista' },
    ]);
    expect(await app.collection.hasOtherActiveCopies(playerId, a!.id)).toBe(true);
    expect(await app.collection.hasOtherActiveCopies(playerId, b!.id)).toBe(true);
    // Soft-release one — the other is now unique.
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, b!.id));
    expect(await app.collection.hasOtherActiveCopies(playerId, a!.id)).toBe(false);
  });

  it('convertDuplicate rejects on non-ownership without granting essence', async () => {
    const [theirs] = await grantWaifus(otherId, [
      { slug: 'neko_barista' },
      { slug: 'neko_barista' },
    ]);
    const before = await app.currency.getBalances(playerId);
    await expect(
      app.collection.convertDuplicateToEssence(playerId, theirs!.id),
    ).rejects.toBeInstanceOf(WaifuNotOwnedError);
    const after = await app.currency.getBalances(playerId);
    expect(after.essence).toBe(before.essence);
  });

  it('release grants partial essence (releaseFraction × dup value)', async () => {
    const [mine] = await grantWaifus(playerId, [{ slug: 'eclipse_valkyrie' }]); // SSR
    const before = await app.currency.getBalances(playerId);
    const result = await app.collection.releaseWaifu(playerId, mine!.id);
    const expected = Math.floor(
      app.content.tables.duplicate.essenceByRarity.SSR *
        app.content.tables.duplicate.releaseFraction,
    );
    expect(result.essenceGranted).toBe(expected);
    expect(result.balanceAfter).toBe(before.essence + expected);
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, mine!.id));
    expect(row?.releasedAt).not.toBeNull();
  });

  it('release rejects favorites without force, allows with force', async () => {
    const [mine] = await grantWaifus(playerId, [
      { slug: 'neko_barista', isFavorite: true },
    ]);
    await expect(app.collection.releaseWaifu(playerId, mine!.id)).rejects.toBeInstanceOf(
      WaifuIsFavoriteError,
    );
    // Nothing was released.
    const [before] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, mine!.id));
    expect(before?.releasedAt).toBeNull();
    // Force release succeeds.
    const result = await app.collection.releaseWaifu(playerId, mine!.id, { force: true });
    expect(result.essenceGranted).toBeGreaterThan(0);
  });

  it('cannot release someone else\'s waifu', async () => {
    const [theirs] = await grantWaifus(otherId, [{ slug: 'neko_barista' }]);
    await expect(app.collection.releaseWaifu(playerId, theirs!.id)).rejects.toBeInstanceOf(
      WaifuNotOwnedError,
    );
  });

  it('cannot release the same waifu twice', async () => {
    const [mine] = await grantWaifus(playerId, [{ slug: 'neko_barista' }]);
    await app.collection.releaseWaifu(playerId, mine!.id);
    await expect(app.collection.releaseWaifu(playerId, mine!.id)).rejects.toBeInstanceOf(
      WaifuAlreadyReleasedError,
    );
  });

  it('duplicate detection integrates end-to-end with the capture flow', async () => {
    // Grant mythic contracts and script two captures of the same species.
    const mythic = await t.db
      .select()
      .from(items)
      .where(eq(items.slug, 'mythic_contract'));
    await app.inventory.addItem(t.db, playerId, mythic[0]!.id, 2);

    // Create two encounters (bypass the hunt path — the capture service is
    // what we care about here).
    const [first] = await t.db
      .insert(encounters)
      .values({
        playerId,
        speciesId: hunterSlug.id,
        channelId: 'c-1',
        state: 'active',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const r1 = await app.capture.attemptCapture(playerId, first!.id, 'mythic_contract');
    expect(r1.outcome).toBe('success');
    expect(r1.isDuplicate).toBe(false);
    const [second] = await t.db
      .insert(encounters)
      .values({
        playerId,
        speciesId: hunterSlug.id,
        channelId: 'c-1',
        state: 'active',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const r2 = await app.capture.attemptCapture(playerId, second!.id, 'mythic_contract');
    expect(r2.outcome).toBe('success');
    expect(r2.isDuplicate).toBe(true);

    // Now convert the duplicate → essence.
    const before = await app.currency.getBalances(playerId);
    const conv = await app.collection.convertDuplicateToEssence(playerId, r2.newWaifu!.id);
    expect(conv.essenceGranted).toBe(app.content.tables.duplicate.essenceByRarity.N);
    expect(conv.balanceAfter).toBe(before.essence + conv.essenceGranted);
    // Original owned copy is still there.
    const [orig] = await t.db
      .select()
      .from(playerWaifus)
      .where(and(eq(playerWaifus.id, r1.newWaifu!.id)));
    expect(orig?.releasedAt).toBeNull();
    // Duplicate row is soft-released.
    const [dupRow] = await t.db
      .select()
      .from(playerWaifus)
      .where(and(eq(playerWaifus.id, r2.newWaifu!.id)));
    expect(dupRow?.releasedAt).not.toBeNull();
  });
});
