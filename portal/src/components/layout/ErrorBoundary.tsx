/**
 * The global error boundary (plan §19).
 *
 * Catches render-time errors the query layer cannot — a bad hook order, a
 * malformed response that slipped past a hand-written type (§26 "hand-written
 * types drift"). Query failures never reach here: they surface as `isError` on
 * the owning component so one failing tile leaves the rest of the page intact.
 *
 * Errors log with the `[portal error]` marker §19 specifies, and in dev the
 * stack is rendered inline rather than hidden behind devtools.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { portalEnv } from '@/lib/env';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[portal error] unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-canvas px-6 text-center"
      >
        <h1 className="font-display text-2xl text-ink">Something went wrong</h1>
        <p className="max-w-md text-sm text-ink-muted">
          The Portal hit an error it could not recover from. Reloading usually clears it.
        </p>
        {portalEnv.isDev && (
          <pre className="max-h-64 max-w-2xl overflow-auto rounded-xl border border-border bg-surface-sunken p-4 text-left font-mono text-xs text-ink-muted">
            {error.stack ?? error.message}
          </pre>
        )}
        <Button variant="accent" onClick={() => window.location.reload()}>
          Reload the app
        </Button>
      </div>
    );
  }
}
