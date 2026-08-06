/**
 * A horizontally scrolling container that a keyboard can actually reach.
 *
 * A `overflow-x: auto` box whose contents hold no focusable elements is a trap
 * for keyboard and screen-reader users: the content scrolls, but nothing can
 * put focus inside it to do the scrolling. WCAG calls this out, and axe flags
 * it as `scrollable-region-focusable`.
 *
 * The fix is small and easy to forget, which is why it lives in a component:
 * make the region itself focusable and give it a name, so it becomes a tab stop
 * that responds to the arrow keys.
 *
 * Used for the Guide's tuning tables (plan §8.9), which are wider than a phone.
 */
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export interface ScrollableRegionProps extends ComponentProps<'div'> {
  /** Announced when focus lands on the region, e.g. "Capture charms table". */
  label: string;
}

export function ScrollableRegion({ label, className, ...props }: ScrollableRegionProps) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn('overflow-x-auto', className)}
      {...props}
    />
  );
}
