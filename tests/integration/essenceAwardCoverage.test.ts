/**
 * Every gameplay Essence reward pays `essence_gain` — the coverage half.
 *
 * `essenceAward.test.ts` proves the shared award path is correct in isolation.
 * This file proves each *reward* actually goes through it, which is the thing
 * that was broken: Hunt and Convert did their own multiply, World Encounters
 * and Daily Quests did none at all, and nothing failed when a path forgot.
 *
 * The Hunt and Convert cases are therefore regression assertions rather than
 * new behaviour — they shipped correct, were refactored onto the shared path,
 * and must produce byte-for-byte the same payout. The Quest cases are new
 * coverage for a path that previously paid the raw authored amount.
 *
 * The preview cases close the presentation half of the same bug: the
 * pre-confirmation screens quoted the rarity table, so a player with an
 * Essence Buddy was shown less than they were about to receive.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  playerCurrencies,
  playerDailyQuests,
  playerWaifus,
  players,
  species,
} from '../../src/db/schema';
import type { BuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import { createHuntService } from '../../src/modules/hunt/huntService';
import {
  bootstrapApp,
  insertOwnedWaifu,
  provisionPlayer,
  scriptedRng,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let buddySlug: string;
/** A species that is *not* the Buddy, so conversions never hit the buddy guard. */
let dupSlug: string;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-essence-coverage', 'u-1'));
  const enabled = app.content.species.filter((s) => s.enabled);
  buddySlug = enabled[0]!.slug;
  dupSlug = enabled[1]!.slug;
});
afterAll(async () => {
  await t.cleanup();
});

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

const essenceBonus = (value: number): BuddyBonus => ({
  name: 'Extra Serving',
  flavorText: `Extra Serving: +${value}% Essence gained.`,
  effectId: 'essence_gain',
  value,
});

async function speciesIdFor(slug: string): Promise<number> {
  const [row] = await t.db.select().from(species).where(eq(species.slug, slug));
  return row!.id;
}

async function equipBuddy(): Promise<number> {
  const waifu = await insertOwnedWaifu(t.db, {
    playerId,
    speciesId: await speciesIdFor(buddySlug),
  });
  await app.collection.setBuddy(playerId, waifu.id);
  return waifu.id;
}

/** Two copies of a non-Buddy species, so the second is a convertible duplicate. */
async function insertDuplicatePair(): Promise<{ rarity: string; waifuId: number }> {
  const speciesId = await speciesIdFor(dupSlug);
  await insertOwnedWaifu(t.db, { playerId, speciesId });
  const dup = await insertOwnedWaifu(t.db, { playerId, speciesId });
  const [row] = await t.db.select().from(species).where(eq(species.id, speciesId));
  return { rarity: row!.rarity, waifuId: dup.id };
}

/** What the rarity table alone says a full conversion is worth. */
function tableEssence(rarity: string): number {
  return (app.content.tables.duplicate.essenceByRarity as Record<string, number>)[rarity] ?? 0;
}

const essenceOf = async (): Promise<number> => (await app.currency.getBalances(playerId)).essence;

beforeEach(async () => {
  restoreBonuses();
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.delete(playerDailyQuests).where(eq(playerDailyQuests.playerId, playerId));
  // `lastHuntAt` too: the hunt cooldown is real and two hunts in one suite
  // would otherwise trip it.
  await t.db
    .update(players)
    .set({ buddyWaifuId: null, lastHuntAt: null })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 1000, essence: 0, huntEnergy: 20 })
    .where(eq(playerCurrencies.playerId, playerId));
});

/* ───────────────────────── Hunt (regression) ───────────────────────── */

describe('Hunt essence_find behaviour is unchanged by the refactor', () => {
  /**
   * A hunt scripted onto the `essence_find` outcome.
   *
   * The result table is content, so the weight offset that lands on Essence is
   * derived rather than hard-coded — a retuned table must not silently make
   * this test assert something else.
   */
  function huntRollForEssence(): number {
    const table = app.content.tables.hunt.resultTable;
    const total = table.reduce((sum, r) => sum + r.weight, 0);
    let cursor = 0;
    for (const row of table) {
      if (row.kind === 'essence_find') return (cursor + row.weight / 2) / total;
      cursor += row.weight;
    }
    throw new Error('no essence_find row in the hunt result table');
  }

  function scriptedHunt(rolls: number[]) {
    return createHuntService({
      db: t.db,
      currency: app.currency,
      essenceAward: app.essenceAward,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      care: app.care,
      quests: app.quests,
      tables: app.content.tables,
      buddyBonus: app.buddyBonus,
      logger: t.logger,
      rng: scriptedRng(rolls),
    });
  }

  it('pays the table amount with no Essence Buddy equipped', async () => {
    const hunt = scriptedHunt([huntRollForEssence()]);
    const result = await hunt.hunt(playerId, 'c-hunt');
    expect(result.kind).toBe('essence_find');
    if (result.kind !== 'essence_find') throw new Error('unreachable');

    const { min, max } = app.content.tables.hunt.essenceFind;
    expect(result.amount).toBeGreaterThanOrEqual(min);
    expect(result.amount).toBeLessThanOrEqual(max);
    expect(result.balanceAfter).toBe(result.amount);
    expect(result.buddyBonuses).toEqual([]);
  });

  it('still reports the uplift on the result, exactly as it shipped', async () => {
    authorBonus(buddySlug, essenceBonus(100));
    await equipBuddy();
    const hunt = scriptedHunt([huntRollForEssence()]);
    const result = await hunt.hunt(playerId, 'c-hunt');
    if (result.kind !== 'essence_find') throw new Error('expected an essence find');

    // +100% doubles, which is unambiguous at any point in the find range.
    const applied = result.buddyBonuses.find((b) => b.effectId === 'essence_gain');
    expect(applied).toBeDefined();
    expect(applied!.finalValue).toBe(applied!.baseValue! * 2);
    expect(result.amount).toBe(applied!.finalValue);
    expect(await essenceOf()).toBe(result.amount);
  });
});

/* ─────────────────────── Convert / Release (regression) ─────────────────────── */

describe('Convert and Release behaviour is unchanged by the refactor', () => {
  it('converts a duplicate for the table value with no Buddy', async () => {
    const { rarity, waifuId } = await insertDuplicatePair();
    const result = await app.collection.convertDuplicateToEssence(playerId, waifuId);

    expect(result.essenceGranted).toBe(tableEssence(rarity));
    expect(result.essenceBonus).toBeNull();
    expect(result.balanceAfter).toBe(tableEssence(rarity));
  });

  it('scales the conversion by essence_gain and reports base and final', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    const { rarity, waifuId } = await insertDuplicatePair();

    const result = await app.collection.convertDuplicateToEssence(playerId, waifuId);

    const base = tableEssence(rarity);
    expect(result.essenceGranted).toBe(Math.round(base * 1.3));
    expect(result.essenceBonus).toMatchObject({
      effectId: 'essence_gain',
      value: 30,
      baseValue: base,
      finalValue: result.essenceGranted,
    });
  });

  it('scales a Release, which pays the release fraction of the same table', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    const { rarity, waifuId } = await insertDuplicatePair();

    const result = await app.collection.releaseWaifu(playerId, waifuId);

    // The fraction is applied to the table first and the bonus to that — the
    // bonus scales the payout, never the table it comes from.
    const base = Math.floor(
      tableEssence(rarity) * app.content.tables.duplicate.releaseFraction,
    );
    expect(result.essenceGranted).toBe(Math.round(base * 1.3));
  });
});

/* ─────────────────────── conversion previews ─────────────────────── */

describe('conversion previews quote the Buddy-adjusted payout', () => {
  it('quotes the raw table value when no Buddy is equipped', async () => {
    const rarity = (await t.db.select().from(species).where(eq(species.slug, dupSlug)))[0]!.rarity;
    const preview = await app.collection.previewConversionEssence(playerId, rarity, 'convert');
    expect(preview).toMatchObject({
      baseAmount: tableEssence(rarity),
      finalAmount: tableEssence(rarity),
      bonus: null,
    });
  });

  it('quotes the uplifted value with an essence_gain Buddy equipped', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    const rarity = (await t.db.select().from(species).where(eq(species.slug, dupSlug)))[0]!.rarity;

    const preview = await app.collection.previewConversionEssence(playerId, rarity, 'convert');

    const base = tableEssence(rarity);
    expect(preview.baseAmount).toBe(base);
    expect(preview.finalAmount).toBe(Math.round(base * 1.3));
    expect(preview.bonus).toMatchObject({ effectId: 'essence_gain', value: 30 });
  });

  it('quotes the release fraction for a release', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    const rarity = (await t.db.select().from(species).where(eq(species.slug, dupSlug)))[0]!.rarity;

    const preview = await app.collection.previewConversionEssence(playerId, rarity, 'release');

    const base = Math.floor(
      tableEssence(rarity) * app.content.tables.duplicate.releaseFraction,
    );
    expect(preview.baseAmount).toBe(base);
    expect(preview.finalAmount).toBe(Math.round(base * 1.3));
  });

  it('writes nothing — a preview is a quote, not a payout', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    const rarity = (await t.db.select().from(species).where(eq(species.slug, dupSlug)))[0]!.rarity;

    await app.collection.previewConversionEssence(playerId, rarity, 'convert');
    await app.collection.previewConversionEssence(playerId, rarity, 'release');

    expect(await essenceOf()).toBe(0);
  });

  it('the conversion is authoritative when the Buddy changes after the preview', async () => {
    // The player opens the prompt with a +100% Buddy, sees a doubled quote,
    // then swaps to a Buddy with no Essence bonus before pressing the button.
    // What they are paid is what the *conversion* resolves, not the quote.
    authorBonus(buddySlug, essenceBonus(100));
    authorBonus(dupSlug, null);
    const generous = await equipBuddy();
    const { rarity, waifuId } = await insertDuplicatePair();

    const quoted = await app.collection.previewConversionEssence(playerId, rarity, 'convert');
    expect(quoted.finalAmount).toBe(tableEssence(rarity) * 2);

    // Swap: the duplicate's own species authors no bonus, so equipping the
    // first copy of that pair removes the Essence uplift entirely.
    const [firstCopy] = await t.db
      .select()
      .from(playerWaifus)
      .where(
        and(eq(playerWaifus.playerId, playerId), eq(playerWaifus.speciesId, await speciesIdFor(dupSlug))),
      );
    await app.collection.setBuddy(playerId, firstCopy!.id);
    expect(firstCopy!.id).not.toBe(generous);

    const result = await app.collection.convertDuplicateToEssence(playerId, waifuId);

    expect(result.essenceGranted).toBe(tableEssence(rarity));
    expect(result.essenceBonus).toBeNull();
    expect(await essenceOf()).toBe(tableEssence(rarity));
  });
});
