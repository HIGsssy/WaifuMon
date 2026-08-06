/**
 * ErrorState — the Portal's single error presentation (plan §19).
 *
 * Two densities, one component:
 *   `inline`  a compact banner for one failing tile among many, so the rest of
 *             the page still renders (§19 "partial responses")
 *   `block`   a full panel when the page has nothing else to show
 *
 * `error.code` is rendered in dev builds only — it is a machine-readable value
 * that helps a developer and means nothing to a player. The message shown is
 * always the API's `userMessage`, which the API documents as safe to display.
 */
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';

import { isPortalApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { portalEnv } from '@/lib/env';

export interface ErrorStateProps {
  error: unknown;
  /** Usually TanStack Query's `refetch`. */
  onRetry?: () => void;
  variant?: 'inline' | 'block';
  /** Overrides the derived message — e.g. "Couldn't load your buddy." */
  title?: string;
  className?: string;
}

interface Described {
  message: string;
  code: string | null;
  offline: boolean;
}

function describe(error: unknown): Described {
  if (isPortalApiError(error)) {
    return { message: error.message, code: error.code, offline: error.isNetworkError };
  }
  if (error instanceof Error) {
    return { message: error.message, code: null, offline: false };
  }
  return { message: 'Something went wrong.', code: null, offline: false };
}

export function ErrorState({
  error,
  onRetry,
  variant = 'block',
  title,
  className,
}: ErrorStateProps) {
  const { message, code, offline } = describe(error);
  const Icon = offline ? WifiOff : AlertTriangle;

  if (variant === 'inline') {
    return (
      <div
        role="alert"
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm',
          className,
        )}
      >
        <Icon className="size-4 shrink-0 text-danger" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-ink">{title ?? message}</span>
        {portalEnv.isDev && code && (
          <code className="font-mono text-xs text-ink-subtle">{code}</code>
        )}
        {onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Retry
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-border bg-surface px-6 py-14 text-center',
        className,
      )}
    >
      <div className="mb-5 rounded-2xl border border-danger/30 bg-danger-soft p-4 text-danger">
        <Icon className="size-7" aria-hidden="true" />
      </div>
      <h2 className="font-display text-xl text-ink">
        {title ?? (offline ? "Can't reach the Waifumon server" : 'Something went wrong')}
      </h2>
      <p className="mt-2 max-w-sm text-sm text-ink-muted">{message}</p>
      {portalEnv.isDev && code && (
        <code className="mt-3 rounded bg-surface-sunken px-2 py-1 font-mono text-xs text-ink-subtle">
          {code}
        </code>
      )}
      {onRetry && (
        <Button variant="outline" className="mt-6" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}
