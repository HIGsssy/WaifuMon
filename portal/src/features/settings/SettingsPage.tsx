/**
 * `/settings` — theme, session context and build information.
 *
 * Development keeps an explicit warning about the local player picker and
 * shared bearer token. Production uses Discord OAuth, so it shows the signed-in
 * identity instead of the retired pre-OAuth warning.
 */
import { Info, Moon, ShieldAlert, Sun } from 'lucide-react';

import { useTheme } from '@/app/useTheme';
import { useCurrentSession } from '@/auth/useSession';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { SwitchPlayerButton } from '@/features/devLogin/SwitchPlayerButton';
import { portalEnv } from '@/lib/env';
import { cn } from '@/lib/cn';

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const session = useCurrentSession();

  const options = [
    { value: 'dark', label: 'Dark', icon: Moon, hint: 'Designed for the artwork.' },
    { value: 'light', label: 'Light', icon: Sun, hint: 'Higher contrast in daylight.' },
  ] as const;

  return (
    <>
      <PageHeader title="Settings" description="Theme, and what this build is." />

      <div className="max-w-2xl space-y-6">
        <Card>
          <CardTitle>Appearance</CardTitle>
          <p className="mt-3 text-sm text-ink-muted">
            The Portal opens dark by default — the palette is built so key art reads as illuminated.
            Your choice is remembered in this browser.
          </p>
          <div
            role="radiogroup"
            aria-label="Colour theme"
            className="mt-4 grid gap-3 sm:grid-cols-2"
          >
            {options.map((option) => {
              const selected = theme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTheme(option.value)}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                    selected
                      ? 'border-accent bg-accent-soft/40'
                      : 'border-border hover:border-border-strong',
                  )}
                >
                  <option.icon
                    className={cn(
                      'mt-0.5 size-4 shrink-0',
                      selected ? 'text-accent' : 'text-ink-subtle',
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{option.label}</span>
                    <span className="block text-sm text-ink-muted">{option.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Card>

        {import.meta.env.DEV ? (
          <Card>
            <div className="flex items-start gap-3">
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-800 dark:text-amber-200">
                <ShieldAlert className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="font-medium text-ink">This is a development build</h2>
                <p className="mt-2 text-sm text-ink-muted">
                  The developer picker is not authentication. This browser acts as whichever player
                  you selected and carries the Platform API's shared development token. Keep this
                  build on your own machine or a trusted network.
                </p>
                <SwitchPlayerButton className="mt-3 -ml-2" />
              </div>
            </div>
          </Card>
        ) : (
          <Card>
            <div className="flex items-start gap-3">
              <div className="rounded-xl border border-border bg-surface-raised p-2.5 text-accent">
                <ShieldAlert className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="font-medium text-ink">Signed in with Discord</h2>
                <p className="mt-2 text-sm text-ink-muted">
                  You are viewing Waifumon as{' '}
                  <strong className="text-ink">{session.displayName}</strong> in the selected
                  Discord server. Use Sign out in the header to end this Portal session.
                </p>
              </div>
            </div>
          </Card>
        )}

        <Card>
          <div className="flex items-start gap-3">
            <div className="rounded-xl border border-border bg-surface-raised p-2.5 text-ink-subtle">
              <Info className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-medium text-ink">About</h2>
              <dl className="mt-3 divide-y divide-border text-sm">
                <div className="flex items-baseline justify-between gap-3 py-2">
                  <dt className="text-ink-muted">Portal version</dt>
                  <dd className="font-mono text-ink">{portalEnv.appVersion}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 py-2">
                  <dt className="text-ink-muted">Build mode</dt>
                  <dd className="font-mono text-ink">{portalEnv.mode}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 py-2">
                  <dt className="text-ink-muted">Platform API</dt>
                  <dd className="font-mono text-ink">{portalEnv.apiUrl}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 py-2">
                  <dt className="text-ink-muted">Acting player</dt>
                  <dd className="font-mono text-ink">
                    {session.displayName} (#{session.playerId})
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-ink-subtle">
                Player features are browse-only and gameplay happens in Discord. Permission-gated
                administration tools can update game configuration.
              </p>
              {import.meta.env.DEV && (
                <Button asChild variant="ghost" size="sm" className="mt-3 -ml-2">
                  <a href="/__dev/diagnostics">Open developer diagnostics</a>
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
