/**
 * The detail panels below the gauges.
 *
 * Where a reading exists both as "the last ~5 s" and "since the window began",
 * both are shown side by side and labelled — never one silently standing in for
 * the other. The first answers "what is happening now", the second "what
 * happened across this test", and a load test needs both.
 */
import type { ReactNode } from 'react';

import type { SystemMetricsReport } from '@/api/adminSystemMetrics';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatDateTime } from '@/lib/format';

import {
  formatBytes,
  formatCount,
  formatFraction,
  formatMs,
  formatPct,
  formatRate,
  formatUptime,
} from './format';
import { Trend } from './LoadGauges';
import type { MetricsSample } from './metricsHistory';
import { LevelBadge, StatList } from './primitives';
import {
  assessEventLoopDelay,
  assessFullPressure,
  assessLoadPerCore,
  assessServerErrors,
  LOOP_DELAY_CRITICAL_MS,
  LOOP_DELAY_WARN_MS,
  type Assessment,
} from './thresholds';

interface PanelProps {
  report: SystemMetricsReport;
  history: readonly MetricsSample[];
  historyWindowMs: number;
  pollMs: number;
}

function Panel({
  title,
  assessment,
  children,
  testId,
}: {
  title: string;
  assessment?: Assessment;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {assessment && <LevelBadge assessment={assessment} />}
      </CardHeader>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{children}</h3>
  );
}

function TrendBlock({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="space-y-1">
      {children}
      <figcaption className="text-xs text-ink-subtle">{caption}</figcaption>
    </figure>
  );
}

/** A two-window comparison table: last interval vs. since the window began. */
function WindowTable({
  caption,
  rows,
  windowLabel,
}: {
  caption: string;
  rows: ReadonlyArray<{ label: string; recent: string; total: string }>;
  windowLabel: string;
}) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-1 text-left font-medium">
            <span className="sr-only">Measure</span>
          </th>
          <th scope="col" className="pb-1 text-right font-medium">
            Last 5 s
          </th>
          <th scope="col" className="pb-1 text-right font-medium">
            {windowLabel}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row" className="py-0.5 text-left font-normal text-ink-muted">
              {r.label}
            </th>
            <td className="py-0.5 text-right font-mono text-ink tabular-nums">{r.recent}</td>
            <td className="py-0.5 text-right font-mono text-ink-muted tabular-nums">{r.total}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ───────────────────────────────────────────────────────────── Event loop

export function EventLoopPanel({ report, ...trend }: PanelProps) {
  const loop = report.eventLoop;
  const recent = loop.recent;
  const delayRow = (label: string, key: 'p50Ms' | 'p95Ms' | 'p99Ms' | 'maxMs' | 'stddevMs') => ({
    label,
    recent: formatMs(recent?.delay?.[key]),
    total: formatMs(loop.delay?.[key]),
  });
  return (
    <Panel
      title="Event loop"
      assessment={assessEventLoopDelay(recent?.delay?.p99Ms ?? null)}
      testId="panel-event-loop"
    >
      <WindowTable
        caption="Event-loop delay and utilization"
        windowLabel="Since window start"
        rows={[
          delayRow('Delay p50', 'p50Ms'),
          delayRow('Delay p95', 'p95Ms'),
          delayRow('Delay p99', 'p99Ms'),
          delayRow('Delay max', 'maxMs'),
          delayRow('Delay std. dev.', 'stddevMs'),
          {
            label: 'Utilization',
            recent: formatFraction(recent?.utilization),
            total: formatFraction(loop.utilization),
          },
        ]}
      />
      <TrendBlock
        caption={`Delay p99 per interval. Dashed lines: ${LOOP_DELAY_WARN_MS} ms (perceptible) and ${LOOP_DELAY_CRITICAL_MS / 1000} s (Discord interactions at risk).`}
      >
        <Trend
          {...trend}
          name="Event-loop delay p99"
          field="eventLoopP99Ms"
          describe={formatMs}
          guides={[
            { value: LOOP_DELAY_WARN_MS, level: 'warn' },
            { value: LOOP_DELAY_CRITICAL_MS, level: 'critical' },
          ]}
        />
      </TrendBlock>
      <p className="text-xs text-ink-subtle">
        Sampled every {loop.resolutionMs} ms, so an idle loop reads about {loop.resolutionMs} ms —
        that is the floor, not a stall.
      </p>
    </Panel>
  );
}

// ───────────────────────────────────────────────────────────── HTTP

export function HttpPanel({ report, ...trend }: PanelProps) {
  const http = report.http;
  const recent = http.recent;
  const counts = http.counts;
  const errorRate = counts.total > 0 ? counts.errors / counts.total : null;
  const classes = ['2xx', '3xx', '4xx', '5xx'];
  const latencyRow = (label: string, key: 'p50Ms' | 'p95Ms' | 'p99Ms' | 'maxMs') => ({
    label,
    recent: formatMs(recent?.latency[key]),
    total: formatMs(http.latency[key]),
  });
  return (
    <Panel
      title="HTTP"
      assessment={assessServerErrors(recent?.counts.serverErrors ?? null)}
      testId="panel-http"
    >
      <StatList
        stats={[
          { label: 'Requests per second', value: formatRate(recent?.requestsPerSecond) },
          { label: 'In flight / peak', value: `${http.inFlight} / ${http.peakInFlight}` },
        ]}
      />
      <WindowTable
        caption="HTTP latency"
        windowLabel="Since window start"
        rows={[
          latencyRow('Latency p50', 'p50Ms'),
          latencyRow('Latency p95', 'p95Ms'),
          latencyRow('Latency p99', 'p99Ms'),
          latencyRow('Latency max', 'maxMs'),
          {
            label: 'Requests',
            recent: formatCount(recent?.counts.total),
            total: formatCount(counts.total),
          },
          {
            label: 'Errors (4xx + 5xx)',
            recent: formatCount(recent?.counts.errors),
            total: formatCount(counts.errors),
          },
          {
            label: 'Server errors (5xx)',
            recent: formatCount(recent?.counts.serverErrors),
            total: formatCount(counts.serverErrors),
          },
        ]}
      />
      <StatList
        stats={[
          ...classes.map((c) => ({
            label: `${c} responses`,
            value: formatCount(counts.byStatusClass[c] ?? 0),
          })),
          {
            label: 'Error rate (window)',
            value: errorRate === null ? '—' : formatPct(errorRate * 100, 1),
            hint: '4xx + 5xx as a share of all requests since the window began.',
          },
          { label: 'Window started', value: formatDateTime(http.windowStartedAt) },
        ]}
      />
      <TrendBlock caption="Latency p99 per interval.">
        <Trend {...trend} name="HTTP latency p99" field="httpP99Ms" describe={formatMs} />
      </TrendBlock>
      <TrendBlock caption="Server errors (5xx) per interval.">
        <Trend
          {...trend}
          name="Server errors per interval"
          field="serverErrors"
          describe={(v) => `${v}`}
          level="critical"
        />
      </TrendBlock>
    </Panel>
  );
}

// ───────────────────────────────────────────────────────────── Database

export function DatabasePanel({ report, ...trend }: PanelProps) {
  const pool = report.database.pool;
  return (
    <Panel title="Database pool" testId="panel-database">
      {pool ? (
        <StatList
          stats={[
            { label: 'Connections open', value: formatCount(pool.totalCount) },
            { label: 'Busy', value: formatCount(pool.totalCount - pool.idleCount) },
            { label: 'Idle', value: formatCount(pool.idleCount) },
            {
              label: 'Queries waiting',
              value: formatCount(pool.waitingCount),
              hint: 'Queued for a free connection. Sustained non-zero means the pool is the bottleneck.',
            },
            { label: 'Maximum', value: pool.max === null ? '—' : formatCount(pool.max) },
          ]}
        />
      ) : (
        <p className="text-sm text-ink-muted">No pool reading.</p>
      )}
      <TrendBlock caption="Busy connections.">
        <Trend
          {...trend}
          name="Busy connections"
          field="dbBusy"
          describe={(v) => `${v}`}
          {...(pool?.max ? { max: pool.max } : {})}
        />
      </TrendBlock>
      <TrendBlock caption="Queries waiting for a connection.">
        <Trend
          {...trend}
          name="Queries waiting"
          field="dbWaiting"
          describe={(v) => `${v}`}
          level="critical"
        />
      </TrendBlock>
    </Panel>
  );
}

// ───────────────────────────────────────────────────────────── Cards

export function CardRendererPanel({ report }: PanelProps) {
  const c = report.cards;
  const w = c.workers;
  const served =
    c.cacheHits === null ? null : c.cacheHits + (c.masterRenders ?? 0) + (c.derivativeRenders ?? 0);
  const hitShare = served ? (c.cacheHits ?? 0) / served : null;
  return (
    <Panel title="Card renderer" testId="panel-cards">
      {!c.active ? (
        <p className="text-sm text-ink-muted">
          No card has been drawn or served by this process yet. Counters appear with the first card.
        </p>
      ) : (
        <>
          <StatList
            stats={[
              {
                label: 'Master renders',
                value: formatCount(c.masterRenders),
                hint: 'Full resvg + composite passes — the expensive work.',
              },
              {
                label: 'Derivative renders',
                value: formatCount(c.derivativeRenders),
                hint: 'Resizes from an existing master.',
              },
              { label: 'Cache hits', value: formatCount(c.cacheHits) },
              {
                label: 'Deduplicated renders',
                value: formatCount(c.dedupedRenders),
                hint: 'Joined an identical render already in progress.',
              },
              {
                label: 'Served from cache',
                value: formatFraction(hitShare),
                hint: 'Cache hits as a share of cache hits plus renders.',
              },
            ]}
          />
          <SubHeading>Worker pool</SubHeading>
          {w ? (
            <StatList
              stats={[
                { label: 'Busy / size', value: `${w.active} / ${w.size}` },
                { label: 'Threads alive', value: formatCount(w.workers) },
                { label: 'Queued now', value: formatCount(w.queued) },
                { label: 'Peak queue', value: formatCount(w.peakQueued) },
                { label: 'Peak concurrency', value: formatCount(w.peakConcurrent) },
                { label: 'Jobs dispatched', value: formatCount(w.dispatched) },
                { label: 'Threads spawned', value: formatCount(w.spawned) },
                {
                  label: 'Threads replaced (crashes)',
                  value: formatCount(w.replaced),
                  hint: 'Replaced after an unexpected exit. Should stay 0.',
                },
              ]}
            />
          ) : (
            <p className="text-sm text-ink-muted">
              {c.poolSize === 0
                ? 'Rendering in-process — no worker pool.'
                : `No worker started yet (pool size ${c.poolSize ?? '—'}). Every card so far came from cache.`}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

// ───────────────────────────────────────────────────────────── Process

export function ProcessPanel({ report }: PanelProps) {
  const p = report.process;
  const heapFrac =
    p.memory.heapTotalBytes > 0 ? p.memory.heapUsedBytes / p.memory.heapTotalBytes : 0;
  return (
    <Panel title="Waifumon process" testId="panel-process">
      <StatList
        stats={[
          { label: 'Uptime', value: formatUptime(p.uptimeSeconds) },
          { label: 'Node version', value: p.nodeVersion },
          { label: 'PID', value: String(p.pid) },
          {
            label: 'RSS',
            value: formatBytes(p.memory.rssBytes),
            hint: 'Whole process, worker threads included.',
          },
        ]}
      />
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-ink-muted">Heap (main thread)</span>
          <span className="font-mono text-ink tabular-nums">
            {formatBytes(p.memory.heapUsedBytes)} / {formatBytes(p.memory.heapTotalBytes)}
          </span>
        </div>
        <Progress value={heapFrac * 100} aria-label="Main-thread heap used" />
      </div>
      <StatList
        stats={[
          {
            label: 'External',
            value: formatBytes(p.memory.externalBytes),
            hint: 'Native memory bound to JS objects — sharp and resvg buffers.',
          },
          { label: 'Array buffers', value: formatBytes(p.memory.arrayBuffersBytes) },
          {
            label: 'CPU used, user (total)',
            value: formatUptime(p.cpu.userMs / 1000),
            hint: 'Cumulative since start — not current load.',
          },
          {
            label: 'CPU used, system (total)',
            value: formatUptime(p.cpu.systemMs / 1000),
            hint: 'Cumulative since start — not current load.',
          },
          {
            label: 'Major page faults',
            value: formatCount(p.cpu.majorPageFaults),
            hint: 'Rising under load means the host is swapping.',
          },
          {
            label: 'Filesystem reads / writes',
            value: `${formatCount(p.cpu.fsReads)} / ${formatCount(p.cpu.fsWrites)}`,
          },
        ]}
      />
      <p className="text-xs text-ink-subtle">
        Heap figures describe the main thread only; card worker heaps are inside RSS.
      </p>
    </Panel>
  );
}

// ───────────────────────────────────────────────────────────── Host / cgroup

function PressureTable({
  pressure,
}: {
  pressure: NonNullable<SystemMetricsReport['system']['host']>['pressure'];
}) {
  const rows = [
    { name: 'CPU', p: pressure.cpu, full: false },
    { name: 'Memory', p: pressure.memory, full: true },
    { name: 'I/O', p: pressure.io, full: true },
  ] as const;
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Pressure stall information</caption>
      <thead>
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-1 text-left font-medium">
            Resource
          </th>
          <th scope="col" className="pb-1 text-right font-medium">
            Some 10 s
          </th>
          <th scope="col" className="pb-1 text-right font-medium">
            Some 60 s
          </th>
          <th scope="col" className="pb-1 text-right font-medium">
            Full 10 s
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ name, p, full }) => (
          <tr key={name}>
            <th scope="row" className="py-0.5 text-left font-normal text-ink-muted">
              <span className="inline-flex items-center gap-2">
                {name}
                {full && p && <LevelBadge assessment={assessFullPressure(p.fullAvg10)} />}
              </span>
            </th>
            <td className="py-0.5 text-right font-mono tabular-nums">
              {formatPct(p?.someAvg10, 1)}
            </td>
            <td className="py-0.5 text-right font-mono tabular-nums">
              {formatPct(p?.someAvg60, 1)}
            </td>
            <td className="py-0.5 text-right font-mono tabular-nums">
              {formatPct(p?.fullAvg10, 1)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HostPanel({ report, ...trend }: PanelProps) {
  const sys = report.system;
  const host = sys.host;
  const cg = sys.cgroup;
  const hostLabel = sys.hostViewVirtualized ? 'Machine (virtualized by LXCFS)' : 'Host machine';
  return (
    <Panel
      title={sys.containerized ? 'Host & container' : 'Host'}
      assessment={assessLoadPerCore(host?.loadPerCore ?? null)}
      testId="panel-host"
    >
      <p className="text-xs text-ink-subtle" data-testid="host-scope-note">
        {!host
          ? `Host readings come from Linux /proc and are not available on ${sys.platform}.`
          : sys.hostViewVirtualized
            ? 'LXCFS is mounted over /proc, so these "host" readings describe this container, not the physical machine.'
            : sys.containerized
              ? 'Running in a container. Host readings are kernel-wide — the whole machine, including Postgres and every other container — not this container alone. Container limits are listed separately below.'
              : 'Kernel-wide readings for the whole machine, including Postgres.'}
      </p>

      {host && (
        <>
          <SubHeading>{hostLabel}</SubHeading>
          <StatList
            stats={[
              { label: 'Logical CPUs', value: formatCount(host.cores) },
              {
                label: 'Load average (1 / 5 / 15 min)',
                value: host.loadAverage
                  ? `${host.loadAverage.one.toFixed(2)} / ${host.loadAverage.five.toFixed(2)} / ${host.loadAverage.fifteen.toFixed(2)}`
                  : '—',
              },
              {
                label: 'Load per CPU (1 min)',
                value: host.loadPerCore === null ? '—' : host.loadPerCore.toFixed(2),
                hint: 'Above 1.00, more tasks want to run than there are CPUs.',
              },
              { label: 'CPU busy', value: formatPct(host.cpu?.busyPercent, 1) },
              {
                label: 'CPU iowait',
                value: formatPct(host.cpu?.iowaitPercent, 1),
                hint: 'Idle, waiting on disk.',
              },
              {
                label: 'CPU steal',
                value: formatPct(host.cpu?.stealPercent, 1),
                hint: 'Taken by the hypervisor. Non-zero on a VPS means fewer real cycles than cores.',
              },
              {
                label: 'Memory used / total',
                value: host.memory
                  ? `${formatBytes(host.memory.usedBytes)} / ${formatBytes(host.memory.totalBytes)}`
                  : '—',
                hint: 'Used = total − MemAvailable, so reclaimable page cache counts as free.',
              },
              { label: 'Memory available', value: formatBytes(host.memory?.availableBytes) },
              {
                label: 'Swap used / total',
                value: host.memory
                  ? `${formatBytes(host.memory.swapUsedBytes)} / ${formatBytes(host.memory.swapTotalBytes)}`
                  : '—',
              },
            ]}
          />
          <SubHeading>Pressure (time stalled waiting)</SubHeading>
          <PressureTable pressure={host.pressure} />
          <TrendBlock caption="CPU pressure (some, 10 s average): share of time a task waited for a CPU.">
            <Trend
              {...trend}
              name="CPU pressure"
              field="cpuPressure"
              describe={(v) => formatPct(v, 1)}
              max={100}
            />
          </TrendBlock>
          <TrendBlock caption="I/O pressure (some, 10 s average): share of time a task waited on disk.">
            <Trend
              {...trend}
              name="I/O pressure"
              field="ioPressure"
              describe={(v) => formatPct(v, 1)}
              max={100}
            />
          </TrendBlock>
        </>
      )}

      {cg && (
        <>
          <SubHeading>
            {sys.containerized ? 'This container (cgroup)' : 'This process’s cgroup'}
          </SubHeading>
          <StatList
            stats={[
              { label: 'cgroup', value: <span className="break-all">{cg.path}</span> },
              {
                label: 'Memory charged',
                value: formatBytes(cg.memoryCurrentBytes),
                hint: 'Includes page cache owned by the cgroup, so it can exceed RSS.',
              },
              {
                label: 'Memory limit',
                value: cg.memoryLimitBytes === null ? 'None' : formatBytes(cg.memoryLimitBytes),
              },
              {
                label: 'Memory of limit',
                value:
                  cg.memoryPercentOfLimit === null ? '—' : formatPct(cg.memoryPercentOfLimit, 1),
              },
              {
                label: 'CPU limit',
                value: cg.cpuLimitCores === null ? 'None' : `${cg.cpuLimitCores} cores`,
              },
              { label: 'OOM kills', value: formatCount(cg.oomKills) },
            ]}
          />
        </>
      )}
    </Panel>
  );
}
