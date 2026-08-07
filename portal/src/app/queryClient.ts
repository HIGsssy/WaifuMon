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

import { isCanceledRequest, isPortalApiError } from '@/api/client';
import { PLAYER_POLICY } from '@/api/cachePolicy';
import { portalEnv } from '@/lib/env';

/**
 * Retry once, and only when a retry could plausibly help.
 *
 * Three carve-outs, each earned:
 *   - **4xx** is a settled answer; retrying doubles the latency before the
 *     error state appears and changes nothing.
 *   - **cancellations** are the Portal aborting its own request. Retrying an
 *     abort re-issues traffic nobody is waiting for any more.
 *   - **timeouts** are not retried either. A timeout means the connection pool
 *     was already saturated for the full timeout window; adding a second
 *     request to that queue is precisely the retry storm to avoid, and with
 *     several dashboard queries failing at once it multiplies.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isCanceledRequest(error)) return false;
  if (isPortalApiError(error)) {
    if (error.status >= 400 && error.status < 500) return false;
    if (error.isTimeout) return false;
  }
  return failureCount < 1;
}

/**
 * Capped backoff. The default is uncapped exponential, which is fine for one
 * query and unhelpful when six dashboard tiles fail together and all wake at
 * the same moment — the jitter is what spreads them out.
 */
function retryDelay(attemptIndex: number): number {
  const base = Math.min(1_000 * 2 ** attemptIndex, 8_000);
  return base + Math.random() * 250;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // A cancelled request is not a failure — see `client.ts`.
        if (portalEnv.isDev && !isCanceledRequest(error)) {
          console.warn('[portal error] query failed', query.queryKey, error);
        }
      },
    }),
    defaultOptions: {
      queries: {
        // Player-scoped is the majority case; content, shop and identity
        // queries override this from `cachePolicy.ts`. `refetchOnReconnect`
        // now travels with the policy rather than being forced on here, so a
        // brief link drop no longer refetches the entire mounted tree at once.
        ...PLAYER_POLICY,
        retry: shouldRetry,
        retryDelay,
        // Errors surface as `isError` on the owning component so one failing
        // tile never takes out the page (§19 "partial responses").
        throwOnError: false,
      },
    },
  });
}
