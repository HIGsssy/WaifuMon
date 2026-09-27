/**
 * The load-test controller: the part that lives in the Waifumon process.
 *
 * It generates no load. It prepares synthetic players, forks the generator
 * (`runner.ts`), relays progress to the Portal, takes a System Metrics reading
 * at each end of the timed phase, cleans up, and records the result. One run
 * at a time.
 *
 * ## A run, in order
 *
 *   preparing  fixture ensured, stale synthetic sessions removed, one fresh
 *              session minted per virtual player
 *   priming    generator touches every read once; the controller then waits
 *              for the card renderer and background warmer to go idle, so the
 *              timed phase starts from steady state
 *   running    cold-card plan computed (if any), metrics reading taken, `go`
 *   → completed | stopped | failed
 *              metrics reading, generator gone, cold renders evicted,
 *              synthetic sessions deleted, row written
 *
 * Cleanup runs on every path out, including failure and stop.
 *
 * ## Bounds
 *
 * Nothing about a run is open-ended. Priming has a deadline, the timed phase
 * has one (duration + request timeout + grace, after which the generator is
 * told to stop, then killed), and the generator enforces its own besides.
 */
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import path from 'node:path';
import type { MetricsResponse } from '../../api/routes/metrics';
import type { Logger } from '../../shared/logger';
import type { PlannedColdCard } from './coldCards';
import { metricsDelta, snapshotMetrics, type CompactMetrics, type HostInfo } from './metricsSnapshot';
import { coldCardsNeeded } from './profiles';
import type { LoadTestRunStore } from './store';
import type { LoadTestRunRow } from '../../db/schema';
import {
  DEFAULT_SEED,
  TERMINAL_STATES,
  type ControllerMessage,
  type LoadTestStartRequest,
  type RunnerMessage,
  type RunnerPlan,
  type RunnerSnapshot,
  type RunnerSummary,
  type RunState,
  type VirtualPlayerFixture,
} from './types';

// ─────────────────────────────────────────────────────────── collaborators

/** The slice of `ChildProcess` the controller uses — small enough to fake. */
export interface GeneratorProcess extends EventEmitter {
  send(message: ControllerMessage, callback?: (err: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  readonly connected: boolean;
}

export type SpawnGenerator = (env: NodeJS.ProcessEnv) => GeneratorProcess;

export interface PreparedPlayers {
  players: VirtualPlayerFixture[];
  /** Species every prepared player has discovered — the cold plan's pool. */
  commonSpeciesSlugs: string[];
}

export interface RunPreparer {
  /** Ensure `count` synthetic players and mint one Portal session for each. */
  prepare(count: number): Promise<PreparedPlayers>;
  /** Delete every synthetic Portal session. */
  release(): Promise<void>;
}

export interface ColdCardService {
  plan(slugs: readonly string[], count: number): Promise<PlannedColdCard[]>;
  evict(planned: readonly PlannedColdCard[]): Promise<number>;
  /** Resolves once no card is rendering or queued, or after `timeoutMs`. */
  waitForIdle(timeoutMs: number): Promise<void>;
}

export interface LoadTestControllerDeps {
  /** `LOAD_TESTING_ENABLED`. The constructor refuses to build without it. */
  enabled: boolean;
  /** Where the generator sends requests: this process's own API, over loopback. */
  baseUrl: string;
  sessionCookieName: string;
  cardsAvailable: boolean;
  hostLabel?: string | undefined;
  hostInfo: () => HostInfo;
  preparer: RunPreparer;
  cold?: ColdCardService | undefined;
  store: LoadTestRunStore;
  readMetrics?: (() => MetricsResponse) | undefined;
  resetMetrics?: (() => void) | undefined;
  spawn?: SpawnGenerator | undefined;
  logger: Logger;
  now?: () => number;
  requestTimeoutMs?: number;
  progressIntervalMs?: number;
  /** How long a stopped generator gets to report before it is killed. */
  stopGraceMs?: number;
  primeTimeoutMs?: number;
  /** Slack past duration + request timeout before an unfinished run is stopped. */
  deadlineGraceMs?: number;
}

// ─────────────────────────────────────────────────────────────── views

export interface LoadTestRunView {
  runKey: string;
  state: RunState;
  profile: LoadTestStartRequest['profile'];
  cardMode: 'warm' | 'cold' | null;
  concurrency: number;
  durationSeconds: number;
  seed: number;
  label: string | null;
  resetMetricsWindow: boolean;
  operatorDiscordId: string | null;
  requestedAt: string;
  /** When the timed phase began; null while preparing or priming. */
  startedAt: string | null;
  endsAt: string | null;
  elapsedMs: number;
  remainingMs: number | null;
  progress: RunnerSnapshot | null;
  error: string | null;
  /** `load_test_runs.id` once the result has been written. */
  resultId: number | null;
}

export class LoadTestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadTestConflictError';
  }
}

export class LoadTestUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadTestUnavailableError';
  }
}

/** Variables the generator inherits. Everything else — every secret — stays here. */
const GENERATOR_ENV_ALLOWLIST = ['PATH', 'NODE_ENV', 'TZ', 'LANG', 'HOME', 'NODE_OPTIONS'] as const;

export function generatorEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GENERATOR_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.LOAD_TESTING_ENABLED = 'true';
  return env;
}

/**
 * Forks `runner.ts` (under tsx in development) or `runner.js` (from `dist`),
 * whichever sits beside this file. `execArgv` is inherited, which is what
 * carries tsx's loader into the child in development.
 */
export const defaultSpawnGenerator: SpawnGenerator = (env) => {
  const runnerPath = path.join(__dirname, `runner${path.extname(__filename)}`);
  return fork(runnerPath, [], {
    env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    serialization: 'json',
  }) as unknown as GeneratorProcess;
};

interface ActiveRun {
  view: LoadTestRunView;
  request: LoadTestStartRequest;
  child: GeneratorProcess | undefined;
  /** Set by the child's `exit` event — `exitCode` stays null for a signal death. */
  exited: boolean;
  stopRequested: boolean;
  /** Settles when a stop is requested, so long waits can be cut short. */
  stopSignal: Promise<void>;
  signalStop: () => void;
  requestedAtMs: number;
  startedAtMs: number | null;
  coldPlan: PlannedColdCard[];
  metricsStart: CompactMetrics | null;
  /** Resolves the current wait (primed / done) when the generator speaks or dies. */
  waiter: ((event: GeneratorEvent) => void) | undefined;
  pending: GeneratorEvent[];
}

type GeneratorEvent =
  | { kind: 'primed' }
  | { kind: 'done'; summary: RunnerSummary; stopped: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'exit'; code: number | null };

export class LoadTestController {
  private readonly deps: LoadTestControllerDeps;
  private readonly now: () => number;
  private readonly spawn: SpawnGenerator;
  private current: ActiveRun | undefined;
  private last: LoadTestRunView | undefined;
  private running: Promise<void> | undefined;

  constructor(deps: LoadTestControllerDeps) {
    // The third lock, after route registration and the permission: even a
    // wiring mistake that built one of these in production gets nothing.
    if (!deps.enabled) throw new Error('load testing is disabled (LOAD_TESTING_ENABLED is not true)');
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.spawn = deps.spawn ?? defaultSpawnGenerator;
  }

  get cardsAvailable(): boolean {
    return this.deps.cardsAvailable;
  }

  get hostLabel(): string | null {
    return this.deps.hostLabel ?? null;
  }

  currentRun(): LoadTestRunView | null {
    return this.current ? this.refresh(this.current) : null;
  }

  lastRun(): LoadTestRunView | null {
    return this.last ?? null;
  }

  start(request: LoadTestStartRequest, operatorDiscordId: string | null): LoadTestRunView {
    if (this.current) throw new LoadTestConflictError('A load test is already running.');
    if (request.profile === 'cards' && !this.deps.cardsAvailable) {
      throw new LoadTestUnavailableError('Card rendering is disabled on this server (CARD_RENDERER_ENABLED).');
    }
    const nowMs = this.now();
    let signalStop: () => void = () => {};
    const stopSignal = new Promise<void>((resolve) => {
      signalStop = resolve;
    });
    const run: ActiveRun = {
      view: {
        runKey: `lt-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
        state: 'preparing',
        profile: request.profile,
        cardMode: request.profile === 'cards' ? (request.cardMode ?? 'warm') : null,
        concurrency: request.concurrency,
        durationSeconds: request.durationSeconds,
        seed: request.seed ?? DEFAULT_SEED,
        label: request.label && request.label.length > 0 ? request.label : null,
        resetMetricsWindow: request.resetMetricsWindow === true,
        operatorDiscordId,
        requestedAt: new Date(nowMs).toISOString(),
        startedAt: null,
        endsAt: null,
        elapsedMs: 0,
        remainingMs: null,
        progress: null,
        error: null,
        resultId: null,
      },
      request,
      child: undefined,
      exited: false,
      stopRequested: false,
      stopSignal,
      signalStop,
      requestedAtMs: nowMs,
      startedAtMs: null,
      coldPlan: [],
      metricsStart: null,
      waiter: undefined,
      pending: [],
    };
    this.current = run;
    this.deps.logger.info(
      { tag: 'load-test/start', runKey: run.view.runKey, profile: request.profile, concurrency: request.concurrency, durationSeconds: request.durationSeconds, cardMode: run.view.cardMode },
      'load test starting',
    );
    this.running = this.execute(run).finally(() => {
      this.running = undefined;
    });
    return this.refresh(run);
  }

  /** Asks the active run to stop. Null when nothing is running. */
  stop(): LoadTestRunView | null {
    const run = this.current;
    if (!run) return null;
    if (!run.stopRequested) {
      run.stopRequested = true;
      run.signalStop();
      if (!TERMINAL_STATES.has(run.view.state)) run.view.state = 'stopping';
      this.sendToChild(run, { type: 'stop' });
      // Bounded whatever phase the run is in: a generator that has not gone
      // within the grace is killed, and its exit ends whatever was waiting.
      const kill = setTimeout(() => {
        if (run.child && !run.exited) run.child.kill('SIGKILL');
      }, this.deps.stopGraceMs ?? 30_000);
      kill.unref?.();
      this.deps.logger.info({ tag: 'load-test/stop', runKey: run.view.runKey }, 'load test stop requested');
    }
    return this.refresh(run);
  }

  /** Resolves when the active run (if any) has fully finished and cleaned up. */
  async whenIdle(): Promise<void> {
    await this.running;
  }

  /** Process shutdown: stop, give the generator its grace, then make sure it is gone. */
  async shutdown(): Promise<void> {
    this.stop();
    await this.whenIdle();
  }

  listRuns(limit = 25): Promise<LoadTestRunRow[]> {
    return this.deps.store.list(limit);
  }

  getRun(id: number): Promise<LoadTestRunRow | null> {
    return this.deps.store.get(id);
  }

  // ──────────────────────────────────────────────────────────── the run

  private async execute(run: ActiveRun): Promise<void> {
    const { request } = run;
    const durationMs = request.durationSeconds * 1000;
    const requestTimeoutMs = this.deps.requestTimeoutMs ?? 30_000;
    let summary: RunnerSummary | null = null;
    let metricsEnd: CompactMetrics | null = null;
    let outcome: 'completed' | 'stopped' | 'failed' = 'completed';

    try {
      // A crashed earlier run may have left sessions behind; none survive.
      await this.deps.preparer.release();
      if (run.stopRequested) throw new StoppedBeforeStart();
      const prepared = await this.deps.preparer.prepare(request.concurrency);
      if (run.stopRequested) throw new StoppedBeforeStart();

      const plan: RunnerPlan = {
        runKey: run.view.runKey,
        baseUrl: this.deps.baseUrl,
        sessionCookieName: this.deps.sessionCookieName,
        profile: request.profile,
        cardMode: run.view.cardMode,
        cardsAvailable: this.deps.cardsAvailable,
        concurrency: request.concurrency,
        durationMs,
        seed: run.view.seed,
        requestTimeoutMs,
        progressIntervalMs: this.deps.progressIntervalMs ?? 1_000,
        players: prepared.players.slice(0, request.concurrency),
      };

      const child = this.spawn(generatorEnv(process.env));
      run.child = child;
      this.attach(run, child);
      run.view.state = 'priming';
      this.sendToChild(run, { type: 'start', plan });

      const primed = await this.next(run, this.deps.primeTimeoutMs ?? 15 * 60_000);
      if (primed.kind === 'done') {
        summary = primed.summary;
        throw new StoppedBeforeStart();
      }
      if (primed.kind !== 'primed') throw new Error(describeEvent(primed, 'while priming'));

      // Steady state: let the background warm the priming triggered finish —
      // unless the operator stops first, which must not wait on the renderer.
      await Promise.race([
        this.deps.cold?.waitForIdle(this.deps.primeTimeoutMs ?? 15 * 60_000),
        run.stopSignal,
      ]);
      if (run.stopRequested) {
        this.sendToChild(run, { type: 'stop' });
        const ended = await this.next(run, this.deps.stopGraceMs ?? 30_000);
        if (ended.kind === 'done') summary = ended.summary;
        throw new StoppedBeforeStart();
      }

      const needed = this.deps.cardsAvailable
        ? coldCardsNeeded(request.profile, run.view.cardMode, request.concurrency, durationMs)
        : 0;
      if (needed > 0 && this.deps.cold) {
        run.coldPlan = await this.deps.cold.plan(prepared.commonSpeciesSlugs, needed);
      }

      if (run.view.resetMetricsWindow) this.deps.resetMetrics?.();
      run.metricsStart = snapshotMetrics(this.deps.readMetrics);
      run.startedAtMs = this.now();
      run.view.startedAt = new Date(run.startedAtMs).toISOString();
      run.view.endsAt = new Date(run.startedAtMs + durationMs).toISOString();
      if (!run.stopRequested) run.view.state = 'running';
      this.sendToChild(run, {
        type: 'go',
        coldCards: run.coldPlan.map(({ slug, level }) => ({ slug, level })),
      });
      if (run.stopRequested) this.sendToChild(run, { type: 'stop' });

      // Past the deadline the generator is told to stop; past the grace, killed.
      const deadline = durationMs + requestTimeoutMs + (this.deps.deadlineGraceMs ?? 30_000);
      let ended = await this.next(run, deadline);
      if (ended.kind === 'timeout') {
        this.sendToChild(run, { type: 'stop' });
        ended = await this.next(run, this.deps.stopGraceMs ?? 30_000);
        if (ended.kind === 'timeout') throw new Error('load generator did not finish and was killed');
      }
      if (ended.kind !== 'done') throw new Error(describeEvent(ended, 'while running'));
      summary = ended.summary;
      metricsEnd = snapshotMetrics(this.deps.readMetrics);
      outcome = ended.stopped || run.stopRequested ? 'stopped' : 'completed';
    } catch (err) {
      if (err instanceof StoppedBeforeStart) {
        outcome = 'stopped';
      } else if (run.stopRequested) {
        // The operator asked for this; how the generator went is a footnote.
        outcome = 'stopped';
        run.view.error = err instanceof Error ? err.message : String(err);
      } else {
        outcome = 'failed';
        run.view.error = err instanceof Error ? err.message : String(err);
        this.deps.logger.error({ err, tag: 'load-test/failed', runKey: run.view.runKey }, 'load test failed');
      }
    } finally {
      await this.cleanup(run);
    }

    if (summary) run.view.progress = summary;
    run.view.state = outcome;
    await this.record(run, outcome, summary, metricsEnd);
    this.last = this.refresh(run);
    this.current = undefined;
    this.deps.logger.info(
      {
        tag: 'load-test/end',
        runKey: run.view.runKey,
        state: outcome,
        completed: summary?.completed ?? 0,
        failures: summary?.failures.total ?? 0,
        p99Ms: summary?.latency.p99Ms ?? null,
      },
      'load test ended',
    );
  }

  private async cleanup(run: ActiveRun): Promise<void> {
    const child = run.child;
    if (child && !run.exited) {
      this.sendToChild(run, { type: 'stop' });
      const exited = await waitForExit(run, child, this.deps.stopGraceMs ?? 30_000);
      if (!exited) child.kill('SIGKILL');
    }
    if (run.coldPlan.length > 0 && this.deps.cold) {
      try {
        // Renders already dispatched finish and write; evicting before they
        // land would leave their files behind.
        await this.deps.cold.waitForIdle(120_000);
        const removed = await this.deps.cold.evict(run.coldPlan);
        this.deps.logger.info(
          { tag: 'load-test/cold-evicted', runKey: run.view.runKey, planned: run.coldPlan.length, removed },
          'cold-render cards evicted',
        );
      } catch (err) {
        this.deps.logger.warn({ err, tag: 'load-test/cold-evict-failed' }, 'cold-render eviction failed');
      }
    }
    try {
      await this.deps.preparer.release();
    } catch (err) {
      this.deps.logger.warn({ err, tag: 'load-test/release-failed' }, 'synthetic session cleanup failed');
    }
  }

  private async record(
    run: ActiveRun,
    outcome: 'completed' | 'stopped' | 'failed',
    summary: RunnerSummary | null,
    metricsEnd: CompactMetrics | null,
  ): Promise<void> {
    const endedAtMs = this.now();
    const elapsedMs = run.startedAtMs === null ? 0 : endedAtMs - run.startedAtMs;
    try {
      const row = await this.deps.store.save({
        runKey: run.view.runKey,
        status: outcome,
        profile: run.view.profile,
        cardMode: run.view.cardMode,
        concurrency: run.view.concurrency,
        durationSeconds: run.view.durationSeconds,
        elapsedSeconds: Math.round(Math.min(elapsedMs, run.view.durationSeconds * 1000) / 1000),
        seed: run.view.seed,
        label: run.view.label,
        hostLabel: this.deps.hostLabel ?? null,
        operatorDiscordId: run.view.operatorDiscordId,
        hostInfo: { ...this.deps.hostInfo() },
        summary: {
          ...(summary ?? {}),
          coldPlanned: run.coldPlan.length,
          resetMetricsWindow: run.view.resetMetricsWindow,
          serverDelta: metricsDelta(run.metricsStart, metricsEnd),
        },
        metricsStart: run.metricsStart as unknown as Record<string, unknown> | null,
        metricsEnd: metricsEnd as unknown as Record<string, unknown> | null,
        error: run.view.error,
        startedAt: new Date(run.startedAtMs ?? run.requestedAtMs),
        endedAt: new Date(endedAtMs),
      });
      run.view.resultId = row.id;
    } catch (err) {
      this.deps.logger.error({ err, tag: 'load-test/record-failed' }, 'load test result could not be saved');
    }
  }

  // ─────────────────────────────────────────────────── generator plumbing

  private attach(run: ActiveRun, child: GeneratorProcess): void {
    const deliver = (event: GeneratorEvent): void => {
      if (run.waiter) {
        const w = run.waiter;
        run.waiter = undefined;
        w(event);
      } else {
        run.pending.push(event);
      }
    };
    child.on('message', (message: RunnerMessage) => {
      switch (message.type) {
        case 'progress':
          run.view.progress = message.snapshot;
          return;
        case 'primed':
          deliver({ kind: 'primed' });
          return;
        case 'done':
          run.view.progress = message.summary;
          deliver({ kind: 'done', summary: message.summary, stopped: message.stopped });
          return;
        case 'error':
          deliver({ kind: 'error', message: message.message });
          return;
      }
    });
    child.on('exit', (code: number | null) => {
      run.exited = true;
      deliver({ kind: 'exit', code });
    });
    child.on('error', (err: Error) => deliver({ kind: 'error', message: err.message }));
  }

  private next(run: ActiveRun, timeoutMs: number): Promise<GeneratorEvent | { kind: 'timeout' }> {
    const queued = run.pending.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        run.waiter = undefined;
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      run.waiter = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
    });
  }

  private sendToChild(run: ActiveRun, message: ControllerMessage): void {
    const child = run.child;
    if (!child || !child.connected) return;
    try {
      child.send(message, () => {});
    } catch {
      // The generator is exiting; its exit event reports that.
    }
  }

  private refresh(run: ActiveRun): LoadTestRunView {
    const view = run.view;
    if (run.startedAtMs !== null && !TERMINAL_STATES.has(view.state)) {
      const elapsed = Math.max(0, this.now() - run.startedAtMs);
      const total = view.durationSeconds * 1000;
      view.elapsedMs = Math.min(elapsed, total);
      view.remainingMs = Math.max(0, total - elapsed);
    } else if (TERMINAL_STATES.has(view.state)) {
      view.remainingMs = 0;
      if (view.progress) view.elapsedMs = view.progress.elapsedMs;
    }
    return { ...view };
  }
}

class StoppedBeforeStart extends Error {
  constructor() {
    super('stopped');
  }
}

function describeEvent(event: GeneratorEvent | { kind: 'timeout' }, when: string): string {
  switch (event.kind) {
    case 'error':
      return `load generator error ${when}: ${event.message}`;
    case 'exit':
      return `load generator exited unexpectedly ${when} (code ${event.code ?? 'signal'})`;
    case 'timeout':
      return `load generator timed out ${when}`;
    default:
      return `unexpected load generator event ${event.kind} ${when}`;
  }
}

function waitForExit(run: ActiveRun, child: GeneratorProcess, timeoutMs: number): Promise<boolean> {
  if (run.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}
