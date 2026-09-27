/**
 * Formatters for operational readings. The shared `@/lib/format` covers game
 * values; these cover bytes, latencies and uptimes, which nothing else in the
 * Portal displays.
 */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Binary units, since that is what the kernel and `docker stats` report. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Latency: sub-millisecond precision where it matters, seconds past 1 s. */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** A value already in percent (0–100, or beyond for multi-core CPU). */
export function formatPct(percent: number | null | undefined, digits = 0): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return '—';
  return `${percent.toFixed(digits)}%`;
}

/** A 0–1 fraction as percent. */
export function formatFraction(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  return `${Math.round(fraction * 100)}%`;
}

export function formatRate(perSecond: number | null | undefined): string {
  if (perSecond === null || perSecond === undefined || !Number.isFinite(perSecond)) return '—';
  return `${perSecond < 10 ? perSecond.toFixed(1) : Math.round(perSecond)}/s`;
}

/** `3d 4h`, `2h 15m`, `4m 10s`, `12s`. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** How long ago, coarsely: `just now`, `12s ago`, `3m ago`. */
export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 2_000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(undefined).format(n);
}

/** A polling interval in words: `5 seconds`, `1 second`, `250 ms`. */
export function formatInterval(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  return `${s} ${s === 1 ? 'second' : 'seconds'}`;
}
