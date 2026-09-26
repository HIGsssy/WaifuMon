/**
 * Process memory and CPU, as this process can see them.
 *
 * RSS is the headline number, and the reason is documented in
 * `docs/card-rendering-deployment.md`: the production target shares 16 GB
 * between Postgres, the Discord gateway, Fastify and the card renderer, and the
 * repo's existing benchmark reports 193–218 MB peak main-thread RSS **excluding
 * the render workers' own heaps**. That exclusion is the gap this module is
 * here to close, so the worker threads are reported explicitly rather than
 * folded into a single figure that would understate the total.
 *
 * ## What `rss` does and does not include
 *
 * `process.memoryUsage().rss` is the resident set of the whole process, worker
 * threads included — threads share an address space. But `heapUsed` and
 * `heapTotal` are **per-isolate**, so they describe the main thread alone; a
 * card worker's V8 heap is inside `rss` and outside `heapUsed`. Reporting the
 * two side by side without saying so invites the reading that the difference is
 * native allocation, when part of it is another thread's JavaScript heap.
 * Hence `heapScope: 'main-thread'` in the payload — the field exists to stop a
 * reader drawing that conclusion.
 *
 * Sharp's decoded-image buffers and resvg's canvases are native, and land in
 * `external` / `arrayBuffers` rather than the JS heap. During a cold card burst
 * those are where the growth shows up, which makes `external` worth reporting
 * even though it is usually uninteresting.
 */
import { resourceUsage, memoryUsage, cpuUsage, uptime, version, pid } from 'node:process';

export interface MemoryMetrics {
  /**
   * Resident set size of the entire process, worker threads included.
   * The figure to compare against the host's RAM.
   */
  rssBytes: number;
  /** V8 heap, **main thread only** — see `heapScope`. */
  heapUsedBytes: number;
  heapTotalBytes: number;
  /** Native allocations bound to V8 — sharp buffers and resvg canvases land here. */
  externalBytes: number;
  arrayBuffersBytes: number;
  /**
   * Which isolate the heap figures describe. Constant, and present so the
   * `rss` / `heapUsed` gap is not misread as purely native allocation.
   */
  heapScope: 'main-thread';
}

export interface CpuMetrics {
  /** CPU time consumed since process start, all threads included. */
  userMs: number;
  systemMs: number;
  /**
   * Hard page faults and block I/O, from `getrusage`. A rising
   * `majorPageFaults` under memory pressure is the signal that the host has
   * started swapping, which on a 16 GB box shared with Postgres is the failure
   * mode worth catching early.
   */
  majorPageFaults: number;
  fsReads: number;
  fsWrites: number;
}

export interface ProcessMetrics {
  pid: number;
  nodeVersion: string;
  uptimeSeconds: number;
  memory: MemoryMetrics;
  cpu: CpuMetrics;
}

export function readProcessMetrics(): ProcessMetrics {
  const mem = memoryUsage();
  const cpu = cpuUsage();
  const usage = resourceUsage();

  return {
    pid,
    nodeVersion: version,
    uptimeSeconds: Math.round(uptime() * 1000) / 1000,
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers,
      heapScope: 'main-thread',
    },
    cpu: {
      // `cpuUsage` reports microseconds; milliseconds keep it in the same unit
      // as every latency figure in the payload.
      userMs: Math.round(cpu.user / 1000),
      systemMs: Math.round(cpu.system / 1000),
      majorPageFaults: usage.majorPageFault,
      fsReads: usage.fsRead,
      fsWrites: usage.fsWrite,
    },
  };
}
