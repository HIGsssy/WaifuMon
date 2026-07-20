/**
 * Care Mode (Milestone 5B) integration tests.
 * Real Postgres, real transactions — the whole point of Care Mode is that
 * ticks accrue idempotently under concurrent hits and interact cleanly with
 * hunt/daily. Time is injected via `now?: Date` on every service call.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  captureAttempts,
  dailyClaims,
  encounters,
  playerCurrencies,
  playerInventory,
  playerProgressionEvents,
  playerWaifus,
  players,
  species,
  type PlayerWaifuRow,
} from '../../src/db/schema';
import { AlreadyClaimedError, InsufficientEnergyError } from '../../src/shared/errors';
import { createHuntService } from '../../src/modules/hunt/huntService';
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

async function resetPlayer(playerId: number, huntEnergy = 25): Promise<void> {
  await t.db
    .delete(playerProgressionEvents)
    .where(eq(playerProgressionEvents.playerId, playerId));
  await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, playerId));
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db.delete(dailyClaims).where(eq(dailyClaims.playerId, playerId));
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

const INTERVAL_MIN = 30;
const T0 = new Date('2026-07-15T12:00:00Z');
const later = (mins: number): Date => new Date(T0.getTime() + mins * 60 * 1000);

// ─────────────────────── start / target selection ───────────────────────

describe('CareService.start — target selection', () => {
  let playerId: number;
  let otherId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-care-start', 'u-1'));
    ({ playerId: otherId } = await provisionPlayer(app, 'g-care-start', 'u-2'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId);
    await resetPlayer(otherId);
  });

  it('defaults to the active buddy when no explicit target is given', async () => {
    const buddy = await grantWaifu(playerId, 'neko_barista');
    await app.collection.setBuddy(playerId, buddy.id);
    const summary = await app.care.start(playerId, null, T0);
    expect(summary.active).toBe(true);
    expect(summary.target?.waifu.id).toBe(buddy.id);
    const [row] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(row?.careModeWaifuId).toBe(buddy.id);
    expect(row?.careModeStartedAt?.getTime()).toBe(T0.getTime());
    expect(row?.careModeLastTickAt?.getTime()).toBe(T0.getTime());
  });

  it('requires an explicit target when the player has no buddy', async () => {
    await expect(app.care.start(playerId, null, T0)).rejects.toMatchObject({
      name: 'WaifuNotOwnedError',
    });
    // No state written — care fields still null.
    const [row] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(row?.careModeWaifuId).toBeNull();
  });

  it('accepts an explicit owned target (not necessarily the buddy)', async () => {
    const buddy = await grantWaifu(playerId, 'neko_barista');
    const other = await grantWaifu(playerId, 'gym_oni');
    await app.collection.setBuddy(playerId, buddy.id);
    const summary = await app.care.start(playerId, other.id, T0);
    expect(summary.target?.waifu.id).toBe(other.id);
  });

  it('rejects another player’s Waifumon', async () => {
    const theirs = await grantWaifu(otherId, 'neko_barista');
    await expect(app.care.start(playerId, theirs.id, T0)).rejects.toMatchObject({
      name: 'WaifuNotOwnedError',
    });
  });

  it('rejects a soft-released Waifumon', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista', { releasedAt: new Date() });
    await expect(app.care.start(playerId, mine.id, T0)).rejects.toMatchObject({
      name: 'WaifuAlreadyReleasedError',
    });
  });

  it('starting twice with the same target does not reset last_tick_at', async () => {
    const mine = await grantWaifu(playerId, 'neko_barista');
    await app.care.start(playerId, mine.id, T0);
    // 10 minutes later: bare re-start — should not reset accumulated timing.
    await app.care.start(playerId, mine.id, later(10));
    const [row] = await t.db.select().from(players).where(eq(players.id, playerId));
    // last_tick_at stays at T0 (no ticks yet); started_at stays at T0.
    expect(row?.careModeLastTickAt?.getTime()).toBe(T0.getTime());
    expect(row?.careModeStartedAt?.getTime()).toBe(T0.getTime());
  });
});

// ──────────────────────── lazy tick calculation ────────────────────────

describe('CareService.applyPending — lazy tick math', () => {
  let playerId: number;
  let waifu: PlayerWaifuRow;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-care-ticks', 'u-1'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId, 0);
    waifu = await grantWaifu(playerId, 'neko_barista');
    await app.care.start(playerId, waifu.id, T0);
  });

  it('29 minutes → 0 ticks', async () => {
    const summary = await app.care.applyPending(playerId, later(29));
    expect(summary.active).toBe(true);
    expect(summary.ticksProcessed).toBe(0);
    expect(summary.energyGained).toBe(0);
    expect(summary.waifuXpGained).toBe(0);
    expect(summary.affectionGained).toBe(0);
  });

  it('30 minutes → 1 tick (+1 energy, +2 xp, +1 affection)', async () => {
    const summary = await app.care.applyPending(playerId, later(INTERVAL_MIN));
    expect(summary.ticksProcessed).toBe(1);
    expect(summary.energyGained).toBe(1);
    expect(summary.waifuXpGained).toBe(2);
    expect(summary.affectionGained).toBe(1);
    const bal = await app.currency.getBalances(playerId);
    expect(bal.huntEnergy).toBe(1);
    const [w] = await t.db
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, waifu.id));
    expect(w?.xp).toBe(2);
    expect(w?.affection).toBe(1);
  });

  it('90 minutes → 3 ticks', async () => {
    const summary = await app.care.applyPending(playerId, later(90));
    expect(summary.ticksProcessed).toBe(3);
    expect(summary.energyGained).toBe(3);
    expect(summary.waifuXpGained).toBe(6);
    expect(summary.affectionGained).toBe(3);
    // last_tick_at advanced by exactly 3 * interval (partial 0m preserved).
    const [row] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(row?.careModeLastTickAt?.getTime()).toBe(
      T0.getTime() + 3 * INTERVAL_MIN * 60 * 1000,
    );
  });

  it('energy recovery caps at 20 (careMode.recoveryCap)', async () => {
    // Level 1 max energy = 25 > 20, so cap is 20.
    await app.currency.setHuntEnergy(t.db, playerId, 19);
    // 5 ticks (150 min) would grant 5 energy but only 1 fits under cap.
    const summary = await app.care.applyPending(playerId, later(150));
    expect(summary.ticksProcessed).toBe(5);
    expect(summary.energyGained).toBe(1);
    const bal = await app.currency.getBalances(playerId);
    expect(bal.huntEnergy).toBe(20);
    // XP/affection still accrues even though energy hit the cap.
    expect(summary.waifuXpGained).toBe(10);
    expect(summary.affectionGained).toBe(5);
  });

  it('energy recovery is bounded by the player’s computed max energy', async () => {
    // Force max energy below the care cap via an artificially low base by
    // dropping current energy well under 20 first; here we just verify the
    // Math.min(cap, maxEnergy) contract via the state readout.
    const state = await app.care.getState(playerId);
    expect(state.effectiveEnergyCap).toBe(Math.min(20, state.maxEnergy));
  });

  it('waifu XP/affection continues accruing when energy is already at cap', async () => {
    await app.currency.setHuntEnergy(t.db, playerId, 20);
    const summary = await app.care.applyPending(playerId, later(60));
    expect(summary.ticksProcessed).toBe(2);
    expect(summary.energyGained).toBe(0);
    expect(summary.waifuXpGained).toBe(4);
    expect(summary.affectionGained).toBe(2);
    const bal = await app.currency.getBalances(playerId);
    expect(bal.huntEnergy).toBe(20);
  });

  it('target can level up from care ticks', async () => {
    // Waifu base level curve: base 30 growth 10; L1→L2 needs 30 XP = 15 ticks.
    // Bump waifu to 28 XP so 1 tick (2 XP) crosses to level 2.
    await t.db.update(playerWaifus).set({ xp: 28 }).where(eq(playerWaifus.id, waifu.id));
    const summary = await app.care.applyPending(playerId, later(INTERVAL_MIN));
    expect(summary.leveledUp).toBe(true);
    expect(summary.fromLevel).toBe(1);
    expect(summary.toLevel).toBe(2);
    const [w] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifu.id));
    expect(w?.level).toBe(2);
  });

  it('a released target safely stops Care Mode', async () => {
    // Soft-release the target underneath us.
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, waifu.id));
    const summary = await app.care.applyPending(playerId, later(INTERVAL_MIN));
    expect(summary.active).toBe(false);
    expect(summary.stopped).toBe(true);
    expect(summary.energyGained).toBe(0);
    expect(summary.waifuXpGained).toBe(0);
    const [row] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(row?.careModeWaifuId).toBeNull();
    expect(row?.careModeStartedAt).toBeNull();
    expect(row?.careModeLastTickAt).toBeNull();
  });
});

// ─────────────────────────── change target ───────────────────────────

describe('CareService.changeTarget', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-care-change', 'u-1'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId, 0);
  });

  it('applies pending ticks to the OLD target before switching', async () => {
    const oldW = await grantWaifu(playerId, 'neko_barista');
    const newW = await grantWaifu(playerId, 'gym_oni');
    await app.care.start(playerId, oldW.id, T0);
    // 60m later → 2 ticks to old target, then switch.
    const summary = await app.care.changeTarget(playerId, newW.id, later(60));
    expect(summary.active).toBe(true);
    expect(summary.target?.waifu.id).toBe(newW.id);
    // Old target received 4 XP + 2 affection (2 ticks × per-tick config).
    const [oldRow] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, oldW.id));
    expect(oldRow?.xp).toBe(4);
    expect(oldRow?.affection).toBe(2);
    // New target unchanged.
    const [newRow] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, newW.id));
    expect(newRow?.xp).toBe(0);
    expect(newRow?.affection).toBe(0);
    // last_tick_at reset to now so the new target starts a fresh interval.
    const [row] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(row?.careModeLastTickAt?.getTime()).toBe(later(60).getTime());
  });

  it('rejects switching to another player’s waifu', async () => {
    const { playerId: otherId } = await provisionPlayer(app, 'g-care-change', 'u-2');
    const oldW = await grantWaifu(playerId, 'neko_barista');
    const theirs = await grantWaifu(otherId, 'gym_oni');
    await app.care.start(playerId, oldW.id, T0);
    await expect(app.care.changeTarget(playerId, theirs.id, later(60))).rejects.toMatchObject({
      name: 'WaifuNotOwnedError',
    });
  });
});

// ─────────────────────────── leave ───────────────────────────

describe('CareService.leave', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-care-leave', 'u-1'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId, 0);
  });

  it('applies pending ticks and clears the care fields', async () => {
    const w = await grantWaifu(playerId, 'neko_barista');
    await app.care.start(playerId, w.id, T0);
    const summary = await app.care.leave(playerId, later(60));
    expect(summary.stopped).toBe(true);
    expect(summary.ticksProcessed).toBe(2);
    expect(summary.energyGained).toBe(2);
    const bal = await app.currency.getBalances(playerId);
    expect(bal.huntEnergy).toBe(2);
    const [row] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(row?.careModeStartedAt).toBeNull();
    expect(row?.careModeLastTickAt).toBeNull();
    expect(row?.careModeWaifuId).toBeNull();
  });

  it('is safe to call when not in Care Mode', async () => {
    const summary = await app.care.leave(playerId, T0);
    expect(summary.active).toBe(false);
    expect(summary.stopped).toBe(false);
    expect(summary.ticksProcessed).toBe(0);
  });
});

// ─────────────────────────── daily interaction ───────────────────────────

describe('daily claim interacts with Care Mode', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-care-daily', 'u-1'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId, 0);
  });

  it('applies pending ticks, exits Care Mode, and refills normally', async () => {
    const w = await grantWaifu(playerId, 'neko_barista');
    await app.care.start(playerId, w.id, T0);
    // 60m later, claim daily.
    const result = await app.daily.claim(playerId, later(60));
    // Care exit summary attached (2 ticks were pending).
    expect(result.careExit?.ticksProcessed).toBe(2);
    expect(result.careExit?.stopped).toBe(true);
    // Daily refills to max (25 at L1), overriding any care-tick energy.
    expect(result.energySetTo).toBe(25);
    const bal = await app.currency.getBalances(playerId);
    expect(bal.huntEnergy).toBe(25);
    // Waifu XP/affection from care ticks was granted (2 ticks × per-tick).
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, w.id));
    expect(row?.xp).toBe(4);
    expect(row?.affection).toBe(2);
    // Care fields cleared.
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.careModeStartedAt).toBeNull();
    expect(player?.careModeWaifuId).toBeNull();
  });

  it('failed daily (already claimed) does not leave Care Mode', async () => {
    const w = await grantWaifu(playerId, 'neko_barista');
    await app.daily.claim(playerId, T0);
    await app.care.start(playerId, w.id, later(60));
    await expect(app.daily.claim(playerId, later(70))).rejects.toBeInstanceOf(
      AlreadyClaimedError,
    );
    // Care Mode still active (transaction rolled back).
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.careModeWaifuId).toBe(w.id);
  });
});

// ─────────────────────────── hunt interaction ───────────────────────────

describe('hunt interacts with Care Mode', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-care-hunt', 'u-1'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId, 0);
  });

  it('applies pending ticks, exits Care Mode, then spends 1 energy', async () => {
    const w = await grantWaifu(playerId, 'neko_barista');
    await app.care.start(playerId, w.id, T0);
    // 60m later a full-flavor hunt (0.99 → flavor bucket, then random flavor).
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
    const result = await scripted.hunt(playerId, 'c-1', later(60));
    // Care ticks were applied (energy went 0 → 2), and 1 spent by hunt → 1 left.
    expect(result.kind).toBe('flavor');
    expect(result.energyRemaining).toBe(1);
    expect(result.careExit?.ticksProcessed).toBe(2);
    // Care fields cleared.
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.careModeWaifuId).toBeNull();
    // Waifu XP/affection accrued.
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, w.id));
    expect(row?.xp).toBe(4);
    expect(row?.affection).toBe(2);
  });

  it('failed hunt (insufficient energy after ticks) keeps Care Mode active', async () => {
    const w = await grantWaifu(playerId, 'neko_barista');
    await app.care.start(playerId, w.id, T0);
    // Only 20 minutes later → 0 ticks, energy still 0.
    await expect(app.hunt.hunt(playerId, 'c-1', later(20))).rejects.toBeInstanceOf(
      InsufficientEnergyError,
    );
    // Care Mode still active.
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.careModeWaifuId).toBe(w.id);
    expect(player?.careModeStartedAt?.getTime()).toBe(T0.getTime());
  });
});

// ─────────────────────────── concurrency ───────────────────────────

describe('CareService — concurrency', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-care-race', 'u-1'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId, 0);
  });

  it('parallel applyPending calls never double-grant energy or XP', async () => {
    const w = await grantWaifu(playerId, 'neko_barista');
    await app.care.start(playerId, w.id, T0);
    // 90 minutes → 3 ticks pending. Fire 8 concurrent calls.
    const at = later(90);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => app.care.applyPending(playerId, at)),
    );
    // Exactly one call granted 3 ticks; the rest saw 0 pending.
    const grantedCounts = results.map((r) => r.ticksProcessed).sort((a, b) => b - a);
    expect(grantedCounts[0]).toBe(3);
    for (let i = 1; i < grantedCounts.length; i++) expect(grantedCounts[i]).toBe(0);
    // Energy / XP applied exactly once.
    const bal = await app.currency.getBalances(playerId);
    expect(bal.huntEnergy).toBe(3);
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, w.id));
    expect(row?.xp).toBe(6);
    expect(row?.affection).toBe(3);
  });
});

// ─────────────────────── config validation ───────────────────────

describe('careMode config schema', () => {
  it('the shipped tables.json declares energy.careMode with the required fields', () => {
    const cfg = app.content.tables.energy.careMode;
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalMinutes).toBeGreaterThan(0);
    expect(cfg.energyPerTick).toBeGreaterThanOrEqual(0);
    expect(cfg.recoveryCap).toBeGreaterThanOrEqual(0);
    expect(cfg.waifuXpPerTick).toBeGreaterThanOrEqual(0);
    expect(cfg.affectionPerTick).toBeGreaterThanOrEqual(0);
  });
});
