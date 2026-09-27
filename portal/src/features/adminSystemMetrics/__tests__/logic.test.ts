/**
 * The System Metrics page's pure logic: thresholds, history, feed status and
 * route ordering. No DOM, no network.
 *
 * The threshold tests pin the *boundaries*, because the boundaries are the
 * documented claims (`thresholds.ts` says why each one is where it is). They
 * also pin the readings that deliberately have no threshold — a future edit
 * that "helpfully" colours CPU % should have to delete a test that says why not.
 */
import { describe, expect, it } from 'vitest';

import type { RouteMetrics, SystemMetricsReport } from '@/api/adminSystemMetrics';

import { systemMetricsReport } from '../../../../msw/fixtures';
import { feedStatus } from '../feedStatus';
import { formatBytes, formatMs, formatUptime } from '../format';
import {
  appendSample,
  restartedWithin,
  series,
  seriesMax,
  toSample,
  type MetricsSample,
} from '../metricsHistory';
import { sortRoutes } from '../routeSort';
import {
  assessEventLoopDelay,
  assessEventLoopUtilization,
  assessFullPressure,
  assessLoadPerCore,
  assessMemory,
  assessPool,
  assessRenderer,
  assessServerErrors,
  poolUtilization,
  worst,
} from '../thresholds';

const report = (at = '2026-09-26T12:00:00.000Z') =>
  systemMetricsReport(at) as unknown as SystemMetricsReport;

// ─────────────────────────────────────────────────────────────── thresholds

describe('event-loop utilization', () => {
  it.each([
    [0, 'ok'],
    [0.69, 'ok'],
    [0.7, 'warn'],
    [0.89, 'warn'],
    [0.9, 'critical'],
    [1, 'critical'],
  ])('%s → %s', (u, level) => {
    expect(assessEventLoopUtilization(u).level).toBe(level);
  });

  it('is neutral with no reading, never "ok"', () => {
    expect(assessEventLoopUtilization(null).level).toBe('neutral');
  });
});

describe('event-loop delay p99', () => {
  it.each([
    // An idle loop reads about the 20 ms sampling resolution — comfortably ok.
    [20, 'ok'],
    [99, 'ok'],
    [100, 'warn'],
    [999, 'warn'],
    [1000, 'critical'],
  ])('%s ms → %s', (ms, level) => {
    expect(assessEventLoopDelay(ms).level).toBe(level);
  });
});

describe('database pool', () => {
  const pool = (total: number, idle: number, waiting: number, max: number | null = 10) => ({
    totalCount: total,
    idleCount: idle,
    waitingCount: waiting,
    max,
  });

  it('is critical the moment anything waits for a connection', () => {
    const a = assessPool(pool(10, 0, 1));
    expect(a.level).toBe('critical');
    expect(a.reason).toMatch(/1 query waiting/);
  });

  it('warns when every connection is checked out, before anything waits', () => {
    expect(assessPool(pool(10, 0, 0)).level).toBe('warn');
  });

  it('is ok with any idle connection, however busy — no arbitrary percentage', () => {
    expect(assessPool(pool(10, 1, 0)).level).toBe('ok');
    expect(assessPool(pool(9, 0, 0)).level).toBe('ok'); // one more can still open
  });

  it('computes busy as a fraction of the ceiling', () => {
    expect(poolUtilization(pool(7, 3, 0))).toBe(0.4);
    expect(poolUtilization(pool(7, 3, 0, null))).toBeNull();
  });
});

describe('card renderer', () => {
  it.each([
    [{ size: 2, active: 0, queued: 0 }, 'ok'],
    [{ size: 2, active: 1, queued: 0 }, 'ok'],
    [{ size: 2, active: 2, queued: 0 }, 'warn'], // saturated: next cold card waits
    [{ size: 2, active: 2, queued: 1 }, 'warn'],
    [{ size: 2, active: 2, queued: 2 }, 'critical'], // a full round backed up
  ] as const)('%o → %s', (reading, level) => {
    expect(assessRenderer(reading).level).toBe(level);
  });

  it('is neutral for in-process rendering and for no renderer at all', () => {
    expect(assessRenderer({ size: 0, active: 0, queued: 0 }).level).toBe('neutral');
    expect(assessRenderer(null).level).toBe('neutral');
  });
});

describe('readings with deliberately no percentage threshold', () => {
  it('memory is neutral short of an actual OOM kill', () => {
    expect(assessMemory(0).level).toBe('neutral');
    expect(assessMemory(null).level).toBe('neutral');
    expect(assessMemory(1).level).toBe('critical');
  });
});

describe('server errors', () => {
  it('warns on any 5xx in the interval, and is ok on none', () => {
    expect(assessServerErrors(0).level).toBe('ok');
    expect(assessServerErrors(3).level).toBe('warn');
    expect(assessServerErrors(null).level).toBe('neutral');
  });
});

describe('host signals', () => {
  it('warns when load exceeds one per core', () => {
    expect(assessLoadPerCore(1).level).toBe('ok');
    expect(assessLoadPerCore(1.01).level).toBe('warn');
  });

  it('warns on any full pressure stall', () => {
    expect(assessFullPressure(0).level).toBe('ok');
    expect(assessFullPressure(0.01).level).toBe('warn');
    expect(assessFullPressure(null).level).toBe('neutral');
  });
});

describe('worst', () => {
  it('picks the most severe level', () => {
    expect(
      worst(
        { level: 'ok', reason: 'a' },
        { level: 'critical', reason: 'b' },
        { level: 'warn', reason: 'c' },
      ),
    ).toEqual({ level: 'critical', reason: 'b' });
  });
});

// ─────────────────────────────────────────────────────────────── history

describe('toSample', () => {
  it('trends the recent interval, never the cumulative window', () => {
    const s = toSample(report());
    // Fixture: cumulative ELU 0.18, recent 0.42; cumulative p99 38.7, recent 52.5.
    expect(s.eventLoopUtilization).toBe(0.42);
    expect(s.eventLoopP99Ms).toBe(52.5);
    // HTTP: cumulative p99 180, recent 96.
    expect(s.httpP99Ms).toBe(96);
    expect(s.requestsPerSecond).toBe(42.4);
  });

  it('derives busy connections and reads renderer load', () => {
    const s = toSample(report());
    expect(s.dbBusy).toBe(4);
    expect(s.rendererActive).toBe(1);
    expect(s.processCpuPercent).toBe(32.25);
  });

  it('reports an idle-but-configured renderer as zero, not missing', () => {
    const r = report();
    r.cards.workers = null;
    const s = toSample(r);
    expect(s.rendererActive).toBe(0);
    expect(s.rendererQueued).toBe(0);
  });

  it('degrades missing host data to null', () => {
    const r = report();
    r.system.host = null;
    const s = toSample(r);
    expect(s.hostCpuPercent).toBeNull();
    expect(s.cpuPressure).toBeNull();
  });
});

describe('appendSample', () => {
  const at = (t: number, pid = 1): MetricsSample => ({ ...toSample(report()), t, pid });

  it('appends in order', () => {
    const h = appendSample(appendSample([], at(1000)), at(2000));
    expect(h.map((s) => s.t)).toEqual([1000, 2000]);
  });

  it('returns the same array for a repeated report, so React skips the update', () => {
    const h = appendSample([], at(1000));
    expect(appendSample(h, at(1000))).toBe(h);
  });

  it('trims samples older than the window, measured from the newest sample', () => {
    let h: readonly MetricsSample[] = [];
    for (const t of [0, 1000, 2000, 3000]) h = appendSample(h, at(t), 1500);
    expect(h.map((s) => s.t)).toEqual([2000, 3000]);
  });

  it('restarts the history if the server clock goes backwards', () => {
    const h = appendSample(appendSample([], at(5000)), at(1000));
    expect(h.map((s) => s.t)).toEqual([1000]);
  });

  it('ignores a sample with an unparseable time', () => {
    const h = appendSample([], at(1000));
    expect(appendSample(h, at(Number.NaN))).toBe(h);
  });

  it('spots a server restart by a changed pid', () => {
    expect(restartedWithin([at(1, 10), at(2, 10)])).toBe(false);
    expect(restartedWithin([at(1, 10), at(2, 11)])).toBe(true);
  });
});

describe('series', () => {
  it('extracts one field and finds its peak', () => {
    const h = [
      { ...toSample(report()), t: 1, dbWaiting: 0 },
      { ...toSample(report()), t: 2, dbWaiting: 3 },
      { ...toSample(report()), t: 3, dbWaiting: null },
    ];
    const pts = series(h, 'dbWaiting');
    expect(pts).toEqual([
      { t: 1, v: 0 },
      { t: 2, v: 3 },
      { t: 3, v: null },
    ]);
    expect(seriesMax(pts)).toBe(3);
    expect(seriesMax([])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────── feed status

describe('feedStatus', () => {
  const base = {
    hasData: false,
    lastSuccessAt: 0,
    lastErrorAt: 0,
    now: 100_000,
    staleAfterMs: 15_000,
  };

  it('is loading before anything arrives', () => {
    expect(feedStatus(base)).toEqual({ status: 'loading', dataAgeMs: null });
  });

  it('is error when the first attempt failed', () => {
    expect(feedStatus({ ...base, lastErrorAt: 99_000 }).status).toBe('error');
  });

  it('is live with recent data', () => {
    expect(feedStatus({ ...base, hasData: true, lastSuccessAt: 95_000 })).toEqual({
      status: 'live',
      dataAgeMs: 5_000,
    });
  });

  it('is stale when data has not refreshed within the threshold', () => {
    expect(feedStatus({ ...base, hasData: true, lastSuccessAt: 80_000 }).status).toBe('stale');
  });

  it('is error — not live — when the latest attempt failed, even with fresh-looking data', () => {
    const r = feedStatus({ ...base, hasData: true, lastSuccessAt: 98_000, lastErrorAt: 99_000 });
    expect(r.status).toBe('error');
    expect(r.dataAgeMs).toBe(2_000);
  });

  it('recovers to live once a success follows the error', () => {
    const r = feedStatus({ ...base, hasData: true, lastSuccessAt: 99_500, lastErrorAt: 99_000 });
    expect(r.status).toBe('live');
  });
});

// ─────────────────────────────────────────────────────────────── routes & format

describe('sortRoutes', () => {
  const route = (
    name: string,
    total: number,
    p99: number | null,
    errors: number,
  ): RouteMetrics => ({
    route: name,
    method: 'GET',
    counts: { total, byStatusClass: {}, errors, serverErrors: 0 },
    latency: { count: total, minMs: 1, meanMs: 1, maxMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: p99 },
  });
  const routes = [route('/a', 10, 5, 0), route('/b', 50, 900, 2), route('/c', 30, null, 9)];

  it('orders by requests, p99 or errors', () => {
    expect(sortRoutes(routes, 'requests').map((r) => r.route)).toEqual(['/b', '/c', '/a']);
    expect(sortRoutes(routes, 'p99').map((r) => r.route)).toEqual(['/b', '/a', '/c']);
    expect(sortRoutes(routes, 'errors').map((r) => r.route)).toEqual(['/c', '/b', '/a']);
  });

  it('does not mutate its input', () => {
    const copy = [...routes];
    sortRoutes(routes, 'p99');
    expect(routes).toEqual(copy);
  });
});

describe('formatters', () => {
  it('formats bytes in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(412 * 1024 * 1024)).toBe('412 MiB');
    expect(formatBytes(16 * 1024 ** 3)).toBe('16.0 GiB');
    expect(formatBytes(null)).toBe('—');
  });

  it('keeps sub-millisecond precision where it matters', () => {
    expect(formatMs(0.42)).toBe('0.42 ms');
    expect(formatMs(52.5)).toBe('53 ms');
    expect(formatMs(1480)).toBe('1.48 s');
  });

  it('formats uptime coarsely', () => {
    expect(formatUptime(93_784)).toBe('1d 2h');
    expect(formatUptime(125)).toBe('2m 5s');
  });
});
