/**
 * Progress meters — XP and affection.
 *
 * **Every number rendered here comes from the API.** `WaifuProgress` is derived
 * by `collectionService.waifuProgress` on the server (pure arithmetic over a row
 * it already holds), so the Portal computes no XP curve, no level threshold and
 * no affection cap. The only arithmetic below is turning two numbers the API
 * gave us into a bar width, which is presentation (plan §16).
 */
import { Progress } from '@/components/ui/progress';
import type { PlayerProgress, WaifuProgress } from '@/api/types';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * What the bar can measure: an owned copy's progress, or the trainer's.
 *
 * The API gives the two the same fields on purpose, so one bar serves both and
 * neither curve is ever recomputed here. The union rather than a hand-written
 * minimum, because these are the only two shapes that exist and naming them
 * keeps the bar tied to the resources it draws.
 */
export type XpProgress = WaifuProgress | PlayerProgress;

export interface XpBarProps {
  progress: XpProgress;
  /** Hides the numeric caption for tight layouts. */
  compact?: boolean;
  /**
   * What this bar measures. Named because the Dashboard draws two of them —
   * the trainer's and her buddy's — and a screen reader hearing "experience to
   * next level" twice cannot tell which one it has landed on.
   */
  label?: string;
  className?: string;
}

export function XpBar({
  progress,
  compact = false,
  label = 'Experience',
  className,
}: XpBarProps) {
  const span = progress.xpIntoLevel + progress.xpToNext;
  const percent = progress.atMaxLevel || span <= 0 ? 100 : (progress.xpIntoLevel / span) * 100;

  return (
    <div className={cn('space-y-1.5', className)}>
      <Progress
        value={percent}
        aria-label={progress.atMaxLevel ? `${label}: max level` : `${label} to next level`}
      />
      {!compact && (
        <p className="tabular text-xs text-ink-subtle">
          {progress.atMaxLevel
            ? 'Max level'
            : `${formatNumber(progress.xpIntoLevel)} / ${formatNumber(span)} XP to level ${progress.level + 1}`}
        </p>
      )}
    </div>
  );
}

/**
 * Affection has no API-provided maximum, so the meter is scaled to 100 and the
 * raw value is always shown beside it — the number is the truth, the bar is a
 * hint. A real cap would be an API field, not a constant invented here.
 */
export function AffectionMeter({
  affection,
  className,
}: {
  affection: number;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-ink-muted">Affection</span>
        <span className="tabular text-xs text-ink">{formatNumber(affection)}</span>
      </div>
      <Progress
        value={Math.min(100, affection)}
        indicatorClassName="bg-[var(--rarity-ur)]"
        aria-label={`Affection: ${affection}`}
      />
    </div>
  );
}
