/**
 * Card — the Portal's default container.
 *
 * Generous padding and quiet borders by default (§17 "space over density").
 * `flush` drops the padding for cards whose first child is full-bleed artwork.
 */
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export function Card({
  className,
  flush = false,
  ...props
}: ComponentProps<'div'> & { flush?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-border bg-surface shadow-[var(--shadow-ambient)]',
        !flush && 'p-5 sm:p-6',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      className={cn('text-sm font-medium tracking-wide text-ink-muted uppercase', className)}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('space-y-3', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('mt-5 flex items-center gap-3 border-t border-border pt-4', className)}
      {...props}
    />
  );
}
