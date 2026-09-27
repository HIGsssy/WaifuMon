/**
 * The load-test contract: what may be asked for, and the shapes that cross
 * the process boundary between the controller (in the Waifumon process) and
 * the generator (a separate child process).
 *
 * Everything here is plain data. The generator imports this file and
 * `profiles.ts` and nothing that touches the database, Discord or the card
 * renderer — see `runner.ts` for why that matters.
 */
import { z } from 'zod';

export const LOAD_TEST_PROFILES = ['normal', 'portal', 'cards', 'mixed'] as const;
export type LoadTestProfile = (typeof LOAD_TEST_PROFILES)[number];

export const CARD_MODES = ['warm', 'cold'] as const;
export type CardMode = (typeof CARD_MODES)[number];

/** Offered as one-click presets. The question the harness exists to answer. */
export const CONCURRENCY_PRESETS = [1, 5, 10, 25, 50] as const;
export const DURATION_PRESETS_SECONDS = [60, 300, 600] as const;

/**
 * Safety ceilings. Twice the largest preset for players: enough headroom to
 * find the knee past 50, not enough to turn a capacity test into a flood.
 * Thirty minutes for time: longer than any preset, short enough that a
 * forgotten run ends on its own.
 */
export const MAX_CONCURRENCY = 100;
export const MIN_DURATION_SECONDS = 30;
export const MAX_DURATION_SECONDS = 30 * 60;

export const loadTestStartSchema = z
  .object({
    profile: z.enum(LOAD_TEST_PROFILES),
    concurrency: z.coerce.number().int().min(1).max(MAX_CONCURRENCY),
    durationSeconds: z.coerce.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
    /** Only meaningful for `cards`; required there, ignored elsewhere. */
    cardMode: z.enum(CARD_MODES).optional(),
    /** Free text shown beside the run, e.g. "after pool max=20". */
    label: z.string().trim().max(120).optional(),
    /**
     * PRNG seed. Omitted means a fixed default, so two runs of the same
     * scenario make the same choices in the same order — the point of a
     * comparison between hosts.
     */
    seed: z.coerce.number().int().min(0).max(2 ** 31 - 1).optional(),
    /**
     * Zero the server's cumulative HTTP and event-loop windows as the timed
     * phase starts, so the end-of-run percentiles cover the run and nothing
     * before it. Off unless asked: it also resets what the System Metrics page
     * shows as cumulative.
     */
    resetMetricsWindow: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.profile === 'cards' && v.cardMode === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cardMode'],
        message: 'cardMode (warm or cold) is required for the cards profile',
      });
    }
  });

export type LoadTestStartRequest = z.infer<typeof loadTestStartSchema>;

export const DEFAULT_SEED = 1337;

export type RunState =
  | 'preparing'
  | 'priming'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed';

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(['completed', 'stopped', 'failed']);

/** Client-observed latency, milliseconds. Null throughout when nothing completed. */
export interface LatencyStats {
  count: number;
  minMs: number | null;
  meanMs: number | null;
  maxMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

/** Why an operation failed. `http` is any 4xx/5xx the workload did not expect. */
export interface FailureCounts {
  total: number;
  http4xx: number;
  http5xx: number;
  timeout: number;
  network: number;
}

export interface EndpointStats {
  /** Route template, e.g. `GET /players/:id/collection/owned`. */
  endpoint: string;
  attempted: number;
  completed: number;
  failed: number;
  latency: LatencyStats;
}

/**
 * One progress report from the generator. Cumulative over the timed phase;
 * `recent` covers the last report interval only.
 */
export interface RunnerSnapshot {
  phase: 'priming' | 'running' | 'finished';
  elapsedMs: number;
  activePlayers: number;
  /** HTTP requests issued / answered successfully (2xx or expected 304). */
  attempted: number;
  completed: number;
  failures: FailureCounts;
  /** Requests abandoned because the run was stopped — neither completed nor failed. */
  canceled: number;
  /** Page views / commands — the unit a person experiences. */
  actions: number;
  opsPerSecond: number;
  latency: LatencyStats;
  recent: { intervalMs: number; opsPerSecond: number; latency: LatencyStats } | null;
  cards: { coldRequested: number; coldPlanned: number; coldExhausted: number; notModified: number };
  /** The generator's own CPU, so its share of the host figures can be subtracted. */
  generatorCpuPercentOfOneCore: number | null;
  primeProgress?: { done: number; total: number } | undefined;
}

export interface RunnerSummary extends RunnerSnapshot {
  endpoints: EndpointStats[];
  /** Up to 20 distinct failure descriptions, for diagnosis. */
  sampleErrors: string[];
}

// ───────────────────────────────────────────────────── generator plan (IPC)

/** One synthetic player as the generator sees it: a cookie and some ids. */
export interface VirtualPlayerFixture {
  playerId: number;
  /** Portal session cookie value. Bound to this synthetic player only. */
  sessionToken: string;
  ownedWaifuIds: number[];
  /** The first collection page — the only owned cards the warm workload asks for. */
  gridWaifuIds: number[];
  /** Species this player has discovered (owns), so species cards answer 200. */
  speciesSlugs: string[];
  /** Other synthetic players in the same guild, for public-profile views. */
  neighbourPlayerIds: number[];
}

export interface ColdCardTarget {
  slug: string;
  level: number;
}

export interface RunnerPlan {
  runKey: string;
  baseUrl: string;
  /** Passed in rather than imported, so the generator loads no server module. */
  sessionCookieName: string;
  profile: LoadTestProfile;
  cardMode: CardMode | null;
  /** Whether the card routes exist on this server; card actions are skipped otherwise. */
  cardsAvailable: boolean;
  concurrency: number;
  durationMs: number;
  seed: number;
  requestTimeoutMs: number;
  progressIntervalMs: number;
  players: VirtualPlayerFixture[];
}

/** Controller → generator. */
export type ControllerMessage =
  | { type: 'start'; plan: RunnerPlan }
  | { type: 'go'; coldCards: ColdCardTarget[] }
  | { type: 'stop' };

/** Generator → controller. */
export type RunnerMessage =
  | { type: 'progress'; snapshot: RunnerSnapshot }
  | { type: 'primed' }
  | { type: 'done'; summary: RunnerSummary; stopped: boolean }
  | { type: 'error'; message: string };
