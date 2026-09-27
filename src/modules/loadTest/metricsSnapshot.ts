/**
 * Two readings of System Metrics per run — one as the timed phase starts, one
 * as it ends — kept with the run's result.
 *
 * Not a time series, on purpose: the System Metrics page is where a run is
 * watched, and a history store is the monitoring platform this project has
 * decided not to build. What a comparison between hosts needs from the server
 * side is small: the "recent" (~5 s) readings at the end of the run, when load
 * is at its steadiest, and the counter deltas across it (renders, cache hits,
 * requests), which *are* differenceable between two scrapes.
 */
import os from 'node:os';
import type { MetricsResponse } from '../../api/routes/metrics';

export interface CompactMetrics {
  collectedAt: string;
  eventLoop: {
    utilization: number | null;
    recentUtilization: number | null;
    delayP99Ms: number | null;
    recentDelayP99Ms: number | null;
  };
  process: { cpuPercentOfOneCore: number | null; rssBytes: number };
  host: {
    busyPercent: number | null;
    iowaitPercent: number | null;
    loadPerCore: number | null;
    memoryUsedPercent: number | null;
  };
  cgroup: { memoryCurrentBytes: number | null; oomKills: number | null };
  http: {
    total: number;
    errors: number;
    serverErrors: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    recentRequestsPerSecond: number | null;
    recentP99Ms: number | null;
  };
  pool: { totalCount: number; idleCount: number; waitingCount: number; max: number | null } | null;
  cards: {
    masterRenders: number | null;
    derivativeRenders: number | null;
    cacheHits: number | null;
    peakQueued: number | null;
    replaced: number | null;
  };
}

export function compactMetrics(report: MetricsResponse): CompactMetrics {
  const system = report.system;
  return {
    collectedAt: report.collectedAt,
    eventLoop: {
      utilization: report.eventLoop.utilization,
      recentUtilization: report.eventLoop.recent?.utilization ?? null,
      delayP99Ms: report.eventLoop.delay?.p99Ms ?? null,
      recentDelayP99Ms: report.eventLoop.recent?.delay?.p99Ms ?? null,
    },
    process: {
      cpuPercentOfOneCore: system.process.percentOfOneCore,
      rssBytes: report.process.memory.rssBytes,
    },
    host: {
      busyPercent: system.host?.cpu?.busyPercent ?? null,
      iowaitPercent: system.host?.cpu?.iowaitPercent ?? null,
      loadPerCore: system.host?.loadPerCore ?? null,
      memoryUsedPercent: system.host?.memory?.usedPercent ?? null,
    },
    cgroup: {
      memoryCurrentBytes: system.cgroup?.memoryCurrentBytes ?? null,
      oomKills: system.cgroup?.oomKills ?? null,
    },
    http: {
      total: report.http.counts.total,
      errors: report.http.counts.errors,
      serverErrors: report.http.counts.serverErrors,
      p50Ms: report.http.latency.p50Ms,
      p95Ms: report.http.latency.p95Ms,
      p99Ms: report.http.latency.p99Ms,
      recentRequestsPerSecond: report.http.recent?.requestsPerSecond ?? null,
      recentP99Ms: report.http.recent?.latency.p99Ms ?? null,
    },
    pool: report.database.pool,
    cards: {
      masterRenders: report.cards.masterRenders,
      derivativeRenders: report.cards.derivativeRenders,
      cacheHits: report.cards.cacheHits,
      peakQueued: report.cards.workers?.peakQueued ?? null,
      replaced: report.cards.workers?.replaced ?? null,
    },
  };
}

/**
 * `read` is the host's closure over `buildMetricsReport` — handed in, like
 * every other metrics consumer's, so this module does not reach into the API
 * layer. Absent when metrics are disabled.
 */
export function snapshotMetrics(read: (() => MetricsResponse) | undefined): CompactMetrics | null {
  if (!read) return null;
  try {
    return compactMetrics(read());
  } catch {
    return null;
  }
}

/** Counter deltas across the run: the part of two scrapes that subtracts. */
export function metricsDelta(
  start: CompactMetrics | null,
  end: CompactMetrics | null,
): Record<string, number | null> | null {
  if (!start || !end) return null;
  const diff = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : b - a;
  return {
    httpRequests: diff(start.http.total, end.http.total),
    httpServerErrors: diff(start.http.serverErrors, end.http.serverErrors),
    masterRenders: diff(start.cards.masterRenders, end.cards.masterRenders),
    derivativeRenders: diff(start.cards.derivativeRenders, end.cards.derivativeRenders),
    cacheHits: diff(start.cards.cacheHits, end.cards.cacheHits),
    workerReplacements: diff(start.cards.replaced, end.cards.replaced),
    oomKills: diff(start.cgroup.oomKills, end.cgroup.oomKills),
  };
}

export interface HostInfo {
  hostname: string;
  platform: string;
  cpuModel: string | null;
  logicalCpus: number;
  totalMemoryBytes: number;
  nodeVersion: string;
  cardRenderWorkers: number | null;
  databasePoolMax: number | null;
}

/** The machine as this process sees it — inside Docker, the container's view. */
export function describeHost(extra: {
  cardRenderWorkers: number | null;
  databasePoolMax: number | null;
}): HostInfo {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpuModel: cpus[0]?.model.trim() ?? null,
    logicalCpus: cpus.length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
    ...extra,
  };
}
