/**
 * Badge — small labelled chip.
 *
 * Rarity badges are built on this but live in `components/waifumon/` so the
 * rarity vocabulary stays in one place (§17).
 */
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-border bg-surface-raised text-ink-muted',
        outline: 'border-border-strong bg-transparent text-ink-muted',
        solid: 'border-transparent bg-surface-sunken text-ink',
        danger: 'border-danger/40 bg-danger-soft text-danger',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
