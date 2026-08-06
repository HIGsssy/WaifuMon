/**
 * Button — shadcn/ui pattern, Portal palette.
 *
 * There is deliberately no bright "primary" variant: §17 forbids a saturated
 * button competing with the artwork. The loudest thing here is `accent`, a
 * desaturated rose used for the one or two genuinely primary actions per page
 * (retry, reload). Rarity owns every strong colour in the UI.
 */
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ' +
    'transition-colors outline-none disabled:pointer-events-none disabled:opacity-50 ' +
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-surface-raised text-ink border border-border hover:bg-surface-sunken',
        accent: 'bg-accent text-accent-ink hover:opacity-90',
        ghost: 'text-ink-muted hover:bg-surface-raised hover:text-ink',
        outline: 'border border-border-strong text-ink hover:bg-surface-raised',
        danger: 'border border-danger/40 bg-danger-soft text-danger hover:bg-danger/15',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        // ≥44px hit targets on touch, tightened from `sm` up (§18).
        default: 'h-11 px-4 py-2 sm:h-9',
        sm: 'h-11 rounded-md px-3 text-xs sm:h-8',
        lg: 'h-12 rounded-lg px-6',
        icon: 'size-11 sm:size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
