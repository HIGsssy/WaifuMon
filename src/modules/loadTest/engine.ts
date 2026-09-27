/**
 * The load engine: N virtual players, each a loop of act → think, over HTTP.
 *
 * Deliberately free of process concerns — no IPC, no `process.exit` — so the
 * whole behaviour (think time, stop, failure accounting, cold-plan handout)
 * is testable in-process against a fake `fetch`. `runner.ts` wraps it for the
 * child process the controller actually spawns.
 */
import {
  chooseAction,
  personaFor,
  playerRng,
  primeRequests,
  rampMs,
  thinkTimeMs,
  type ActionContext,
  type RequestSpec,
} from './profiles';
import { opsPerSecond, RunStats, type Outcome } from './stats';
import type {
  ColdCardTarget,
  RunnerPlan,
  RunnerSnapshot,
  RunnerSummary,
  VirtualPlayerFixture,
} from './types';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface EngineDeps {
  fetch?: FetchLike;
  now?: () => number;
  /** CPU used by the generator itself; `process.cpuUsage` in the child. */
  cpuUsage?: () => { user: number; system: number };
  /** Think-time and ramp waits. Injected by tests to compress time. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Resolves after `ms`, or immediately once `signal` aborts. Never rejects. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Prime requests in flight at once, across all players. Gentle on purpose. */
const PRIME_CONCURRENCY = 4;

export class LoadEngine {
  readonly stats = new RunStats();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly cpuUsage: (() => { user: number; system: number }) | undefined;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly stopController = new AbortController();
  private coldQueue: ColdCardTarget[] = [];
  private coldPlanned = 0;
  private startedAt: number | null = null;
  private active = 0;
  private phase: RunnerSnapshot['phase'] = 'priming';
  private primeProgress = { done: 0, total: 0 };
  private primeFailures = 0;
  private lastRotate: number;
  private lastCpu: { user: number; system: number; at: number } | null = null;
  private lastCpuPercent: number | null = null;
  /** Last ETag per player+path, for revalidating card requests. */
  private readonly etags = new Map<string, string>();

  constructor(
    private readonly plan: RunnerPlan,
    deps: EngineDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? (() => Date.now());
    this.cpuUsage = deps.cpuUsage;
    this.wait = deps.sleep ?? sleep;
    this.lastRotate = this.now();
  }

  get stopped(): boolean {
    return this.stopController.signal.aborted;
  }

  stop(): void {
    this.stopController.abort();
  }

  /**
   * Touch every read each player will make, once, before the clock starts.
   * Not counted in the run's statistics. Throws when the server refuses the
   * sessions outright — a misconfiguration no timed phase could survive.
   */
  async prime(onProgress?: (done: number, total: number) => void): Promise<void> {
    const work: Array<{ player: VirtualPlayerFixture; spec: RequestSpec }> = [];
    for (const player of this.plan.players) {
      for (const spec of primeRequests(player, this.plan.cardsAvailable)) work.push({ player, spec });
    }
    this.primeProgress = { done: 0, total: work.length };
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!this.stopped && next < work.length) {
        const item = work[next++]!;
        const outcome = (await this.request(item.player, item.spec)).outcome;
        if (outcome.kind !== 'ok') this.primeFailures += 1;
        this.primeProgress.done += 1;
        onProgress?.(this.primeProgress.done, this.primeProgress.total);
      }
    };
    await Promise.all(Array.from({ length: PRIME_CONCURRENCY }, worker));
    if (!this.stopped && work.length > 0 && this.primeFailures > work.length / 2) {
      throw new Error(
        `priming failed: ${this.primeFailures} of ${work.length} requests were refused or errored`,
      );
    }
  }

  /** The timed phase. Resolves when every player has finished or been stopped. */
  async run(coldCards: ColdCardTarget[]): Promise<RunnerSummary> {
    this.coldQueue = [...coldCards];
    this.coldPlanned = coldCards.length;
    this.phase = 'running';
    this.startedAt = this.now();
    this.lastRotate = this.startedAt;
    const endAt = this.startedAt + this.plan.durationMs;
    const ramp = rampMs(this.plan.durationMs);

    await Promise.all(
      this.plan.players.map((player, index) =>
        this.playerLoop(player, index, endAt, (ramp * index) / Math.max(1, this.plan.players.length)),
      ),
    );
    this.phase = 'finished';
    return this.summary();
  }

  snapshot(): RunnerSnapshot {
    const now = this.now();
    const elapsedMs = this.startedAt === null ? 0 : Math.min(now - this.startedAt, this.plan.durationMs);
    const recent = this.startedAt === null ? null : this.stats.rotateRecent(now - this.lastRotate);
    this.lastRotate = now;
    return {
      phase: this.phase,
      elapsedMs,
      activePlayers: this.active,
      attempted: this.stats.attempted,
      completed: this.stats.completed,
      failures: { ...this.stats.failures },
      canceled: this.stats.canceled,
      actions: this.stats.actions,
      opsPerSecond: opsPerSecond(this.stats.completed, elapsedMs),
      latency: this.stats.latency(),
      recent,
      cards: {
        coldRequested: this.stats.coldRequested,
        coldPlanned: this.coldPlanned,
        coldExhausted: this.stats.coldExhausted,
        notModified: this.stats.notModified,
      },
      generatorCpuPercentOfOneCore: this.sampleCpu(now),
      ...(this.phase === 'priming' ? { primeProgress: { ...this.primeProgress } } : {}),
    };
  }

  summary(): RunnerSummary {
    return {
      ...this.snapshot(),
      endpoints: this.stats.endpointStats(),
      sampleErrors: this.stats.errors(),
    };
  }

  // ───────────────────────────────────────────────────────────── internals

  private async playerLoop(
    player: VirtualPlayerFixture,
    index: number,
    endAt: number,
    startDelayMs: number,
  ): Promise<void> {
    const signal = this.stopController.signal;
    await this.wait(startDelayMs, signal);
    if (this.stopped || this.now() >= endAt) return;

    const rng = playerRng(this.plan.seed, index);
    const persona = personaFor(this.plan.profile, this.plan.cardMode, index, this.plan.cardsAvailable);
    const ctx: ActionContext = {
      player,
      rng,
      cardsAvailable: this.plan.cardsAvailable,
      cardMode: this.plan.cardMode,
      takeCold: () => this.coldQueue.shift() ?? null,
      noteColdExhausted: () => {
        this.stats.coldExhausted += 1;
      },
    };

    this.active += 1;
    try {
      while (!this.stopped && this.now() < endAt) {
        const action = chooseAction(persona.actions, rng);
        for (const step of action.build(ctx)) {
          if (this.stopped) break;
          await Promise.all(step.map((spec) => this.timed(player, spec)));
        }
        if (this.stopped) break;
        this.stats.actions += 1;
        const remaining = endAt - this.now();
        if (remaining <= 0) break;
        await this.wait(Math.min(thinkTimeMs(persona.think, rng), remaining), signal);
      }
    } finally {
      this.active -= 1;
    }
  }

  private async timed(player: VirtualPlayerFixture, spec: RequestSpec): Promise<void> {
    this.stats.begin(spec.endpoint);
    if (spec.cold) this.stats.coldRequested += 1;
    const { outcome, latencyMs, canceled } = await this.request(player, spec);
    if (canceled) this.stats.cancel();
    else this.stats.finish(spec.endpoint, outcome, latencyMs);
  }

  private async request(
    player: VirtualPlayerFixture,
    spec: RequestSpec,
  ): Promise<{ outcome: Outcome; latencyMs: number; canceled: boolean }> {
    const headers: Record<string, string> = {
      cookie: `${this.plan.sessionCookieName}=${player.sessionToken}`,
      accept: spec.card ? 'image/webp,*/*' : 'application/json',
      'user-agent': `waifumon-loadtest/${this.plan.runKey}`,
    };
    const etagKey = `${player.playerId}:${spec.path}`;
    if (spec.revalidate) {
      const etag = this.etags.get(etagKey);
      if (etag) headers['if-none-match'] = etag;
    }

    const timeout = AbortSignal.timeout(this.plan.requestTimeoutMs);
    const signal = AbortSignal.any([timeout, this.stopController.signal]);
    const started = performance.now();
    try {
      const res = await this.fetchImpl(`${this.plan.baseUrl}${spec.path}`, {
        method: 'GET',
        headers,
        signal,
      });
      // Read the whole body: a client has not "got" a card until it has the
      // bytes, and an unread body would hold the connection.
      await res.arrayBuffer();
      const latencyMs = performance.now() - started;
      if (res.status === 304 && spec.card) {
        return { outcome: { kind: 'ok', notModified: true }, latencyMs, canceled: false };
      }
      if ((res.status >= 200 && res.status < 300) || spec.expectedStatuses?.includes(res.status)) {
        const etag = res.headers.get('etag');
        if (spec.card && etag) this.etags.set(etagKey, etag);
        return { outcome: { kind: 'ok' }, latencyMs, canceled: false };
      }
      return { outcome: { kind: 'http', status: res.status }, latencyMs, canceled: false };
    } catch (err) {
      const latencyMs = performance.now() - started;
      if (this.stopped && !timeout.aborted) {
        return { outcome: { kind: 'timeout' }, latencyMs, canceled: true };
      }
      if (timeout.aborted) return { outcome: { kind: 'timeout' }, latencyMs, canceled: false };
      const message = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      return { outcome: { kind: 'network', message }, latencyMs, canceled: false };
    }
  }

  private sampleCpu(now: number): number | null {
    if (!this.cpuUsage) return null;
    const usage = this.cpuUsage();
    const prev = this.lastCpu;
    this.lastCpu = { ...usage, at: now };
    if (prev === null || now <= prev.at) return this.lastCpuPercent;
    const usedUs = usage.user - prev.user + (usage.system - prev.system);
    this.lastCpuPercent = Math.round((usedUs / 1000 / (now - prev.at)) * 1000) / 10;
    return this.lastCpuPercent;
  }
}
