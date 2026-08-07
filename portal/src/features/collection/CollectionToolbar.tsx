/**
 * The Collection toolbar (plan §8.2).
 *
 * Sticky as the grid scrolls, so filters stay reachable without a trip to the
 * top. On phones the chips collapse into a popover — a full chip row would eat
 * the first screenful of artwork, and §2 says the art wins.
 *
 * **Honesty note.** Only `rarity` is a server-side filter; the endpoint accepts
 * nothing else today. Everything else narrows the 25 rows already on screen,
 * and the caption under the toolbar says so rather than implying the whole
 * collection was searched. Server-side filters are filed as §25.6.
 */
import { SlidersHorizontal, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { Rarity } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import { cn } from '@/lib/cn';
import type { CollectionParamsApi, Ownership } from './useCollectionParams';

const OWNERSHIP_OPTIONS: ReadonlyArray<{ value: Ownership; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'favorites', label: 'Favourites' },
  { value: 'buddy', label: 'Buddy' },
];

/** A filter chip. Toggling an active chip clears that filter. */
function Chip({
  active,
  onClick,
  children,
  style,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'border-transparent bg-ink text-ink-inverse'
          : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
      )}
      style={active ? undefined : style}
    >
      {children}
    </button>
  );
}

function FilterGroups({
  api,
  archetypes,
  affinities,
}: {
  api: CollectionParamsApi;
  archetypes: string[];
  affinities: string[];
}) {
  const { params, setFilter } = api;

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-xs tracking-wide text-ink-muted uppercase">Rarity</legend>
        <div className="flex flex-wrap gap-1.5">
          {RARITY_ORDER.map((rarity) => (
            <Chip
              key={rarity}
              active={params.rarity === rarity}
              onClick={() =>
                setFilter({ rarity: params.rarity === rarity ? null : (rarity as Rarity) })
              }
              style={{ color: `var(${rarityStyle(rarity).cssVar})` }}
            >
              {rarity}
            </Chip>
          ))}
        </div>
      </fieldset>

      {archetypes.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-xs tracking-wide text-ink-muted uppercase">Type</legend>
          <div className="flex flex-wrap gap-1.5">
            {archetypes.map((archetype) => (
              <Chip
                key={archetype}
                active={params.archetype === archetype}
                onClick={() =>
                  setFilter({ archetype: params.archetype === archetype ? null : archetype })
                }
              >
                {titleCase(archetype)}
              </Chip>
            ))}
          </div>
        </fieldset>
      )}

      {affinities.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-xs tracking-wide text-ink-muted uppercase">Affinity</legend>
          <div className="flex flex-wrap gap-1.5">
            {affinities.map((affinity) => (
              <Chip
                key={affinity}
                active={params.affinity === affinity}
                onClick={() =>
                  setFilter({ affinity: params.affinity === affinity ? null : affinity })
                }
              >
                {titleCase(affinity)}
              </Chip>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset>
        <legend className="mb-2 text-xs tracking-wide text-ink-muted uppercase">Show</legend>
        <div className="flex flex-wrap gap-1.5">
          {OWNERSHIP_OPTIONS.map((option) => (
            <Chip
              key={option.value}
              active={params.ownership === option.value}
              onClick={() => setFilter({ ownership: option.value })}
            >
              {option.label}
            </Chip>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export interface CollectionToolbarProps {
  api: CollectionParamsApi;
  archetypes: string[];
  affinities: string[];
  /** Shows the quiet inline indicator while a background refetch runs (§14). */
  refreshing: boolean;
}

export function CollectionToolbar({
  api,
  archetypes,
  affinities,
  refreshing,
}: CollectionToolbarProps) {
  const { params, setFilter, clearFilters, hasFilters } = api;

  // The input is instant; the URL write is debounced (§15).
  const [searchDraft, setSearchDraft] = useState(params.search);
  const debouncedSearch = useDebouncedValue(searchDraft, 250);

  useEffect(() => {
    if (debouncedSearch !== params.search) setFilter({ search: debouncedSearch });
    // Only the debounced value should trigger a commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  // Keep the box in step when the URL changes from elsewhere (back button,
  // "clear filters"), without fighting the user mid-keystroke.
  useEffect(() => {
    setSearchDraft((draft) => (params.search === draft ? draft : params.search));
  }, [params.search]);

  return (
    <div className="sticky top-14 z-30 -mx-4 mb-5 border-b border-border bg-canvas/90 px-4 py-3 backdrop-blur-md sm:top-16 sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
            aria-hidden="true"
          />
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Search this page…"
            aria-label="Search the current page of your collection"
            className="pl-9"
          />
        </div>

        {/* Phones: one button opens every filter group. */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="default" className="lg:hidden">
              <SlidersHorizontal aria-hidden="true" />
              Filters
              {hasFilters && (
                <Badge variant="solid" className="px-1.5 py-0">
                  on
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="max-h-[70vh] overflow-y-auto">
            <FilterGroups api={api} archetypes={archetypes} affinities={affinities} />
          </PopoverContent>
        </Popover>

        <div className="ml-auto flex items-center gap-2">
          {refreshing && (
            <span className="text-xs text-ink-subtle" role="status">
              Refreshing…
            </span>
          )}
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X aria-hidden="true" />
              Clear
            </Button>
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
        </div>
      </div>

      {/* Desktop: the groups sit inline, no popover needed. */}
      <div className="mt-3 hidden lg:block">
        <FilterGroups api={api} archetypes={archetypes} affinities={affinities} />
      </div>
    </div>
  );
}
