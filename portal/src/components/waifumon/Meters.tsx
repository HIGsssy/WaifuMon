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
import type { WaifuProgress } from '@/api/types';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';

export interface XpBarProps {
  progress: WaifuProgress;
  /** Hides the numeric caption for tight layouts. */
  compact?: boolean;
  className?: string;
}

export function XpBar({ progress, compact = false, className }: XpBarProps) {
  const span = progress.xpIntoLevel + progress.xpToNext;
  const percent = progress.atMaxLevel || span <= 0 ? 100 : (progress.xpIntoLevel / span) * 100;

  return (
    <div className={cn('space-y-1.5', className)}>
      <Progress
        value={percent}
        aria-label={progress.atMaxLevel ? 'Experience: max level' : 'Experience to next level'}
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
