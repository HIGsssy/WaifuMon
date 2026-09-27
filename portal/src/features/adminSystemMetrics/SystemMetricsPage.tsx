/**
 * `/admin/system` — live server load, for the guild owner.
 *
 * Gated on `system.metrics.read` by the route and, for real, by the API, which
 * serves it from the in-process collectors behind the session cookie — the
 * Platform API bearer token never reaches the browser.
 *
 * Built to be left open during a load test: it polls every 5 s, keeps ~10
 * minutes of trends in memory, says plainly whether what is on screen is
 * current, and never resets the server's measurement window (the Portal has no
 * way to). "Clear trends" empties only this page's history, for starting a
 * fresh view between test phases.
 */
import {
  Activity,
  AlertTriangle,
  Clock,
  Eraser,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';

import { isPortalApiError } from '@/api/client';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

import {
  CardRendererPanel,
  DatabasePanel,
  EventLoopPanel,
  HostPanel,
  HttpPanel,
  ProcessPanel,
} from './DetailPanels';
import type { FeedStatus } from './feedStatus';
import { formatAge, formatInterval } from './format';
import { LoadGauges } from './LoadGauges';
import { restartedWithin } from './metricsHistory';
import { RouteTable } from './RouteTable';
import { useSystemMetrics, type UseSystemMetricsOptions } from './useSystemMetrics';

const STATUS_PILL: Record<FeedStatus, { label: string; className: string; icon: typeof Activity }> =
  {
    loading: {
      label: 'Loading',
      className: 'border-border bg-surface-raised text-ink-muted',
      icon: Loader2,
    },
    live: {
      label: 'Live',
      className: 'border-success/40 bg-success-soft text-success',
      icon: Activity,
    },
    stale: {
      label: 'Stale',
      className: 'border-warning/40 bg-warning-soft text-warning',
      icon: Clock,
    },
    error: {
      label: 'Unavailable',
      className: 'border-danger/40 bg-danger-soft text-danger',
      icon: AlertTriangle,
    },
  };

function FeedStatusPill({ status, dataAgeMs }: { status: FeedStatus; dataAgeMs: number | null }) {
  const pill = STATUS_PILL[status];
  const Icon = pill.icon;
  const age = dataAgeMs === null ? '' : formatAge(dataAgeMs);
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="feed-status"
      data-status={status}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium',
        pill.className,
      )}
    >
      <Icon className={cn('size-3.5', status === 'loading' && 'animate-spin')} aria-hidden="true" />
      {pill.label}
      {age && status !== 'loading' && <span className="font-normal">· updated {age}</span>}
    </span>
  );
}

function describeError(error: unknown): string {
  if (isPortalApiError(error)) {
    if (error.status === 401) return 'Your session has expired. Sign in again to resume.';
    if (error.status === 403) return 'This account is no longer allowed to view system metrics.';
    if (error.isTimeout) return 'The server took too long to answer — it may be under heavy load.';
    if (error.isNetworkError) return 'The server could not be reached.';
    return error.message;
  }
  return 'Metrics could not be retrieved.';
}

function StatusBanner({
  status,
  dataAgeMs,
  error,
  accessDenied,
  onRetry,
  pollMs,
}: {
  status: FeedStatus;
  dataAgeMs: number | null;
  error: unknown;
  accessDenied: boolean;
  onRetry: () => void;
  pollMs: number;
}) {
  if (status === 'live' || status === 'loading') return null;
  const hasData = dataAgeMs !== null;
  const Icon = accessDenied ? ShieldAlert : status === 'stale' ? Clock : AlertTriangle;
  const tone =
    status === 'stale' ? 'border-warning/40 bg-warning-soft' : 'border-danger/30 bg-danger-soft';

  let message: string;
  if (status === 'stale') {
    message = `The last update arrived ${formatAge(dataAgeMs)}, and the request since has not completed — the server may be slow to respond. Values below are the last received.`;
  } else {
    message = describeError(error);
    if (hasData) message += ` Showing the last values received, ${formatAge(dataAgeMs)}.`;
    message += accessDenied
      ? ' Automatic refresh has stopped.'
      : ` Retrying every ${formatInterval(pollMs)}.`;
  }

  return (
    <div
      role="alert"
      data-testid="feed-banner"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm',
        tone,
      )}
    >
      <Icon
        className={cn('size-4 shrink-0', status === 'stale' ? 'text-warning' : 'text-danger')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 text-ink">
        <strong className="font-medium">
          {status === 'stale' ? 'Data is stale.' : 'Unable to retrieve metrics.'}
        </strong>{' '}
        {message}
      </span>
      {status === 'error' && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Retry now
        </Button>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6" data-testid="metrics-loading" aria-hidden="true">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-56 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 rounded-2xl" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    </div>
  );
}

export function SystemMetricsPage(props: UseSystemMetricsOptions = {}) {
  const m = useSystemMetrics(props);
  const report = m.report;
  const trend = { history: m.history, historyWindowMs: m.historyWindowMs, pollMs: m.pollMs };
  const showingOldData = report !== null && m.status !== 'live';

  return (
    <div>
      <PageHeader
        title="System Metrics"
        description={`Live load on the Waifumon server, refreshed every ${formatInterval(m.pollMs)}. Trends cover the last ${Math.round(m.historyWindowMs / 60_000)} minutes and are kept only in this tab.`}
        actions={
          <>
            <FeedStatusPill status={m.status} dataAgeMs={m.dataAgeMs} />
            <Button
              size="sm"
              variant="ghost"
              onClick={m.clearHistory}
              disabled={m.history.length === 0}
              title="Empties this page's trend charts. The server's measurement window is not affected."
            >
              <Eraser aria-hidden="true" />
              Clear trends
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        <StatusBanner
          status={m.status}
          dataAgeMs={m.dataAgeMs}
          error={m.error}
          accessDenied={m.accessDenied}
          onRetry={m.retry}
          pollMs={m.pollMs}
        />

        {report === null ? (
          m.status === 'loading' ? (
            <>
              <p className="sr-only" role="status">
                Loading system metrics…
              </p>
              <LoadingSkeleton />
            </>
          ) : null
        ) : (
          // Desaturated while not live, so last-known values never read as
          // current even to someone who skipped the banner. Grayscale rather
          // than opacity: fading the text would drop it below WCAG AA contrast
          // exactly when an operator most needs to read it, while the ink
          // colours are already neutral, so removing hue costs them nothing.
          // Assistive tech hears it from the banner (`role="alert"`); `data-current`
          // is for tests.
          <div
            data-testid="metrics-body"
            className={cn('space-y-6 transition-[filter]', showingOldData && 'grayscale')}
            data-current={showingOldData ? 'false' : 'true'}
          >
            {restartedWithin(m.history) && (
              <p className="rounded-lg border border-border bg-surface-raised px-3.5 py-2 text-xs text-ink-muted">
                The server restarted during the charted period. Counters and windows before the
                restart are not comparable with those after it.
              </p>
            )}

            <LoadGauges report={report} {...trend} />

            <section aria-labelledby="details-heading" className="space-y-3">
              <h2
                id="details-heading"
                className="text-sm font-medium tracking-wide text-ink-muted uppercase"
              >
                Details
              </h2>
              <div className="grid gap-4 lg:grid-cols-2">
                <EventLoopPanel report={report} {...trend} />
                <HttpPanel report={report} {...trend} />
                <DatabasePanel report={report} {...trend} />
                <CardRendererPanel report={report} {...trend} />
                <ProcessPanel report={report} {...trend} />
                <HostPanel report={report} {...trend} />
              </div>
            </section>

            <RouteTable routes={report.http.routes} />
          </div>
        )}
      </div>
    </div>
  );
}
