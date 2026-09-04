/**
 * `/encyclopedia` - every species in the world.
 *
 * The catalogue filters client-side over the cached content snapshot. The
 * ownership overlay still gates the grid so undiscovered species never leak
 * names or lore while the owned-count request is loading.
 */
import { BookOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import type { Affinity, Race } from '@/api/types';
import { useContentSpecies } from '@/api/hooks/useContent';
import { useOwnedSlugs } from '@/api/hooks/useOwnedSlugs';
import { useSpeciesDiscovery } from '@/api/hooks/useSpeciesDiscovery';
import { useCurrentSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  FilterToolbar,
  type ActiveFilterChip,
  type FilterGroup,
} from '@/components/waifumon/FilterToolbar';
import { Skeleton } from '@/components/ui/skeleton';
import { distinctSpeciesValues } from '@/content/species';
import { titleCase } from '@/lib/format';
import { byRarityDesc, RARITY_ORDER, rarityStyle } from '@/lib/rarity';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { SpeciesCard } from './SpeciesCard';

type Discovery = 'all' | 'discovered' | 'undiscovered';

const GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 2xl:grid-cols-5';

const DISCOVERY_OPTIONS: readonly Discovery[] = ['all', 'discovered', 'undiscovered'];

function readParam<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

export function EncyclopediaPage() {
  const session = useCurrentSession();
  const species = useContentSpecies();
  const owned = useOwnedSlugs(session.playerId);
  // The same query read through the fail-closed lens. `owned` still drives the
  // filters and the tally; nothing that decides what to *reveal* reads it
  // directly, because `owned.data` alone cannot say whose dex it is holding —
  // see `useSpeciesDiscovery`. Named `dex` because `discovery` on this page is
  // already the name of the Show filter.
  const dex = useSpeciesDiscovery(session.playerId);

  const [searchParams, setSearchParams] = useSearchParams();
  const rarity = readParam(searchParams.get('rarity'), RARITY_ORDER);
  const discovery = readParam(searchParams.get('discovery'), DISCOVERY_OPTIONS) ?? 'all';
  const search = searchParams.get('search') ?? '';

  const [searchDraft, setSearchDraft] = useState(search);
  const debouncedSearch = useDebouncedValue(searchDraft, 250);

  function patch(key: string, value: string | null) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  const enabled = useMemo(
    () => (species.data ?? []).filter((entry) => entry.enabled),
    [species.data],
  );
  const races = useMemo(() => distinctSpeciesValues(enabled, 'race') as Race[], [enabled]);
  const affinities = useMemo(
    () => distinctSpeciesValues(enabled, 'affinity') as Affinity[],
    [enabled],
  );
  const race = readParam(searchParams.get('type'), races);
  const affinity = readParam(searchParams.get('affinity'), affinities);

  // Filtering and the header tally only — never artwork. Both are gated on
  // `discovery.isSettled` below, so an empty map here is never rendered.
  const counts = useMemo(
    () => (dex.isSettled ? (owned.data?.countBySlug ?? {}) : {}),
    [owned.data, dex.isSettled],
  );

  const visible = useMemo(() => {
    const needle = debouncedSearch.trim().toLowerCase();
    return enabled
      .filter((entry) => {
        const ownedCount = counts[entry.slug] ?? 0;
        if (rarity && entry.rarity !== rarity) return false;
        if (race && entry.race !== race) return false;
        if (affinity && entry.affinity !== affinity) return false;
        if (discovery === 'discovered' && ownedCount === 0) return false;
        if (discovery === 'undiscovered' && ownedCount > 0) return false;
        if (needle && (ownedCount === 0 || !entry.name.toLowerCase().includes(needle))) {
          return false;
        }
        return true;
      })
      .sort((a, b) => byRarityDesc(a.rarity, b.rarity) || a.name.localeCompare(b.name));
  }, [enabled, counts, rarity, race, affinity, discovery, debouncedSearch]);

  const discoveredCount = enabled.filter((entry) => (counts[entry.slug] ?? 0) > 0).length;

  const groups: FilterGroup[] = [
    {
      label: 'Show',
      options: DISCOVERY_OPTIONS.map((value) => ({
        value,
        label: titleCase(value),
        active: discovery === value,
        onSelect: () => patch('discovery', value === 'all' ? null : value),
      })),
    },
    {
      label: 'Rarity',
      options: RARITY_ORDER.map((tier) => ({
        value: tier,
        label: tier,
        active: rarity === tier,
        onSelect: () => patch('rarity', rarity === tier ? null : tier),
        style: { color: `var(${rarityStyle(tier).cssVar})` },
      })),
    },
    {
      label: 'Type',
      options: races.map((value) => ({
        value,
        label: titleCase(value),
        active: race === value,
        onSelect: () => patch('type', race === value ? null : value),
      })),
    },
    {
      label: 'Affinity',
      options: affinities.map((value) => ({
        value,
        label: titleCase(value),
        active: affinity === value,
        onSelect: () => patch('affinity', affinity === value ? null : value),
      })),
    },
  ];

  const activeChips: ActiveFilterChip[] = [
    ...(search
      ? [
          {
            key: 'search',
            label: `Search: "${search}"`,
            onRemove: () => {
              setSearchDraft('');
              patch('search', null);
            },
          },
        ]
      : []),
    ...(rarity
      ? [
          {
            key: 'rarity',
            label: `Rarity: ${rarity}`,
            onRemove: () => patch('rarity', null),
          },
        ]
      : []),
    ...(race
      ? [
          {
            key: 'type',
            label: `Type: ${titleCase(race)}`,
            onRemove: () => patch('type', null),
          },
        ]
      : []),
    ...(affinity
      ? [
          {
            key: 'affinity',
            label: `Affinity: ${titleCase(affinity)}`,
            onRemove: () => patch('affinity', null),
          },
        ]
      : []),
    ...(discovery !== 'all'
      ? [
          {
            key: 'discovery',
            label: titleCase(discovery),
            onRemove: () => patch('discovery', null),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Encyclopedia"
        description="Every species in the world, discovered or not."
        actions={
          species.data && dex.isSettled ? (
            <span className="tabular text-sm text-ink-muted">
              {discoveredCount} / {enabled.length} discovered
            </span>
          ) : undefined
        }
      />

      {species.isError ? (
        <ErrorState
          error={species.error}
          onRetry={() => void species.refetch()}
          title="Couldn't load the species catalogue."
        />
      ) : (
        <>
          <FilterToolbar
            searchValue={searchDraft}
            onSearchChange={(value) => {
              setSearchDraft(value);
              patch('search', value);
            }}
            searchPlaceholder="Search discovered species..."
            searchLabel="Search discovered species"
            groups={groups}
            activeChips={activeChips}
            onClearAll={() => {
              setSearchDraft('');
              setSearchParams(new URLSearchParams());
            }}
          />

          {species.isPending || !dex.isSettled ? (
            <div className={GRID} aria-busy="true" aria-label="Loading the encyclopedia">
              {Array.from({ length: 10 }, (_, index) => (
                <Skeleton key={index} className="aspect-[3/4] rounded-2xl" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No species match your filters"
              description="Try widening the search or clearing a filter."
            />
          ) : (
            <div className={GRID}>
              {visible.map((entry, index) => (
                <SpeciesCard
                  key={entry.slug}
                  species={entry}
                  ownedCount={dex.copiesOf(entry.slug)}
                  priority={index < 4}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
