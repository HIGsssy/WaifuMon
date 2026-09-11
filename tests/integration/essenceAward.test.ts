/**
 * The shared Essence award path — real Postgres, real services.
 *
 * The bug this file is a net around: `essence_gain` used to be implemented
 * twice (Hunt, Convert) and forgotten twice (World Encounters, Daily Quests),
 * because the multiply lived at each caller rather than at one domain seam.
 * `EssenceAwardService.awardEssence` is that seam now, so the assertions below
 * are deliberately about *coverage* — every gameplay Essence reward pays the
 * bonus, and every system grant still pays exactly what it was asked.
 *
 * The two halves matter equally. A test proving the bonus applies everywhere
 * is only half the contract; the other half is that `currency.grantEssence`
 * stayed raw, so an admin correction or a refund is never silently amplified.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activeWorldEncounters,
  playerCurrencies,
  playerWaifus,
  players,
  species,
  worldEncounterChoices,
  worldEncounterHistory,
  worldEncounters,
} from '../../src/db/schema';
import type { Effect } from '../../src/modules/worldEncounters/types';
import type { BuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;
let buddySlug: string;

let slugCounter = 0;
const nextSlug = (): string => `essence_award_test_${++slugCounter}`;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-essence-award', 'u-1'));
  buddySlug = app.content.species.find((s) => s.enabled)!.slug;
});
afterAll(async () => {
  await t.cleanup();
});

/* ───────────────────────────── helpers ───────────────────────────── */

/** Define an encounter with one auto-resolving choice carrying `effects`. */
async function defineEncounter(
  successEffects: Effect[],
): Promise<{ encounterId: number; choiceId: number }> {
  const [encounter] = await t.db
    .insert(worldEncounters)
    .values({
      slug: nextSlug(),
      name: 'A Glinting Seam',
      description: 'Something valuable in the rock.',
      type: 'decision',
      rarity: 'common',
      weight: 10,
      lifecycle: 'active',
      huntEligible: true,
      travelEligible: true,
      cooldownSeconds: 0,
      choicesRequired: true,
    })
    .returning();
  const [choice] = await t.db
    .insert(worldEncounterChoices)
    .values({
      encounterId: encounter!.id,
      sortOrder: 0,
      label: 'Chip it free',
      checkJson: { type: 'none' },
      successEffectsJson: successEffects as unknown as Record<string, unknown>[],
      failureEffectsJson: [],
    })
    .returning();
  return { encounterId: encounter!.id, choiceId: choice!.id };
}

async function activate(encounterId: number): Promise<number> {
  const [row] = await t.db
    .insert(activeWorldEncounters)
    .values({
      playerId,
      encounterId,
      source: 'travel',
      regionId: 'waifu-valley',
      originRegionId: 'waifu-valley',
      destinationRegionId: 'twin-peeks',
      guildId: guildDbId,
      channelId: 'c-essence-award',
      contextJson: {},
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .returning();
  return row!.id;
}

/**
 * Author a Buddy Bonus onto a species in the live content snapshot.
 *
 * Nothing here names a species on purpose: every assertion drives the effect
 * through whatever species the fixture happens to make the Buddy, so a passing
 * test proves the *effect* works rather than that one Ramen Android does.
 */
const shipped = new Map<string, BuddyBonus | undefined>();
function authorBonus(slug: string, bonus: BuddyBonus | null): void {
  const entry = app.content.species.find((s) => s.slug === slug)!;
  if (!shipped.has(slug)) shipped.set(slug, entry.buddyBonus);
  if (bonus) entry.buddyBonus = bonus;
  else delete entry.buddyBonus;
}
function restoreBonuses(): void {
  for (const [slug, bonus] of shipped) {
    const entry = app.content.species.find((s) => s.slug === slug)!;
    if (bonus) entry.buddyBonus = bonus;
    else delete entry.buddyBonus;
  }
  shipped.clear();
}

const essenceBonus = (value: number, name = 'Extra Serving'): BuddyBonus => ({
  name,
  flavorText: `${name}: +${value}% Essence gained.`,
  effectId: 'essence_gain',
  value,
});

async function equipBuddy(slug = buddySlug): Promise<number> {
  const [row] = await t.db.select().from(species).where(eq(species.slug, slug));
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: row!.id });
  await app.collection.setBuddy(playerId, waifu.id);
  return waifu.id;
}

const essenceOf = async (): Promise<number> => (await app.currency.getBalances(playerId)).essence;

beforeEach(async () => {
  restoreBonuses();
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 1000, essence: 0, huntEnergy: 20 })
    .where(eq(playerCurrencies.playerId, playerId));
});

/* ─────────────────────── the award service itself ─────────────────────── */

describe('EssenceAwardService.awardEssence', () => {
  it('grants the base amount unchanged when no Buddy is equipped', async () => {
    const result = await t.db.transaction((tx) =>
      app.essenceAward.awardEssence(tx, playerId, 40),
    );
    expect(result).toMatchObject({ baseAmount: 40, essenceGranted: 40, bonus: null });
    expect(await essenceOf()).toBe(40);
  });

  it('applies the equipped Buddy’s essence_gain: 40 at +30% is 52', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();

    const result = await t.db.transaction((tx) =>
      app.essenceAward.awardEssence(tx, playerId, 40),
    );

    expect(result.baseAmount).toBe(40);
    expect(result.essenceGranted).toBe(52);
    expect(result.essenceAfter).toBe(52);
    expect(result.bonus).toMatchObject({
      effectId: 'essence_gain',
      value: 30,
      baseValue: 40,
      finalValue: 52,
    });
    expect(await essenceOf()).toBe(52);
  });

  it('is generic across values — nothing is keyed to one species or percentage', async () => {
    // Three different bonuses, three different species-agnostic percentages,
    // one formula. If any of these needed its own branch, the effect would not
    // be content-driven.
    for (const [percent, expected] of [
      [25, 50],
      [50, 60],
      [100, 80],
      [200, 120],
    ] as const) {
      restoreBonuses();
      await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
      await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
      await t.db
        .update(playerCurrencies)
        .set({ essence: 0 })
        .where(eq(playerCurrencies.playerId, playerId));

      authorBonus(buddySlug, essenceBonus(percent, `Cut ${percent}`));
      await equipBuddy();
      const result = await t.db.transaction((tx) =>
        app.essenceAward.awardEssence(tx, playerId, 40),
      );
      expect(result.essenceGranted, `+${percent}%`).toBe(expected);
    }
  });

  it('rounds rather than floors, matching the shipped shared helper', async () => {
    // 7 at +25% is 8.75 → 9. Flooring would give 8, which is the behaviour
    // `applyPercentModifierInt` exists to avoid: a bonus too small to clear an
    // integer step reads to a player as broken rather than small.
    authorBonus(buddySlug, essenceBonus(25));
    await equipBuddy();
    const result = await t.db.transaction((tx) => app.essenceAward.awardEssence(tx, playerId, 7));
    expect(result.essenceGranted).toBe(9);
  });

  it('reports no bonus when the percentage cannot lift the award', async () => {
    // 1 at +30% is 1.3 → 1. The award did not move, so there is nothing to
    // tell the player and `bonus` must stay null.
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    const result = await t.db.transaction((tx) => app.essenceAward.awardEssence(tx, playerId, 1));
    expect(result.essenceGranted).toBe(1);
    expect(result.bonus).toBeNull();
  });

  it('ignores a Buddy Bonus for a different effect', async () => {
    authorBonus(buddySlug, {
      name: 'Star Charts',
      flavorText: '+30% XP gained by the active Buddy.',
      effectId: 'buddy_xp_gain',
      value: 30,
    });
    await equipBuddy();
    const result = await t.db.transaction((tx) => app.essenceAward.awardEssence(tx, playerId, 40));
    expect(result.essenceGranted).toBe(40);
    expect(result.bonus).toBeNull();
  });

  it('ignores a targeted capture bonus, which names no Essence at all', async () => {
    authorBonus(buddySlug, {
      name: 'Royal Favor',
      flavorText: '+12% capture chance against SSR+ Waifumon.',
      effectId: 'capture_chance',
      value: 12,
      target: { type: 'rarity_min', value: 'SSR' },
    });
    await equipBuddy();
    const result = await t.db.transaction((tx) => app.essenceAward.awardEssence(tx, playerId, 40));
    expect(result.essenceGranted).toBe(40);
    expect(result.bonus).toBeNull();
  });

  it('refuses a non-positive award rather than writing one', async () => {
    await expect(
      t.db.transaction((tx) => app.essenceAward.awardEssence(tx, playerId, 0)),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      t.db.transaction((tx) => app.essenceAward.awardEssence(tx, playerId, -5)),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

/* ───────────────── the raw path stays raw ───────────────── */

describe('currency.grantEssence remains a raw system mutation', () => {
  it('grants an exact amount even with a +30% Essence Buddy equipped', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();

    await t.db.transaction((tx) => app.currency.grantEssence(tx, playerId, 40));

    // 40, not 52. Admin grants, compensation, migrations and refunds all ride
    // this path and must move the balance by exactly what was asked.
    expect(await essenceOf()).toBe(40);
  });

  it('leaves an admin-style correction unamplified', async () => {
    authorBonus(buddySlug, essenceBonus(100));
    await equipBuddy();
    const row = await t.db.transaction((tx) =>
      app.currency.grantEssence(tx, playerId, 1234),
    );
    expect(row.essence).toBe(1234);
  });
});

/* ─────────────────────── World Encounters ─────────────────────── */

describe('World Encounter essence_gain', () => {
  it('pays 40 as 52 with a +30% Buddy, and says so in the applied entry', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'essence_gain', amount: 40 },
    ]);
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    expect(await essenceOf()).toBe(52);
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'essence_gain');
    expect(entry).toMatchObject({ applied: true, amount: 52 });
    expect(entry!.essence).toMatchObject({
      baseAmount: 40,
      finalAmount: 52,
      essenceAfter: 52,
    });
    expect(entry!.essence!.bonus).toMatchObject({
      effectId: 'essence_gain',
      value: 30,
      baseValue: 40,
      finalValue: 52,
    });
  });

  it('pays 40 as 40 with no Buddy, and reports no bonus', async () => {
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'essence_gain', amount: 40 },
    ]);
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    expect(await essenceOf()).toBe(40);
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'essence_gain');
    expect(entry!.essence).toMatchObject({ baseAmount: 40, finalAmount: 40, bonus: null });
  });

  it('persists base, final and bonus onto the history row', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'essence_gain', amount: 40 },
    ]);
    const activeId = await activate(encounterId);
    await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    // The audit trail has to carry the concrete numbers, not a template of
    // intent — "why was this 52?" must be answerable from the row alone.
    const [row] = await t.db
      .select()
      .from(worldEncounterHistory)
      .where(eq(worldEncounterHistory.playerId, playerId));
    const applied = row!.effectsAppliedJson as unknown as Array<Record<string, unknown>>;
    const stored = applied.find((e) => (e.effect as { type: string }).type === 'essence_gain');
    expect(stored!.essence).toMatchObject({
      baseAmount: 40,
      finalAmount: 52,
      bonus: { value: 30 },
    });
  });

  it('does not touch a Waifubux payout on the same choice', async () => {
    // `essence_gain` is a modifier on Essence and nothing else — a choice that
    // pays both must move only one of the two numbers.
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'essence_gain', amount: 40 },
      { type: 'waifubux_gain', amount: 200 },
    ]);
    const activeId = await activate(encounterId);
    await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    const bal = await app.currency.getBalances(playerId);
    expect(bal.essence).toBe(52);
    expect(bal.waifubux).toBe(1200);
  });
});
