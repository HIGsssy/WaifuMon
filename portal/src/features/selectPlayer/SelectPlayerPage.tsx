/**
 * `/select-player` — where `RequireSession` sends an unresolved session.
 *
 * One route, two screens, chosen at compile time:
 *
 *   dev builds   the developer login form — pick a player by Discord id and
 *                the Portal resolves it through `GET /players/lookup`
 *   otherwise    the env fallback below: a diagnostic card reporting the
 *                current `VITE_DEFAULT_PLAYER_ID`, the resolution error, and
 *                what to edit (plan §8.11)
 *
 * `import.meta.env.DEV` is substituted before bundling, so the production build
 * folds this to the fallback and drops `features/devLogin/` entirely — the
 * login screen is absent from the output, not merely unlinked.
 *
 * The fallback is deliberately **not** a picker: adding an id box there would
 * quietly become the auth surface the plan says a shipped build must not grow.
 * Runtime switching is a development convenience, and it lives on the other
 * side of this branch.
 */
import { KeyRound, LogIn, RefreshCw } from 'lucide-react';
import { Navigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { describeSessionError } from '@/auth/describeSessionError';
import { useSession } from '@/auth/useSession';
import { DevLoginPage } from '@/features/devLogin/DevLoginPage';

export function SelectPlayerPage() {
  if (import.meta.env.DEV) return <DevLoginPage />;
  return <EnvFallbackScreen />;
}

function EnvFallbackScreen() {
  const { status, error, retry, eligibleGuilds, noProfile, selectGuild } = useSession();

  // Arriving here with a working session (a stale bookmark, a resolved retry)
  // should not strand the developer on a diagnostic screen.
  if (status === 'ready') return <Navigate to="/dashboard" replace />;

  const described = describeSessionError(error);
  const hasGuildChoices = (eligibleGuilds?.length ?? 0) > 1;

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center py-10 sm:py-16">
      <Card className="w-full">
        <div className="mb-5 flex items-center gap-3">
          <div className="rounded-xl border border-border bg-surface-raised p-2.5 text-ink-subtle">
            <KeyRound className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="font-display text-xl text-ink">
              {noProfile ? 'No Waifumon profile found' : hasGuildChoices ? 'Choose a server' : 'Sign in'}
            </h1>
            <p className="text-sm text-ink-muted">
              {noProfile
                ? 'Play Waifumon in Discord first, then come back here.'
                : hasGuildChoices
                  ? 'Pick which Waifumon server to view.'
                  : 'Use Discord to open your Waifumon Portal.'}
            </p>
          </div>
        </div>

        {hasGuildChoices && (
          <div className="space-y-2">
            {eligibleGuilds?.map((guild) => (
              <Button
                key={guild.discordGuildId}
                variant="outline"
                className="w-full justify-start"
                onClick={() => void selectGuild?.(guild.discordGuildId)}
              >
                {guild.name ?? `Discord server ${guild.discordGuildId}`}
              </Button>
            ))}
          </div>
        )}

        {described && (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm"
          >
            <p className="font-medium text-ink">{described.headline}</p>
            <p className="mt-1 text-ink-muted">{described.detail}</p>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          {!hasGuildChoices && !noProfile && (
            <Button asChild>
              <a href="/auth/discord">
                <LogIn aria-hidden="true" />
                Sign in with Discord
              </a>
            </Button>
          )}
          <Button variant="outline" onClick={retry} className="ml-2">
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      </Card>
    </div>
  );
}
