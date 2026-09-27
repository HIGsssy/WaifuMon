/**
 * Current CPU, memory and pressure for the process, the host and the cgroup.
 *
 * ## Why a sampler, and not a calculation at scrape time
 *
 * CPU utilization is a *rate*: CPU time used divided by wall time elapsed. The
 * existing `process.cpu` counters are cumulative since start, and dividing them
 * by uptime gives a lifetime average that barely moves during a load spike —
 * the reason those counters cannot be shown as "load".
 *
 * A rate needs two readings. Computing it "since the last scrape" would make the
 * answer depend on who is scraping: two dashboards open at once would each see
 * the interval shortened by the other, and a `curl` from a shell would corrupt
 * both. So the rate is measured here, on a fixed interval of its own, and every
 * caller reads the same last-completed interval. Scraping is O(1), does no I/O
 * on the request path, and gives the same answer to everyone.
 *
 * ## The shared clock
 *
 * The same reasoning applies to every "right now" figure, not just CPU: the
 * HTTP recorder's recent latency and the event-loop monitor's recent delay
 * each need an interval boundary, and those boundaries must not be set by
 * whoever happens to be reading. So this sampler is the one clock: `onSample`
 * fires at each tick, and the host wires it to those collectors'
 * `rotateRecent()`. Every "recent" reading in a report then describes the same
 * interval, reported once as `intervalMs`.
 *
 * ## Cost
 *
 * One timer every 5 s, `unref`'d so it never holds the process open, reading
 * nine small procfs/cgroupfs files synchronously — tens of microseconds, off the
 * request path. That is the same order as the event-loop monitor's own timer.
 *
 * ## What each reading describes
 *
 * See `procfs.ts` for the full story. In one line each:
 *   process   this Node process, every thread included
 *   host      the kernel-global view — the physical machine, even in Docker,
 *             unless LXCFS virtualizes it (`hostViewVirtualized`)
 *   cgroup    this process's cgroup — under Docker, the container's limits
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
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
  type CpuUtilization,
  type HostMemory,
  type LoadAverage,
  type Pressure,
} from './procfs';

export const DEFAULT_SYSTEM_SAMPLE_INTERVAL_MS = 5_000;

export interface ProcessCpu {
  /** CPU used over the last interval, as % of one core. May exceed 100. */
  percentOfOneCore: number | null;
  /**
   * The same, as % of the CPU this process can actually get: the cgroup quota
   * when one is set, otherwise the cores it may be scheduled on. 0–100.
   */
  percentOfAvailable: number | null;
  /** The denominator used for `percentOfAvailable`, so the reader can check it. */
  availableCores: number;
}

export interface HostReadings {
  /** Logical CPUs the kernel reports for the whole machine. */
  cores: number;
  cpu: CpuUtilization | null;
  loadAverage: LoadAverage | null;
  /** `loadAverage.one / cores`. Above 1.0, runnable work exceeds cores. */
  loadPerCore: number | null;
  memory: HostMemory | null;
  pressure: {
    cpu: Pressure | null;
    memory: Pressure | null;
    io: Pressure | null;
  };
}

export interface CgroupReadings {
  /** From `/proc/self/cgroup`; `/` under a private cgroup namespace. */
  path: string;
  /** All memory charged to the cgroup — RSS *plus* page cache it owns. */
  memoryCurrentBytes: number | null;
  /** Hard limit; null when unlimited. Exceeding it triggers the OOM killer. */
  memoryLimitBytes: number | null;
  /** Null when there is no limit — a percentage of "unlimited" is meaningless. */
  memoryPercentOfLimit: number | null;
  /** Cores' worth of CPU quota; null when unlimited. */
  cpuLimitCores: number | null;
  /** Tasks the kernel has OOM-killed in this cgroup. Should be 0, always. */
  oomKills: number | null;
}

export interface SystemMetrics {
  /** When the last completed sample was taken. Null before the first. */
  sampledAt: string | null;
  /** Wall time the reported rates were measured over. Null until two samples exist. */
  intervalMs: number | null;
  platform: NodeJS.Platform;
  /** A container marker file was found (`/.dockerenv` or `/run/.containerenv`). */
  containerized: boolean;
  /**
   * LXCFS is mounted over `/proc`. When true, the `host` readings describe the
   * container rather than the physical machine and must not be labelled host.
   */
  hostViewVirtualized: boolean;
  process: ProcessCpu;
  /** Null off Linux, where none of these sources exist. */
  host: HostReadings | null;
  /** Null off Linux, on cgroup v1, or when the cgroup directory is unreadable. */
  cgroup: CgroupReadings | null;
}

/** Filesystem seam. Returns null for a missing or unreadable file, never throws. */
export type ReadText = (path: string) => string | null;

export interface SystemSamplerOptions {
  intervalMs?: number;
  readText?: ReadText;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  /** Cumulative process CPU (user + system) in microseconds. */
  processCpuMicros?: () => number;
  /** Monotonic clock, microseconds. */
  monotonicMicros?: () => number;
  wallClock?: () => Date;
  /** Cores this process may be scheduled on. */
  availableParallelism?: () => number;
  hostCores?: () => number;
  /**
   * Runs at every tick, before this sampler's own readings, so collectors that
   * rotate on it close their interval at the same instant CPU is measured.
   */
  onSample?: () => void;
  /**
   * Reports a tick that threw. The tick runs on a timer, where an uncaught
   * throw would reach the process's `uncaughtException` handler — which in this
   * application exits. Instrumentation must never be what takes the bot down,
   * so a failed tick is reported here and the previous sample is kept.
   */
  onError?: (err: unknown) => void;
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

interface RawSample {
  monotonicMicros: number;
  processCpuMicros: number;
  hostCpu: CpuTimes | null;
}

export class SystemSampler {
  private readonly intervalMs: number;
  private readonly readText: ReadText;
  private readonly platform: NodeJS.Platform;
  private readonly processCpuMicros: () => number;
  private readonly monotonicMicros: () => number;
  private readonly wallClock: () => Date;
  private readonly availableParallelism: () => number;
  private readonly hostCores: () => number;
  private readonly onSample: (() => void) | undefined;
  private readonly onError: ((err: unknown) => void) | undefined;
  private readonly containerized: boolean;
  private readonly hostViewVirtualized: boolean;
  /** Resolved once: a process does not change cgroup during its life. */
  private readonly cgroupDir: string | null;
  private readonly cgroupPath: string | null;

  private timer: NodeJS.Timeout | undefined;
  private previous: RawSample | undefined;
  private latest: SystemMetrics;

  constructor(options: SystemSamplerOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SYSTEM_SAMPLE_INTERVAL_MS;
    this.readText = options.readText ?? defaultReadText;
    this.platform = options.platform ?? process.platform;
    this.processCpuMicros =
      options.processCpuMicros ??
      (() => {
        const u = process.cpuUsage();
        return u.user + u.system;
      });
    this.monotonicMicros =
      options.monotonicMicros ?? (() => Number(process.hrtime.bigint() / 1000n));
    this.wallClock = options.wallClock ?? (() => new Date());
    this.availableParallelism = options.availableParallelism ?? (() => os.availableParallelism());
    this.hostCores = options.hostCores ?? (() => os.cpus().length);
    this.onSample = options.onSample;
    this.onError = options.onError;

    const exists = options.exists ?? existsSync;
    const linux = this.platform === 'linux';
    this.containerized = linux && (exists('/.dockerenv') || exists('/run/.containerenv'));
    this.hostViewVirtualized = linux && detectLxcfs(this.readText('/proc/self/mountinfo') ?? '');

    const path = linux ? parseCgroupPath(this.readText('/proc/self/cgroup') ?? '') : null;
    this.cgroupPath = path;
    this.cgroupDir = path === null ? null : `/sys/fs/cgroup${path === '/' ? '' : path}`;

    this.latest = this.emptyMetrics();
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Takes a first sample now and then one per interval. Idempotent. */
  start(): void {
    if (this.timer !== undefined) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** A guarded `sample()`: see `onError`. */
  private tick(): void {
    try {
      this.sample();
    } catch (err) {
      this.onError?.(err);
    }
  }

  /** The last completed sample. Never does I/O. */
  read(): SystemMetrics {
    return this.latest;
  }

  /**
   * Takes one sample. Public so tests can drive it deterministically instead of
   * waiting on the timer; the application never calls it directly.
   */
  sample(): SystemMetrics {
    this.onSample?.();
    const raw: RawSample = {
      monotonicMicros: this.monotonicMicros(),
      processCpuMicros: this.processCpuMicros(),
      hostCpu: this.isLinux() ? parseProcStat(this.readText('/proc/stat') ?? '') : null,
    };
    const prev = this.previous;
    this.previous = raw;

    const elapsed = prev === undefined ? null : raw.monotonicMicros - prev.monotonicMicros;
    const cgroup = this.readCgroup();
    const availableCores = cgroup?.cpuLimitCores ?? this.availableParallelism();

    const oneCore =
      prev === undefined || elapsed === null
        ? null
        : processCpuPercent(prev.processCpuMicros, raw.processCpuMicros, elapsed);

    this.latest = {
      sampledAt: this.wallClock().toISOString(),
      intervalMs: elapsed === null ? null : Math.round(elapsed / 1000),
      platform: this.platform,
      containerized: this.containerized,
      hostViewVirtualized: this.hostViewVirtualized,
      process: {
        percentOfOneCore: oneCore,
        percentOfAvailable:
          oneCore === null || !(availableCores > 0)
            ? null
            : Math.min(100, Math.round((oneCore / availableCores) * 100) / 100),
        availableCores,
      },
      host: this.readHost(prev?.hostCpu ?? null, raw.hostCpu),
      cgroup,
    };
    return this.latest;
  }

  private isLinux(): boolean {
    return this.platform === 'linux';
  }

  private readHost(prevCpu: CpuTimes | null, nextCpu: CpuTimes | null): HostReadings | null {
    if (!this.isLinux()) return null;
    const cores = this.hostCores();
    const loadAverage = parseLoadavg(this.readText('/proc/loadavg') ?? '');
    const pressure = (resource: string) =>
      parsePressure(this.readText(`/proc/pressure/${resource}`) ?? '');
    return {
      cores,
      cpu: prevCpu !== null && nextCpu !== null ? cpuUtilizationBetween(prevCpu, nextCpu) : null,
      loadAverage,
      loadPerCore:
        loadAverage === null || !(cores > 0)
          ? null
          : Math.round((loadAverage.one / cores) * 100) / 100,
      memory: parseMeminfo(this.readText('/proc/meminfo') ?? ''),
      // Absent on kernels built without CONFIG_PSI; reported as null, not zero.
      pressure: { cpu: pressure('cpu'), memory: pressure('memory'), io: pressure('io') },
    };
  }

  private readCgroup(): CgroupReadings | null {
    if (this.cgroupDir === null || this.cgroupPath === null) return null;
    const file = (name: string) => this.readText(`${this.cgroupDir}/${name}`);

    const current = file('memory.current');
    const max = file('memory.max');
    const cpuMax = file('cpu.max');
    // The root cgroup has none of these files. That is a bare-metal process in
    // the root slice, or a container sharing the host cgroup namespace — either
    // way there is no cgroup-level reading to give.
    if (current === null && max === null && cpuMax === null) return null;

    const memoryCurrentBytes = current === null ? null : parseCgroupBytes(current);
    const memoryLimitBytes = max === null ? null : parseCgroupBytes(max);
    const events = file('memory.events');
    return {
      path: this.cgroupPath,
      memoryCurrentBytes,
      memoryLimitBytes,
      memoryPercentOfLimit:
        memoryCurrentBytes === null || memoryLimitBytes === null || memoryLimitBytes === 0
          ? null
          : Math.round((memoryCurrentBytes / memoryLimitBytes) * 10_000) / 100,
      cpuLimitCores: cpuMax === null ? null : parseCpuMax(cpuMax),
      oomKills: events === null ? null : parseOomKills(events),
    };
  }

  private emptyMetrics(): SystemMetrics {
    return {
      sampledAt: null,
      intervalMs: null,
      platform: this.platform,
      containerized: this.containerized,
      hostViewVirtualized: this.hostViewVirtualized,
      process: { percentOfOneCore: null, percentOfAvailable: null, availableCores: 0 },
      host: null,
      cgroup: null,
    };
  }
}
