/**
 * Request latency and request counts, recorded in-process.
 *
 * Built on `perf_hooks.createHistogram()` — a native HDR histogram — rather
 * than a bucket array or a percentile library. Three reasons it is the right
 * primitive here:
 *
 *  - **No dependency.** It ships with Node, which matters for a process that
 *    deliberately has no Redis, no Prometheus client and no metrics agent.
 *  - **Bounded memory.** An HDR histogram's footprint is a function of its
 *    value *range*, not of how many samples it holds. A million requests cost
 *    the same few KB as a thousand, so this can stay enabled indefinitely.
 *  - **Real percentiles.** p99 is read from the recorded distribution, not
 *    interpolated from a mean and a max, which is what makes it usable as the
 *    acceptance signal for a capacity test.
 *
 * ## Microseconds, not milliseconds
 *
 * Samples are recorded as integer microseconds. `record()` rejects zero, and a
 * warm card hit or an indexed single-row read genuinely takes well under a
 * millisecond — recording those in whole milliseconds would floor an entire
 * class of fast routes to the histogram's minimum and make p50 meaningless.
 * Readers convert back to milliseconds, so the reported unit is still `ms`.
 *
 * ## Route keys, not URLs
 *
 * Per-route breakdown is keyed on Fastify's route *pattern*
 * (`/api/v1/players/:playerId/collection`), never the concrete URL. That caps
 * cardinality at the number of registered routes — around eighty — instead of
 * growing without bound as player ids vary. A request that matched no route is
 * folded into a single `<unrouted>` key rather than being dropped, so a flood
 * of 404s is visible instead of silently absent.
 */
import { createHistogram, type RecordableHistogram } from 'node:perf_hooks';

/** Microseconds; the smallest value the histogram will accept. */
const MIN_SAMPLE_US = 1;

/**
 * Key used for requests that never matched a route.
 *
 * Angle brackets cannot appear in a Fastify route pattern, so this can never
 * collide with a real one.
 */
export const UNROUTED_KEY = '<unrouted>';

/** Latency percentiles, in milliseconds. Null throughout when nothing was recorded. */
export interface LatencySummary {
  count: number;
  minMs: number | null;
  meanMs: number | null;
  maxMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

/** Requests grouped by HTTP status class, plus the two aggregates worth naming. */
export interface RequestCounts {
  total: number;
  /** `1xx` … `5xx`, and `other` for a status outside 100–599. */
  byStatusClass: Record<string, number>;
  /** 4xx + 5xx. The number an error-rate calculation wants. */
  errors: number;
  /** 5xx alone — ours to fix, as distinct from a caller's bad request. */
  serverErrors: number;
}

export interface RouteMetrics {
  route: string;
  method: string;
  counts: RequestCounts;
  latency: LatencySummary;
}

/**
 * Requests completed during the last finished sampling interval.
 *
 * The cumulative `counts` and `latency` describe the whole window since start
 * or reset — right for isolating a load-test phase, wrong for "what is
 * happening now": after an hour, a new latency spike barely moves a cumulative
 * p99. This is the "now" reading. The interval is driven by the system sampler's
 * clock (`rotateRecent`), so every reader sees the same one.
 */
export interface RecentHttpMetrics {
  /** Wall time the interval covered. */
  intervalMs: number;
  /** Completed requests per second over the interval. */
  requestsPerSecond: number;
  counts: RequestCounts;
  latency: LatencySummary;
}

export interface HttpMetrics {
  /** Requests that have started but not yet sent a response. */
  inFlight: number;
  /** High-water mark of `inFlight` since the last reset. */
  peakInFlight: number;
  counts: RequestCounts;
  latency: LatencySummary;
  /** Sorted by descending request count, so the busiest route reads first. */
  routes: RouteMetrics[];
  /** The last completed sampling interval; null until one has completed. */
  recent: RecentHttpMetrics | null;
  /** When the current measurement window began. */
  windowStartedAt: string;
}

/** Reads a histogram as milliseconds, reporting nulls rather than sentinels. */
export function summarize(histogram: RecordableHistogram): LatencySummary {
  const count = Number(histogram.count);
  // An empty HDR histogram reports min as INT64_MAX and mean as NaN. Surfacing
  // either would put a 9.2e15 in a latency field, so an empty window is
  // reported as explicitly absent instead.
  if (count === 0) {
    return { count: 0, minMs: null, meanMs: null, maxMs: null, p50Ms: null, p95Ms: null, p99Ms: null };
  }
  const toMs = (us: number): number => Math.round((us / 1000) * 1000) / 1000;
  return {
    count,
    minMs: toMs(Number(histogram.min)),
    meanMs: toMs(histogram.mean),
    maxMs: toMs(Number(histogram.max)),
    p50Ms: toMs(Number(histogram.percentile(50))),
    p95Ms: toMs(Number(histogram.percentile(95))),
    p99Ms: toMs(Number(histogram.percentile(99))),
  };
}

function emptyCounts(): RequestCounts {
  return { total: 0, byStatusClass: {}, errors: 0, serverErrors: 0 };
}

function copyCounts(counts: RequestCounts): RequestCounts {
  return { ...counts, byStatusClass: { ...counts.byStatusClass } };
}

function countStatus(counts: RequestCounts, statusCode: number): void {
  counts.total += 1;
  const klass =
    statusCode >= 100 && statusCode <= 599 ? `${Math.floor(statusCode / 100)}xx` : 'other';
  counts.byStatusClass[klass] = (counts.byStatusClass[klass] ?? 0) + 1;
  if (statusCode >= 400) counts.errors += 1;
  if (statusCode >= 500) counts.serverErrors += 1;
}

interface RouteBucket {
  route: string;
  method: string;
  counts: RequestCounts;
  histogram: RecordableHistogram;
}

/**
 * One recorder per process. Cheap enough to leave on: a record is an integer
 * clamp plus a native histogram write, and the per-route map is bounded by the
 * route table.
 */
export class LatencyRecorder {
  private readonly now: () => number;
  private readonly overall = createHistogram();
  /** The interval in progress; becomes `lastInterval` on `rotateRecent`. */
  private readonly current = createHistogram();
  private readonly currentCounts = emptyCounts();
  private currentStartedAt: number;
  private lastInterval: RecentHttpMetrics | null = null;
  private readonly overallCounts = emptyCounts();
  private readonly routes = new Map<string, RouteBucket>();
  private inFlightCount = 0;
  private peakInFlight = 0;
  private windowStartedAt: Date;

  /** `now` is injectable so interval arithmetic can be tested without waiting. */
  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.currentStartedAt = this.now();
    this.windowStartedAt = new Date(this.currentStartedAt);
  }

  /** Call when a request begins. Pair with exactly one {@link recordResponse}. */
  requestStarted(): void {
    this.inFlightCount += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlightCount);
  }

  /**
   * Call when a response is sent.
   *
   * `durationMs` is a float; it is converted to integer microseconds and
   * clamped to at least 1, because the histogram rejects zero and a
   * sub-microsecond response is still a response worth counting.
   */
  recordResponse(params: {
    method: string;
    route: string | undefined;
    statusCode: number;
    durationMs: number;
  }): void {
    if (this.inFlightCount > 0) this.inFlightCount -= 1;

    const us = Math.max(MIN_SAMPLE_US, Math.round(params.durationMs * 1000));
    this.overall.record(us);
    countStatus(this.overallCounts, params.statusCode);
    this.current.record(us);
    countStatus(this.currentCounts, params.statusCode);

    const route = params.route ?? UNROUTED_KEY;
    const key = `${params.method} ${route}`;
    let bucket = this.routes.get(key);
    if (bucket === undefined) {
      bucket = { route, method: params.method, counts: emptyCounts(), histogram: createHistogram() };
      this.routes.set(key, bucket);
    }
    bucket.histogram.record(us);
    countStatus(bucket.counts, params.statusCode);
  }

  /**
   * A request that ended without a response — the connection went away.
   *
   * Decrements in-flight without recording a latency sample, so an aborted
   * request cannot inflate `inFlight` for the life of the process nor land in
   * the latency distribution as a fabricated duration.
   */
  requestAborted(): void {
    if (this.inFlightCount > 0) this.inFlightCount -= 1;
  }

  snapshot(): HttpMetrics {
    const routes = [...this.routes.values()]
      .map((b) => ({
        route: b.route,
        method: b.method,
        counts: copyCounts(b.counts),
        latency: summarize(b.histogram),
      }))
      .sort((a, b) => b.counts.total - a.counts.total);

    return {
      inFlight: this.inFlightCount,
      peakInFlight: this.peakInFlight,
      counts: copyCounts(this.overallCounts),
      latency: summarize(this.overall),
      routes,
      recent: this.lastInterval,
      windowStartedAt: this.windowStartedAt.toISOString(),
    };
  }

  /**
   * Closes the interval in progress and starts the next.
   *
   * Called on the system sampler's fixed clock, never by a reader — a reader
   * that rotated would shorten the interval for everyone else, which is the
   * whole problem a shared clock exists to avoid.
   */
  rotateRecent(): void {
    const now = this.now();
    const intervalMs = Math.max(0, now - this.currentStartedAt);
    const counts = copyCounts(this.currentCounts);
    this.lastInterval = {
      intervalMs,
      requestsPerSecond:
        intervalMs > 0 ? Math.round((counts.total / intervalMs) * 1000 * 100) / 100 : 0,
      counts,
      latency: summarize(this.current),
    };
    this.current.reset();
    Object.assign(this.currentCounts, emptyCounts());
    this.currentStartedAt = now;
  }

  /**
   * Starts a fresh measurement window.
   *
   * Percentiles cannot be subtracted, so a load test that wants "p99 during
   * phase two" has to zero the distribution between phases — that, and not
   * debugging convenience, is why this exists. Counters are reset with it so
   * every number in a snapshot describes the same window.
   *
   * `inFlight` is deliberately *not* zeroed: requests in flight right now are
   * still in flight after a reset, and clearing it would make the next
   * `recordResponse` underflow toward a permanently wrong count. `peakInFlight`
   * restarts from the current depth, which is its true high-water mark for the
   * new window.
   */
  reset(): void {
    this.overall.reset();
    Object.assign(this.overallCounts, emptyCounts());
    this.routes.clear();
    this.peakInFlight = this.inFlightCount;
    // The recent interval goes too. Otherwise the first scrape after a reset
    // would report pre-reset traffic as "now", in a window that claims to have
    // just begun.
    this.current.reset();
    Object.assign(this.currentCounts, emptyCounts());
    this.lastInterval = null;
    this.currentStartedAt = this.now();
    this.windowStartedAt = new Date(this.currentStartedAt);
  }
}
