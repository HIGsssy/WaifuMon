/**
 * Skeleton — initial-load placeholder (plan §14).
 *
 * Skeletons appear only when a query has no cached data at all. Background
 * refreshes keep the previous content on screen instead, which is why nothing
 * in the Portal renders a spinner.
 */
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('skeleton rounded-md', className)}
      aria-hidden="true"
      data-testid="skeleton"
      {...props}
    />
  );
}
