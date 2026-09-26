/**
 * Event-loop delay and utilization.
 *
 * This is the single most diagnostic number this process can report. The card
 * renderer exists in the shape it does *because* a master render blocks a
 * thread for ~750 ms in synchronous resvg, and the whole point of moving it to
 * a worker was to keep that stall off the loop that serves Discord and Fastify
 * (see `modules/cards/rasterizer/masterRender.ts`). Event-loop delay is the
 * measurement that says whether that separation is actually holding on a given
 * machine — which the repo's own benchmark notes has never been checked on the
 * production node.
 *
 * ## Two complementary signals
 *
 * `monitorEventLoopDelay` answers *how late did a timer fire* — a distribution,
 * in nanoseconds, sampled by libuv itself at a fixed resolution. Percentiles
 * over it are what catch an occasional long stall that a mean would bury.
 *
 * `eventLoopUtilization` answers *what fraction of wall time was the loop
 * actually busy* — closer to a CPU-saturation number, and the one that
 * distinguishes "slow because we are waiting on Postgres" (low utilization,
 * high latency) from "slow because we are compute-bound" (high utilization).
 * Reading both is how a capacity test tells those two apart, so both are here.
 *
 * ## Resolution is a floor, not an error
 *
 * The monitor samples every `resolution` ms, so reported delay never drops
 * below roughly that figure even on a completely idle loop — a 10 ms resolution
 * reports a ~10 ms idle baseline. That is inherent to the mechanism, not a
 * fault, and it is why the repo's existing benchmark quotes an idle baseline
 * alongside its measurements rather than expecting zero. Compare against the
 * baseline, never against nothing.
 */
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';

/**
 * Sampling interval, in milliseconds.
 *
 * 20 ms is chosen to sit well below the delay that would be alarming (a render
 * stall is hundreds of milliseconds) while costing one libuv timer tick fifty
 * times a second, which is negligible against the request rate this process
 * serves. It is also the resolution the reported idle baseline reflects.
 */
export const DEFAULT_EVENT_LOOP_RESOLUTION_MS = 20;

export interface EventLoopDelay {
  minMs: number;
  meanMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  stddevMs: number;
  /** Samples taken. Zero means the monitor was enabled too recently to say anything. */
  samples: number;
}

export interface EventLoopMetrics {
  enabled: boolean;
  /** The sampling floor, so a reader can tell a real baseline from an artefact. */
  resolutionMs: number;
  /** Null until the monitor has taken at least one sample. */
  delay: EventLoopDelay | null;
  /**
   * Fraction of wall time the loop was busy, in [0, 1], measured since the last
   * {@link EventLoopMonitor.reset}. Null when no interval has elapsed yet.
   */
  utilization: number | null;
}

const NS_PER_MS = 1e6;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Owns the process-wide event-loop monitor.
 *
 * A class rather than module-level state so a test can construct, drive and
 * dispose one without touching the singleton the application uses — enabling
 * two `monitorEventLoopDelay` instances concurrently is legal, and keeping the
 * test's own instance separate is what stops a test from resetting the
 * application's measurement window.
 */
export class EventLoopMonitor {
  private readonly resolutionMs: number;
  private histogram: IntervalHistogram | undefined;
  /** Baseline for the next utilization delta. */
  private eluBaseline = performance.eventLoopUtilization();

  constructor(resolutionMs: number = DEFAULT_EVENT_LOOP_RESOLUTION_MS) {
    this.resolutionMs = resolutionMs;
  }

  get enabled(): boolean {
    return this.histogram !== undefined;
  }

  /** Idempotent, so wiring this from more than one place cannot double-enable. */
  start(): void {
    if (this.histogram !== undefined) return;
    const histogram = monitorEventLoopDelay({ resolution: this.resolutionMs });
    histogram.enable();
    this.histogram = histogram;
    this.eluBaseline = performance.eventLoopUtilization();
  }

  /**
   * Disables sampling and drops the histogram.
   *
   * Called on shutdown. The monitor holds a libuv timer, so leaving it enabled
   * in a test process is a handle that outlives the test.
   */
  stop(): void {
    this.histogram?.disable();
    this.histogram = undefined;
  }

  read(): EventLoopMetrics {
    const histogram = this.histogram;
    const elu = performance.eventLoopUtilization(this.eluBaseline);

    if (histogram === undefined) {
      return { enabled: false, resolutionMs: this.resolutionMs, delay: null, utilization: null };
    }

    const samples = Number(histogram.count);
    return {
      enabled: true,
      resolutionMs: this.resolutionMs,
      delay:
        samples === 0
          ? null
          : {
              minMs: round(Number(histogram.min) / NS_PER_MS),
              meanMs: round(histogram.mean / NS_PER_MS),
              maxMs: round(Number(histogram.max) / NS_PER_MS),
              p50Ms: round(Number(histogram.percentile(50)) / NS_PER_MS),
              p95Ms: round(Number(histogram.percentile(95)) / NS_PER_MS),
              p99Ms: round(Number(histogram.percentile(99)) / NS_PER_MS),
              stddevMs: round(histogram.stddev / NS_PER_MS),
              samples,
            },
      // `idle + active` is 0 only when no measurable interval has passed.
      utilization: elu.idle + elu.active === 0 ? null : round(elu.utilization),
    };
  }

  /** Starts a fresh window for both the delay distribution and utilization. */
  reset(): void {
    this.histogram?.reset();
    this.eluBaseline = performance.eventLoopUtilization();
  }
}
