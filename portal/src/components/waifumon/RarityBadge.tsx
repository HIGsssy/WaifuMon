/**
 * RarityBadge — rarity stated in words as well as colour (plan §17).
 *
 * Accessibility rule, not a style choice: "rarity meaning is never colour-alone
 * — the badge always names the rarity". The tier code (`SR`) is the loud part;
 * the full label (`Super Rare`) is what gets announced, so a screen reader
 * hears something meaningful rather than two letters.
 *
 * That announcement is carried by visually-hidden text rather than an
 * `aria-label`. A bare `<span>` has no ARIA role, and `aria-label` on a roleless
 * element is prohibited — assistive tech is free to ignore it, and axe flags it
 * as a serious violation. Hidden text works everywhere and needs no role.
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
        backgroundColor: `color-mix(in oklch, var(${style.cssVar}) 10%, transparent)`,
      }}
    >
      {/* Announced, never seen. The visible glyphs below are decorative. */}
      <span className="sr-only">Rarity: {style.label}</span>
      <span aria-hidden="true">{rarity}</span>
      {variant === 'full' && (
        <span aria-hidden="true" className="font-medium normal-case opacity-80">
          {style.label}
        </span>
      )}
    </span>
  );
}
