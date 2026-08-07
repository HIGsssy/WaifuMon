/**
 * Presentation formatters. Nothing here computes a gameplay value — these turn
 * numbers and instants the API already returned into strings a human reads.
 */

const numberFormat = new Intl.NumberFormat(undefined);

/** Thousands-separated integer, e.g. `12,480`. */
export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/** Compact form for tight chips, e.g. `12.5K`. */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

/** `0`–`1` as a whole-percent string, clamped. */
export function formatPercent(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  return `${Math.round(clamped * 100)}%`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

/** Absolute calendar date, e.g. `6 Aug 2026`. Empty string for bad input. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** Relative instant, e.g. `3 days ago`. Falls back to the absolute date. */
export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const delta = date.getTime() - now.getTime();
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= ms) {
      return relativeFormat.format(Math.round(delta / ms), unit);
    }
  }
  return relativeFormat.format(Math.round(delta / 1000), 'second');
}

/** Milliseconds as a compact duration, for the diagnostics timing table. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Sentence-cases a lowercase content token like `demi-human` or `submissive`. */
export function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
