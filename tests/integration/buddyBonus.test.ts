/**
 * Buddy Bonuses end to end — real Postgres, real seeding, real content.
 *
 * Every case authors its bonus onto a shipped species **at runtime**, which is
 * exactly what shipping a new species JSON file does: nothing in `src/` names
 * a slug, so a test that passes here is evidence the system is content-driven
 * rather than evidence that one Waifumon was wired up by hand.
 *
 * Two things are neutralized so the only quantity moving is the bonus under
 * test: the buddy species is forced onto the neutral `switch` affinity (so the
 * Milestone 5D affinity term stays 0), and any bonus the shipped corpus
 * already authors on a species a case borrows is cleared first.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bossEncounters,
  bossParticipations,
  encounters,
  guildBossState,
  playerCurrencies,
  playerInventory,
  playerWaifus,
  players,
  species,
  type BossEncounterRow,
  type EncounterRow,
  type SpeciesRow,
} from '../../src/db/schema';
import { createHuntService } from '../../src/modules/hunt/huntService';
import { resolveRace } from '../../src/modules/cards/race';
import type { BuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import type { Rng } from '../../src/shared/random';
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
let guildDbId: number;
let playerId: number;

const CHANNEL = 'c-buddy-bonus';
const IDENTITY = { discordUserId: 'u-1', trainerName: 'Whistler' };
const MINUTE = 60_000;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ guildDbId, playerId } = await provisionPlayer(app, 'g-buddy-bonus', 'u-1'));
});

afterAll(async () => {
  await t.cleanup();
});

/** Every species the shipped corpus authors a bonus on, remembered once. */
const shippedBonuses = new Map<string, BuddyBonus | undefined>();

beforeEach(async () => {
  await t.db.delete(bossParticipations);
  await t.db.delete(bossEncounters);
  await t.db.delete(guildBossState);
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db
    .update(players)
    .set({ level: 1, xp: 0, lastHuntAt: null, careModeStartedAt: null, careModeLastTickAt: null, careModeWaifuId: null })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: 25, waifubux: 0, essence: 0 })
    .where(eq(playerCurrencies.playerId, playerId));
  // Undo any bonus a previous test authored, so cases stay order-independent.
  for (const [slug, original] of shippedBonuses) {
    const entry = app.content.species.find((s) => s.slug === slug)!;
    if (original) entry.buddyBonus = original;
    else delete entry.buddyBonus;
  }
  shippedBonuses.clear();
});

/**
 * Author a Buddy Bonus onto a species in the live content snapshot — the same
 * thing editing its JSON file and reloading content does.
 */
function authorBonus(slug: string, bonus: BuddyBonus | null): void {
  const entry = app.content.species.find((s) => s.slug === slug);
  if (!entry) throw new Error(`no such species in content: ${slug}`);
  if (!shippedBonuses.has(slug)) shippedBonuses.set(slug, entry.buddyBonus);
  if (bonus) entry.buddyBonus = bonus;
  else delete entry.buddyBonus;
}

async function speciesBySlug(slug: string): Promise<SpeciesRow> {
  const [row] = await t.db.select().from(species).where(eq(species.slug, slug));
  if (!row) throw new Error(`missing seeded species ${slug}`);
  return row;
}

/** Any enabled species of a given rarity that is not the buddy. */
function contentSlugOf(predicate: (s: (typeof app.content.species)[number]) => boolean): string {
  const found = app.content.species.find((s) => s.enabled && predicate(s));
  if (!found) throw new Error('no species in the content set matches the test predicate');
  return found.slug;
}

/** An owned copy of `slug`, equipped as the active buddy. */
async function giveBuddy(slug: string, level = 5): Promise<number> {
  const s = await speciesBySlug(slug);
  const row = await insertOwnedWaifu(t.db, { playerId, speciesId: s.id, level, xp: 0 });
  await app.collection.setBuddy(playerId, row.id);
  return row.id;
}

async function createEncounter(slug: string): Promise<EncounterRow> {
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
  const s = await speciesBySlug(slug);
  const [row] = await t.db
    .insert(encounters)
    .values({
      playerId,
      speciesId: s.id,
      channelId: CHANNEL,
      state: 'active',
      attemptCount: 0,
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  return row!;
}

async function energy(): Promise<number> {
  return (await app.currency.getBalances(playerId)).huntEnergy;
}

function huntWith(rng: Rng) {
  return createHuntService({
    db: t.db,
    currency: app.currency,
    inventory: app.inventory,
    progression: app.progression,
    collection: app.collection,
    care: app.care,
    quests: app.quests,
    tables: app.content.tables,
    buddyBonus: app.buddyBonus,
    logger: t.logger,
    rng,
  });
}

const captureBonus = (over: Partial<BuddyBonus>): BuddyBonus => ({
  name: 'Test Bonus',
  flavorText: 'Display only.',
  effectId: 'capture_chance',
  value: 10,
  ...over,
});

// ── capture_chance ──────────────────────────────────────────────────────────

describe('capture_chance', () => {
  /** An N-rarity species to meet, and a species to carry the bonus. */
  let buddySlug: string;
  let targetSlug: string;

  beforeAll(() => {
    buddySlug = contentSlugOf((s) => s.rarity === 'N');
    targetSlug = contentSlugOf((s) => s.rarity === 'N' && s.slug !== buddySlug);
  });

  beforeEach(async () => {
    // A `switch` buddy is always a neutral matchup, so equipping her adds no
    // affinity term and the before/after comparison isolates the Buddy Bonus.
    await t.db.update(species).set({ affinity: 'switch' }).where(eq(species.slug, buddySlug));
    await t.db.update(species).set({ affinity: 'switch' }).where(eq(species.slug, targetSlug));
    // Whatever the corpus ships on these two is irrelevant to what is tested.
    authorBonus(buddySlug, null);
    authorBonus(targetSlug, null);
  });

  async function quotedChance(): Promise<number> {
    const enc = await createEncounter(targetSlug);
    return (await app.capture.quoteCapture(playerId, enc.id, null)).chance;
  }

  it('applies to every species when the bonus has no target', async () => {
    const before = await quotedChance();
    authorBonus(buddySlug, captureBonus({ value: 10 }));
    await giveBuddy(buddySlug);
    const after = await quotedChance();
    expect(after).toBeCloseTo(before * 1.1, 6);
  });

  it('does nothing at all when no buddy is equipped', async () => {
    const before = await quotedChance();
    authorBonus(buddySlug, captureBonus({ value: 50 }));
    // The copy exists but is not equipped — a bonus is granted by the Buddy
    // slot, not by ownership.
    const s = await speciesBySlug(buddySlug);
    await insertOwnedWaifu(t.db, { playerId, speciesId: s.id });
    expect(await quotedChance()).toBeCloseTo(before, 10);
  });

  it('applies a race-targeted bonus only to that race', async () => {
    const target = app.content.species.find((s) => s.slug === targetSlug)!;
    const race = resolveRace({ slug: target.slug, race: target.race ?? null, archetype: target.archetype });
    const otherRace = race === 'human' ? 'angel' : 'human';

    authorBonus(buddySlug, captureBonus({ value: 20, target: { type: 'race', value: race } }));
    await giveBuddy(buddySlug);
    const matched = await quotedChance();

    authorBonus(buddySlug, captureBonus({ value: 20, target: { type: 'race', value: otherRace } }));
    const missed = await quotedChance();

    expect(matched).toBeCloseTo(missed * 1.2, 6);
  });

  it('applies an affinity-targeted bonus only to that affinity', async () => {
    await t.db.update(species).set({ affinity: 'primal' }).where(eq(species.slug, targetSlug));
    try {
      authorBonus(
        buddySlug,
        captureBonus({ value: 20, target: { type: 'affinity', value: 'primal' } }),
      );
      await giveBuddy(buddySlug);
      const matched = await quotedChance();

      authorBonus(
        buddySlug,
        captureBonus({ value: 20, target: { type: 'affinity', value: 'caregiver' } }),
      );
      const missed = await quotedChance();
      expect(matched).toBeCloseTo(missed * 1.2, 6);
    } finally {
      await t.db.update(species).set({ affinity: 'switch' }).where(eq(species.slug, targetSlug));
    }
  });

  it('matches rarity_min and rarity_max on the encountered rarity', async () => {
    const rareSlug = contentSlugOf((s) => s.rarity === 'SSR');
    authorBonus(
      buddySlug,
      captureBonus({ value: 20, target: { type: 'rarity_min', value: 'SSR' } }),
    );
    await giveBuddy(buddySlug);

    const commonEnc = await createEncounter(targetSlug); // N
    const rareEnc = await createEncounter(rareSlug); // SSR
    expect((await app.capture.quoteCapture(playerId, commonEnc.id, null)).buddyBonusPercent).toBe(0);
    expect((await app.capture.quoteCapture(playerId, rareEnc.id, null)).buddyBonusPercent).toBe(20);

    authorBonus(
      buddySlug,
      captureBonus({ value: 20, target: { type: 'rarity_max', value: 'SR' } }),
    );
    const commonAgain = await createEncounter(targetSlug);
    const rareAgain = await createEncounter(rareSlug);
    expect((await app.capture.quoteCapture(playerId, commonAgain.id, null)).buddyBonusPercent).toBe(20);
    expect((await app.capture.quoteCapture(playerId, rareAgain.id, null)).buddyBonusPercent).toBe(0);
  });

  it('matches ownership in both directions', async () => {
    authorBonus(
      buddySlug,
      captureBonus({ value: 25, target: { type: 'ownership', value: 'unowned' } }),
    );
    await giveBuddy(buddySlug);

    const unowned = await createEncounter(targetSlug);
    expect((await app.capture.quoteCapture(playerId, unowned.id, null)).buddyBonusPercent).toBe(25);

    // Now own her, and the same bonus stops applying.
    const target = await speciesBySlug(targetSlug);
    await insertOwnedWaifu(t.db, { playerId, speciesId: target.id });
    const owned = await createEncounter(targetSlug);
    expect((await app.capture.quoteCapture(playerId, owned.id, null)).buddyBonusPercent).toBe(0);

    authorBonus(
      buddySlug,
      captureBonus({ value: 25, target: { type: 'ownership', value: 'owned' } }),
    );
    const ownedNow = await createEncounter(targetSlug);
    expect((await app.capture.quoteCapture(playerId, ownedNow.id, null)).buddyBonusPercent).toBe(25);
  });
});

// ── hunt ────────────────────────────────────────────────────────────────────

describe('energy_save_chance', () => {
  it('runs the hunt without spending Energy when it procs', async () => {
    const slug = contentSlugOf((s) => s.rarity === 'N');
    authorBonus(slug, {
      name: 'Free Round',
      flavorText: 'No Energy spent.',
      effectId: 'energy_save_chance',
      value: 100,
    });
    await giveBuddy(slug);
    const before = await energy();
    const result = await app.hunt.hunt(playerId, CHANNEL, new Date());
    expect(result.energySaved).toBe(true);
    expect(await energy()).toBe(before);
    expect(result.energyRemaining).toBe(before);
  });

  it('spends Energy as usual at 0%, and with no buddy at all', async () => {
    const slug = contentSlugOf((s) => s.rarity === 'N');
    authorBonus(slug, {
      name: 'Free Round',
      flavorText: 'No Energy spent.',
      effectId: 'energy_save_chance',
      value: 0,
    });
    await giveBuddy(slug);
    const before = await energy();
    const result = await app.hunt.hunt(playerId, CHANNEL, new Date());
    expect(result.energySaved).toBe(false);
    expect(await energy()).toBe(before - 1);

    await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
    const noBuddy = await app.hunt.hunt(playerId, CHANNEL, new Date(Date.now() + 10_000));
    expect(noBuddy.energySaved).toBe(false);
    expect(await energy()).toBe(before - 2);
  });
});

describe('hunt_item_find_chance', () => {
  /**
   * The result table is `encounter 70 / item_find 12 / waifubux 8 / essence 5 /
   * rare_item 3 / flavor 2` (total 100). A draw of 0.60 lands in the encounter
   * band. Doubling the two item weights makes the total 118 and pushes the same
   * draw into the item band — which is the whole claim: the existing table is
   * reweighted, not supplemented with a second roll.
   *
   * The first scripted value is the `energy_save_chance` proc, which is rolled
   * on every hunt whether or not a bonus can use it.
   */
  it('reweights the shipped result table rather than adding a second roll', async () => {
    const slug = contentSlugOf((s) => s.rarity === 'N');
    authorBonus(slug, null);
    await giveBuddy(slug);

    const baseline = await huntWith(scriptedRng([0.99, 0.6, 0.3, 0.3])).hunt(
      playerId,
      CHANNEL,
      new Date(),
    );
    expect(baseline.kind).toBe('encounter');

    authorBonus(slug, {
      name: 'Sticky Fingers',
      flavorText: '+100% chance to find items.',
      effectId: 'hunt_item_find_chance',
      value: 100,
    });
    await t.db
      .update(encounters)
      .set({ state: 'expired', resolvedAt: new Date() })
      .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
    const boosted = await huntWith(scriptedRng([0.99, 0.6, 0.1])).hunt(
      playerId,
      CHANNEL,
      new Date(Date.now() + 60_000),
    );
    expect(boosted.kind).toBe('item_find');
  });
});

describe('encounter_weight', () => {
  /**
   * The rarity table is `N 60 / R 25 / SR 10 / SSR 4 / UR 0.9 / LR 0.1`. A draw
   * of 0.92 lands in the SR band. Doubling every rarity at SSR-or-better makes
   * the total 105 and moves the same draw into the SSR band — a *relative*
   * weight change, with nothing added to or removed from the pool.
   */
  it('scales the encounter weight of a targeted rarity, relatively', async () => {
    const slug = contentSlugOf((s) => s.rarity === 'N');
    authorBonus(slug, null);
    await giveBuddy(slug);

    const baseline = await huntWith(scriptedRng([0.99, 0.1, 0.92, 0.5])).hunt(
      playerId,
      CHANNEL,
      new Date(),
    );
    expect(baseline.kind).toBe('encounter');
    if (baseline.kind !== 'encounter') return;
    expect(baseline.species.rarity).toBe('SR');

    authorBonus(slug, {
      name: 'Rare Sense',
      flavorText: '+100% encounter weight for SSR and above.',
      effectId: 'encounter_weight',
      value: 100,
      target: { type: 'rarity_min', value: 'SSR' },
    });
    await t.db
      .update(encounters)
      .set({ state: 'expired', resolvedAt: new Date() })
      .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
    const boosted = await huntWith(scriptedRng([0.99, 0.1, 0.92, 0.5])).hunt(
      playerId,
      CHANNEL,
      new Date(Date.now() + 60_000),
    );
    expect(boosted.kind).toBe('encounter');
    if (boosted.kind !== 'encounter') return;
    expect(boosted.species.rarity).toBe('SSR');
  });
});

// ── awards ──────────────────────────────────────────────────────────────────

describe('care_energy_gain', () => {
  it('doubles the Energy a Care Mode tick recovers at +100%', async () => {
    const slug = contentSlugOf((s) => s.rarity === 'N');
    authorBonus(slug, null);
    const waifuId = await giveBuddy(slug);
    const interval = app.content.tables.energy.careMode.intervalMinutes * MINUTE;
    const perTick = app.content.tables.energy.careMode.energyPerTick;

    const drain = async (): Promise<void> => {
      await t.db
        .update(playerCurrencies)
        .set({ huntEnergy: 0 })
        .where(eq(playerCurrencies.playerId, playerId));
    };

    const start = new Date('2030-01-01T00:00:00Z');
    await drain();
    await app.care.start(playerId, waifuId, start);
    const plain = await app.care.applyPending(playerId, new Date(start.getTime() + 2 * interval));
    expect(plain.ticksProcessed).toBe(2);
    expect(plain.energyGained).toBe(2 * perTick);
    await app.care.leave(playerId, new Date(start.getTime() + 2 * interval));

    authorBonus(slug, {
      name: 'Second Cup',
      flavorText: '+100% Energy gained in Care mode.',
      effectId: 'care_energy_gain',
      value: 100,
    });
    const restart = new Date(start.getTime() + 3 * interval);
    await drain();
    await app.care.start(playerId, waifuId, restart);
    const boosted = await app.care.applyPending(
      playerId,
      new Date(restart.getTime() + 2 * interval),
    );
    expect(boosted.ticksProcessed).toBe(2);
    expect(boosted.energyGained).toBe(4 * perTick);
  });
});

describe('player_xp_gain', () => {
  it('scales an XP award, and records what was actually granted', async () => {
    const slug = contentSlugOf((s) => s.rarity === 'N');
    authorBonus(slug, {
      name: 'Quick Study',
      flavorText: '+50% Player XP.',
      effectId: 'player_xp_gain',
      value: 50,
    });
    await giveBuddy(slug);

    const granted = await t.db.transaction((tx) =>
      app.progression.grantXp(tx, playerId, { eventType: 'test', xpDelta: 10 }),
    );
    expect(granted.baseXpDelta).toBe(10);
    expect(granted.buddyBonusPercent).toBe(50);
    expect(granted.xpDelta).toBe(15);
    expect(granted.player.xp).toBe(15);
  });

  it('leaves a correction alone, and applies nothing with no buddy', async () => {
    // No buddy equipped at all: the beforeEach cleared the pointer.
    const negative = await t.db.transaction((tx) =>
      app.progression.grantXp(tx, playerId, { eventType: 'test', xpDelta: -5 }),
    );
    expect(negative.xpDelta).toBe(-5);
    expect(negative.buddyBonusPercent).toBe(0);
  });
});

describe('buddy_xp_gain and affection_gain', () => {
  it('scales the buddy’s own per-hunt award', async () => {
    const slug = contentSlugOf((s) => s.rarity === 'N');
    const cfg = app.content.tables.waifuProgression.buddy;
    authorBonus(slug, {
      name: 'Training Montage',
      flavorText: '+100% Buddy XP.',
      effectId: 'buddy_xp_gain',
      value: 100,
    });
    await giveBuddy(slug);
    const xpAward = await t.db.transaction((tx) => app.collection.awardBuddyOnHunt(tx, playerId));
    expect(xpAward!.xpGranted).toBe(cfg.xpPerHunt * 2);
    expect(xpAward!.affectionGranted).toBe(cfg.affectionPerHunt);

    authorBonus(slug, {
      name: 'Offering Bowl',
      flavorText: '+100% Affection gained.',
      effectId: 'affection_gain',
      value: 100,
    });
    const affAward = await t.db.transaction((tx) => app.collection.awardBuddyOnHunt(tx, playerId));
    expect(affAward!.xpGranted).toBe(cfg.xpPerHunt);
    expect(affAward!.affectionGranted).toBe(cfg.affectionPerHunt * 2);
  });
});

describe('essence_gain', () => {
  it('scales the Essence a duplicate conversion pays out', async () => {
    const buddySlug = contentSlugOf((s) => s.rarity === 'N');
    const dupSlug = contentSlugOf((s) => s.rarity === 'R');
    const dup = await speciesBySlug(dupSlug);
    const base =
      (app.content.tables.duplicate.essenceByRarity as Record<string, number>)[dup.rarity] ?? 0;
    expect(base).toBeGreaterThan(0);

    authorBonus(buddySlug, {
      name: 'Quiet Study',
      flavorText: '+100% Essence gained.',
      effectId: 'essence_gain',
      value: 100,
    });
    await giveBuddy(buddySlug);
    await insertOwnedWaifu(t.db, { playerId, speciesId: dup.id });
    const extra = await insertOwnedWaifu(t.db, { playerId, speciesId: dup.id });

    const result = await app.collection.convertDuplicateToEssence(playerId, extra.id);
    expect(result.essenceGranted).toBe(base * 2);
  });
});

// ── bosses ──────────────────────────────────────────────────────────────────

describe('boss_reward_gain', () => {
  /**
   * The payout is made deterministic before it is scaled: one enabled entry in
   * one certain group, every other group off. What is drawn is then fixed, so
   * the assertion is purely about the *size* of the outcome — which is exactly
   * the line this effect is not allowed to cross.
   */
  let restoreTable: (() => void) | null = null;

  function pinRewardTable(): { slug: string; quantity: number; buddyXp: number } {
    const table = app.content.bossRewards[0]!;
    const snapshot = JSON.parse(JSON.stringify(table)) as typeof table;
    restoreTable = () => {
      app.content.bossRewards[0] = snapshot;
    };
    const standard = table.groups.find((g) => g.id === 'standard-item')!;
    for (const group of table.groups) group.enabled = group.id === 'standard-item';
    standard.chanceBasisPoints = 10_000;
    standard.rolls = 1;
    const kept = standard.entries[0]!;
    for (const entry of standard.entries) entry.enabled = entry === kept;
    return { slug: kept.itemId, quantity: kept.quantity, buddyXp: table.buddyXp };
  }

  afterEach(() => {
    restoreTable?.();
    restoreTable = null;
  });

  async function openEncounter(): Promise<BossEncounterRow> {
    const boss = app.content.bosses[0]!;
    const now = new Date();
    const [row] = await t.db
      .insert(bossEncounters)
      .values({
        guildId: guildDbId,
        region: 'waifu-valley',
        bossId: boss.id,
        bossName: boss.name,
        bossAffinity: boss.affinity,
        bossArtwork: null,
        rewardTable: boss.rewardTable,
        rewardTableVersion: 'standard-scouting-v1',
        calcVersion: 1,
        affinityVersion: 1,
        channelId: 'c-boss',
        messageId: 'm-1',
        status: 'scouting',
        scheduledAt: now,
        scoutingStartedAt: now,
        deadlineAt: new Date(now.getTime() + 60 * MINUTE),
      })
      .returning();
    return row!;
  }

  async function resolveOnce(bonus: BuddyBonus | null): Promise<{
    xpAwarded: number | null;
    items: Array<{ slug: string; quantity: number }>;
  }> {
    const slug = contentSlugOf((s) => s.rarity === 'N');
    authorBonus(slug, bonus);
    await giveBuddy(slug, 10);
    const encounter = await openEncounter();
    await app.bosses.commit(encounter.id, guildDbId, playerId, IDENTITY);
    await app.bosses.resolve(encounter.id);
    const [row] = await t.db
      .select()
      .from(bossParticipations)
      .where(eq(bossParticipations.encounterId, encounter.id));
    return {
      xpAwarded: row!.xpAwarded,
      items: (row!.rewardItems ?? []) as Array<{ slug: string; quantity: number }>,
    };
  }

  it('pays the table exactly when no bonus applies', async () => {
    const pinned = pinRewardTable();
    const plain = await resolveOnce(null);
    expect(plain.xpAwarded).toBe(pinned.buddyXp);
    expect(plain.items).toEqual([{ slug: pinned.slug, quantity: pinned.quantity }]);
  });

  it('scales the eligible outcome without changing what was drawn', async () => {
    const pinned = pinRewardTable();
    const boosted = await resolveOnce({
      name: 'Spoils',
      flavorText: '+100% boss rewards.',
      effectId: 'boss_reward_gain',
      value: 100,
    });
    // Same item, twice as much of it — the draw is untouched.
    expect(boosted.items).toEqual([{ slug: pinned.slug, quantity: pinned.quantity * 2 }]);
    expect(boosted.xpAwarded).toBe(pinned.buddyXp * 2);
  });

  /**
   * The committed copy is authoritative for the whole participation.
   *
   * Everything else the payout reads — level, SP, rarity, affinity, race — is
   * already snapshotted at commitment and does not follow a later Buddy swap.
   * `boss_reward_gain` is held to the same rule, in both directions, so the
   * Buddy slot cannot be used as a payout switch after the commitment that
   * earned the reward.
   */
  describe('swapping Buddy between commitment and resolution', () => {
    /** A species carrying the bonus, and one that carries nothing. */
    function pair(): { withBonus: string; without: string } {
      const withBonus = contentSlugOf((s) => s.rarity === 'N');
      const without = contentSlugOf((s) => s.rarity === 'N' && s.slug !== withBonus);
      authorBonus(withBonus, {
        name: 'Spoils',
        flavorText: '+100% boss rewards.',
        effectId: 'boss_reward_gain',
        value: 100,
      });
      authorBonus(without, null);
      return { withBonus, without };
    }

    async function payout(encounterId: number): Promise<{
      xpAwarded: number | null;
      items: Array<{ slug: string; quantity: number }>;
    }> {
      const [row] = await t.db
        .select()
        .from(bossParticipations)
        .where(eq(bossParticipations.encounterId, encounterId));
      return {
        xpAwarded: row!.xpAwarded,
        items: (row!.rewardItems ?? []) as Array<{ slug: string; quantity: number }>,
      };
    }

    it('pays nothing extra when the bonus arrived after the commitment', async () => {
      const pinned = pinRewardTable();
      const { withBonus, without } = pair();

      await giveBuddy(without, 10); // commits a copy with no bonus
      const encounter = await openEncounter();
      const participation = await app.bosses.commit(
        encounter.id,
        guildDbId,
        playerId,
        IDENTITY,
      );
      expect(participation.speciesSlug).toBe(without);

      await giveBuddy(withBonus, 10); // swap *after* committing
      await app.bosses.resolve(encounter.id);

      const paid = await payout(encounter.id);
      expect(paid.items).toEqual([{ slug: pinned.slug, quantity: pinned.quantity }]);
      expect(paid.xpAwarded).toBe(pinned.buddyXp);
    });

    it('still pays the committed copy’s bonus after the player swaps away', async () => {
      const pinned = pinRewardTable();
      const { withBonus, without } = pair();

      await giveBuddy(withBonus, 10); // commits the copy that carries the bonus
      const encounter = await openEncounter();
      const participation = await app.bosses.commit(
        encounter.id,
        guildDbId,
        playerId,
        IDENTITY,
      );
      expect(participation.speciesSlug).toBe(withBonus);

      await giveBuddy(without, 10); // swap *after* committing
      await app.bosses.resolve(encounter.id);

      const paid = await payout(encounter.id);
      expect(paid.items).toEqual([{ slug: pinned.slug, quantity: pinned.quantity * 2 }]);
      expect(paid.xpAwarded).toBe(pinned.buddyXp * 2);
    });
  });
});

// ── the content-driven guarantee ────────────────────────────────────────────

describe('a species that ships no bonus at all', () => {
  it('grants one the moment content authors it, with no code change', async () => {
    // Deliberately a species the shipped corpus leaves bonus-less: nothing in
    // `src/` mentions her, and nothing had to be taught about this effect.
    const slug = contentSlugOf((s) => !s.buddyBonus);
    const waifuId = await giveBuddy(slug);
    expect(app.buddyBonus.bonusForSpeciesSlug(slug)).toBeNull();

    const before = await t.db.transaction((tx) =>
      app.progression.grantXp(tx, playerId, { eventType: 'test', xpDelta: 10 }),
    );
    expect(before.xpDelta).toBe(10);

    authorBonus(slug, {
      name: 'Newly Authored',
      flavorText: 'Newly Authored: +100% Player XP.',
      effectId: 'player_xp_gain',
      value: 100,
    });

    const after = await t.db.transaction((tx) =>
      app.progression.grantXp(tx, playerId, { eventType: 'test', xpDelta: 10 }),
    );
    expect(after.xpDelta).toBe(20);
    // …and it is the equipped copy that grants it: unequip, and it is gone.
    expect(waifuId).toBeGreaterThan(0);
    await app.collection.clearBuddy(playerId);
    const unequipped = await t.db.transaction((tx) =>
      app.progression.grantXp(tx, playerId, { eventType: 'test', xpDelta: 10 }),
    );
    expect(unequipped.xpDelta).toBe(10);
  });
});
