import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dailyClaims } from '../../src/db/schema';
import { AlreadyClaimedError } from '../../src/shared/errors';
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

const DAY1 = new Date('2026-07-15T12:00:00Z');
const DAY2 = new Date('2026-07-16T00:00:01Z');

describe('daily claim', () => {
  it('grants energy refill, WaifuBux, and the charm pack', async () => {
    const { playerId } = await provisionPlayer(app, 'g-daily', 'u-1');
    await app.currency.setHuntEnergy(t.db, playerId, 3); // partially spent

    const result = await app.daily.claim(playerId, DAY1);
    expect(result.claimDate).toBe('2026-07-15');
    expect(result.energySetTo).toBe(25);
    expect(result.waifubux).toBe(100);
    expect(
      Object.fromEntries(result.items.map(({ item, quantity }) => [item.slug, quantity])),
    ).toEqual({ basic_charm: 5, silk_charm: 2, velvet_charm: 1 });

    const balances = await app.currency.getBalances(playerId);
    expect(balances.huntEnergy).toBe(25);
    expect(balances.waifubux).toBe(100);
    const basic = await getItemBySlug(t.db, 'basic_charm');
    expect(await app.inventory.getQuantity(playerId, basic.id)).toBe(5);
  });

  it('records the claim with a rewards payload', async () => {
    const { playerId } = await provisionPlayer(app, 'g-daily', 'u-1');
    const [row] = await t.db
      .select()
      .from(dailyClaims)
      .where(eq(dailyClaims.playerId, playerId));
    expect(row?.claimDate).toBe('2026-07-15');
    expect(row?.rewards).toMatchObject({ waifubux: 100, energySetTo: 25 });
  });

  it('blocks a second claim the same day (unique constraint) and grants nothing', async () => {
    const { playerId } = await provisionPlayer(app, 'g-daily', 'u-1');
    await expect(app.daily.claim(playerId, DAY1)).rejects.toBeInstanceOf(AlreadyClaimedError);
    const balances = await app.currency.getBalances(playerId);
    expect(balances.waifubux).toBe(100); // unchanged
    const basic = await getItemBySlug(t.db, 'basic_charm');
    expect(await app.inventory.getQuantity(playerId, basic.id)).toBe(5); // unchanged
  });

  it('allows claiming again the next calendar day', async () => {
    const { playerId } = await provisionPlayer(app, 'g-daily', 'u-1');
    const result = await app.daily.claim(playerId, DAY2);
    expect(result.claimDate).toBe('2026-07-16');
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(200);
  });

  it('exactly one concurrent claim succeeds', async () => {
    const { playerId } = await provisionPlayer(app, 'g-daily', 'u-race');
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => app.daily.claim(playerId, DAY1)),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(5);
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyClaimedError);
    }
    // Rewards applied exactly once.
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(100);
  });

  it('respects the configured timezone for the calendar-day boundary', async () => {
    const tokyoApp = await bootstrapApp(t, 'Asia/Tokyo');
    const { playerId } = await provisionPlayer(tokyoApp, 'g-daily-tz', 'u-1');
    // 23:30Z Jul 15 is already Jul 16 in Tokyo.
    const result = await tokyoApp.daily.claim(playerId, new Date('2026-07-15T23:30:00Z'));
    expect(result.claimDate).toBe('2026-07-16');
  });

  it('reports claim status', async () => {
    const { playerId } = await provisionPlayer(app, 'g-daily', 'u-status');
    expect((await app.daily.status(playerId, DAY1)).claimedToday).toBe(false);
    await app.daily.claim(playerId, DAY1);
    expect((await app.daily.status(playerId, DAY1)).claimedToday).toBe(true);
    expect((await app.daily.status(playerId, DAY2)).claimedToday).toBe(false);
  });
});
