/**
 * Regional encounters — the one place a region changes gameplay, and the
 * regression that proves it is the *only* place.
 *
 * The pools are built by hand rather than taken from shipped content, because
 * the properties under test ("she is unreachable from over there", "she is
 * three times as likely here") need a corpus small enough to reason about
 * exactly. Shipped content is asserted separately, in `regionContent.test.ts`.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  captureAttempts,
  encounters,
  playerCurrencies,
  players,
  regionEncounterPools,
  species,
} from '../../src/db/schema';
import { createHuntService } from '../../src/modules/hunt/huntService';
import type { HuntService } from '../../src/modules/hunt/huntService';
import {
  bootstrapApp,
  forceRegion,
  provisionPlayer,
  scriptedRng,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
const CHANNEL_ID = 'chan-region';

/** Slugs minted for this file, so nothing here depends on shipped content. */
const VALLEY_ONLY = 'test_valley_only';
const PEAKS_ONLY = 'test_peaks_only';
const SHARED = 'test_shared';

let valleyOnlyId: number;
let peaksOnlyId: number;
let sharedId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);

  // Three N-rarity species and two hand-built pools:
  //   Waifu Valley → valley-only (w1) + shared (w1)
  //   Twin Peeks   → peaks-only  (w1) + shared (w9)
  // The shared species carries a very different weight in each region, which
  // is the property a `species.region` scalar column could not have expressed.
  const inserted = await t.db
    .insert(species)
    .values(
      [VALLEY_ONLY, PEAKS_ONLY, SHARED].map((slug) => ({
        slug,
        name: slug,
        rarity: 'N',
        archetype: 'human',
        contentRating: 'suggestive',
        affinity: 'switch',
        imagePath: `waifumon/${slug}/standard.png`,
        enabled: true,
        perSpeciesWeight: 1,
      })),
    )
    .returning({ id: species.id, slug: species.slug });
  const idOf = (slug: string): number => inserted.find((r) => r.slug === slug)!.id;
  valleyOnlyId = idOf(VALLEY_ONLY);
  peaksOnlyId = idOf(PEAKS_ONLY);
  sharedId = idOf(SHARED);

  // Take the seeded pools out of the way so an N roll can only land on the
  // three species above — otherwise 75 shipped valley species share the bucket.
  await t.db.delete(regionEncounterPools);
  await t.db.insert(regionEncounterPools).values([
    { regionId: 'waifu-valley', speciesId: valleyOnlyId, weight: 1 },
    { regionId: 'waifu-valley', speciesId: sharedId, weight: 1 },
    { regionId: 'twin-peeks', speciesId: peaksOnlyId, weight: 1 },
    { regionId: 'twin-peeks', speciesId: sharedId, weight: 9 },
  ]);
  // Everything else stops being drawable at all, so a stray fallback shows up
  // as a failure rather than as a plausible-looking species.
  await t.db
    .update(species)
    .set({ enabled: false })
    .where(sql`${species.id} not in (${valleyOnlyId}, ${peaksOnlyId}, ${sharedId})`);
});
afterAll(async () => {
  await t.cleanup();
});

/** A hunt service whose RNG is scripted: [resultKind, rarity, speciesPick, …]. */
function huntWith(nexts: number[]): HuntService {
  return createHuntService({
    db: t.db,
    currency: app.currency,
    inventory: app.inventory,
    progression: app.progression,
    collection: app.collection,
    care: app.care,
    quests: app.quests,
    tables: app.content.tables,
    logger: t.logger,
    rng: scriptedRng(nexts),
  });
}

async function resetPlayer(playerId: number, region: string): Promise<void> {
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: 50 })
    .where(eq(playerCurrencies.playerId, playerId));
  await forceRegion(t.db, playerId, region);
}

/**
 * Runs `count` hunts and returns the species slug of each encounter.
 *
 * The species pick is scripted per hunt with an evenly spread fraction, so the
 * result is a deterministic sample of the weighted distribution rather than a
 * statistical one — 20 draws is enough to see a 9:1 split exactly.
 */
async function sampleSpecies(playerId: number, count: number): Promise<string[]> {
  const slugs: string[] = [];
  for (let i = 0; i < count; i++) {
    await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
    // 0.0 → 'encounter', 0.0 → rarity N, then walk the species-pick fraction.
    const pick = (i + 0.5) / count;
    const result = await huntWith([0, 0, pick]).hunt(playerId, CHANNEL_ID);
    expect(result.kind).toBe('encounter');
    slugs.push((result as { species: { slug: string } }).species.slug);
  }
  return slugs;
}

describe('region gates which species can be met', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-region', 'u-region'));
  });

  it('never draws a Twin Peeks species from Waifu Valley', async () => {
    await resetPlayer(playerId, 'waifu-valley');
    const drawn = new Set(await sampleSpecies(playerId, 20));
    expect(drawn.has(PEAKS_ONLY)).toBe(false);
    expect([...drawn].every((s) => s === VALLEY_ONLY || s === SHARED)).toBe(true);
  });

  it('never draws a Waifu Valley exclusive from Twin Peeks', async () => {
    await resetPlayer(playerId, 'twin-peeks');
    const drawn = new Set(await sampleSpecies(playerId, 20));
    expect(drawn.has(VALLEY_ONLY)).toBe(false);
    expect([...drawn].every((s) => s === PEAKS_ONLY || s === SHARED)).toBe(true);
  });

  it('makes a Twin Peeks exclusive reachable only after travelling there', async () => {
    // The end-to-end shape of the feature: buy, travel, meet someone new.
    await resetPlayer(playerId, 'waifu-valley');
    expect(new Set(await sampleSpecies(playerId, 12)).has(PEAKS_ONLY)).toBe(false);

    await app.travel.grantRoute(playerId, 'twin-peeks');
    await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
    await app.travel.travel(playerId, 'twin-peeks');

    expect(new Set(await sampleSpecies(playerId, 12)).has(PEAKS_ONLY)).toBe(true);
  });

  it('weights a shared species by its region-local weight, not the species column', async () => {
    // 1:1 in the valley, 9:1 in Twin Peeks — from one `species` row whose own
    // `per_species_weight` is 1 in both cases.
    await resetPlayer(playerId, 'waifu-valley');
    const valley = await sampleSpecies(playerId, 20);
    expect(valley.filter((s) => s === SHARED)).toHaveLength(10);
    expect(valley.filter((s) => s === VALLEY_ONLY)).toHaveLength(10);

    await resetPlayer(playerId, 'twin-peeks');
    const peaks = await sampleSpecies(playerId, 20);
    expect(peaks.filter((s) => s === SHARED)).toHaveLength(18);
    expect(peaks.filter((s) => s === PEAKS_ONLY)).toHaveLength(2);
  });

  it('falls back to the global species table, by rarity, when no pool covers it', async () => {
    // The regression guard for a content set with no `content/regions/` at
    // all — a supported configuration. Without this tier the reroll loop
    // exhausts and every hunt hands back one fixed species, ignoring rarity
    // and weight entirely. With it, the hunt degrades to exactly the game it
    // was before regions existed.
    const pools = await t.db.select().from(regionEncounterPools);
    await t.db.delete(regionEncounterPools);
    try {
      await resetPlayer(playerId, 'twin-peeks');
      // 0.0 → 'encounter'; 0.0 → rarity N; 0.0 → first weighted entry.
      const result = await huntWith([0, 0, 0]).hunt(playerId, CHANNEL_ID);
      expect(result.kind).toBe('encounter');
      // Rarity is still honoured: only the three N species are enabled here.
      const picked = (result as { species: { slug: string; rarity: string } }).species;
      expect(picked.rarity).toBe('N');
      expect([VALLEY_ONLY, PEAKS_ONLY, SHARED]).toContain(picked.slug);
    } finally {
      await t.db.insert(regionEncounterPools).values(pools);
    }
  });

  it('prefers the starting region pool over the global table', async () => {
    // Ordering matters: tier 2 (Waifu Valley's curated pool) must win over
    // tier 3 (anything enabled at that rarity), or travelling would quietly
    // widen the draw instead of narrowing it.
    await resetPlayer(playerId, 'twin-peeks');
    const drawn = new Set(await sampleSpecies(playerId, 12));
    // Twin Peeks covers N itself, so neither fallback should fire at all.
    expect(drawn.has(VALLEY_ONLY)).toBe(false);
  });

  it('snapshots the hunt region onto the encounter row', async () => {
    await resetPlayer(playerId, 'twin-peeks');
    const result = await huntWith([0, 0, 0]).hunt(playerId, CHANNEL_ID);
    expect(result.kind).toBe('encounter');
    const [row] = await t.db
      .select({ regionId: encounters.regionId })
      .from(encounters)
      .where(eq(encounters.playerId, playerId));
    expect(row!.regionId).toBe('twin-peeks');
  });

  it('falls back to the starting region pool when a region has no bucket', async () => {
    // Twin Peeks has nobody at R. The draw must reach Waifu Valley's curated
    // pool rather than any enabled species in the table.
    const [rare] = await t.db
      .insert(species)
      .values({
        slug: 'test_valley_rare',
        name: 'test_valley_rare',
        rarity: 'R',
        archetype: 'human',
        contentRating: 'suggestive',
        affinity: 'switch',
        imagePath: 'waifumon/test_valley_rare/standard.png',
        enabled: true,
        perSpeciesWeight: 1,
      })
      .returning({ id: species.id });
    const [orphanRare] = await t.db
      .insert(species)
      .values({
        slug: 'test_orphan_rare',
        name: 'test_orphan_rare',
        rarity: 'R',
        archetype: 'human',
        contentRating: 'suggestive',
        affinity: 'switch',
        imagePath: 'waifumon/test_orphan_rare/standard.png',
        enabled: true,
        perSpeciesWeight: 1,
      })
      .returning({ id: species.id });
    await t.db
      .insert(regionEncounterPools)
      .values({ regionId: 'waifu-valley', speciesId: rare!.id, weight: 1 });

    try {
      await resetPlayer(playerId, 'twin-peeks');
      // 0.0 → 'encounter'; 0.7 lands squarely in the R band (0.60–0.85 of
      // the shipped rarity table, unshifted at level 1); species pick 0.0.
      const result = await huntWith([0, 0.7, 0]).hunt(playerId, CHANNEL_ID);
      expect(result.kind).toBe('encounter');
      const slug = (result as { species: { slug: string } }).species.slug;
      expect(slug).toBe('test_valley_rare');
      expect(slug).not.toBe('test_orphan_rare');
    } finally {
      await t.db.delete(regionEncounterPools).where(eq(regionEncounterPools.speciesId, rare!.id));
      await t.db
        .update(species)
        .set({ enabled: false })
        .where(inArray(species.id, [rare!.id, orphanRare!.id]));
    }
  });
});

describe('capture math is region-agnostic', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-region-capture', 'u-region-capture'));
  });
  /** Attempts hold an FK to encounters, so they go first. */
  async function clearEncounters(): Promise<void> {
    const rows = await t.db
      .select({ id: encounters.id })
      .from(encounters)
      .where(eq(encounters.playerId, playerId));
    if (rows.length > 0) {
      await t.db.delete(captureAttempts).where(
        inArray(
          captureAttempts.encounterId,
          rows.map((r) => r.id),
        ),
      );
    }
    await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  }

  beforeEach(async () => {
    await clearEncounters();
    await t.db
      .update(playerCurrencies)
      .set({ huntEnergy: 50, waifubux: 0, essence: 0 })
      .where(eq(playerCurrencies.playerId, playerId));
  });

  /**
   * Hand-builds an encounter in `regionId` and commits one capture against it,
   * returning the chance the formula computed.
   *
   * Deliberately reuses the *same* species and the same charm in both regions,
   * so the only difference between the two runs is the column travel writes.
   */
  async function captureChanceIn(regionId: string): Promise<number> {
    await forceRegion(t.db, playerId, regionId);
    await app.inventory.addItem(t.db, playerId, (await charmId()), 1);
    const [encounter] = await t.db
      .insert(encounters)
      .values({
        playerId,
        speciesId: sharedId,
        channelId: CHANNEL_ID,
        state: 'active',
        expiresAt: new Date(Date.now() + 60_000),
        regionId,
      })
      .returning();
    // A roll of 0.999 fails against any real chance, so both runs take the
    // identical branch and the comparison is of the formula, not the outcome.
    await app.capture.attemptCapture(playerId, encounter!.id, 'basic_charm');
    const [attempt] = await t.db
      .select({ chance: captureAttempts.computedChance })
      .from(captureAttempts)
      .where(eq(captureAttempts.encounterId, encounter!.id));
    return attempt!.chance;
  }

  async function charmId(): Promise<number> {
    const [item] = await t.db
      .select({ id: sql<number>`id` })
      .from(sql`items`)
      .where(sql`slug = 'basic_charm'`);
    return item!.id;
  }

  it('computes the same capture chance in Waifu Valley and Twin Peeks', async () => {
    const valley = await captureChanceIn('waifu-valley');
    await clearEncounters();
    const peaks = await captureChanceIn('twin-peeks');
    expect(peaks).toBe(valley);
  });

  it('never threads a region into the attempt row', async () => {
    // The encounter carries a region snapshot; the *attempt* — where capture
    // math is recorded — has no region column and must never grow one.
    await captureChanceIn('twin-peeks');
    const [attempt] = await t.db
      .select()
      .from(captureAttempts)
      .where(eq(captureAttempts.playerId, playerId))
      .limit(1);
    expect(Object.keys(attempt!)).not.toContain('regionId');
  });
});
