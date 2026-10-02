/**
 * The Gear Bag — one card per owned copy, never grouped, because two copies of
 * the same item can differ in roll, affix, favourite, lock and equipped state,
 * and each must stay individually actionable.
 *
 * Filtering, searching, sorting and paging all happen on the server; the page
 * holds one bounded page at a time and asks for the next by cursor. Search
 * matches the display name, so "Bad Decisions" finds "Combat Knife of Bad
 * Decisions" as surely as "Combat Knife" does.
 */
import { Backpack, SearchX } from 'lucide-react';

import { GEAR_BAG_SORTS, type GearBagQuery, type GearBagSort } from '@/api/equipment';
import { useGearBag } from '@/api/hooks/useEquipment';
import type { EquipmentItem, Rarity } from '@/api/types';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  FilterToolbar,
  type ActiveFilterChip,
  type FilterGroup,
} from '@/components/waifumon/FilterToolbar';
import { DismantleSelectCard } from './DismantleSelectCard';
import { EquipmentItemCard } from './EquipmentItemCard';
import { DEFAULT_FILTERS, type GearBagFilters } from './filters';
import { SLOTS, SLOT_LABEL } from './format';

/** The rarities random Equipment comes in today. */
const RARITY_FILTERS: readonly Rarity[] = ['N', 'R', 'SR'];

const SORT_LABEL: Readonly<Record<GearBagSort, string>> = {
  newest: 'Newest',
  oldest: 'Oldest',
  slot: 'Slot',
  rarity: 'Rarity',
  name: 'Name',
  multiplier: 'Multiplier',
  quality: 'Roll quality',
};

export function GearBag({
  playerId,
  filters,
  onFiltersChange,
  searchDraft,
  onSearchDraftChange,
  search,
  onOpen,
  selection,
}: {
  playerId: number;
  filters: GearBagFilters;
  onFiltersChange: (next: GearBagFilters) => void;
  searchDraft: string;
  onSearchDraftChange: (value: string) => void;
  search: string;
  onOpen: (item: EquipmentItem) => void;
  /**
   * Dismantle selection mode: every card becomes a checkbox (protected copies
   * disabled, with the reason) instead of opening the detail view.
   */
  selection?: { ids: ReadonlySet<number>; onToggle: (item: EquipmentItem) => void } | undefined;
}) {
  const query: GearBagQuery = {
    slot: filters.slot,
    rarity: filters.rarity,
    equipped: filters.equipped,
    favorite: filters.favorite,
    locked: filters.locked,
    search: search.trim() || undefined,
    sort: filters.sort,
  };
  const bag = useGearBag(playerId, query);
  const items = bag.data?.pages.flatMap((page) => page.items) ?? [];

  const set = (patch: Partial<GearBagFilters>) => onFiltersChange({ ...filters, ...patch });
  const option = (value: string, label: string, active: boolean, onSelect: () => void) => ({
    value,
    label,
    active,
    onSelect,
  });

  const groups: FilterGroup[] = [
    {
      label: 'Slot',
      options: [
        option('any', 'Any', filters.slot === undefined, () => set({ slot: undefined })),
        ...SLOTS.map((slot) =>
          option(slot, SLOT_LABEL[slot], filters.slot === slot, () => set({ slot })),
        ),
      ],
    },
    {
      label: 'Rarity',
      options: [
        option('any', 'Any', filters.rarity === undefined, () => set({ rarity: undefined })),
        ...RARITY_FILTERS.map((rarity) =>
          option(rarity, rarity, filters.rarity === rarity, () => set({ rarity })),
        ),
      ],
    },
    {
      label: 'Equipped',
      options: [
        option('any', 'Any', filters.equipped === undefined, () => set({ equipped: undefined })),
        option('yes', 'Equipped', filters.equipped === true, () => set({ equipped: true })),
        option('no', 'Unequipped', filters.equipped === false, () => set({ equipped: false })),
      ],
    },
    {
      label: 'Favorite',
      options: [
        option('any', 'Any', filters.favorite === undefined, () => set({ favorite: undefined })),
        option('yes', 'Favorite', filters.favorite === true, () => set({ favorite: true })),
      ],
    },
    {
      label: 'Locked',
      options: [
        option('any', 'Any', filters.locked === undefined, () => set({ locked: undefined })),
        option('yes', 'Locked', filters.locked === true, () => set({ locked: true })),
      ],
    },
  ];

  const chips: ActiveFilterChip[] = [
    ...(filters.slot
      ? [{ key: 'slot', label: SLOT_LABEL[filters.slot], onRemove: () => set({ slot: undefined }) }]
      : []),
    ...(filters.rarity
      ? [{ key: 'rarity', label: filters.rarity, onRemove: () => set({ rarity: undefined }) }]
      : []),
    ...(filters.equipped !== undefined
      ? [
          {
            key: 'equipped',
            label: filters.equipped ? 'Equipped' : 'Unequipped',
            onRemove: () => set({ equipped: undefined }),
          },
        ]
      : []),
    ...(filters.favorite
      ? [{ key: 'favorite', label: 'Favorite', onRemove: () => set({ favorite: undefined }) }]
      : []),
    ...(filters.locked
      ? [{ key: 'locked', label: 'Locked', onRemove: () => set({ locked: undefined }) }]
      : []),
  ];
  const narrowed = chips.length > 0 || search.trim() !== '';

  return (
    <section aria-labelledby="gear-bag-heading">
      <h2 id="gear-bag-heading" className="mb-2 font-display text-lg text-ink">
        Gear Bag
      </h2>
      <FilterToolbar
        searchValue={searchDraft}
        onSearchChange={onSearchDraftChange}
        searchLabel="Search your Gear Bag"
        searchPlaceholder="Search by name or suffix..."
        groups={groups}
        activeChips={chips}
        onClearAll={() => {
          onSearchDraftChange('');
          onFiltersChange({ ...DEFAULT_FILTERS, sort: filters.sort });
        }}
        status={
          bag.isFetching && !bag.isPending ? (
            <span className="text-xs text-ink-subtle" role="status">
              Refreshing...
            </span>
          ) : null
        }
        trailing={
          <Select
            value={filters.sort}
            onValueChange={(value) => set({ sort: value as GearBagSort })}
          >
            <SelectTrigger aria-label="Sort" className="w-[10.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GEAR_BAG_SORTS.map((sort) => (
                <SelectItem key={sort} value={sort}>
                  {SORT_LABEL[sort]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {bag.isError ? (
        <ErrorState
          error={bag.error}
          onRetry={() => void bag.refetch()}
          title="Couldn't load your Gear Bag."
        />
      ) : bag.isPending ? (
        <div
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
          aria-busy="true"
          aria-label="Loading your Gear Bag"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-2xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        narrowed ? (
          <EmptyState
            icon={SearchX}
            title="No gear matches"
            description="Nothing in your Gear Bag matches this search and these filters."
          />
        ) : (
          <EmptyState
            icon={Backpack}
            title="Your Gear Bag is empty"
            description="Equipment you earn lands here."
          />
        )
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Gear Bag items">
            {items.map((item) => (
              <li key={item.id}>
                {selection ? (
                  <DismantleSelectCard
                    item={item}
                    selected={selection.ids.has(item.id)}
                    onToggle={selection.onToggle}
                    className="h-full"
                  />
                ) : (
                  <EquipmentItemCard item={item} onOpen={onOpen} className="h-full" />
                )}
              </li>
            ))}
          </ul>
          {bag.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                disabled={bag.isFetchingNextPage}
                onClick={() => void bag.fetchNextPage()}
              >
                {bag.isFetchingNextPage ? 'Loading...' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
