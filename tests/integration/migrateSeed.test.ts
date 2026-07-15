import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { items, species } from '../../src/db/schema';
import { seedContent } from '../../src/modules/content/seeder';
import { loadShippedContent } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb(); // migrations from zero to head run inside
});
afterAll(async () => {
  await t.cleanup();
});

describe('migrations + seeder', () => {
  it('migrates a fresh database and seeds shipped content', async () => {
    const content = loadShippedContent(t.logger);
    const summary = await seedContent(t.db, content, t.logger);
    expect(summary.items).toBe(5);
    expect(summary.species).toBe(content.species.length);

    const itemRows = await t.db.select().from(items);
    expect(itemRows).toHaveLength(5);
    const mythic = itemRows.find((i) => i.slug === 'mythic_contract');
    expect(mythic?.isGuaranteedCapture).toBe(true);
    expect(mythic?.purchasable).toBe(false);
    const prismatic = itemRows.find((i) => i.slug === 'prismatic_charm');
    expect(prismatic?.enabled).toBe(true);
    expect(prismatic?.purchasable).toBe(false);
  });

  it('is idempotent — running twice yields the same state', async () => {
    const content = loadShippedContent(t.logger);
    await seedContent(t.db, content, t.logger);
    const before = await t.db.select().from(items).orderBy(items.slug);
    await seedContent(t.db, content, t.logger);
    const after = await t.db.select().from(items).orderBy(items.slug);
    expect(after).toEqual(before);
    expect(after).toHaveLength(5);
  });

  it('updates mutable fields on existing slugs', async () => {
    const content = loadShippedContent(t.logger);
    const modified = {
      ...content,
      items: content.items.map((i) =>
        i.slug === 'silk_charm' ? { ...i, buyPrice: 80, name: 'Silk Charm II' } : i,
      ),
    };
    await seedContent(t.db, modified, t.logger);
    const [silk] = await t.db.select().from(items).where(eq(items.slug, 'silk_charm'));
    expect(silk?.buyPrice).toBe(80);
    expect(silk?.name).toBe('Silk Charm II');
    // restore
    await seedContent(t.db, content, t.logger);
  });

  it('disables DB slugs missing from JSON instead of deleting them', async () => {
    const content = loadShippedContent(t.logger);
    await seedContent(t.db, content, t.logger);
    const withoutKitsune = {
      ...content,
      species: content.species.filter((s) => s.slug !== 'neon_kitsune'),
    };
    await seedContent(t.db, withoutKitsune, t.logger);
    const [kitsune] = await t.db.select().from(species).where(eq(species.slug, 'neon_kitsune'));
    expect(kitsune).toBeDefined();
    expect(kitsune?.enabled).toBe(false);
    // restoring the content re-enables it
    await seedContent(t.db, content, t.logger);
    const [restored] = await t.db.select().from(species).where(eq(species.slug, 'neon_kitsune'));
    expect(restored?.enabled).toBe(true);
  });
});
