/**
 * `/settings` — theme and About (plan §8.10).
 *
 * The only enabled entry among the four reserved sidebar slots, and the only
 * page in the Portal with a control that changes anything. That control changes
 * a CSS class, not game state: the read-only rule is about the Platform API,
 * and the theme never leaves the browser.
 *
 * The About card restates the dev-auth caveat in full. §26 lists "users mistake
 * dev-auth for real auth" as a high-impact risk, and the header chip alone is
 * easy to stop seeing.
 */
import { Info, Moon, ShieldAlert, Sun } from 'lucide-react';

import { useTheme } from '@/app/useTheme';
import { useCurrentSession } from '@/auth/useSession';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
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

        <Card>
          <div className="flex items-start gap-3">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-600 dark:text-amber-300">
              <ShieldAlert className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="font-medium text-ink">This is a development build</h2>
              <p className="mt-2 text-sm text-ink-muted">
                The Portal has no authentication. It acts as whichever player{' '}
                <code className="font-mono text-ink">VITE_DEFAULT_PLAYER_ID</code> names, and it
                carries the Platform API's shared token in the page itself. Anyone who can reach
                this address is that player.
              </p>
              <p className="mt-2 text-sm text-ink-muted">
                Discord sign-in replaces this before the Portal is ever deployed anywhere. Until
                then, keep it on your own machine.
              </p>
            </div>
          </div>
        </Card>

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
                The Portal is a read-only companion. Gameplay lives in Discord, and the Platform API
                is the only thing this page talks to.
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
