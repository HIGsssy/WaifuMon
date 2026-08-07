/**
 * EmptyState — illustrated, warm, never mistaken for an error (plan §17).
 *
 * The Portal is read-only, so almost every empty state ends in "do this in
 * Discord". `hint` carries that line; it is prose, not a button, because the
 * Portal has no gameplay actions to offer (§4).
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** e.g. "Head to Discord and try /waifumon hunt." */
  hint?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, hint, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-dashed border-border',
        'bg-surface/40 px-6 py-14 text-center sm:py-20',
        className,
      )}
    >
      <div className="mb-5 rounded-2xl border border-border bg-surface-raised p-4 text-ink-subtle">
        <Icon className="size-7" aria-hidden="true" />
      </div>
      <h2 className="font-display text-xl text-ink">{title}</h2>
      <p className="mt-2 max-w-sm text-sm text-ink-muted">{description}</p>
      {hint && <p className="mt-4 max-w-sm text-xs text-ink-subtle">{hint}</p>}
    </div>
  );
}
