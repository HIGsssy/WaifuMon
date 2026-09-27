/**
 * Per-route HTTP performance.
 *
 * Route *patterns*, as the server keys them — `/api/v1/players/:playerId/...`
 * rather than one row per player. Figures are cumulative since the server's
 * window began: per-route recent intervals would multiply the server's
 * histograms by the route count for a view this table does not need, since
 * sorting by p99 already surfaces the route that is hurting.
 *
 * Sorting is client-side and the busiest routes show first by default; the
 * long tail folds behind "Show all" so the table does not push the rest of the
 * page off screen during a load test.
 */
import { useMemo, useState } from 'react';

import type { RouteMetrics } from '@/api/adminSystemMetrics';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollableRegion } from '@/components/ui/scrollableRegion';
import { cn } from '@/lib/cn';

import { formatCount, formatMs } from './format';
import { ROUTE_TABLE_COLLAPSED_ROWS, sortRoutes, type SortKey } from './routeSort';

const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'requests', label: 'Requests' },
  { key: 'p99', label: 'Slowest p99' },
  { key: 'errors', label: 'Errors' },
];

export function RouteTable({ routes }: { routes: readonly RouteMetrics[] }) {
  const [sort, setSort] = useState<SortKey>('requests');
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => sortRoutes(routes, sort), [routes, sort]);
  const visible = expanded ? sorted : sorted.slice(0, ROUTE_TABLE_COLLAPSED_ROWS);
  const hidden = sorted.length - visible.length;

  return (
    <Card data-testid="panel-routes">
      <CardHeader className="flex-wrap">
        <CardTitle>Per-route performance</CardTitle>
        <div role="group" aria-label="Sort routes by" className="flex flex-wrap gap-1.5">
          {SORTS.map((s) => (
            <Button
              key={s.key}
              size="sm"
              variant={sort === s.key ? 'outline' : 'ghost'}
              aria-pressed={sort === s.key}
              onClick={() => setSort(s.key)}
            >
              {s.label}
            </Button>
          ))}
        </div>
      </CardHeader>

      {routes.length === 0 ? (
        <p className="text-sm text-ink-muted">No requests recorded in this window yet.</p>
      ) : (
        <>
          <ScrollableRegion label="Per-route performance table">
            <table className="w-full min-w-[40rem] text-sm">
              <caption className="sr-only">
                Requests and latency per API route since the window began
              </caption>
              <thead>
                <tr className="border-b border-border text-xs text-ink-subtle">
                  <th scope="col" className="py-2 pr-3 text-left font-medium">
                    Route
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Requests
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    p50
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    p95
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    p99
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Max
                  </th>
                  <th scope="col" className="py-2 pl-2 text-right font-medium">
                    Errors
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={`${r.method} ${r.route}`}
                    className="border-b border-border/60 last:border-0"
                  >
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                      <span className="mr-2 inline-block w-12 font-mono text-xs text-ink-subtle">
                        {r.method}
                      </span>
                      <span className="font-mono text-xs break-all text-ink">{r.route}</span>
                    </th>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {formatCount(r.counts.total)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {formatMs(r.latency.p50Ms)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {formatMs(r.latency.p95Ms)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {formatMs(r.latency.p99Ms)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {formatMs(r.latency.maxMs)}
                    </td>
                    <td
                      className={cn(
                        'py-1.5 pl-2 text-right font-mono tabular-nums',
                        r.counts.serverErrors > 0 ? 'text-danger' : 'text-ink-muted',
                      )}
                    >
                      {formatCount(r.counts.errors)}
                      {r.counts.serverErrors > 0 && (
                        <span className="ml-1 text-xs">({r.counts.serverErrors} 5xx)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableRegion>
          {(hidden > 0 || expanded) && sorted.length > ROUTE_TABLE_COLLAPSED_ROWS && (
            <div className="mt-3">
              <Button size="sm" variant="ghost" onClick={() => setExpanded((e) => !e)}>
                {expanded ? 'Show fewer' : `Show all ${sorted.length} routes`}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
