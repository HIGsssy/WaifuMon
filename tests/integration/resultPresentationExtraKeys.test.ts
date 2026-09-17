/**
 * The two presentation keys added after Phase 2, against real Postgres.
 *
 *   - a database migrated through 0034 accepts both keys, and still refuses
 *     `encountered` artwork for the one that has no Waifumon to show;
 *   - converting a copy is unchanged by presentation: the same row is
 *     released, the same Essence is paid once, and the Buddy uplift still
 *     applies;
 *   - authored variants for either key cannot move gameplay randomness —
 *     neither a conversion payout nor a World Encounter resolution.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeWorldEncounters,
  playerCurrencies,
  playerWaifus,
  resultPresentationVariants,
  species as speciesTable,
  worldEncounterCooldowns,
} from '../../src/db/schema';
import { RESULT_PRESENTATION_KEYS } from '../../src/modules/resultPresentation/keys';
import { createResultPresentationService } from '../../src/modules/resultPresentation/resultPresentationService';
import { seededRng } from '../../src/shared/random';
import {
  bootstrapApp,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
const CHANNEL = 'c-extra-keys';

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-extra-keys', 'u-extra-keys'));
});
afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(resultPresentationVariants);
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ essence: 0, waifubux: 0, huntEnergy: 50 })
    .where(eq(playerCurrencies.playerId, playerId));
});

async function speciesBySlug(slug: string) {
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.slug, slug));
  if (!row) throw new Error(`missing seeded species ${slug}`);
  return row;
}

/** Two active copies, so the newer one is a convertible duplicate. */
async function giveDuplicatePair(slug = 'alley_catgirl') {
  const species = await speciesBySlug(slug);
  const keep = await insertOwnedWaifu(t.db, {
    playerId,
    speciesId: species.id,
    level: 5,
  });
  const duplicate = await insertOwnedWaifu(t.db, {
    playerId,
    speciesId: species.id,
    level: 5,
  });
  return { species, keep, duplicate };
}

const variantsFor = (key: string, count: number, weight = 1) =>
  Array.from({ length: count }, (_, i) => ({
    presentationKey: key,
    flavorText: `${key} #${i + 1}`,
    weight,
  }));

describe('the migrated database', () => {
  it('accepts a variant for every canonical key, including the two new ones', async () => {
    for (const presentationKey of RESULT_PRESENTATION_KEYS) {
      await expect(
        t.db.insert(resultPresentationVariants).values({ presentationKey, flavorText: 'ok' }),
      ).resolves.toBeDefined();
    }
    expect(RESULT_PRESENTATION_KEYS).toContain('world_encounter.back_to_hunting');
    expect(RESULT_PRESENTATION_KEYS).toContain('collection.converted_to_essence');
  });

  it('allows encountered artwork for a conversion but not for Back to Hunting', async () => {
    await expect(
      t.db.insert(resultPresentationVariants).values({
        presentationKey: 'collection.converted_to_essence',
        artworkMode: 'encountered',
      }),
    ).resolves.toBeDefined();
    await expect(
      t.db.insert(resultPresentationVariants).values({
        presentationKey: 'world_encounter.back_to_hunting',
        artworkMode: 'encountered',
      }),
    ).rejects.toBeTruthy();
  });
});

describe('converting a copy is untouched by presentation', () => {
  it('releases exactly that row and pays the Essence once', async () => {
    const { species, keep, duplicate } = await giveDuplicatePair();
    const svc = createResultPresentationService({ db: t.db, logger: t.logger, ttlMs: 0 });
    for (const values of variantsFor('collection.converted_to_essence', 3, 5)) {
      await svc.createVariant(values);
    }

    const before = await app.currency.getBalances(playerId);
    const result = await app.collection.convertDuplicateToEssence(playerId, duplicate.id);
    const after = await app.currency.getBalances(playerId);

    expect(result.species.id).toBe(species.id);
    expect(result.waifu.id).toBe(duplicate.id);
    expect(result.essenceGranted).toBeGreaterThan(0);
    // Paid exactly once, and exactly what the result reported.
    expect(after.essence - before.essence).toBe(result.essenceGranted);
    expect(result.balanceAfter).toBe(after.essence);

    // Only the converted row is released; the kept copy is untouched.
    const [releasedRow] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, duplicate.id));
    expect(releasedRow!.releasedAt).not.toBeNull();
    const active = await t.db
      .select()
      .from(playerWaifus)
      .where(and(eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt)));
    expect(active.map((w) => w.id)).toEqual([keep.id]);

    // Her species row is still in hand afterwards, which is what lets the
    // built-in screen show her artwork.
    expect(result.species.slug).toBe(species.slug);
  });

  it('pays the same Essence whether variants exist, are reweighted or disabled', async () => {
    const svc = createResultPresentationService({ db: t.db, logger: t.logger, ttlMs: 0 });
    const payouts: number[] = [];

    const convertOnce = async () => {
      const { duplicate } = await giveDuplicatePair();
      const result = await app.collection.convertDuplicateToEssence(playerId, duplicate.id);
      payouts.push(result.essenceGranted);
      await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
    };

    await convertOnce(); // no variants
    for (const values of variantsFor('collection.converted_to_essence', 4, 3)) {
      await svc.createVariant(values);
    }
    await convertOnce(); // many variants
    await t.db.update(resultPresentationVariants).set({ weight: 999 });
    await convertOnce(); // reweighted
    await t.db.update(resultPresentationVariants).set({ enabled: false });
    await convertOnce(); // disabled

    expect(payouts[0]).toBeGreaterThan(0);
    expect(new Set(payouts).size).toBe(1);
  });

  it('still applies the Buddy essence_gain uplift with variants present', async () => {
    const svc = createResultPresentationService({ db: t.db, logger: t.logger, ttlMs: 0 });
    for (const values of variantsFor('collection.converted_to_essence', 2)) {
      await svc.createVariant(values);
    }
    // Baseline with no buddy.
    const plain = await giveDuplicatePair();
    const unbonused = await app.collection.convertDuplicateToEssence(playerId, plain.duplicate.id);
    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));

    // A buddy whose species authors `essence_gain`, if the shipped content has
    // one; otherwise this reduces to "the payout is still the table's".
    const bonusSpecies = app.content.species.find(
      (sp) => sp.buddyBonus?.effectId === 'essence_gain',
    );
    const { duplicate } = await giveDuplicatePair();
    if (bonusSpecies) {
      const row = await speciesBySlug(bonusSpecies.slug);
      const buddy = await insertOwnedWaifu(t.db, {
        playerId,
        speciesId: row.id,
        level: 20,
      });
      await app.collection.setBuddy(playerId, buddy.id);
    }
    const result = await app.collection.convertDuplicateToEssence(playerId, duplicate.id);
    if (bonusSpecies) {
      expect(result.essenceBonus).not.toBeNull();
      expect(result.essenceGranted).toBeGreaterThan(unbonused.essenceGranted);
    } else {
      expect(result.essenceGranted).toBe(unbonused.essenceGranted);
    }
    await app.collection.clearBuddy(playerId);
  });
});

describe('presentation randomness stays out of gameplay', () => {
  it('leaves a seeded World Encounter resolution identical', async () => {
    const svc = createResultPresentationService({ db: t.db, logger: t.logger, ttlMs: 0 });
    // Force the roll so this cannot pass by never firing.
    await app.worldEncounterSettings.update({ huntChance: 1, forceTrigger: true }, null);

    /** One seeded roll-and-resolve, reporting only what gameplay decided. */
    async function resolveOnce(seed: number) {
      // A pending encounter or a cooldown would block the next roll, so each
      // run starts from the same clean slate — including the balance, which
      // an encounter's payout would otherwise carry between runs.
      await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
      await t.db
        .delete(worldEncounterCooldowns)
        .where(eq(worldEncounterCooldowns.playerId, playerId));
      await t.db
        .update(playerCurrencies)
        .set({ essence: 0 })
        .where(eq(playerCurrencies.playerId, playerId));
      const activation = await app.worldEncounter.tryRollForHunt({
        playerId,
        playerLevel: 10,
        guildId: 1,
        channelId: CHANNEL,
        regionId: 'waifu-valley',
        rng: seededRng(seed),
      });
      if (!activation) return null;
      const resolution = await app.worldEncounter.resolveChoice({
        activeId: activation.activeId,
        playerId,
        choiceId: activation.encounter.choices[0]!.id,
        rng: seededRng(seed + 1),
      });
      return {
        slug: activation.encounter.slug,
        success: resolution.check.success,
        roll: resolution.check.roll,
        effects: resolution.effectsApplied,
        huntReturn: resolution.huntReturn !== null,
      };
    }

    const baseline = await resolveOnce(4242);
    // Not a vacuous pass: an encounter really fired and really resolved.
    expect(baseline).not.toBeNull();
    expect(baseline!.huntReturn).toBe(true);
    for (const values of variantsFor('world_encounter.back_to_hunting', 3, 7)) {
      await svc.createVariant(values);
    }
    expect(await resolveOnce(4242)).toEqual(baseline);
    await t.db.update(resultPresentationVariants).set({ weight: 1000 });
    expect(await resolveOnce(4242)).toEqual(baseline);
    await t.db.update(resultPresentationVariants).set({ enabled: false });
    expect(await resolveOnce(4242)).toEqual(baseline);
  });

  it('draws only from its own rng when resolving either new key', async () => {
    const random = vi.spyOn(Math, 'random');
    const svc = createResultPresentationService({
      db: t.db,
      logger: t.logger,
      ttlMs: 0,
      rng: seededRng(9),
    });
    for (const values of variantsFor('world_encounter.back_to_hunting', 2, 4)) {
      await svc.createVariant(values);
    }
    for (const values of variantsFor('collection.converted_to_essence', 2, 4)) {
      await svc.createVariant(values);
    }
    for (let n = 0; n < 5; n++) {
      await svc.resolve('world_encounter.back_to_hunting');
      await svc.resolve('collection.converted_to_essence');
    }
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});
