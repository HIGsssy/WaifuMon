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
