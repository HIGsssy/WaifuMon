/**
 * `/__dev/diagnostics` — developer diagnostics (plan §23).
 *
 * **Dev builds only.** `router.tsx` registers this route inside an
 * `import.meta.env.DEV` branch and imports this module dynamically from inside
 * that branch, so Vite drops the whole subtree from `npm run build`. Nothing
 * here needs its own guard as a result — but nothing here is allowed to be
 * imported from a production code path either.
 *
 * Guarantees restated from §23, and enforced below:
 *   - no secret is rendered; the bearer token shows as presence only
 *   - the only action beyond "copy" is "Clear cache", which is a dev convenience
 *
 * It pays for itself the first time someone asks "what player am I, what is the
 * API returning, and why is the Dashboard blank?" without opening devtools.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { getLastApiError, getLastApiVersion } from '@/api/client';
import { getReadiness } from '@/api/system';
import { queryKeys } from '@/api/queryKeys';
import {
  clearRequestLog,
  getRequestLog,
  subscribeToRequestLog,
  summarizeRequests,
} from '@/api/telemetry';
import { useDevAuth } from '@/auth/dev/useDevAuth';
import { useSession } from '@/auth/useSession';
import { SwitchPlayerButton } from '@/features/devLogin/SwitchPlayerButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/PageHeader';
import { imageTransferStats } from '@/images/instrumentation';
import { getImageProviderChain, imageResolverStats } from '@/images/provider';
import { describeEnv, portalEnv } from '@/lib/env';
import { formatDuration, formatPercent } from '@/lib/format';
import { DiagnosticsCard, DiagnosticsRows } from './DiagnosticsCard';

function statusTone(status: string): 'default' | 'danger' {
  return status === 'ok' ? 'default' : 'danger';
}

export function DiagnosticsPage() {
  const queryClient = useQueryClient();
  const { status, session, error } = useSession();
  const { identity } = useDevAuth();

  const requests = useSyncExternalStore(subscribeToRequestLog, getRequestLog);
  const requestSummary = summarizeRequests();

  const readiness = useQuery({
    queryKey: queryKeys.readiness(),
    queryFn: ({ signal }) => getReadiness(signal),
    staleTime: 10_000,
    retry: false,
  });

  const cache = queryClient.getQueryCache().getAll();
  const cacheSummary = {
    total: cache.length,
    errored: cache.filter((q) => q.state.status === 'error').length,
    fetching: cache.filter((q) => q.state.fetchStatus === 'fetching').length,
  };

  const lastError = getLastApiError();
  const imageStats = imageResolverStats();
  const transfer = imageTransferStats();
  const envRows = describeEnv();

  return (
    <>
      <PageHeader
        title="Developer diagnostics"
        description="Dev builds only. Never registered in a production bundle."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => queryClient.clear()}
            title="Drops every cached query — dev convenience only"
          >
            <Trash2 aria-hidden="true" />
            Clear cache
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <DiagnosticsCard
          title="Environment"
          copyText={envRows.map(({ key, value }) => `${key}=${value}`).join('\n')}
        >
          <DiagnosticsRows
            rows={[
              ['Mode', portalEnv.mode],
              ['Portal version', portalEnv.appVersion],
              ...envRows
                .filter((row) => row.key !== 'MODE')
                .map(({ key, value }) => [key, value] as [string, string]),
            ]}
          />
        </DiagnosticsCard>

        <DiagnosticsCard
          title="Platform API"
          copyText={`base=${portalEnv.apiUrl}\nversion=${getLastApiVersion() ?? 'unknown'}\nready=${readiness.data?.status ?? 'unknown'}`}
        >
          <DiagnosticsRows
            rows={[
              ['Base URL', portalEnv.apiUrl],
              ['API version header', getLastApiVersion() ?? '—'],
              [
                'GET /ready',
                readiness.isPending ? (
                  'probing…'
                ) : readiness.isError ? (
                  <Badge variant="danger">unreachable</Badge>
                ) : (
                  <Badge variant={statusTone(readiness.data.status)}>{readiness.data.status}</Badge>
                ),
              ],
              ...Object.entries(readiness.data?.components ?? {}).map(
                ([name, report]) =>
                  [
                    `  ${name}`,
                    <Badge key={name} variant={statusTone(report.status)}>
                      {report.status}
                    </Badge>,
                  ] as [string, React.ReactNode],
              ),
            ]}
          />
        </DiagnosticsCard>

        <DiagnosticsCard
          title="Session"
          copyText={`status=${status}\nplayerId=${session?.playerId ?? '—'}\nguildDbId=${session?.guildDbId ?? '—'}`}
        >
          <DiagnosticsRows
            rows={[
              ['Status', <Badge key="s">{status}</Badge>],
              ['playerId', session?.playerId ?? '—'],
              ['guildDbId', session?.guildDbId ?? '—'],
              ['displayName', session?.displayName ?? '—'],
              ['discordUserId', session?.discordUserId ?? '—'],
              ['discordGuildId', session?.discordGuildId ?? '—'],
              // The developer login is the sole source of the acting player in
              // a dev build; `VITE_DEFAULT_PLAYER_ID` is not read at all here.
              ['Signed-in user id', identity?.discordUserId ?? '(signed out)'],
              ['Signed-in guild id', identity?.discordGuildId ?? '(signed out)'],
              ['Resolution error', error instanceof Error ? error.message : '—'],
            ]}
          />
          <div className="mt-3 flex justify-end">
            <SwitchPlayerButton className="-mr-2" />
          </div>
        </DiagnosticsCard>

        <DiagnosticsCard
          title="Query cache"
          copyText={`queries=${cacheSummary.total} errored=${cacheSummary.errored} fetching=${cacheSummary.fetching}`}
        >
          <DiagnosticsRows
            rows={[
              ['Queries', cacheSummary.total],
              ['Errored', cacheSummary.errored],
              ['Fetching now', cacheSummary.fetching],
            ]}
          />
          <div className="mt-3 max-h-52 overflow-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface-raised text-ink-muted">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Key</th>
                  <th className="px-2.5 py-1.5 font-medium">Status</th>
                  <th className="px-2.5 py-1.5 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {cache.slice(0, 25).map((query) => (
                  <tr key={query.queryHash} className="border-t border-border">
                    <td className="max-w-[16rem] truncate px-2.5 py-1.5">
                      {JSON.stringify(query.queryKey)}
                    </td>
                    <td className="px-2.5 py-1.5">{query.state.status}</td>
                    <td className="px-2.5 py-1.5">
                      {query.state.dataUpdatedAt
                        ? new Date(query.state.dataUpdatedAt).toLocaleTimeString()
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DiagnosticsCard>

        <DiagnosticsCard
          title="Recent API activity"
          copyText={requests
            .map(
              (r) => `${r.method} ${r.path} ${r.status ?? 'ERR'} ${formatDuration(r.durationMs)}`,
            )
            .join('\n')}
        >
          <div className="mb-3 flex items-center gap-3 text-sm text-ink-muted">
            <span>{requestSummary.total} recorded</span>
            <span>{requestSummary.failed} failed</span>
            <span>{formatDuration(requestSummary.averageMs)} avg</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={clearRequestLog}>
              Clear log
            </Button>
          </div>
          <div className="max-h-64 overflow-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface-raised text-ink-muted">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">Method</th>
                  <th className="px-2.5 py-1.5 font-medium">Path</th>
                  <th className="px-2.5 py-1.5 font-medium">Status</th>
                  <th className="px-2.5 py-1.5 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {requests.length === 0 && (
                  <tr>
                    <td className="px-2.5 py-3 text-ink-subtle" colSpan={4}>
                      No requests recorded yet.
                    </td>
                  </tr>
                )}
                {requests.map((record) => (
                  <tr key={record.id} className="border-t border-border">
                    <td className="px-2.5 py-1.5">{record.method}</td>
                    <td className="max-w-[18rem] truncate px-2.5 py-1.5">{record.path}</td>
                    <td className="px-2.5 py-1.5">
                      {record.errorCode ? (
                        <span className="text-danger">{record.errorCode}</span>
                      ) : (
                        record.status
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">{formatDuration(record.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DiagnosticsCard>

        <DiagnosticsCard
          title="Last error"
          copyText={
            lastError
              ? `${lastError.status} ${lastError.code} ${lastError.message} requestId=${lastError.requestId ?? '—'}`
              : 'none'
          }
        >
          {lastError ? (
            <DiagnosticsRows
              rows={[
                ['Status', lastError.status === 0 ? 'network' : lastError.status],
                ['Code', lastError.code],
                ['Message', lastError.message],
                ['requestId', lastError.requestId ?? '—'],
              ]}
            />
          ) : (
            <p className="text-sm text-ink-subtle">No API error decoded this session.</p>
          )}
        </DiagnosticsCard>

        <DiagnosticsCard
          title="Image resolver"
          copyText={`chain=${getImageProviderChain()
            .map((p) => p.id)
            .join(' → ')}\nfallbackRate=${formatPercent(imageStats.fallbackRate)}`}
        >
          <DiagnosticsRows
            rows={[
              [
                'Provider chain',
                getImageProviderChain()
                  .map((p) => p.id)
                  .join(' → '),
              ],
              ['Assets resolved', imageStats.resolved],
              ['Silhouette fallbacks', imageStats.fallbacks],
              ['Fallback rate', formatPercent(imageStats.fallbackRate)],
              ['Load failures', imageStats.loadFailures],
              ['Images transferred', transfer.images],
              ['Bytes transferred', `${(transfer.totalBytes / 1024 / 1024).toFixed(1)} MB`],
              // Anything counted here is source art reaching the browser —
              // either a missing rendition or a call site with no displayWidth.
              ['Oversized (>400 KB)', transfer.largeImages],
            ]}
          />
        </DiagnosticsCard>
      </div>
    </>
  );
}
