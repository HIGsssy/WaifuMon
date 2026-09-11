/**
 * Authoring for `trigger_waifumon_encounter`: Specific Species or Random, with
 * pool and filters, a readable summary, and a server-evaluated candidate
 * preview.
 *
 * Every edit goes through {@link effectFromForm}, so the saved effect is always
 * the one canonical shape for the chosen mode. Switching modes remembers the
 * other mode's settings in local state only — they come back if the author
 * switches back, but they are never serialized alongside the active mode.
 */
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  previewSpeciesSelector,
  type AdminEncounterReference,
  type SelectorPreviewEncounter,
} from '@/api/adminEncounters';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';

import type { EffectShape } from './EffectEditor';
import {
  EMPTY_RANDOM,
  POOL_HELP,
  POOL_LABELS,
  affinityLabel,
  effectFromForm,
  formFromEffect,
  raceLabel,
  rarityLabel,
  regionLabel,
  selectionFromForm,
  summarizeSelector,
  type CanonicalOrder,
  type PoolChoice,
  type SelectorForm,
} from './waifumonSelection';

/** Fallback when an older server's reference lacks `speciesRarities`. */
const DEFAULT_SPECIES_RARITIES = ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX'];

type RandomForm = Extract<SelectorForm, { mode: 'random' }>;

interface Props {
  effect: EffectShape;
  reference: AdminEncounterReference | undefined;
  /** Where the encounter can fire; omitted = every enabled region. */
  encounterContext?: SelectorPreviewEncounter | undefined;
  onChange: (next: EffectShape) => void;
}

function Toggle({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  // Same chip treatment as the shared FilterToolbar's options.
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40',
        pressed
          ? 'border-transparent bg-ink text-ink-inverse'
          : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

export function WaifumonSelectorEditor({ effect, reference, encounterContext, onChange }: Props) {
  const form = formFromEffect(effect);
  const speciesRarities = reference?.speciesRarities ?? DEFAULT_SPECIES_RARITIES;
  const order: CanonicalOrder = {
    rarities: speciesRarities,
    races: reference?.races ?? [],
    affinities: reference?.affinities ?? [],
  };

  // The inactive mode's settings, so a Specific ↔ Random flip is not lossy.
  // Local only: never part of the saved effect.
  const memory = useRef<{ specific: string; random: RandomForm }>({
    specific: form.mode === 'specific' ? form.speciesSlug : '',
    random: form.mode === 'random' ? form : EMPTY_RANDOM,
  });
  const [search, setSearch] = useState('');

  const commit = (next: SelectorForm) => {
    if (next.mode === 'specific') memory.current.specific = next.speciesSlug;
    else memory.current.random = next;
    onChange(effectFromForm(next, order));
  };

  const nameOf = (slug: string) => reference?.species.find((s) => s.slug === slug)?.name;

  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const species = reference?.species ?? [];
  const query = search.trim().toLowerCase();
  const visibleSpecies = species.filter(
    (sp) =>
      query === '' ||
      sp.name.toLowerCase().includes(query) ||
      sp.slug.includes(query) ||
      (form.mode === 'specific' && sp.slug === form.speciesSlug),
  );

  return (
    <div className="space-y-2" data-testid="waifumon-selector">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span>Selection</span>
        <Toggle
          pressed={form.mode === 'specific'}
          onClick={() =>
            form.mode !== 'specific' &&
            commit({ mode: 'specific', speciesSlug: memory.current.specific })
          }
        >
          Specific Species
        </Toggle>
        <Toggle
          pressed={form.mode === 'random'}
          onClick={() => form.mode !== 'random' && commit(memory.current.random)}
        >
          Random
        </Toggle>
      </div>

      {form.mode === 'specific' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-ink-muted">
            Search species
            <Input
              value={search}
              placeholder="Name or slug"
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="text-xs text-ink-muted">
            Species
            <select
              value={form.speciesSlug}
              onChange={(e) => commit({ mode: 'specific', speciesSlug: e.target.value })}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
            >
              <option value="">— pick a species —</option>
              {/* A slug no longer in the reference list still shows, so an
                  edit never silently changes what was authored. */}
              {form.speciesSlug && !species.some((s) => s.slug === form.speciesSlug) && (
                <option value={form.speciesSlug}>{form.speciesSlug} (not found)</option>
              )}
              {visibleSpecies.map((sp) => (
                <option key={sp.slug} value={sp.slug}>
                  {sp.name} ({sp.rarity})
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {form.mode === 'random' && (
        <div className="space-y-2">
          <fieldset>
            <legend className="mb-1 text-xs text-ink-muted">Pool</legend>
            <div className="flex flex-wrap gap-1.5">
              {(['region', 'global', 'hunt_draw'] as PoolChoice[]).map((pool) => (
                <Toggle
                  key={pool}
                  pressed={form.pool === pool}
                  onClick={() =>
                    commit(
                      pool === 'hunt_draw'
                        ? { ...EMPTY_RANDOM, pool }
                        : { ...form, pool },
                    )
                  }
                >
                  {POOL_LABELS[pool]}
                </Toggle>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">{POOL_HELP[form.pool]}</p>
          </fieldset>

          {(
            [
              ['Rarity', 'rarities', speciesRarities, rarityLabel],
              ['Race', 'races', reference?.races ?? [], raceLabel],
              ['Affinity', 'affinities', reference?.affinities ?? [], affinityLabel],
            ] as const
          ).map(([label, key, values, toLabel]) => (
            <fieldset key={key}>
              <legend className="mb-1 text-xs text-ink-muted">{label}</legend>
              <div className="flex flex-wrap gap-1.5">
                {values.map((value) => (
                  <Toggle
                    key={value}
                    pressed={form[key].includes(value)}
                    disabled={form.pool === 'hunt_draw'}
                    onClick={() => commit({ ...form, [key]: toggleIn(form[key], value) })}
                  >
                    {toLabel(value)}
                  </Toggle>
                ))}
              </div>
            </fieldset>
          ))}
          {form.pool === 'hunt_draw' && (
            <p className="text-[11px] text-ink-muted">
              Choose Current Region or Global to filter by rarity, race or affinity.
            </p>
          )}
        </div>
      )}

      <p className="text-sm font-medium" data-testid="selector-summary">
        {summarizeSelector(form, nameOf)}
      </p>

      <SelectorCandidatePreview
        form={form}
        selection={selectionFromForm(form, order)}
        encounterContext={encounterContext}
        regionNames={reference?.regionNames}
      />
    </div>
  );
}

function SelectorCandidatePreview({
  form,
  selection,
  encounterContext,
  regionNames,
}: {
  form: SelectorForm;
  selection: Record<string, unknown> | null;
  encounterContext: SelectorPreviewEncounter | undefined;
  regionNames: Record<string, string> | undefined;
}) {
  const huntDraw = form.mode === 'random' && form.pool === 'hunt_draw';
  const unchosen = form.mode === 'specific' && form.speciesSlug === '';
  const previewQuery = useQuery({
    queryKey: ['admin', 'encounters', 'selector-preview', selection, encounterContext ?? null],
    queryFn: () =>
      previewSpeciesSelector({
        selection,
        ...(encounterContext ? { encounter: encounterContext } : {}),
      }),
    enabled: !huntDraw && !unchosen,
    staleTime: 30_000,
  });

  if (huntDraw) {
    return (
      <p className="text-[11px] text-ink-muted">
        The hunt draw is decided by the region/rarity roll at runtime and falls back to other
        pools when a rarity is empty, so it has no fixed candidate set to preview.
      </p>
    );
  }
  if (unchosen) {
    return <p className="text-[11px] text-ink-muted">Pick a species to preview this sighting.</p>;
  }
  if (previewQuery.isPending) {
    return <p className="text-[11px] text-ink-muted">Checking eligible species…</p>;
  }
  if (previewQuery.isError) {
    return <p className="text-[11px] text-destructive">Could not load eligible species.</p>;
  }

  const data = previewQuery.data;
  if (data.mode === 'specific' && data.specific) {
    return data.specific.found ? (
      <p className="text-xs" data-testid="selector-preview">
        Eligible species: 1 — {data.specific.name} ({data.specific.rarity}). A specific species
        appears in any region.
      </p>
    ) : (
      <p
        className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs text-destructive"
        data-testid="selector-preview"
        role="alert"
      >
        ⚠ “{data.specific.slug}” is not an enabled species on this server. This sighting cannot
        happen.
      </p>
    );
  }

  return (
    <div className="space-y-1 text-xs" data-testid="selector-preview">
      {!data.matchesAnywhere && (
        <p
          className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-destructive"
          role="alert"
        >
          ⚠ This selector does not match any enabled Waifumon in any valid region. It can never
          produce a sighting, and importing an encounter carrying it is blocked.
        </p>
      )}
      <p className="text-[11px] text-ink-muted">
        Evaluated with the live selector in{' '}
        {encounterContext &&
        (encounterContext.regions.length > 0 || encounterContext.routes.length > 0)
          ? 'each region this encounter can fire in (hunt regions and travel destinations)'
          : 'every enabled region'}
        :
      </p>
      <ul className="space-y-1">
        {data.regions.map((r) => {
          const label = regionLabel(r.regionId, regionNames) || r.regionName;
          return (
            <li key={r.regionId}>
              {r.candidateCount > 0 ? (
                <details>
                  <summary className="cursor-pointer">
                    {label}: {r.candidateCount} eligible
                  </summary>
                  <ul className="ml-4 list-disc text-ink-muted">
                    {r.candidates.map((c) => (
                      <li key={c.slug}>
                        {c.name} ({c.rarity})
                      </li>
                    ))}
                  </ul>
                </details>
              ) : (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2" role="alert">
                  <strong>{label}: 0 eligible.</strong> ⚠ No Waifumon currently match this selector in{' '}
                  {label}. This selector cannot produce a sighting in this region.
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
