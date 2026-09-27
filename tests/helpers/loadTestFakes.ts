/**
 * Fakes for the load-test controller: a scriptable generator "process", an
 * in-memory result store, a preparer and a cold-card service that record what
 * was asked of them. No fork, no database, no renderer.
 */
import { EventEmitter } from 'node:events';
import type { LoadTestRunRow } from '../../src/db/schema';
import type {
  ColdCardService,
  GeneratorProcess,
  LoadTestControllerDeps,
  RunPreparer,
} from '../../src/modules/loadTest/controller';
import { LoadTestController } from '../../src/modules/loadTest/controller';
import type { PlannedColdCard } from '../../src/modules/loadTest/coldCards';
import type { LoadTestRunStore } from '../../src/modules/loadTest/store';
import type {
  ControllerMessage,
  RunnerMessage,
  RunnerSummary,
  VirtualPlayerFixture,
} from '../../src/modules/loadTest/types';
import { createCapturedLogger } from './platformApiFixtures';

export type GeneratorScript = 'auto' | 'hang' | 'crash-on-start' | 'error-on-go' | 'manual';

export function fakeSummary(overrides: Partial<RunnerSummary> = {}): RunnerSummary {
  return {
    phase: 'finished',
    elapsedMs: 1_000,
    activePlayers: 0,
    attempted: 10,
    completed: 9,
    failures: { total: 1, http4xx: 0, http5xx: 1, timeout: 0, network: 0 },
    canceled: 0,
    actions: 4,
    opsPerSecond: 9,
    latency: { count: 9, minMs: 1, meanMs: 5, maxMs: 20, p50Ms: 4, p95Ms: 15, p99Ms: 20 },
    recent: null,
    cards: { coldRequested: 0, coldPlanned: 0, coldExhausted: 0, notModified: 0 },
    generatorCpuPercentOfOneCore: 2,
    endpoints: [],
    sampleErrors: ['GET /x → HTTP 500'],
    ...overrides,
  };
}

export class FakeGenerator extends EventEmitter implements GeneratorProcess {
  connected = true;
  readonly sent: ControllerMessage[] = [];
  readonly signals: string[] = [];
  private exited = false;

  constructor(
    private readonly script: GeneratorScript,
    readonly env: NodeJS.ProcessEnv,
  ) {
    super();
  }

  send(message: ControllerMessage, callback?: (err: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    queueMicrotask(() => this.react(message));
    return true;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.exit(null);
    return true;
  }

  /** Test-driven: deliver a generator message. */
  emitMessage(message: RunnerMessage): void {
    this.emit('message', message);
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.connected = false;
    this.emit('exit', code);
  }

  private react(message: ControllerMessage): void {
    if (this.exited) return;
    const s = this.script;
    if (s === 'hang' || s === 'manual') return;
    if (message.type === 'start') {
      if (s === 'crash-on-start') return this.exit(1);
      this.emitMessage({ type: 'primed' });
      return;
    }
    if (message.type === 'go') {
      if (s === 'error-on-go') {
        this.emitMessage({ type: 'error', message: 'boom' });
        return this.exit(1);
      }
      this.emitMessage({
        type: 'progress',
        snapshot: { ...fakeSummary({ phase: 'running' }) },
      });
      this.emitMessage({ type: 'done', summary: fakeSummary(), stopped: false });
      return this.exit(0);
    }
    if (message.type === 'stop') {
      this.emitMessage({ type: 'done', summary: fakeSummary(), stopped: true });
      this.exit(0);
    }
  }
}

export function fakePlayers(count: number): VirtualPlayerFixture[] {
  return Array.from({ length: count }, (_, i) => ({
    playerId: 1000 + i,
    sessionToken: `token-${i}`,
    ownedWaifuIds: [1, 2, 3],
    gridWaifuIds: [1, 2],
    speciesSlugs: ['alpha', 'beta'],
    neighbourPlayerIds: [1000 + ((i + 1) % count)],
  }));
}

export interface Recorder {
  prepared: number[];
  releases: number;
  planned: Array<{ slugs: readonly string[]; count: number }>;
  evicted: PlannedColdCard[][];
  rows: LoadTestRunRow[];
  generators: FakeGenerator[];
}

export function buildController(
  opts: {
    script?: GeneratorScript;
    enabled?: boolean;
    cardsAvailable?: boolean;
    withCold?: boolean;
    prepareDelayMs?: number;
    /** How long the renderer takes to go idle after priming. */
    idleDelayMs?: number;
    overrides?: Partial<LoadTestControllerDeps>;
  } = {},
): { controller: LoadTestController; rec: Recorder } {
  const rec: Recorder = { prepared: [], releases: 0, planned: [], evicted: [], rows: [], generators: [] };
  const preparer: RunPreparer = {
    async prepare(count) {
      rec.prepared.push(count);
      if (opts.prepareDelayMs) await new Promise((r) => setTimeout(r, opts.prepareDelayMs));
      return { players: fakePlayers(count), commonSpeciesSlugs: ['alpha', 'beta'] };
    },
    async release() {
      rec.releases += 1;
    },
  };
  const cold: ColdCardService = {
    async plan(slugs, count) {
      rec.planned.push({ slugs, count });
      return Array.from({ length: Math.min(count, 4) }, (_, i) => ({
        slug: 'alpha',
        level: 50 - i,
        renderKey: `abcdef0${i}`,
      }));
    },
    async evict(planned) {
      rec.evicted.push([...planned]);
      return planned.length;
    },
    async waitForIdle(timeoutMs) {
      if (opts.idleDelayMs) await new Promise((r) => setTimeout(r, Math.min(opts.idleDelayMs!, timeoutMs)));
    },
  };
  let nextId = 1;
  const store: LoadTestRunStore = {
    async save(run) {
      const row = { id: nextId++, ...run } as LoadTestRunRow;
      rec.rows.push(row);
      return row;
    },
    async list(limit) {
      return rec.rows.slice(-limit).reverse();
    },
    async get(id) {
      return rec.rows.find((r) => r.id === id) ?? null;
    },
  };
  const controller = new LoadTestController({
    enabled: opts.enabled ?? true,
    baseUrl: 'http://127.0.0.1:3120',
    sessionCookieName: 'wm_portal_session',
    cardsAvailable: opts.cardsAvailable ?? true,
    hostLabel: 'test host',
    hostInfo: () => ({
      hostname: 'h',
      platform: 'linux',
      cpuModel: null,
      logicalCpus: 4,
      totalMemoryBytes: 1,
      nodeVersion: 'v22',
      cardRenderWorkers: 2,
      databasePoolMax: 10,
    }),
    preparer,
    ...(opts.withCold === false ? {} : { cold }),
    store,
    spawn: (env) => {
      const g = new FakeGenerator(opts.script ?? 'auto', env);
      rec.generators.push(g);
      return g;
    },
    logger: createCapturedLogger('silent').logger,
    stopGraceMs: 200,
    primeTimeoutMs: 2_000,
    requestTimeoutMs: 100,
    ...opts.overrides,
  });
  return { controller, rec };
}
