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
  /**
   * Admin screens: show *why* alongside the title — the server's own message,
   * its error code and the HTTP status — in every build, not only in dev. An
   * admin who sees "Could not load artwork" needs to know whether that was a
   * 403, a 404 from a server that has not been updated, or a 500. Inline only.
   */
  showReason?: boolean;
  className?: string;
}

interface Described {
  message: string;
  code: string | null;
  offline: boolean;
  /** HTTP status; null for a transport failure or a non-API error. */
  status: number | null;
  requestId: string | null;
}

function describe(error: unknown): Described {
  if (isPortalApiError(error)) {
    // The offline glyph is for *unreachable*, not for slow: a timeout gets the
    // ordinary warning icon because the connection is fine and retrying is the
    // obvious next move.
    return {
      message: error.message,
      code: error.code,
      offline: error.isNetworkError,
      status: error.status > 0 ? error.status : null,
      requestId: error.requestId ?? null,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, code: null, offline: false, status: null, requestId: null };
  }
  return {
    message: 'Something went wrong.',
    code: null,
    offline: false,
    status: null,
    requestId: null,
  };
}

export function ErrorState({
  error,
  onRetry,
  variant = 'block',
  title,
  showReason = false,
  className,
}: ErrorStateProps) {
  const { message, code, offline, status, requestId } = describe(error);
  const reason = [
    code,
    status !== null ? `HTTP ${status}` : null,
    requestId ? `request ${requestId}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
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
        <span className="min-w-0 flex-1 text-ink">
          {title ?? message}
          {showReason && title && title !== message && (
            <span className="block text-xs text-ink-muted" data-testid="error-reason">
              {message}
            </span>
          )}
        </span>
        {showReason
          ? reason && (
              <code className="font-mono text-xs text-ink-subtle" data-testid="error-code">
                {reason}
              </code>
            )
          : portalEnv.isDev &&
            code && <code className="font-mono text-xs text-ink-subtle">{code}</code>}
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
