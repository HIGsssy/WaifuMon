/**
 * Ordering for the per-route table. Split from `RouteTable.tsx` so the
 * component module exports only components (fast refresh) and so the ordering
 * can be tested on its own.
 */
import type { RouteMetrics } from '@/api/adminSystemMetrics';

export type SortKey = 'requests' | 'p99' | 'errors';

export const ROUTE_TABLE_COLLAPSED_ROWS = 12;

export function sortRoutes(routes: readonly RouteMetrics[], key: SortKey): RouteMetrics[] {
  const value = (r: RouteMetrics): number => {
    if (key === 'requests') return r.counts.total;
    if (key === 'errors') return r.counts.errors;
    return r.latency.p99Ms ?? -1;
  };
  // Ties broken by request count, then by name, so the order is stable between
  // polls and rows do not shuffle while the operator is reading them.
  return [...routes].sort(
    (a, b) =>
      value(b) - value(a) ||
      b.counts.total - a.counts.total ||
      `${a.method} ${a.route}`.localeCompare(`${b.method} ${b.route}`),
  );
}
