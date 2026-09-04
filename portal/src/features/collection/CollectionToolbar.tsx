import { useEffect, useState } from 'react';

import type { Race, Rarity } from '@/api/types';
import { CardViewToggle, type CardView } from '@/components/media/CardViewToggle';
import {
  FilterToolbar,
  type ActiveFilterChip,
  type FilterGroup,
} from '@/components/waifumon/FilterToolbar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SORT_OPTIONS, type SortKey } from '@/content/species';
import { titleCase } from '@/lib/format';
import { RARITY_ORDER, rarityStyle } from '@/lib/rarity';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import type { CollectionParamsApi, Ownership } from './useCollectionParams';

const OWNERSHIP_OPTIONS: ReadonlyArray<{ value: Ownership; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'favorites', label: 'Favourites' },
  { value: 'buddy', label: 'Buddy' },
];

export interface CollectionToolbarProps {
  api: CollectionParamsApi;
  races: Race[];
  affinities: string[];
  /** Shows the quiet inline indicator while a background refetch runs (§14). */
  refreshing: boolean;
  view?: CardView | undefined;
  onViewChange?: ((view: CardView) => void) | undefined;
}

export function CollectionToolbar({
  api,
  races,
  affinities,
  refreshing,
  view,
  onViewChange,
}: CollectionToolbarProps) {
  const { params, setFilter, clearFilters } = api;

  const [searchDraft, setSearchDraft] = useState(params.search);
  const debouncedSearch = useDebouncedValue(searchDraft, 250);

  useEffect(() => {
    if (debouncedSearch !== params.search) setFilter({ search: debouncedSearch });
    // Only the debounced value should trigger a commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  useEffect(() => {
    setSearchDraft((draft) => (params.search === draft ? draft : params.search));
  }, [params.search]);

  const groups: FilterGroup[] = [
    {
      label: 'Rarity',
      options: RARITY_ORDER.map((rarity) => ({
        value: rarity,
        label: rarity,
        active: params.rarity === rarity,
        onSelect: () =>
          setFilter({ rarity: params.rarity === rarity ? null : (rarity as Rarity) }),
        style: { color: `var(${rarityStyle(rarity).cssVar})` },
      })),
    },
    {
      label: 'Type',
      options: races.map((race) => ({
        value: race,
        label: titleCase(race),
        active: params.race === race,
        onSelect: () => setFilter({ race: params.race === race ? null : race }),
      })),
    },
    {
      label: 'Affinity',
      options: affinities.map((affinity) => ({
        value: affinity,
        label: titleCase(affinity),
        active: params.affinity === affinity,
        onSelect: () => setFilter({ affinity: params.affinity === affinity ? null : affinity }),
      })),
    },
    {
      label: 'Show',
      options: OWNERSHIP_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        active: params.ownership === option.value,
        onSelect: () => setFilter({ ownership: option.value }),
      })),
    },
  ];

  const activeChips: ActiveFilterChip[] = [
    ...(params.search
      ? [
          {
            key: 'search',
            label: `Search: "${params.search}"`,
            onRemove: () => {
              setSearchDraft('');
              setFilter({ search: '' });
            },
          },
        ]
      : []),
    ...(params.rarity
      ? [
          {
            key: 'rarity',
            label: `Rarity: ${params.rarity}`,
            onRemove: () => setFilter({ rarity: null }),
          },
        ]
      : []),
    ...(params.race
      ? [
          {
            key: 'type',
            label: `Type: ${titleCase(params.race)}`,
            onRemove: () => setFilter({ race: null }),
          },
        ]
      : []),
    ...(params.affinity
      ? [
          {
            key: 'affinity',
            label: `Affinity: ${titleCase(params.affinity)}`,
            onRemove: () => setFilter({ affinity: null }),
          },
        ]
      : []),
    ...(params.ownership !== 'all'
      ? [
          {
            key: 'ownership',
            label:
              OWNERSHIP_OPTIONS.find((option) => option.value === params.ownership)?.label ??
              'Owned',
            onRemove: () => setFilter({ ownership: 'all' }),
          },
        ]
      : []),
  ];

  return (
    <FilterToolbar
      searchValue={searchDraft}
      onSearchChange={setSearchDraft}
      searchPlaceholder="Search your collection..."
      searchLabel="Search your collection"
      groups={groups}
      activeChips={activeChips}
      onClearAll={() => {
        setSearchDraft('');
        clearFilters();
      }}
      status={
        refreshing ? (
          <span className="text-xs text-ink-subtle" role="status">
            Refreshing...
          </span>
        ) : null
      }
      trailing={
        <>
          {view !== undefined && onViewChange !== undefined && (
            <CardViewToggle value={view} onChange={onViewChange} label="Collection tile view" />
          )}
          <Select
            value={params.sort}
            onValueChange={(value) => setFilter({ sort: value as SortKey })}
          >
            <SelectTrigger aria-label="Sort" className="w-[10.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      }
    />
  );
}
