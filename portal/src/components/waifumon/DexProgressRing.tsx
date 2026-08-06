/**
 * DexProgressRing — species discovery as a ring (plan §8.1).
 *
 * Every number is straight from `GET /collection/stats`; the only computation
 * is the ratio that becomes an arc length, which is presentation.
 *
 * The ring is `aria-hidden` and the figures are restated in text beside it, so
 * the progress is readable without seeing the graphic.
 */
import { formatPercent } from '@/lib/format';
import { cn } from '@/lib/cn';

export interface DexProgressRingProps {
  distinctSpecies: number;
  totalSpecies: number;
  size?: number;
  className?: string;
}

export function DexProgressRing({
  distinctSpecies,
  totalSpecies,
  size = 132,
  className,
}: DexProgressRingProps) {
  const fraction = totalSpecies > 0 ? Math.min(1, distinctSpecies / totalSpecies) : 0;
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true" className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-surface-sunken"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          stroke="var(--accent)"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className="transition-[stroke-dashoffset] duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="tabular text-2xl leading-none font-semibold text-ink">
          {formatPercent(fraction)}
        </span>
        <span className="tabular mt-1 text-xs text-ink-subtle">
          {distinctSpecies} / {totalSpecies}
        </span>
      </div>
    </div>
  );
}
