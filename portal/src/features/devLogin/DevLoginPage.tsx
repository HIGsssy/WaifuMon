/**
 * The developer login screen — dev builds only.
 *
 * Reached at `/select-player`, which is where `RequireSession` already sends an
 * unresolved session; a dev build renders this in place of the production env
 * fallback (see `SelectPlayerPage`). No new route, and nothing here is reachable
 * from a production bundle.
 *
 * What it is: two snowflake fields and a submit, resolving through the Platform
 * API's existing `GET /players/lookup`. What it is not: provisioning. A pair
 * that has never played gets an explanation, not a new player — the Portal
 * stays read-only, and this screen is the one place where that distinction is
 * easy to blur.
 *
 * A restored session (the common case: reload, second tab, Monday morning)
 * redirects straight through. Only a *fresh* sign-in pauses on the confirmation
 * card, because that is the moment where knowing which account you just became
 * is worth a click.
 */
import { KeyRound, LogIn, UserCheck } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { DevPlayerNotFoundError } from '@/auth/dev/DevLoginSessionProvider';
import { isSnowflake } from '@/auth/dev/devIdentity';
import { useDevAuth } from '@/auth/dev/useDevAuth';
import { describeSessionError } from '@/auth/describeSessionError';
import { useSession } from '@/auth/useSession';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { portalEnv } from '@/lib/env';

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  autoFocus = false,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        placeholder="000000000000000000"
        className="font-mono"
        // Dev-only screen whose entire purpose is typing an id — landing in the
        // field is the behaviour, not an accessibility slip.
        autoFocus={autoFocus}
      />
      <p className="text-xs text-ink-subtle">{hint}</p>
    </div>
  );
}

export function DevLoginPage() {
  const { lastIdentity, signIn } = useDevAuth();
  const { status, session, error } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [userId, setUserId] = useState(
    () => lastIdentity?.discordUserId ?? portalEnv.defaultDiscordUserId ?? '',
  );
  const [guildId, setGuildId] = useState(
    () => lastIdentity?.discordGuildId ?? portalEnv.defaultDiscordGuildId ?? '',
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  /**
   * What this screen is doing, which a resolved session alone cannot say:
   *
   *   auto     nobody asked to be here — a restored session redirects straight
   *            through, an unresolved one falls to the form
   *   confirm  a sign-in was just submitted; show who it resolved to
   *   form     the form was asked for explicitly ("Choose someone else"), so a
   *            working session must not redirect out from under it
   */
  const [mode, setMode] = useState<'auto' | 'confirm' | 'form'>('auto');

  const returnTo = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  // A session that was already good on arrival — a stale bookmark, or the
  // ordinary restore — should not strand anyone on a login form.
  if (mode === 'auto' && status === 'ready') return <Navigate to={returnTo} replace />;
  if (mode === 'auto' && status === 'loading') {
    return (
      <Shell
        icon={<KeyRound className="size-5" aria-hidden="true" />}
        title="Developer login"
        subtitle="Restoring the session this browser remembers…"
      >
        <Skeleton className="h-24 rounded-xl" />
      </Shell>
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const user = userId.trim();
    const guild = guildId.trim() || (portalEnv.defaultDiscordGuildId ?? '');

    if (!isSnowflake(user)) {
      setInvalid('A Discord user ID is a run of digits — use “Copy User ID” in Discord.');
      return;
    }
    if (guild.length === 0) {
      setInvalid(
        'No guild to search. Enter a Discord server ID, or set VITE_DEFAULT_DISCORD_GUILD_ID ' +
          'in portal/.env.local so this field pre-fills.',
      );
      return;
    }
    if (!isSnowflake(guild)) {
      setInvalid(
        'A Discord server ID is a run of digits — right-click the server → Copy Server ID.',
      );
      return;
    }

    setInvalid(null);
    setMode('confirm');
    signIn({ discordUserId: user, discordGuildId: guild });
  }

  // ── Signed in: who you now are, before the Portal takes over ──────────────
  if (mode === 'confirm' && status === 'ready' && session) {
    return (
      <Shell
        icon={<UserCheck className="size-5" aria-hidden="true" />}
        title="Signed in"
        subtitle="This is the account the Portal will show."
      >
        <dl className="space-y-3 rounded-xl border border-border bg-surface-sunken p-4 text-sm">
          <Row term="Discord display name" value={session.displayName} />
          <Row term="Internal player ID" value={`#${session.playerId}`} />
          <Row term="Discord user ID" value={session.discordUserId ?? '—'} />
          <Row term="Discord server ID" value={session.discordGuildId ?? '—'} />
        </dl>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setMode('form')}>
            Choose someone else
          </Button>
          <Button variant="accent" onClick={() => void navigate(returnTo, { replace: true })}>
            Enter the Portal
          </Button>
        </div>
      </Shell>
    );
  }

  const notFound = error instanceof DevPlayerNotFoundError ? error : null;
  const described = notFound ? null : describeSessionError(error);
  const busy = status === 'loading';

  return (
    <Shell
      icon={<KeyRound className="size-5" aria-hidden="true" />}
      title="Developer login"
      subtitle="Pick the player this Portal acts as."
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field
          id="dev-login-user"
          label="Discord user ID"
          hint="Required. The tester whose collection you want to see."
          value={userId}
          onChange={setUserId}
          autoFocus
        />
        <Field
          id="dev-login-guild"
          label="Discord server ID"
          hint={
            portalEnv.defaultDiscordGuildId
              ? 'Optional — pre-filled from VITE_DEFAULT_DISCORD_GUILD_ID.'
              : 'Which server’s save to open. A player exists per server.'
          }
          value={guildId}
          onChange={setGuildId}
        />

        {invalid && (
          <p role="alert" className="text-sm text-danger">
            {invalid}
          </p>
        )}

        {notFound && (
          <div
            role="alert"
            className="rounded-xl border border-border bg-surface-sunken p-4 text-sm"
          >
            <p className="font-medium text-ink">This Discord account hasn’t played here yet</p>
            <p className="mt-1 text-ink-muted">
              No Waifumon player exists for user{' '}
              <code className="font-mono text-ink">{notFound.identity.discordUserId}</code> on
              server <code className="font-mono text-ink">{notFound.identity.discordGuildId}</code>.
              Players are created the first time someone plays in Discord — the Portal never creates
              one.
            </p>
          </div>
        )}

        {described && (
          <div
            role="alert"
            className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm"
          >
            <p className="font-medium text-ink">{described.headline}</p>
            <p className="mt-1 text-ink-muted">{described.detail}</p>
          </div>
        )}

        <div className="flex justify-end">
          <Button type="submit" variant="accent" disabled={busy}>
            <LogIn aria-hidden="true" />
            {busy ? 'Looking up…' : 'Continue'}
          </Button>
        </div>
      </form>

      <p className="mt-6 border-t border-border pt-4 text-xs text-ink-subtle">
        Development convenience only. The choice is remembered in this browser and never leaves it;
        a production build has no login screen and no player switcher.
      </p>
    </Shell>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-ink-muted">{term}</dt>
      <dd className="font-mono text-ink">{value}</dd>
    </div>
  );
}

function Shell({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center py-10 sm:py-16">
      <Card className="w-full">
        <div className="mb-5 flex items-center gap-3">
          <div className="rounded-xl border border-border bg-surface-raised p-2.5 text-ink-subtle">
            {icon}
          </div>
          <div>
            <h1 className="font-display text-xl text-ink">{title}</h1>
            <p className="text-sm text-ink-muted">{subtitle}</p>
          </div>
        </div>
        {children}
      </Card>
    </div>
  );
}
