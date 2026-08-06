/**
 * RarityBadge — rarity stated in words as well as colour (plan §17).
 *
 * Accessibility rule, not a style choice: "rarity meaning is never colour-alone
 * — the badge always names the rarity". The tier code (`SR`) is the loud part;
 * the full label (`Super Rare`) is the accessible name, so a screen reader
 * announces something meaningful rather than two letters.
 */
import { rarityStyle } from '@/lib/rarity';
import { cn } from '@/lib/cn';

export interface RarityBadgeProps {
  rarity: string;
  /** `code` shows the tier only; `full` adds the readable label beside it. */
  variant?: 'code' | 'full';
  className?: string;
}

export function RarityBadge({ rarity, variant = 'code', className }: RarityBadgeProps) {
  const style = rarityStyle(rarity);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-xs font-semibold tracking-wide whitespace-nowrap uppercase',
        className,
      )}
      style={{
        color: `var(${style.cssVar})`,
        borderColor: `color-mix(in oklch, var(${style.cssVar}) 45%, transparent)`,
        backgroundColor: `color-mix(in oklch, var(${style.cssVar}) 12%, transparent)`,
      }}
      // The visible text may be just "SR"; the label is what gets announced.
      aria-label={`Rarity: ${style.label}`}
    >
      <span aria-hidden="true">{rarity}</span>
      {variant === 'full' && (
        <span aria-hidden="true" className="font-medium normal-case opacity-80">
          {style.label}
        </span>
      )}
    </span>
  );
}
