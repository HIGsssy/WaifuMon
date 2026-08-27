/**
 * Batched Essence investment — real Postgres.
 *
 * The contract under test: N applications cost N × the base cost and grant
 * N × the base XP, land atomically (an unaffordable batch spends nothing), and
 * produce exactly the appearance unlocks that N separate 1× clicks would.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { playerCurrencies, playerWaifus, species } from '../../src/db/schema';
import {
  InsufficientEssenceError,
  WaifuAtMaxLevelError,
  WaifuNotOwnedError,
} from '../../src/shared/errors';
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

/** Base economy numbers, read from shipped content rather than hard-coded. */
let costPer: number;
let xpPer: number;
let maxLevel: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-essence-batch', 'u-1'));
  const cfg = app.content.tables.waifuProgression;
  costPer = cfg.essenceInvestment.essenceCost;
  xpPer = cfg.essenceInvestment.xpGranted;
  maxLevel = cfg.maxLevel;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
});

async function setEssence(amount: number): Promise<void> {
  await t.db
    .update(playerCurrencies)
    .set({ essence: amount })
    .where(eq(playerCurrencies.playerId, playerId));
}

async function essenceBalance(): Promise<number> {
  const [row] = await t.db
    .select({ essence: playerCurrencies.essence })
    .from(playerCurrencies)
    .where(eq(playerCurrencies.playerId, playerId));
  return row!.essence;
}

async function grantWaifu(slug = 'neko_barista', level = 1, xp = 0): Promise<number> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, slug));
  const row = await insertOwnedWaifu(t.db, { playerId, speciesId: sp!.id, level, xp });
  return row!.id;
}

async function waifuRow(waifuId: number) {
  const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
  return row!;
}

describe('investEssenceBatch — cost and XP scale linearly', () => {
  it.each([1, 5, 10])('%i× costs N × base and grants N × base XP', async (n) => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 20);
    const before = await essenceBalance();

    const result = await app.collection.investEssenceBatch(playerId, waifuId, n);

    expect(result.applications).toBe(n);
    expect(result.essenceSpent).toBe(costPer * n);
    expect(result.xpGranted).toBe(xpPer * n);
    expect(result.essenceBalanceAfter).toBe(before - costPer * n);
    expect(await essenceBalance()).toBe(before - costPer * n);
    expect((await waifuRow(waifuId)).xp).toBe(xpPer * n);
  });

  it('1× through the batch matches 1× through investEssence exactly', async () => {
    await setEssence(costPer * 10);
    const viaLegacy = await grantWaifu();
    const legacy = await app.collection.investEssence(playerId, viaLegacy);

    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
    const viaBatch = await grantWaifu();
    const batch = await app.collection.investEssenceBatch(playerId, viaBatch, 1);

    expect(batch.essenceSpent).toBe(legacy.essenceSpent);
    expect(batch.xpGranted).toBe(legacy.xpGranted);
    expect(batch.toLevel).toBe(legacy.toLevel);
    expect(batch.applications).toBe(1);
    expect(legacy.applications).toBe(1);
  });

  it('5× lands the same level as five separate 1× calls', async () => {
    await setEssence(costPer * 50);
    const stepwise = await grantWaifu();
    for (let i = 0; i < 5; i++) await app.collection.investEssence(playerId, stepwise);
    const stepwiseRow = await waifuRow(stepwise);

    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
    const batched = await grantWaifu();
    await app.collection.investEssenceBatch(playerId, batched, 5);
    const batchedRow = await waifuRow(batched);

    expect(batchedRow.level).toBe(stepwiseRow.level);
    expect(batchedRow.xp).toBe(stepwiseRow.xp);
  });
});

describe('investEssenceBatch — balance handling', () => {
  it('spends an exact balance down to zero', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 3);

    const result = await app.collection.investEssenceBatch(playerId, waifuId, 3);

    expect(result.essenceBalanceAfter).toBe(0);
    expect(await essenceBalance()).toBe(0);
  });

  it('rejects an unaffordable batch atomically — nothing is spent or granted', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 3);

    await expect(
      app.collection.investEssenceBatch(playerId, waifuId, 4),
    ).rejects.toBeInstanceOf(InsufficientEssenceError);

    // The whole point of batching atomically: no partial application.
    expect(await essenceBalance()).toBe(costPer * 3);
    const row = await waifuRow(waifuId);
    expect(row.xp).toBe(0);
    expect(row.level).toBe(1);
  });

  it('rejects a batch one Essence short', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 5 - 1);

    await expect(
      app.collection.investEssenceBatch(playerId, waifuId, 5),
    ).rejects.toBeInstanceOf(InsufficientEssenceError);
    expect(await essenceBalance()).toBe(costPer * 5 - 1);
  });
});

describe('investEssenceBatch — level cap', () => {
  /**
   * Total XP a copy needs to sit exactly at the level cap. Shipped content puts
   * this ~530 applications away from a fresh capture — far beyond one batch —
   * so these tests seed the copy near the ceiling instead of grinding to it.
   */
  function cumulativeXpToMax(): number {
    let total = 0;
    for (let level = 1; level < maxLevel; level++) {
      total += app.collection.waifuXpToNext(level);
    }
    return total;
  }

  it('reports exactly one useful application when one short of the cap', async () => {
    const waifuId = await grantWaifu('neko_barista', 1, cumulativeXpToMax() - xpPer);
    expect(app.collection.maxUsefulApplications(await waifuRow(waifuId))).toBe(1);
  });

  it('clamps at max level when the batch overshoots, still spending the batch', async () => {
    // Two applications' worth of room, but ask for ten: the extra XP is stored
    // and the level clamps — exactly what a 1× at the last rung already does.
    const waifuId = await grantWaifu('neko_barista', 1, cumulativeXpToMax() - xpPer * 2);
    await setEssence(costPer * 20);
    const before = await essenceBalance();

    const result = await app.collection.investEssenceBatch(playerId, waifuId, 10);

    expect(result.toLevel).toBe(maxLevel);
    expect((await waifuRow(waifuId)).level).toBe(maxLevel);
    expect(result.essenceSpent).toBe(costPer * 10);
    expect(await essenceBalance()).toBe(before - costPer * 10);
  });

  it('reports 0 useful applications once she is capped', async () => {
    const waifuId = await grantWaifu('neko_barista', 1, cumulativeXpToMax());
    await setEssence(costPer * 20);
    await app.collection.investEssenceBatch(playerId, waifuId, 1).catch(() => undefined);
    expect(app.collection.maxUsefulApplications(await waifuRow(waifuId))).toBe(0);
  });

  it('refuses to spend once she is already capped', async () => {
    const waifuId = await grantWaifu('neko_barista', maxLevel, cumulativeXpToMax());
    await setEssence(costPer * 20);
    const before = await essenceBalance();

    await expect(
      app.collection.investEssenceBatch(playerId, waifuId, 1),
    ).rejects.toBeInstanceOf(WaifuAtMaxLevelError);
    expect(await essenceBalance()).toBe(before);
  });

  it('a fresh copy needs more applications than one batch allows', async () => {
    // Documents the shape of the shipped curve: the 100-per-batch ceiling is
    // the binding limit for most of a copy's life, not the level cap.
    const waifuId = await grantWaifu();
    expect(app.collection.maxUsefulApplications(await waifuRow(waifuId))).toBeGreaterThan(100);
  });
});

describe('investEssenceBatch — guards', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects a nonsense count (%s)', async (n) => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 50);
    await expect(
      app.collection.investEssenceBatch(playerId, waifuId, n as number),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects a batch above the hard cap', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 10_000);
    await expect(
      app.collection.investEssenceBatch(playerId, waifuId, 101),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects a waifu the player does not own', async () => {
    await setEssence(costPer * 10);
    await expect(
      app.collection.investEssenceBatch(playerId, 999_999, 1),
    ).rejects.toBeInstanceOf(WaifuNotOwnedError);
  });
});

describe('investEssenceBatch — appearance unlocks', () => {
  /**
   * A batch crossing several level milestones must report the same unlocks as
   * the equivalent run of 1× calls — `syncUnlocks` compares the resulting level
   * against `seen_appearances`, so one call after the jump is sufficient.
   */
  it('reports the same unlocks as the equivalent stepwise investment', async () => {
    await setEssence(costPer * 100);

    const stepwise = await grantWaifu();
    const stepwiseUnlocks: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await app.collection.investEssence(playerId, stepwise);
      stepwiseUnlocks.push(...r.newAppearances.map((a) => a.appearanceId));
    }

    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
    await setEssence(costPer * 100);
    const batched = await grantWaifu();
    const batchResult = await app.collection.investEssenceBatch(playerId, batched, 8);

    expect([...batchResult.newAppearances.map((a) => a.appearanceId)].sort()).toEqual(
      [...stepwiseUnlocks].sort(),
    );
  });

  it('records unlocks on the copy so they never re-fire', async () => {
    await setEssence(costPer * 100);
    const waifuId = await grantWaifu();
    const first = await app.collection.investEssenceBatch(playerId, waifuId, 8);

    // Whatever the batch unlocked is now acknowledged on the row.
    const row = await waifuRow(waifuId);
    for (const unlock of first.newAppearances) {
      expect(row.seenAppearances).toContain(unlock.appearanceId);
    }

    const second = await app.collection.investEssenceBatch(playerId, waifuId, 1);
    for (const unlock of first.newAppearances) {
      expect(second.newAppearances.map((a) => a.appearanceId)).not.toContain(unlock.appearanceId);
    }
  });
});
