/**
 * Portal admin API client for Load Testing.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/loadTesting.ts`, gated on the owner-only
 * `system.loadtest.run`. Those routes exist only on a deployment started with
 * `LOAD_TESTING_ENABLED=true`; everywhere else every call here answers 404,
 * which the page reports as "disabled on this server" rather than as an error.
 *
 * Starting and stopping are ordinary session-cookie POSTs with the CSRF header
 * the shared client already attaches. No bearer token is involved.
 */
import { getData, postData } from './client';

export type LoadTestProfile = 'normal' | 'portal' | 'cards' | 'mixed';
export type CardMode = 'warm' | 'cold';
export type RunState =
  'preparing' | 'priming' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed';

export interface LatencyStats {
  count: number;
  minMs: number | null;
  meanMs: number | null;
  maxMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface FailureCounts {
  total: number;
  http4xx: number;
  http5xx: number;
  timeout: number;
  network: number;
}

export interface RunProgress {
  phase: 'priming' | 'running' | 'finished';
  elapsedMs: number;
  activePlayers: number;
  attempted: number;
  completed: number;
  failures: FailureCounts;
  canceled: number;
  actions: number;
  opsPerSecond: number;
  latency: LatencyStats;
  recent: { intervalMs: number; opsPerSecond: number; latency: LatencyStats } | null;
  cards: { coldRequested: number; coldPlanned: number; coldExhausted: number; notModified: number };
  generatorCpuPercentOfOneCore: number | null;
  primeProgress?: { done: number; total: number };
  endpoints?: Array<{
    endpoint: string;
    attempted: number;
    completed: number;
    failed: number;
    latency: LatencyStats;
  }>;
  sampleErrors?: string[];
}

export interface LoadTestRun {
  runKey: string;
  state: RunState;
  profile: LoadTestProfile;
  cardMode: CardMode | null;
  concurrency: number;
  durationSeconds: number;
  seed: number;
  label: string | null;
  resetMetricsWindow: boolean;
  operatorDiscordId: string | null;
  requestedAt: string;
  startedAt: string | null;
  endsAt: string | null;
  elapsedMs: number;
  remainingMs: number | null;
  progress: RunProgress | null;
  error: string | null;
  resultId: number | null;
}

export interface LoadTestLimits {
  profiles: LoadTestProfile[];
  concurrencyPresets: number[];
  durationPresetsSeconds: number[];
  maxConcurrency: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
}

export interface LoadTestStatus {
  enabled: true;
  hostLabel: string | null;
  cardsAvailable: boolean;
  limits: LoadTestLimits;
  current: LoadTestRun | null;
  last: LoadTestRun | null;
}

export interface LoadTestResult {
  id: number;
  runKey: string;
  status: 'completed' | 'stopped' | 'failed';
  profile: LoadTestProfile;
  cardMode: CardMode | null;
  concurrency: number;
  durationSeconds: number;
  elapsedSeconds: number;
  seed: number;
  label: string | null;
  hostLabel: string | null;
  operatorDiscordId: string | null;
  hostInfo: Record<string, unknown>;
  summary: Partial<RunProgress> & Record<string, unknown>;
  metricsStart: Record<string, unknown> | null;
  metricsEnd: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  endedAt: string;
}

export interface StartLoadTestBody {
  profile: LoadTestProfile;
  concurrency: number;
  durationSeconds: number;
  cardMode?: CardMode;
  label?: string;
  resetMetricsWindow?: boolean;
}

export function getLoadTestStatus(signal?: AbortSignal): Promise<LoadTestStatus> {
  return getData<LoadTestStatus>('/v1/admin/load-testing', signal ? { signal } : {});
}

export function getLoadTestResults(signal?: AbortSignal): Promise<LoadTestResult[]> {
  return getData<LoadTestResult[]>('/v1/admin/load-testing/results', {
    params: { limit: 25 },
    ...(signal ? { signal } : {}),
  });
}

export function startLoadTest(body: StartLoadTestBody): Promise<LoadTestRun> {
  return postData<LoadTestRun>('/v1/admin/load-testing/runs', body);
}

export function stopLoadTest(): Promise<LoadTestRun> {
  return postData<LoadTestRun>('/v1/admin/load-testing/runs/current/stop');
}
