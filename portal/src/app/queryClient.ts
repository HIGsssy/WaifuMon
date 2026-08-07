/**
 * The QueryClient and its defaults (plan §10, §13, §14).
 *
 * The defaults encode the two philosophies the Portal is judged on:
 *
 *   §13 cache      player-scoped resources are short-lived and refetch on focus
 *                  so a player alt-tabbing back from a hunt catches up; content
 *                  is effectively static and overrides these per-hook.
 *   §14 loading    `placeholderData: keepPreviousData` is the default on every
 *                  list and detail query, so a filter change or page turn keeps
 *                  the previous grid on screen instead of blanking it.
 *
 * `retry: 1` matches §10 ("retries default to 1 for reads"), with one carve-out:
 * a 4xx is a settled answer, and retrying it just doubles the latency before
 * the error state appears.
 */
import { QueryCache, QueryClient } from '@tanstack/react-query';

import { isPortalApiError } from '@/api/client';
import { PLAYER_POLICY } from '@/api/cachePolicy';
import { portalEnv } from '@/lib/env';

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isPortalApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (portalEnv.isDev) {
          console.warn('[portal error] query failed', query.queryKey, error);
        }
      },
    }),
    defaultOptions: {
      queries: {
        ...PLAYER_POLICY,
        retry: shouldRetry,
        refetchOnReconnect: true,
        // Errors surface as `isError` on the owning component so one failing
        // tile never takes out the page (§19 "partial responses").
        throwOnError: false,
      },
    },
  });
}
