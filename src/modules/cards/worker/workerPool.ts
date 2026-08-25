/**
 * A small, fixed pool of threads that draw card masters.
 *
 * Scope is deliberately narrow: this is a card-master render pool, not a
 * general application worker framework. It knows one job shape, has no plugin
 * surface, and is ~200 lines because that is all the problem needs.
 *
 * ## What it guarantees
 *
 * - **Bounded.** At most `size` renders run at once, however many callers ask.
 *   Twenty-five distinct cold cards produce twenty-five queued jobs and two
 *   threads, never twenty-five threads.
 * - **Lazy.** Threads are spawned on the first job, so a process that never
 *   renders a card (the flag is off by default) never pays for them, and a
 *   test that constructs a renderer without rendering spawns nothing.
 * - **Idle-transparent.** Workers are `unref`'d whenever the pool is idle, so
 *   they never hold the process open — and `ref`'d again while work is in
 *   flight, so a render can never be cut short by the process deciding it had
 *   nothing left to do. This is what lets `cards:warm` and Vitest exit
 *   normally without every caller remembering to shut the pool down.
 * - **Self-healing.** A thread that dies takes its own job's promise down with
 *   it and nothing else; the next job spawns a replacement.
 *
 * ## What it deliberately does *not* do
 *
 * No dedupe, no caching, no retries. Identical keys are collapsed by the
 * renderer *before* they reach the queue, which is both cheaper (one job, not
 * two) and the only place that can see the disk cache. Retrying a failed
 * render would turn a deterministic content error — a species with no
 * artwork — into three of them.
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { CardRenderError } from '../errors';
import { reviveCardError, type CardRenderJob, type CardRenderResponse } from './protocol';
import type { CardRenderInput } from '../types';
import type { Logger } from '../../../shared/logger';

/**
 * Threads by default.
 *
 * Two, not `os.cpus()`. Each thread holds a full decoded card in flight
 * (hundreds of MB of peak RSS across a burst), and the container this runs in
 * rarely has the core count the host reports — deriving the default from the
 * machine is how a 2-vCPU deployment ends up trying to render sixteen cards at
 * once. Tuned by measurement in `CARD_RENDER_WORKERS`, not by hardware.
 */
export const DEFAULT_CARD_RENDER_WORKERS = 2;

/** Guardrail on the configured value; the pool is not the right tool at scale. */
export const MAX_CARD_RENDER_WORKERS = 8;

export interface CardRenderPoolOptions {
  assetRoot: string;
  /** Threads. `0` is not valid here — the renderer skips the pool entirely. */
  size?: number | undefined;
  logger?: Logger | undefined;
  /**
   * How to start a thread. Defaults to the real card worker.
   *
   * Exists so the pool's own behaviour — bounding, queueing, what happens when
   * a thread dies mid-job — can be tested against a thread that answers in
   * microseconds and can be told to crash on cue. Proving those properties
   * through real 1.4-second card renders would be slow, and *provoking* a
   * genuine worker crash on demand is not something the render path offers.
   * The real worker is covered separately, end to end.
   */
  spawn?: (() => Worker) | undefined;
}

export interface CardRenderPoolStats {
  /** Threads currently alive. */
  workers: number;
  /** Threads started over the pool's life, replacements included. */
  spawned: number;
  /** Threads replaced after an unexpected exit or error. */
  replaced: number;
  /** Jobs waiting for a free thread right now. */
  queued: number;
  /** High-water mark of `queued` — how deep a burst actually got. */
  peakQueued: number;
  /** High-water mark of simultaneous renders. Must never exceed `size`. */
  peakConcurrent: number;
  /** Jobs dispatched to a thread over the pool's life. */
  dispatched: number;
}

interface Pending {
  job: CardRenderJob;
  resolve: (bytes: Buffer) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  current: Pending | null;
  /** Set while the pool is deliberately tearing this thread down. */
  retiring: boolean;
}

/**
 * The worker entry, resolved next to this file so it follows the build.
 *
 * Under `tsx` and Vitest this file is `.ts` and the entry beside it is too;
 * in `dist/` both are `.js`. Deriving the extension from `__filename` is what
 * makes one code path serve development, tests and production — the
 * alternative is a build step that copies a hand-written `.js` worker, and a
 * second copy of the render code to keep in step with the first.
 */
const WORKER_ENTRY = path.join(
  __dirname,
  `cardRenderWorker${path.extname(__filename) === '.ts' ? '.ts' : '.js'}`,
);

/**
 * Starts the worker thread.
 *
 * A `.ts` entry needs a TypeScript hook registered *inside* the new thread —
 * loaders are per-thread, so the one `tsx` installed on the main thread does
 * not follow us here. The eval bootstrap is the smallest thing that does it:
 * two `require` calls, no build step, no second copy of the worker in plain JS.
 */
function spawnWorker(): Worker {
  if (WORKER_ENTRY.endsWith('.ts')) {
    return new Worker(`require('tsx/cjs');require(${JSON.stringify(WORKER_ENTRY)});`, {
      eval: true,
    });
  }
  return new Worker(WORKER_ENTRY);
}

/** A render that died with its thread rather than failing on its own terms. */
export class CardWorkerCrashedError extends CardRenderError {
  constructor(detail: string) {
    super(
      'CARD_WORKER_CRASHED',
      `Card render worker stopped unexpectedly (${detail})`,
      'Card art is being updated, try again shortly~',
    );
  }
}

/** The pool refused work because the process is shutting down. */
export class CardPoolClosedError extends CardRenderError {
  constructor() {
    super(
      'CARD_POOL_CLOSED',
      'Card render pool is shut down',
      'Card art is being updated, try again shortly~',
    );
  }
}

export class CardRenderPool {
  private readonly assetRoot: string;
  private readonly size: number;
  private readonly logger: Logger | undefined;
  private readonly spawn: () => Worker;
  private readonly workers: PoolWorker[] = [];
  private readonly queue: Pending[] = [];
  private readonly jobs = new Map<number, Pending>();
  private nextJobId = 1;
  private closed = false;
  private spawned = 0;
  private replaced = 0;
  private dispatched = 0;
  private peakQueued = 0;
  private peakConcurrent = 0;

  constructor(options: CardRenderPoolOptions) {
    this.assetRoot = options.assetRoot;
    this.size = clampSize(options.size ?? DEFAULT_CARD_RENDER_WORKERS);
    this.logger = options.logger;
    this.spawn = options.spawn ?? spawnWorker;
  }

  get maxWorkers(): number {
    return this.size;
  }

  getStats(): CardRenderPoolStats {
    return {
      workers: this.workers.length,
      spawned: this.spawned,
      replaced: this.replaced,
      queued: this.queue.length,
      peakQueued: this.peakQueued,
      peakConcurrent: this.peakConcurrent,
      dispatched: this.dispatched,
    };
  }

  /** Renders one master on a worker thread. Queues when every thread is busy. */
  render(input: CardRenderInput): Promise<Buffer> {
    if (this.closed) return Promise.reject(new CardPoolClosedError());

    return new Promise<Buffer>((resolve, reject) => {
      const pending: Pending = {
        job: { id: this.nextJobId++, assetRoot: this.assetRoot, input },
        resolve,
        reject,
      };
      this.queue.push(pending);
      this.peakQueued = Math.max(this.peakQueued, this.queue.length);
      this.pump();
    });
  }

  /**
   * Stops accepting work, lets in-flight renders finish, and terminates.
   *
   * Queued-but-unstarted jobs are rejected rather than run: shutdown should be
   * bounded by the render already in progress (~1.4 s), not by however deep the
   * queue happened to be.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const pending of this.queue.splice(0)) {
      this.jobs.delete(pending.job.id);
      pending.reject(new CardPoolClosedError());
    }

    await Promise.all(
      this.workers.map(async (entry) => {
        if (entry.current !== null) {
          // Bounded by one render. Settling either way is enough — a failure
          // has already rejected its own caller.
          await new Promise<void>((done) => {
            entry.worker.once('message', () => done());
            entry.worker.once('error', () => done());
            entry.worker.once('exit', () => done());
          });
        }
        entry.retiring = true;
        await entry.worker.terminate();
      }),
    );

    this.workers.length = 0;
  }

  // ------------------------------------------------------------- internals

  /** Fills idle threads from the queue, spawning up to `size` on demand. */
  private pump(): void {
    while (this.queue.length > 0) {
      const idle = this.workers.find((entry) => entry.current === null) ?? this.grow();
      if (idle === null) return;

      const pending = this.queue.shift() as Pending;
      idle.current = pending;
      this.jobs.set(pending.job.id, pending);
      this.dispatched += 1;
      this.peakConcurrent = Math.max(this.peakConcurrent, this.busyCount());
      // Ref'd for the duration: an in-flight render must be able to hold the
      // process open, or a CLI could exit between dispatch and result.
      idle.worker.ref();
      idle.worker.postMessage(pending.job);
    }
  }

  private busyCount(): number {
    return this.workers.reduce((n, entry) => n + (entry.current === null ? 0 : 1), 0);
  }

  private grow(): PoolWorker | null {
    if (this.workers.length >= this.size) return null;

    const worker = this.spawn();
    const entry: PoolWorker = { worker, current: null, retiring: false };
    this.workers.push(entry);
    this.spawned += 1;

    worker.on('message', (response: CardRenderResponse) => this.settle(entry, response));
    worker.on('error', (err: Error) => this.discard(entry, err.message, true));
    worker.on('exit', (code) => {
      if (entry.retiring) return;
      this.discard(entry, `exit code ${code}`, code !== 0);
    });

    return entry;
  }

  private settle(entry: PoolWorker, response: CardRenderResponse): void {
    const pending = this.jobs.get(response.id);
    this.jobs.delete(response.id);
    entry.current = null;

    if (pending !== undefined) {
      if (response.ok) pending.resolve(Buffer.from(response.bytes));
      else pending.reject(reviveCardError(response.error));
    }

    this.pump();
    this.settleIdle();
  }

  /**
   * Retires a thread that failed or exited on its own.
   *
   * Its in-flight render is rejected — the bytes are gone and the disk cache
   * was never written, so the next request simply renders again. Crucially the
   * *queue* survives: one bad card must not take out the jobs behind it, and a
   * replacement thread is started by the next `pump()`.
   */
  private discard(entry: PoolWorker, detail: string, unexpected: boolean): void {
    const index = this.workers.indexOf(entry);
    if (index >= 0) this.workers.splice(index, 1);

    const pending = entry.current;
    entry.current = null;
    if (pending !== null) {
      this.jobs.delete(pending.job.id);
      pending.reject(new CardWorkerCrashedError(detail));
    }

    if (unexpected) {
      this.replaced += 1;
      this.logger?.warn(
        { tag: 'card-renderer/worker-crashed', detail, slug: pending?.job.input.species.slug },
        'card render worker stopped unexpectedly; it will be replaced',
      );
    }

    void entry.worker.terminate();
    if (!this.closed) this.pump();
    this.settleIdle();
  }

  /** An idle pool must not be the reason the process stays alive. */
  private settleIdle(): void {
    if (this.queue.length > 0 || this.busyCount() > 0) return;
    for (const entry of this.workers) entry.worker.unref();
  }
}

function clampSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_CARD_RENDER_WORKERS;
  return Math.max(1, Math.min(MAX_CARD_RENDER_WORKERS, Math.floor(size)));
}
