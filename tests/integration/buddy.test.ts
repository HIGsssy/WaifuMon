/**
 * Buddy + individual Waifumon progression integration tests.
 * Covers set/get/clear buddy, cross-player safety, release/convert buddy
 * guard, buddy auto-clear on soft-release, buddy hunt XP+affection award,
 * Essence investment + level-up, nickname unlock gate.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  captureAttempts,
  encounters,
  playerCurrencies,
  playerInventory,
  playerProgressionEvents,
  playerWaifus,
  players,
  species,
  type PlayerWaifuRow,
} from '../../src/db/schema';
import {
  InsufficientEssenceError,
  WaifuAlreadyReleasedError,
  WaifuIsBuddyError,
  WaifuNicknameTooEarlyError,
  WaifuNotOwnedError,
} from '../../src/shared/errors';
import type { Rng } from '../../src/shared/random';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
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

function scriptedRng(nexts: number[]): Rng {
  let i = 0;
  return {
    next: () => {
      if (i >= nexts.length) throw new Error(`scriptedRng exhausted at ${i}`);
      return nexts[i++]!;
    },
    intInclusive(min, max) {
      const v = nexts[i++]!;
      return Math.floor(v * (max - min + 1)) + min;
    },
  };
}

async function resetPlayer(playerId: number, essence = 0): Promise<void> {
  await t.db
    .delete(playerProgressionEvents)
    .where(eq(playerProgressionEvents.playerId, playerId));
  await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, playerId));
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db
    .update(players)
    .set({ xp: 0, level: 1, lastHuntAt: null, buddyWaifuId: null })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: 25, waifubux: 0, essence })
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

describe('CollectionService — buddy set/get/clear', () => {
  let playerId: number;
  let otherId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-buddy-set', 'u-1'));
    ({ playerId: otherId } = await provisionPlayer(app, 'g-buddy-set', 'u-2'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId);
    await resetPlayer(otherId);
  });

  it('setBuddy stores the pointer on the player row', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista');
    const result = await app.collection.setBuddy(playerId, mine.id);
    expect(result.player.buddyWaifuId).toBe(mine.id);
    expect(result.buddy.species.slug).toBe('neko_barista');
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.buddyWaifuId).toBe(mine.id);
  });

  it('getBuddy returns the active entry, or null when unset / soft-released', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista');
    await app.collection.setBuddy(playerId, mine.id);
    const buddy = await app.collection.getBuddy(playerId);
    expect(buddy?.waifu.id).toBe(mine.id);
    // Soft-release the underlying row directly to simulate an orphaned pointer.
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, mine.id));
    expect(await app.collection.getBuddy(playerId)).toBeNull();
  });

  it('clearBuddy sets the pointer back to null', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista');
    await app.collection.setBuddy(playerId, mine.id);
    const player = await app.collection.clearBuddy(playerId);
    expect(player.buddyWaifuId).toBeNull();
    expect(await app.collection.getBuddy(playerId)).toBeNull();
  });

  it('cannot set another player\'s waifu as buddy', async () => {
    const theirs = await grantWaifu(otherId, 'neko_barista');
    await expect(app.collection.setBuddy(playerId, theirs.id)).rejects.toBeInstanceOf(
      WaifuNotOwnedError,
    );
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.buddyWaifuId).toBeNull();
  });

  it('cannot set a released waifu as buddy', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista');
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, mine.id));
    await expect(app.collection.setBuddy(playerId, mine.id)).rejects.toBeInstanceOf(
      WaifuAlreadyReleasedError,
    );
  });
});

describe('release / convert guard against active buddy', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-buddy-guard', 'u-1'));
  });
  beforeEach(() => resetPlayer(playerId));

  it('release refuses the active buddy', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista');
    await app.collection.setBuddy(playerId, mine.id);
    await expect(app.collection.releaseWaifu(playerId, mine.id)).rejects.toBeInstanceOf(
      WaifuIsBuddyError,
    );
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, mine.id));
    expect(row?.releasedAt).toBeNull();
  });

  it('release refuses even with force=true (buddy check is unconditional)', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista', { isFavorite: true });
    await app.collection.setBuddy(playerId, mine.id);
    await expect(
      app.collection.releaseWaifu(playerId, mine.id, { force: true }),
    ).rejects.toBeInstanceOf(WaifuIsBuddyError);
  });

  it('convertDuplicateToEssence refuses the active buddy', async () => {
    // Two copies so we clear the duplicate check.
    const a = await grantWaifu(playerId, 'neko_barista');
    await grantWaifu(playerId, 'neko_barista');
    await app.collection.setBuddy(playerId, a.id);
    await expect(
      app.collection.convertDuplicateToEssence(playerId, a.id),
    ).rejects.toBeInstanceOf(WaifuIsBuddyError);
  });

  it('once the buddy is cleared, release proceeds normally', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista');
    await app.collection.setBuddy(playerId, mine.id);
    await app.collection.clearBuddy(playerId);
    const result = await app.collection.releaseWaifu(playerId, mine.id);
    expect(result.essenceGranted).toBeGreaterThan(0);
  });
});

describe('buddy hunt reward', () => {
  it('active buddy gains XP + affection on each hunt; no-op without a buddy', async () => {
    const { playerId } = await provisionPlayer(app, 'g-buddy-hunt', 'u-1');
    await resetPlayer(playerId);
    // First hunt without a buddy: baseline.
    const noBuddyApp = await bootstrapApp(t, { huntRng: scriptedRng([0.99, 0.0]) });
    const r0 = await noBuddyApp.hunt.hunt(playerId, 'c-1');
    expect(r0.kind).toBe('flavor');
    expect(r0.buddyAward).toBeNull();

    // Now set a buddy and hunt again.
    const mine = await grantWaifu(playerId, 'neko_barista');
    await app.collection.setBuddy(playerId, mine.id);
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));

    const buddyApp = await bootstrapApp(t, { huntRng: scriptedRng([0.99, 0.0]) });
    const r1 = await buddyApp.hunt.hunt(playerId, 'c-1');
    expect(r1.buddyAward).not.toBeNull();
    expect(r1.buddyAward?.xpGranted).toBe(app.content.tables.waifuProgression.buddy.xpPerHunt);
    expect(r1.buddyAward?.affectionGranted).toBe(
      app.content.tables.waifuProgression.buddy.affectionPerHunt,
    );
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, mine.id));
    expect(row?.xp).toBe(app.content.tables.waifuProgression.buddy.xpPerHunt);
    expect(row?.affection).toBe(app.content.tables.waifuProgression.buddy.affectionPerHunt);
  });

  it('buddy XP eventually crosses the waifu level threshold', async () => {
    const { playerId } = await provisionPlayer(app, 'g-buddy-level', 'u-1');
    await resetPlayer(playerId);
    const mine = await grantWaifu(playerId, 'neko_barista');
    await app.collection.setBuddy(playerId, mine.id);

    // Buddy hunts directly via the service to avoid hunt cooldown/energy plumbing.
    const target = app.content.tables.waifuProgression.levelCurve.base; // XP for lvl 1→2
    const perHunt = app.content.tables.waifuProgression.buddy.xpPerHunt;
    const huntsNeeded = Math.ceil(target / perHunt);
    for (let i = 0; i < huntsNeeded; i++) {
      await t.db.transaction(async (tx) => app.collection.awardBuddyOnHunt(tx, playerId));
    }
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, mine.id));
    expect(row?.level).toBeGreaterThanOrEqual(2);
  });
});

describe('Essence investment', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-invest', 'u-1'));
  });
  beforeEach(() => resetPlayer(playerId, /* essence */ 200));

  it('spends the essence and grants configured XP', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista');
    const cfg = app.content.tables.waifuProgression.essenceInvestment;
    const result = await app.collection.investEssence(playerId, mine.id);
    expect(result.essenceSpent).toBe(cfg.essenceCost);
    expect(result.xpGranted).toBe(cfg.xpGranted);
    expect(result.essenceBalanceAfter).toBe(200 - cfg.essenceCost);
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, mine.id));
    expect(row?.xp).toBe(cfg.xpGranted);
  });

  it('levels up the waifu when the grant crosses the curve threshold', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista');
    // Level 1→2 needs `base` XP. With grant 25 and base 30, one invest ends at 25 (still lvl 1);
    // second invest crosses into lvl 2.
    const cfg = app.content.tables.waifuProgression.essenceInvestment;
    const base = app.content.tables.waifuProgression.levelCurve.base;
    const needed = Math.ceil(base / cfg.xpGranted);
    // Make sure we have enough essence.
    await t.db
      .update(playerCurrencies)
      .set({ essence: needed * cfg.essenceCost + 10 })
      .where(eq(playerCurrencies.playerId, playerId));
    let last;
    for (let i = 0; i < needed; i++) {
      last = await app.collection.investEssence(playerId, mine.id);
    }
    expect(last!.toLevel).toBeGreaterThanOrEqual(2);
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, mine.id));
    expect(row?.level).toBeGreaterThanOrEqual(2);
  });

  it('rejects when essence balance is insufficient — nothing changes', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista');
    await t.db
      .update(playerCurrencies)
      .set({ essence: 0 })
      .where(eq(playerCurrencies.playerId, playerId));
    await expect(app.collection.investEssence(playerId, mine.id)).rejects.toBeInstanceOf(
      InsufficientEssenceError,
    );
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, mine.id));
    expect(row?.xp).toBe(0);
  });

  it('cannot invest in another player\'s waifu', async () => {
    const { playerId: otherId } = await provisionPlayer(app, 'g-invest', 'u-2');
    await resetPlayer(otherId);
    const theirs = await grantWaifu(otherId, 'neko_barista');
    await expect(app.collection.investEssence(playerId, theirs.id)).rejects.toBeInstanceOf(
      WaifuNotOwnedError,
    );
  });
});

describe('nickname unlock gate', () => {
  it('blocks nickname below configured minimum, allows at threshold', async () => {
    const { playerId } = await provisionPlayer(app, 'g-nickname', 'u-1');
    await resetPlayer(playerId);
    const mine = await grantWaifu(playerId, 'neko_barista');
    const min = app.content.tables.waifuProgression.nicknameMinLevel;
    // Level 1 waifu → nickname refused.
    await expect(
      app.collection.setNickname(playerId, mine.id, 'Foxy'),
    ).rejects.toBeInstanceOf(WaifuNicknameTooEarlyError);
    // Bump the waifu to the threshold and try again.
    await t.db.update(playerWaifus).set({ level: min }).where(eq(playerWaifus.id, mine.id));
    const updated = await app.collection.setNickname(playerId, mine.id, 'Foxy');
    expect(updated.nickname).toBe('Foxy');
    // Empty string clears the nickname.
    const cleared = await app.collection.setNickname(playerId, mine.id, '  ');
    expect(cleared.nickname).toBeNull();
  });

  it('cross-player: cannot nickname another player\'s waifu', async () => {
    const { playerId } = await provisionPlayer(app, 'g-nickname', 'u-3');
    const { playerId: otherId } = await provisionPlayer(app, 'g-nickname', 'u-4');
    await resetPlayer(otherId);
    const theirs = await grantWaifu(otherId, 'neko_barista', { level: 10 });
    await expect(
      app.collection.setNickname(playerId, theirs.id, 'hax'),
    ).rejects.toBeInstanceOf(WaifuNotOwnedError);
  });
});

describe('level curve math (waifu)', () => {
  it('waifuXpToNext follows base + growth × (level − 1) and returns 0 at max', () => {
    const cfg = app.content.tables.waifuProgression;
    expect(app.collection.waifuXpToNext(1)).toBe(cfg.levelCurve.base);
    expect(app.collection.waifuXpToNext(2)).toBe(cfg.levelCurve.base + cfg.levelCurve.growth);
    expect(app.collection.waifuXpToNext(cfg.maxLevel)).toBe(0);
  });
});
