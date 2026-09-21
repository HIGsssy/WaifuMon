/**
 * Expeditions Phase 1 — the item foundation against a real database.
 *
 * The unit tests cover what the *content schema* refuses. This covers what the
 * *database* refuses, which is the backstop for everything that does not go
 * through the loader: the admin panel, a manual fix in psql, and any future
 * service that writes an item row directly.
 *
 * It also pins the migration's compatibility promise — every pre-existing item
 * comes out the other side unsellable — because that is the claim that is only
 * true once, on the deploy, and can never be re-checked afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { items } from '../../src/db/schema';
import { bootstrapApp, getItemBySlug, loadShippedContent, provisionPlayer, type App } from '../helpers/fixtures';
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

/** Insert a bare item row, bypassing the content loader entirely. */
async function insertItem(overrides: Record<string, unknown> = {}) {
  const [row] = await t.db
    .insert(items)
    .values({
      slug: `raw_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Raw Item',
      category: 'salvage',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

describe('items_category_check', () => {
  it.each(['salvage', 'key', 'equipment'])('admits the new category %s', async (category) => {
    const row = await insertItem({ category });
    expect(row.category).toBe(category);
  });

  it.each(['capture', 'material', 'cosmetic', 'consumable'])(
    'still admits the original category %s',
    async (category) => {
      const row = await insertItem({ category });
      expect(row.category).toBe(category);
    },
  );

  it('rejects a category outside the widened set', async () => {
    await expect(insertItem({ category: 'treasure' })).rejects.toThrow(/items_category_check/);
  });
});

describe('items_sell_value_check', () => {
  it('stores a positive sell value', async () => {
    const row = await insertItem({ sellValue: 45 });
    expect(row.sellValue).toBe(45);
  });

  it('defaults to null — nothing is sellable unless it says so', async () => {
    const row = await insertItem();
    expect(row.sellValue).toBeNull();
  });

  // The constraint exists so that `sell_value IS NOT NULL` is the *whole*
  // eligibility rule everywhere. A stored 0 would silently break that promise
  // for every consumer that trusts it.
  it('rejects a zero sell value, leaving null the only way to say "not sellable"', async () => {
    await expect(insertItem({ sellValue: 0 })).rejects.toThrow(/items_sell_value_check/);
  });

  it('rejects a negative sell value', async () => {
    await expect(insertItem({ sellValue: -5 })).rejects.toThrow(/items_sell_value_check/);
  });
});

describe('migration compatibility', () => {
  /**
   * The seeded catalog is the pre-expeditions content set: nothing in it has
   * been given a sell value yet. If this ever fails it means content started
   * pricing items, which is a Phase 5 change that should update this test
   * deliberately rather than discover it.
   */
  it('leaves every seeded item unsellable', async () => {
    // Scoped to slugs the seeder owns, so the raw rows the constraint tests
    // above insert cannot make this pass or fail for the wrong reason.
    const shippedSlugs = loadShippedContent(t.logger).items.map((i) => i.slug);
    const sellable = await t.db
      .select({ slug: items.slug, sellValue: items.sellValue })
      .from(items)
      .where(and(inArray(items.slug, shippedSlugs), isNotNull(items.sellValue)));
    expect(sellable).toEqual([]);
  });

  it('round-trips a sell value through the content seeder', async () => {
    const charm = await getItemBySlug(t.db, 'basic_charm');
    // Write through the same column the seeder's mutable block now carries,
    // then confirm a re-seed of the shipped content resets it — the seeder is
    // authoritative over `sell_value`, exactly as it is over `buy_price`.
    await t.db.update(items).set({ sellValue: 999 }).where(eq(items.id, charm.id));
    expect((await getItemBySlug(t.db, 'basic_charm')).sellValue).toBe(999);

    await bootstrapApp(t);
    expect((await getItemBySlug(t.db, 'basic_charm')).sellValue).toBeNull();
  });
});

describe('inventory carries the new categories', () => {
  it('holds a salvage item like any other', async () => {
    const salvage = await insertItem({
      slug: 'test_sunbleached_scrap',
      name: 'Sunbleached Scrap',
      category: 'salvage',
      sellValue: 30,
    });
    const { playerId } = await provisionPlayer(app, 'g-items', 'u-salvage');

    await app.inventory.addItem(t.db, playerId, salvage.id, 3);
    const entries = await app.inventory.getInventory(playerId);
    const entry = entries.find((e) => e.item.slug === 'test_sunbleached_scrap');
    expect(entry?.quantity).toBe(3);
    expect(entry?.item.sellValue).toBe(30);
  });
});
