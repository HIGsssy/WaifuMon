/**
 * Recent history for the System Metrics trend charts — in browser memory only.
 *
 * There is deliberately no metrics database, no Prometheus and no server-side
 * retention. Each poll's report is reduced to the handful of numbers the charts
 * draw, appended here, and trimmed to a fixed window. Reloading the page starts
 * over; that is the accepted cost of not running another service.
 *
 * ## Which numbers are trended
 *
 * Only *interval* readings — the server's `recent` blocks, CPU rates, and
 * point-in-time gauges like in-flight and pool state. The cumulative latency and
 * loop-delay percentiles are not trended: they describe everything since the
 * process started, so on a long-running server they are near-flat lines that
 * would say "nothing is happening" during a spike.
 *
 * ## Time
 *
 * Samples are positioned by the server's `collectedAt`, and the window is
 * trimmed relative to the newest sample rather than to the browser's clock. A
 * laptop whose clock is a minute off still draws a correct chart, and a gap in
 * the data (the server was unreachable) shows as a gap rather than being
 * compressed away.
 */
import type { SystemMetricsReport } from '@/api/adminSystemMetrics';

/** How much history the charts show. */
export const HISTORY_WINDOW_MS = 10 * 60_000;

export interface MetricsSample {
  /** Server `collectedAt`, epoch ms. */
  t: number;
  /** Server process id — a change means the server restarted mid-history. */
  pid: number;
  eventLoopUtilization: number | null;
  eventLoopP99Ms: number | null;
  processCpuPercent: number | null;
  hostCpuPercent: number | null;
  rssBytes: number;
  hostMemoryUsedPercent: number | null;
  inFlight: number;
  requestsPerSecond: number | null;
  httpP99Ms: number | null;
  serverErrors: number | null;
  dbBusy: number | null;
  dbWaiting: number | null;
  rendererActive: number | null;
  rendererQueued: number | null;
  cpuPressure: number | null;
  ioPressure: number | null;
}

export type NumericSampleKey = {
  [K in keyof MetricsSample]: MetricsSample[K] extends number | null ? K : never;
}[keyof MetricsSample];

export function toSample(report: SystemMetricsReport): MetricsSample {
  const recentHttp = report.http.recent;
  const recentLoop = report.eventLoop.recent;
  const pool = report.database.pool;
  const workers = report.cards.workers;
  const host = report.system.host;
  return {
    t: Date.parse(report.collectedAt),
    pid: report.process.pid,
    eventLoopUtilization: recentLoop?.utilization ?? null,
    eventLoopP99Ms: recentLoop?.delay?.p99Ms ?? null,
    processCpuPercent: report.system.process.percentOfAvailable,
    hostCpuPercent: host?.cpu?.busyPercent ?? null,
    rssBytes: report.process.memory.rssBytes,
    hostMemoryUsedPercent: host?.memory?.usedPercent ?? null,
    inFlight: report.http.inFlight,
    requestsPerSecond: recentHttp?.requestsPerSecond ?? null,
    httpP99Ms: recentHttp?.latency.p99Ms ?? null,
    serverErrors: recentHttp?.counts.serverErrors ?? null,
    dbBusy: pool === null ? null : pool.totalCount - pool.idleCount,
    dbWaiting: pool?.waitingCount ?? null,
    rendererActive: workers?.active ?? (report.cards.poolSize === null ? null : 0),
    rendererQueued: workers?.queued ?? (report.cards.poolSize === null ? null : 0),
    cpuPressure: host?.pressure.cpu?.someAvg10 ?? null,
    ioPressure: host?.pressure.io?.someAvg10 ?? null,
  };
}

/**
 * Appends a sample and trims to the window.
 *
 * Returns the *same array* when nothing changed, so a React state update with
 * it is a no-op. That happens routinely: the query re-delivers the same report
 * on a re-render, and the same `collectedAt` must not become two points.
 *
 * A sample older than the newest one restarts the history. The server's clock
 * went backwards, which makes the existing x-axis meaningless.
 */
export function appendSample(
  history: readonly MetricsSample[],
  sample: MetricsSample,
  windowMs: number = HISTORY_WINDOW_MS,
): readonly MetricsSample[] {
  if (!Number.isFinite(sample.t)) return history;
  const last = history[history.length - 1];
  if (last !== undefined && sample.t === last.t) return history;
  if (last !== undefined && sample.t < last.t) return [sample];

  const cutoff = sample.t - windowMs;
  const kept = history.filter((s) => s.t >= cutoff);
  kept.push(sample);
  return kept;
}

export interface SeriesPoint {
  t: number;
  v: number | null;
}

export function series(history: readonly MetricsSample[], key: NumericSampleKey): SeriesPoint[] {
  return history.map((s) => ({ t: s.t, v: s[key] }));
}

/** The largest non-null value in a series, or null when there is none. */
export function seriesMax(points: readonly SeriesPoint[]): number | null {
  let max: number | null = null;
  for (const p of points) if (p.v !== null && (max === null || p.v > max)) max = p.v;
  return max;
}

/** Whether the server restarted during the retained history. */
export function restartedWithin(history: readonly MetricsSample[]): boolean {
  return history.some((s, i) => i > 0 && s.pid !== history[i - 1]!.pid);
}
