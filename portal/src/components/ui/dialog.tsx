/**
 * Dialog — a centred modal.
 *
 * The same Radix primitive `sheet.tsx` already uses, laid out in the middle of
 * the viewport instead of against an edge. Radix supplies the focus trap,
 * Escape handling, outside-click dismissal and the scroll lock, so this is
 * positioning and nothing else.
 *
 * `DialogTitle` is required by Radix for accessibility. A dialog whose visible
 * design has no heading should still render one and hide it with `sr-only`
 * rather than omitting it — Radix warns, and screen readers get nothing.
 */
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Accessible label for the close button. */
  closeLabel?: string;
}

export function DialogContent({
  className,
  children,
  closeLabel = 'Close',
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out" />
      <DialogPrimitive.Content
        className={cn(
          // Centred without translate maths: a grid whose single cell is the
          // dialog, so tall content shrinks to the viewport instead of
          // overflowing off the top where it cannot be scrolled back to.
          'fixed inset-0 z-50 grid place-items-center p-4 outline-none sm:p-6',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="fixed top-4 right-4 rounded-md bg-surface/80 p-2 text-ink-subtle shadow-sm backdrop-blur transition-colors hover:bg-surface-raised hover:text-ink"
          aria-label={closeLabel}
        >
          <X className="size-5" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
