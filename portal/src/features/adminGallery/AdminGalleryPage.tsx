/**
 * `/admin/gallery` — every authored Waifumon, loaded or not, as a visual QA
 * catalog. Gated on `gallery.read` by the route and, for real, by the API.
 *
 * This is not the Encyclopedia: nothing here consults ownership, discovery or
 * unlocks. One request fetches the whole catalog; filtering is client-side and
 * lives in the URL, so a filtered view can be bookmarked or shared. Only each
 * species' default artwork is requested, at the grid rendition, lazily.
 */
import { Images, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';

import { useAdminGalleryCatalog } from '@/api/hooks/useAdminGallery';
import { queryKeys } from '@/api/queryKeys';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  FilterToolbar,
  type ActiveFilterChip,
  type FilterGroup,
} from '@/components/waifumon/FilterToolbar';
import { titleCase } from '@/lib/format';
import { RARITY_ORDER, rarityStyle } from '@/lib/rarity';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { ZONES, zoneLabel } from '@/lib/zone';

import { GallerySpeciesTile } from './GallerySpeciesTile';
import {
  distinctValues,
  filterGallerySpecies,
  FILTER_PARAM,
  NO_ZONE,
  RATING_OPTIONS,
  readGalleryFilters,
  type GalleryFilters,
} from './galleryFilters';

/** 2 → 3 → 4 → 6 columns; same gaps as the Encyclopedia grid. */
export const GALLERY_GRID =
  'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 2xl:grid-cols-6';

const RUNTIME_LABEL = { loaded: 'Loaded', future: 'Future' } as const;
const ENABLED_LABEL = { enabled: 'Enabled', disabled: 'Disabled' } as const;
const HEALTH_LABEL = { issues: 'Has Issues', clean: 'No Issues' } as const;

export function AdminGalleryPage() {
  const catalog = useAdminGalleryCatalog();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const species = useMemo(() => catalog.data?.species ?? [], [catalog.data]);
  const races = useMemo(() => distinctValues(species, 'race'), [species]);
  const affinities = useMemo(() => distinctValues(species, 'affinity'), [species]);
  const filters = readGalleryFilters(searchParams, { races, affinities });

  const [searchDraft, setSearchDraft] = useState(filters.search);
  const debouncedSearch = useDebouncedValue(searchDraft, 250);

  const visible = useMemo(
    () => filterGallerySpecies(species, { ...filters, search: debouncedSearch }),
    // `filters` is rebuilt every render; its URL is the stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [species, searchParams, debouncedSearch],
  );

  function patch(key: keyof GalleryFilters, value: string | null) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null || value === '') next.delete(FILTER_PARAM[key]);
        else next.set(FILTER_PARAM[key], value);
        return next;
      },
      { replace: key === 'search' },
    );
  }

  /** A toggle chip: selecting the active option clears it. */
  function option<T extends string>(
    key: keyof GalleryFilters,
    value: T,
    label: string,
    current: T | null,
  ) {
    return {
      value,
      label,
      active: current === value,
      onSelect: () => patch(key, current === value ? null : value),
    };
  }

  const allOption = (key: keyof GalleryFilters, label: string, current: string | null) => ({
    value: 'all',
    label,
    active: current === null,
    onSelect: () => patch(key, null),
  });

  const groups: FilterGroup[] = [
    {
      label: 'Runtime',
      options: [
        allOption('runtime', 'All', filters.runtime),
        option('runtime', 'loaded', 'Loaded', filters.runtime),
        option('runtime', 'future', 'Future', filters.runtime),
      ],
    },
    {
      label: 'Enabled',
      options: [
        allOption('enabled', 'All', filters.enabled),
        option('enabled', 'enabled', 'Enabled', filters.enabled),
        option('enabled', 'disabled', 'Disabled', filters.enabled),
      ],
    },
    {
      label: 'Artwork health',
      options: [
        allOption('health', 'All', filters.health),
        option('health', 'issues', 'Has Issues', filters.health),
        option('health', 'clean', 'No Issues', filters.health),
      ],
    },
    {
      label: 'Zone',
      options: [
        allOption('zone', 'All Zones', filters.zone),
        ...ZONES.map((z) => option('zone', z.tag, z.label, filters.zone)),
        option('zone', NO_ZONE, 'No Zone', filters.zone),
      ],
    },
    {
      label: 'Rarity',
      options: RARITY_ORDER.map((tier) => ({
        ...option('rarity', tier, tier, filters.rarity),
        style: { color: `var(${rarityStyle(tier).cssVar})` },
      })),
    },
    {
      label: 'Type',
      options: races.map((race) => option('race', race, titleCase(race), filters.race)),
    },
    {
      label: 'Affinity',
      options: affinities.map((a) => option('affinity', a, titleCase(a), filters.affinity)),
    },
    {
      label: 'Content rating',
      options: [
        allOption('rating', 'All', filters.rating),
        ...RATING_OPTIONS.map((r) => option('rating', r, titleCase(r), filters.rating)),
      ],
    },
  ];

  const chip = (key: keyof GalleryFilters, label: string): ActiveFilterChip => ({
    key,
    label,
    onRemove: () => {
      if (key === 'search') setSearchDraft('');
      patch(key, null);
    },
  });

  const activeChips: ActiveFilterChip[] = [
    ...(filters.search ? [chip('search', `Search: "${filters.search}"`)] : []),
    ...(filters.runtime ? [chip('runtime', `Runtime: ${RUNTIME_LABEL[filters.runtime]}`)] : []),
    ...(filters.enabled ? [chip('enabled', ENABLED_LABEL[filters.enabled])] : []),
    ...(filters.health ? [chip('health', HEALTH_LABEL[filters.health])] : []),
    ...(filters.zone
      ? [
          chip(
            'zone',
            `Zone: ${filters.zone === NO_ZONE ? 'No Zone' : (zoneLabel(filters.zone) ?? filters.zone)}`,
          ),
        ]
      : []),
    ...(filters.rarity ? [chip('rarity', `Rarity: ${filters.rarity}`)] : []),
    ...(filters.race ? [chip('race', `Type: ${titleCase(filters.race)}`)] : []),
    ...(filters.affinity ? [chip('affinity', `Affinity: ${titleCase(filters.affinity)}`)] : []),
    ...(filters.rating ? [chip('rating', `Rating: ${titleCase(filters.rating)}`)] : []),
  ];

  const summary = catalog.data?.summary;
  const query = searchParams.toString();
  const detailSearch = query ? `?${query}` : '';

  return (
    <>
      <PageHeader
        title="Waifumon Gallery"
        description="Inspect authored species, appearances and artwork health."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: queryKeys.adminGallery() })
            }
            disabled={catalog.isFetching}
          >
            <RefreshCw
              className={catalog.isFetching ? 'animate-spin' : undefined}
              aria-hidden="true"
            />
            Refresh
          </Button>
        }
      />

      {summary && (
        <p
          className="tabular -mt-3 mb-5 text-sm text-ink-muted sm:-mt-5"
          data-testid="gallery-summary"
        >
          {summary.authoredSpecies} authored · {summary.runtimeLoadedSpecies} loaded ·{' '}
          {summary.unloadedSpecies} future · {summary.authoredAppearances} appearances ·{' '}
          {summary.artworkAvailableAppearances} with artwork · {summary.speciesWithIssues} species
          with issues
        </p>
      )}

      {catalog.isError ? (
        <ErrorState
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
          title="Couldn't load the Waifumon Gallery."
        />
      ) : (
        <>
          <FilterToolbar
            searchValue={searchDraft}
            onSearchChange={(value) => {
              setSearchDraft(value);
              patch('search', value);
            }}
            searchPlaceholder="Search by name or slug..."
            searchLabel="Search species by name or slug"
            groups={groups}
            activeChips={activeChips}
            onClearAll={() => {
              setSearchDraft('');
              setSearchParams(new URLSearchParams());
            }}
            status={
              catalog.data ? (
                <span className="tabular text-sm text-ink-muted" aria-live="polite">
                  {visible.length} of {species.length} species
                </span>
              ) : undefined
            }
          />

          {catalog.isPending ? (
            <div className={GALLERY_GRID} aria-busy="true" aria-label="Loading the gallery">
              {Array.from({ length: 12 }, (_, index) => (
                <Skeleton key={index} className="aspect-[3/4] rounded-2xl" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={Images}
              title="No species match your filters"
              description="Try widening the search or clearing a filter."
            />
          ) : (
            <ul className={GALLERY_GRID} aria-label="Species">
              {visible.map((entry, index) => (
                <li key={entry.slug}>
                  <GallerySpeciesTile species={entry} search={detailSearch} priority={index < 4} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
