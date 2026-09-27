/**
 * Parsers and rate arithmetic for Linux `/proc` and cgroup v2 files.
 *
 * Pure functions over file *contents*, never over paths: nothing here touches
 * the filesystem. `systemSampler.ts` does the reading, which is what lets every
 * calculation below be tested against fixture text — including the malformed
 * and absent cases, which on a real host arrive as a missing file or an
 * unexpected kernel version rather than as a thrown error.
 *
 * ## Which of these describe the physical host
 *
 * This is the part most likely to be misread, so it is stated once, here, and
 * the payload carries a `scope` on every group so a reader never has to know it.
 *
 * `/proc/stat`, `/proc/meminfo`, `/proc/loadavg` and `/proc/pressure/*` are
 * **kernel-global**. Linux does not namespace them, so inside a Docker
 * container they report the *whole machine* — every core, all RAM, the load
 * from Postgres and every other container. That is exactly what a capacity test
 * wants from a "host" reading, and it is the opposite of what `docker stats`
 * shows. The one exception is LXCFS, a FUSE filesystem some hosts mount over
 * these files to fake per-container values; the sampler detects it and says so.
 *
 * `/sys/fs/cgroup/*` is the **cgroup's** view — under Docker's default private
 * cgroup namespace, the container's own limits and usage. Those are reported as
 * `cgroup`, never as host.
 *
 * Node's `os` module reads the same kernel-global sources (`os.totalmem`,
 * `os.loadavg`, `os.cpus`), so it has the same host semantics — with two traps
 * that are why this file reads `/proc` directly instead: `os.freemem()` returns
 * `MemAvailable`, not `MemFree`, which its name does not suggest; and
 * `process.constrainedMemory()` returns 2^64 rather than `undefined` when there
 * is no limit, a sentinel that would render as 16 EiB.
 */

/** Anything at or above this is the kernel's "no limit" and not a real byte count. */
export const UNLIMITED_BYTES_THRESHOLD = 2 ** 62;

// ─────────────────────────────────────────────────────────────── /proc/stat

/**
 * Aggregate CPU time from the first line of `/proc/stat`, in USER_HZ ticks.
 *
 * Only ratios of these are ever reported, so the tick unit cancels out and the
 * value of USER_HZ (almost always 100) never needs to be known.
 */
export interface CpuTimes {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (line === undefined) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal [guest guest_nice]. Guest
  // time is already included in user/nice, so counting it again would
  // double-count a VM host's guests; it is deliberately ignored.
  if (fields.length < 8 || fields.slice(0, 8).some((n) => !Number.isFinite(n))) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields as [
    number, number, number, number, number, number, number, number,
  ];
  return { user, nice, system, idle, iowait, irq, softirq, steal };
}

export interface CpuUtilization {
  /** Non-idle, non-iowait share of all CPU time, 0–100, across every core. */
  busyPercent: number;
  /**
   * Time a core sat idle *waiting on disk*, 0–100. Not busy — but a high value
   * is the classic sign of an I/O-bound host, which is why it is reported
   * separately rather than folded into either side.
   */
  iowaitPercent: number;
  /**
   * Time the hypervisor gave this VM's vCPUs to someone else, 0–100. Zero on
   * bare metal. On a shared VPS, a non-zero steal under load means the machine
   * is slower than its core count says — directly relevant to sizing.
   */
  stealPercent: number;
}

/**
 * Utilization between two samples.
 *
 * Null when the counters did not advance (two reads inside one tick) or went
 * backwards (a counter reset, which should not happen but would otherwise
 * produce a negative percentage that looks like a measurement).
 */
export function cpuUtilizationBetween(prev: CpuTimes, next: CpuTimes): CpuUtilization | null {
  const total = (t: CpuTimes) =>
    t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal;
  const dTotal = total(next) - total(prev);
  if (!(dTotal > 0)) return null;
  const dIdle = next.idle - prev.idle;
  const dIowait = next.iowait - prev.iowait;
  const dSteal = next.steal - prev.steal;
  if (dIdle < 0 || dIowait < 0 || dSteal < 0) return null;
  const pct = (n: number) => round2((n / dTotal) * 100);
  return {
    busyPercent: clampPercent(pct(dTotal - dIdle - dIowait)),
    iowaitPercent: clampPercent(pct(dIowait)),
    stealPercent: clampPercent(pct(dSteal)),
  };
}

// ────────────────────────────────────────────────────────────── /proc/meminfo

export interface HostMemory {
  totalBytes: number;
  /**
   * `MemAvailable` — the kernel's own estimate of memory a new workload could
   * use without swapping, page cache it can drop included. The honest "free"
   * figure. `MemFree` alone would report a healthy host with a warm page cache
   * as nearly out of memory.
   */
  availableBytes: number;
  /** `total - available`: memory genuinely spoken for. */
  usedBytes: number;
  usedPercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export function parseMeminfo(text: string): HostMemory | null {
  const kib = (key: string): number | null => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kib('MemTotal');
  const available = kib('MemAvailable');
  // MemAvailable has existed since Linux 3.14. Without it there is no honest
  // "used" figure to report, and a guess from MemFree would be misleading.
  if (total === null || available === null || total <= 0) return null;
  const swapTotal = kib('SwapTotal') ?? 0;
  const swapFree = kib('SwapFree') ?? 0;
  const used = Math.max(0, total - available);
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: used,
    usedPercent: round2((used / total) * 100),
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

// ────────────────────────────────────────────────────────────── /proc/loadavg

export interface LoadAverage {
  one: number;
  five: number;
  fifteen: number;
}

export function parseLoadavg(text: string): LoadAverage | null {
  const [one, five, fifteen] = text.trim().split(/\s+/).map(Number);
  if (![one, five, fifteen].every((n) => Number.isFinite(n))) return null;
  return { one: one as number, five: five as number, fifteen: fifteen as number };
}

// ───────────────────────────────────────────────────────── /proc/pressure/*

/**
 * Pressure Stall Information for one resource.
 *
 * `some` is the share of wall time in which **at least one** runnable task was
 * stalled waiting on the resource; `full` is the share in which **every**
 * non-idle task was. Both are percentages the kernel computes itself, averaged
 * over 10 and 60 seconds.
 *
 * This is the reading that answers the question CPU% cannot: a host at 100% CPU
 * with near-zero CPU `some` is busy but not contended, while one at 60% with a
 * high `some` has work queueing for cores. It is also the cheapest honest disk
 * I/O signal available without `iostat`.
 */
export interface Pressure {
  someAvg10: number;
  someAvg60: number;
  /** Null for CPU on kernels that do not report a `full` line for it. */
  fullAvg10: number | null;
  fullAvg60: number | null;
}

export function parsePressure(text: string): Pressure | null {
  const line = (kind: 'some' | 'full') => {
    const m = text.match(new RegExp(`^${kind}\\s+avg10=([\\d.]+)\\s+avg60=([\\d.]+)`, 'm'));
    return m ? { avg10: Number(m[1]), avg60: Number(m[2]) } : null;
  };
  const some = line('some');
  if (some === null) return null;
  const full = line('full');
  return {
    someAvg10: some.avg10,
    someAvg60: some.avg60,
    fullAvg10: full?.avg10 ?? null,
    fullAvg60: full?.avg60 ?? null,
  };
}

// ──────────────────────────────────────────────────────────────── cgroup v2

/**
 * The cgroup this process belongs to, from `/proc/self/cgroup`.
 *
 * cgroup v2 has a single `0::<path>` line. Under Docker's default private
 * cgroup namespace the path is `/` and `/sys/fs/cgroup` *is* the container's
 * cgroup; on a bare host it is a systemd slice. Null for cgroup v1, which has
 * per-controller lines and a different file layout that is not supported here.
 */
export function parseCgroupPath(text: string): string | null {
  const m = text.match(/^0::(\/.*)$/m);
  return m ? (m[1] as string).trim() : null;
}

/** `memory.max` / `memory.current`: a byte count, or null for `max` (no limit). */
export function parseCgroupBytes(text: string): number | null {
  const value = text.trim();
  if (value === '' || value === 'max') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n >= UNLIMITED_BYTES_THRESHOLD) return null;
  return n;
}

/**
 * `cpu.max` → how many cores' worth of CPU time the cgroup may use.
 *
 * The file is `<quota> <period>` in microseconds, or `max <period>` for no
 * limit. A quota of 150000 over a 100000 period is 1.5 cores.
 */
export function parseCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (quota === undefined || quota === 'max') return null;
  const q = Number(quota);
  const p = Number(period);
  if (!(q > 0) || !(p > 0)) return null;
  return round2(q / p);
}

/** `oom_kill` from `memory.events`: times the kernel killed a task in this cgroup. */
export function parseOomKills(text: string): number | null {
  const m = text.match(/^oom_kill\s+(\d+)$/m);
  return m ? Number(m[1]) : null;
}

/**
 * Whether `/proc` is virtualized by LXCFS.
 *
 * LXCFS bind-mounts FUSE files over `/proc/meminfo`, `/proc/stat` and friends so
 * a container sees its own limits there. When it is present, readings this
 * module would otherwise label "host" are per-container, and the payload must
 * say so rather than claim to describe the physical machine.
 */
export function detectLxcfs(mountinfo: string): boolean {
  return /\blxcfs\b/.test(mountinfo);
}

// ─────────────────────────────────────────────────────────────── process CPU

/**
 * The process's CPU use between two samples, as a percentage of **one core**.
 *
 * Deliberately not capped at 100: a Node process with busy worker threads (the
 * card renderer) can legitimately use more than one core, and `process.
 * cpuUsage()` counts every thread. 180% means "nearly two cores".
 */
export function processCpuPercent(
  prevCpuMicros: number,
  nextCpuMicros: number,
  elapsedMicros: number,
): number | null {
  if (!(elapsedMicros > 0)) return null;
  const used = nextCpuMicros - prevCpuMicros;
  if (used < 0) return null;
  return round2((used / elapsedMicros) * 100);
}

// ─────────────────────────────────────────────────────────────────── helpers

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, n));
}
