/**
 * Probability analysis — the server's `describeRegionDistribution`, shown.
 *
 * Three separate views, because they are three different draws:
 *
 *   - **Normal hunting** — rarity first (Buddy, then the level-40 shift), six
 *     attempts across fallback tiers, then a species by weight.
 *   - **Scripted spawns** — the same draw with no Buddy.
 *   - **Filtered World Encounter selectors** — the filter, then the
 *     level-adjusted rarity table conditioned on what matched; no fallback.
 *
 * Every number on this panel is a field of the analysis response. When the
 * server reports a scenario as unsafe (the runtime would throw) the panel says
 * so and shows no odds for it — nothing is estimated here.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import {
  analyseRegionPool,
  regionPoolKeys,
  type DistributionMode,
  type DistributionResult,
  type RegionPoolAnalysis,
  type RegionPoolAnalysisRequest,
  type RegionPoolSelectorFilter,
  type RegionPoolSpecies,
} from '@/api/adminRegionPools';
import { isPortalApiError } from '@/api/client';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

import {
  EXCLUSION_LABELS,
  FALLBACK_LABELS,
  TIER_LABELS,
  formatDelta,
  formatPercent,
} from './regionPoolModel';

const MODE_LABELS: Record<DistributionMode, string> = {
  hunt: 'Normal hunting',
  scripted_spawn: 'Scripted spawns',
  filtered_selector: 'Filtered World Encounter selectors',
};

const MODE_HINTS: Record<DistributionMode, string> = {
  hunt: 'What pressing Hunt in this region meets: a rarity is rolled first (with any Buddy bonus, then the level-40 shift), then a species of that rarity by weight. An empty rarity falls back to the default region, then to any open species, and rerolls up to six times.',
  scripted_spawn:
    'Wild encounters spawned by scripted content (for example a World Encounter outcome). The same rarity-first draw as hunting, but a Buddy Bonus never applies.',
  filtered_selector:
    'A World Encounter that spawns a random species matching a filter. Only matching species are considered, and there is no fallback: if nothing matches, nothing spawns.',
};

const RARITY_FILTERS = ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX'];

export function RegionPoolAnalysisPanel({
  regionId,
  catalogue,
  poolSpecies,
  hasUnpublishedDraft,
  dirty,
}: {
  regionId: string;
  catalogue: readonly RegionPoolSpecies[];
  /** Species in the analysed pools, for the ownership assumption. */
  poolSpecies: readonly { slug: string; name: string }[];
  hasUnpublishedDraft: boolean;
  /** Unsaved edits exist on this page: the analysis covers the saved draft only. */
  dirty: boolean;
}) {
  const [mode, setMode] = useState<DistributionMode>('hunt');
  const [source, setSource] = useState<'draft' | 'published'>('published');
  const [compare, setCompare] = useState(hasUnpublishedDraft);
  const [levelText, setLevelText] = useState('1');
  const [buddy, setBuddy] = useState('');
  const [owned, setOwned] = useState<string[]>([]);
  const [filter, setFilter] = useState<RegionPoolSelectorFilter>({ poolScope: 'region' });

  const level = /^\d+$/.test(levelText) ? Math.min(1000, Math.max(1, Number(levelText))) : 1;
  const request: RegionPoolAnalysisRequest = {
    source,
    mode,
    level,
    compare,
    ...(mode === 'hunt' && buddy ? { buddySpecies: buddy } : {}),
    ...(mode === 'hunt' && owned.length ? { ownedSpecies: owned } : {}),
    ...(mode === 'filtered_selector' ? { filter } : {}),
  };

  const query = useQuery({
    queryKey: regionPoolKeys.analysis(regionId, request),
    queryFn: ({ signal }) => analyseRegionPool(regionId, request, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const toggleIn = (list: string[] | undefined, value: string) => {
    const set = new Set(list ?? []);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    return set.size ? [...set] : undefined;
  };
  const setDimension = (key: 'rarities' | 'races' | 'affinities', value: string) => {
    const next = { ...filter };
    const list = toggleIn(filter[key], value);
    if (list) next[key] = list;
    else delete next[key];
    setFilter(next);
  };

  // Filter values are the ones species actually carry; the server validates the rest.
  const distinct = (pick: (s: RegionPoolSpecies) => string) =>
    [...new Set(catalogue.map(pick))].sort();
  const raceFilters = distinct((s) => s.race);
  const affinityFilters = distinct((s) => s.affinity);

  const buddies = catalogue
    .filter((s) => s.inContent)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section
      aria-label="Probability analysis"
      className="space-y-4"
      data-testid="region-pool-analysis"
    >
      <div role="tablist" aria-label="What to analyse" className="flex flex-wrap gap-2">
        {(Object.keys(MODE_LABELS) as DistributionMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={m === mode}
            className={`h-11 rounded-md px-3 text-xs font-medium sm:h-8 ${m === mode ? 'border border-border bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface-raised'}`}
            onClick={() => setMode(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <p className="text-xs text-ink-muted">{MODE_HINTS[mode]}</p>

      <Card className="space-y-3 p-4" data-testid="analysis-scenario">
        <h3 className="text-sm font-semibold uppercase text-ink-muted">Scenario</h3>
        <div className="flex flex-wrap items-end gap-3 text-xs text-ink-muted">
          <label>
            Pool
            <select
              aria-label="Pool to analyse"
              className="block h-11 rounded border border-border bg-surface px-2 text-sm text-ink sm:h-9"
              value={source}
              onChange={(e) => setSource(e.target.value as 'draft' | 'published')}
            >
              <option value="published">Published (live)</option>
              <option value="draft">Saved draft</option>
            </select>
          </label>
          <label>
            Player level
            <Input
              aria-label="Player level"
              inputMode="numeric"
              className="w-24"
              value={levelText}
              onChange={(e) => setLevelText(e.target.value)}
            />
          </label>
          <div className="flex gap-1" aria-label="Level presets">
            {[1, 39, 40].map((n) => (
              <button
                key={n}
                type="button"
                className="h-11 rounded border border-border px-2 text-xs sm:h-8"
                onClick={() => setLevelText(String(n))}
              >
                Level {n}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={compare}
              onChange={(e) => setCompare(e.target.checked)}
            />
            Compare draft with published
          </label>
        </div>

        {mode === 'hunt' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-ink-muted">
              Buddy (her authored Buddy Bonus is applied)
              <select
                aria-label="Buddy species"
                className="block h-11 w-full rounded border border-border bg-surface px-2 text-sm text-ink sm:h-9"
                value={buddy}
                onChange={(e) => setBuddy(e.target.value)}
              >
                <option value="">No Buddy</option>
                {buddies.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name} ({s.rarity})
                  </option>
                ))}
              </select>
            </label>
            <details className="text-xs text-ink-muted">
              <summary className="cursor-pointer">
                Assume the player owns… ({owned.length} selected)
              </summary>
              <p className="mt-1">
                Only matters for a Buddy whose bonus targets owned species. The default is that the
                player owns none of them.
              </p>
              <ul
                className="mt-1 max-h-48 space-y-1 overflow-y-auto"
                aria-label="Owned species assumption"
              >
                {poolSpecies.map((s) => (
                  <li key={s.slug}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={owned.includes(s.slug)}
                        onChange={() => setOwned(toggleIn(owned, s.slug) ?? [])}
                      />
                      {s.name}
                    </label>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {mode === 'filtered_selector' && (
          <div className="space-y-2 text-xs text-ink-muted" data-testid="selector-filter">
            <label>
              Pool scope
              <select
                aria-label="Selector pool scope"
                className="block h-11 rounded border border-border bg-surface px-2 text-sm text-ink sm:h-9"
                value={filter.poolScope ?? 'region'}
                onChange={(e) =>
                  setFilter({ ...filter, poolScope: e.target.value as 'region' | 'global' })
                }
              >
                <option value="region">This region's pool</option>
                <option value="global">Global (open species plus this pool)</option>
              </select>
            </label>
            {(
              [
                ['rarities', 'Rarities', RARITY_FILTERS],
                ['races', 'Races', raceFilters],
                ['affinities', 'Affinities', affinityFilters],
              ] as const
            ).map(([key, label, values]) => (
              <fieldset key={key}>
                <legend>{label} (none ticked = any)</legend>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {values.map((v) => (
                    <label key={v} className="flex min-h-8 items-center gap-1 text-ink">
                      <input
                        type="checkbox"
                        aria-label={`Filter ${label.toLowerCase()} ${v}`}
                        checked={filter[key]?.includes(v) ?? false}
                        onChange={() => setDimension(key, v)}
                      />
                      {v}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        )}
        {dirty && source === 'draft' && (
          <p className="text-xs text-danger" role="note">
            You have unsaved edits. The analysis covers the saved draft — save to include them.
          </p>
        )}
      </Card>

      {query.isPending && <Skeleton className="h-48 w-full" />}
      {query.isError && (
        <p role="alert" className="text-sm text-danger" data-testid="analysis-error">
          {isPortalApiError(query.error) && query.error.code === 'REGION_POOL_SCENARIO_INVALID'
            ? `This scenario cannot be analysed: ${query.error.message}`
            : `The analysis failed: ${query.error.message}`}
        </p>
      )}
      {query.data && <AnalysisResult analysis={query.data} stale={query.isPlaceholderData} />}
    </section>
  );
}

function AnalysisResult({ analysis, stale }: { analysis: RegionPoolAnalysis; stale: boolean }) {
  const { result, comparison } = analysis;
  const delta = new Map(comparison?.diff.species.map((d) => [d.slug, d]) ?? []);
  return (
    <div
      className={`space-y-4 ${stale ? 'opacity-60' : ''}`}
      aria-busy={stale}
      data-testid="analysis-result"
    >
      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-semibold uppercase text-ink-muted">
          Assumptions — {analysis.source === 'draft' ? 'saved draft' : 'published pool'}
        </h3>
        <ul className="ml-4 list-disc text-xs text-ink-muted" data-testid="analysis-assumptions">
          {analysis.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        {result.encounterShare !== null && (
          <p className="text-xs text-ink">
            {formatPercent(result.encounterShare)} of Hunt actions are encounters; the rest find
            items or nothing. "Per Hunt" columns include that.
          </p>
        )}
        {result.errorProbability > 0 && (
          <p role="alert" className="text-sm text-danger" data-testid="analysis-unsafe">
            In {formatPercent(result.errorProbability)} of draws this scenario makes the game's draw
            fail. No odds are shown for the unsafe part.
          </p>
        )}
        {result.exhausted && result.exhausted.probability > 0 && (
          <p className="text-xs text-ink" data-testid="analysis-exhausted">
            {formatPercent(result.exhausted.probability)} of encounters use up all six rerolls and
            meet {FALLBACK_LABELS[result.exhausted.fallback] ?? result.exhausted.fallback}. That
            share is not attributed to any one species.
          </p>
        )}
        {result.issues.length > 0 && (
          <ul className="space-y-1" aria-label="Analysis warnings" data-testid="analysis-issues">
            {result.issues.map((i, n) => (
              <li
                key={`${i.code}:${i.rarity ?? ''}:${n}`}
                className={`text-xs ${i.severity === 'error' ? 'text-danger' : 'text-ink-muted'}`}
              >
                <span className="font-medium">
                  {i.severity === 'info' ? 'Note' : i.severity === 'error' ? 'Error' : 'Warning'}:
                </span>{' '}
                {i.message}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <RarityTable result={result} comparison={comparison} />

      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-semibold uppercase text-ink-muted">Species</h3>
        <SpeciesOddsTable
          result={result}
          delta={comparison ? delta : null}
          against={comparison?.against ?? null}
        />
        {comparison &&
          comparison.diff.species.some((d) => !result.species.some((s) => s.slug === d.slug)) && (
            <p className="text-xs text-ink-muted" data-testid="analysis-dropped">
              No longer met:{' '}
              {comparison.diff.species
                .filter((d) => !result.species.some((s) => s.slug === d.slug))
                .map(
                  (d) =>
                    `${comparison.result.species.find((s) => s.slug === d.slug)?.name ?? d.slug} (${formatDelta(d.delta)})`,
                )
                .join(', ')}
            </p>
          )}
      </Card>

      {result.excluded.length > 0 && (
        <Card className="space-y-2 p-4" data-testid="analysis-excluded">
          <h3 className="text-sm font-semibold uppercase text-ink-muted">
            Pool members this draw never meets
          </h3>
          <ul className="space-y-0.5 text-xs text-ink-muted">
            {result.excluded.map((e) => (
              <li key={e.slug}>
                <span className="font-mono">{e.slug}</span> —{' '}
                {EXCLUSION_LABELS[e.reason] ?? e.reason}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function RarityTable({
  result,
  comparison,
}: {
  result: DistributionResult;
  comparison: RegionPoolAnalysis['comparison'];
}) {
  const tierChange = new Map(comparison?.diff.rarities.map((r) => [r.rarity, r]) ?? []);
  return (
    <Card className="space-y-2 p-4">
      <h3 className="text-sm font-semibold uppercase text-ink-muted">Rarity distribution</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-xs" data-testid="analysis-rarities">
          <thead className="text-ink-subtle">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Rarity
              </th>
              <th scope="col" className="py-1 font-medium">
                Table weight
              </th>
              <th scope="col" className="py-1 font-medium">
                One roll lands here
              </th>
              <th scope="col" className="py-1 font-medium">
                Encounters at this rarity
              </th>
              <th scope="col" className="py-1 font-medium">
                Drawn from
              </th>
            </tr>
          </thead>
          <tbody>
            {result.rarities.map((r) => {
              const change = tierChange.get(r.rarity);
              return (
                <tr
                  key={r.rarity}
                  className="border-t border-border"
                  data-testid={`analysis-rarity-${r.rarity}`}
                >
                  <th scope="row" className="py-1 font-normal">
                    <RarityBadge rarity={r.rarity} />
                  </th>
                  <td>
                    {r.effectiveWeight !== r.baseWeight
                      ? `${r.baseWeight} → ${r.effectiveWeight}`
                      : r.baseWeight}
                  </td>
                  <td>{formatPercent(r.rollProbability)}</td>
                  <td>
                    {r.unsafe ? (
                      <Badge variant="danger">Unsafe — no odds</Badge>
                    ) : (
                      formatPercent(r.probability)
                    )}
                  </td>
                  <td>
                    {TIER_LABELS[r.tier]} ({r.candidates})
                    {r.tier === 'dead' && (
                      <span className="block text-danger">Empty — rerolled</span>
                    )}
                    {change && (
                      <span className="block text-ink-subtle">
                        was {change.tierBefore ? TIER_LABELS[change.tierBefore] : 'absent'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SpeciesOddsTable({
  result,
  delta,
  against,
}: {
  result: DistributionResult;
  delta: Map<string, { delta: number }> | null;
  against: 'draft' | 'published' | null;
}) {
  if (result.species.length === 0)
    return <p className="text-xs text-ink-muted">No species can be met in this scenario.</p>;
  const perHunt = result.encounterShare !== null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-xs" data-testid="analysis-species">
        <thead className="text-ink-subtle">
          <tr>
            <th scope="col" className="py-1 font-medium">
              Species
            </th>
            <th scope="col" className="py-1 font-medium">
              Source
            </th>
            <th scope="col" className="py-1 font-medium">
              Weight
            </th>
            <th scope="col" className="py-1 font-medium">
              Share of rarity
            </th>
            <th scope="col" className="py-1 font-medium">
              Per encounter
            </th>
            {perHunt && (
              <th scope="col" className="py-1 font-medium">
                Per Hunt
              </th>
            )}
            {delta && (
              <th scope="col" className="py-1 font-medium">
                vs {against === 'published' ? 'published' : 'draft'}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {result.species.map((s) => (
            <tr
              key={s.slug}
              className="border-t border-border"
              data-testid={`analysis-species-${s.slug}`}
            >
              <th scope="row" className="py-1 font-normal">
                <span className="flex items-center gap-1">
                  <RarityBadge rarity={s.rarity} />
                  <span className="text-ink">{s.name}</span>
                </span>
              </th>
              <td>{s.inPool ? 'Pool' : TIER_LABELS[s.tier]}</td>
              <td>
                {s.effectiveWeight !== s.weight ? `${s.weight} → ${s.effectiveWeight}` : s.weight}
              </td>
              <td>{formatPercent(s.shareOfRarity)}</td>
              <td>{formatPercent(s.perEncounter)}</td>
              {perHunt && <td>{formatPercent(s.perHunt)}</td>}
              {delta && <td>{delta.has(s.slug) ? formatDelta(delta.get(s.slug)!.delta) : '±0'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Draft vs published, per species, for the publish review. Normal hunting at
 * level 1 with no Buddy — stated, not implied.
 */
export function PublishProbabilityChanges({
  regionId,
  draftRevision,
}: {
  regionId: string;
  draftRevision: number;
}) {
  const request: RegionPoolAnalysisRequest = {
    source: 'draft',
    mode: 'hunt',
    level: 1,
    compare: true,
  };
  const query = useQuery({
    queryKey: [...regionPoolKeys.analysis(regionId, request), draftRevision],
    queryFn: ({ signal }) => analyseRegionPool(regionId, request, signal),
    retry: false,
  });
  if (query.isPending) return <Skeleton className="h-16 w-full" />;
  if (query.isError)
    return (
      <p className="text-xs text-danger">Could not analyse the change: {query.error.message}</p>
    );
  const diff = query.data.comparison?.diff;
  const names = new Map(
    [...query.data.result.species, ...(query.data.comparison?.result.species ?? [])].map((s) => [
      s.slug,
      s.name,
    ]),
  );
  return (
    <div className="space-y-1 text-xs" data-testid="review-probability">
      <p className="text-ink-subtle">Normal hunting, level 1, no Buddy. Chance per encounter.</p>
      {!diff || (diff.species.length === 0 && diff.rarities.length === 0) ? (
        <p className="text-ink-muted">No change to any species' odds.</p>
      ) : (
        <>
          {diff.rarities.map((r) => (
            <p key={r.rarity} className="text-ink">
              {r.rarity}: drawn from {r.tierBefore ? TIER_LABELS[r.tierBefore] : '—'} →{' '}
              {r.tierAfter ? TIER_LABELS[r.tierAfter] : '—'}
            </p>
          ))}
          <ul className="max-h-40 space-y-0.5 overflow-y-auto">
            {diff.species.map((d) => (
              <li key={d.slug}>
                {names.get(d.slug) ?? d.slug}: {formatPercent(d.before)} → {formatPercent(d.after)}{' '}
                ({formatDelta(d.delta)})
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
