/**
 * "Where it appears" — sources, regions, and (only when Travel is on) routes,
 * in plain language. Empty regions means every region; the section says so.
 */
import { useState } from 'react';

import type { AdminEncounterReference } from '@/api/adminEncounters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { selectClass } from './EntitySelect';
import type { Draft } from './encounterDraft';
import type { EncounterRole } from './encounterGraph';
import { regionLabel } from './waifumonSelection';

type Eligibility = Pick<Draft, 'huntEligible' | 'travelEligible' | 'regions' | 'routes'>;

interface Props {
  value: Eligibility;
  onChange: (patch: Partial<Eligibility>) => void;
  reference: AdminEncounterReference | undefined;
  role: EncounterRole | null;
}

export function EligibilityEditor({ value, onChange, reference, role }: Props) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [routesOpen, setRoutesOpen] = useState(value.routes.length > 0);
  const regions = reference?.regions ?? [];
  const names = reference?.regionNames;
  const enabled = reference?.enabledRegions;
  const label = (id: string) =>
    `${regionLabel(id, names)}${enabled && !enabled.includes(id) ? ' (disabled)' : ''}`;
  const toggleRegion = (id: string) =>
    onChange({
      regions: value.regions.includes(id)
        ? value.regions.filter((r) => r !== id)
        : [...value.regions, id],
    });
  const spawns = value.huntEligible || value.travelEligible;
  const reachedByChain = (role?.parents.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="text-xs font-medium text-ink-muted">Appears during</legend>
        <div className="mt-1 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.huntEligible}
              onChange={(e) => onChange({ huntEligible: e.target.checked })}
            />
            Hunt
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.travelEligible}
              onChange={(e) => onChange({ travelEligible: e.target.checked })}
            />
            Travel
          </label>
        </div>
        {!spawns && (
          <p className="mt-1 text-xs text-ink-muted">
            Chain-only: this encounter never appears on its own — only when another encounter
            continues to it.
          </p>
        )}
      </fieldset>

      {spawns && (
        <fieldset>
          <legend className="text-xs font-medium text-ink-muted">Regions</legend>
          <p className="text-xs text-ink-muted" data-testid="region-scope">
            {value.regions.length === 0
              ? 'All regions — no region is selected, so it can appear anywhere.'
              : `Only in: ${value.regions.map((r) => regionLabel(r, names)).join(', ')}.`}
          </p>
          <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="Regions">
            {regions.map((r) => {
              const on = value.regions.includes(r);
              return (
                <Button
                  key={r}
                  type="button"
                  size="sm"
                  variant={on ? 'accent' : 'outline'}
                  aria-pressed={on}
                  onClick={() => toggleRegion(r)}
                >
                  {on && <span aria-hidden="true">✓</span>}
                  {label(r)}
                </Button>
              );
            })}
            {value.regions.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onChange({ regions: [] })}
              >
                All regions
              </Button>
            )}
          </div>
        </fieldset>
      )}

      {(value.travelEligible || value.routes.length > 0) && (
        <fieldset className="rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-medium text-ink-muted">Travel routes</legend>
          {!routesOpen ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              Every route (optionally limited by the regions above).
              <Button type="button" size="sm" variant="ghost" onClick={() => setRoutesOpen(true)}>
                Limit to specific routes…
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-ink-muted">
                One direction each: a return trip needs its own route. None listed = every route.
                {!value.travelEligible && ' Travel is off, so these have no effect.'}
              </p>
              {value.routes.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {value.routes.map((r, i) => (
                    <Badge key={`${r.fromRegion}-${r.toRegion}-${i}`} variant="outline">
                      {regionLabel(r.fromRegion, names)} → {regionLabel(r.toRegion, names)}
                      <button
                        type="button"
                        className="ml-1"
                        aria-label={`Remove route ${r.fromRegion} to ${r.toRegion}`}
                        onClick={() => onChange({ routes: value.routes.filter((_, k) => k !== i) })}
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <select
                  aria-label="Route from"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className={selectClass}
                >
                  <option value="">from…</option>
                  {regions.map((r) => (
                    <option key={r} value={r}>
                      {regionLabel(r, names)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Route to"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className={selectClass}
                >
                  <option value="">to…</option>
                  {regions.map((r) => (
                    <option key={r} value={r}>
                      {regionLabel(r, names)}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!from || !to || from === to}
                  onClick={() => {
                    if (value.routes.some((r) => r.fromRegion === from && r.toRegion === to))
                      return;
                    onChange({ routes: [...value.routes, { fromRegion: from, toRegion: to }] });
                    setFrom('');
                    setTo('');
                  }}
                >
                  Add route
                </Button>
              </div>
            </div>
          )}
        </fieldset>
      )}

      {reachedByChain && (
        <p className="rounded-md bg-surface-sunken p-2 text-xs text-ink-muted">
          When another encounter continues to this one, it opens right there — in whatever region
          and trip the previous encounter happened in. The settings above only decide where it can
          appear <em>on its own</em>.
        </p>
      )}
    </div>
  );
}
