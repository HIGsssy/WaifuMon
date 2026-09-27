/**
 * The event-loop monitor's lifecycle and its reporting contract.
 *
 * Deliberately not asserting *values*: how late a timer fires on a loaded CI
 * box is not a property of this code, and a test that expected "delay under
 * 50ms" would fail for reasons that have nothing to do with the monitor. What
 * is asserted is the shape — that a stall registers at all, that an unstarted
 * monitor reports absence rather than zeros, and that stop/reset behave.
 *
 * Each test builds its own monitor rather than touching a shared one, so a
 * reset here cannot disturb another test's window.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventLoopMonitor, DEFAULT_EVENT_LOOP_RESOLUTION_MS } from '../../../src/shared/metrics';

const monitors: EventLoopMonitor[] = [];

/** Tracked so a failing assertion cannot leak an enabled libuv timer. */
function makeMonitor(resolutionMs?: number): EventLoopMonitor {
  const m = resolutionMs === undefined ? new EventLoopMonitor() : new EventLoopMonitor(resolutionMs);
  monitors.push(m);
  return m;
}

afterEach(() => {
  for (const m of monitors.splice(0)) m.stop();
});

/** Blocks the loop synchronously, which is what a resvg rasterization does. */
function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('before start', () => {
  it('reports itself disabled with no fabricated readings', () => {
    const m = makeMonitor();
    const read = m.read();

    expect(m.enabled).toBe(false);
    expect(read.enabled).toBe(false);
    // Null, not zero: "we did not measure" and "we measured zero delay" are
    // different claims, and a dashboard cannot tell them apart from a 0.
    expect(read.delay).toBeNull();
    expect(read.utilization).toBeNull();
  });

  it('still reports its resolution, so a reader knows the floor in advance', () => {
    expect(makeMonitor().read().resolutionMs).toBe(DEFAULT_EVENT_LOOP_RESOLUTION_MS);
  });
});

describe('while running', () => {
  it('records a synchronous stall in the delay distribution', async () => {
    // A fine resolution so the short stall below is definitely sampled.
    const m = makeMonitor(1);
    m.start();
    expect(m.enabled).toBe(true);

    await tick(5);
    blockFor(60);
    await tick(5);

    const { delay } = m.read();
    expect(delay).not.toBeNull();
    expect(delay!.samples).toBeGreaterThan(0);
    // The stall must show up somewhere in the distribution. A loose bound on
    // purpose — the exact figure is the machine's, not this code's.
    expect(delay!.maxMs).toBeGreaterThan(10);
    // Percentiles are ordered by construction; this catches a unit-conversion
    // slip that scaled one field and not another.
    expect(delay!.maxMs).toBeGreaterThanOrEqual(delay!.p99Ms);
    expect(delay!.p99Ms).toBeGreaterThanOrEqual(delay!.p50Ms);
    expect(delay!.p50Ms).toBeGreaterThanOrEqual(delay!.minMs);
  });

  it('converts nanoseconds to milliseconds', async () => {
    const m = makeMonitor(1);
    m.start();
    await tick(20);

    const { delay } = m.read();
    expect(delay).not.toBeNull();
    // Raw libuv values are nanoseconds. Reporting them unconverted would put a
    // ~1e7 in a field labelled `ms`, which reads as a catastrophic stall.
    expect(delay!.meanMs).toBeLessThan(1000);
  });

  it('reports utilization as a fraction in [0, 1]', async () => {
    const m = makeMonitor(1);
    m.start();
    blockFor(30);
    await tick(5);

    const { utilization } = m.read();
    expect(utilization).not.toBeNull();
    expect(utilization).toBeGreaterThanOrEqual(0);
    expect(utilization).toBeLessThanOrEqual(1);
  });

  it('is idempotent on repeated start', async () => {
    const m = makeMonitor(1);
    m.start();
    await tick(10);
    m.start(); // Must not replace the histogram or double-enable a timer.
    await tick(10);

    expect(m.enabled).toBe(true);
    expect(m.read().delay!.samples).toBeGreaterThan(0);
  });
});

describe('reset', () => {
  it('starts a fresh delay window', async () => {
    const m = makeMonitor(1);
    m.start();
    // Yield before blocking. The monitor samples on a libuv timer, so blocking
    // synchronously on the same tick as `start()` stalls the loop *before* that
    // timer is ever scheduled and the stall goes unrecorded — which is a
    // property of how the sampler works, not a bug, but it makes the setup
    // below silently record nothing.
    await tick(5);
    blockFor(60);
    await tick(5);
    const before = m.read().delay!.maxMs;
    expect(before).toBeGreaterThan(10);

    m.reset();
    await tick(10);

    const after = m.read().delay;
    expect(after).not.toBeNull();
    // The old stall must be gone — that is what makes "p99 during this phase"
    // answerable at all.
    expect(after!.maxMs).toBeLessThan(before);
  });
});

describe('stop', () => {
  it('disables sampling and reports absence again', async () => {
    const m = makeMonitor(1);
    m.start();
    await tick(10);
    m.stop();

    expect(m.enabled).toBe(false);
    expect(m.read().delay).toBeNull();
  });

  it('is safe to call without a start, and twice', () => {
    const m = makeMonitor();
    expect(() => {
      m.stop();
      m.stop();
    }).not.toThrow();
  });

  it('can be restarted after stopping', async () => {
    const m = makeMonitor(1);
    m.start();
    m.stop();
    m.start();
    await tick(10);

    expect(m.enabled).toBe(true);
    expect(m.read().delay).not.toBeNull();
  });
});

describe('recent interval', () => {
  it('is null until the first rotation, and while stopped', () => {
    const m = makeMonitor(1);
    expect(m.read().recent).toBeNull();
    m.rotateRecent(); // no-op while stopped
    expect(m.read().recent).toBeNull();
    m.start();
    expect(m.read().recent).toBeNull();
  });

  it('forgets an old stall once a calm interval has passed', async () => {
    const m = makeMonitor(1);
    m.start();
    await tick(5);
    blockFor(80);
    await tick(5);
    m.rotateRecent();
    const stalled = m.read().recent!;
    expect(stalled.delay!.maxMs).toBeGreaterThan(20);
    expect(stalled.utilization).toBeGreaterThan(0);

    await tick(30);
    m.rotateRecent();
    const calm = m.read();
    // The cumulative distribution still holds the stall…
    expect(calm.delay!.maxMs).toBeGreaterThan(20);
    // …but the recent one does not. That is what a live gauge needs.
    expect(calm.recent!.delay!.maxMs).toBeLessThan(stalled.delay!.maxMs);
  });

  it('reports the interval length and a utilization in [0, 1]', async () => {
    let now = 0;
    const m = new EventLoopMonitor(1, { now: () => now });
    monitors.push(m);
    m.start();
    await tick(10);
    now += 5_000;
    m.rotateRecent();
    const recent = m.read().recent!;
    expect(recent.intervalMs).toBe(5_000);
    expect(recent.utilization).toBeGreaterThanOrEqual(0);
    expect(recent.utilization).toBeLessThanOrEqual(1);
  });

  it('is cleared by reset', async () => {
    const m = makeMonitor(1);
    m.start();
    await tick(10);
    m.rotateRecent();
    expect(m.read().recent).not.toBeNull();
    m.reset();
    expect(m.read().recent).toBeNull();
  });
});
