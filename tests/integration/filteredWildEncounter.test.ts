/**
 * Filtered `trigger_waifumon_encounter` selectors, end to end — real Postgres,
 * real hunt/travel rolls, real spawner, real capture service.
 *
 * The species world is made small and fully known in `beforeAll`: every
 * species but four is disabled and the region pools are rebuilt by hand, so
 * "only LR", "never another region" and "no fallback" are exact assertions
 * rather than statistical ones.
 *
 *   valleyLr  — LR, primal,   pooled in waifu-valley
 *   valleyN   — N,             pooled in waifu-valley
 *   peaksLr   — LR, dominant,  pooled in twin-peeks only
 *   globalUr  — UR,            in no pool, not region-exclusive
 *
 * Requires Docker/testcontainers (or `TEST_DATABASE_URL`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import {
  activeWorldEncounters,
  encounters,
  playerCurrencies,
  regionEncounterPools,
  species,
  worldEncounters,
  type SpeciesRow,
} from '../../src/db/schema';
import { raceResolverFromContent } from '../../src/modules/encounters/speciesSelection';
import type { Effect } from '../../src/modules/worldEncounters/types';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const T = 'trigger_waifumon_encounter' as const;
const SLUG = 'test_filtered_sighting';

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;
let valleyLr: SpeciesRow;
let valleyN: SpeciesRow;
let peaksLr: SpeciesRow;
let globalUr: SpeciesRow;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-filter', 'u-filter'));

  const picked = await t.db
    .select()
    .from(species)
    .where(eq(species.enabled, true))
    .orderBy(species.id)
    .limit(4);
  if (picked.length < 4) throw new Error('need four enabled species');
  const ids = picked.map((s) => s.id);
  await t.db.update(species).set({ enabled: false }).where(notInArray(species.id, ids));

  const shape = async (row: SpeciesRow, patch: Partial<SpeciesRow>): Promise<SpeciesRow> => {
    const [out] = await t.db
      .update(species)
      .set({ tags: [], ...patch })
      .where(eq(species.id, row.id))
      .returning();
    return out!;
  };
  valleyLr = await shape(picked[0]!, { rarity: 'LR', affinity: 'primal' });
  valleyN = await shape(picked[1]!, { rarity: 'N', affinity: 'switch' });
  peaksLr = await shape(picked[2]!, { rarity: 'LR', affinity: 'dominant' });
  globalUr = await shape(picked[3]!, { rarity: 'UR', affinity: 'switch' });

  await t.db.delete(regionEncounterPools);
  await t.db.insert(regionEncounterPools).values([
    { regionId: 'waifu-valley', speciesId: valleyLr.id, weight: 10 },
    { regionId: 'waifu-valley', speciesId: valleyN.id, weight: 10 },
    { regionId: 'twin-peeks', speciesId: peaksLr.id, weight: 10 },
  ]);

  // Every roll below must land on the fixture encounter, whatever the dice.
  await app.worldEncounterSettings.update({ forceTrigger: true });
  await seed({ type: T });
  await t.db
    .update(worldEncounters)
    .set({ lifecycle: 'disabled' })
    .where(ne(worldEncounters.slug, SLUG));
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 5000, essence: 1000, huntEnergy: 20 })
    .where(eq(playerCurrencies.playerId, playerId));
});

/** Hunt- and travel-eligible everywhere, one auto-succeeding choice. */
async function seed(effect: Record<string, unknown>): Promise<void> {
  await app.worldEncounterAdmin.upsert({
    slug: SLUG,
    name: 'Tracks in the Mud',
    description: 'Something large passed this way.',
    type: 'discovery',
    rarity: 'common',
    weight: 1,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: true,
    cooldownSeconds: 0,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    metadata: {},
    choices: [
      {
        label: 'Follow the tracks',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: [effect as Effect],
        failureEffects: [],
      },
    ],
  });
}

function random(filters: Record<string, unknown>) {
  return { type: T, selection: { mode: 'random', ...filters } };
}

async function resolveActivation(activeId: number, choiceId: number) {
  return app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
}

/** A hunt in `regionId` that rolls into the fixture encounter, then resolves it. */
async function huntIn(regionId: string) {
  const activation = await app.worldEncounter.tryRollForHunt({
    playerId,
    playerLevel: 10,
    guildId: guildDbId,
    channelId: 'c-1',
    regionId,
  });
  if (!activation) throw new Error('expected the forced roll to activate');
  const resolution = await resolveActivation(activation.activeId, activation.encounter.choices[0]!.id);
  return { activeId: activation.activeId, resolution };
}

/**
 * A journey `from` → `to`, called exactly as the Discord layer calls it
 * (`waifumonWorldEncounter.ts`): travel has already committed, and the
 * encounter's `regionId` is the destination.
 */
async function travel(from: string, to: string) {
  const activation = await app.worldEncounter.tryRollForTravel({
    playerId,
    playerLevel: 10,
    guildId: guildDbId,
    channelId: 'c-1',
    regionId: to,
    originRegionId: from,
    destinationRegionId: to,
  });
  if (!activation) throw new Error('expected the forced roll to activate');
  const resolution = await resolveActivation(activation.activeId, activation.encounter.choices[0]!.id);
  return { activeId: activation.activeId, resolution };
}

async function spawnedRows() {
  return t.db
    .select()
    .from(encounters)
    .where(and(eq(encounters.playerId, playerId), eq(encounters.originKind, 'world_encounter')));
}

async function clearWild(): Promise<void> {
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
}

/* ─────────────────────────── Selection ─────────────────────────── */

describe('region scope', () => {
  it('rarities ["LR"] from a valley hunt only ever yields the valley LR', async () => {
    await seed(random({ poolScope: 'region', rarities: ['LR'] }));
    for (let i = 0; i < 5; i++) {
      await clearWild();
      const { resolution } = await huntIn('waifu-valley');
      expect(resolution.wildEncounter?.status).toBe('created');
      // Not valleyN (wrong rarity), not peaksLr (wrong region).
      expect(resolution.wildEncounter?.speciesSlug).toBe(valleyLr.slug);
    }
  });

  it('an unfiltered region selector never leaves the region', async () => {
    await seed(random({ poolScope: 'region' }));
    for (let i = 0; i < 5; i++) {
      await clearWild();
      const { resolution } = await huntIn('twin-peeks');
      expect(resolution.wildEncounter?.speciesSlug).toBe(peaksLr.slug);
    }
  });

  it('race and affinity filters narrow the candidates', async () => {
    const race = raceResolverFromContent(() => app.content)(valleyLr);
    await seed(random({ poolScope: 'region', rarities: ['LR'], races: [race], affinities: ['primal'] }));
    expect((await huntIn('waifu-valley')).resolution.wildEncounter?.speciesSlug).toBe(valleyLr.slug);

    await clearWild();
    await seed(random({ poolScope: 'region', rarities: ['LR'], affinities: ['caregiver'] }));
    expect((await huntIn('waifu-valley')).resolution.wildEncounter?.status).toBe('unavailable');
  });
});

describe('global scope', () => {
  it('can reach a species in no pool at all', async () => {
    await seed(random({ poolScope: 'global', rarities: ['UR'] }));
    const { resolution } = await huntIn('waifu-valley');
    expect(resolution.wildEncounter?.speciesSlug).toBe(globalUr.slug);
  });

  it('can reach an out-of-region species, and only matching ones', async () => {
    await seed(random({ poolScope: 'global', rarities: ['LR'] }));
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      await clearWild();
      const { resolution } = await huntIn('twin-peeks');
      seen.add(resolution.wildEncounter!.speciesSlug!);
    }
    expect([...seen].every((s) => s === valleyLr.slug || s === peaksLr.slug)).toBe(true);
  });
});

describe('zero candidates', () => {
  it('never falls back to Waifu Valley', async () => {
    // Twin Peeks has no N; the valley does. Strict means nothing appears.
    await seed(random({ poolScope: 'region', rarities: ['N'] }));
    const { activeId, resolution } = await huntIn('twin-peeks');

    expect(resolution.wildEncounter?.status).toBe('unavailable');
    expect(resolution.wildEncounter?.unavailableReason).toBe('no_matching_species');
    expect(resolution.wildEncounter?.encounterId).toBeNull();
    expect(await spawnedRows()).toHaveLength(0);

    // The World Encounter itself resolved cleanly — no dangling pending row.
    const [row] = await t.db
      .select()
      .from(activeWorldEncounters)
      .where(eq(activeWorldEncounters.id, activeId));
    expect(row?.status).toBe('resolved');
  });

  it('never falls back to the global table', async () => {
    // A UR exists — just not in the valley's pool.
    await seed(random({ poolScope: 'region', rarities: ['UR'] }));
    const { resolution } = await huntIn('waifu-valley');
    expect(resolution.wildEncounter?.unavailableReason).toBe('no_matching_species');
    expect(await spawnedRows()).toHaveLength(0);
  });

  it('never falls back to another rarity', async () => {
    await seed(random({ poolScope: 'global', rarities: ['EX'] }));
    const before = await app.currency.getBalances(playerId);
    const { resolution } = await huntIn('waifu-valley');
    expect(resolution.wildEncounter?.unavailableReason).toBe('no_matching_species');
    expect(await spawnedRows()).toHaveLength(0);
    expect((await app.currency.getBalances(playerId)).huntEnergy).toBe(before.huntEnergy);
  });
});

describe('legacy and specific shapes are unchanged', () => {
  it('legacy random still spawns through the hunt draw (fallbacks included)', async () => {
    await seed({ type: T });
    const { resolution } = await huntIn('twin-peeks');
    expect(resolution.wildEncounter?.status).toBe('created');
    expect([valleyLr.slug, valleyN.slug, peaksLr.slug]).toContain(
      resolution.wildEncounter?.speciesSlug,
    );
  });

  it('legacy speciesSlug and selection.mode "specific" both name the species outright', async () => {
    await seed({ type: T, speciesSlug: globalUr.slug });
    expect((await huntIn('twin-peeks')).resolution.wildEncounter?.speciesSlug).toBe(globalUr.slug);

    await clearWild();
    await seed({ type: T, selection: { mode: 'specific', speciesSlug: valleyN.slug } });
    expect((await huntIn('twin-peeks')).resolution.wildEncounter?.speciesSlug).toBe(valleyN.slug);
  });
});

/* ─────────────────────────── Region semantics ─────────────────────────── */

describe('which region a selector resolves in', () => {
  it('hunt-origin: the region the hunt happened in', async () => {
    await seed(random({ poolScope: 'region', rarities: ['LR'] }));
    expect((await huntIn('waifu-valley')).resolution.wildEncounter?.speciesSlug).toBe(valleyLr.slug);
    await clearWild();
    expect((await huntIn('twin-peeks')).resolution.wildEncounter?.speciesSlug).toBe(peaksLr.slug);
  });

  it('travel-origin: the committed destination, not the origin', async () => {
    await seed(random({ poolScope: 'region', rarities: ['LR'] }));
    const { activeId, resolution } = await travel('waifu-valley', 'twin-peeks');

    const [row] = await t.db
      .select()
      .from(activeWorldEncounters)
      .where(eq(activeWorldEncounters.id, activeId));
    expect(row?.source).toBe('travel');
    expect(row?.originRegionId).toBe('waifu-valley');
    expect(row?.regionId).toBe('twin-peeks');
    // The origin has an LR too — it must not be the one that appears.
    expect(resolution.wildEncounter?.speciesSlug).toBe(peaksLr.slug);
    expect(resolution.journey?.destinationRegionId).toBe('twin-peeks');
  });
});

/* ─────────────────────────── Canonical pipeline ─────────────────────────── */

describe('the selected species goes through the ordinary spawn and capture path', () => {
  it('writes an ordinary encounters row the hunt service treats as active', async () => {
    await seed(random({ poolScope: 'region', rarities: ['LR'] }));
    const { activeId, resolution } = await huntIn('waifu-valley');

    const active = await app.hunt.getActiveEncounterDetail(playerId);
    expect(active?.encounter.id).toBe(resolution.wildEncounter!.encounterId);
    expect(active?.encounter.originKind).toBe('world_encounter');
    expect(active?.encounter.originRef).toBe(String(activeId));
    expect(active?.encounter.state).toBe('active');
    expect(active?.encounter.attemptCount).toBe(0);
    expect(active?.species.slug).toBe(valleyLr.slug);
  });

  it('quotes capture exactly as for a hunted encounter of the same species — not guaranteed', async () => {
    // The sighting is the only guarantee. Comparing against an ordinary hunted
    // row under the same player state proves charms, affinity, capture
    // Buddy Bonuses and consumable effects all flow through the one shared
    // formula rather than an LR-specific path.
    await seed(random({ poolScope: 'region', rarities: ['LR'] }));
    const { resolution } = await huntIn('waifu-valley');
    const spawnedId = resolution.wildEncounter!.encounterId!;
    const spawned = await app.capture.quoteCapture(playerId, spawnedId, null);

    await clearWild();
    const [hunted] = await t.db
      .insert(encounters)
      .values({
        playerId,
        speciesId: valleyLr.id,
        channelId: 'c-1',
        state: 'active',
        attemptCount: 0,
        maxAttempts: 3,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        regionId: 'waifu-valley',
      })
      .returning();
    const ordinary = await app.capture.quoteCapture(playerId, hunted!.id, null);

    const shape = (q: typeof spawned) => ({
      chance: q.chance,
      baselineChance: q.baselineChance,
      guaranteed: q.guaranteed,
      buddyAffinityModifier: q.buddyAffinityModifier,
      captureBonusModifier: q.captureBonusModifier,
      buddyBonusPercent: q.buddyBonusPercent,
    });
    expect(shape(spawned)).toEqual(shape(ordinary));
    expect(spawned.guaranteed).toBe(false);
    expect(spawned.chance).toBeLessThan(1);
    expect(await app.capture.listEncounterItems(playerId, hunted!.id)).toBeInstanceOf(Array);
  });

  it('spends no Hunt Energy', async () => {
    await seed(random({ poolScope: 'region', rarities: ['LR'] }));
    const before = await app.currency.getBalances(playerId);
    await huntIn('waifu-valley');
    const after = await app.currency.getBalances(playerId);
    expect(after.huntEnergy).toBe(before.huntEnergy);
  });

  it('keeps origin idempotency: a replay never re-rolls or duplicates', async () => {
    await seed(random({ poolScope: 'region', rarities: ['LR'] }));
    const { activeId, resolution } = await huntIn('waifu-valley');
    const firstId = resolution.wildEncounter!.encounterId!;

    // Double-resolve is refused before any effect — the spawn included — can
    // run a second time.
    await expect(resolveActivation(activeId, resolution.choice.id)).rejects.toBeTruthy();

    // Replaying the spawn with the same origin returns the original, even with
    // a selector that would now match nobody — the species is never re-drawn.
    const replay = await app.wildEncounters.createWildEncounter({
      playerId,
      channelId: 'c-1',
      regionId: 'waifu-valley',
      origin: { kind: 'world_encounter', ref: String(activeId) },
      selection: { poolScope: 'region', rarities: ['EX'] },
    });
    expect(replay.status).toBe('existing');
    if (replay.status === 'existing') expect(replay.encounter.id).toBe(firstId);

    const rows = await spawnedRows();
    expect(rows.map((r) => r.id)).toEqual([firstId]);
  });
});
