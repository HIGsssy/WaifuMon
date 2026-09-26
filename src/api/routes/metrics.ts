/**
 * Runtime metrics for capacity measurement (`GET /metrics`).
 *
 * Sits beside `/health` and `/ready`, outside `/api/v1`, for the reason those
 * two do: ops tooling needs a target that survives a version bump. Like them it
 * answers at the top level rather than inside the `{ data }` envelope — it
 * describes the process, not a game resource.
 *
 * ## Why this is not Prometheus
 *
 * No exposition format, no scrape agent, no time-series database. This process
 * deliberately has no Redis and no queue broker, and adding a metrics stack to
 * answer one sizing question would be a permanent dependency bought for a
 * temporary need. JSON over the existing authenticated HTTP surface is read the
 * same way by `curl`, by `jq` in a shell loop, and by the load harness that will
 * consume it later — and it costs nothing when nobody calls it.
 *
 * The tradeoff is real and worth naming: nothing here is retained. A scrape
 * reports the window since the last reset, so history lives in whatever the
 * caller writes it to. For a bounded capacity test that is the right shape; a
 * standing production dashboard would want the other design.
 *
 * ## Authentication: bearer only
 *
 * `/metrics` is deliberately **absent** from `isPublicPath`, so the global auth
 * hook already demands a credential. That hook accepts either the shared bearer
 * token *or* a Portal session cookie, and a Portal session is a *player's*
 * browser login — RSS, query latency and pool saturation are operator data, and
 * no logged-in player should be able to read them by visiting a URL. So this
 * route additionally requires `apiAuth === 'bearer'` and answers 403 to a
 * session that the global hook was happy with.
 *
 * That check is the security boundary. The nginx rule in
 * `portal/nginx.conf.template` is the second layer: it refuses `/metrics`
 * outright so the endpoint is not reachable through the public Portal host even
 * if a future proxy rule were widened.
 */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MetricsBearerRequiredError } from '../errors';
import type { ZodFastify } from '../plugins/typeProvider';
import {
  readProcessMetrics,
  type EventLoopMetrics,
  type EventLoopMonitor,
  type HttpMetrics,
  type LatencyRecorder,
} from '../../shared/metrics';

/**
 * Postgres pool state, as `pg.Pool` exposes it.
 *
 * Supplied by the host process as a closure rather than read here, so this
 * module imports neither `pg` nor `db/client` — the same arrangement
 * `ReadinessProbes` uses, and what keeps the API layer free of the database.
 */
export interface DatabasePoolMetrics {
  /** Connections the pool currently holds, busy and idle together. */
  totalCount: number;
  /** Held open and unused — the pool's spare capacity right now. */
  idleCount: number;
  /**
   * Queries blocked waiting for a connection.
   *
   * The number that answers whether the pool is the bottleneck. Sustained
   * non-zero means requests are serializing on connections rather than on
   * Postgres, and it is the reading that would justify raising `max` — which is
   * why it is reported next to the configured ceiling.
   */
  waitingCount: number;
  /** Configured ceiling (`max`), so `totalCount` can be read as a fraction of it. */
  max: number | null;
}

/** Card renderer counters, shaped by `CardRendererStats`. */
export interface CardMetrics {
  /**
   * False when no renderer has been constructed in this process — no card has
   * been drawn or served. Every other field is null in that case, which is
   * itself the useful signal rather than a gap.
   */
  active: boolean;
  masterRenders: number | null;
  derivativeRenders: number | null;
  cacheHits: number | null;
  dedupedRenders: number | null;
  workers: {
    /** Threads alive now. */
    workers: number;
    /** Started over the pool's life, replacements included. */
    spawned: number;
    /** Replaced after an unexpected exit — a crash count. */
    replaced: number;
    /** Jobs waiting for a free thread right now. */
    queued: number;
    /** High-water mark of `queued` — how deep a burst actually got. */
    peakQueued: number;
    /** High-water mark of simultaneous renders. Must never exceed the pool size. */
    peakConcurrent: number;
    dispatched: number;
  } | null;
}

/**
 * What `/metrics` needs from the host process.
 *
 * Same contract style as {@link import('./health').ReadinessProbes}: the two
 * collectors are owned objects, and anything the API layer must not import is a
 * closure the host supplies.
 */
export interface MetricsSources {
  eventLoop: EventLoopMonitor;
  http: LatencyRecorder;
  /** Null when the process has no pool — it never does in practice, but tests do. */
  describeDatabasePool: () => DatabasePoolMetrics | null;
  /** Null when no card renderer has been built. */
  describeCardRenderer: () => CardMetrics;
}

// ----------------------------------------------------------------- schemas

const latencySummarySchema = z.object({
  count: z.number().int(),
  minMs: z.number().nullable(),
  meanMs: z.number().nullable(),
  maxMs: z.number().nullable(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  p99Ms: z.number().nullable(),
});

const requestCountsSchema = z.object({
  total: z.number().int(),
  byStatusClass: z.record(z.string(), z.number().int()),
  errors: z.number().int().describe('4xx + 5xx.'),
  serverErrors: z.number().int().describe('5xx only.'),
});

const httpSchema = z.object({
  inFlight: z.number().int(),
  peakInFlight: z.number().int(),
  counts: requestCountsSchema,
  latency: latencySummarySchema,
  routes: z.array(
    z.object({
      route: z.string(),
      method: z.string(),
      counts: requestCountsSchema,
      latency: latencySummarySchema,
    }),
  ),
  windowStartedAt: z.string(),
});

const eventLoopSchema = z.object({
  enabled: z.boolean(),
  resolutionMs: z.number().describe('Sampling floor; reported delay never drops below it.'),
  delay: z
    .object({
      minMs: z.number(),
      meanMs: z.number(),
      maxMs: z.number(),
      p50Ms: z.number(),
      p95Ms: z.number(),
      p99Ms: z.number(),
      stddevMs: z.number(),
      samples: z.number().int(),
    })
    .nullable(),
  utilization: z.number().nullable().describe('Fraction of wall time the loop was busy, 0–1.'),
});

const metricsResponseSchema = z.object({
  collectedAt: z.string(),
  process: z.object({
    pid: z.number().int(),
    nodeVersion: z.string(),
    uptimeSeconds: z.number(),
    memory: z.object({
      rssBytes: z.number().int(),
      heapUsedBytes: z.number().int(),
      heapTotalBytes: z.number().int(),
      externalBytes: z.number().int(),
      arrayBuffersBytes: z.number().int(),
      heapScope: z.literal('main-thread'),
    }),
    cpu: z.object({
      userMs: z.number().int(),
      systemMs: z.number().int(),
      majorPageFaults: z.number().int(),
      fsReads: z.number().int(),
      fsWrites: z.number().int(),
    }),
  }),
  eventLoop: eventLoopSchema,
  http: httpSchema,
  database: z.object({ pool: z.object({
    totalCount: z.number().int(),
    idleCount: z.number().int(),
    waitingCount: z.number().int(),
    max: z.number().int().nullable(),
  }).nullable() }),
  cards: z.object({
    active: z.boolean(),
    masterRenders: z.number().int().nullable(),
    derivativeRenders: z.number().int().nullable(),
    cacheHits: z.number().int().nullable(),
    dedupedRenders: z.number().int().nullable(),
    workers: z
      .object({
        workers: z.number().int(),
        spawned: z.number().int(),
        replaced: z.number().int(),
        queued: z.number().int(),
        peakQueued: z.number().int(),
        peakConcurrent: z.number().int(),
        dispatched: z.number().int(),
      })
      .nullable(),
  }),
});

export type MetricsResponse = z.infer<typeof metricsResponseSchema>;

const resetResponseSchema = z.object({
  reset: z.literal(true),
  windowStartedAt: z.string(),
});

// ------------------------------------------------------------------ route

export function buildMetricsReport(
  sources: MetricsSources,
  now: Date = new Date(),
): MetricsResponse {
  const eventLoop: EventLoopMetrics = sources.eventLoop.read();
  const http: HttpMetrics = sources.http.snapshot();

  return {
    collectedAt: now.toISOString(),
    process: readProcessMetrics(),
    eventLoop,
    http,
    database: { pool: sources.describeDatabasePool() },
    cards: sources.describeCardRenderer(),
  };
}

/**
 * Rejects a credential the global auth hook accepted but these routes must not.
 *
 * A route-level `onRequest` runs after the instance-level hooks, so
 * `req.apiAuth` is already resolved by the time this sees it. Throwing rather
 * than replying by hand routes the refusal through the central error handler,
 * so it gets the same body shape, status mapping and logging as every other
 * 403 in the API.
 */
async function requireBearer(req: FastifyRequest): Promise<void> {
  if (req.apiAuth === 'bearer') return;
  req.log.warn(
    { path: req.url.split('?')[0] ?? '', auth: req.apiAuth ?? 'none' },
    'metrics request rejected: bearer token required',
  );
  throw new MetricsBearerRequiredError();
}

export function registerMetricsRoutes(app: ZodFastify, sources: MetricsSources): void {
  app.get(
    '/metrics',
    {
      onRequest: requireBearer,
      schema: {
        tags: ['System'],
        summary: 'Runtime metrics',
        description:
          'Process, event-loop, HTTP-latency, database-pool and card-renderer metrics for the ' +
          'current measurement window.\n\n' +
          'Requires the `PLATFORM_API_TOKEN` bearer token — a Portal session is rejected with ' +
          '403, because these are operator readings rather than player data. Not reachable ' +
          'through the public Portal host.\n\n' +
          'Counters and latency distributions accumulate since process start or since the last ' +
          '`POST /metrics/reset`. Percentiles cannot be differenced between two scrapes, so a ' +
          'test that needs "p99 during this phase" resets first.',
        response: { 200: metricsResponseSchema },
      },
    },
    async () => buildMetricsReport(sources),
  );

  app.post(
    '/metrics/reset',
    {
      onRequest: requireBearer,
      schema: {
        tags: ['System'],
        summary: 'Start a fresh metrics window',
        description:
          'Zeroes the HTTP latency distributions, request counters and event-loop delay ' +
          'histogram, and rebases event-loop utilization.\n\n' +
          'Exists because percentiles are not differenceable: isolating "p99 during the ramp" ' +
          'from "p99 including warm-up" requires zeroing between phases. Affects only ' +
          'instrumentation — no gameplay state, no cache, no database.\n\n' +
          '`inFlight` is not zeroed: requests in flight are still in flight afterwards.',
        response: { 200: resetResponseSchema },
      },
    },
    async () => {
      sources.http.reset();
      sources.eventLoop.reset();
      return { reset: true as const, windowStartedAt: sources.http.snapshot().windowStartedAt };
    },
  );
}
