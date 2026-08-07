/**
 * Currency and energy tiles (plan §8.1).
 *
 * Energy shows the **current value only**. The Dashboard deliberately has no
 * regeneration countdown: the regen rate lives in `tables.energy` and turning
 * it into "full in 42 minutes" would be gameplay arithmetic in a React
 * component — exactly what §16 forbids. If a countdown is wanted, the API
 * should return `energyFullAt`.
 */
import { Coins, Sparkle, Zap, type LucideIcon } from 'lucide-react';

import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';

export type CurrencyKind = 'energy' | 'waifubux' | 'essence';

interface CurrencyMeta {
  label: string;
  icon: LucideIcon;
  cssVar: string;
}

const META: Record<CurrencyKind, CurrencyMeta> = {
  energy: { label: 'Energy', icon: Zap, cssVar: '--currency-energy' },
  waifubux: { label: 'WaifuBux', icon: Coins, cssVar: '--currency-waifubux' },
  essence: { label: 'Essence', icon: Sparkle, cssVar: '--currency-essence' },
};

/** The large Dashboard tile. */
export function CurrencyTile({
  kind,
  value,
  caption,
  className,
}: {
  kind: CurrencyKind;
  value: number;
  caption?: string;
  className?: string;
}) {
  const meta = META[kind];
  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-2xl border border-border bg-surface p-4 sm:p-5',
        className,
      )}
    >
      <div
        className="rounded-xl p-2.5"
        style={{
          color: `var(${meta.cssVar})`,
          backgroundColor: `color-mix(in oklch, var(${meta.cssVar}) 14%, transparent)`,
        }}
      >
        <meta.icon className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="text-xs tracking-wide text-ink-muted uppercase">{meta.label}</p>
        <p className="tabular text-2xl leading-tight font-semibold text-ink">
          {formatNumber(value)}
        </p>
        {caption && <p className="text-xs text-ink-subtle">{caption}</p>}
      </div>
    </div>
  );
}

/** The inline chip, for prices and compact rows. */
export function CurrencyChip({
  kind,
  value,
  className,
}: {
  kind: CurrencyKind;
  value: number;
  className?: string;
}) {
  const meta = META[kind];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs',
        className,
      )}
      style={{ color: `var(${meta.cssVar})` }}
    >
      <meta.icon className="size-3" aria-hidden="true" />
      <span className="tabular font-medium">{formatNumber(value)}</span>
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}
