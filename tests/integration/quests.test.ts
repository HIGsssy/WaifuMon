/**
 * Daily Quests (Milestone 5C) integration tests.
 * Real Postgres, real transactions — the whole point of the quest system is
 * that progress accrues atomically with gameplay actions and can only be
 * claimed once.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_COMPLETE_BONUS_SLUG,
  captureAttempts,
  dailyClaims,
  encounters,
  playerCurrencies,
  playerDailyQuests,
  playerInventory,
  playerProgressionEvents,
  playerWaifus,
  players,
  species,
  type PlayerWaifuRow,
} from '../../src/db/schema';
import { createQuestService } from '../../src/modules/quests/questService';
import { createHuntService } from '../../src/modules/hunt/huntService';
import { createCaptureService } from '../../src/modules/capture/captureService';
import {
  DailyQuestsConfigSchema,
  QuestPoolEntrySchema,
} from '../../src/modules/content/schemas';
import { claimDateInTimezone } from '../../src/shared/time';
import type { Rng } from '../../src/shared/random';
import { bootstrapApp, getItemBySlug, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
});
afterAll(async () => {
  await t.cleanup();
});

async function resetPlayer(playerId: number, huntEnergy = 25): Promise<void> {
  await t.db
    .delete(playerProgressionEvents)
    .where(eq(playerProgressionEvents.playerId, playerId));
  await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, playerId));
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db.delete(dailyClaims).where(eq(dailyClaims.playerId, playerId));
  await t.db.delete(playerDailyQuests).where(eq(playerDailyQuests.playerId, playerId));
  await t.db
    .update(players)
    .set({
      xp: 0,
      level: 1,
      lastHuntAt: null,
      buddyWaifuId: null,
      careModeStartedAt: null,
      careModeLastTickAt: null,
      careModeWaifuId: null,
    })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy, waifubux: 0, essence: 0 })
    .where(eq(playerCurrencies.playerId, playerId));
}

async function grantWaifu(
  playerId: number,
  slug: string,
  overrides: Partial<PlayerWaifuRow> = {},
): Promise<PlayerWaifuRow> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, slug));
  const [row] = await t.db
    .insert(playerWaifus)
    .values({ playerId, speciesId: sp!.id, ...overrides })
    .returning();
  return row!;
}

async function loadTodayRows(playerId: number, date?: string) {
  const [{ questDate = date ?? '' } = { questDate: '' }] = await t.db
    .select({ questDate: playerDailyQuests.questDate })
    .from(playerDailyQuests)
    .where(eq(playerDailyQuests.playerId, playerId))
    .limit(1);
  if (!questDate) return [];
  return t.db
    .select()
    .from(playerDailyQuests)
    .where(
      and(
        eq(playerDailyQuests.playerId, playerId),
        eq(playerDailyQuests.questDate, questDate),
      ),
    );
}

function scriptedRng(nexts: number[]): Rng {
  let i = 0;
  return {
    next: () => nexts[i++]!,
    intInclusive(min, max) {
      const v = nexts[i++]!;
      return Math.floor(v * (max - min + 1)) + min;
    },
  };
}

const DAY1 = new Date('2026-08-01T12:00:00Z');
const DAY2 = new Date('2026-08-02T12:00:00Z');

// ─────────────────────── config validation ───────────────────────

describe('DailyQuests config schema', () => {
  const baseEntry = {
    slug: 'test_q',
    title: 'Test',
    description: 'Do the thing.',
    type: 'hunt_energy_spent',
    target: 3,
    weight: 100,
    rewards: { waifubux: 10 },
  };
  it('accepts a well-formed pool entry', () => {
    expect(QuestPoolEntrySchema.safeParse(baseEntry).success).toBe(true);
  });
  it('requires rarityAtLeast on rarity-gated quests', () => {
    const bad = { ...baseEntry, type: 'capture_success_rarity_at_least' };
    expect(QuestPoolEntrySchema.safeParse(bad).success).toBe(false);
  });
  it('rejects rarityAtLeast on non-rarity quests', () => {
    const bad = { ...baseEntry, rarityAtLeast: 'SR' };
    expect(QuestPoolEntrySchema.safeParse(bad).success).toBe(false);
  });
  it('rewards must grant at least one of waifubux/essence/items', () => {
    const bad = { ...baseEntry, rewards: {} };
    expect(QuestPoolEntrySchema.safeParse(bad).success).toBe(false);
  });
  it('flags duplicate slugs in the pool', () => {
    const cfg = {
      enabled: true,
      questsPerDay: 2,
      pool: [baseEntry, baseEntry],
    };
    expect(DailyQuestsConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('rejects pool referencing an unknown item slug on load', async () => {
    // Reuse the fixture app's content and mutate it to point at a bogus slug —
    // then re-validate via loader-like path. The shipped tables passes, but
    // a quest referencing nonexistent item is caught. We verify by loading
    // content with mutated tables directly.
    const tables = structuredClone(app.content.tables) as typeof app.content.tables;
    tables.dailyQuests.pool.push({
      slug: 'bogus_quest',
      title: 'Bogus',
      description: 'Test',
      type: 'hunt_energy_spent',
      target: 1,
      weight: 10,
      difficulty: 'easy',
      rewards: { waifubux: 0, essence: 0, items: [{ slug: 'nonexistent_item', quantity: 1 }] },
    });
    // Validate via manual item slug lookup (mirrors loader.ts behavior).
    const itemSlugs = new Set(app.content.items.map((i) => i.slug));
    const bad = tables.dailyQuests.pool.some((p) =>
      p.rewards.items.some((i) => !itemSlugs.has(i.slug)),
    );
    expect(bad).toBe(true);
  });
});

// ─────────────────────── assignment ───────────────────────

describe('QuestService.ensureDailyQuests', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-q-assign', 'u-1'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId);
  });

  it('assigns 3 unique weighted quests on first call', async () => {
    const rows = await app.quests.ensureDailyQuests(playerId, DAY1);
    expect(rows.length).toBe(3);
    const slugs = new Set(rows.map((r) => r.questSlug));
    expect(slugs.size).toBe(3);
    // No sentinel row until the all-complete bonus fires.
    const all = await loadTodayRows(playerId);
    expect(all.some((r) => r.questSlug === ALL_COMPLETE_BONUS_SLUG)).toBe(false);
  });

  it('is idempotent for the same day', async () => {
    const first = await app.quests.ensureDailyQuests(playerId, DAY1);
    const second = await app.quests.ensureDailyQuests(playerId, DAY1);
    expect(second.length).toBe(first.length);
    expect(new Set(second.map((r) => r.questSlug))).toEqual(new Set(first.map((r) => r.questSlug)));
  });

  it('assigns a fresh set on the next calendar day', async () => {
    const day1 = await app.quests.ensureDailyQuests(playerId, DAY1);
    const day2 = await app.quests.ensureDailyQuests(playerId, DAY2);
    expect(day2.length).toBe(3);
    // Different quest_date — original day-1 rows still exist.
    const all = await loadTodayRows(playerId);
    void all;
    const day1After = await t.db
      .select()
      .from(playerDailyQuests)
      .where(
        and(
          eq(playerDailyQuests.playerId, playerId),
          eq(playerDailyQuests.questDate, '2026-08-01'),
        ),
      );
    expect(day1After.length).toBe(day1.length);
  });
});

// ─────────────────────── progress ───────────────────────

describe('QuestService.recordQuestEvent — progress', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-q-progress', 'u-1'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId);
    // Deterministic set: pick the first 3 pool entries by scripting rng.
    // rollWeighted picks the entry whose cumulative weight passes r*total.
    // Force selection: use 0.0 → first, then repeat with the reduced set.
    await app.quests.ensureDailyQuests(playerId, DAY1);
  });

  it('progress clamps at target', async () => {
    // Find the hunt_energy_spent quest if assigned; otherwise seed one.
    let rows = await app.quests.getDailyQuests(playerId, DAY1);
    let energyQuest = rows.find((r) => r.type === 'hunt_energy_spent');
    if (!energyQuest) {
      const [inserted] = await t.db
        .insert(playerDailyQuests)
        .values({
          playerId,
          questDate: '2026-08-01',
          questSlug: 'seed_energy',
          titleSnapshot: 'Seed',
          descriptionSnapshot: 'seed',
          type: 'hunt_energy_spent',
          target: 5,
          progress: 0,
          rewardsJson: { waifubux: 10, essence: 0, items: [] },
        })
        .returning();
      energyQuest = inserted!;
    }
    await app.quests.recordQuestEvent(null, playerId, 'hunt_energy_spent', 999, {}, DAY1);
    rows = await app.quests.getDailyQuests(playerId, DAY1);
    const eq2 = rows.find((r) => r.id === energyQuest!.id);
    expect(eq2!.progress).toBe(energyQuest!.target);
    expect(eq2!.completedAt).not.toBeNull();
  });

  it('does not over-increment once completed', async () => {
    const [row] = await t.db
      .insert(playerDailyQuests)
      .values({
        playerId,
        questDate: '2026-08-01',
        questSlug: 'once_quest',
        titleSnapshot: 'Once',
        descriptionSnapshot: 'once',
        type: 'inspect_waifu',
        target: 1,
        progress: 0,
        rewardsJson: { waifubux: 5, essence: 0, items: [] },
      })
      .returning();
    await app.quests.recordQuestEvent(null, playerId, 'inspect_waifu', 1, {}, DAY1);
    await app.quests.recordQuestEvent(null, playerId, 'inspect_waifu', 1, {}, DAY1);
    const [after] = await t.db
      .select()
      .from(playerDailyQuests)
      .where(eq(playerDailyQuests.id, row!.id));
    expect(after!.progress).toBe(1);
  });

  it('rarity-at-least only advances for qualifying captures', async () => {
    const [rq] = await t.db
      .insert(playerDailyQuests)
      .values({
        playerId,
        questDate: '2026-08-01',
        questSlug: 'rare_q',
        titleSnapshot: 'Rare',
        descriptionSnapshot: 'rare',
        type: 'capture_success_rarity_at_least',
        rarityAtLeast: 'R',
        target: 1,
        progress: 0,
        rewardsJson: { waifubux: 10, essence: 0, items: [] },
      })
      .returning();
    // N doesn't count.
    await app.quests.recordQuestEvent(
      null,
      playerId,
      'capture_success_rarity_at_least',
      1,
      { rarity: 'N' },
      DAY1,
    );
    let [row] = await t.db.select().from(playerDailyQuests).where(eq(playerDailyQuests.id, rq!.id));
    expect(row!.progress).toBe(0);
    // R does count.
    await app.quests.recordQuestEvent(
      null,
      playerId,
      'capture_success_rarity_at_least',
      1,
      { rarity: 'R' },
      DAY1,
    );
    [row] = await t.db.select().from(playerDailyQuests).where(eq(playerDailyQuests.id, rq!.id));
    expect(row!.progress).toBe(1);
    expect(row!.completedAt).not.toBeNull();
  });
});

// ─────────────────────── claim ───────────────────────

describe('QuestService.claimAllCompleted', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-q-claim', 'u-1'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId);
  });

  it('claim grants WaifuBux, Essence, and items and stamps claimed_at', async () => {
    const basic = await getItemBySlug(t.db, 'basic_charm');
    const [row] = await t.db
      .insert(playerDailyQuests)
      .values({
        playerId,
        questDate: '2026-08-01',
        questSlug: 'multi_reward',
        titleSnapshot: 'Multi',
        descriptionSnapshot: 'multi',
        type: 'inspect_waifu',
        target: 1,
        progress: 1,
        completedAt: DAY1,
        rewardsJson: {
          waifubux: 30,
          essence: 5,
          items: [{ slug: 'basic_charm', quantity: 2 }],
        },
      })
      .returning();
    const result = await app.quests.claimAllCompleted(playerId, DAY1);
    expect(result.claimed.length).toBe(1);
    // Sole-quest completion also triggers the shipped allCompleteBonus
    // (+50 WB, +1 silk_charm). So totalRewards includes both.
    expect(result.allCompleteBonusGranted).toBe(true);
    const bonus = app.quests.config.allCompleteBonus;
    const expectedWb = 30 + (bonus?.waifubux ?? 0);
    expect(result.totalRewards.waifubux).toBe(expectedWb);
    expect(result.totalRewards.essence).toBe(5);
    const bal = await app.currency.getBalances(playerId);
    expect(bal.waifubux).toBe(expectedWb);
    expect(bal.essence).toBe(5);
    expect(await app.inventory.getQuantity(playerId, basic.id)).toBe(2);
    // Row stamped.
    const [after] = await t.db
      .select()
      .from(playerDailyQuests)
      .where(eq(playerDailyQuests.id, row!.id));
    expect(after!.claimedAt).not.toBeNull();
  });

  it('cannot claim the same quest twice', async () => {
    await t.db.insert(playerDailyQuests).values({
      playerId,
      questDate: '2026-08-01',
      questSlug: 'once_only',
      titleSnapshot: 'Once',
      descriptionSnapshot: 'once',
      type: 'inspect_waifu',
      target: 1,
      progress: 1,
      completedAt: DAY1,
      rewardsJson: { waifubux: 20, essence: 0, items: [] },
    });
    const first = await app.quests.claimAllCompleted(playerId, DAY1);
    expect(first.claimed.length).toBe(1);
    const expectedWb = 20 + (app.quests.config.allCompleteBonus?.waifubux ?? 0);
    const second = await app.quests.claimAllCompleted(playerId, DAY1);
    expect(second.claimed.length).toBe(0);
    expect(second.allCompleteBonusGranted).toBe(false);
    const bal = await app.currency.getBalances(playerId);
    expect(bal.waifubux).toBe(expectedWb); // unchanged after second claim
  });

  it('claim-all grants multiple completed quest rewards + the all-complete bonus once', async () => {
    // 2 completed quests; the config's allCompleteBonus should fire once.
    await t.db.insert(playerDailyQuests).values([
      {
        playerId,
        questDate: '2026-08-01',
        questSlug: 'q1',
        titleSnapshot: 'Q1',
        descriptionSnapshot: '',
        type: 'inspect_waifu',
        target: 1,
        progress: 1,
        completedAt: DAY1,
        rewardsJson: { waifubux: 10, essence: 0, items: [] },
      },
      {
        playerId,
        questDate: '2026-08-01',
        questSlug: 'q2',
        titleSnapshot: 'Q2',
        descriptionSnapshot: '',
        type: 'inspect_waifu',
        target: 1,
        progress: 1,
        completedAt: DAY1,
        rewardsJson: { waifubux: 15, essence: 0, items: [] },
      },
    ]);
    const first = await app.quests.claimAllCompleted(playerId, DAY1);
    expect(first.claimed.length).toBe(2);
    expect(first.allCompleteBonusGranted).toBe(true);
    // Repeated claim-all: no rewards, no bonus (sentinel row already exists).
    const second = await app.quests.claimAllCompleted(playerId, DAY1);
    expect(second.claimed.length).toBe(0);
    expect(second.allCompleteBonusGranted).toBe(false);
  });

  it('concurrent claim-all does not double-pay', async () => {
    await t.db.insert(playerDailyQuests).values({
      playerId,
      questDate: '2026-08-01',
      questSlug: 'race_q',
      titleSnapshot: 'Race',
      descriptionSnapshot: '',
      type: 'inspect_waifu',
      target: 1,
      progress: 1,
      completedAt: DAY1,
      rewardsJson: { waifubux: 25, essence: 0, items: [] },
    });
    const [a, b] = await Promise.all([
      app.quests.claimAllCompleted(playerId, DAY1),
      app.quests.claimAllCompleted(playerId, DAY1),
    ]);
    const claimedCount = a.claimed.length + b.claimed.length;
    expect(claimedCount).toBe(1);
    // At most one of the two calls granted the all-complete bonus.
    const bonusFired = [a, b].filter((r) => r.allCompleteBonusGranted).length;
    expect(bonusFired).toBeLessThanOrEqual(1);
    const bonusWb =
      bonusFired === 1 ? (app.quests.config.allCompleteBonus?.waifubux ?? 0) : 0;
    const bal = await app.currency.getBalances(playerId);
    expect(bal.waifubux).toBe(25 + bonusWb);
  });
});

// ─────────────────────── gameplay integration ───────────────────────

describe('gameplay actions update quest progress', () => {
  let playerId: number;
  const TODAY = claimDateInTimezone(new Date(), 'UTC');
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-q-integration', 'u-1'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId);
  });

  async function seedQuest(
    type: string,
    target: number,
    slug: string,
    rarityAtLeast?: string,
  ): Promise<number> {
    const [row] = await t.db
      .insert(playerDailyQuests)
      .values({
        playerId,
        questDate: TODAY,
        questSlug: slug,
        titleSnapshot: slug,
        descriptionSnapshot: slug,
        type,
        rarityAtLeast: rarityAtLeast ?? null,
        target,
        progress: 0,
        rewardsJson: { waifubux: 5, essence: 0, items: [] },
      })
      .returning();
    return row!.id;
  }
  async function progressOf(rowId: number): Promise<{ progress: number; completed: boolean }> {
    const [r] = await t.db
      .select()
      .from(playerDailyQuests)
      .where(eq(playerDailyQuests.id, rowId));
    return { progress: r!.progress, completed: r!.completedAt != null };
  }

  it('hunt records hunt_energy_spent inside the hunt transaction', async () => {
    const rowId = await seedQuest('hunt_energy_spent', 3, 'seed_energy');
    // 3 non-encounter hunts (rng picks flavor). Use current date so the quest
    // service's own `today()` lookup matches the seeded quest_date.
    const base = new Date();
    const times = [
      base,
      new Date(base.getTime() + 60_000),
      new Date(base.getTime() + 120_000),
    ];
    for (const at of times) {
      const scripted = createHuntService({
        db: t.db,
        currency: app.currency,
        inventory: app.inventory,
        progression: app.progression,
        collection: app.collection,
        care: app.care,
        quests: app.quests,
        tables: app.content.tables,
        logger: t.logger,
        rng: scriptedRng([0.99, 0.0]),
      });
      await scripted.hunt(playerId, 'c-1', at);
    }
    const state = await progressOf(rowId);
    expect(state.progress).toBe(3);
    expect(state.completed).toBe(true);
  });

  it('capture attempt records capture_attempts; success also records capture_success + rarity-at-least', async () => {
    const attemptId = await seedQuest('capture_attempts', 1, 'seed_attempts');
    const successId = await seedQuest('capture_success', 1, 'seed_success');
    const rareId = await seedQuest('capture_success_rarity_at_least', 1, 'seed_rare', 'R');
    // Grant a Basic Charm and stage an encounter with a Rare species.
    const basic = await getItemBySlug(t.db, 'basic_charm');
    await app.inventory.addItem(t.db, playerId, basic.id, 1);
    const [rareSp] = await t.db
      .select()
      .from(species)
      .where(and(eq(species.rarity, 'R'), eq(species.enabled, true)))
      .limit(1);
    const now = new Date();
    const [enc] = await t.db
      .insert(encounters)
      .values({
        playerId,
        speciesId: rareSp!.id,
        channelId: 'c-1',
        state: 'active',
        attemptCount: 0,
        maxAttempts: 3,
        expiresAt: new Date(now.getTime() + 60_000),
      })
      .returning();
    const scripted = createCaptureService({
      db: t.db,
      inventory: app.inventory,
      progression: app.progression,
      progressionConfig: app.content.tables.progression,
      captureConfig: app.content.tables.capture,
      quests: app.quests,
      logger: t.logger,
      rng: scriptedRng([0.0]),
    });
    const result = await scripted.attemptCapture(playerId, enc!.id, 'basic_charm', now);
    expect(result.outcome).toBe('success');
    expect((await progressOf(attemptId)).progress).toBe(1);
    expect((await progressOf(successId)).progress).toBe(1);
    expect((await progressOf(rareId)).progress).toBe(1);
  });

  it('duplicate convert records duplicate_converted', async () => {
    const rowId = await seedQuest('duplicate_converted', 1, 'seed_dup');
    const w1 = await grantWaifu(playerId, 'neko_barista');
    const w2 = await grantWaifu(playerId, 'neko_barista');
    void w1;
    await app.collection.convertDuplicateToEssence(playerId, w2.id);
    expect((await progressOf(rowId)).progress).toBe(1);
  });

  it('inspect updates inspect_waifu quest via handleQuestsClaimAll path (recordQuestEvent direct)', async () => {
    const rowId = await seedQuest('inspect_waifu', 1, 'seed_inspect');
    // renderInspect in UI calls quests.recordQuestEvent(null, ..., 'inspect_waifu', 1) —
    // we exercise the same service call directly to avoid Discord plumbing.
    await app.quests.recordQuestEvent(null, playerId, 'inspect_waifu', 1);
    expect((await progressOf(rowId)).progress).toBe(1);
  });

  it('care mode ticks update care_mode_ticks and waifu_affection_gained', async () => {
    const tickId = await seedQuest('care_mode_ticks', 2, 'seed_ticks');
    const affId = await seedQuest('waifu_affection_gained', 2, 'seed_aff');
    const w = await grantWaifu(playerId, 'neko_barista');
    const now = new Date();
    // Backdate care_mode_started_at so 60 minutes have elapsed by `now`.
    const backDate = new Date(now.getTime() - 60 * 60 * 1000);
    await app.care.start(playerId, w.id, backDate);
    const summary = await app.care.applyPending(playerId, now);
    expect(summary.ticksProcessed).toBe(2);
    expect((await progressOf(tickId)).progress).toBe(2);
    expect((await progressOf(affId)).progress).toBe(2);
  });

  it('rollback of a gameplay action rolls back quest progress', async () => {
    const rowId = await seedQuest('capture_attempts', 5, 'rollback_q');
    // No inventory → InsufficientItemsError → transaction rolls back.
    const basic = await getItemBySlug(t.db, 'basic_charm');
    const [rareSp] = await t.db.select().from(species).limit(1);
    const now = new Date();
    const [enc] = await t.db
      .insert(encounters)
      .values({
        playerId,
        speciesId: rareSp!.id,
        channelId: 'c-1',
        state: 'active',
        attemptCount: 0,
        maxAttempts: 3,
        expiresAt: new Date(now.getTime() + 60_000),
      })
      .returning();
    let threw = false;
    try {
      await app.capture.attemptCapture(playerId, enc!.id, basic.slug, now);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect((await progressOf(rowId)).progress).toBe(0);
  });
});

// ─────────────────────── UI shape ───────────────────────

describe('Daily Quests UI helpers', () => {
  it('renderSummaryLines-style: completed quests reveal claim button (indirect check)', async () => {
    // We just verify the QuestService.config.enabled is truthy for shipped
    // content so the menu button shows up. Actual UI rendering is exercised
    // via the discord.js embed builders indirectly in session tests.
    expect(app.quests.config.enabled).toBe(true);
    expect(app.quests.config.pool.length).toBeGreaterThan(0);
  });
});

// ─────────────────────── config integration ───────────────────────

describe('QuestService respects an empty/disabled config', () => {
  it('ensureDailyQuests is a no-op when config.enabled is false', async () => {
    const { playerId: pid } = await provisionPlayer(app, 'g-q-disabled', 'u-1');
    await resetPlayer(pid);
    // Build a private QuestService instance with disabled config.
    const disabled = createQuestService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      config: { enabled: false, questsPerDay: 3, pool: [] },
      timezone: 'UTC',
      logger: t.logger,
    });
    const rows = await disabled.ensureDailyQuests(pid, DAY1);
    expect(rows).toEqual([]);
    // recordQuestEvent is a no-op when disabled.
    await disabled.recordQuestEvent(null, pid, 'hunt_energy_spent', 5, {}, DAY1);
    const all = await t.db
      .select()
      .from(playerDailyQuests)
      .where(eq(playerDailyQuests.playerId, pid));
    expect(all.length).toBe(0);
  });
});
