/**
 * `/select-player` — the dev-only fallback screen (plan §8.11).
 *
 * Shown when `VITE_DEFAULT_PLAYER_ID` is missing or does not resolve. It is a
 * diagnostic card, not a picker: it reports the current env value and the
 * resolution error, and says what to edit.
 *
 * **No input field, no runtime picker.** Runtime switching is §25.2 — adding an
 * id box here would quietly become the auth surface the plan says v1 must not
 * grow.
 */
import { KeyRound, RefreshCw } from 'lucide-react';
import { Navigate } from 'react-router';

import { isPortalApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useSession } from '@/auth/useSession';
import { portalEnv } from '@/lib/env';

function describeError(error: unknown): { headline: string; detail: string } | null {
  if (error === null || error === undefined) return null;

  if (isPortalApiError(error)) {
    if (error.isNetworkError) {
      return {
        headline: "Can't reach the Waifumon server",
        detail:
          'The Platform API did not answer. Check that the bot is running with ' +
          'PLATFORM_API_ENABLED=true and that VITE_PLATFORM_API_PROXY_TARGET points at its port.',
      };
    }
    if (error.isUnauthorized) {
      return {
        headline: 'The Platform API rejected the token',
        detail: 'VITE_PLATFORM_API_TOKEN must match PLATFORM_API_TOKEN in the bot’s .env exactly.',
      };
    }
    if (error.isNotFound) {
      return {
        headline: 'No player with that id',
        detail:
          'The id resolved to nothing. Find a real one with /waifumon in Discord, or query the ' +
          'API’s GET /api/v1/players/lookup with a Discord guild and user id.',
      };
    }
    return { headline: error.message, detail: `${error.code} (HTTP ${error.status})` };
  }

  if (error instanceof Error) {
    return { headline: 'The configured player id is not usable', detail: error.message };
  }
  return { headline: 'Session could not be resolved', detail: String(error) };
}

export function SelectPlayerPage() {
  const { status, configuredPlayerId, error, retry } = useSession();

  // Arriving here with a working session (a stale bookmark, a resolved retry)
  // should not strand the developer on a diagnostic screen.
  if (status === 'ready') return <Navigate to="/dashboard" replace />;

  const described = describeError(error);

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center py-10 sm:py-16">
      <Card className="w-full">
        <div className="mb-5 flex items-center gap-3">
          <div className="rounded-xl border border-border bg-surface-raised p-2.5 text-ink-subtle">
            <KeyRound className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="font-display text-xl text-ink">No player selected</h1>
            <p className="text-sm text-ink-muted">The Portal needs to know who it is showing.</p>
          </div>
        </div>

        <dl className="space-y-3 rounded-xl border border-border bg-surface-sunken p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-ink-muted">VITE_DEFAULT_PLAYER_ID</dt>
            <dd className="font-mono text-ink">
              {configuredPlayerId ?? <span className="text-ink-subtle">unset</span>}
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-ink-muted">VITE_PLATFORM_API_URL</dt>
            <dd className="font-mono text-ink">{portalEnv.apiUrl}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-ink-muted">VITE_PLATFORM_API_TOKEN</dt>
            <dd className="font-mono text-ink">
              {portalEnv.apiToken ? '••••••••' : <span className="text-ink-subtle">unset</span>}
            </dd>
          </div>
        </dl>

        {described && (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm"
          >
            <p className="font-medium text-ink">{described.headline}</p>
            <p className="mt-1 text-ink-muted">{described.detail}</p>
          </div>
        )}

        <div className="mt-6 rounded-xl border border-border p-4 text-sm text-ink-muted">
          <p>
            Set <code className="font-mono text-ink">VITE_DEFAULT_PLAYER_ID</code> in{' '}
            <code className="font-mono text-ink">portal/.env.local</code> and reload.
          </p>
          <p className="mt-2 text-xs text-ink-subtle">
            There is no runtime player switcher in v1 — selecting a player is an env edit plus a
            reload, by design.
          </p>
        </div>

        <div className="mt-5 flex justify-end">
          <Button variant="outline" onClick={retry}>
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      </Card>
    </div>
  );
}
