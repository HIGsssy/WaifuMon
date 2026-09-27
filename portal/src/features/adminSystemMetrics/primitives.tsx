/**
 * Display primitives for System Metrics: a gauge, a sparkline, a level badge
 * and a label/value list.
 *
 * Hand-drawn SVG rather than a charting library. The Portal ships none, the
 * charts here are small and single-series, and a library would be the largest
 * dependency in the bundle to draw what a `<polyline>` does.
 *
 * Colour is never the only carrier of meaning (§17): every levelled reading also
 * renders its level as text, and every chart has a text description.
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

import type { SeriesPoint } from './metricsHistory';
import type { Assessment, Level } from './thresholds';

// ──────────────────────────────────────────────────────────────── Levels

const LEVEL_TEXT: Record<Level, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  critical: 'text-danger',
  neutral: 'text-accent',
};

const LEVEL_BADGE: Record<Exclude<Level, 'neutral'>, { label: string; className: string }> = {
  ok: { label: 'Healthy', className: 'border-success/40 bg-success-soft text-success' },
  warn: { label: 'Elevated', className: 'border-warning/40 bg-warning-soft text-warning' },
  critical: { label: 'Critical', className: 'border-danger/40 bg-danger-soft text-danger' },
};

function levelTextClass(level: Level): string {
  return LEVEL_TEXT[level];
}

/**
 * The level as a word. Renders nothing for `neutral` — an informational
 * reading has no verdict, and a "Normal" badge on it would imply one.
 */
export function LevelBadge({ assessment }: { assessment: Assessment }) {
  if (assessment.level === 'neutral') return null;
  const badge = LEVEL_BADGE[assessment.level];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        badge.className,
      )}
      title={assessment.reason}
      data-level={assessment.level}
    >
      {badge.label}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────── Gauge

export interface GaugeProps {
  title: string;
  /** The headline value, already formatted. */
  value: string;
  /** Fill, 0–1. Null draws an empty track. */
  fraction: number | null;
  assessment: Assessment;
  /** One line under the value: the numbers behind it. */
  caption?: ReactNode;
  /** Usually a sparkline. */
  children?: ReactNode;
  testId?: string;
}

/**
 * A semicircular meter. `role="meter"` with the value text, so assistive tech
 * reads "Event loop utilization, 42%" rather than an unlabelled graphic.
 */
export function Gauge({
  title,
  value,
  fraction,
  assessment,
  caption,
  children,
  testId,
}: GaugeProps) {
  const pct = fraction === null ? 0 : Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-ambient)]"
      data-testid={testId}
      data-level={assessment.level}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs font-medium tracking-wide text-ink-muted uppercase">{title}</h3>
        <LevelBadge assessment={assessment} />
      </div>
      <div
        role="meter"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={fraction === null ? `${value} (no scale)` : value}
        className="relative mx-auto w-full max-w-[11rem]"
      >
        <svg viewBox="0 0 100 56" className="w-full" aria-hidden="true">
          <path
            d="M8 50 A42 42 0 0 1 92 50"
            pathLength={100}
            fill="none"
            strokeWidth={8}
            strokeLinecap="round"
            className="stroke-surface-sunken"
          />
          {pct > 0 && (
            <path
              d="M8 50 A42 42 0 0 1 92 50"
              pathLength={100}
              fill="none"
              strokeWidth={8}
              strokeLinecap="round"
              strokeDasharray={`${pct} 100`}
              stroke="currentColor"
              className={cn(
                'transition-[stroke-dasharray] duration-500',
                levelTextClass(assessment.level),
              )}
            />
          )}
        </svg>
        <div className="absolute inset-x-0 bottom-0 text-center">
          <span className="font-mono text-xl font-semibold text-ink tabular-nums">{value}</span>
        </div>
      </div>
      {caption && <p className="text-center text-xs text-ink-muted tabular-nums">{caption}</p>}
      {assessment.level !== 'neutral' && (
        <p className="text-center text-xs text-ink-subtle">{assessment.reason}</p>
      )}
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────── Sparkline

export interface SparklineProps {
  points: readonly SeriesPoint[];
  /** The newest sample's time; the chart's right edge. */
  end: number;
  windowMs: number;
  /** Fixed ceiling (e.g. 100 for percent). Otherwise scaled to the series peak. */
  max?: number;
  /** Consecutive samples further apart than this are not joined. */
  gapMs: number;
  /** Dashed horizontal guides — e.g. the warn and critical lines. */
  guides?: ReadonlyArray<{ value: number; level: Level }>;
  level?: Level;
  /** Text equivalent of the chart, for screen readers. */
  label: string;
  className?: string;
}

const W = 200;
const H = 40;

/**
 * A single-series trend line.
 *
 * Null values and gaps longer than `gapMs` break the line rather than being
 * bridged: a stretch where the server could not be reached must look like a
 * stretch with no data, not like a smooth interpolation through it.
 */
export function Sparkline({
  points,
  end,
  windowMs,
  max,
  gapMs,
  guides = [],
  level = 'neutral',
  label,
  className,
}: SparklineProps) {
  const start = end - windowMs;
  const values = points.map((p) => p.v).filter((v): v is number => v !== null);
  const peak = values.length === 0 ? 0 : Math.max(...values);
  // Scaled to the data plus the *lowest* guide only. Including every guide
  // would let a distant critical line (1 s on loop delay) flatten a trend that
  // lives around 100 ms into the bottom few pixels. The first guide stays in
  // view as the reference; higher ones appear as the data climbs toward them.
  const lowestGuide = guides.length ? Math.min(...guides.map((g) => g.value)) : 0;
  const ceiling = max ?? Math.max(peak * 1.15, lowestGuide * 1.1, 1e-9);

  const x = (t: number) => ((t - start) / windowMs) * W;
  const y = (v: number) => H - Math.min(1, Math.max(0, v / ceiling)) * (H - 2) - 1;

  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  let lastT: number | null = null;
  for (const p of points) {
    if (p.t < start) continue;
    const gapped = lastT !== null && p.t - lastT > gapMs;
    if (p.v === null || gapped) {
      if (current.length > 0) segments.push(current);
      current = [];
    }
    if (p.v !== null) current.push([x(p.t), y(p.v)]);
    lastT = p.t;
  }
  if (current.length > 0) segments.push(current);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cn('h-10 w-full overflow-visible', levelTextClass(level), className)}
    >
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-border" strokeWidth={1} />
      {guides
        .filter((g) => g.value < ceiling)
        .map((g) => (
          <line
            key={`${g.level}-${g.value}`}
            x1={0}
            x2={W}
            y1={y(g.value)}
            y2={y(g.value)}
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            className={cn('opacity-60', levelTextClass(g.level))}
          />
        ))}
      {segments.map((seg, i) =>
        seg.length === 1 ? (
          <circle key={i} cx={seg[0]![0]} cy={seg[0]![1]} r={1.5} fill="currentColor" />
        ) : (
          <polyline
            key={i}
            points={seg.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ),
      )}
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────── StatList

export interface Stat {
  label: string;
  value: ReactNode;
  hint?: string;
}

/** A two-column definition list — the detail panels' basic layout. */
export function StatList({ stats, className }: { stats: readonly Stat[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm', className)}>
      {stats.map((s) => (
        <div key={s.label} className="contents">
          <dt className="text-ink-muted" title={s.hint}>
            {s.label}
          </dt>
          <dd className="text-right font-mono text-ink tabular-nums">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}
