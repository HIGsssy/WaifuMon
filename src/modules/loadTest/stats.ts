/**
 * Client-side accounting for one run: what was attempted, what came back, how
 * long it took, and why anything failed.
 *
 * Latency is the **client-observed** figure — request issued to body fully
 * read — which includes loopback transport and Fastify's own queueing. The
 * server's `/metrics` HTTP latency excludes both; comparing the two is how
 * application time is separated from everything around it.
 *
 * Percentiles come from the same native HDR histogram and the same
 * `summarize` the server's `LatencyRecorder` uses, so a p99 here and a p99 on
 * the System Metrics page are computed the same way.
 */
import { createHistogram, type RecordableHistogram } from 'node:perf_hooks';
import { summarize } from '../../shared/metrics/latencyRecorder';
import type { EndpointStats, FailureCounts, LatencyStats } from './types';

export type Outcome =
  | { kind: 'ok'; notModified?: boolean }
  | { kind: 'http'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network'; message: string };

interface Bucket {
  attempted: number;
  completed: number;
  failed: number;
  histogram: RecordableHistogram;
}

const MAX_SAMPLE_ERRORS = 20;

function newHistogram(): RecordableHistogram {
  return createHistogram({ lowest: 1, highest: 120_000_000, figures: 3 });
}

function record(histogram: RecordableHistogram, ms: number): void {
  // Microseconds, clamped into the histogram's range — a sub-microsecond
  // loopback answer and a two-minute stall are both still counted.
  const us = Math.min(120_000_000, Math.max(1, Math.round(ms * 1000)));
  histogram.record(us);
}

export function emptyFailures(): FailureCounts {
  return { total: 0, http4xx: 0, http5xx: 0, timeout: 0, network: 0 };
}

export class RunStats {
  attempted = 0;
  completed = 0;
  canceled = 0;
  actions = 0;
  notModified = 0;
  coldRequested = 0;
  coldExhausted = 0;
  readonly failures: FailureCounts = emptyFailures();
  private readonly overall = newHistogram();
  private recent = newHistogram();
  private recentCompleted = 0;
  private readonly endpoints = new Map<string, Bucket>();
  private readonly sampleErrors = new Set<string>();

  begin(endpoint: string): void {
    this.attempted += 1;
    this.bucket(endpoint).attempted += 1;
  }

  finish(endpoint: string, outcome: Outcome, latencyMs: number): void {
    const bucket = this.bucket(endpoint);
    if (outcome.kind === 'ok') {
      this.completed += 1;
      this.recentCompleted += 1;
      bucket.completed += 1;
      if (outcome.notModified) this.notModified += 1;
      record(this.overall, latencyMs);
      record(this.recent, latencyMs);
      record(bucket.histogram, latencyMs);
      return;
    }
    bucket.failed += 1;
    this.failures.total += 1;
    let description: string;
    switch (outcome.kind) {
      case 'http':
        if (outcome.status >= 500) this.failures.http5xx += 1;
        else this.failures.http4xx += 1;
        description = `${endpoint} → HTTP ${outcome.status}`;
        break;
      case 'timeout':
        this.failures.timeout += 1;
        description = `${endpoint} → timeout`;
        break;
      case 'network':
        this.failures.network += 1;
        description = `${endpoint} → ${outcome.message}`;
        break;
    }
    if (this.sampleErrors.size < MAX_SAMPLE_ERRORS) this.sampleErrors.add(description);
  }

  /** A request cut off by a stop: not the server's failure, and not a success. */
  cancel(): void {
    this.canceled += 1;
  }

  latency(): LatencyStats {
    return summarize(this.overall);
  }

  /** Closes the recent interval and returns it. */
  rotateRecent(intervalMs: number): { intervalMs: number; opsPerSecond: number; latency: LatencyStats } {
    const latency = summarize(this.recent);
    const opsPerSecond = intervalMs > 0 ? (this.recentCompleted * 1000) / intervalMs : 0;
    this.recent = newHistogram();
    this.recentCompleted = 0;
    return { intervalMs, opsPerSecond: round2(opsPerSecond), latency };
  }

  endpointStats(): EndpointStats[] {
    return [...this.endpoints.entries()]
      .map(([endpoint, b]) => ({
        endpoint,
        attempted: b.attempted,
        completed: b.completed,
        failed: b.failed,
        latency: summarize(b.histogram),
      }))
      .sort((a, b) => b.attempted - a.attempted);
  }

  errors(): string[] {
    return [...this.sampleErrors];
  }

  private bucket(endpoint: string): Bucket {
    let b = this.endpoints.get(endpoint);
    if (!b) {
      b = { attempted: 0, completed: 0, failed: 0, histogram: newHistogram() };
      this.endpoints.set(endpoint, b);
    }
    return b;
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Completed operations per second over the timed phase so far. */
export function opsPerSecond(completed: number, elapsedMs: number): number {
  return elapsedMs > 0 ? round2((completed * 1000) / elapsedMs) : 0;
}
