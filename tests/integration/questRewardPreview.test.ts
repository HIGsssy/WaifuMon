/**
 * `QuestService.previewRewards` — the pre-claim Essence quote.
 *
 * The gap this closes: the quest board read the authored `rewardsJson`
 * directly, so a player with an `essence_gain` Buddy was shown 40 Essence and
 * then paid 52. The claim was right; the board under-reported it.
 *
 * Two properties carry the whole design, and most of this file is about them:
 *
 *   - **The quote is not a promise.** It describes the Buddy equipped *now*.
 *     Swapping Buddy before pressing Claim changes what is paid, and the claim
 *     is authoritative — asserted here by actually swapping between the two.
 *   - **Per-award granularity.** The claim pays each quest and the
 *     all-complete bonus as separate awards, each rounded on its own. A
 *     preview that summed the bases first would quote a total the claim can
 *     never produce, so the preview must round the same way, per bundle.
 *
 * Everything else is a net around "presentation-only": no balance moves, no
 * quest row changes, and `rewardsJson` still holds exactly what was authored.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  playerCurrencies,
  playerDailyQuests,
  playerWaifus,
  players,
  species,
} from '../../src/db/schema';
import type { BuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import { createQuestService, parseQuestRewards } from '../../src/modules/quests/questService';
import type { QuestRewards } from '../../src/modules/content/schemas';
import { handleQuests } from '../../src/discord/commands/waifumon';
import type { AppContext, PlayerInteraction, Provisioned } from '../../src/discord/types';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
/** Two species with different bonuses, so "swap Buddy" is a real swap. */
let generousSlug: string;
let plainSlug: string;

const DAY1 = new Date('2026-08-01T12:00:00Z');

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-quest-preview', 'u-1'));
  const enabled = app.content.species.filter((s) => s.enabled);
  generousSlug = enabled[0]!.slug;
  plainSlug = enabled[1]!.slug;
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

async function equipBuddy(slug: string): Promise<number> {
  const [row] = await t.db.select().from(species).where(eq(species.slug, slug));
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: row!.id });
  await app.collection.setBuddy(playerId, waifu.id);
  return waifu.id;
}

const rewards = (essence: number, waifubux = 30): QuestRewards =>
  ({ waifubux, essence, items: [] }) as QuestRewards;

/** A single completed, unclaimed quest worth `essence` (and 30 Waifubux). */
async function completedQuest(essence: number): Promise<void> {
  await t.db.insert(playerDailyQuests).values({
    playerId,
    questDate: '2026-08-01',
    questSlug: 'preview_quest',
    titleSnapshot: 'Preview Quest',
    descriptionSnapshot: 'Earn Essence.',
    type: 'inspect_waifu',
    target: 1,
    progress: 1,
    completedAt: DAY1,
    rewardsJson: { waifubux: 30, essence, items: [] },
  });
}

const essenceOf = async (): Promise<number> => (await app.currency.getBalances(playerId)).essence;

const previewOne = async (bundle: QuestRewards) =>
  (await app.quests.previewRewards(playerId, [bundle]))[0]!;

beforeEach(async () => {
  restoreBonuses();
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.delete(playerDailyQuests).where(eq(playerDailyQuests.playerId, playerId));
  await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 0, essence: 0, huntEnergy: 25 })
    .where(eq(playerCurrencies.playerId, playerId));
});

/* ─────────────────────────── the quote itself ─────────────────────────── */

describe('previewRewards quotes Essence against the current Buddy', () => {
  it('quotes 40 as 52 with a +30% Essence Buddy', async () => {
    authorBonus(generousSlug, essenceBonus(30));
    await equipBuddy(generousSlug);

    const preview = await previewOne(rewards(40));

    expect(preview.essence).toBe(52);
    expect(preview.essenceBase).toBe(40);
    expect(preview.essenceBonus).toMatchObject({
      effectId: 'essence_gain',
      value: 30,
      baseValue: 40,
      finalValue: 52,
    });
  });

  it('quotes 40 as 40 with no Buddy equipped, and reports no bonus', async () => {
    const preview = await previewOne(rewards(40));
    expect(preview).toMatchObject({ essence: 40, essenceBase: 40, essenceBonus: null });
  });

  it('quotes 40 as 40 when the equipped Buddy grants an unrelated effect', async () => {
    authorBonus(generousSlug, {
      name: 'Star Charts',
      flavorText: '+30% XP gained by the active Buddy.',
      effectId: 'buddy_xp_gain',
      value: 30,
    });
    await equipBuddy(generousSlug);

    const preview = await previewOne(rewards(40));
    expect(preview.essence).toBe(40);
    expect(preview.essenceBonus).toBeNull();
  });

  it('uses the Buddy who is equipped, not merely one the player owns', async () => {
    // Owns the generous copy but has the plain one equipped: owning a bonus
    // is not the same as granting it.
    authorBonus(generousSlug, essenceBonus(30));
    authorBonus(plainSlug, null);
    await equipBuddy(generousSlug);
    await equipBuddy(plainSlug);

    const preview = await previewOne(rewards(40));
    expect(preview.essence).toBe(40);
    expect(preview.essenceBonus).toBeNull();
  });

  it('follows a Buddy swap on the very next quote', async () => {
    authorBonus(generousSlug, essenceBonus(30));
    authorBonus(plainSlug, null);
    const generous = await equipBuddy(generousSlug);
    expect((await previewOne(rewards(40))).essence).toBe(52);

    const plain = await equipBuddy(plainSlug);
    expect(plain).not.toBe(generous);
    expect((await previewOne(rewards(40))).essence).toBe(40);

    // …and back again, so this is tracking the pointer rather than latching.
    await app.collection.setBuddy(playerId, generous);
    expect((await previewOne(rewards(40))).essence).toBe(52);
  });

  it('leaves Waifubux and items exactly as authored', async () => {
    authorBonus(generousSlug, essenceBonus(100));
    await equipBuddy(generousSlug);
    const bundle = {
      waifubux: 30,
      essence: 40,
      items: [{ slug: 'basic_charm', quantity: 2 }],
    } as QuestRewards;

    const preview = await previewOne(bundle);

    expect(preview.essence).toBe(80);
    expect(preview.waifubux).toBe(30);
    expect(preview.items).toEqual([{ slug: 'basic_charm', quantity: 2 }]);
  });
});

/* ───────────────────────── per-award granularity ───────────────────────── */

describe('previewRewards rounds per award, matching claim granularity', () => {
  it('quotes two 5-Essence bundles at +10% as 6 and 6, not a summed 11', async () => {
    // The worked example. The claim pays each bundle as its own award, so each
    // rounds on its own: 5.5 → 6, twice, for 12. Previewing their combined
    // base of 10 would quote 11 — a number no claim can produce.
    authorBonus(generousSlug, essenceBonus(10));
    await equipBuddy(generousSlug);

    const previews = await app.quests.previewRewards(playerId, [rewards(5), rewards(5)]);

    expect(previews.map((p) => p.essence)).toEqual([6, 6]);
    expect(previews[0]!.essence + previews[1]!.essence).toBe(12);
  });

  it('agrees with what the claim actually pays for the same two awards', async () => {
    // The claim side of the same arithmetic: one 5-Essence quest plus a
    // 5-Essence all-complete bonus, both at +10%, must land on 12 in the
    // balance — proving the quote above is not merely self-consistent.
    const quests = createQuestService({
      db: t.db,
      currency: app.currency,
      essenceAward: app.essenceAward,
      inventory: app.inventory,
      config: {
        ...app.quests.config,
        allCompleteBonus: { waifubux: 0, essence: 5, items: [] },
      },
      timezone: 'UTC',
      logger: t.logger,
    });
    authorBonus(generousSlug, essenceBonus(10));
    await equipBuddy(generousSlug);
    await completedQuest(5);

    const result = await quests.claimAllCompleted(playerId, DAY1);

    expect(result.questRewards.essence).toBe(6);
    expect(result.allCompleteBonusRewards!.essence).toBe(6);
    expect(await essenceOf()).toBe(12);
  });

  it('quotes the all-complete bonus independently of the quests', async () => {
    authorBonus(generousSlug, essenceBonus(30));
    await equipBuddy(generousSlug);

    const [quest, bonus] = await app.quests.previewRewards(playerId, [
      rewards(40),
      rewards(100, 0),
    ]);

    expect(quest!.essence).toBe(52);
    expect(bonus!.essence).toBe(130);
    expect(bonus!.essenceBonus).toMatchObject({ baseValue: 100, finalValue: 130 });
  });

  it('returns one index-aligned quote per input, and handles an empty list', async () => {
    authorBonus(generousSlug, essenceBonus(30));
    await equipBuddy(generousSlug);

    const previews = await app.quests.previewRewards(playerId, [
      rewards(10),
      rewards(0, 25),
      rewards(40),
    ]);

    expect(previews).toHaveLength(3);
    expect(previews.map((p) => p.essence)).toEqual([13, 0, 52]);
    expect(await app.quests.previewRewards(playerId, [])).toEqual([]);
  });
});

/* ───────────────────── presentation-only guarantees ───────────────────── */

describe('previewRewards changes nothing', () => {
  it('does not move the Essence balance', async () => {
    authorBonus(generousSlug, essenceBonus(30));
    await equipBuddy(generousSlug);

    await app.quests.previewRewards(playerId, [rewards(40), rewards(100)]);

    expect(await essenceOf()).toBe(0);
  });

  it('does not touch quest state or the authored rewardsJson', async () => {
    authorBonus(generousSlug, essenceBonus(30));
    await equipBuddy(generousSlug);
    await completedQuest(40);
    const [before] = await t.db
      .select()
      .from(playerDailyQuests)
      .where(eq(playerDailyQuests.playerId, playerId));

    await app.quests.previewRewards(playerId, [parseQuestRewards(before!.rewardsJson)]);

    const [after] = await t.db
      .select()
      .from(playerDailyQuests)
      .where(eq(playerDailyQuests.playerId, playerId));
    // The frozen snapshot still says 40 — the quote is derived, never stored.
    expect(parseQuestRewards(after!.rewardsJson).essence).toBe(40);
    expect(after).toEqual(before);
  });
});

/* ──────────────────── the claim stays authoritative ──────────────────── */

describe('the claim is authoritative over the quote', () => {
  it('agrees with the claim when the Buddy does not change', async () => {
    authorBonus(generousSlug, essenceBonus(30));
    await equipBuddy(generousSlug);
    await completedQuest(40);

    const quoted = await previewOne(rewards(40));
    const result = await app.quests.claimAllCompleted(playerId, DAY1);

    expect(quoted.essence).toBe(52);
    expect(result.questRewards.essence).toBe(52);
    expect(await essenceOf()).toBe(52);
  });

  it('pays the new Buddy’s rate when the player swaps after seeing the quote', async () => {
    // The whole reason the quote is documented as non-authoritative: the board
    // said 52, the player swapped to a Buddy with no Essence bonus, and the
    // claim correctly pays 40.
    authorBonus(generousSlug, essenceBonus(30));
    authorBonus(plainSlug, null);
    await equipBuddy(generousSlug);
    await completedQuest(40);

    const quoted = await previewOne(rewards(40));
    expect(quoted.essence).toBe(52);

    await equipBuddy(plainSlug);
    const result = await app.quests.claimAllCompleted(playerId, DAY1);

    expect(result.questRewards.essence).toBe(40);
    expect(result.questRewards.essenceBonus).toBeNull();
    expect(await essenceOf()).toBe(40);
  });

  it('pays more than quoted when the player swaps *into* an Essence Buddy', async () => {
    // The mirror case, so the quote is not merely a ceiling.
    authorBonus(generousSlug, essenceBonus(30));
    authorBonus(plainSlug, null);
    await equipBuddy(plainSlug);
    await completedQuest(40);

    expect((await previewOne(rewards(40))).essence).toBe(40);

    await equipBuddy(generousSlug);
    const result = await app.quests.claimAllCompleted(playerId, DAY1);

    expect(result.questRewards.essence).toBe(52);
    expect(await essenceOf()).toBe(52);
  });
});

/* ────────────────────────── the board itself ────────────────────────── */

/**
 * The quest board, end to end: the real `QuestService` behind a Discord shell
 * thin enough to read the painted embed back.
 *
 * The domain assertions above prove `previewRewards` is right; this proves the
 * board actually *calls* it. Reading `rewardsJson` straight into the summary is
 * exactly what the bug was, and it typechecked perfectly.
 *
 * `handleQuests` assigns today's quests from the live pool, so nothing here
 * hard-codes a reward figure — the expectations are derived from whatever was
 * actually rolled. A retuned pool must not quietly turn these into assertions
 * about something else.
 */
describe('the quest board renders the Buddy-adjusted quote', () => {
  function boardCtx(): AppContext {
    return {
      content: app.content,
      services: { quests: app.quests },
    } as unknown as AppContext;
  }

  function boardInteraction(): PlayerInteraction {
    return {
      isChatInputCommand: () => true,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      replied: false,
      deferred: false,
      reply: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      followUp: vi.fn(async () => ({ id: 'm-1' })),
    } as unknown as PlayerInteraction;
  }

  /** Paint the board and hand back its description plus the rows behind it. */
  async function paintBoard(): Promise<{ desc: string; essenceBases: number[] }> {
    const interaction = boardInteraction();
    await handleQuests(boardCtx(), interaction, { playerId } as Provisioned);
    const calls = (interaction.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const payload = calls.at(-1)![0] as { embeds: { data: { description?: string } }[] };
    // Read the authored figures back off the rows the board just assigned, so
    // the expectation follows the pool rather than restating it.
    const rows = await app.quests.getDailyQuests(playerId);
    const essenceBases = rows
      .map((r) => parseQuestRewards(r.rewardsJson).essence)
      .filter((e) => e > 0);
    return { desc: payload.embeds[0]!.data.description ?? '', essenceBases };
  }

  it('shows every Essence reward adjusted, and names the bonus once', async () => {
    authorBonus(generousSlug, essenceBonus(30));
    await equipBuddy(generousSlug);

    const { desc, essenceBases } = await paintBoard();
    expect(essenceBases.length).toBeGreaterThan(0);

    for (const base of essenceBases) {
      const adjusted = Math.round(base * 1.3);
      expect(desc, `base ${base}`).toContain(`${adjusted} Essence ✨`);
      // The authored figure is gone from the board — that line was the bug.
      expect(desc, `base ${base}`).not.toContain(`${base} Essence,`);
    }
    // One line for the whole board, however many quests carried a star.
    expect(desc.match(/Extra Serving/g)).toHaveLength(1);
  });

  it('shows the authored figures and no star when no Buddy raises Essence', async () => {
    const { desc, essenceBases } = await paintBoard();
    expect(essenceBases.length).toBeGreaterThan(0);

    for (const base of essenceBases) {
      expect(desc, `base ${base}`).toContain(`${base} Essence`);
    }
    expect(desc).not.toContain('✨');
  });

  it('leaves the Waifubux and item halves of each reward line untouched', async () => {
    // `essence_gain` scales Essence and nothing else, so the board painted
    // with a Buddy must differ from the unbonused one *only* in its Essence
    // clauses. Comparing the two whole boards is the strongest form of that.
    const plain = await paintBoard();

    authorBonus(generousSlug, essenceBonus(30));
    await equipBuddy(generousSlug);
    const bonused = await paintBoard();

    let normalised = bonused.desc;
    for (const base of plain.essenceBases) {
      normalised = normalised.replace(`${Math.round(base * 1.3)} Essence ✨`, `${base} Essence`);
    }
    // Drop the board-level note, which has no counterpart on a plain board.
    normalised = normalised.replace(/\n\n✨ Essence shown includes .*$/, '');
    expect(normalised).toBe(plain.desc);
  });

  it('does not pay anything just by being looked at', async () => {
    authorBonus(generousSlug, essenceBonus(30));
    await equipBuddy(generousSlug);

    await paintBoard();
    await paintBoard();

    expect(await essenceOf()).toBe(0);
  });
});
