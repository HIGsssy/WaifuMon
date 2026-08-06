/**
 * The persistent "DEV MODE — no authentication" marker (plan §6, §26).
 *
 * This is a risk control, not decoration. The Portal has no login, ships a
 * shared bearer token to the browser, and acts as whichever player
 * `VITE_DEFAULT_PLAYER_ID` names. The banner is always visible so that setup is
 * never mistaken for a production session.
 *
 * Two densities: a full strip under the header on desktop, a compact chip in
 * the header on phones where a strip would eat the first screenful.
 */
import { ShieldAlert } from 'lucide-react';

import { cn } from '@/lib/cn';

export function DevModeBanner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-2 border-b border-amber-500/25 bg-amber-500/10 px-4 py-1.5',
        'text-center text-xs text-amber-700 dark:text-amber-300',
        className,
      )}
    >
      <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        <strong className="font-semibold">DEV MODE</strong> — no authentication. Anyone who can
        reach this page acts as the configured player.
      </span>
    </div>
  );
}

export function DevModeChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5',
        'text-[0.625rem] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-300',
        className,
      )}
      title="No authentication — development build"
    >
      <ShieldAlert className="size-3" aria-hidden="true" />
      Dev
    </span>
  );
}
