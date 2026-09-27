/**
 * Polls System Metrics and keeps a short in-memory history for the trend charts.
 *
 * ## Polling
 *
 * TanStack Query's `refetchInterval`, so the request is deduped, cancelled on
 * unmount and never overlapped: a poll that is still in flight when the next is
 * due is not doubled. That matters most exactly when it is most likely — under
 * load, when responses slow down.
 *
 * `refetchIntervalInBackground` is on. This page is meant to be left open in a
 * tab during a load test; pausing when the tab lost focus would put holes in
 * the history precisely while the operator was looking at the load generator.
 * (Browsers still throttle background timers, which can itself show up as
 * `stale` — accurately: the page did not receive fresh data.)
 *
 * Polling stops on 401 or 403. A session that has expired, or an owner who is
 * no longer the owner, will not start succeeding on the next tick, and polling
 * a refused endpoint every five seconds is noise in the very logs a load test
 * reads. Retry resumes it.
 *
 * `retry: false`: the next poll *is* the retry, five seconds later. A
 * backoff-retry on top would stack extra requests onto a server that is failing
 * because it is overloaded.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { getAdminSystemMetrics, type SystemMetricsReport } from '@/api/adminSystemMetrics';
import { SYSTEM_METRICS_POLICY } from '@/api/cachePolicy';
import { isPortalApiError } from '@/api/client';
import { queryKeys } from '@/api/queryKeys';
import { useNow } from '@/lib/useNow';

import { feedStatus, STALE_AFTER_POLLS, type FeedStatusResult } from './feedStatus';
import { appendSample, HISTORY_WINDOW_MS, toSample, type MetricsSample } from './metricsHistory';

/** Matches the server sampler's 5 s interval, so each poll sees a new interval. */
export const SYSTEM_METRICS_POLL_MS = 5_000;

export interface UseSystemMetricsOptions {
  pollMs?: number;
  historyWindowMs?: number;
}

export interface SystemMetricsState extends FeedStatusResult {
  report: SystemMetricsReport | null;
  history: readonly MetricsSample[];
  error: unknown;
  /** True when polling has stopped because access was refused. */
  accessDenied: boolean;
  pollMs: number;
  historyWindowMs: number;
  /** Empties the trend history. Client-only — the server's window is untouched. */
  clearHistory: () => void;
  retry: () => void;
}

function isAccessError(error: unknown): boolean {
  return isPortalApiError(error) && (error.status === 401 || error.status === 403);
}

export function useSystemMetrics(options: UseSystemMetricsOptions = {}): SystemMetricsState {
  const pollMs = options.pollMs ?? SYSTEM_METRICS_POLL_MS;
  const historyWindowMs = options.historyWindowMs ?? HISTORY_WINDOW_MS;

  const query = useQuery({
    queryKey: queryKeys.adminSystemMetrics(),
    queryFn: ({ signal }) => getAdminSystemMetrics(signal),
    ...SYSTEM_METRICS_POLICY,
    refetchInterval: (q) => (isAccessError(q.state.error) ? false : pollMs),
    refetchIntervalInBackground: true,
    retry: false,
  });

  const [history, setHistory] = useState<readonly MetricsSample[]>([]);
  useEffect(() => {
    if (query.data) setHistory((h) => appendSample(h, toSample(query.data), historyWindowMs));
  }, [query.data, historyWindowMs]);

  // Re-evaluates staleness between polls. Without it, a hung poll would leave
  // the badge saying "live" until something else happened to re-render.
  const now = useNow(Math.min(1_000, pollMs));

  const freshness = feedStatus({
    hasData: query.data !== undefined,
    lastSuccessAt: query.dataUpdatedAt,
    lastErrorAt: query.errorUpdatedAt,
    now: now.getTime(),
    staleAfterMs: pollMs * STALE_AFTER_POLLS,
  });

  const clearHistory = useCallback(() => setHistory([]), []);
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);

  return {
    ...freshness,
    report: query.data ?? null,
    history,
    error: query.error,
    accessDenied: isAccessError(query.error),
    pollMs,
    historyWindowMs,
    clearHistory,
    retry,
  };
}
