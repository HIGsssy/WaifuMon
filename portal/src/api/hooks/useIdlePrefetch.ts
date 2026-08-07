/**
 * Prefetch something the *next* page will want, once this one has settled.
 *
 * The Dashboard used to prime the species catalogue on mount. That is the right
 * instinct and the wrong moment: the catalogue is a large JSON payload no
 * dashboard widget reads, and firing it alongside the profile, buddy and stats
 * calls put a fourth request into the same connection pool that first paint was
 * waiting on. On a fast link nobody notices; across Tailscale it is the
 * difference between a dashboard at 400 ms and one at 2 s.
 *
 * Deferring it to idle keeps the benefit — the Collection and Encyclopedia are
 * still instant — and removes the cost, because by the time the browser reports
 * itself idle the dashboard has already painted.
 *
 * `requestIdleCallback` is not in Safari before 17, so a timeout stands in. The
 * fallback delay is long enough to be after first paint on any link the Portal
 * is used over.
 */
import { useEffect } from 'react';

const FALLBACK_DELAY_MS = 1_200;

/** Matches the shape both branches return, so cleanup is one call site. */
type Cancel = () => void;

function whenIdle(run: () => void, timeoutMs: number): Cancel {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(() => run(), { timeout: timeoutMs });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, FALLBACK_DELAY_MS);
  return () => clearTimeout(handle);
}

/**
 * Runs `task` when the browser is idle, or after `timeoutMs` at the latest.
 *
 * `task` must be stable — wrap it in `useCallback` — because a new identity
 * re-schedules the work.
 */
export function useIdleTask(task: () => void, timeoutMs = 3_000): void {
  useEffect(() => whenIdle(task, timeoutMs), [task, timeoutMs]);
}
