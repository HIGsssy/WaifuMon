/**
 * PageHeader — the one place a page states what it is.
 *
 * Rendered as soon as the route changes, before any query resolves, so
 * navigation always paints something immediately (§14: "never replace an entire
 * page with a loading indicator").
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Toolbar, filters, counts — anything right-aligned on desktop. */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('mb-6 sm:mb-8', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-2xl leading-tight text-ink sm:text-3xl">{title}</h1>
          {description && (
            <p className="mt-1.5 max-w-prose text-sm text-ink-muted">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
