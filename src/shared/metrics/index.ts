/**
 * Runtime instrumentation, kept in `shared/` because it describes the *process*
 * rather than the game.
 *
 * Nothing in here imports Fastify, the database, discord.js or the card
 * renderer. The API layer wires these collectors to an HTTP surface
 * (`api/routes/metrics.ts`) and the host process supplies the pool and renderer
 * readings it alone can see — the same separation `routes/health.ts` already
 * uses for its readiness probes, and for the same reason: it keeps the
 * collectors testable without standing up a server.
 */
export {
  DEFAULT_EVENT_LOOP_RESOLUTION_MS,
  EventLoopMonitor,
  type EventLoopDelay,
  type EventLoopMetrics,
} from './eventLoopMetrics';
export {
  LatencyRecorder,
  UNROUTED_KEY,
  summarize,
  type HttpMetrics,
  type LatencySummary,
  type RequestCounts,
  type RouteMetrics,
} from './latencyRecorder';
export {
  readProcessMetrics,
  type CpuMetrics,
  type MemoryMetrics,
  type ProcessMetrics,
} from './processMetrics';
