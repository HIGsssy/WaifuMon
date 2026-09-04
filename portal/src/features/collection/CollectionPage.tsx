/**
 * `/collection` — the flagship (plan §8.2).
 *
 * Reads like a collector's binder rather than a table: 2 columns on a phone
 * rising to 5 on a wide display, large art, rarity rings visible before the
 * images land.
 *
 * The two behaviours that make it feel alive:
 *
 *   - **The grid never blanks.** `keepPreviousData` on the list query means a
 *     page turn or a rarity change keeps the previous cards on screen while the
 *     next set loads; only a cold first load shows skeletons (§14).
 *   - **Filters are URL state.** Back and forward move through filter history,
 *     and a filtered view is a link you can send (§7).
 *
 * The API is page-based, so the Portal walks the owned collection first, then
 * filters and sorts the complete dataset before slicing the requested UI page.
 *
 * ## Art / Card
 *
 * The grid can draw either raw artwork or the server-rendered collectible card
 * for each owned copy. **Art is the default and stays the default**: cards are
 * opt-in for this rollout, so nobody's first page load turns into twenty-five
 * card requests, and the switch is only offered when `/v1/capabilities` says
 * the backend can render them. With the renderer off there is no control and no
 * card request — the grid is exactly what it was before this existed.
 */
import { LibraryBig, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { COLLECTION_PAGE_SIZE } from '@/api/collection';
import { useBuddy, useEntireCollection } from '@/api/hooks/useCollection';
import { usePlatformCapabilities } from '@/api/hooks/useCapabilities';
import { useCurrentSession } from '@/auth/useSession';
import type { Race } from '@/api/types';
import type { CardView } from '@/components/media/CardViewToggle';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { WaifumonCard, WaifumonCardSkeleton } from '@/components/waifumon/WaifumonCard';
import { distinctValues, filterEntries, sortEntries } from '@/content/species';
import { formatNumber } from '@/lib/format';
import { CollectionToolbar } from './CollectionToolbar';
import { useCollectionParams } from './useCollectionParams';

const GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 2xl:grid-cols-5';

/** The first row is above the fold on most viewports and loads eagerly (§15). */
const EAGER_CARDS = 4;

export function CollectionPage() {
  const session = useCurrentSession();
  const api = useCollectionParams();
  const { params, setPage } = api;

  const capabilities = usePlatformCapabilities();
  // Art, always, until the player says otherwise. Deliberately component state
  // rather than URL state: the filters are a view of the collection worth
  // sharing in a link, and which image style someone prefers is not.
  const [view, setView] = useState<CardView>('art');
  // A capability that flips off mid-session (an API restart) takes the grid
  // back to artwork rather than leaving a page of broken images behind.
  const cardsAvailable = capabilities.cards;
  const tileView: CardView = cardsAvailable ? view : 'art';

  const collection = useEntireCollection(session.playerId);
  const buddy = useBuddy(session.playerId);

  const entries = useMemo(() => collection.data ?? [], [collection.data]);

  const filtered = useMemo(
    () =>
      sortEntries(
        filterEntries(
          entries,
          {
            rarity: params.rarity,
            search: params.search,
            race: params.race,
            affinity: params.affinity,
            ownership: params.ownership,
          },
          buddy.data?.waifu.id ?? null,
        ),
        params.sort,
      ),
    [
      entries,
      params.rarity,
      params.search,
      params.race,
      params.affinity,
      params.ownership,
      params.sort,
      buddy.data,
    ],
  );

  const races = useMemo(() => distinctValues(entries, 'race') as Race[], [entries]);
  const affinities = useMemo(() => distinctValues(entries, 'affinity'), [entries]);

  const total = entries.length;
  const pageSize = COLLECTION_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(params.page, totalPages);
  const visible = useMemo(
    () => filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [currentPage, filtered, pageSize],
  );

  useEffect(() => {
    if (params.page !== currentPage) setPage(currentPage);
  }, [currentPage, params.page, setPage]);

  // A cold load has nothing cached; a background refresh keeps the old grid.
  const showSkeletons = collection.isPending;
  const refreshing = collection.isFetching && !collection.isPending;

  return (
    <>
      <PageHeader
        title="Collection"
        description="Every Waifumon you have caught."
        actions={
          collection.data ? (
            <span className="tabular text-sm text-ink-muted">{formatNumber(total)} owned</span>
          ) : undefined
        }
      />

      <CollectionToolbar
        api={api}
        races={races}
        affinities={affinities}
        refreshing={refreshing}
        {...(cardsAvailable ? { view: tileView, onViewChange: setView } : {})}
      />

      {collection.isError ? (
        <ErrorState
          error={collection.error}
          onRetry={() => void collection.refetch()}
          title="Couldn't load your collection."
        />
      ) : showSkeletons ? (
        <div className={GRID} aria-busy="true" aria-label="Loading your collection">
          {Array.from({ length: 10 }, (_, index) => (
            <WaifumonCardSkeleton key={index} />
          ))}
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={LibraryBig}
          title="Your collection is empty"
          description="No Waifumon yet — the hunt starts in Discord."
          hint={
            <>
              Head to Discord and try <code className="font-mono text-ink">/waifumon hunt</code>.
            </>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={LibraryBig}
          title="Nothing matches those filters"
          description="No Waifumon match what you are looking for."
          hint="Try clearing a filter or widening your search."
        />
      ) : (
        <>
          <div className={GRID}>
            {visible.map((entry, index) => (
              <WaifumonCard
                key={entry.waifu.id}
                entry={entry}
                isBuddy={entry.waifu.id === buddy.data?.waifu.id}
                priority={index < EAGER_CARDS}
                view={tileView}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <nav
              className="mt-8 flex items-center justify-center gap-3"
              aria-label="Collection pages"
            >
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft aria-hidden="true" />
                Previous
              </Button>
              <span className="tabular text-sm text-ink-muted" aria-live="polite">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= totalPages}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
                <ChevronRight aria-hidden="true" />
              </Button>
            </nav>
          )}
        </>
      )}
    </>
  );
}
