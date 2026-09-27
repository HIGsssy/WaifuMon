/**
 * Whether the dashboard is showing current data.
 *
 *   loading  nothing has arrived yet, and nothing has failed
 *   live     the last poll succeeded, recently
 *   stale    data is on screen, but none has arrived for longer than
 *            `staleAfterMs` — a poll is hanging, or the tab was throttled
 *   error    the most recent attempt failed. Data may still be on screen, and
 *            is then shown as last-known, never as current
 *
 * `stale` and `error` are separate on purpose. "The server refused" and "the
 * server has gone quiet" call for different next steps, and during a load test
 * the second — responses slowing until polls stop completing — is itself the
 * finding.
 *
 * Every time here is the *browser's* clock (when a response arrived), never the
 * server's `collectedAt`. Freshness is a question about this page's connection,
 * and mixing two clocks would make a laptop with drift report stale data as
 * live, or the reverse.
 */

export type FeedStatus = 'loading' | 'live' | 'stale' | 'error';

/** Three missed polls. One late response is noise; three is a pattern. */
export const STALE_AFTER_POLLS = 3;

export interface FeedStatusInput {
  hasData: boolean;
  /** Epoch ms the last successful response arrived; 0 when none has. */
  lastSuccessAt: number;
  /** Epoch ms the last failed attempt settled; 0 when none has. */
  lastErrorAt: number;
  now: number;
  staleAfterMs: number;
}

export interface FeedStatusResult {
  status: FeedStatus;
  /** Age of the data on screen; null when there is none. */
  dataAgeMs: number | null;
}

export function feedStatus(input: FeedStatusInput): FeedStatusResult {
  const dataAgeMs = input.hasData ? Math.max(0, input.now - input.lastSuccessAt) : null;
  const failedLast = input.lastErrorAt > 0 && input.lastErrorAt >= input.lastSuccessAt;

  if (!input.hasData) return { status: failedLast ? 'error' : 'loading', dataAgeMs };
  if (failedLast) return { status: 'error', dataAgeMs };
  if (dataAgeMs !== null && dataAgeMs > input.staleAfterMs) return { status: 'stale', dataAgeMs };
  return { status: 'live', dataAgeMs };
}
