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
 * Server-side filtering is `rarity` only; the rest narrows the current page in
 * memory and the caption says so. Widening that is an API change (§25.6), not a
 * cleverer client (§16).
 */
import { LibraryBig, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';

import { COLLECTION_PAGE_SIZE } from '@/api/collection';
import { useBuddy, useCollection } from '@/api/hooks/useCollection';
import { useCurrentSession } from '@/auth/useSession';
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
  const { params } = api;

  const collection = useCollection({
    playerId: session.playerId,
    page: params.page,
    rarity: params.rarity ?? undefined,
  });
  const buddy = useBuddy(session.playerId);

  const entries = useMemo(() => collection.data?.items ?? [], [collection.data]);

  const visible = useMemo(
    () =>
      sortEntries(
        filterEntries(
          entries,
          {
            search: params.search,
            archetype: params.archetype,
            affinity: params.affinity,
            ownership: params.ownership,
          },
          buddy.data?.waifu.id ?? null,
        ),
        params.sort,
      ),
    [
      entries,
      params.search,
      params.archetype,
      params.affinity,
      params.ownership,
      params.sort,
      buddy.data,
    ],
  );

  const archetypes = useMemo(() => distinctValues(entries, 'archetype'), [entries]);
  const affinities = useMemo(() => distinctValues(entries, 'affinity'), [entries]);

  const total = collection.data?.total ?? 0;
  const pageSize = collection.data?.pageSize ?? COLLECTION_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = collection.data?.page ?? params.page;

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
        archetypes={archetypes}
        affinities={affinities}
        refreshing={refreshing}
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
      ) : visible.length === 0 ? (
        <EmptyState
          icon={LibraryBig}
          title="Nothing matches those filters"
          description="No Waifumon on this page match what you are looking for."
          hint="Filters other than rarity apply to the current page only — try clearing them or turning the page."
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
              />
            ))}
          </div>

          {/*
            Honest caption: the count on screen is a page, not the collection,
            whenever a client-side filter is narrowing it.
          */}
          {visible.length !== entries.length && (
            <p className="tabular mt-4 text-center text-xs text-ink-subtle">
              Showing {visible.length} of {entries.length} on this page
            </p>
          )}

          {totalPages > 1 && (
            <nav
              className="mt-8 flex items-center justify-center gap-3"
              aria-label="Collection pages"
            >
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => api.setPage(currentPage - 1)}
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
                onClick={() => api.setPage(currentPage + 1)}
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
