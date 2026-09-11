/**
 * Daily Quest Essence pays `essence_gain`.
 *
 * This is the path the audit found paying the raw authored amount: quests
 * called `currency.grantEssence` directly, so a player with an Essence Buddy
 * was quietly short-changed on every quest reward and every all-complete bonus.
 *
 * `QuestService` deliberately does not know what a Buddy Bonus is. It takes an
 * `EssenceAwardService` and hands it the Essence it owes; the percentage lives
 * there. These tests therefore assert the *payout*, and that only the Essence
 * moved — a quest's Waifubux and items are not Essence and must not shift.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  playerCurrencies,
  playerDailyQuests,
  playerInventory,
  playerWaifus,
  players,
  species,
} from '../../src/db/schema';
import type { BuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import { createQuestService } from '../../src/modules/quests/questService';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let buddySlug: string;

const DAY1 = new Date('2026-08-01T12:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-quest-essence', 'u-1'));
  buddySlug = app.content.species.find((s) => s.enabled)!.slug;
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

async function equipBuddy(): Promise<void> {
  const [row] = await t.db.select().from(species).where(eq(species.slug, buddySlug));
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: row!.id });
  await app.collection.setBuddy(playerId, waifu.id);
}

/** A single completed, unclaimed quest worth `essence` (and 30 Waifubux). */
async function completedQuest(essence: number): Promise<void> {
  await t.db.insert(playerDailyQuests).values({
    playerId,
    questDate: '2026-08-01',
    questSlug: 'essence_quest',
    titleSnapshot: 'Essence Quest',
    descriptionSnapshot: 'Earn Essence.',
    type: 'inspect_waifu',
    target: 1,
    progress: 1,
    completedAt: DAY1,
    rewardsJson: { waifubux: 30, essence, items: [] },
  });
}

beforeEach(async () => {
  restoreBonuses();
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.delete(playerDailyQuests).where(eq(playerDailyQuests.playerId, playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 0, essence: 0, huntEnergy: 25 })
    .where(eq(playerCurrencies.playerId, playerId));
});

describe('Daily Quest Essence rewards', () => {
  it('pays the authored amount when no Buddy is equipped', async () => {
    await completedQuest(40);
    const result = await app.quests.claimAllCompleted(playerId, DAY1);

    expect(result.questRewards.essence).toBe(40);
    expect(result.questRewards.essenceBase).toBe(40);
    expect(result.questRewards.essenceBonus).toBeNull();
    expect((await app.currency.getBalances(playerId)).essence).toBe(40);
  });

  it('pays 40 as 52 with a +30% Essence Buddy', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    await completedQuest(40);

    const result = await app.quests.claimAllCompleted(playerId, DAY1);

    expect(result.questRewards.essenceBase).toBe(40);
    expect(result.questRewards.essence).toBe(52);
    expect(result.questRewards.essenceBonus).toMatchObject({
      effectId: 'essence_gain',
      value: 30,
      baseValue: 40,
      finalValue: 52,
    });
    expect((await app.currency.getBalances(playerId)).essence).toBe(52);
  });

  it('leaves the quest’s Waifubux and items untouched', async () => {
    // `essence_gain` is a modifier on Essence and on nothing else. A quest
    // paying three reward types must see exactly one of them move.
    authorBonus(buddySlug, essenceBonus(100));
    await equipBuddy();
    await completedQuest(40);

    const result = await app.quests.claimAllCompleted(playerId, DAY1);

    expect(result.questRewards.essence).toBe(80);
    expect(result.questRewards.waifubux).toBe(30);
    const bal = await app.currency.getBalances(playerId);
    expect(bal.essence).toBe(80);
    // The shipped all-complete bonus also pays Waifubux; only the quest's own
    // 30 is asserted above, and the total is quest + bonus.
    expect(bal.waifubux).toBe(30 + (app.quests.config.allCompleteBonus?.waifubux ?? 0));
  });

  it('sums two quests’ Essence and restates the bonus against the total', async () => {
    authorBonus(buddySlug, essenceBonus(50));
    await equipBuddy();
    await completedQuest(40);
    await t.db.insert(playerDailyQuests).values({
      playerId,
      questDate: '2026-08-01',
      questSlug: 'essence_quest_2',
      titleSnapshot: 'Second',
      descriptionSnapshot: 'More Essence.',
      type: 'inspect_waifu',
      target: 1,
      progress: 1,
      completedAt: DAY1,
      rewardsJson: { waifubux: 0, essence: 20, items: [] },
    });

    const result = await app.quests.claimAllCompleted(playerId, DAY1);

    // Each award is scaled on its own (60 and 30), and the aggregate bonus
    // describes the pair rather than one of them.
    expect(result.questRewards.essenceBase).toBe(60);
    expect(result.questRewards.essence).toBe(90);
    expect(result.questRewards.essenceBonus).toMatchObject({
      baseValue: 60,
      finalValue: 90,
    });
  });
});

describe('the all-complete Quest bonus', () => {
  /**
   * A private QuestService whose all-complete bonus pays Essence.
   *
   * The shipped bonus pays Waifubux and an item, so the only way to exercise
   * the Essence branch of that reward is to author one — which is also the
   * point: the bonus goes through the same `grantRewards` helper, so a content
   * change that starts paying Essence is bonused with no code change.
   */
  function questsWithEssenceBonus() {
    return createQuestService({
      db: t.db,
      currency: app.currency,
      essenceAward: app.essenceAward,
      inventory: app.inventory,
      config: {
        ...app.quests.config,
        allCompleteBonus: { waifubux: 0, essence: 100, items: [] },
      },
      timezone: 'UTC',
      logger: t.logger,
    });
  }

  it('pays its Essence unbonused with no Buddy', async () => {
    await completedQuest(40);
    const result = await questsWithEssenceBonus().claimAllCompleted(playerId, DAY1);

    expect(result.allCompleteBonusGranted).toBe(true);
    expect(result.allCompleteBonusRewards!.essence).toBe(100);
    expect((await app.currency.getBalances(playerId)).essence).toBe(140);
  });

  it('pays its Essence through the same modifier: 100 at +30% is 130', async () => {
    authorBonus(buddySlug, essenceBonus(30));
    await equipBuddy();
    await completedQuest(40);

    const result = await questsWithEssenceBonus().claimAllCompleted(playerId, DAY1);

    expect(result.allCompleteBonusRewards!.essenceBase).toBe(100);
    expect(result.allCompleteBonusRewards!.essence).toBe(130);
    expect(result.allCompleteBonusRewards!.essenceBonus).toMatchObject({ value: 30 });

    // 52 from the quest + 130 from the bonus, and the grand total restates the
    // bonus against both.
    expect(result.totalRewards.essenceBase).toBe(140);
    expect(result.totalRewards.essence).toBe(182);
    expect(result.totalRewards.essenceBonus).toMatchObject({
      baseValue: 140,
      finalValue: 182,
    });
    expect((await app.currency.getBalances(playerId)).essence).toBe(182);
  });
});
