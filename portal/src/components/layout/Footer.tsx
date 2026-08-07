/**
 * Footer — the quiet end of every page.
 *
 * Also the diagnostics page's only in-app entry point (plan §23: "a footer link
 * visible only in dev builds, plus the direct URL"). The link is inside an
 * `import.meta.env.DEV` guard so it is not merely hidden in production — it is
 * absent, alongside the route itself.
 */
import { Link } from 'react-router';

import { portalEnv } from '@/lib/env';

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border px-4 py-6 text-xs text-ink-subtle sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>
          Waifumon Portal v{portalEnv.appVersion} — a read-only companion. The game happens in
          Discord.
        </p>
        {import.meta.env.DEV && (
          <Link to="/__dev/diagnostics" className="underline-offset-4 hover:underline">
            Developer diagnostics
          </Link>
        )}
      </div>
    </footer>
  );
}
