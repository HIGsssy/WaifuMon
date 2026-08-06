/**
 * Progress — a quiet horizontal meter (XP, affection).
 *
 * Built on Radix so the ARIA roles and value semantics are right without each
 * call site restating them.
 */
import * as ProgressPrimitive from '@radix-ui/react-progress';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export interface ProgressProps extends ComponentProps<typeof ProgressPrimitive.Root> {
  /** Percentage 0–100. */
  value?: number | null;
  /** Colour of the filled portion; defaults to the quiet accent. */
  indicatorClassName?: string;
}

export function Progress({ className, value, indicatorClassName, ...props }: ProgressProps) {
  // Rounded, not just clamped: Radix mirrors this into `aria-valuenow`, and a
  // screen reader announcing "28.571428 percent" helps nobody.
  const clamped = Math.round(Math.max(0, Math.min(100, value ?? 0)));
  return (
    <ProgressPrimitive.Root
      className={cn(
        'relative h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken',
        className,
      )}
      value={clamped}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full rounded-full bg-accent transition-[width] duration-500',
          indicatorClassName,
        )}
        style={{ width: `${clamped}%` }}
      />
    </ProgressPrimitive.Root>
  );
}
