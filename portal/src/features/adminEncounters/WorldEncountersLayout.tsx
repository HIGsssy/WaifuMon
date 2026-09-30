/**
 * World Encounters — the admin section's sub-navigation.
 *
 *   Encounters · Chains · Vendors · Settings · Import / Export
 *
 * Each tab is its own route (and permission-gated there); this only draws the
 * tabs above whichever page is showing. Editing an encounter keeps the
 * Encounters tab lit, editing a vendor the Vendors tab.
 */
import { Link, Outlet, useLocation } from 'react-router';

import { cn } from '@/lib/cn';

const BASE = '/admin/encounters';

const WORLD_ENCOUNTER_TABS = [
  { to: `${BASE}/chains`, label: 'Chains' },
  { to: `${BASE}/vendors`, label: 'Vendors' },
  { to: `${BASE}/settings`, label: 'Settings' },
  { to: `${BASE}/import-export`, label: 'Import / Export' },
] as const;

export function WorldEncountersNav() {
  const { pathname } = useLocation();
  const section = WORLD_ENCOUNTER_TABS.find(
    (t) => pathname === t.to || pathname.startsWith(`${t.to}/`),
  );
  const tabs = [{ to: BASE, label: 'Encounters' }, ...WORLD_ENCOUNTER_TABS];
  return (
    <nav aria-label="World Encounters" className="mb-6 flex flex-wrap gap-1 border-b border-border">
      {tabs.map((t) => {
        const active = t.to === BASE ? section == null : section?.to === t.to;
        return (
          <Link
            key={t.to}
            to={t.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-accent font-medium text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function WorldEncountersLayout() {
  return (
    <div>
      <p className="mb-1 text-xs uppercase tracking-wide text-ink-muted">World Encounters</p>
      <WorldEncountersNav />
      <Outlet />
    </div>
  );
}
