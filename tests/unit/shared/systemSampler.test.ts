/**
 * The system sampler, driven deterministically: a fake filesystem, a fake
 * monotonic clock, fake CPU counters. No timers, no real `/proc`.
 *
 * Pinned:
 *   - rates need two samples, and the first read says so with nulls;
 *   - process CPU is measured against wall time, per core, and normalized
 *     against the cgroup quota when one exists;
 *   - host and cgroup readings are kept apart and labelled;
 *   - LXCFS and container markers are detected and reported;
 *   - off Linux, host and cgroup are null rather than zeros;
 *   - reading never does I/O — scrapes see the last completed sample.
 */
import { describe, expect, it } from 'vitest';
import { SystemSampler, type SystemSamplerOptions } from '../../../src/shared/metrics';

interface Fs {
  /** `undefined` is a file that does not exist. */
  files: Record<string, string | undefined>;
  reads: string[];
}

function stat(user: number, idle: number): string {
  return `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\n`;
}

function harness(
  overrides: Partial<SystemSamplerOptions> & { files?: Record<string, string | undefined> } = {},
) {
  const fs: Fs = {
    files: {
      '/proc/self/cgroup': '0::/\n',
      '/proc/self/mountinfo': '22 1 0:21 / /proc rw - proc proc rw\n',
      '/proc/stat': stat(0, 0),
      '/proc/loadavg': '2.00 1.00 0.50 1/100 1\n',
      '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
      '/proc/pressure/cpu': 'some avg10=5.00 avg60=4.00 avg300=1.00 total=1\n',
      '/proc/pressure/memory':
        'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
      '/proc/pressure/io':
        'some avg10=1.00 avg60=0.50 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
      '/sys/fs/cgroup/memory.current': '268435456\n',
      '/sys/fs/cgroup/memory.max': '536870912\n',
      '/sys/fs/cgroup/cpu.max': '200000 100000\n',
      '/sys/fs/cgroup/memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
      ...overrides.files,
    },
    reads: [],
  };
  let clockMicros = 0;
  let cpuMicros = 0;
  const sampler = new SystemSampler({
    platform: 'linux',
    readText: (path) => {
      fs.reads.push(path);
      return fs.files[path] ?? null;
    },
    exists: (path) => path === '/.dockerenv',
    monotonicMicros: () => clockMicros,
    processCpuMicros: () => cpuMicros,
    wallClock: () => new Date('2026-09-26T12:00:00.000Z'),
    availableParallelism: () => 8,
    hostCores: () => 8,
    ...overrides,
  });
  return {
    sampler,
    fs,
    advance(wallMicros: number, cpu: number) {
      clockMicros += wallMicros;
      cpuMicros += cpu;
    },
  };
}

describe('before a rate can exist', () => {
  it('reports nulls, not zeros, until the first sample', () => {
    const { sampler } = harness();
    const m = sampler.read();
    expect(m.sampledAt).toBeNull();
    expect(m.process.percentOfOneCore).toBeNull();
  });

  it('reports instantaneous readings after one sample, but no rates', () => {
    const { sampler } = harness();
    const m = sampler.sample();
    // Memory, load and pressure are point-in-time — available immediately.
    expect(m.host!.memory!.usedPercent).toBe(75);
    expect(m.host!.loadAverage!.one).toBe(2);
    // CPU is a rate and needs two readings; zero here would be a lie.
    expect(m.process.percentOfOneCore).toBeNull();
    expect(m.host!.cpu).toBeNull();
    expect(m.intervalMs).toBeNull();
  });
});

describe('process CPU', () => {
  it('measures CPU used over the wall-clock interval', () => {
    const h = harness();
    h.sampler.sample();
    h.advance(5_000_000, 1_000_000); // 1s of CPU in 5s of wall time
    const m = h.sampler.sample();
    expect(m.intervalMs).toBe(5000);
    expect(m.process.percentOfOneCore).toBe(20);
  });

  it('normalizes against the cgroup CPU quota when one is set', () => {
    // cpu.max = 2 cores. 1 core busy is half of what the container may use,
    // even though the host has 8 — the number that says how close the
    // container is to being throttled.
    const h = harness();
    h.sampler.sample();
    h.advance(1_000_000, 1_000_000);
    const m = h.sampler.sample();
    expect(m.process.availableCores).toBe(2);
    expect(m.process.percentOfOneCore).toBe(100);
    expect(m.process.percentOfAvailable).toBe(50);
  });

  it('falls back to schedulable cores without a quota', () => {
    const h = harness({ files: { '/sys/fs/cgroup/cpu.max': 'max 100000\n' } });
    h.sampler.sample();
    h.advance(1_000_000, 2_000_000);
    const m = h.sampler.sample();
    expect(m.process.availableCores).toBe(8);
    expect(m.process.percentOfOneCore).toBe(200);
    expect(m.process.percentOfAvailable).toBe(25);
  });
});

describe('host CPU', () => {
  it('computes utilization from successive /proc/stat readings', () => {
    const h = harness({ files: { '/proc/stat': stat(0, 0) } });
    h.sampler.sample();
    h.fs.files['/proc/stat'] = stat(300, 700);
    h.advance(5_000_000, 0);
    expect(h.sampler.sample().host!.cpu).toEqual({
      busyPercent: 30,
      iowaitPercent: 0,
      stealPercent: 0,
    });
  });

  it('reports load per core, so a reader need not know the core count', () => {
    const { sampler } = harness();
    expect(sampler.sample().host!.loadPerCore).toBe(0.25); // 2.00 / 8
  });

  it('reads pressure for all three resources', () => {
    const p = harness().sampler.sample().host!.pressure;
    expect(p.cpu!.someAvg10).toBe(5);
    expect(p.io!.someAvg10).toBe(1);
    expect(p.memory!.fullAvg10).toBe(0);
  });
});

describe('cgroup', () => {
  it('reports memory against the limit and the CPU quota', () => {
    const cg = harness().sampler.sample().cgroup!;
    expect(cg.path).toBe('/');
    expect(cg.memoryCurrentBytes).toBe(268_435_456);
    expect(cg.memoryLimitBytes).toBe(536_870_912);
    expect(cg.memoryPercentOfLimit).toBe(50);
    expect(cg.cpuLimitCores).toBe(2);
    expect(cg.oomKills).toBe(0);
  });

  it('reports no percentage when memory is unlimited', () => {
    const cg = harness({ files: { '/sys/fs/cgroup/memory.max': 'max\n' } }).sampler.sample()
      .cgroup!;
    expect(cg.memoryLimitBytes).toBeNull();
    // "50% of unlimited" is not a quantity.
    expect(cg.memoryPercentOfLimit).toBeNull();
  });

  it('resolves a nested cgroup path under /sys/fs/cgroup', () => {
    const path = '/system.slice/docker-abc.scope';
    const h = harness({
      files: {
        '/proc/self/cgroup': `0::${path}\n`,
        [`/sys/fs/cgroup${path}/memory.current`]: '1024\n',
      },
    });
    const cg = h.sampler.sample().cgroup!;
    expect(cg.path).toBe(path);
    expect(cg.memoryCurrentBytes).toBe(1024);
  });

  it('is null in the root cgroup, which has no limit files', () => {
    const h = harness({
      files: {
        '/sys/fs/cgroup/memory.current': undefined,
        '/sys/fs/cgroup/memory.max': undefined,
        '/sys/fs/cgroup/cpu.max': undefined,
      },
    });
    expect(h.sampler.sample().cgroup).toBeNull();
  });

  it('is null on cgroup v1', () => {
    const h = harness({ files: { '/proc/self/cgroup': '4:memory:/docker/abc\n' } });
    expect(h.sampler.sample().cgroup).toBeNull();
  });
});

describe('what the readings describe', () => {
  it('reports a container marker', () => {
    expect(harness().sampler.sample().containerized).toBe(true);
  });

  it('flags LXCFS, which makes "host" readings per-container', () => {
    const h = harness({
      files: {
        '/proc/self/mountinfo': '100 90 0:50 / /proc/meminfo rw - fuse.lxcfs lxcfs rw\n',
      },
    });
    expect(h.sampler.sample().hostViewVirtualized).toBe(true);
  });

  it('reports no host or cgroup off Linux rather than zeros', () => {
    const h = harness({ platform: 'darwin' });
    const m = h.sampler.sample();
    expect(m.host).toBeNull();
    expect(m.cgroup).toBeNull();
    expect(m.containerized).toBe(false);
  });
});

describe('reading', () => {
  it('does no I/O — a scrape returns the last completed sample', () => {
    const h = harness();
    h.sampler.sample();
    const readsAfterSample = h.fs.reads.length;
    h.sampler.read();
    h.sampler.read();
    expect(h.fs.reads.length).toBe(readsAfterSample);
  });

  it('gives every reader the same interval, however often it is read', () => {
    // The reason this is a sampler at all: two dashboards polling must not
    // shorten each other's measurement interval.
    const h = harness();
    h.sampler.sample();
    h.advance(5_000_000, 500_000);
    h.sampler.sample();
    const first = h.sampler.read().process.percentOfOneCore;
    const second = h.sampler.read().process.percentOfOneCore;
    expect(first).toBe(10);
    expect(second).toBe(first);
  });

  it('degrades a missing file to null for that reading only', () => {
    const h = harness({ files: { '/proc/meminfo': undefined } });
    const m = h.sampler.sample();
    expect(m.host!.memory).toBeNull();
    expect(m.host!.loadAverage).not.toBeNull();
  });
});

describe('lifecycle', () => {
  it('samples immediately on start and is idempotent', () => {
    const h = harness();
    h.sampler.start();
    h.sampler.start();
    expect(h.sampler.running).toBe(true);
    expect(h.sampler.read().sampledAt).not.toBeNull();
    h.sampler.stop();
    h.sampler.stop();
    expect(h.sampler.running).toBe(false);
  });
});

describe('the shared clock', () => {
  it('runs onSample at every sample, before its own readings', () => {
    const calls: string[] = [];
    const h = harness({
      onSample: () => calls.push('hook'),
      processCpuMicros: () => {
        calls.push('cpu');
        return 0;
      },
    });
    h.sampler.sample();
    h.sampler.sample();
    expect(calls).toEqual(['hook', 'cpu', 'hook', 'cpu']);
  });

  it('survives a throwing hook on the timer, reports it, and keeps the last sample', () => {
    // A throw on a timer reaches `uncaughtException`, which in this app exits.
    // Instrumentation must never be what takes the bot down.
    const errors: unknown[] = [];
    let fail = false;
    const h = harness({
      onSample: () => {
        if (fail) throw new Error('boom');
      },
      onError: (err) => errors.push(err),
    });
    h.sampler.start(); // first tick succeeds
    const good = h.sampler.read();
    fail = true;
    expect(() => (h.sampler as unknown as { tick(): void }).tick()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(h.sampler.read()).toBe(good);
    h.sampler.stop();
  });
});
