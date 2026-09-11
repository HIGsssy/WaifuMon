/**
 * `buddy_xp_gain` and the active-Buddy XP award path.
 *
 * The audit's second finding: a World Encounter `buddy_xp` effect paid the
 * *live* Buddy — exactly the population `buddy_xp_gain` is documented over —
 * but routed through `CollectionService.awardWaifuXp`, which is deliberately
 * bonus-free. `awardBuddyXp` is the seam that fixes it.
 *
 * The two methods must stay distinguishable, and most of this file is about
 * that boundary rather than about the arithmetic:
 *
 *   - `awardBuddyXp` asks *who is the Buddy* and applies the bonus;
 *   - `awardWaifuXp` names a copy and applies nothing, because a Boss
 *     Encounter uses it to pay a snapshotted participant whose payout
 *     `boss_reward_gain` has already scaled. Bonusing it would double-dip.
 *
 * Care Mode keeps its own multiply and is asserted unchanged here: its
 * condition is genuinely different (it pays whichever copy is being cared for,
 * and applies `buddy_xp_gain` only when that copy *is* the Buddy), so folding
 * it into `awardBuddyXp` would distort the semantics rather than share them.
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
const nextSlug = (): string => `buddy_xp_test_${++slugCounter}`;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-buddy-xp', 'u-1'));
  buddySlug = app.content.species.find((s) => s.enabled)!.slug;
});
afterAll(async () => {
  await t.cleanup();
});

/* ───────────────────────────── helpers ───────────────────────────── */

async function defineEncounter(
  successEffects: Effect[],
): Promise<{ encounterId: number; choiceId: number }> {
  const [encounter] = await t.db
    .insert(worldEncounters)
    .values({
      slug: nextSlug(),
      name: 'A Sparring Partner',
      description: 'She wants to practise.',
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
      label: 'Spar',
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
      channelId: 'c-buddy-xp',
      contextJson: {},
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .returning();
  return row!.id;
}

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

const xpBonus = (value: number, name = 'Star Charts'): BuddyBonus => ({
  name,
  flavorText: `${name}: +${value}% XP gained by the active Buddy.`,
  effectId: 'buddy_xp_gain',
  value,
});

async function equipBuddy(): Promise<number> {
  const [row] = await t.db.select().from(species).where(eq(species.slug, buddySlug));
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: row!.id });
  await app.collection.setBuddy(playerId, waifu.id);
  return waifu.id;
}

const xpOf = async (waifuId: number): Promise<number> => {
  const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
  return row!.xp;
};

beforeEach(async () => {
  restoreBonuses();
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db
    .update(players)
    .set({
      buddyWaifuId: null,
      careModeStartedAt: null,
      careModeLastTickAt: null,
      careModeWaifuId: null,
    })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 1000, essence: 100, huntEnergy: 20 })
    .where(eq(playerCurrencies.playerId, playerId));
});

/* ─────────────────── CollectionService.awardBuddyXp ─────────────────── */

describe('CollectionService.awardBuddyXp', () => {
  it('grants the base amount unchanged with no buddy_xp_gain bonus', async () => {
    const buddyId = await equipBuddy();
    const result = await t.db.transaction((tx) => app.collection.awardBuddyXp(tx, playerId, 40));

    expect(result!.xpGranted).toBe(40);
    expect(result!.xpBonus).toBeNull();
    expect(await xpOf(buddyId)).toBe(40);
  });

  it('applies buddy_xp_gain: 40 at +25% is 50', async () => {
    authorBonus(buddySlug, xpBonus(25));
    const buddyId = await equipBuddy();

    const result = await t.db.transaction((tx) => app.collection.awardBuddyXp(tx, playerId, 40));

    expect(result!.xpGranted).toBe(50);
    expect(result!.xpBonus).toMatchObject({
      effectId: 'buddy_xp_gain',
      value: 25,
      baseValue: 40,
      finalValue: 50,
    });
    expect(await xpOf(buddyId)).toBe(50);
  });

  it('returns null when no Buddy is equipped, writing nothing', async () => {
    const result = await t.db.transaction((tx) => app.collection.awardBuddyXp(tx, playerId, 40));
    expect(result).toBeNull();
  });

  it('treats 0 as a legal no-op', async () => {
    await equipBuddy();
    const result = await t.db.transaction((tx) => app.collection.awardBuddyXp(tx, playerId, 0));
    expect(result).toBeNull();
  });

  it('ignores an unrelated effect on the equipped Buddy', async () => {
    authorBonus(buddySlug, {
      name: 'Extra Serving',
      flavorText: '+30% Essence gained.',
      effectId: 'essence_gain',
      value: 30,
    });
    await equipBuddy();
    const result = await t.db.transaction((tx) => app.collection.awardBuddyXp(tx, playerId, 40));
    expect(result!.xpGranted).toBe(40);
    expect(result!.xpBonus).toBeNull();
  });

  it('leaves Affection alone — this is an XP award and nothing else', async () => {
    authorBonus(buddySlug, xpBonus(25));
    const buddyId = await equipBuddy();
    const result = await t.db.transaction((tx) => app.collection.awardBuddyXp(tx, playerId, 40));

    expect(result!.affectionGranted).toBe(0);
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, buddyId));
    expect(row!.affection).toBe(0);
  });
});

/* ───────────── awardWaifuXp stays deliberately bonus-free ───────────── */

describe('CollectionService.awardWaifuXp is not bonused', () => {
  it('pays a named copy exactly, even when she is the Buddy and grants the bonus', async () => {
    // The critical negative. This method is how a Boss Encounter pays a
    // *snapshotted* participant, whose payout `boss_reward_gain` has already
    // scaled — applying `buddy_xp_gain` on top would double-dip.
    authorBonus(buddySlug, xpBonus(25));
    const buddyId = await equipBuddy();

    const result = await t.db.transaction((tx) =>
      app.collection.awardWaifuXp(tx, playerId, buddyId, 40),
    );

    expect(result!.xpGranted).toBe(40);
    expect(result!.xpBonus).toBeNull();
    expect(await xpOf(buddyId)).toBe(40);
  });
});

/* ─────────────────── Care Mode keeps its own semantics ─────────────────── */

describe('Care Mode buddy_xp_gain is unchanged', () => {
  const MINUTE = 60_000;

  /**
   * Care applies `buddy_xp_gain` only when the copy being cared for **is** the
   * equipped Buddy. That condition has no analogue in `awardBuddyXp`, which
   * pays the Buddy by definition, so Care deliberately keeps its own multiply
   * rather than being folded into the shared path — consolidating it would
   * have to smuggle "and only if the target happens to be her" into a method
   * whose entire contract is "pay the Buddy".
   *
   * Both directions are asserted below, because it is the *pair* that defines
   * the rule; either alone would pass under a wrong implementation.
   *
   * `careOnce` deliberately does not assert a hard-coded tick count — Care's
   * tick model is content-tuned, and the claim is about the *ratio* between a
   * bonused and an unbonused session, which stays true however many ticks a
   * session is worth.
   */
  async function careOnce(
    targetId: number,
    day: string,
  ): Promise<{ xp: number; bonus: unknown }> {
    const interval = app.content.tables.energy.careMode.intervalMinutes * MINUTE;
    const start = new Date(`${day}T00:00:00Z`);
    await app.care.start(playerId, targetId, start);
    const summary = await app.care.applyPending(playerId, new Date(start.getTime() + interval));
    await app.care.leave(playerId, new Date(start.getTime() + interval));
    return { xp: summary.waifuXpGained, bonus: summary.xpBonus };
  }

  it('applies when the Care target is the active Buddy', async () => {
    const buddyId = await equipBuddy();
    const plain = await careOnce(buddyId, '2030-03-01');
    expect(plain.xp).toBeGreaterThan(0);
    expect(plain.bonus).toBeNull();

    authorBonus(buddySlug, xpBonus(100));
    const boosted = await careOnce(buddyId, '2030-03-02');

    expect(boosted.xp).toBe(plain.xp * 2);
    expect(boosted.bonus).toMatchObject({ effectId: 'buddy_xp_gain', value: 100 });
  });

  it('does not apply when the Care target is a different copy', async () => {
    authorBonus(buddySlug, xpBonus(100));
    await equipBuddy();
    // A second copy of the same species, cared for instead of the Buddy.
    const [row] = await t.db.select().from(species).where(eq(species.slug, buddySlug));
    const other = await insertOwnedWaifu(t.db, { playerId, speciesId: row!.id });

    const cared = await careOnce(other.id, '2030-03-03');

    // She earns the plain rate: the effect is XP awarded to the *Buddy*, and
    // this copy is not her — even though the Buddy granting it is equipped the
    // whole time. (`affection_gain` is the deliberate mirror case and *would*
    // apply here; see `buddyBonus.test.ts`.)
    //
    // Compared against the same session run without the bonus rather than a
    // hard-coded tick count, so a retuned Care interval cannot turn this into
    // an assertion about something else.
    restoreBonuses();
    const baseline = await careOnce(other.id, '2030-03-04');
    expect(cared.xp).toBe(baseline.xp);
    expect(cared.bonus).toBeNull();
  });
});

/* ─────────────────────── World Encounters ─────────────────────── */

describe('World Encounter buddy_xp', () => {
  it('pays 40 as 50 with a +25% Buddy, and reports base, final and bonus', async () => {
    authorBonus(buddySlug, xpBonus(25));
    const buddyId = await equipBuddy();
    const { encounterId, choiceId } = await defineEncounter([{ type: 'buddy_xp', amount: 40 }]);
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    expect(await xpOf(buddyId)).toBe(50);
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'buddy_xp');
    expect(entry).toMatchObject({ applied: true, amount: 50 });
    expect(entry!.buddyXp).toMatchObject({
      waifuId: buddyId,
      baseAmount: 40,
      finalAmount: 50,
    });
    expect(entry!.buddyXp!.bonus).toMatchObject({ effectId: 'buddy_xp_gain', value: 25 });
    expect(entry!.buddyXp!.waifuName).toBeTruthy();
  });

  it('pays 40 as 40 with no bonus, and reports no uplift', async () => {
    const buddyId = await equipBuddy();
    const { encounterId, choiceId } = await defineEncounter([{ type: 'buddy_xp', amount: 40 }]);
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    expect(await xpOf(buddyId)).toBe(40);
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'buddy_xp');
    expect(entry!.buddyXp).toMatchObject({ baseAmount: 40, finalAmount: 40, bonus: null });
  });

  it('uses the copy’s nickname when she has one', async () => {
    authorBonus(buddySlug, xpBonus(25));
    const buddyId = await equipBuddy();
    await t.db.update(playerWaifus).set({ nickname: 'Pip' }).where(eq(playerWaifus.id, buddyId));
    const { encounterId, choiceId } = await defineEncounter([{ type: 'buddy_xp', amount: 40 }]);
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'buddy_xp');
    expect(entry!.buddyXp!.waifuName).toBe('Pip');
  });

  it('skips without failing when there is no Buddy — unchanged behaviour', async () => {
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'buddy_xp', amount: 40 },
      { type: 'waifubux_gain', amount: 100 },
    ]);
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'buddy_xp');
    expect(entry).toMatchObject({ applied: false, amount: 0, reason: 'no_buddy_or_zero' });
    // The rest of the choice still paid: a missing Buddy must not roll back an
    // encounter the player already resolved.
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(1100);
  });

  it('persists base, final and bonus onto the history row', async () => {
    authorBonus(buddySlug, xpBonus(25));
    await equipBuddy();
    const { encounterId, choiceId } = await defineEncounter([{ type: 'buddy_xp', amount: 40 }]);
    const activeId = await activate(encounterId);
    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'buddy_xp');
    expect(entry!.buddyXp).toMatchObject({
      baseAmount: 40,
      finalAmount: 50,
      bonus: { value: 25 },
    });
  });
});
