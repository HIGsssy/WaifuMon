/**
 * Health assessment for System Metrics — and, as importantly, where there is
 * none.
 *
 * ## The rule
 *
 * A reading gets a colour only when a threshold follows from what the number
 * *means*: queueing theory, a hard kernel limit, a definitional saturation
 * point, a documented deadline. Everything else is `neutral` — shown with its
 * value and trend, never implied healthy or unhealthy.
 *
 * That leaves several prominent readings deliberately uncoloured, and it is
 * worth saying why rather than letting it look like an omission:
 *
 *   - **CPU %** (process and host). 95% CPU on a batch host is efficient; 40%
 *     on a latency-sensitive one can already be queueing. The number alone does
 *     not say which. Contention is what matters, and CPU *pressure* measures
 *     that directly — so CPU % is informational and pressure is shown beside it.
 *   - **HTTP in-flight.** An I/O-bound Node process can hold hundreds of
 *     requests in flight at negligible cost. No count is "too many" without
 *     latency beside it.
 *   - **RSS without a limit.** Memory growth is only a problem relative to
 *     something that will stop it. With no cgroup limit, the host's own memory
 *     reading is the relevant one, and it is shown separately.
 *   - **PSI `some` averages.** Non-zero CPU `some` pressure is routine on any
 *     busy machine. No published threshold turns a given percentage into a
 *     verdict, and inventing one would be exactly what this module exists to
 *     avoid.
 *
 * ## Levels
 *
 *   ok        a threshold exists and the reading is inside it
 *   warn      approaching a limit: the next increment of load is likely to hurt
 *   critical  at or past a limit: work is being delayed or lost now
 *   neutral   no defensible threshold — value only
 */

export type Level = 'ok' | 'warn' | 'critical' | 'neutral';

export interface Assessment {
  level: Level;
  /** One short line saying why, rendered beside the reading. */
  reason: string;
}

const neutral = (reason: string): Assessment => ({ level: 'neutral', reason });

// ─────────────────────────────────────────────────────── Event-loop utilization

/**
 * Warn at 70% busy, critical at 90%.
 *
 * The event loop is a single server; a request waits for it like a customer in
 * an M/M/1 queue, where mean wait relative to service time is ρ / (1 − ρ). At
 * 50% busy a request waits 1× its own service time; at 70%, 2.3×; at 90%, 9×.
 * The curve is the reason: latency does not degrade linearly with load, it
 * degrades gently and then very suddenly, and 0.7 is roughly where the knee
 * begins. (Real traffic is burstier than M/M/1 assumes, which moves the knee
 * *earlier*, not later.)
 */
export const ELU_WARN = 0.7;
export const ELU_CRITICAL = 0.9;

export function assessEventLoopUtilization(utilization: number | null): Assessment {
  if (utilization === null) return neutral('No reading yet');
  if (utilization >= ELU_CRITICAL)
    return { level: 'critical', reason: 'Loop nearly saturated — requests queue sharply' };
  if (utilization >= ELU_WARN)
    return { level: 'warn', reason: 'Past the queueing knee — latency rising faster than load' };
  return { level: 'ok', reason: 'Loop has headroom' };
}

// ──────────────────────────────────────────────────────────── Event-loop delay

/**
 * Warn at a p99 of 100 ms, critical at 1 s.
 *
 * Every millisecond of loop delay is added to every request and every Discord
 * interaction handled in that moment. 100 ms is the long-standing threshold for
 * a response to feel instantaneous (Nielsen, *Usability Engineering*, 1993); a
 * p99 above it means one interaction in a hundred has gained a perceptible lag
 * *from the loop alone*. 1 s is the same source's limit for keeping the user's
 * flow — and a third of Discord's 3-second window to acknowledge an
 * interaction, past which Discord shows the player "This interaction failed".
 *
 * The monitor's sampling resolution (20 ms) is a floor, not a problem: an idle
 * loop reports roughly that much delay, far below the warn line.
 */
export const LOOP_DELAY_WARN_MS = 100;
export const LOOP_DELAY_CRITICAL_MS = 1_000;

export function assessEventLoopDelay(p99Ms: number | null): Assessment {
  if (p99Ms === null) return neutral('No reading yet');
  if (p99Ms >= LOOP_DELAY_CRITICAL_MS)
    return { level: 'critical', reason: 'Stalls long enough to fail Discord interactions' };
  if (p99Ms >= LOOP_DELAY_WARN_MS)
    return { level: 'warn', reason: 'Stalls long enough for players to notice' };
  return { level: 'ok', reason: 'No perceptible stalls' };
}

// ──────────────────────────────────────────────────────────── Database pool

export interface PoolReading {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  max: number | null;
}

/** Connections checked out, as a fraction of the pool's ceiling. */
export function poolUtilization(pool: PoolReading): number | null {
  if (pool.max === null || pool.max <= 0) return null;
  return Math.min(1, Math.max(0, (pool.totalCount - pool.idleCount) / pool.max));
}

/**
 * Definitional, no percentages.
 *
 *   critical  `waitingCount > 0` — queries are queued for a connection *now*.
 *             This is saturation by definition; it is the reading that would
 *             justify raising the pool size.
 *   warn      every connection is checked out and none is idle. Nothing is
 *             waiting yet, but the next query will.
 *   ok        otherwise.
 *
 * A "busy above 80%" rule was considered and rejected: with a ten-connection
 * pool, 80% is eight connections, and there is nothing special about eight.
 */
export function assessPool(pool: PoolReading | null): Assessment {
  if (pool === null) return neutral('No pool reading');
  if (pool.waitingCount > 0) {
    const n = pool.waitingCount;
    return {
      level: 'critical',
      reason: `${n} ${n === 1 ? 'query' : 'queries'} waiting for a connection`,
    };
  }
  const saturated = pool.max !== null && pool.totalCount >= pool.max && pool.idleCount === 0;
  if (saturated) return { level: 'warn', reason: 'Every connection busy — the next query waits' };
  return { level: 'ok', reason: 'Connections available' };
}

// ──────────────────────────────────────────────────────────── Card renderer

export interface RendererReading {
  size: number;
  active: number;
  queued: number;
}

/**
 * Measured in render *rounds*, so it does not depend on how long a render takes
 * on this machine — the one figure that has not been measured on the target
 * hardware yet.
 *
 *   critical  `queued >= size` — at least one full round of backlog. A newly
 *             requested cold card waits for every worker to finish a render
 *             before its own even starts.
 *   warn      every worker busy, or anything queued. The next cold card waits.
 *   ok        a worker is free.
 *   neutral   in-process rendering (`size` 0), or no renderer in this process.
 */
export function assessRenderer(reading: RendererReading | null): Assessment {
  if (reading === null) return neutral('No card rendered yet');
  if (reading.size <= 0) return neutral('Rendering in-process (no worker pool)');
  if (reading.queued >= reading.size)
    return { level: 'critical', reason: 'A full round of renders is backed up' };
  if (reading.queued > 0) return { level: 'warn', reason: 'Cold cards are queueing' };
  if (reading.active >= reading.size)
    return { level: 'warn', reason: 'All workers busy — the next cold card waits' };
  return { level: 'ok', reason: reading.active === 0 ? 'Idle' : 'Workers available' };
}

// ─────────────────────────────────────────────────────────────── Memory

/**
 * Only a hard event gets a colour: the kernel OOM-killing something in this
 * cgroup. Anything short of that is neutral, because:
 *
 *   - without a cgroup limit there is nothing to be close *to*;
 *   - with one, `memory.current` includes reclaimable page cache, so 90% of the
 *     limit can be perfectly healthy — the kernel reclaims cache before it
 *     kills. A percentage threshold here would be a guess dressed as a rule.
 */
export function assessMemory(oomKills: number | null): Assessment {
  if (oomKills !== null && oomKills > 0) {
    return {
      level: 'critical',
      reason: `The kernel has OOM-killed ${oomKills} ${oomKills === 1 ? 'process' : 'processes'} in this container`,
    };
  }
  return neutral('No limit-based threshold — see host memory');
}

// ────────────────────────────────────────────────────────────── HTTP errors

/**
 * Server errors in the last interval.
 *
 * A 5xx is by definition the server's fault — it is how this API reports a
 * defect or an unavailable dependency — so any is worth attention. `warn`
 * rather than `critical`: a single 5xx is a signal to look, not proof the
 * system is failing. 4xx is not assessed at all: those are callers' mistakes
 * (bad input, expired sessions), and under a load test a scripted 404 would
 * otherwise light the dashboard up for no server-side reason.
 */
export function assessServerErrors(recentServerErrors: number | null): Assessment {
  if (recentServerErrors === null) return neutral('No reading yet');
  if (recentServerErrors > 0) {
    const n = recentServerErrors;
    return {
      level: 'warn',
      reason: `${n} server ${n === 1 ? 'error' : 'errors'} in the last interval`,
    };
  }
  return { level: 'ok', reason: 'No server errors' };
}

// ────────────────────────────────────────────────────────────── Host signals

/**
 * Warn when the one-minute load exceeds one per core.
 *
 * On Linux, load counts tasks that are running, runnable, or in uninterruptible
 * (usually disk) sleep. Above one per core, more tasks want to run than there
 * are cores to run them — by definition, something is waiting. Not `critical`:
 * load averages lag by design, and a brief excursion is normal. The per-core
 * normalization is what makes the rule independent of machine size.
 */
export function assessLoadPerCore(loadPerCore: number | null): Assessment {
  if (loadPerCore === null) return neutral('No reading');
  if (loadPerCore > 1) return { level: 'warn', reason: 'More runnable tasks than cores' };
  return { level: 'ok', reason: 'Fewer runnable tasks than cores' };
}

/**
 * Warn on any non-zero `full` pressure for memory or I/O.
 *
 * `full` is the share of time in which *every* non-idle task on the machine was
 * stalled on the resource simultaneously — wall time in which nothing useful
 * ran at all. Any sustained value above zero is lost capacity, which is a
 * definitional line rather than a chosen one. `some` averages are shown without
 * a verdict; see the module note.
 */
export function assessFullPressure(fullAvg10: number | null): Assessment {
  if (fullAvg10 === null) return neutral('Not reported');
  if (fullAvg10 > 0) return { level: 'warn', reason: 'At times every task was stalled' };
  return { level: 'ok', reason: 'No full stalls' };
}

/** The more severe of several assessments — for a panel with more than one signal. */
export function worst(...assessments: Assessment[]): Assessment {
  const rank: Record<Level, number> = { neutral: 0, ok: 1, warn: 2, critical: 3 };
  return assessments.reduce((a, b) => (rank[b.level] > rank[a.level] ? b : a), neutral(''));
}
