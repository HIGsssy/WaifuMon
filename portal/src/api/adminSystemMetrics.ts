/**
 * Portal admin API client for System Metrics.
 *
 * Maps 1:1 to `GET /api/v1/admin/system/metrics` (`src/api/routes/v1/admin/
 * systemMetrics.ts`), gated on the owner-only `system.metrics.read`. The
 * Portal is a separate package and cannot import the server's types, so the
 * wire shape is restated here field for field with `metricsResponseSchema`.
 *
 * ## Authentication
 *
 * Nothing special: the shared Axios client sends the session cookie, exactly as
 * for every other admin page. The Platform API bearer token is never involved —
 * the server answers this route from its in-process collectors rather than by
 * proxying the bearer-only `/metrics`, so there is no token to leak.
 *
 * There is intentionally no reset call here. The server offers none to the
 * Portal: a dashboard must not be able to zero a load test's measurement window.
 */
import { getData } from './client';

export interface LatencySummary {
  count: number;
  minMs: number | null;
  meanMs: number | null;
  maxMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface RequestCounts {
  total: number;
  byStatusClass: Record<string, number>;
  /** 4xx + 5xx. */
  errors: number;
  /** 5xx only. */
  serverErrors: number;
}

export interface RouteMetrics {
  route: string;
  method: string;
  counts: RequestCounts;
  latency: LatencySummary;
}

export interface PressureReading {
  someAvg10: number;
  someAvg60: number;
  fullAvg10: number | null;
  fullAvg60: number | null;
}

export interface EventLoopDelay {
  minMs: number;
  meanMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  stddevMs: number;
  samples: number;
}

/**
 * The last completed sampling interval (~5 s). The live reading: the top-level
 * latency/delay/utilization fields accumulate since process start or the last
 * server-side reset, and barely move during a spike on a long-running process.
 */
export interface RecentHttp {
  intervalMs: number;
  requestsPerSecond: number;
  counts: RequestCounts;
  latency: LatencySummary;
}

export interface RecentEventLoop {
  intervalMs: number;
  /** 0–1. */
  utilization: number;
  delay: EventLoopDelay | null;
}

export interface SystemMetricsReport {
  collectedAt: string;
  process: {
    pid: number;
    nodeVersion: string;
    uptimeSeconds: number;
    memory: {
      rssBytes: number;
      heapUsedBytes: number;
      heapTotalBytes: number;
      externalBytes: number;
      arrayBuffersBytes: number;
      heapScope: 'main-thread';
    };
    /** Cumulative since process start — not a load figure. See `system.process`. */
    cpu: {
      userMs: number;
      systemMs: number;
      majorPageFaults: number;
      fsReads: number;
      fsWrites: number;
    };
  };
  eventLoop: {
    enabled: boolean;
    resolutionMs: number;
    /** Cumulative since start or reset. */
    delay: EventLoopDelay | null;
    /** 0–1, cumulative since start or reset. */
    utilization: number | null;
    recent: RecentEventLoop | null;
  };
  system: {
    sampledAt: string | null;
    intervalMs: number | null;
    platform: string;
    containerized: boolean;
    hostViewVirtualized: boolean;
    process: {
      percentOfOneCore: number | null;
      percentOfAvailable: number | null;
      availableCores: number;
    };
    host: {
      cores: number;
      cpu: { busyPercent: number; iowaitPercent: number; stealPercent: number } | null;
      loadAverage: { one: number; five: number; fifteen: number } | null;
      loadPerCore: number | null;
      memory: {
        totalBytes: number;
        availableBytes: number;
        usedBytes: number;
        usedPercent: number;
        swapTotalBytes: number;
        swapUsedBytes: number;
      } | null;
      pressure: {
        cpu: PressureReading | null;
        memory: PressureReading | null;
        io: PressureReading | null;
      };
    } | null;
    cgroup: {
      path: string;
      memoryCurrentBytes: number | null;
      memoryLimitBytes: number | null;
      memoryPercentOfLimit: number | null;
      cpuLimitCores: number | null;
      oomKills: number | null;
    } | null;
  };
  http: {
    inFlight: number;
    peakInFlight: number;
    counts: RequestCounts;
    latency: LatencySummary;
    routes: RouteMetrics[];
    recent: RecentHttp | null;
    windowStartedAt: string;
  };
  database: {
    pool: {
      totalCount: number;
      idleCount: number;
      waitingCount: number;
      max: number | null;
    } | null;
  };
  cards: {
    active: boolean;
    masterRenders: number | null;
    derivativeRenders: number | null;
    cacheHits: number | null;
    dedupedRenders: number | null;
    poolSize: number | null;
    workers: {
      size: number;
      active: number;
      workers: number;
      spawned: number;
      replaced: number;
      queued: number;
      peakQueued: number;
      peakConcurrent: number;
      dispatched: number;
    } | null;
  };
}

export function getAdminSystemMetrics(signal?: AbortSignal): Promise<SystemMetricsReport> {
  return getData<SystemMetricsReport>('/v1/admin/system/metrics', signal ? { signal } : {});
}
