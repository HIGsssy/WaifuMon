/**
 * The top of the page: current load, at a glance.
 *
 * Eight gauges in two rows of four. The first row is the Waifumon process
 * itself — where pressure shows up first when players pile on. The second is
 * what it depends on: the database pool, the card renderer, and the machine.
 *
 * Every gauge reads the server's *recent* (~5 s) figures where a recent figure
 * exists, never the cumulative since-start ones — see `metricsHistory.ts`.
 */
import type { SystemMetricsReport } from '@/api/adminSystemMetrics';

import {
  formatBytes,
  formatCount,
  formatFraction,
  formatMs,
  formatPct,
  formatRate,
} from './format';
import { series, type MetricsSample, type NumericSampleKey } from './metricsHistory';
import { Gauge, Sparkline, type SparklineProps } from './primitives';
import {
  assessEventLoopUtilization,
  assessMemory,
  assessPool,
  assessRenderer,
  ELU_CRITICAL,
  ELU_WARN,
  poolUtilization,
  type Assessment,
} from './thresholds';

interface TrendProps {
  history: readonly MetricsSample[];
  historyWindowMs: number;
  pollMs: number;
}

const neutral = (reason: string): Assessment => ({ level: 'neutral', reason });

/** Sparkline bound to one history series, with a generated description. */
export function Trend({
  history,
  historyWindowMs,
  pollMs,
  field,
  describe,
  ...rest
}: TrendProps & {
  field: NumericSampleKey;
  /** How to read one value aloud, e.g. `formatPct`. */
  describe: (v: number) => string;
  name: string;
} & Pick<SparklineProps, 'max' | 'guides' | 'level'>) {
  const points = series(history, field);
  const end = history[history.length - 1]?.t ?? 0;
  const values = points.map((p) => p.v).filter((v): v is number => v !== null);
  const latest = values[values.length - 1];
  const peak = values.length ? Math.max(...values) : undefined;
  const minutes = Math.round(historyWindowMs / 60_000);
  const label =
    latest === undefined
      ? `${rest.name}: no trend data yet`
      : `${rest.name} over the last ${minutes} minutes: latest ${describe(latest)}, peak ${describe(peak!)}`;
  return (
    <Sparkline
      points={points}
      end={end}
      windowMs={historyWindowMs}
      gapMs={pollMs * 2.5}
      label={label}
      {...(rest.max === undefined ? {} : { max: rest.max })}
      {...(rest.guides === undefined ? {} : { guides: rest.guides })}
      {...(rest.level === undefined ? {} : { level: rest.level })}
    />
  );
}

export function LoadGauges({ report, ...trend }: TrendProps & { report: SystemMetricsReport }) {
  const recentLoop = report.eventLoop.recent;
  const sys = report.system;
  const host = sys.host;
  const cgroup = sys.cgroup;
  const pool = report.database.pool;
  const cards = report.cards;
  const http = report.http;

  // ── Event loop
  const elu = recentLoop?.utilization ?? null;
  const eluAssessment = assessEventLoopUtilization(elu);

  // ── Process CPU
  const cpu = sys.process;

  // ── Memory: scaled to the tightest limit that actually applies.
  const rss = report.process.memory.rssBytes;
  const memCeiling = cgroup?.memoryLimitBytes ?? host?.memory?.totalBytes ?? null;
  const memCeilingLabel =
    cgroup?.memoryLimitBytes != null
      ? 'container limit'
      : host?.memory
        ? sys.hostViewVirtualized
          ? 'visible memory'
          : 'host RAM'
        : null;

  // ── Pool
  const poolFrac = pool ? poolUtilization(pool) : null;
  const busy = pool ? pool.totalCount - pool.idleCount : null;

  // ── Renderer: size is known before any worker has started.
  const size = cards.workers?.size ?? cards.poolSize;
  const renderer =
    size === null
      ? null
      : { size, active: cards.workers?.active ?? 0, queued: cards.workers?.queued ?? 0 };
  const rendererAssessment = assessRenderer(renderer);

  return (
    <section aria-labelledby="current-load-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="current-load-heading"
          className="text-sm font-medium tracking-wide text-ink-muted uppercase"
        >
          Current load
        </h2>
        <p className="text-xs text-ink-subtle">
          {sys.intervalMs
            ? `Measured over the last ${Math.round(sys.intervalMs / 1000)} s`
            : 'First interval pending'}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Gauge
          testId="gauge-event-loop"
          title="Event loop utilization"
          value={formatFraction(elu)}
          fraction={elu}
          assessment={eluAssessment}
          caption={`p99 delay ${formatMs(recentLoop?.delay?.p99Ms)}`}
        >
          <Trend
            {...trend}
            name="Event loop utilization"
            field="eventLoopUtilization"
            describe={formatFraction}
            max={1}
            level={eluAssessment.level}
            guides={[
              { value: ELU_WARN, level: 'warn' },
              { value: ELU_CRITICAL, level: 'critical' },
            ]}
          />
        </Gauge>

        <Gauge
          testId="gauge-process-cpu"
          title="Waifumon CPU"
          value={formatPct(cpu.percentOfAvailable)}
          fraction={cpu.percentOfAvailable === null ? null : cpu.percentOfAvailable / 100}
          assessment={neutral('CPU % has no threshold without contention data')}
          caption={
            cpu.percentOfOneCore === null
              ? 'First interval pending'
              : `${formatPct(cpu.percentOfOneCore)} of one core · ${cpu.availableCores} ${cpu.availableCores === 1 ? 'core' : 'cores'} available`
          }
        >
          <Trend
            {...trend}
            name="Waifumon CPU"
            field="processCpuPercent"
            describe={(v) => formatPct(v)}
            max={100}
          />
        </Gauge>

        <Gauge
          testId="gauge-memory"
          title="Waifumon memory (RSS)"
          value={formatBytes(rss)}
          fraction={memCeiling ? rss / memCeiling : null}
          assessment={assessMemory(cgroup?.oomKills ?? null)}
          caption={
            memCeiling
              ? `of ${formatBytes(memCeiling)} ${memCeilingLabel}`
              : 'No memory ceiling known'
          }
        >
          <Trend {...trend} name="Waifumon memory" field="rssBytes" describe={formatBytes} />
        </Gauge>

        <Gauge
          testId="gauge-in-flight"
          title="HTTP requests in flight"
          value={formatCount(http.inFlight)}
          fraction={http.inFlight / Math.max(1, http.peakInFlight)}
          assessment={neutral('No defensible in-flight limit')}
          caption={`peak ${formatCount(http.peakInFlight)} · ${formatRate(http.recent?.requestsPerSecond)}`}
        >
          <Trend
            {...trend}
            name="Requests per second"
            field="requestsPerSecond"
            describe={formatRate}
          />
        </Gauge>

        <Gauge
          testId="gauge-db-pool"
          title="Database pool"
          value={pool ? `${busy} / ${pool.max ?? '?'}` : '—'}
          fraction={poolFrac}
          assessment={assessPool(pool)}
          caption={
            pool ? `${pool.idleCount} idle · ${pool.waitingCount} waiting` : 'No pool reading'
          }
        >
          <Trend
            {...trend}
            name="Busy connections"
            field="dbBusy"
            describe={(v) => `${v} busy`}
            {...(pool?.max ? { max: pool.max } : {})}
          />
        </Gauge>

        <Gauge
          testId="gauge-renderer"
          title="Card renderer"
          value={renderer ? `${renderer.active} / ${renderer.size}` : '—'}
          fraction={renderer && renderer.size > 0 ? renderer.active / renderer.size : null}
          assessment={rendererAssessment}
          caption={
            renderer
              ? `${renderer.queued} queued · peak queue ${cards.workers?.peakQueued ?? 0}`
              : 'No card rendered in this process'
          }
        >
          <Trend
            {...trend}
            name="Queued card renders"
            field="rendererQueued"
            describe={(v) => `${v} queued`}
            {...(renderer
              ? { guides: [{ value: renderer.size, level: 'critical' as const }] }
              : {})}
          />
        </Gauge>

        <Gauge
          testId="gauge-host-cpu"
          title={sys.hostViewVirtualized ? 'CPU (virtualized /proc)' : 'Host CPU'}
          value={formatPct(host?.cpu?.busyPercent)}
          fraction={host?.cpu ? host.cpu.busyPercent / 100 : null}
          assessment={neutral('See CPU pressure for contention')}
          caption={
            host?.cpu
              ? `iowait ${formatPct(host.cpu.iowaitPercent)} · steal ${formatPct(host.cpu.stealPercent)} · pressure ${formatPct(host.pressure.cpu?.someAvg10, 1)}`
              : host
                ? 'First interval pending'
                : 'Not available on this platform'
          }
        >
          <Trend
            {...trend}
            name="Host CPU"
            field="hostCpuPercent"
            describe={(v) => formatPct(v)}
            max={100}
          />
        </Gauge>

        <Gauge
          testId="gauge-host-memory"
          title={sys.hostViewVirtualized ? 'Memory (virtualized /proc)' : 'Host memory'}
          value={formatPct(host?.memory?.usedPercent)}
          fraction={host?.memory ? host.memory.usedPercent / 100 : null}
          assessment={neutral('Includes every process on the machine')}
          caption={
            host?.memory
              ? `${formatBytes(host.memory.usedBytes)} of ${formatBytes(host.memory.totalBytes)} · swap ${formatBytes(host.memory.swapUsedBytes)}`
              : 'Not available on this platform'
          }
        >
          <Trend
            {...trend}
            name="Host memory"
            field="hostMemoryUsedPercent"
            describe={(v) => formatPct(v)}
            max={100}
          />
        </Gauge>
      </div>
    </section>
  );
}
