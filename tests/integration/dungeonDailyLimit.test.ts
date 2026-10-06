/**
 * The daily Delve allowance against a real database: what consumes an
 * attempt, what never does, the game-day rollover, the configurable limit,
 * and the races — two starts at once must spend one attempt and make one run.
 *
 * Also the combat side of "no rerolls": a fight under real damage variance is
 * resolved once, and asking again reads the same result back.
 *
 * The world's clock is the test's (`w.clock.now`), in UTC, so a reset is
 * crossed by moving it past midnight — never by waiting.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dungeonDailyUsage, dungeonRunEvents, dungeonRuns, dungeonSettings, playerProgressionEvents } from '../../src/db/schema';
import { ADMIN_ACTION_EVENT } from '../../src/modules/admin/adminActionAudit';
import type { CombatEvent } from '../../src/modules/combat/combatTypes';
import {
  DEFAULT_DUNGEON_DAILY_RUN_LIMIT,
  DUNGEON_DAILY_RUN_LIMIT_BOUNDS,
  createDungeonAllowanceService,
  validateDungeonSettingsPatch,
} from '../../src/modules/dungeons/dungeonAllowanceService';
import type { DungeonGraph } from '../../src/modules/dungeons/dungeonGenerator';
import { createDungeonPlayService } from '../../src/modules/dungeons/dungeonPlayService';
import { dungeonCombatSeed } from '../../src/modules/dungeons/dungeonRunState';
import { createEquipmentRewardService } from '../../src/modules/equipment/equipmentRewardService';
import { createStagingTestControlsService } from '../../src/modules/testControls/stagingTestControlsService';
import {
  DungeonDailyLimitError,
  DungeonGenerationError,
  DungeonRunActiveError,
  DungeonSettingsInvalidError,
  DungeonZoneUnavailableError,
} from '../../src/shared/errors';
import { atCompleted, createDungeonWorld, walk, type DungeonWorld } from '../helpers/dungeonPlayFixtures';
import { createCapturedLogger } from '../helpers/platformApiFixtures';

let w: DungeonWorld;

/** One fork, a rest (the extraction point), a reward node, a beatable boss. */
const MAIN = 'daily_main';
/** A second zone: the allowance is shared with MAIN, not its own. */
const OTHER = 'daily_other';
/** The boss cannot be beaten: a run that reaches it is defeated. */
const DOOMED = 'daily_doomed';
/** Valid when saved, impossible to generate afterwards (see `breakGeneration`). */
const BROKEN = 'daily_broken';

const DAY_A = new Date('2026-03-10T12:00:00Z');
const DAY_A_LATE = new Date('2026-03-10T23:55:00Z');
const DAY_B_EARLY = new Date('2026-03-11T00:10:00Z');
const DAY_B = new Date('2026-03-11T12:00:00Z');

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.zone(MAIN);
  await w.zone(OTHER);
  await w.zone(DOOMED, (z) => {
    z.pools.boss = [{ id: 'brute', enemyKey: 'brute', weight: 10 }];
  });
  await w.zone(BROKEN);
});
afterAll(async () => {
  await w?.cleanup();
});
beforeEach(async () => {
  w.clock.now = DAY_A;
  await w.allowance.updateSettings({ dailyRunLimit: DEFAULT_DUNGEON_DAILY_RUN_LIMIT });
});

const usageRows = (playerId: number) => w.t.db.select().from(dungeonDailyUsage).where(eq(dungeonDailyUsage.playerId, playerId));
const runRows = (playerId: number) => w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.playerId, playerId));
const daily = async (playerId: number) => {
  const { limit, used, remaining, periodKey } = await w.allowance.status(playerId);
  return { limit, used, remaining, periodKey };
};
/** Start a run and end it at once, by abandoning. */
const startAndAbandon = async (playerId: number, zoneKey = MAIN) => {
  const run = await w.play.start(playerId, zoneKey);
  await w.play.abandon(playerId, run.id);
  return run;
};

/* ─────────────────────────── the setting ─────────────────────────── */

describe('the configured limit', () => {
  it('ships as 3, seeded by the migration, and is what a fresh player is allowed', async () => {
    expect(DEFAULT_DUNGEON_DAILY_RUN_LIMIT).toBe(3);
    expect((await w.t.db.select().from(dungeonSettings))[0]).toMatchObject({ id: 1, dailyRunLimit: 3 });
    const { playerId } = await w.player();
    expect(await daily(playerId)).toEqual({ limit: 3, used: 0, remaining: 3, periodKey: '2026-03-10' });
    // Nothing is written for a player who has not started a run: usage is stored, never handed out.
    expect(await usageRows(playerId)).toHaveLength(0);
  });

  it('recreates the settings row from the default if the table was emptied', async () => {
    await w.t.db.delete(dungeonSettings);
    expect((await w.allowance.getSettings()).dailyRunLimit).toBe(3);
    expect(await w.t.db.select().from(dungeonSettings)).toHaveLength(1);
  });

  it('accepts whole numbers inside its bounds and refuses everything else, changing nothing', async () => {
    expect(DUNGEON_DAILY_RUN_LIMIT_BOUNDS).toEqual({ min: 0, max: 50 });
    const saved = await w.allowance.updateSettings({ dailyRunLimit: 5 }, 'admin-1');
    expect(saved).toMatchObject({ dailyRunLimit: 5, updatedBy: 'admin-1' });
    for (const bad of [-1, 51, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '4' as unknown as number]) {
      await expect(w.allowance.updateSettings({ dailyRunLimit: bad }), String(bad)).rejects.toBeInstanceOf(DungeonSettingsInvalidError);
      expect(validateDungeonSettingsPatch({ dailyRunLimit: bad }), String(bad)).toHaveLength(1);
    }
    expect((await w.allowance.getSettings()).dailyRunLimit).toBe(5);
    // The table holds the same line, whoever writes to it.
    await expect(w.t.db.update(dungeonSettings).set({ dailyRunLimit: 51 })).rejects.toThrow();
    await expect(w.t.db.insert(dungeonSettings).values({ id: 2, dailyRunLimit: 3 })).rejects.toThrow();
  });

  it('takes effect at once in both directions, because usage is stored and the remainder computed', async () => {
    const { playerId } = await w.player();
    await startAndAbandon(playerId);
    await startAndAbandon(playerId);
    expect(await daily(playerId)).toMatchObject({ limit: 3, used: 2, remaining: 1 });

    await w.allowance.updateSettings({ dailyRunLimit: 5 });
    expect(await daily(playerId)).toMatchObject({ limit: 5, used: 2, remaining: 3 });
    expect((await w.play.home(playerId)).daily).toMatchObject({ limit: 5, used: 2, remaining: 3 });

    // Lowered below what was already used: nothing left, never negative, nothing clawed back.
    await w.allowance.updateSettings({ dailyRunLimit: 1 });
    expect(await daily(playerId)).toMatchObject({ limit: 1, used: 2, remaining: 0 });
    await expect(w.play.start(playerId, MAIN)).rejects.toBeInstanceOf(DungeonDailyLimitError);
    expect((await usageRows(playerId))[0]!.runsStarted).toBe(2);
  });

  it('at 0 closes Delve to new runs — explicitly — while an active run plays on', async () => {
    const active = await w.player();
    const run = await w.play.start(active.playerId, MAIN);
    await w.allowance.updateSettings({ dailyRunLimit: 0 });

    const fresh = await w.player();
    const refusal = await w.play.start(fresh.playerId, MAIN).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(DungeonDailyLimitError);
    expect(refusal).toMatchObject({ limit: 0, used: 0, userMessage: 'Delve is closed to new runs right now.' });
    expect(await daily(fresh.playerId)).toMatchObject({ limit: 0, used: 0, remaining: 0 });
    expect(await usageRows(fresh.playerId)).toHaveLength(0);
    expect(await runRows(fresh.playerId)).toHaveLength(0);

    const end = await walk(w.play, active.playerId, run);
    expect(end.status).toBe('completed');
  });
});

/* ─────────────────────────── consumption ─────────────────────────── */

describe('what consumes an attempt', () => {
  it('the first run does, in the transaction that creates it, and records it on the run', async () => {
    const { playerId } = await w.player();
    const run = await w.play.start(playerId, MAIN);
    expect(await daily(playerId)).toEqual({ limit: 3, used: 1, remaining: 2, periodKey: '2026-03-10' });
    expect(await usageRows(playerId)).toMatchObject([{ periodKey: '2026-03-10', runsStarted: 1 }]);
    const [started] = await w.play.history(run.id);
    expect(started).toMatchObject({ type: 'run_started', payload: { daily: { periodKey: '2026-03-10', limit: 3, used: 1 } } });
    expect(await w.play.dailyAllowance(playerId)).toMatchObject({ used: 1, remaining: 2 });
  });

  it('is shared by every zone: a run anywhere draws on the same allowance', async () => {
    const { playerId } = await w.player();
    await startAndAbandon(playerId, MAIN);
    await startAndAbandon(playerId, OTHER);
    await startAndAbandon(playerId, DOOMED);
    expect(await daily(playerId)).toMatchObject({ used: 3, remaining: 0 });
    expect(await usageRows(playerId)).toHaveLength(1);
    for (const zone of [MAIN, OTHER, DOOMED]) {
      await expect(w.play.start(playerId, zone), zone).rejects.toBeInstanceOf(DungeonDailyLimitError);
      expect((await w.play.zone(playerId, zone)).daily).toMatchObject({ limit: 3, used: 3, remaining: 0 });
    }
  });

  it('resuming, moving and resolving do not', async () => {
    const { playerId } = await w.player();
    const run = await w.play.start(playerId, MAIN);
    await w.play.home(playerId);
    await w.play.activeRun(playerId);
    await w.play.run(playerId, run.id);
    const first = await w.play.resolveNode(playerId, run.id, run.node.id);
    await w.play.resolveNode(playerId, run.id, run.node.id); // a replay
    await w.play.enterNode(playerId, run.id, first.run.next[0]!.id);
    await w.play.enterNode(playerId, run.id, first.run.next[0]!.id); // a replay
    expect(await daily(playerId)).toMatchObject({ used: 1, remaining: 2 });
  });

  it('does not refund an extraction', async () => {
    const { playerId } = await w.player();
    const run = await w.play.start(playerId, MAIN);
    const rest = await walk(w.play, playerId, run, { stopAt: atCompleted('rest') });
    const out = await w.play.extract(playerId, run.id, rest.node.id);
    expect(out.run.status).toBe('extracted');
    expect(await daily(playerId)).toMatchObject({ used: 1, remaining: 2 });
  });

  it('does not refund a completion', async () => {
    const { playerId } = await w.player();
    expect((await walk(w.play, playerId, await w.play.start(playerId, MAIN))).status).toBe('completed');
    expect(await daily(playerId)).toMatchObject({ used: 1, remaining: 2 });
  });

  it('does not refund a defeat', async () => {
    const { playerId } = await w.player();
    expect((await walk(w.play, playerId, await w.play.start(playerId, DOOMED))).status).toBe('defeated');
    expect(await daily(playerId)).toMatchObject({ used: 1, remaining: 2 });
  });

  it('does not refund an abandon', async () => {
    const { playerId } = await w.player();
    const run = await w.play.start(playerId, MAIN);
    expect((await w.play.abandon(playerId, run.id))!.run.status).toBe('abandoned');
    expect(await daily(playerId)).toMatchObject({ used: 1, remaining: 2 });
  });

  it('never touches Energy', async () => {
    const { playerId } = await w.player();
    const before = await w.app.currency.getBalances(playerId);
    await startAndAbandon(playerId);
    await startAndAbandon(playerId);
    expect((await w.app.currency.getBalances(playerId)).huntEnergy).toBe(before.huntEnergy);
  });
});

describe('a start that fails consumes nothing', () => {
  it('refused before the run exists: locked, no Buddy, incomplete loadout, a missing zone', async () => {
    const locked = await w.player({ unlocked: false });
    const noBuddy = await w.player({ buddy: false });
    const noGear = await w.player({ starters: false });
    const fine = await w.player();
    await expect(w.play.start(locked.playerId, MAIN)).rejects.toThrow();
    await expect(w.play.start(noBuddy.playerId, MAIN)).rejects.toThrow();
    await expect(w.play.start(noGear.playerId, MAIN)).rejects.toThrow();
    await expect(w.play.start(fine.playerId, 'no_such_zone')).rejects.toBeInstanceOf(DungeonZoneUnavailableError);
    for (const { playerId } of [locked, noBuddy, noGear, fine]) {
      expect(await usageRows(playerId), String(playerId)).toHaveLength(0);
      expect(await runRows(playerId)).toHaveLength(0);
    }
    expect(await daily(fine.playerId)).toMatchObject({ used: 0, remaining: 3 });
  });

  it('a second start while a run is active is refused as that, and spends nothing', async () => {
    const { playerId } = await w.player();
    await w.play.start(playerId, MAIN);
    await expect(w.play.start(playerId, MAIN)).rejects.toBeInstanceOf(DungeonRunActiveError);
    await expect(w.play.start(playerId, OTHER)).rejects.toBeInstanceOf(DungeonRunActiveError);
    expect(await daily(playerId)).toMatchObject({ used: 1, remaining: 2 });
    expect(await runRows(playerId)).toHaveLength(1);
  });

  it('generation failure — after the attempt was taken in the transaction — rolls the attempt back', async () => {
    // Switch off the only boss in the Enemy Catalogue: the zone still reads,
    // but no run can be generated for it.
    await w.setEnemyEnabled('overlord', false);
    const { playerId } = await w.player();
    try {
      await startAndAbandon(playerId, DOOMED); // still generates: its boss is the brute
      const failure = await w.play.start(playerId, BROKEN).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(DungeonDailyLimitError);
    } finally {
      await w.setEnemyEnabled('overlord', true);
    }
    expect(await daily(playerId)).toMatchObject({ used: 1, remaining: 2 });
    expect(await runRows(playerId)).toHaveLength(1);
  });

  it('a generator that throws rolls the attempt back', async () => {
    const play = createDungeonPlayService({
      db: w.t.db,
      runs: {
        startRun: async () => {
          throw new DungeonGenerationError({ zoneKey: 'test_zone', seed: 1, attempts: 1, failures: {}, lastFailure: 'forced' } as never);
        },
      },
      allowance: w.allowance,
      featureUnlocks: w.svc.featureUnlocks,
      combatStats: w.stats,
      currencies: w.currencies,
      currency: w.app.currency,
      inventory: w.app.inventory,
      equipmentRewards: createEquipmentRewardService({ equipment: w.svc.equipment, getAffixes: w.svc.getAffixes, featureUnlocks: w.svc.featureUnlocks }),
    });
    const { playerId } = await w.player();
    await expect(play.start(playerId, MAIN)).rejects.toBeInstanceOf(DungeonGenerationError);
    expect(await usageRows(playerId)).toHaveLength(0);
    expect(await daily(playerId)).toMatchObject({ used: 0, remaining: 3 });
  });

  it('a database failure after the run row was inserted rolls back the run and the attempt together', async () => {
    const { playerId } = await w.player();
    // The start's last write is the `run_started` event. Make that insert fail.
    await w.t.pool.query(`
      CREATE FUNCTION fail_run_started() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced failure for the test'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_run_started BEFORE INSERT ON dungeon_run_events
        FOR EACH ROW WHEN (NEW.type = 'run_started') EXECUTE FUNCTION fail_run_started();
    `);
    try {
      await expect(w.play.start(playerId, MAIN)).rejects.toThrow(/forced failure/);
    } finally {
      await w.t.pool.query('DROP TRIGGER fail_run_started ON dungeon_run_events; DROP FUNCTION fail_run_started();');
    }
    expect(await runRows(playerId)).toHaveLength(0);
    expect(await usageRows(playerId)).toHaveLength(0);
    expect(await daily(playerId)).toMatchObject({ used: 0, remaining: 3 });
    // And the player can start normally afterwards.
    await w.play.start(playerId, MAIN);
    expect(await daily(playerId)).toMatchObject({ used: 1, remaining: 2 });
  });
});

/* ─────────────────────────── the limit ─────────────────────────── */

describe('with nothing left', () => {
  const spend = async () => {
    const { playerId } = await w.player();
    await startAndAbandon(playerId);
    await startAndAbandon(playerId);
    return playerId;
  };

  it('a new start is refused, says so, and stores nothing', async () => {
    const playerId = await spend();
    await startAndAbandon(playerId);
    const refusal = await w.play.start(playerId, MAIN).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(DungeonDailyLimitError);
    expect(refusal).toMatchObject({ code: 'DUNGEON_DAILY_LIMIT', limit: 3, used: 3, periodKey: '2026-03-10' });
    expect(await runRows(playerId)).toHaveLength(3);
    expect(await daily(playerId)).toMatchObject({ used: 3, remaining: 0 });
    const home = await w.play.home(playerId);
    expect(home).toMatchObject({ activeRun: null, daily: { limit: 3, used: 3, remaining: 0 } });
    expect(home.daily.resetsAt).toEqual(new Date('2026-03-11T00:00:00Z'));
  });

  it('the active run can still be resumed, played, and ended every way — but not replaced', async () => {
    for (const ending of ['extract', 'complete', 'abandon'] as const) {
      const playerId = await spend();
      const run = await w.play.start(playerId, MAIN);
      expect(await daily(playerId), ending).toMatchObject({ used: 3, remaining: 0 });

      // Resume.
      expect((await w.play.home(playerId)).activeRun?.id).toBe(run.id);
      expect((await w.play.run(playerId, run.id)).status).toBe('active');
      // Cannot start another: the active run is in the way before the allowance is even asked.
      await expect(w.play.start(playerId, OTHER)).rejects.toBeInstanceOf(DungeonRunActiveError);

      // Navigate, then end it.
      if (ending === 'extract') {
        const rest = await walk(w.play, playerId, run, { stopAt: atCompleted('rest') });
        expect(rest.canExtract).toBe(true);
        expect((await w.play.extract(playerId, run.id, rest.node.id)).run.status).toBe('extracted');
      } else if (ending === 'complete') {
        expect((await walk(w.play, playerId, run)).status).toBe('completed');
      } else {
        const first = await w.play.resolveNode(playerId, run.id, run.node.id);
        expect(first.status).toBe('applied');
        expect((await w.play.abandon(playerId, run.id))!.run.status).toBe('abandoned');
      }

      // The run is over; the allowance is still spent until the day turns.
      await expect(w.play.start(playerId, MAIN), ending).rejects.toBeInstanceOf(DungeonDailyLimitError);
      expect(await daily(playerId)).toMatchObject({ used: 3, remaining: 0 });
    }
  });
});

/* ─────────────────────────── concurrency ─────────────────────────── */

describe('concurrent starts', () => {
  it('a double-clicked Start makes one run and spends one attempt', async () => {
    const { playerId } = await w.player();
    const results = await Promise.allSettled([w.play.start(playerId, MAIN), w.play.start(playerId, MAIN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(DungeonRunActiveError);
    expect(await runRows(playerId)).toHaveLength(1);
    expect(await daily(playerId)).toMatchObject({ used: 1, remaining: 2 });
  });

  it('eight starts at once across two zones: one run, one attempt', async () => {
    const { playerId } = await w.player();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => w.play.start(playerId, i % 2 ? MAIN : OTHER)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DungeonRunActiveError);
    expect(await runRows(playerId)).toHaveLength(1);
    expect((await usageRows(playerId))[0]!.runsStarted).toBe(1);
  });

  it('one attempt left and two requests: exactly one run, and the count stops at the limit', async () => {
    const { playerId } = await w.player();
    await startAndAbandon(playerId);
    await startAndAbandon(playerId);
    expect(await daily(playerId)).toMatchObject({ remaining: 1 });
    const results = await Promise.allSettled([w.play.start(playerId, MAIN), w.play.start(playerId, OTHER)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await runRows(playerId)).filter((r) => r.status === 'active')).toHaveLength(1);
    expect(await runRows(playerId)).toHaveLength(3);
    expect((await usageRows(playerId))[0]!.runsStarted).toBe(3);
  });

  it('the allowance holds on its own: racing consumers with no player lock never pass the limit', async () => {
    // `consume` without the start's player lock or the one-active-run index —
    // the conditional upsert alone must stop at the limit.
    const { playerId } = await w.player();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => w.t.db.transaction((tx) => w.allowance.consume(tx, playerId))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DungeonDailyLimitError);
    expect((await usageRows(playerId))[0]!.runsStarted).toBe(3);
    // The same from an empty day with a single attempt on offer: one winner.
    await w.allowance.updateSettings({ dailyRunLimit: 1 });
    const other = await w.player();
    const single = await Promise.allSettled(
      Array.from({ length: 6 }, () => w.t.db.transaction((tx) => w.allowance.consume(tx, other.playerId))),
    );
    expect(single.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await usageRows(other.playerId))[0]!.runsStarted).toBe(1);
  });

  it('the usage table refuses a negative count', async () => {
    const { playerId } = await w.player();
    await expect(
      w.t.db.insert(dungeonDailyUsage).values({ playerId, periodKey: '2026-03-10', runsStarted: -1 }),
    ).rejects.toThrow();
  });
});

/* ─────────────────────────── the reset ─────────────────────────── */

describe('the daily reset', () => {
  it('uses the daily claim’s calendar day: the period is the date in the daily timezone', async () => {
    const { playerId } = await w.player();
    w.clock.now = DAY_A_LATE;
    expect(await w.allowance.status(playerId)).toMatchObject({ periodKey: '2026-03-10', resetsAt: new Date('2026-03-11T00:00:00Z') });
    w.clock.now = DAY_B_EARLY;
    expect(await w.allowance.status(playerId)).toMatchObject({ periodKey: '2026-03-11', resetsAt: new Date('2026-03-12T00:00:00Z') });

    // A non-UTC daily timezone moves the boundary with it: 03:30Z is still the 10th in New York.
    const eastern = createDungeonAllowanceService({ db: w.t.db, timezone: 'America/New_York', now: () => new Date('2026-03-11T03:30:00Z') });
    expect(await eastern.status(playerId)).toMatchObject({ periodKey: '2026-03-10', resetsAt: new Date('2026-03-11T04:00:00Z') });
  });

  it('gives a full allowance on the new day with no refill job — yesterday’s row is simply not today’s', async () => {
    const { playerId } = await w.player();
    for (let i = 0; i < 3; i++) await startAndAbandon(playerId);
    await expect(w.play.start(playerId, MAIN)).rejects.toBeInstanceOf(DungeonDailyLimitError);

    w.clock.now = DAY_B;
    expect(await daily(playerId)).toEqual({ limit: 3, used: 0, remaining: 3, periodKey: '2026-03-11' });
    await startAndAbandon(playerId);
    expect(await daily(playerId)).toMatchObject({ used: 1, remaining: 2 });
    // Both days are on record; nothing was reset or deleted.
    expect((await usageRows(playerId)).map((r) => [r.periodKey, r.runsStarted]).sort()).toEqual([
      ['2026-03-10', 3],
      ['2026-03-11', 1],
    ]);
  });

  it('a run started before the reset carries on after it and is not charged to the new day', async () => {
    const { playerId } = await w.player();
    w.clock.now = DAY_A_LATE;
    const run = await w.play.start(playerId, MAIN);
    expect(await daily(playerId)).toMatchObject({ periodKey: '2026-03-10', used: 1 });

    w.clock.now = DAY_B_EARLY;
    // Still active, still resumable, exactly where it was.
    const home = await w.play.home(playerId);
    expect(home.activeRun).toMatchObject({ id: run.id, status: 'active', currentHp: run.currentHp });
    // The new day's allowance exists and is untouched by the old run…
    expect(home.daily).toMatchObject({ periodKey: '2026-03-11', used: 0, remaining: 3 });
    // …but the one-active-run rule still stands.
    await expect(w.play.start(playerId, OTHER)).rejects.toBeInstanceOf(DungeonRunActiveError);

    const end = await walk(w.play, playerId, run);
    expect(end.status).toBe('completed');
    expect(await daily(playerId)).toMatchObject({ periodKey: '2026-03-11', used: 0, remaining: 3 });
    expect(await usageRows(playerId)).toMatchObject([{ periodKey: '2026-03-10', runsStarted: 1 }]);

    // Now a run of the new day costs the new day one.
    await w.play.start(playerId, MAIN);
    expect(await daily(playerId)).toMatchObject({ periodKey: '2026-03-11', used: 1, remaining: 2 });
  });

  it('a run started on a spent day and resumed the next still leaves the new day whole', async () => {
    const { playerId } = await w.player();
    await startAndAbandon(playerId);
    await startAndAbandon(playerId);
    w.clock.now = DAY_A_LATE;
    const run = await w.play.start(playerId, MAIN);
    expect(await daily(playerId)).toMatchObject({ used: 3, remaining: 0 });

    w.clock.now = DAY_B_EARLY;
    const first = await w.play.resolveNode(playerId, run.id, run.node.id);
    expect(first.status).toBe('applied');
    await w.play.abandon(playerId, run.id);
    expect(await daily(playerId)).toMatchObject({ periodKey: '2026-03-11', used: 0, remaining: 3 });
  });

  it('starts racing across the boundary each count toward the day they landed on', async () => {
    const a = await w.player();
    const b = await w.player();
    for (const p of [a, b]) for (let i = 0; i < 2; i++) await startAndAbandon(p.playerId);

    // One request reads the clock just before midnight, the other just after.
    const before = w.t.db.transaction((tx) => w.allowance.consume(tx, a.playerId, DAY_A_LATE));
    const after = w.t.db.transaction((tx) => w.allowance.consume(tx, a.playerId, DAY_B_EARLY));
    const [late, early] = await Promise.all([before, after]);
    expect(late).toMatchObject({ periodKey: '2026-03-10', used: 3, remaining: 0 });
    expect(early).toMatchObject({ periodKey: '2026-03-11', used: 1, remaining: 2 });

    // Through the real start: the clock ticks over between two simultaneous clicks.
    let tick = 0;
    const flipping = createDungeonAllowanceService({
      db: w.t.db,
      timezone: 'UTC',
      now: () => (tick++ === 0 ? DAY_A_LATE : DAY_B_EARLY),
    });
    const play = createDungeonPlayService({
      db: w.t.db,
      runs: w.runs,
      allowance: flipping,
      featureUnlocks: w.svc.featureUnlocks,
      combatStats: w.stats,
      currencies: w.currencies,
      currency: w.app.currency,
      inventory: w.app.inventory,
      equipmentRewards: createEquipmentRewardService({ equipment: w.svc.equipment, getAffixes: w.svc.getAffixes, featureUnlocks: w.svc.featureUnlocks }),
    });
    const results = await Promise.allSettled([play.start(b.playerId, MAIN), play.start(b.playerId, MAIN)]);
    // Exactly one run exists, and exactly one attempt was spent across both days.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await runRows(b.playerId)).filter((r) => r.status === 'active')).toHaveLength(1);
    const total = (await usageRows(b.playerId)).reduce((sum, r) => sum + r.runsStarted, 0);
    expect(total).toBe(3);
  });
});

/* ─────────────────────────── logging ─────────────────────────── */

describe('structured logs', () => {
  it('record the consumed attempt, the refusal and the settlement — and fights only at debug', async () => {
    const captured = createCapturedLogger('debug');
    const logged = await createDungeonWorldWithLogger(captured.logger);
    const { playerId } = await w.player();
    const tags = () =>
      captured
        .lines()
        .map((l) => JSON.parse(l) as { tag?: string; level: number; playerId?: number } & Record<string, unknown>)
        .filter((l) => l.playerId === playerId || l.tag === 'dungeons/combat-resolved');

    const run = await logged.start(playerId, MAIN);
    await walk(logged, playerId, run);
    await w.allowance.updateSettings({ dailyRunLimit: 1 });
    await expect(logged.start(playerId, MAIN)).rejects.toBeInstanceOf(DungeonDailyLimitError);

    const lines = tags();
    expect(lines.find((l) => l.tag === 'dungeons/daily-usage-consumed')).toMatchObject({ level: 30, runId: run.id, used: 1, limit: 3, remaining: 2, periodKey: '2026-03-10' });
    expect(lines.find((l) => l.tag === 'dungeons/run-settled')).toMatchObject({ level: 30, runId: run.id, outcome: 'completed', cause: 'boss_defeated' });
    expect(lines.find((l) => l.tag === 'dungeons/start-refused-daily-limit')).toMatchObject({ level: 30, limit: 1, used: 1 });
    const fights = lines.filter((l) => l.tag === 'dungeons/combat-resolved');
    expect(fights.length).toBeGreaterThan(0);
    // One line per fight, at debug — never one per damage roll, never at info.
    for (const f of fights) expect(f.level).toBe(20);
    expect(typeof fights[0]!.combatSeed).toBe('number');
  });
});

/** The world's services again, with a logger attached to the play service. */
async function createDungeonWorldWithLogger(logger: NonNullable<Parameters<typeof createDungeonPlayService>[0]['logger']>) {
  return createDungeonPlayService({
    db: w.t.db,
    runs: w.runs,
    allowance: w.allowance,
    featureUnlocks: w.svc.featureUnlocks,
    combatStats: w.stats,
    currencies: w.currencies,
    currency: w.app.currency,
    inventory: w.app.inventory,
    equipmentRewards: createEquipmentRewardService({ equipment: w.svc.equipment, getAffixes: w.svc.getAffixes, featureUnlocks: w.svc.featureUnlocks }),
    logger,
  });
}

/* ─────────────────────────── staging reset ─────────────────────────── */

describe('the staging test control', () => {
  const controls = (deploymentEnv: 'development' | 'staging') =>
    createStagingTestControlsService({
      db: w.t.db,
      currency: w.app.currency,
      inventory: w.app.inventory,
      travel: w.app.travel,
      progression: w.app.progression,
      getContent: () => w.app.content,
      logger: w.t.logger,
      config: { enabled: true, deploymentEnv },
      dungeonAllowance: w.allowance,
    });
  const actor = { discordUserId: 'admin-9', discordGuildId: null };

  it('forgets today’s usage only — runs, an active run and other days are untouched — and audits it', async () => {
    const { playerId } = await w.player();
    await startAndAbandon(playerId);
    w.clock.now = DAY_B;
    await startAndAbandon(playerId);
    await startAndAbandon(playerId);
    const active = await w.play.start(playerId, MAIN);
    expect(await daily(playerId)).toMatchObject({ used: 3, remaining: 0 });

    const service = controls('staging');
    expect((await service.getState(playerId)).delve).toEqual({ limit: 3, used: 3, remaining: 0, periodKey: '2026-03-11' });
    const result = await service.resetDelveUsage(actor, playerId);
    expect(result).toMatchObject({
      action: 'test_reset_delve_usage',
      changed: true,
      changes: [{ field: 'delveRunsStarted', before: 3, after: 0 }],
      state: { delve: { limit: 3, used: 0, remaining: 3 } },
    });
    expect(await runRows(playerId)).toHaveLength(4);
    expect((await w.play.run(playerId, active.id)).status).toBe('active');
    expect(await usageRows(playerId)).toMatchObject([{ periodKey: '2026-03-10', runsStarted: 1 }]);

    // A second press is a recorded no-op.
    expect(await service.resetDelveUsage(actor, playerId)).toMatchObject({ changed: false, changes: [] });
    const audits = await w.t.db
      .select()
      .from(playerProgressionEvents)
      .where(and(eq(playerProgressionEvents.playerId, playerId), eq(playerProgressionEvents.eventType, ADMIN_ACTION_EVENT)));
    expect(audits.map((a) => (a.metadata as { action: string }).action)).toEqual(['test_reset_delve_usage', 'test_reset_delve_usage']);
  });

  it('cannot exist in production, and refuses if the deployment stops allowing it', async () => {
    expect(() =>
      createStagingTestControlsService({
        db: w.t.db,
        currency: w.app.currency,
        inventory: w.app.inventory,
        travel: w.app.travel,
        progression: w.app.progression,
        getContent: () => w.app.content,
        logger: w.t.logger,
        config: { enabled: true, deploymentEnv: 'production' },
        dungeonAllowance: w.allowance,
      }),
    ).toThrow();
    const config = { enabled: true, deploymentEnv: 'development' as const };
    const service = createStagingTestControlsService({
      db: w.t.db,
      currency: w.app.currency,
      inventory: w.app.inventory,
      travel: w.app.travel,
      progression: w.app.progression,
      getContent: () => w.app.content,
      logger: w.t.logger,
      config,
      dungeonAllowance: w.allowance,
    });
    const { playerId } = await w.player();
    await startAndAbandon(playerId);
    config.enabled = false;
    await expect(service.resetDelveUsage(actor, playerId)).rejects.toThrow();
    expect(await daily(playerId)).toMatchObject({ used: 1 });
  });
});

/* ─────────────────────────── combat under variance ─────────────────────────── */

describe('dungeon combat with real damage variance', () => {
  let real: DungeonWorld;
  const ZONE = 'variance_main';
  beforeAll(async () => {
    // `combatRules: null` — the engine's own rules, variance included.
    real = await createDungeonWorld({ combatRules: null });
    await real.zone(ZONE);
  });
  afterAll(async () => {
    await real?.cleanup();
  });

  const fightPayload = async (runId: number, nodeId: string) => {
    const rows = await real.t.db
      .select()
      .from(dungeonRunEvents)
      .where(and(eq(dungeonRunEvents.runId, runId), eq(dungeonRunEvents.nodeId, nodeId), eq(dungeonRunEvents.type, 'combat_resolved')));
    return rows.map((r) => r.payload as { combatSeed: number; hpAfter: number; events: CombatEvent[] });
  };
  /** A seed whose run opens on a fight. */
  const opensOnAFight = () => real.seedFor(ZONE, (g: DungeonGraph) => g.nodes[0]!.type === 'combat');

  it('rolls each fight from the seed derived from the run seed and the node, inside 90%–110%', async () => {
    const seed = await opensOnAFight();
    const { playerId } = await real.player();
    const run = await real.play.start(playerId, ZONE, { seed });
    const result = await real.play.resolveNode(playerId, run.id, run.node.id);
    const [payload] = await fightPayload(run.id, run.node.id);
    expect(payload!.combatSeed).toBe(dungeonCombatSeed(seed, run.node.id));
    const hits = payload!.events.filter((e): e is Extract<CombatEvent, { type: 'damage' }> => e.type === 'damage');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.varianceBasisPoints).toBeGreaterThanOrEqual(9_000);
      expect(hit.varianceBasisPoints).toBeLessThanOrEqual(11_000);
    }
    expect(new Set(hits.map((h) => h.varianceBasisPoints)).size).toBeGreaterThan(1);
    expect(result.run.resolution).toMatchObject({ kind: 'combat', hpAfter: payload!.hpAfter });
  });

  it('a retry reads the original result back: nothing is fought or rolled again', async () => {
    const seed = await opensOnAFight();
    const { playerId } = await real.player();
    const run = await real.play.start(playerId, ZONE, { seed });
    const first = await real.play.resolveNode(playerId, run.id, run.node.id);
    expect(first.status).toBe('applied');
    for (let i = 0; i < 5; i++) {
      const again = await real.play.resolveNode(playerId, run.id, run.node.id);
      expect(again.status).toBe('replayed');
      expect(again.run.resolution).toEqual(first.run.resolution);
      expect(again.run.currentHp).toBe(first.run.currentHp);
      expect(again.run.combatEvents).toEqual(first.run.combatEvents);
    }
    expect(await fightPayload(run.id, run.node.id)).toHaveLength(1);
  });

  it('two simultaneous Fight clicks resolve one fight', async () => {
    const seed = await opensOnAFight();
    const { playerId } = await real.player();
    const run = await real.play.start(playerId, ZONE, { seed });
    const results = await Promise.all(Array.from({ length: 4 }, () => real.play.resolveNode(playerId, run.id, run.node.id)));
    expect(results.filter((r) => r.status === 'applied')).toHaveLength(1);
    expect(new Set(results.map((r) => r.run.currentHp)).size).toBe(1);
    expect(await fightPayload(run.id, run.node.id)).toHaveLength(1);
  });

  it('the same run seed gives two players the same fight — there is no more favourable roll to fish for', async () => {
    const seed = await opensOnAFight();
    const outcome = async () => {
      const { playerId } = await real.player();
      const run = await real.play.start(playerId, ZONE, { seed });
      const result = await real.play.resolveNode(playerId, run.id, run.node.id);
      const hits = (result.run.combatEvents ?? []).filter((e) => e.type === 'damage');
      return { hp: result.run.currentHp, hits };
    };
    expect(await outcome()).toEqual(await outcome());
  });

  it('abandoning and starting again does not replay the same dice: a new run has a new seed', async () => {
    const { playerId } = await real.player();
    const seeds = new Set<number>();
    for (let i = 0; i < 3; i++) {
      const run = await real.play.start(playerId, ZONE);
      seeds.add((await real.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, run.id)))[0]!.seed);
      await real.play.abandon(playerId, run.id);
    }
    expect(seeds.size).toBe(3);
    // …and each of those cost a daily run, so rerolling by abandoning is paid for.
    expect(await real.allowance.status(playerId)).toMatchObject({ used: 3, remaining: 0 });
  });
});
