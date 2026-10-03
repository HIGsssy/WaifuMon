/**
 * The daily Delve allowance: how many dungeon runs a player may start per game
 * day, and how many they have started.
 *
 * ## One allowance, every zone
 *
 * The limit is a Delve-wide setting (`dungeon_settings.daily_run_limit`,
 * edited in Portal Admin), not a property of a zone. Starting a run in any
 * zone draws on the same allowance. Nothing here reads or spends Energy.
 *
 * ## Stored usage, not a refilled counter
 *
 * `dungeon_daily_usage` holds one row per player per game day on which they
 * started a run. What is left is always computed:
 *
 *   remaining = max(0, daily limit − runs started in the current period)
 *
 * A new day has no row, so it has a full allowance — there is no midnight job
 * and nothing to refill. Raising or lowering the limit takes effect at once
 * for everyone, because nothing was ever handed out.
 *
 * ## The game day
 *
 * `periodKey` is the calendar date (`YYYY-MM-DD`) in the configured
 * `DAILY_TIMEZONE` — exactly the day the daily claim keys on
 * (`claimDateInTimezone`), rolling over at that zone's midnight
 * (`nextResetAt`). Delve does not have a reset boundary of its own.
 *
 * ## Consumption
 *
 * {@link DungeonAllowanceService.consume} is called inside the transaction
 * that creates the run, and only there. It is one conditional upsert —
 * "add one where fewer than the limit have been started" — so the count can
 * never pass the limit however many transactions race, and a transaction that
 * rolls back (generation failed, the insert failed) takes its attempt back
 * with it. Nothing ever refunds one: how a run ends does not matter.
 *
 * `daily_run_limit = 0` is legal and means Delve is closed to new runs. An
 * active run is unaffected: it was already started.
 *
 * ## Bonus attempts (not built)
 *
 * Event, achievement, admin and item grants would add to the *limit* for a
 * period, not subtract from usage: effective limit = base limit + grants that
 * apply to the period. That is a grants table keyed by player (and, for a
 * dated bonus, period) read beside the settings row in {@link status} and
 * {@link consume}; `runs_started` keeps its meaning. A per-zone cap would be a
 * second, zone-keyed usage row checked in the same transaction.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { dungeonDailyUsage, dungeonSettings } from '../../db/schema';
import { DungeonDailyLimitError, DungeonSettingsInvalidError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { claimDateInTimezone, nextResetAt } from '../../shared/time';

/** The one settings row's primary key. The table's CHECK pins it to this. */
const SETTINGS_ID = 1;

/** Initial tuning: three runs a day, shared across every zone. */
export const DEFAULT_DUNGEON_DAILY_RUN_LIMIT = 3;

/** Bounds the API, this service and the table's CHECK constraint all enforce. */
export const DUNGEON_DAILY_RUN_LIMIT_BOUNDS = { min: 0, max: 50 } as const;

export interface DungeonSettings {
  /** Runs a player may start per game day. 0 closes Delve to new runs. */
  dailyRunLimit: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface DungeonSettingsPatch {
  dailyRunLimit?: number | undefined;
}

/** A player's allowance for the current game day. */
export interface DungeonDailyAllowance {
  /** The configured limit. */
  limit: number;
  /** Runs started this period. Can exceed `limit` after the limit is lowered. */
  used: number;
  /** `max(0, limit − used)`. */
  remaining: number;
  /** The game day, `YYYY-MM-DD` in the daily timezone. */
  periodKey: string;
  /** When the next game day — and a full allowance — begins. */
  resetsAt: Date;
}

export interface DungeonAllowanceService {
  /** Delve-wide settings. Creates the row from the defaults on a fresh install. */
  getSettings(tx?: DbOrTx): Promise<DungeonSettings>;
  /** @throws {DungeonSettingsInvalidError} for a value outside its bounds. */
  updateSettings(patch: DungeonSettingsPatch, actor?: string | null): Promise<DungeonSettings>;
  /** The player's allowance for the game day containing `now`. */
  status(playerId: number, tx?: DbOrTx, now?: Date): Promise<DungeonDailyAllowance>;
  /**
   * Spend one attempt, in the caller's transaction. Returns the allowance
   * after it.
   *
   * @throws {DungeonDailyLimitError} when none is left; nothing is written.
   */
  consume(tx: DbOrTx, playerId: number, now?: Date): Promise<DungeonDailyAllowance>;
  /** Forget what the player has started in the current period. Test tooling only. */
  resetUsage(tx: DbOrTx, playerId: number, now?: Date): Promise<{ periodKey: string; cleared: number }>;
}

export interface DungeonAllowanceServiceDeps {
  db: Db;
  /** `DAILY_TIMEZONE` — the zone the daily claim's day is counted in. */
  timezone: string;
  logger?: Pick<Logger, 'info'> | undefined;
  /** The clock. Injected by tests to cross a reset. */
  now?: (() => Date) | undefined;
}

/** One statement of what a valid patch is, shared by the route and the service. */
export function validateDungeonSettingsPatch(patch: DungeonSettingsPatch): string[] {
  const issues: string[] = [];
  if (patch.dailyRunLimit !== undefined) {
    const { min, max } = DUNGEON_DAILY_RUN_LIMIT_BOUNDS;
    if (!Number.isInteger(patch.dailyRunLimit)) {
      issues.push('dailyRunLimit must be a whole number.');
    } else if (patch.dailyRunLimit < min || patch.dailyRunLimit > max) {
      issues.push(`dailyRunLimit must be between ${min} and ${max}.`);
    }
  }
  return issues;
}

export function createDungeonAllowanceService(deps: DungeonAllowanceServiceDeps): DungeonAllowanceService {
  const { db, timezone } = deps;
  const clock = deps.now ?? (() => new Date());

  async function getSettings(tx: DbOrTx = db): Promise<DungeonSettings> {
    const read = () => tx.select().from(dungeonSettings).where(eq(dungeonSettings.id, SETTINGS_ID));
    let [row] = await read();
    if (!row) {
      // The migration seeds the row; this covers a database emptied under it.
      await tx
        .insert(dungeonSettings)
        .values({ id: SETTINGS_ID, dailyRunLimit: DEFAULT_DUNGEON_DAILY_RUN_LIMIT })
        .onConflictDoNothing();
      [row] = await read();
      if (!row) throw new Error('dungeon settings row could not be created');
    }
    return { dailyRunLimit: row.dailyRunLimit, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
  }

  async function runsStarted(tx: DbOrTx, playerId: number, periodKey: string): Promise<number> {
    const [row] = await tx
      .select({ runsStarted: dungeonDailyUsage.runsStarted })
      .from(dungeonDailyUsage)
      .where(and(eq(dungeonDailyUsage.playerId, playerId), eq(dungeonDailyUsage.periodKey, periodKey)));
    return row?.runsStarted ?? 0;
  }

  function allowance(limit: number, used: number, now: Date): DungeonDailyAllowance {
    return {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      periodKey: claimDateInTimezone(now, timezone),
      resetsAt: nextResetAt(now, timezone),
    };
  }

  return {
    getSettings,

    async updateSettings(patch, actor = null) {
      const issues = validateDungeonSettingsPatch(patch);
      if (issues.length > 0) throw new DungeonSettingsInvalidError(issues);
      const before = await getSettings();
      const [row] = await db
        .update(dungeonSettings)
        .set({
          ...(patch.dailyRunLimit !== undefined ? { dailyRunLimit: patch.dailyRunLimit } : {}),
          updatedAt: sql`now()`,
          updatedBy: actor,
        })
        .where(eq(dungeonSettings.id, SETTINGS_ID))
        .returning();
      if (!row) throw new Error('dungeon settings row missing after update');
      deps.logger?.info(
        { tag: 'dungeons/settings-updated', actor, dailyRunLimit: row.dailyRunLimit, previousDailyRunLimit: before.dailyRunLimit },
        'dungeon settings updated',
      );
      return { dailyRunLimit: row.dailyRunLimit, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
    },

    async status(playerId, tx = db, now = clock()) {
      const { dailyRunLimit } = await getSettings(tx);
      return allowance(dailyRunLimit, await runsStarted(tx, playerId, claimDateInTimezone(now, timezone)), now);
    },

    async consume(tx, playerId, now = clock()) {
      const { dailyRunLimit: limit } = await getSettings(tx);
      const periodKey = claimDateInTimezone(now, timezone);
      // One statement, so the check and the increment cannot be separated: the
      // row lock the upsert takes makes a second transaction wait and then
      // re-evaluate `runs_started < limit` against the committed count.
      const [row] =
        limit > 0
          ? await tx
              .insert(dungeonDailyUsage)
              .values({ playerId, periodKey, runsStarted: 1 })
              .onConflictDoUpdate({
                target: [dungeonDailyUsage.playerId, dungeonDailyUsage.periodKey],
                set: { runsStarted: sql`${dungeonDailyUsage.runsStarted} + 1`, updatedAt: sql`now()` },
                setWhere: sql`${dungeonDailyUsage.runsStarted} < ${limit}`,
              })
              .returning({ runsStarted: dungeonDailyUsage.runsStarted })
          : [];
      if (!row) throw new DungeonDailyLimitError(playerId, limit, await runsStarted(tx, playerId, periodKey), periodKey);
      return allowance(limit, row.runsStarted, now);
    },

    async resetUsage(tx, playerId, now = clock()) {
      const periodKey = claimDateInTimezone(now, timezone);
      const [row] = await tx
        .delete(dungeonDailyUsage)
        .where(and(eq(dungeonDailyUsage.playerId, playerId), eq(dungeonDailyUsage.periodKey, periodKey)))
        .returning({ runsStarted: dungeonDailyUsage.runsStarted });
      return { periodKey, cleared: row?.runsStarted ?? 0 };
    },
  };
}
