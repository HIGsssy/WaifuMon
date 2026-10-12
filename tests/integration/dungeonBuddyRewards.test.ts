import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  affectionGifts, affectionGiftRolls, dungeonRuns, playerCurrencies, playerInventory,
  players, playerWaifus, species,
} from '../../src/db/schema';
import type { BuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import { createDungeonAvailabilityProvider } from '../../src/modules/dungeons/dungeonAvailability';
import {
  CombatBuddyRequiredError, WaifuAlreadyReleasedError, WaifuNotOwnedError,
  WaifuReleaseBlockedError, WaifuUnavailableError,
} from '../../src/shared/errors';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { insertOwnedWaifu } from '../helpers/fixtures';

let w: DungeonWorld;
beforeAll(async () => {
  w = await createDungeonWorld();
  await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
  await w.publish();
  await w.publish(singleRoomDungeon([], (d) => { d.key = 't8_exit'; }));
});
afterAll(async () => { await w?.cleanup(); });
const originals = new Map<string, BuddyBonus | undefined>();
afterEach(() => {
  vi.restoreAllMocks();
  for (const [slug, value] of originals) {
    const entry = w.app.content.species.find((s) => s.slug === slug)!;
    if (value) entry.buddyBonus = value;
    else delete entry.buddyBonus;
  }
  originals.clear();
});

const copy = async (id: number) => (await w.t.db.select().from(playerWaifus).where(eq(playerWaifus.id, id)))[0]!;
const authorBonus = (slug: string, effectId: BuddyBonus['effectId'], value: number) => {
  const entry = w.app.content.species.find((s) => s.slug === slug)!;
  if (!originals.has(slug)) originals.set(slug, entry.buddyBonus);
  entry.buddyBonus = { effectId, value, name: 'T8 Bonus', flavorText: '' };
};
async function pair() {
  const { playerId, buddyId } = await w.player();
  const fighter = await copy(buddyId!);
  const other = await insertOwnedWaifu(w.t.db, { playerId, speciesId: fighter.speciesId, level: 35, baseSp: 100 });
  const [speciesRow] = await w.t.db.select().from(species).where(eq(species.id, fighter.speciesId));
  return { playerId, fighterId: fighter.id, otherId: other.id, slug: speciesRow!.slug };
}
const award = (playerId: number, waifuId: number, baseAmount = 3, bonusPercent = 25) =>
  w.t.db.transaction((tx) => w.app.collection.awardCopyAffection(tx, { playerId, waifuId, baseAmount, bonusPercent }));
const reasons = (playerId: number, waifuId: number) => w.app.availability.reasonsFor(w.t.db, playerId, waifuId);

/** Wait for real PostgreSQL blocking, never a timing guess about who acquired a lock. */
async function blocked(fragment: string) {
  await vi.waitFor(async () => {
    const result = await w.t.pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1",
      [`%${fragment}%`],
    );
    expect(result.rows[0].n).toBeGreaterThan(0);
  }, { timeout: 5000, interval: 20 });
}
function barrier() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

describe('copy-targeted affection', () => {
  it('awards the pinned copy after Buddy switching, using supplied rather than live bonuses', async () => {
    const { playerId, fighterId, otherId, slug } = await pair();
    authorBonus(slug, 'affection_gain', 100);
    await w.app.collection.setBuddy(playerId, otherId);
    expect(await award(playerId, fighterId)).toEqual({ waifuId: fighterId, baseAmount: 3, granted: 4, affectionBefore: 0, affectionAfter: 4 });
    expect((await copy(otherId)).affection).toBe(0);
  });

  it.each([[1, 50, 2], [3, 25, 4], [2, 7, 2], [3, 17.5, 4], [3, 0, 3]])(
    'rounds base %i with %s percent to %i', async (base, percent, granted) => {
      const { playerId, fighterId } = await pair();
      const result = await award(playerId, fighterId, base, percent);
      expect(result).toMatchObject({ baseAmount: base, granted, affectionBefore: 0, affectionAfter: granted });
    },
  );

  it('throws typed errors for missing, foreign and released recipients', async () => {
    const a = await pair();
    const b = await pair();
    await expect(award(a.playerId, b.fighterId)).rejects.toBeInstanceOf(WaifuNotOwnedError);
    await expect(award(a.playerId, 9_000_000)).rejects.toBeInstanceOf(WaifuNotOwnedError);
    await w.app.collection.setBuddy(a.playerId, a.otherId);
    await w.app.collection.releaseWaifu(a.playerId, a.fighterId);
    await expect(award(a.playerId, a.fighterId)).rejects.toBeInstanceOf(WaifuAlreadyReleasedError);
  });

  it('changes only affection: no XP, levels, gifts, pity, currency or inventory', async () => {
    const { playerId, fighterId } = await pair();
    await w.t.db.update(playerWaifus).set({ affection: 999, giftRollCounter: 7 }).where(eq(playerWaifus.id, fighterId));
    const before = await copy(fighterId);
    const playerBefore = await w.t.db.select().from(players).where(eq(players.id, playerId));
    const currencyBefore = await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId));
    const inventoryBefore = await w.t.db.select().from(playerInventory).where(eq(playerInventory.playerId, playerId));
    await award(playerId, fighterId, 100, 50);
    expect(await copy(fighterId)).toEqual({ ...before, affection: 1149 });
    expect(await w.t.db.select().from(players).where(eq(players.id, playerId))).toEqual(playerBefore);
    expect(await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId))).toEqual(currencyBefore);
    expect(await w.t.db.select().from(playerInventory).where(eq(playerInventory.playerId, playerId))).toEqual(inventoryBefore);
    expect(await w.t.db.select().from(affectionGifts).where(eq(affectionGifts.playerId, playerId))).toEqual([]);
    expect(await w.t.db.select().from(affectionGiftRolls).where(eq(affectionGiftRolls.playerId, playerId))).toEqual([]);
  });

  it('serialises concurrent awards without lost increments', async () => {
    const { playerId, fighterId } = await pair();
    const results = await Promise.all(Array.from({ length: 5 }, () => award(playerId, fighterId)));
    expect(results.map((r) => r.affectionAfter).sort((a, b) => a - b)).toEqual([4, 8, 12, 16, 20]);
    expect((await copy(fighterId)).affection).toBe(20);
  });

  it('rollback leaves affection unchanged', async () => {
    const { playerId, fighterId } = await pair();
    await expect(w.t.db.transaction(async (tx) => {
      await w.app.collection.awardCopyAffection(tx, { playerId, waifuId: fighterId, baseAmount: 3, bonusPercent: 25 });
      throw new Error('forced affection rollback');
    })).rejects.toThrow('forced affection rollback');
    expect((await copy(fighterId)).affection).toBe(0);
  });

  it('existing Buddy awards retain bonus reporting and no-Buddy/stale-pointer null behaviour', async () => {
    const { playerId, fighterId, slug } = await pair();
    authorBonus(slug, 'affection_gain', 25);
    const result = await w.t.db.transaction((tx) => w.app.collection.awardBuddyAffection(tx, playerId, 3));
    expect(result).toMatchObject({ waifu: { id: fighterId, affection: 4 }, affectionGranted: 4, xpGranted: 0, fromLevel: 35, toLevel: 35, newAppearances: [], xpBonus: null });
    expect(result!.affectionBonus).not.toBeNull();
    await w.app.collection.clearBuddy(playerId);
    expect(await w.t.db.transaction((tx) => w.app.collection.awardBuddyAffection(tx, playerId, 3))).toBeNull();
    await w.t.db.update(playerWaifus).set({ releasedAt: new Date() }).where(eq(playerWaifus.id, fighterId));
    await w.t.db.update(players).set({ buddyWaifuId: fighterId }).where(eq(players.id, playerId));
    expect(await w.t.db.transaction((tx) => w.app.collection.awardBuddyAffection(tx, playerId, 3))).toBeNull();
    expect((await w.t.db.select().from(players).where(eq(players.id, playerId)))[0]!.buddyWaifuId).toBeNull();
  });

  it.each([{ baseAmount: 0, bonusPercent: 0 }, { baseAmount: 1.5, bonusPercent: 0 }, { baseAmount: 1, bonusPercent: NaN }, { baseAmount: 1, bonusPercent: -1 }])('refuses invalid award input %o', async (input) => {
    const { playerId, fighterId } = await pair();
    await expect(award(playerId, fighterId, input.baseAmount, input.bonusPercent)).rejects.toBeInstanceOf(RangeError);
    expect((await copy(fighterId)).affection).toBe(0);
  });
});

describe('active dungeon reservation and pinned bonuses', () => {
  it('blocks release/conversion of only the participant, while permitting Buddy switching and other releases', async () => {
    const { playerId, fighterId, otherId } = await pair();
    await w.runs.start(playerId, 'test_tunnels', { seed: 11 });
    await w.app.collection.setBuddy(playerId, otherId);
    expect(await reasons(playerId, fighterId)).toEqual(['in_dungeon']);
    const map = await w.app.availability.reasonsForMany(w.t.db, playerId, [fighterId, otherId]);
    expect(map.get(fighterId)).toEqual(['in_dungeon']);
    expect(map.get(otherId)).toEqual(['buddy']);
    await expect(w.app.collection.releaseWaifu(playerId, fighterId)).rejects.toMatchObject({
      code: 'WAIFU_RELEASE_BLOCKED', reasons: ['in_dungeon'], userMessage: 'She is in a dungeon run. Finish or abandon the run first.',
    });
    await expect(w.app.collection.convertDuplicateToEssence(playerId, fighterId, { force: true })).rejects.toBeInstanceOf(WaifuUnavailableError);
    await w.app.collection.setBuddy(playerId, fighterId);
    await w.app.collection.releaseWaifu(playerId, otherId);
    expect((await copy(otherId)).releasedAt).not.toBeNull();
    expect((await copy(fighterId)).releasedAt).toBeNull();
  });

  it.each(['abandoned', 'completed'] as const)('reservation ends naturally when the run is %s', async (end) => {
    const { playerId, fighterId, otherId } = await pair();
    const run = await w.runs.start(playerId, end === 'completed' ? 't8_exit' : 'test_tunnels', { seed: 11 });
    await w.app.collection.setBuddy(playerId, otherId);
    const result = await w.act(playerId, run, end === 'completed' ? { type: 'move', connectionId: 'c_out' } : { type: 'abandon' });
    expect(result.run.status).toBe(end);
    expect(await reasons(playerId, fighterId)).toEqual([]);
    await w.app.collection.convertDuplicateToEssence(playerId, fighterId);
    expect((await copy(fighterId)).releasedAt).not.toBeNull();
  });

  it.each(['affection_gain', 'essence_gain'] as const)('start pins %s once and never grants rewards', async (effectId) => {
    const { playerId, fighterId, otherId, slug } = await pair();
    authorBonus(slug, effectId, 25);
    const before = await copy(fighterId);
    const balances = await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId));
    const lookup = vi.spyOn(w.app.buddyBonus, 'bonusForSpeciesSlug');
    const run = await w.runs.start(playerId, 'test_tunnels', { seed: 11 });
    expect(lookup).toHaveBeenCalledTimes(1);
    const pinned = {
      affectionGainPercent: effectId === 'affection_gain' ? 25 : 0,
      essenceGainPercent: effectId === 'essence_gain' ? 25 : 0,
      source: { speciesSlug: slug, effectId, bonusName: 'T8 Bonus' },
    };
    expect(run.fighter.rewardBonuses).toEqual(pinned);
    expect(await copy(fighterId)).toEqual(before);
    expect(await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId))).toEqual(balances);
    authorBonus(slug, effectId, 100);
    await w.app.collection.setBuddy(playerId, otherId);
    const reloaded = (await w.restartedRuns().activeRun(playerId))!;
    expect(reloaded.fighter.rewardBonuses).toEqual(pinned);
    expect(reloaded.fighter.waifuId).toBe(fighterId);
    expect((await w.runs.history(run.id))[0]!.payload.fighter).toMatchObject({ rewardBonuses: pinned });
  });

  it('historical fighter snapshots stay readable and reserved without adding rewardBonuses', async () => {
    const { playerId, fighterId, otherId } = await pair();
    const run = await w.runs.start(playerId, 'test_tunnels', { seed: 11 });
    const { rewardBonuses: _removed, ...historical } = run.fighter;
    await w.t.db.update(dungeonRuns).set({ fighter: historical as unknown as Record<string, unknown> }).where(eq(dungeonRuns.id, run.id));
    await w.app.collection.setBuddy(playerId, otherId);
    expect((await w.restartedRuns().activeRun(playerId))!.fighter).toEqual(historical);
    expect(await reasons(playerId, fighterId)).toEqual(['in_dungeon']);
    await w.act(playerId, (await w.runs.activeRun(playerId))!, { type: 'advance' });
    expect(Object.hasOwn((await w.runs.activeRun(playerId))!.fighter, 'rewardBonuses')).toBe(false);
  });

  it('empty bulk availability performs no query and another player cannot reserve a copy', async () => {
    const a = await pair();
    const b = await pair();
    await w.runs.start(a.playerId, 'test_tunnels', { seed: 11 });
    const tx = { select: () => { throw new Error('unexpected query'); } };
    expect(await createDungeonAvailabilityProvider()(tx as never, a.playerId, [])).toEqual(new Map());
    expect(await createDungeonAvailabilityProvider()(w.t.db, b.playerId, [a.fighterId])).toEqual(new Map());
  });
});

describe('lock safety', () => {
  it('start commits its reservation before a waiting release can succeed, even after Buddy clear', async () => {
    const { playerId, fighterId } = await pair();
    const selected = barrier();
    const proceed = barrier();
    const snapshot = w.stats.snapshotCombatStats.bind(w.stats);
    vi.spyOn(w.stats, 'snapshotCombatStats').mockImplementation(async (tx, id) => {
      const stats = await snapshot(tx, id);
      selected.open();
      await proceed.promise;
      return stats;
    });
    const start = w.runs.start(playerId, 'test_tunnels', { seed: 11 });
    await selected.promise;
    let clearing: ReturnType<typeof w.app.collection.clearBuddy> | undefined;
    let release: Promise<unknown> | undefined;
    try {
      clearing = w.app.collection.clearBuddy(playerId);
      await blocked('update "players"');
      release = w.app.collection.releaseWaifu(playerId, fighterId).catch((err: unknown) => err);
      await blocked('select "buddy_waifu_id" from "players"');
    } finally { proceed.open(); }
    const run = await start;
    await clearing;
    expect(await release).toBeInstanceOf(WaifuReleaseBlockedError);
    expect(await release).toMatchObject({ reasons: ['in_dungeon'] });
    expect(run.fighter.waifuId).toBe(fighterId);
    expect((await copy(fighterId)).releasedAt).toBeNull();
  });

  it('a release that wins the player lock leaves no fighter for a waiting start', async () => {
    const { playerId, fighterId } = await pair();
    await w.app.collection.clearBuddy(playerId);
    const entered = barrier();
    const proceed = barrier();
    const availability = w.app.availability.reasonsFor.bind(w.app.availability);
    vi.spyOn(w.app.availability, 'reasonsFor').mockImplementation(async (tx, id, waifuId) => {
      const result = await availability(tx, id, waifuId);
      entered.open();
      await proceed.promise;
      return result;
    });
    const release = w.app.collection.releaseWaifu(playerId, fighterId);
    await entered.promise;
    const start = w.runs.start(playerId, 'test_tunnels', { seed: 11 }).catch((err: unknown) => err);
    try { await blocked('select "id", "current_region" from "players"'); }
    finally { proceed.open(); }
    await release;
    expect(await start).toBeInstanceOf(CombatBuddyRequiredError);
    expect(await w.runs.activeRun(playerId)).toBeNull();
  });

  it('award holds the copy until commit; a following release preserves the committed affection', async () => {
    const { playerId, fighterId, otherId } = await pair();
    await w.app.collection.setBuddy(playerId, otherId);
    const awarded = barrier();
    const proceed = barrier();
    const pending = w.t.db.transaction(async (tx) => {
      const result = await w.app.collection.awardCopyAffection(tx, { playerId, waifuId: fighterId, baseAmount: 3, bonusPercent: 25 });
      awarded.open();
      await proceed.promise;
      return result;
    });
    await awarded.promise;
    const release = w.app.collection.releaseWaifu(playerId, fighterId);
    try { await blocked('from "player_waifus"'); }
    finally { proceed.open(); }
    expect(await pending).toMatchObject({ granted: 4 });
    await release;
    expect(await copy(fighterId)).toMatchObject({ affection: 4 });
    expect((await copy(fighterId)).releasedAt).not.toBeNull();
  });

  it('release holds the copy until commit; a waiting award fails instead of paying a released recipient', async () => {
    const { playerId, fighterId, otherId } = await pair();
    await w.app.collection.setBuddy(playerId, otherId);
    const entered = barrier();
    const proceed = barrier();
    const availability = w.app.availability.reasonsFor.bind(w.app.availability);
    vi.spyOn(w.app.availability, 'reasonsFor').mockImplementation(async (tx, id, waifuId) => {
      const result = await availability(tx, id, waifuId);
      entered.open();
      await proceed.promise;
      return result;
    });
    const release = w.app.collection.releaseWaifu(playerId, fighterId);
    await entered.promise;
    const pending = award(playerId, fighterId).catch((err: unknown) => err);
    try { await blocked('from "player_waifus"'); }
    finally { proceed.open(); }
    await release;
    expect(await pending).toBeInstanceOf(WaifuAlreadyReleasedError);
    expect((await copy(fighterId)).affection).toBe(0);
  });
});
