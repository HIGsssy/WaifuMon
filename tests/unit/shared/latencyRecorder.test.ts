/**
 * The latency recorder's arithmetic and its edge cases.
 *
 * Three of these cover failure modes that would make the instrument lie rather
 * than break — an empty histogram reporting INT64_MAX as a latency, a
 * sub-microsecond response throwing a RangeError, and an aborted request
 * ratcheting `inFlight` upward forever. Each of those would look like a real
 * measurement, which is the only kind of bug that matters in a measuring tool.
 */
import { describe, expect, it } from 'vitest';
import { LatencyRecorder, UNROUTED_KEY } from '../../../src/shared/metrics';

const DEFAULT_ROUTE = '/api/v1/players/:playerId';

/**
 * `route` uses `in` rather than `??` so a test can pass an explicit `undefined`
 * to mean "this request matched no route" — the case the `<unrouted>` fold
 * exists for. A `??` default would silently substitute the real route and make
 * that test assert nothing.
 */
function record(
  r: LatencyRecorder,
  durationMs: number,
  opts: { route?: string | undefined; status?: number; method?: string } = {},
): void {
  r.requestStarted();
  r.recordResponse({
    method: opts.method ?? 'GET',
    route: 'route' in opts ? opts.route : DEFAULT_ROUTE,
    statusCode: opts.status ?? 200,
    durationMs,
  });
}

describe('an empty window', () => {
  it('reports latency as null rather than as a sentinel', () => {
    const snap = new LatencyRecorder().snapshot();
    // An empty HDR histogram reports min as INT64_MAX (9.22e18) and mean as
    // NaN. Either would render as a plausible-looking number in JSON.
    expect(snap.latency).toEqual({
      count: 0,
      minMs: null,
      meanMs: null,
      maxMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    });
    expect(snap.counts.total).toBe(0);
    expect(snap.routes).toEqual([]);
  });
});

describe('recording', () => {
  it('reports percentiles over the recorded distribution', () => {
    const r = new LatencyRecorder();
    // 95 fast samples and 5 slow ones — the shape a render stall makes. The
    // slow tail has to be more than 1% of the sample for p99 to land in it, so
    // 5-in-100 rather than 1-in-100: with a single outlier p99 is legitimately
    // still 2ms and only `max` moves, which would make this assert the wrong
    // thing about a correct implementation.
    for (let i = 0; i < 95; i++) record(r, 2);
    for (let i = 0; i < 5; i++) record(r, 800);

    const { latency } = r.snapshot();
    expect(latency.count).toBe(100);
    // p50 stays with the bulk; p99 finds the tail. That separation is the
    // entire reason percentiles are recorded rather than a mean.
    expect(latency.p50Ms).toBeLessThan(5);
    expect(latency.p99Ms).toBeGreaterThan(700);
    expect(latency.maxMs).toBeGreaterThan(700);
    expect(latency.meanMs).toBeGreaterThan(latency.p50Ms!);
  });

  it('keeps sub-millisecond responses out of the zero bucket', () => {
    const r = new LatencyRecorder();
    // A warm card hit is genuinely this fast. `record()` rejects 0, and whole
    // milliseconds would floor every one of these to the same value.
    record(r, 0.04);
    record(r, 0.07);

    const { latency } = r.snapshot();
    expect(latency.count).toBe(2);
    expect(latency.minMs).toBeGreaterThan(0);
    expect(latency.minMs).toBeLessThan(1);
  });

  it('does not throw on a zero-duration response', () => {
    const r = new LatencyRecorder();
    // Node's histogram throws RangeError on record(0); the clamp is what stops
    // a fast response from taking down the hook that timed it.
    expect(() => record(r, 0)).not.toThrow();
    expect(r.snapshot().latency.count).toBe(1);
  });
});

describe('status accounting', () => {
  it('groups by class and separates client from server errors', () => {
    const r = new LatencyRecorder();
    record(r, 1, { status: 200 });
    record(r, 1, { status: 204 });
    record(r, 1, { status: 404 });
    record(r, 1, { status: 403 });
    record(r, 1, { status: 500 });

    const { counts } = r.snapshot();
    expect(counts.total).toBe(5);
    expect(counts.byStatusClass).toEqual({ '2xx': 2, '4xx': 2, '5xx': 1 });
    // errors is the error-rate numerator; serverErrors is the subset that is
    // ours to fix rather than a caller's bad request.
    expect(counts.errors).toBe(3);
    expect(counts.serverErrors).toBe(1);
  });

  it('files a status outside 100-599 under "other" rather than dropping it', () => {
    const r = new LatencyRecorder();
    record(r, 1, { status: 0 });
    expect(r.snapshot().counts.byStatusClass).toEqual({ other: 1 });
  });
});

describe('per-route breakdown', () => {
  it('keys on method and route pattern, sorted by traffic', () => {
    const r = new LatencyRecorder();
    record(r, 1, { route: '/api/v1/cards/:slug', method: 'GET' });
    record(r, 1, { route: '/api/v1/cards/:slug', method: 'GET' });
    record(r, 1, { route: '/api/v1/players/:playerId', method: 'GET' });

    const { routes } = r.snapshot();
    expect(routes).toHaveLength(2);
    // Busiest first, so the route that dominates a load test reads at the top.
    expect(routes[0]).toMatchObject({ route: '/api/v1/cards/:slug', method: 'GET' });
    expect(routes[0]!.counts.total).toBe(2);
    expect(routes[1]!.counts.total).toBe(1);
  });

  it('separates methods on the same path', () => {
    const r = new LatencyRecorder();
    record(r, 1, { route: '/api/v1/care', method: 'GET' });
    record(r, 1, { route: '/api/v1/care', method: 'POST' });
    expect(r.snapshot().routes).toHaveLength(2);
  });

  it('folds unmatched requests into one key instead of dropping them', () => {
    const r = new LatencyRecorder();
    // `routeOptions.url` is undefined for a 404. Dropping these would hide a
    // flood of bad requests; keying them on the URL would blow up cardinality.
    record(r, 1, { route: undefined, status: 404 });
    record(r, 1, { route: undefined, status: 404 });

    const { routes } = r.snapshot();
    expect(routes).toHaveLength(1);
    expect(routes[0]!.route).toBe(UNROUTED_KEY);
    expect(routes[0]!.counts.total).toBe(2);
  });
});

describe('in-flight tracking', () => {
  it('rises and falls with request lifetimes and remembers the peak', () => {
    const r = new LatencyRecorder();
    r.requestStarted();
    r.requestStarted();
    r.requestStarted();
    expect(r.snapshot().inFlight).toBe(3);

    r.recordResponse({ method: 'GET', route: '/x', statusCode: 200, durationMs: 1 });
    const snap = r.snapshot();
    expect(snap.inFlight).toBe(2);
    expect(snap.peakInFlight).toBe(3);
  });

  it('releases an aborted request without recording a latency sample', () => {
    const r = new LatencyRecorder();
    r.requestStarted();
    r.requestAborted();

    const snap = r.snapshot();
    // The leak this prevents would be indistinguishable from real saturation.
    expect(snap.inFlight).toBe(0);
    // And a fabricated duration would be worse than a missing one.
    expect(snap.latency.count).toBe(0);
    expect(snap.counts.total).toBe(0);
  });

  it('never underflows below zero', () => {
    const r = new LatencyRecorder();
    r.requestAborted();
    r.recordResponse({ method: 'GET', route: '/x', statusCode: 200, durationMs: 1 });
    expect(r.snapshot().inFlight).toBe(0);
  });
});

describe('reset', () => {
  it('clears the distribution, the counters and the route table', () => {
    const r = new LatencyRecorder();
    record(r, 500);
    record(r, 500, { status: 500 });
    const before = r.snapshot().windowStartedAt;

    r.reset();
    const snap = r.snapshot();

    // Percentiles cannot be differenced between scrapes, which is the whole
    // reason this exists.
    expect(snap.latency.count).toBe(0);
    expect(snap.latency.p99Ms).toBeNull();
    expect(snap.counts.total).toBe(0);
    expect(snap.counts.serverErrors).toBe(0);
    expect(snap.routes).toEqual([]);
    expect(Date.parse(snap.windowStartedAt)).toBeGreaterThanOrEqual(Date.parse(before));
  });

  it('keeps requests that are still in flight, and rebases the peak to them', () => {
    const r = new LatencyRecorder();
    r.requestStarted();
    r.requestStarted();
    r.requestAborted();
    r.reset();

    const snap = r.snapshot();
    // Zeroing inFlight here would make the next recordResponse underflow and
    // leave the count permanently wrong.
    expect(snap.inFlight).toBe(1);
    expect(snap.peakInFlight).toBe(1);
  });

  it('lets a post-reset response settle in-flight without going negative', () => {
    const r = new LatencyRecorder();
    r.requestStarted();
    r.reset();
    r.recordResponse({ method: 'GET', route: '/x', statusCode: 200, durationMs: 3 });

    const snap = r.snapshot();
    expect(snap.inFlight).toBe(0);
    expect(snap.latency.count).toBe(1);
  });
});
