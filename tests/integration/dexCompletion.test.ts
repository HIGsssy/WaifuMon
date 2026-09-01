/**
 * Dex completion — what the profile's `x / y unique species` actually counts.
 *
 * The denominator is the interesting half. It is read live from the `species`
 * table rather than snapshotted at boot, so this file re-seeds a series of
 * deliberately different content sets into one database and asserts the number
 * moves with them: base only, base plus a pack, the pack switched off again.
 * Re-seeding is exactly what an admin "Reload Content" does, which is the
 * operation the old frozen count could not see.
 */
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { regionEncounterPools, species } from '../../src/db/schema';
import { seedContent } from '../../src/modules/content/seeder';
import type { LoadedContent, RegionContent } from '../../src/modules/content/schemas';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;

/** Slugs the shipped core files author, as opposed to any expansion pack. */
let baseSlugs: string[];
/** Slugs the Flaccid Foothills pack authors. */
let foothillsSlugs: string[];

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-dex', 'u-dex'));
  baseSlugs = app.content.species
    .filter((s) => app.content.speciesOrigin[s.slug] === undefined && s.enabled)
    .map((s) => s.slug);
  foothillsSlugs = app.content.species
    .filter((s) => app.content.speciesOrigin[s.slug] === 'flaccid_foothills' && s.enabled)
    .map((s) => s.slug);
  expect(baseSlugs.length).toBeGreaterThan(0);
  expect(foothillsSlugs.length).toBeGreaterThan(0);
});

afterAll(async () => {
  await t.cleanup();
});

/** Put the shipped content back, so no case can be carried by the last one. */
afterEach(async () => {
  await seedContent(t.db, app.content, t.logger);
});

/** A content set narrowed to the given slugs, regions pruned to match. */
function contentWith(slugs: readonly string[]): LoadedContent {
  const keep = new Set(slugs);
  const regions: RegionContent[] = app.content.regions.map((r) => ({
    ...r,
    encounterPool: r.encounterPool.filter((e) => keep.has(e.species)),
    // An enabled region must keep at least one entry; one that loses its whole
    // pool is switched off for the purposes of this fixture.
    enabled: r.enabled && r.encounterPool.some((e) => keep.has(e.species)),
  }));
  return { ...app.content, species: app.content.species.filter((s) => keep.has(s.slug)), regions };
}

const denominator = async (): Promise<number> =>
  (await app.collection.getDexStats(playerId)).totalSpecies;

describe('the denominator', () => {
  it('counts the base species when only base content is loaded', async () => {
    await seedContent(t.db, contentWith(baseSlugs), t.logger);
    expect(await denominator()).toBe(baseSlugs.length);
    // The number the bug reported forever: whatever the base set happens to be
    // today, and nothing beyond it.
    expect(baseSlugs.length).toBeGreaterThanOrEqual(75);
  });

  it('grows when an expansion is enabled', async () => {
    await seedContent(t.db, contentWith(baseSlugs), t.logger);
    const before = await denominator();

    // Exactly what enabling a pack and reloading content does.
    await seedContent(t.db, contentWith([...baseSlugs, ...foothillsSlugs]), t.logger);
    expect(await denominator()).toBe(before + foothillsSlugs.length);
  });

  it('does not count a pack that is switched off again', async () => {
    await seedContent(t.db, contentWith([...baseSlugs, ...foothillsSlugs]), t.logger);
    const withPack = await denominator();

    // A disabled pack drops out of the content set; the seeder then disables
    // the rows whose slugs vanished rather than deleting them, because owned
    // copies still point at them. Disabled rows are not collectable, so they
    // are not part of the target.
    await seedContent(t.db, contentWith(baseSlugs), t.logger);
    expect(await denominator()).toBe(withPack - foothillsSlugs.length);

    const rows = await t.db
      .select({ slug: species.slug, enabled: species.enabled })
      .from(species)
      .where(inArray(species.slug, foothillsSlugs));
    expect(rows).toHaveLength(foothillsSlugs.length);
    expect(rows.every((r) => r.enabled === false)).toBe(true);
  });

  it('excludes a species the content set disables outright', async () => {
    const [victim, ...rest] = baseSlugs;
    const disabled = contentWith(baseSlugs);
    const patched: LoadedContent = {
      ...disabled,
      species: disabled.species.map((s) => (s.slug === victim ? { ...s, enabled: false } : s)),
    };
    await seedContent(t.db, patched, t.logger);
    expect(await denominator()).toBe(rest.length);
  });

  it('counts a species pooled in several regions exactly once', async () => {
    // The failure mode this rules out: counting `region_encounter_pools` rows
    // instead of species would make a shared Waifumon worth one point of dex
    // completion per region she can be met in.
    const shared = app.content.regions
      .flatMap((r) => r.encounterPool.map((e) => e.species))
      .find((slug, _i, all) => all.filter((s) => s === slug).length > 1);
    expect(shared).toBeDefined();

    const [row] = await t.db
      .select({ id: species.id })
      .from(species)
      .where(eq(species.slug, shared!));
    const pooled = await t.db
      .select({ regionId: regionEncounterPools.regionId })
      .from(regionEncounterPools)
      .where(eq(regionEncounterPools.speciesId, row!.id));
    expect(pooled.length).toBeGreaterThan(1);

    // …and the denominator is still one per species, not one per pool row.
    const enabled = app.content.species.filter((s) => s.enabled).length;
    expect(await denominator()).toBe(enabled);
  });
});

describe('the numerator', () => {
  it('counts a species once however many copies are held', async () => {
    const idOf = async (slug: string): Promise<number> => {
      const [row] = await t.db.select({ id: species.id }).from(species).where(eq(species.slug, slug));
      return row!.id;
    };
    const firstId = await idOf(baseSlugs[0]!);
    const secondId = await idOf(baseSlugs[1]!);

    const { playerId: solo } = await provisionPlayer(app, 'g-dex', 'u-dex-numerator');
    for (let i = 0; i < 3; i++) {
      await insertOwnedWaifu(t.db, { playerId: solo, speciesId: firstId });
    }
    await insertOwnedWaifu(t.db, { playerId: solo, speciesId: secondId });

    const stats = await app.collection.getDexStats(solo);
    expect(stats.owned).toBe(4);
    expect(stats.distinctSpecies).toBe(2);
    expect(stats.totalSpecies).toBeGreaterThan(stats.distinctSpecies);
  });
});
