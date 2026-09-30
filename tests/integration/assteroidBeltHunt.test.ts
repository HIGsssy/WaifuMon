/**
 * Assteroid Belt hunts, against the shipped content — a guard for the staging
 * report that every Belt hunt returned an item and never a Waifumon.
 *
 * The outcome kind is rolled from `tables.hunt.resultTable` before any region
 * lookup, so a region can never turn an encounter into an item; what a region
 * *can* get wrong is its pool. These assert both halves: the Belt meets
 * Waifumon at the same rate as Waifu Valley under the same RNG, and every Belt
 * encounter is served from the Belt's own pool without touching a fallback.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encounters, playerCurrencies, players, regionEncounterPools, species } from '../../src/db/schema';
import { createHuntService, type HuntResult } from '../../src/modules/hunt/huntService';
import type { Region } from '../../src/modules/locations/regions';
import { seededRng } from '../../src/shared/random';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
const HUNTS = 200;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-belt-hunt', 'u-belt-hunt'));
});
afterAll(async () => {
  await t.cleanup();
});

async function huntMany(region: Region, warnings: string[]): Promise<HuntResult[]> {
  const logger = {
    ...t.logger,
    warn: (...args: unknown[]) => warnings.push(JSON.stringify(args)),
    error: (...args: unknown[]) => warnings.push(JSON.stringify(args)),
  } as unknown as TestDb['logger'];
  const hunt = createHuntService({
    db: t.db,
    currency: app.currency,
    inventory: app.inventory,
    progression: app.progression,
    collection: app.collection,
    care: app.care,
    quests: app.quests,
    tables: app.content.tables,
    logger,
    rng: seededRng(99),
  });
  await t.db.update(players).set({ currentRegion: region, level: 40 }).where(eq(players.id, playerId));
  const results: HuntResult[] = [];
  for (let i = 0; i < HUNTS; i++) {
    await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
    await t.db
      .update(playerCurrencies)
      .set({ huntEnergy: 50 })
      .where(eq(playerCurrencies.playerId, playerId));
    results.push(await hunt.hunt(playerId, 'chan-belt-hunt'));
  }
  return results;
}

const kinds = (rs: HuntResult[]) => rs.map((r) => r.kind);

describe('Assteroid Belt hunts (shipped content)', () => {
  it('meets Waifumon at the same rate as Waifu Valley under the same RNG', async () => {
    const valley = await huntMany('waifu-valley', []);
    const belt = await huntMany('assteroid-belt', []);
    expect(kinds(belt)).toEqual(kinds(valley));
    const encounterShare = kinds(belt).filter((k) => k === 'encounter').length / HUNTS;
    expect(encounterShare).toBeGreaterThan(0.5);
  });

  it('serves every Belt encounter from the Belt pool, with no fallback', async () => {
    const warnings: string[] = [];
    const results = await huntMany('assteroid-belt', warnings);
    const pool = await t.db
      .select({ slug: species.slug })
      .from(regionEncounterPools)
      .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
      .where(eq(regionEncounterPools.regionId, 'assteroid-belt'));
    const poolSlugs = new Set(pool.map((p) => p.slug));
    expect(poolSlugs.size).toBeGreaterThan(0);

    const met = results.flatMap((r) => (r.kind === 'encounter' ? [r.species.slug] : []));
    expect(met.length).toBeGreaterThan(0);
    expect(met.filter((slug) => !poolSlugs.has(slug))).toEqual([]);
    expect(met).not.toContain('feral_android');
    expect(met).not.toContain('cyber_neko');
    expect(warnings).toEqual([]);
  });

  it('rolls rarity through the normal hunt table — the pool changes who, never how rare', async () => {
    // Same RNG, same level: the rarity roll happens before any pool lookup, so
    // the Belt must draw the identical rarity sequence Waifu Valley does. Only
    // the species inside each rarity differ.
    const rarities = (rs: HuntResult[]) =>
      rs.flatMap((r) => (r.kind === 'encounter' ? [r.species.rarity] : []));
    const valley = await huntMany('waifu-valley', []);
    const belt = await huntMany('assteroid-belt', []);
    expect(rarities(belt)).toEqual(rarities(valley));
    expect(new Set(rarities(belt)).size).toBeGreaterThan(2);
  });

  it('seeds the curated crossovers into the Belt and keeps them in their home pools', async () => {
    const pools = await t.db
      .select({ regionId: regionEncounterPools.regionId, slug: species.slug })
      .from(regionEncounterPools)
      .innerJoin(species, eq(regionEncounterPools.speciesId, species.id));
    const regionsOf = (slug: string) => pools.filter((p) => p.slug === slug).map((p) => p.regionId);
    for (const slug of ['prototype_zero', 'void_empress', 'android_secretary', 'witchy_mechanic']) {
      expect(regionsOf(slug), slug).toContain('assteroid-belt');
      expect(regionsOf(slug), slug).toContain('waifu-valley');
    }
    for (const slug of ['feral_android', 'cyber_neko']) {
      expect(regionsOf(slug), slug).not.toContain('assteroid-belt');
      expect(regionsOf(slug).length, slug).toBeGreaterThan(0);
    }
    const belt = pools.filter((p) => p.regionId === 'assteroid-belt');
    expect(belt).toHaveLength(30);
  });
});
