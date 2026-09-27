/**
 * `/admin/load-testing` — start, watch and stop synthetic load, for the owner.
 *
 * Gated on `system.loadtest.run` by the route and, for real, by the API — which
 * registers these endpoints only on a deployment started with
 * `LOAD_TESTING_ENABLED=true`. Anywhere else the status call 404s and this page
 * says the feature is disabled on this server; it never offers a control the
 * server would refuse.
 *
 * Deliberately not a second metrics dashboard. It shows the generator's side —
 * what was asked of the server, how long it took to answer, what failed — and
 * links to System Metrics for everything the server itself reports.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, FlaskConical, Loader2, Play, Square } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import {
  getLoadTestResults,
  getLoadTestStatus,
  startLoadTest,
  stopLoadTest,
  type LoadTestLimits,
  type LoadTestProfile,
  type LoadTestResult,
  type LoadTestRun,
  type LoadTestStatus,
} from '@/api/adminLoadTesting';
import { isPortalApiError } from '@/api/client';
import { queryKeys } from '@/api/queryKeys';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

import {
  ACTIVE_STATES,
  PROFILE_INFO,
  STATE_LABEL,
  formatCount,
  formatDuration,
  formatMs,
  formatRate,
  formatSeconds,
  validateForm,
  type FormErrors,
  type FormValues,
} from './format';

export interface LoadTestingPageProps {
  /** Poll interval while a run is active. */
  activePollMs?: number;
  /** Poll interval while idle. */
  idlePollMs?: number;
}

export function LoadTestingPage({
  activePollMs = 1_000,
  idlePollMs = 10_000,
}: LoadTestingPageProps) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.adminLoadTesting(),
    queryFn: ({ signal }) => getLoadTestStatus(signal),
    refetchInterval: (q) => {
      const err = q.state.error;
      if (isPortalApiError(err) && [401, 403, 404].includes(err.status)) return false;
      return q.state.data?.current ? activePollMs : idlePollMs;
    },
    refetchIntervalInBackground: true,
    retry: false,
  });
  const active = status.data?.current ?? null;

  const results = useQuery({
    queryKey: queryKeys.adminLoadTestingResults(),
    queryFn: ({ signal }) => getLoadTestResults(signal),
    enabled: status.isSuccess,
    retry: false,
  });

  // A run finishing is the moment the history gains a row.
  const lastKey = status.data?.last?.runKey ?? null;
  useEffect(() => {
    if (lastKey !== null) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminLoadTestingResults() });
    }
  }, [lastKey, queryClient]);

  const start = useMutation({
    mutationFn: startLoadTest,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminLoadTesting() }),
  });
  const stop = useMutation({
    mutationFn: stopLoadTest,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminLoadTesting() }),
  });

  const disabled = isPortalApiError(status.error) && status.error.status === 404;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Load Testing"
        description="Generate controlled, repeatable Waifumon load from synthetic players, then read its effect on System Metrics. Infrastructure testing only — no real player is touched and nothing is sent to Discord."
        actions={
          <Button asChild size="sm" variant="outline">
            <a href="/admin/system" target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />
              Open System Metrics
            </a>
          </Button>
        }
      />

      {status.isPending && (
        <Skeleton className="h-64 rounded-2xl" data-testid="load-testing-loading" />
      )}

      {disabled && (
        <Card data-testid="load-testing-disabled">
          <p className="text-sm text-ink">
            <strong className="font-medium">Load testing is disabled on this server.</strong> It is
            enabled only on deployments started with{' '}
            <code className="rounded bg-surface-sunken px-1">LOAD_TESTING_ENABLED=true</code> — a
            staging setting, never a production one.
          </p>
        </Card>
      )}

      {status.isError && !disabled && (
        <div
          role="alert"
          className="rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm"
        >
          {isPortalApiError(status.error) && status.error.status === 403
            ? 'This account may not run load tests.'
            : 'Load-testing status could not be retrieved.'}
        </div>
      )}

      {status.data && (
        <>
          {active ? (
            <RunPanel
              run={active}
              onStop={() => stop.mutate()}
              stopping={stop.isPending || active.state === 'stopping'}
              stopError={stop.error}
            />
          ) : (
            <StartForm
              status={status.data}
              pending={start.isPending}
              error={start.error}
              onStart={(body) => start.mutate(body)}
            />
          )}
          {!active && status.data.last && <RunPanel run={status.data.last} />}
          <ResultsTable results={results.data ?? []} loading={results.isPending} />
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────── start form

function StartForm({
  status,
  pending,
  error,
  onStart,
}: {
  status: LoadTestStatus;
  pending: boolean;
  error: unknown;
  onStart: (body: Parameters<typeof startLoadTest>[0]) => void;
}) {
  const limits: LoadTestLimits = status.limits;
  const [values, setValues] = useState<FormValues>({
    profile: 'mixed',
    cardMode: 'warm',
    concurrency: '10',
    durationMinutes: '5',
    label: '',
    resetMetricsWindow: true,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateForm(values, limits, status.cardsAvailable);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onStart({
      profile: values.profile,
      concurrency: Number(values.concurrency),
      durationSeconds: Math.round(Number(values.durationMinutes) * 60),
      ...(values.profile === 'cards' ? { cardMode: values.cardMode } : {}),
      ...(values.label.trim() ? { label: values.label.trim() } : {}),
      resetMetricsWindow: values.resetMetricsWindow,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>New run</CardTitle>
        {status.hostLabel && (
          <span className="text-xs text-ink-muted" data-testid="host-label">
            Host: {status.hostLabel}
          </span>
        )}
      </CardHeader>
      <form onSubmit={submit} className="space-y-6" noValidate>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">Workload profile</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {limits.profiles.map((p: LoadTestProfile) => {
              const unavailable = p === 'cards' && !status.cardsAvailable;
              return (
                <label
                  key={p}
                  className={cn(
                    'flex cursor-pointer gap-3 rounded-xl border p-3 text-sm',
                    values.profile === p ? 'border-accent bg-accent-soft' : 'border-border',
                    unavailable && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="radio"
                    name="profile"
                    value={p}
                    checked={values.profile === p}
                    disabled={unavailable}
                    onChange={() => set('profile', p)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block font-medium text-ink">{PROFILE_INFO[p].label}</span>
                    <span className="block text-xs text-ink-muted">
                      {PROFILE_INFO[p].description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {errors.profile && <p className="mt-1 text-xs text-danger">{errors.profile}</p>}
        </fieldset>

        {values.profile === 'cards' && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">Card cache</legend>
            <div className="flex flex-wrap gap-2">
              {(['warm', 'cold'] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="cardMode"
                    value={mode}
                    checked={values.cardMode === mode}
                    onChange={() => set('cardMode', mode)}
                  />
                  {mode === 'warm' ? 'Warm (cache hits)' : 'Cold (forced renders)'}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="grid gap-6 sm:grid-cols-2">
          <PresetField
            id="concurrency"
            label="Simulated active players"
            presets={limits.concurrencyPresets.map((n) => ({ value: String(n), label: String(n) }))}
            value={values.concurrency}
            onChange={(v) => set('concurrency', v)}
            hint={`Custom up to ${limits.maxConcurrency}.`}
            error={errors.concurrency}
            inputProps={{ type: 'number', min: 1, max: limits.maxConcurrency, step: 1 }}
          />
          <PresetField
            id="duration"
            label="Duration (minutes)"
            presets={limits.durationPresetsSeconds.map((s) => ({
              value: String(s / 60),
              label: formatSeconds(s),
            }))}
            value={values.durationMinutes}
            onChange={(v) => set('durationMinutes', v)}
            hint={`Custom ${limits.minDurationSeconds / 60}–${limits.maxDurationSeconds / 60} minutes.`}
            error={errors.durationMinutes}
            inputProps={{
              type: 'number',
              min: 0.5,
              max: limits.maxDurationSeconds / 60,
              step: 0.5,
            }}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink">Label (optional)</span>
            <Input
              value={values.label}
              maxLength={120}
              placeholder="e.g. pool max 20"
              onChange={(e) => set('label', e.target.value)}
            />
          </label>
          <label className="flex items-start gap-2 self-end text-sm">
            <input
              type="checkbox"
              checked={values.resetMetricsWindow}
              onChange={(e) => set('resetMetricsWindow', e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium text-ink">Reset the metrics window at start</span>
              <span className="block text-xs text-ink-muted">
                Cumulative System Metrics percentiles then cover this run only.
              </span>
            </span>
          </label>
        </div>

        {error != null && (
          <p role="alert" className="text-sm text-danger">
            {isPortalApiError(error) ? error.message : 'The run could not be started.'}
          </p>
        )}

        <Button type="submit" variant="accent" disabled={pending}>
          {pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
          Start load test
        </Button>
      </form>
    </Card>
  );
}

function PresetField({
  id,
  label,
  presets,
  value,
  onChange,
  hint,
  error,
  inputProps,
}: {
  id: string;
  label: string;
  presets: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
  hint: string;
  error: string | undefined;
  inputProps: React.ComponentProps<'input'>;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label={`${label} presets`}>
        {presets.map((p) => (
          <Button
            key={p.value}
            type="button"
            size="sm"
            variant={value === p.value ? 'accent' : 'outline'}
            aria-pressed={value === p.value}
            onClick={() => onChange(p.value)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        className="max-w-40"
        {...inputProps}
      />
      <p id={`${id}-hint`} className={cn('mt-1 text-xs', error ? 'text-danger' : 'text-ink-muted')}>
        {error ?? hint}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── run panel

function Stat({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-xl border border-border p-3" data-testid={testId}>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-1 font-display text-xl text-ink tabular-nums">{value}</dd>
      {sub && <dd className="mt-0.5 text-xs text-ink-muted">{sub}</dd>}
    </div>
  );
}

const STATE_TONE: Record<string, string> = {
  running: 'border-success/40 bg-success-soft text-success',
  completed: 'border-success/40 bg-success-soft text-success',
  failed: 'border-danger/40 bg-danger-soft text-danger',
  stopped: 'border-warning/40 bg-warning-soft text-warning',
  stopping: 'border-warning/40 bg-warning-soft text-warning',
};

function RunPanel({
  run,
  onStop,
  stopping,
  stopError,
}: {
  run: LoadTestRun;
  onStop?: () => void;
  stopping?: boolean;
  stopError?: unknown;
}) {
  const p = run.progress;
  const isActive = ACTIVE_STATES.has(run.state);
  const total = run.durationSeconds * 1000;
  const pct = total > 0 ? (run.elapsedMs / total) * 100 : 0;
  const prime = p?.primeProgress;

  return (
    <Card data-testid={isActive ? 'active-run' : 'last-run'}>
      <CardHeader>
        <div>
          <CardTitle>{isActive ? 'Current run' : 'Last run'}</CardTitle>
          <p className="mt-1 text-sm text-ink">
            {PROFILE_INFO[run.profile].label}
            {run.cardMode ? ` (${run.cardMode})` : ''} · {run.concurrency} players ·{' '}
            {formatSeconds(run.durationSeconds)}
            {run.label ? ` · ${run.label}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            role="status"
            data-testid="run-state"
            data-state={run.state}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium',
              STATE_TONE[run.state] ?? 'border-border bg-surface-raised text-ink-muted',
            )}
          >
            {isActive && run.state !== 'running' && (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            )}
            {STATE_LABEL[run.state]}
          </span>
          {isActive && onStop && (
            <Button size="sm" variant="danger" onClick={onStop} disabled={stopping}>
              <Square aria-hidden="true" />
              Stop
            </Button>
          )}
        </div>
      </CardHeader>

      {run.state === 'priming' && prime && (
        <p className="mb-3 text-sm text-ink-muted">
          Priming: touching every read once ({prime.done}/{prime.total}) and letting background card
          warming settle, so the timed phase starts from steady state.
        </p>
      )}
      {run.error && (
        <p role="alert" className="mb-3 flex items-center gap-2 text-sm text-danger">
          <AlertTriangle className="size-4" aria-hidden="true" />
          {run.error}
        </p>
      )}
      {stopError != null && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {isPortalApiError(stopError) ? stopError.message : 'Stop failed.'}
        </p>
      )}

      <div className="mb-4">
        <div className="mb-1 flex justify-between text-xs text-ink-muted">
          <span>Elapsed {formatDuration(run.elapsedMs)}</span>
          <span>Remaining {formatDuration(run.remainingMs)}</span>
        </div>
        <Progress value={pct} aria-label="Run progress" />
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="Virtual players active"
          value={`${p?.activePlayers ?? 0} / ${run.concurrency}`}
          testId="stat-active"
        />
        <Stat
          label="Operations attempted"
          value={formatCount(p?.attempted)}
          sub={`${formatCount(p?.actions)} actions`}
          testId="stat-attempted"
        />
        <Stat
          label="Operations completed"
          value={formatCount(p?.completed)}
          testId="stat-completed"
        />
        <Stat
          label="Failures"
          value={formatCount(p?.failures.total)}
          sub={
            p
              ? `4xx ${p.failures.http4xx} · 5xx ${p.failures.http5xx} · timeout ${p.failures.timeout} · network ${p.failures.network}`
              : undefined
          }
          testId="stat-failures"
        />
        <Stat
          label="Operations / sec"
          value={formatRate(p?.opsPerSecond)}
          sub={p?.recent ? `recent ${formatRate(p.recent.opsPerSecond)}` : undefined}
          testId="stat-ops"
        />
        <Stat
          label="Latency p50"
          value={formatMs(p?.latency.p50Ms)}
          sub={p?.recent ? `recent ${formatMs(p.recent.latency.p50Ms)}` : undefined}
          testId="stat-p50"
        />
        <Stat
          label="Latency p95"
          value={formatMs(p?.latency.p95Ms)}
          sub={p?.recent ? `recent ${formatMs(p.recent.latency.p95Ms)}` : undefined}
          testId="stat-p95"
        />
        <Stat
          label="Latency p99"
          value={formatMs(p?.latency.p99Ms)}
          sub={p?.recent ? `recent ${formatMs(p.recent.latency.p99Ms)}` : undefined}
          testId="stat-p99"
        />
        {p && (p.cards.coldPlanned > 0 || p.cards.notModified > 0) && (
          <Stat
            label="Cards"
            value={`${formatCount(p.cards.coldRequested)} cold`}
            sub={`${p.cards.coldPlanned} planned · ${p.cards.notModified} × 304${p.cards.coldExhausted ? ` · plan spent ${p.cards.coldExhausted}×` : ''}`}
          />
        )}
        <Stat
          label="Generator CPU"
          value={
            p?.generatorCpuPercentOfOneCore == null
              ? '—'
              : `${p.generatorCpuPercentOfOneCore.toFixed(1)}%`
          }
          sub="of one core — included in host CPU, not process CPU"
        />
      </dl>
      <p className="mt-3 text-xs text-ink-muted">
        Latency is measured by the generator: request sent to body received, over loopback.
        Cumulative figures cover the timed phase; “recent” is the last second.
      </p>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────── history

function ResultsTable({ results, loading }: { results: LoadTestResult[]; loading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <FlaskConical className="mr-1.5 inline size-4" aria-hidden="true" />
          Recorded runs
        </CardTitle>
      </CardHeader>
      {loading ? (
        <Skeleton className="h-24" />
      ) : results.length === 0 ? (
        <p className="text-sm text-ink-muted">No runs recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-sm" data-testid="results-table">
            <thead className="text-xs text-ink-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Started</th>
                <th className="py-2 pr-3 font-medium">Host</th>
                <th className="py-2 pr-3 font-medium">Profile</th>
                <th className="py-2 pr-3 text-right font-medium">Players</th>
                <th className="py-2 pr-3 text-right font-medium">Duration</th>
                <th className="py-2 pr-3 text-right font-medium">Ops</th>
                <th className="py-2 pr-3 text-right font-medium">Failures</th>
                <th className="py-2 pr-3 text-right font-medium">Ops/s</th>
                <th className="py-2 pr-3 text-right font-medium">p50 / p95 / p99</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const s = r.summary;
                return (
                  <tr key={r.id} className="border-t border-border tabular-nums">
                    <td className="py-2 pr-3">{new Date(r.startedAt).toLocaleString()}</td>
                    <td className="py-2 pr-3">
                      {r.hostLabel ?? String(r.hostInfo.hostname ?? '—')}
                    </td>
                    <td className="py-2 pr-3">
                      {PROFILE_INFO[r.profile]?.label ?? r.profile}
                      {r.cardMode ? ` (${r.cardMode})` : ''}
                      {r.label ? (
                        <span className="block text-xs text-ink-muted">{r.label}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-right">{r.concurrency}</td>
                    <td className="py-2 pr-3 text-right">
                      {formatDuration(r.elapsedSeconds * 1000)}
                    </td>
                    <td className="py-2 pr-3 text-right">{formatCount(s.completed)}</td>
                    <td className="py-2 pr-3 text-right">{formatCount(s.failures?.total)}</td>
                    <td className="py-2 pr-3 text-right">{formatRate(s.opsPerSecond)}</td>
                    <td className="py-2 pr-3 text-right">
                      {formatMs(s.latency?.p50Ms)} / {formatMs(s.latency?.p95Ms)} /{' '}
                      {formatMs(s.latency?.p99Ms)}
                    </td>
                    <td className="py-2">{r.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
