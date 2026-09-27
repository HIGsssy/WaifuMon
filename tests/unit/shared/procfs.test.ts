/**
 * The procfs / cgroup parsers and the rate arithmetic, against fixture text.
 *
 * The malformed and sentinel cases matter as much as the happy path. On a real
 * host they arrive as an older kernel, a cgroup v1 layout, or an unlimited
 * cgroup — and the failure mode is never an exception, it is a plausible-looking
 * number: a "16 EiB" memory limit, a negative CPU percentage, a healthy host
 * reported as out of memory because `MemFree` was read instead of `MemAvailable`.
 */
import { describe, expect, it } from 'vitest';
import {
  cpuUtilizationBetween,
  detectLxcfs,
  parseCgroupBytes,
  parseCgroupPath,
  parseCpuMax,
  parseLoadavg,
  parseMeminfo,
  parseOomKills,
  parsePressure,
  parseProcStat,
  processCpuPercent,
  type CpuTimes,
} from '../../../src/shared/metrics/procfs';

const STAT = `cpu  1000 50 400 8000 200 10 40 300 0 0
cpu0 500 25 200 4000 100 5 20 150 0 0
intr 12345
`;

describe('parseProcStat', () => {
  it('reads the aggregate line, ignoring per-core lines and guest columns', () => {
    expect(parseProcStat(STAT)).toEqual({
      user: 1000,
      nice: 50,
      system: 400,
      idle: 8000,
      iowait: 200,
      irq: 10,
      softirq: 40,
      steal: 300,
    });
  });

  it('returns null rather than zeros for text it cannot read', () => {
    expect(parseProcStat('')).toBeNull();
    expect(parseProcStat('cpu 1 2 3')).toBeNull(); // too few fields
    expect(parseProcStat('cpu a b c d e f g h')).toBeNull();
  });
});

describe('cpuUtilizationBetween', () => {
  const base: CpuTimes = {
    user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0,
  };

  it('splits the interval into busy, iowait and steal', () => {
    // 1000 ticks elapsed: 500 busy (user+system), 300 idle, 100 iowait, 100 steal.
    const next = { ...base, user: 400, system: 100, idle: 300, iowait: 100, steal: 100 };
    expect(cpuUtilizationBetween(base, next)).toEqual({
      // Steal counts as not-idle time the VM wanted but did not get, so it is
      // inside "busy" from the kernel's accounting — and also reported alone.
      busyPercent: 60,
      iowaitPercent: 10,
      stealPercent: 10,
    });
  });

  it('does not count iowait as busy', () => {
    // A host waiting on disk is idle cores, not busy ones; folding it into busy
    // would make an I/O-bound machine look CPU-bound.
    const next = { ...base, idle: 500, iowait: 500 };
    expect(cpuUtilizationBetween(base, next)).toMatchObject({ busyPercent: 0, iowaitPercent: 50 });
  });

  it('is null when the counters did not advance', () => {
    expect(cpuUtilizationBetween(base, base)).toBeNull();
  });

  it('is null rather than negative when a counter went backwards', () => {
    const prev = { ...base, idle: 1000, user: 100 };
    const next = { ...base, idle: 900, user: 400 };
    expect(cpuUtilizationBetween(prev, next)).toBeNull();
  });
});

describe('parseMeminfo', () => {
  const MEMINFO = `MemTotal:       16000000 kB
MemFree:          500000 kB
MemAvailable:    8000000 kB
Buffers:          100000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
`;

  it('reports used as total minus MemAvailable, not total minus MemFree', () => {
    const m = parseMeminfo(MEMINFO)!;
    expect(m.totalBytes).toBe(16_000_000 * 1024);
    expect(m.availableBytes).toBe(8_000_000 * 1024);
    // 50%, not the ~97% that MemFree would suggest for a host with a warm cache.
    expect(m.usedPercent).toBe(50);
    expect(m.usedBytes).toBe(8_000_000 * 1024);
  });

  it('reports swap in use', () => {
    const m = parseMeminfo(MEMINFO)!;
    expect(m.swapTotalBytes).toBe(2_000_000 * 1024);
    expect(m.swapUsedBytes).toBe(500_000 * 1024);
  });

  it('refuses to guess without MemAvailable', () => {
    expect(parseMeminfo('MemTotal: 1000 kB\nMemFree: 10 kB\n')).toBeNull();
  });

  it('treats absent swap lines as no swap', () => {
    const m = parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 500 kB\n')!;
    expect(m.swapTotalBytes).toBe(0);
    expect(m.swapUsedBytes).toBe(0);
  });
});

describe('parseLoadavg', () => {
  it('reads the three averages', () => {
    expect(parseLoadavg('1.50 0.75 0.25 2/345 6789\n')).toEqual({
      one: 1.5,
      five: 0.75,
      fifteen: 0.25,
    });
  });

  it('is null for garbage', () => {
    expect(parseLoadavg('')).toBeNull();
    expect(parseLoadavg('a b c')).toBeNull();
  });
});

describe('parsePressure', () => {
  it('reads both some and full', () => {
    const text = `some avg10=12.50 avg60=8.25 avg300=4.00 total=123456
full avg10=1.00 avg60=0.50 avg300=0.10 total=654
`;
    expect(parsePressure(text)).toEqual({
      someAvg10: 12.5,
      someAvg60: 8.25,
      fullAvg10: 1,
      fullAvg60: 0.5,
    });
  });

  it('allows a missing full line, as older kernels report for CPU', () => {
    expect(parsePressure('some avg10=3.00 avg60=2.00 avg300=1.00 total=9\n')).toEqual({
      someAvg10: 3,
      someAvg60: 2,
      fullAvg10: null,
      fullAvg60: null,
    });
  });

  it('is null when PSI is not available', () => {
    expect(parsePressure('')).toBeNull();
  });
});

describe('cgroup v2', () => {
  it('finds the unified-hierarchy path', () => {
    expect(parseCgroupPath('0::/\n')).toBe('/');
    expect(parseCgroupPath('0::/system.slice/docker-abc.scope\n')).toBe(
      '/system.slice/docker-abc.scope',
    );
  });

  it('declines cgroup v1, which has per-controller lines', () => {
    expect(parseCgroupPath('12:memory:/docker/abc\n11:cpu,cpuacct:/docker/abc\n')).toBeNull();
  });

  it('reads a byte count, and "max" as no limit', () => {
    expect(parseCgroupBytes('536870912\n')).toBe(536_870_912);
    expect(parseCgroupBytes('max\n')).toBeNull();
  });

  it('treats the 2^63-ish unlimited sentinel as no limit, not 8 EiB', () => {
    // What cgroup v1 and `process.constrainedMemory()` report for "unlimited".
    expect(parseCgroupBytes('9223372036854771712')).toBeNull();
  });

  it('converts a CPU quota to cores', () => {
    expect(parseCpuMax('150000 100000\n')).toBe(1.5);
    expect(parseCpuMax('200000 100000')).toBe(2);
    expect(parseCpuMax('max 100000\n')).toBeNull();
    expect(parseCpuMax('')).toBeNull();
  });

  it('reads the OOM kill count', () => {
    expect(parseOomKills('low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n')).toBe(1);
    expect(parseOomKills('low 0\n')).toBeNull();
  });
});

describe('detectLxcfs', () => {
  it('spots an LXCFS mount over /proc', () => {
    const mountinfo =
      '100 90 0:50 / /proc/meminfo rw,nosuid - fuse.lxcfs lxcfs rw,user_id=0\n';
    expect(detectLxcfs(mountinfo)).toBe(true);
  });

  it('is false for an ordinary mount table', () => {
    expect(detectLxcfs('22 1 0:21 / /proc rw - proc proc rw\n')).toBe(false);
  });
});

describe('processCpuPercent', () => {
  it('reports CPU time as a share of wall time, per core', () => {
    // 250ms of CPU in 1s of wall time: a quarter of one core.
    expect(processCpuPercent(0, 250_000, 1_000_000)).toBe(25);
  });

  it('exceeds 100 when worker threads use more than one core', () => {
    // The card renderer's threads are counted by process.cpuUsage(). Capping
    // at 100 would hide exactly the burst this reading exists to show.
    expect(processCpuPercent(0, 1_800_000, 1_000_000)).toBe(180);
  });

  it('is null for a zero or negative interval, or a counter that went backwards', () => {
    expect(processCpuPercent(0, 100, 0)).toBeNull();
    expect(processCpuPercent(500, 100, 1_000_000)).toBeNull();
  });
});
