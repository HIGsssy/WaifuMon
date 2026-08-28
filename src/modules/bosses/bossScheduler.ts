/**
 * BossScheduler — the clock, and nothing else.
 *
 * A plain interval that asks the same question every minute: for each guild
 * with a boss channel configured, is there anything to do? Everything it might
 * *decide* lives in `BossEncounterService`; everything it might *say* lives
 * behind the injected {@link BossAnnouncer}. This file only orders the steps
 * and makes sure a failure in one guild cannot stop the next.
 *
 * **Why a tick rather than a timer per encounter.** A `setTimeout` scheduled
 * for a deadline half an hour away is state that exists only in one
 * process's
 * memory: a restart forgets it, and a second process would duplicate it. A
 * tick that re-derives what is due from the database is stateless by
 * construction, which is what makes restart recovery and multi-process
 * operation the *same* code path rather than two.
 *
 * Recovery is therefore not a special mode. On every tick, in this order:
 *
 *   1. **Resolve what is past its deadline** — including `resolving` rows
 *      whose owner died, which the service re-claims after a timeout. Resolving
 *      first means a guild whose window just closed gets its results before
 *      the next boss is considered, and frees the one-active slot.
 *   2. **Deliver what resolution still owes Discord** — the completion edit on
 *      an encounter message and the separate results message beneath it. Step 1
 *      already attempts both; this step is what makes a Discord outage, or a
 *      crash between the two calls, self-healing rather than permanent. Both
 *      halves are stamped in the database when they land, so this is a no-op
 *      on every tick where there is nothing outstanding.
 *   3. **Refresh live announcements** — participant count and countdown.
 *   4. **Draw the next appearance** if the guild is due one. Resolution has
 *      already pushed `next_spawn_at` out past the downtime band, so freeing
 *      the slot in step 1 cannot cause an immediate re-spawn.
 *   5. **Announce anything `scheduled`** — both what step 4 just drew and what
 *      a crash between a draw and its announcement left behind. Announcing
 *      last is what lets one pass take a boss all the way from drawn to live,
 *      rather than making every appearance wait a full tick. The persisted
 *      `message_id` is what stops this from posting a second announcement.
 *
 * The tick is re-entrancy guarded: a slow pass (a rate-limited Discord edit)
 * must not overlap the next one and resolve the same encounter twice. The
 * database claim would catch it anyway; this just keeps the logs honest.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { guilds, type BossEncounterRow, type GuildRow } from '../../db/schema';
import type { Logger } from '../../shared/logger';
import type { BossEncounterService } from './bossEncounterService';

/** What the scheduler needs Discord to do, with no discord.js in sight. */
export interface BossAnnouncer {
  /**
   * Verify the guild can host encounters right now.
   *
   * Returns the missing permissions (empty when everything checks out) or
   * `null` when the channel is gone entirely. The scheduler suspends on either
   * — a channel it cannot post in and a channel that no longer exists are the
   * same problem from the players' side.
   */
  verifyChannel(channelId: string): Promise<{ missing: string[] } | null>;
  /** Post the opening announcement. Returns the new message id. */
  postAnnouncement(encounter: BossEncounterRow, channelId: string): Promise<string>;
  /** Edit the live announcement in place. Never posts a replacement. */
  refreshAnnouncement(encounter: BossEncounterRow): Promise<void>;
  /**
   * Close the encounter out in Discord: edit the original announcement into
   * its terminal form, then post a **separate** results message beneath it.
   *
   * Resumable and idempotent — each half is stamped in the database once it
   * lands, so calling this on an encounter that is already fully published
   * does nothing, and calling it on one that got halfway finishes the job.
   * That is what lets the scheduler treat recovery as an ordinary step.
   */
  publishResults(encounterId: number): Promise<void>;
}

/**
 * Post-commit domain events, injected rather than imported.
 *
 * The scheduler has no player and no interaction to build a `GameEventSource`
 * from, so the envelope is assembled by the caller that owns the bus. Every
 * call here happens *after* the owning write has committed, and a throwing
 * emitter is swallowed by the step that raised it — a broken subscriber must
 * never stop an encounter from resolving.
 */
export interface BossSchedulerEvents {
  encounterStarted(encounter: BossEncounterRow): Promise<void>;
  encounterResolved(
    encounter: BossEncounterRow,
    summary: { reason: string; participantCount: number; totalDamage: number; totalAttacks: number },
  ): Promise<void>;
  rewardsApplied(
    encounter: BossEncounterRow,
    summary: { participantCount: number; totalXp: number; totalItems: number },
  ): Promise<void>;
  schedulingSuspended(guildDbId: number, reason: string, channelId: string | null): Promise<void>;
}

export interface BossSchedulerDeps {
  db: Db;
  encounters: BossEncounterService;
  announcer: BossAnnouncer;
  logger: Logger;
  /** Optional: a scheduler without it simply emits nothing. */
  events?: BossSchedulerEvents | undefined;
  /** Milliseconds between passes. Sixty seconds by default. */
  intervalMs?: number;
  /** Injected so tests can drive time without waiting for it. */
  now?: () => Date;
}

export interface BossScheduler {
  /** Run one full pass. Exported so a test drives the loop deterministically. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  readonly running: boolean;
}

const DEFAULT_INTERVAL_MS = 60_000;

export function createBossScheduler(deps: BossSchedulerDeps): BossScheduler {
  const { db, encounters, announcer, logger } = deps;
  /**
   * Emission is best-effort by construction: a subscriber failure is logged
   * and dropped rather than allowed to abort the step that raised it, matching
   * the bus's own contract.
   */
  const emit = async (fn: () => Promise<void>, tag: string): Promise<void> => {
    if (!deps.events) return;
    try {
      await fn();
    } catch (err) {
      logger.warn({ tag: `boss/event-failed`, event: tag, err }, 'boss event emission failed');
    }
  };
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const clock = deps.now ?? (() => new Date());

  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;

  /** Guilds that have opted in. A null channel means bosses are simply off. */
  async function configuredGuilds(): Promise<GuildRow[]> {
    return db.select().from(guilds).where(isNotNull(guilds.bossChannelId));
  }

  /**
   * Channel pre-flight, and the only place a suspension is raised or lifted.
   *
   * Returns the usable channel id, or null after suspending. The suspension is
   * cleared on the first pass that succeeds again, so an admin who fixes the
   * permission does not also have to remember to un-suspend.
   */
  async function checkChannel(guild: GuildRow): Promise<string | null> {
    const channelId = guild.bossChannelId;
    if (!channelId) return null;
    let verdict: { missing: string[] } | null;
    try {
      verdict = await announcer.verifyChannel(channelId);
    } catch (err) {
      logger.warn(
        { tag: 'boss/channel-check-failed', guildId: guild.id, channelId, err },
        'boss channel verification threw — treating as unusable',
      );
      verdict = null;
    }
    if (verdict === null) {
      const reason =
        `The configured boss channel (<#${channelId}>) is missing or I cannot see it. ` +
        'Re-configure it with `/waifumon-admin boss set-channel`.';
      await encounters.suspend(guild.id, reason, clock());
      await emit(
        () => deps.events!.schedulingSuspended(guild.id, reason, channelId),
        'suspended',
      );
      return null;
    }
    if (verdict.missing.length > 0) {
      const reason =
        `I am missing ${verdict.missing.join(', ')} in <#${channelId}>. ` +
        'Grant them, then run `/waifumon-admin boss resume`.';
      await encounters.suspend(guild.id, reason, clock());
      await emit(
        () => deps.events!.schedulingSuspended(guild.id, reason, channelId),
        'suspended',
      );
      return null;
    }
    await encounters.clearSuspension(guild.id);
    return channelId;
  }

  /**
   * Step 1 — close every window that is due, including stale claims.
   *
   * Returns the encounter ids this pass already attempted to publish, so step 2
   * can leave them alone. Retrying a publish microseconds after it failed is
   * strictly worse than waiting for the next tick — the usual reason it failed
   * is a rate limit, and an immediate second call feeds it.
   */
  async function resolveDue(): Promise<Set<number>> {
    const now = clock();
    const attempted = new Set<number>();
    for (const encounter of await encounters.findResolvable(now)) {
      try {
        const result = await encounters.resolve(encounter.id, now);
        if (!result) continue;
        // Only when *this* pass did the work. A caller that found the
        // encounter already finished must not re-announce it on the bus.
        if (result.applied) {
          await emit(
            () =>
              deps.events!.encounterResolved(result.encounter, {
                reason: result.reason,
                participantCount: result.participants.length,
                totalDamage: result.totalDamage,
                totalAttacks: result.totalAttacks,
              }),
            'resolved',
          );
          await emit(
            () =>
              deps.events!.rewardsApplied(result.encounter, {
                participantCount: result.participants.length,
                totalXp: result.participants.reduce(
                  (sum, p) => sum + (p.participation.xpAwarded ?? 0),
                  0,
                ),
                totalItems: result.participants.reduce(
                  (sum, p) => sum + p.rewards.reduce((n, r) => n + r.quantity, 0),
                  0,
                ),
              }),
            'rewards-applied',
          );
        }
        // Publishing is a *presentation* step and is deliberately outside the
        // reward transaction: a Discord outage must never roll back XP and
        // items that have already been granted. The results are stored, so a
        // later pass — or an admin repair — can publish them without repaying.
        try {
          attempted.add(encounter.id);
          await announcer.publishResults(encounter.id);
        } catch (err) {
          logger.error(
            {
              tag: 'boss/publish-failed',
              encounterId: encounter.id,
              guildId: encounter.guildId,
              err,
            },
            'boss results committed but the Discord update failed — rewards are safe',
          );
        }
      } catch (err) {
        logger.error(
          { tag: 'boss/resolve-failed', encounterId: encounter.id, err },
          'boss resolution failed — will retry on the next pass',
        );
      }
    }
    return attempted;
  }

  /**
   * Step 2 — finish any Discord delivery a resolution left outstanding.
   *
   * The completion edit and the results message are both stamped in the
   * database only after Discord accepts them, so "outstanding" is a query
   * rather than a memory of what this process tried. That makes three cases
   * one code path: a crash between the two calls, a Discord outage during
   * `resolveDue`, and a restart hours later.
   *
   * `publishResults` is itself idempotent and resumable, so this step does not
   * need to know *which* half is missing — it just asks again.
   *
   * `justAttempted` carries the ids step 1 already tried this pass. Skipping
   * them is what keeps this a *recovery* step rather than an instant retry
   * loop: a publish that just failed is left for the next tick, a minute away.
   */
  async function deliverPending(justAttempted: ReadonlySet<number>): Promise<void> {
    for (const encounter of await encounters.findUndelivered()) {
      if (justAttempted.has(encounter.id)) continue;
      try {
        await announcer.publishResults(encounter.id);
      } catch (err) {
        // Never fatal. Rewards were applied inside `resolve`; everything
        // outstanding here is presentation, and the row still says so.
        logger.warn(
          { tag: 'boss/deliver-failed', encounterId: encounter.id, err },
          'boss results delivery repair failed — will retry on the next pass',
        );
      }
    }
  }

  /**
   * Step 3 — announce anything drawn but never posted.
   *
   * The order here is what makes a crash safe in both directions: the message
   * is posted *first*, then `beginScouting` records its id and stamps the
   * deadline. A crash between the two leaves an orphan message and a
   * `scheduled` row, and the next pass posts again — one duplicate message, no
   * duplicate encounter. The reverse order would risk a live encounter nobody
   * can see, which is strictly worse.
   */
  async function announceScheduled(channelByGuild: ReadonlyMap<number, string>): Promise<void> {
    for (const encounter of await encounters.findUnannounced()) {
      const channelId = channelByGuild.get(encounter.guildId);
      // No usable channel: leave it `scheduled`. It costs nothing to sit there,
      // and the moment the admin fixes the channel it opens rather than being
      // silently lost.
      if (!channelId) continue;
      try {
        const messageId = await announcer.postAnnouncement(encounter, channelId);
        const opened = await encounters.beginScouting(
          encounter.id,
          channelId,
          messageId,
          clock(),
        );
        await emit(() => deps.events!.encounterStarted(opened), 'started');
      } catch (err) {
        logger.error(
          { tag: 'boss/announce-failed', encounterId: encounter.id, channelId, err },
          'boss announcement failed — encounter stays scheduled and will retry',
        );
      }
    }
  }

  /** Step 4 — keep the countdown and participant count current. */
  async function refreshLive(): Promise<void> {
    for (const encounter of await encounters.findScouting()) {
      try {
        await announcer.refreshAnnouncement(encounter);
      } catch (err) {
        // Never fatal and never escalated: a failed edit costs a stale
        // countdown, and the resolution path does not depend on it.
        logger.warn(
          { tag: 'boss/refresh-failed', encounterId: encounter.id, err },
          'boss announcement refresh failed',
        );
      }
    }
  }

  /** Step 5 — draw the next appearance where one is due. */
  async function spawnDue(guildIds: readonly number[]): Promise<void> {
    const now = clock();
    for (const guildId of guildIds) {
      try {
        await encounters.spawnIfDue(guildId, now);
      } catch (err) {
        logger.error(
          { tag: 'boss/spawn-failed', guildId, err },
          'boss spawn failed — will retry on the next pass',
        );
      }
    }
  }

  async function tick(): Promise<void> {
    if (inFlight) {
      logger.debug({ tag: 'boss/tick-skipped' }, 'boss scheduler pass still running');
      return;
    }
    inFlight = true;
    const started = Date.now();
    try {
      const guildRows = await configuredGuilds();
      const channelByGuild = new Map<number, string>();
      for (const guild of guildRows) {
        const channelId = await checkChannel(guild);
        if (channelId) channelByGuild.set(guild.id, channelId);
      }

      // Order matters, and each step touches a disjoint set of encounters:
      //   resolve  — windows that are past their deadline (frees the slot)
      //   deliver  — finish the completion edit / results message for anything
      //              already resolved that Discord has not received yet
      //   refresh  — windows that are still open (countdown, participant count)
      //   spawn    — draw the next appearance where one is due
      //   announce — post for anything `scheduled`, including what spawn just
      //              drew, so a boss appears in the *same* pass rather than up
      //              to a minute later
      //
      // `deliver` runs before `announce` so a channel never shows the next
      // boss above the previous encounter's results.
      const justResolved = await resolveDue();
      await deliverPending(justResolved);
      await refreshLive();
      await spawnDue([...channelByGuild.keys()]);
      await announceScheduled(channelByGuild);

      logger.debug(
        {
          tag: 'boss/tick',
          guilds: guildRows.length,
          usable: channelByGuild.size,
          durationMs: Date.now() - started,
        },
        'boss scheduler pass complete',
      );
    } catch (err) {
      // A pass that dies takes nothing with it — every decision it might have
      // made is re-derivable from the database next minute.
      logger.error({ tag: 'boss/tick-failed', err }, 'boss scheduler pass failed');
    } finally {
      inFlight = false;
    }
  }

  return {
    tick,
    get running() {
      return timer !== undefined;
    },
    start() {
      if (timer) return;
      // `unref` so a pending tick cannot hold the process open during shutdown.
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
      logger.info({ tag: 'boss/scheduler-start', intervalMs }, 'boss scheduler started');
      // An immediate first pass, so a restart recovers in-flight encounters now
      // rather than up to a minute from now.
      void tick();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
      logger.info({ tag: 'boss/scheduler-stop' }, 'boss scheduler stopped');
    },
  };
}

/** Narrowed guild lookup used by the admin commands. Kept here beside its table. */
export async function findGuildByDiscordId(
  db: Db,
  discordGuildId: string,
): Promise<GuildRow | undefined> {
  const [row] = await db
    .select()
    .from(guilds)
    .where(and(eq(guilds.discordGuildId, discordGuildId)));
  return row;
}
