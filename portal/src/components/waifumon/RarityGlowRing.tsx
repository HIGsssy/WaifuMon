/**
 * RarityGlowRing — the border treatment that makes a grid read as a collection
 * rather than a table (plan §8.2, §17).
 *
 * Purely decorative: rarity is always *also* named by a `RarityBadge` on the
 * same card, so nothing here carries meaning a colour-blind or screen-reader
 * user would miss.
 *
 * The ring is painted immediately, before the artwork loads, which is what lets
 * a skeleton grid still read as "Collection" (§8.2 loading state).
 *
 * LR is the one iridescent tier — a conic gradient rather than a flat hue.
 */
import type { ReactNode } from 'react';

import { rarityStyle } from '@/lib/rarity';
import { cn } from '@/lib/cn';

export interface RarityGlowRingProps {
  rarity: string;
  children: ReactNode;
  /** Adds an outer bloom — used on hero art, not on grid tiles. */
  glow?: boolean;
  className?: string;
}

export function RarityGlowRing({ rarity, children, glow = false, className }: RarityGlowRingProps) {
  const style = rarityStyle(rarity);

  if (style.iridescent) {
    return (
      <div
        aria-hidden={false}
        className={cn('relative rounded-2xl p-px', className)}
        style={{
          background:
            'conic-gradient(from 140deg, oklch(0.78 0.16 20), oklch(0.8 0.15 90), ' +
            'oklch(0.79 0.16 190), oklch(0.76 0.17 300), oklch(0.78 0.16 20))',
          ...(glow ? { boxShadow: '0 0 32px -8px oklch(0.79 0.16 190 / 0.55)' } : {}),
        }}
      >
        <div className="overflow-hidden rounded-[calc(1rem-1px)] bg-surface">{children}</div>
      </div>
    );
  }

  return (
    <div
      className={cn('relative overflow-hidden rounded-2xl border bg-surface', className)}
      style={{
        borderColor: `color-mix(in oklch, var(${style.cssVar}) 40%, transparent)`,
        ...(glow
          ? {
              boxShadow: `0 0 32px -10px color-mix(in oklch, var(${style.cssVar}) 70%, transparent)`,
            }
          : {}),
      }}
    >
      {children}
    </div>
  );
}
