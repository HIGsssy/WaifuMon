/**
 * `affection_gain` as a World Encounter effect — real Postgres, real services.
 *
 * The effect delegates its entire implementation to
 * `CollectionService.awardBuddyAffection`, so the interesting assertions are
 * about the *seam*, not the arithmetic:
 *
 *   - the award that lands is the domain's award, Buddy Bonus and all;
 *   - the reported base and final come off `BuddyAwardResult` rather than
 *     being recomputed anywhere downstream;
 *   - **no Buddy skips, it does not fail.** This is the deliberate inverse of
 *     the `buddy_affection_gain` item, where no Buddy refuses the whole use.
 *     An encounter has already been resolved by the time effects run, so
 *     rolling it back would turn a missing pointer into a lost reward.
 *
 * That last one is the reason this file exists. Everything else is a
 * regression net around a delegation that is easy to "optimise" into a direct
 * column write later.
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

/**
 * Each definition gets a fresh slug rather than reusing one.
 *
 * A resolved encounter leaves a `world_encounter_history` row pointing at it,
 * so deleting and recreating the same slug between tests trips the foreign
 * key. Minting a new one per definition is cheaper than teaching the fixture
 * to unwind an audit trail — and an audit trail that resists deletion is the
 * table behaving correctly.
 */
let slugCounter = 0;
const nextSlug = (prefix = 'tv_test_kind_word'): string => `${prefix}_${++slugCounter}`;

const alwaysRng = { next: () => 0, intInclusive: (a: number) => a };
const neverRng = { next: () => 0.999999, intInclusive: (a: number) => a };

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-we-affection', 'u-1'));
  buddySlug = app.content.species.find((s) => s.enabled)!.slug;
});
afterAll(async () => {
  await t.cleanup();
});

/** Define an encounter with one auto-resolving choice carrying `effects`. */
async function defineEncounter(
  successEffects: Effect[],
  failureEffects: Effect[] = [],
  check: Record<string, unknown> = { type: 'none' },
): Promise<{ encounterId: number; choiceId: number; slug: string }> {
  const slug = nextSlug();
  const [encounter] = await t.db
    .insert(worldEncounters)
    .values({
      slug,
      name: 'A Kind Word',
      description: 'Someone says something nice.',
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
      label: 'Listen',
      checkJson: check,
      successEffectsJson: successEffects as unknown as Record<string, unknown>[],
      failureEffectsJson: failureEffects as unknown as Record<string, unknown>[],
    })
    .returning();
  return { encounterId: encounter!.id, choiceId: choice!.id, slug };
}

/** An active row for that encounter, ready to resolve. */
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
      channelId: 'c-we-affection',
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

async function equipBuddy(affection = 0): Promise<number> {
  const [row] = await t.db.select().from(species).where(eq(species.slug, buddySlug));
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: row!.id, affection });
  await app.collection.setBuddy(playerId, waifu.id);
  return waifu.id;
}

const affectionOf = async (waifuId: number): Promise<number> => {
  const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
  return row!.affection;
};
const balances = () => app.currency.getBalances(playerId);

beforeEach(async () => {
  restoreBonuses();
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 1000, essence: 100, huntEnergy: 20 })
    .where(eq(playerCurrencies.playerId, playerId));
});

describe('granting affection', () => {
  it('awards the configured flat amount to the active buddy', async () => {
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 25 },
    ]);
    const buddyId = await equipBuddy();
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    expect(await affectionOf(buddyId)).toBe(25);
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'affection_gain');
    expect(entry).toMatchObject({ applied: true, amount: 25 });
  });

  it('increments existing affection rather than replacing it', async () => {
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 25 },
    ]);
    const buddyId = await equipBuddy(300);
    const activeId = await activate(encounterId);

    await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    expect(await affectionOf(buddyId)).toBe(325);
  });

  it('reports the recipient, the base, the final and the resulting total', async () => {
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 25 },
    ]);
    const buddyId = await equipBuddy(10);
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'affection_gain');

    expect(entry!.affection).toMatchObject({
      waifuId: buddyId,
      baseAmount: 25,
      finalAmount: 25,
      affectionAfter: 35,
      bonus: null,
    });
    expect(entry!.affection!.waifuName).toBeTruthy();
  });

  it('uses the copy’s nickname when she has one', async () => {
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 25 },
    ]);
    const buddyId = await equipBuddy();
    await t.db
      .update(playerWaifus)
      .set({ nickname: 'Pip' })
      .where(eq(playerWaifus.id, buddyId));
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'affection_gain');
    expect(entry!.affection!.waifuName).toBe('Pip');
  });
});

describe('the affection_gain Buddy Bonus applies', () => {
  it('scales the encounter award, and the values come from the domain', async () => {
    // The worked example: 25 base, +20%, 30 final. The multiply happens inside
    // `awardBuddyAffection`; the effect handler and the presenter only read.
    authorBonus(buddySlug, {
      name: 'Open Heart',
      flavorText: '+20% Affection gained.',
      effectId: 'affection_gain',
      value: 20,
    });
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 25 },
    ]);
    const buddyId = await equipBuddy();
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'affection_gain');

    expect(await affectionOf(buddyId)).toBe(30);
    expect(entry!.amount).toBe(30);
    expect(entry!.affection).toMatchObject({ baseAmount: 25, finalAmount: 30 });
    expect(entry!.affection!.bonus).toMatchObject({
      name: 'Open Heart',
      effectId: 'affection_gain',
      value: 20,
      baseValue: 25,
      finalValue: 30,
    });
  });

  it('matches the shared rounding rather than flooring the remainder away', async () => {
    // `applyPercentModifierInt` rounds — the same behaviour the hunt award and
    // the consumable get, because it is the same function.
    authorBonus(buddySlug, {
      name: 'Soft Word',
      flavorText: '+10% Affection gained.',
      effectId: 'affection_gain',
      value: 10,
    });
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 5 },
    ]);
    const buddyId = await equipBuddy();
    const activeId = await activate(encounterId);

    await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    expect(await affectionOf(buddyId)).toBe(6); // 5.5 → 6
  });

  it('leaves the bonus unreported when it changed nothing', async () => {
    authorBonus(buddySlug, {
      name: 'Training Montage',
      flavorText: '+100% Buddy XP.',
      effectId: 'buddy_xp_gain',
      value: 100,
    });
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 25 },
    ]);
    await equipBuddy();
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'affection_gain');
    expect(entry!.affection!.bonus).toBeNull();
    expect(entry!.affection!.finalAmount).toBe(25);
  });
});

describe('no active buddy skips without failing', () => {
  it('resolves the encounter successfully and records the skip', async () => {
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 25 },
    ]);
    // No buddy equipped.
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    // The encounter is a normal, successful resolution — not an error, not a
    // rollback. The effect is still listed, so the audit trail shows it fired
    // and why it paid nothing.
    expect(resolution.check.success).toBe(true);
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'affection_gain');
    expect(entry).toMatchObject({ applied: false, amount: 0, reason: 'no_buddy' });
    expect(entry!.affection).toBeUndefined();
  });

  it('still applies every other effect on the same choice', async () => {
    // The requirement that motivated the skip-don't-fail rule: a missing
    // pointer must not cost the player the Waifubux and Essence they earned.
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'waifubux_gain', amount: 100 },
      { type: 'affection_gain', amount: 25 },
      { type: 'essence_gain', amount: 5 },
    ]);
    const before = await balances();
    const activeId = await activate(encounterId);

    await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    const after = await balances();
    expect(after.waifubux).toBe(before.waifubux + 100);
    expect(after.essence).toBe(before.essence + 5);
  });

  it('skips when the buddy pointer aims at a released copy', async () => {
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 25 },
    ]);
    const buddyId = await equipBuddy();
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, buddyId));
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });
    const entry = resolution.effectsApplied.find((e) => e.effect.type === 'affection_gain');
    expect(entry).toMatchObject({ applied: false, reason: 'no_buddy' });
    expect(await affectionOf(buddyId)).toBe(0);
  });
});

describe('failure branches and chains', () => {
  it('awards affection from a failureEffects list too', async () => {
    // The effect system is generic over both branches, so a consolation
    // Affection award is authorable and must actually pay.
    const { encounterId, choiceId } = await defineEncounter(
      [{ type: 'affection_gain', amount: 25 }],
      [{ type: 'affection_gain', amount: 5 }],
      { type: 'sp', difficulty: 99 },
    );
    const buddyId = await equipBuddy();
    const activeId = await activate(encounterId);

    const resolution = await app.worldEncounter.resolveChoice({
      activeId,
      playerId,
      choiceId,
      rng: neverRng,
    });

    expect(resolution.check.success).toBe(false);
    expect(await affectionOf(buddyId)).toBe(5);
  });

  it('pays each node of a chain independently', async () => {
    // A chained continuation is its own resolution with its own effect list,
    // so two nodes each carrying the effect award twice — once per screen the
    // player actually acted on, which is the intended behaviour.
    const child = await defineEncounter([{ type: 'affection_gain', amount: 7 }]);

    // A second encounter that chains into the first.
    const [parent] = await t.db
      .insert(worldEncounters)
      .values({
        slug: nextSlug('tv_test_parent'),
        name: 'Parent',
        description: 'Leads somewhere.',
        type: 'decision',
        rarity: 'common',
        weight: 10,
        lifecycle: 'active',
        huntEligible: true,
        travelEligible: true,
        cooldownSeconds: 0,
        choicesRequired: true,
        chainedEncounterSlug: child.slug,
      })
      .returning();
    const [parentChoice] = await t.db
      .insert(worldEncounterChoices)
      .values({
        encounterId: parent!.id,
        sortOrder: 0,
        label: 'Go on',
        checkJson: { type: 'none' },
        successEffectsJson: [{ type: 'affection_gain', amount: 3 }] as unknown as Record<
          string,
          unknown
        >[],
        failureEffectsJson: [],
      })
      .returning();

    const buddyId = await equipBuddy();
    const parentActive = await activate(parent!.id);
    const first = await app.worldEncounter.resolveChoice({
      activeId: parentActive,
      playerId,
      choiceId: parentChoice!.id,
      rng: alwaysRng,
    });
    expect(await affectionOf(buddyId)).toBe(3);
    expect(first.continuationActiveId).not.toBeNull();

    const cont = await app.worldEncounter.getActivationById(first.continuationActiveId!, playerId);
    await app.worldEncounter.resolveChoice({
      activeId: first.continuationActiveId!,
      playerId,
      choiceId: cont!.choiceViews[0]!.choice.id,
      rng: alwaysRng,
    });
    expect(await affectionOf(buddyId)).toBe(3 + 7);
  });
});

describe('the effect costs nothing', () => {
  it('consumes no Hunt Energy and no currency of its own', async () => {
    // It is a reward effect, like buddy XP or Essence. Nothing about applying
    // it should touch Energy, and nothing about it enters or exits Care Mode.
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 25 },
    ]);
    await equipBuddy();
    const before = await balances();
    const activeId = await activate(encounterId);

    await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    const after = await balances();
    expect(after.huntEnergy).toBe(before.huntEnergy);
    expect(after.waifubux).toBe(before.waifubux);
    expect(after.essence).toBe(before.essence);
  });

  it('does not start or stop Care Mode', async () => {
    const { encounterId, choiceId } = await defineEncounter([
      { type: 'affection_gain', amount: 25 },
    ]);
    const buddyId = await equipBuddy();
    await app.care.start(playerId, buddyId);
    const activeId = await activate(encounterId);

    await app.worldEncounter.resolveChoice({ activeId, playerId, choiceId });

    // Still resting afterwards: the award is orthogonal to the care session.
    expect((await app.care.getState(playerId)).active).toBe(true);
    await app.care.leave(playerId);
  });
});
