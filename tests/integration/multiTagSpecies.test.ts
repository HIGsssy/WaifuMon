/**
 * A species may carry more than one tag.
 *
 * Written because `region_exclusive` is the first tag with *runtime* meaning —
 * the hunt's global fallback filters on it — and it lands on expansion species
 * that already carry `expansion`. Everything downstream of the schema treats
 * `tags` as a set, but nothing proved it: every fixture in the suite used
 * either `[]` or a single tag, so a regression to "one tag per species" (a
 * `tags[0]`, an array-equality compare, a lossy comma round-trip) would have
 * gone unnoticed until an expansion species quietly stopped being exclusive.
 *
 * The exclusion is asserted through the *emergency* fallback rather than by
 * inspecting the query: with the multi-tag species as the only enabled species
 * and no pools seeded, tiers 1–3 must all decline her, so tier 4 firing is
 * proof the filter matched `region_exclusive` inside a two-element array. The
 * single-tag contrast case is what stops that passing for the wrong reason —
 * without it, a filter that excluded *any* tagged species would look correct.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  encounters,
  playerCurrencies,
  players,
  regionEncounterPools,
  species,
  type SpeciesRow,
} from '../../src/db/schema';
import { validateContentSet } from '../../src/modules/content/loader';
import { SpeciesContentSchema, type SpeciesContent } from '../../src/modules/content/schemas';
import { seedContent } from '../../src/modules/content/seeder';
import { createHuntService } from '../../src/modules/hunt/huntService';
import { REGION_EXCLUSIVE_TAG } from '../../src/modules/locations/regions';
import type { Logger } from '../../src/shared/logger';
import { bootstrapApp, provisionPlayer, scriptedRng, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;

const CHANNEL_ID = 'chan-multitag';
const MULTI = 'multi_tag_exclusive';
const OPEN = 'multi_tag_open';

/** The species under test: an expansion Waifumon that is also region-locked. */
const MULTI_TAGS = ['expansion', REGION_EXCLUSIVE_TAG];
/** The contrast: same shape, same tag *count* is irrelevant — one tag, no lock. */
const OPEN_TAGS = ['expansion'];

function authored(slug: string, tags: string[]): unknown {
  return {
    slug,
    name: slug,
    rarity: 'N',
    archetype: 'human',
    race: 'human',
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: `waifumon/${slug}/standard.png`,
    tags,
  };
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-multitag', 'u-multitag'));
});
afterAll(() => t.cleanup());

beforeEach(async () => {
  // Each hunt leaves an active encounter, and one-per-player is a hard
  // invariant — so the previous test's encounter has to go before the next
  // hunt, not because of anything this file is testing.
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: 25 })
    .where(eq(playerCurrencies.playerId, playerId));
  await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
});

/**
 * Seeds the two test species alongside shipped content, then reduces the world
 * to just `only`: no encounter pools and nothing else enabled. That is the one
 * state in which the global fallback is the only tier left, which is exactly
 * where the tag filter lives.
 */
async function isolate(only: string): Promise<void> {
  const parsed = [
    SpeciesContentSchema.parse(authored(MULTI, MULTI_TAGS)),
    SpeciesContentSchema.parse(authored(OPEN, OPEN_TAGS)),
  ] as SpeciesContent[];
  const content = { ...app.content, species: [...app.content.species, ...parsed] };
  validateContentSet(content);
  await seedContent(t.db, content, t.logger);

  await t.db.delete(regionEncounterPools);
  await t.db.update(species).set({ enabled: false });
  await t.db.update(species).set({ enabled: true }).where(eq(species.slug, only));
}

interface HuntProbe {
  picked: SpeciesRow;
  /** True when the tier-4 emergency fired — i.e. tiers 1–3 all declined. */
  usedEmergency: boolean;
}

async function huntOnce(): Promise<HuntProbe> {
  const logged: unknown[] = [];
  const capturing = {
    ...t.logger,
    warn: (obj: unknown) => logged.push(obj),
    error: (obj: unknown) => logged.push(obj),
  } as unknown as Logger;

  const hunt = createHuntService({
    db: t.db,
    currency: app.currency,
    inventory: app.inventory,
    progression: app.progression,
    collection: app.collection,
    care: app.care,
    quests: app.quests,
    tables: app.content.tables,
    logger: capturing,
    // One result-kind roll, then up to six rarity rerolls.
    rng: scriptedRng([0, 0, 0, 0, 0, 0, 0, 0]),
  });
  const result = await hunt.hunt(playerId, CHANNEL_ID);
  expect(result.kind).toBe('encounter');
  return {
    picked: (result as { species: SpeciesRow }).species,
    usedEmergency: logged.some(
      (l) => (l as { tag?: string })?.tag === 'hunt/exclusive-emergency-fallback',
    ),
  };
}

describe('a species carrying ["expansion", "region_exclusive"]', () => {
  it('validates through the canonical species schema with both tags intact', () => {
    const parsed = SpeciesContentSchema.safeParse(authored(MULTI, MULTI_TAGS));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tags).toEqual(['expansion', 'region_exclusive']);
  });

  it('seeds with both tags preserved, in order', async () => {
    await isolate(MULTI);
    const [row] = await t.db.select().from(species).where(eq(species.slug, MULTI));
    expect(row!.tags).toEqual(['expansion', 'region_exclusive']);
    expect(row!.enabled).toBe(true);
  });

  it('is excluded from the global hunt fallback by region_exclusive', async () => {
    await isolate(MULTI);
    const { picked, usedEmergency } = await huntOnce();
    // She is the only enabled species, so she is what comes back either way —
    // the question is *which tier* produced her. The emergency firing is the
    // assertion: tier 3 refused her despite her matching rarity and enabled.
    expect(picked.slug).toBe(MULTI);
    expect(usedEmergency).toBe(true);
  });

  it('still carries the expansion tag everywhere it travels', async () => {
    await isolate(MULTI);
    const { picked } = await huntOnce();
    // The tag the filter does *not* care about must survive the round trip
    // through jsonb and back onto the encountered species row.
    expect(picked.tags).toEqual(['expansion', 'region_exclusive']);
    expect(picked.tags).toContain('expansion');
  });

  it('is excluded because of region_exclusive, not because it is tagged at all', async () => {
    // The contrast that stops the exclusion test passing for the wrong reason:
    // an identical species tagged only `expansion` must reach tier 3 normally,
    // with no emergency.
    await isolate(OPEN);
    const { picked, usedEmergency } = await huntOnce();
    expect(picked.slug).toBe(OPEN);
    expect(picked.tags).toEqual(['expansion']);
    expect(usedEmergency).toBe(false);
  });
});
