import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink sm:h-9',
        'placeholder:text-ink-subtle',
        'focus-visible:border-accent focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
