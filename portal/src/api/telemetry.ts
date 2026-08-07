/**
 * Dev-only request telemetry — a small in-memory ring buffer of the last N HTTP
 * calls, surfaced on `/__dev/diagnostics` (plan §23).
 *
 * The buffer is fed by the Axios interceptors in `client.ts` and is guarded by
 * `portalEnv.isDev` at both ends: `record()` returns immediately in production
 * and the diagnostics feature module is never imported there, so the whole file
 * tree-shakes out of `npm run build`.
 *
 * Nothing here is reactive state. Subscribers get a plain callback so the
 * diagnostics page can re-render without dragging a store into the app (§10).
 */
import { portalEnv } from '@/lib/env';

export interface RequestRecord {
  id: number;
  method: string;
  /** Path only — query strings can carry player ids and add no diagnostic value. */
  path: string;
  status: number | null;
  durationMs: number;
  /** Decoded `error.code` when the call failed. */
  errorCode?: string;
  requestId?: string;
  at: string;
}

const CAPACITY = 50;

let buffer: RequestRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function recordRequest(entry: Omit<RequestRecord, 'id' | 'at'>): void {
  if (!portalEnv.isDev) return;
  buffer = [
    { ...entry, id: nextId++, at: new Date().toISOString() },
    ...buffer.slice(0, CAPACITY - 1),
  ];
  emit();
}

/** Most recent first. Returns a stable reference between mutations. */
export function getRequestLog(): readonly RequestRecord[] {
  return buffer;
}

export function clearRequestLog(): void {
  buffer = [];
  resetDuplicateTracking();
  emit();
}

/** `useSyncExternalStore`-compatible subscription. */
export function subscribeToRequestLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fallback rate and counts for the diagnostics summary card. */
export function summarizeRequests(): {
  total: number;
  failed: number;
  averageMs: number;
} {
  if (buffer.length === 0) return { total: 0, failed: 0, averageMs: 0 };
  const failed = buffer.filter((r) => r.status === null || r.status >= 400).length;
  const averageMs = buffer.reduce((sum, r) => sum + r.durationMs, 0) / buffer.length;
  return { total: buffer.length, failed, averageMs };
}

// ── Duplicate-request detection ─────────────────────────────────────────────

/**
 * Warns when the same path is *fetched to completion* twice inside a short
 * window.
 *
 * React Query deduplicates by query key, so two hooks asking for the same
 * resource under different keys — or two endpoints that happen to return the
 * same row — sail straight past it and cost two round trips. That is invisible
 * in devtools and obvious here.
 *
 * ### Why completions, not starts
 *
 * Counting *starts* made this warn constantly and wrongly. `<StrictMode>`
 * mounts every component twice in development: React Query starts a fetch,
 * unmounts, aborts it because the query function consumed the `AbortSignal`,
 * then refetches on the second mount. Two starts, microseconds apart, same
 * query key — and entirely by design. The old message told developers to go
 * looking for a bug that was React doing exactly what it promises, and the
 * stack traces all led into `doubleInvokeEffectsInDEV`.
 *
 * A cancelled request never reaches this function, so that pattern produces one
 * completion and no warning. Two *completed* fetches of one path inside the
 * window is the thing that actually costs a user two round trips, and it is
 * what remains worth reporting.
 *
 * The window is short on purpose: a legitimate refetch after a focus event is
 * seconds or minutes later, whereas a genuine duplicate is same-tick. Dev only,
 * and one line per offender rather than one per request.
 */
const DUPLICATE_WINDOW_MS = 1_500;

const lastCompletedByPath = new Map<string, number>();
const warnedPaths = new Set<string>();

/**
 * Records a request that actually finished — a response, or a failure that was
 * not a cancellation. Cancelled requests are excluded by the caller, which is
 * the entire mechanism that keeps StrictMode out of these numbers.
 */
export function noteRequestCompleted(path: string): void {
  if (!portalEnv.isDev) return;

  const now = performance.now();
  const previous = lastCompletedByPath.get(path);
  lastCompletedByPath.set(path, now);

  if (previous === undefined || now - previous >= DUPLICATE_WINDOW_MS) return;
  if (warnedPaths.has(path)) return;

  warnedPaths.add(path);
  console.warn(
    `[portal duplicate] ${path} completed twice within ${Math.round(now - previous)}ms. ` +
      'Two queries fetched the same resource — different query keys for one endpoint, ' +
      'two endpoints returning the same row, or a key whose identity changes between ' +
      'renders. StrictMode remounts are already excluded from this check.',
  );
}

/** Test seam, and what "Clear log" on the diagnostics page resets. */
export function resetDuplicateTracking(): void {
  lastCompletedByPath.clear();
  warnedPaths.clear();
}
