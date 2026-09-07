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
 *
 * ## Self and public are one renderer
 *
 * `/collection` and `/players/:playerId/collection` are the same component in
 * two modes. That is deliberate, and it is the whole reason the public view
 * cannot drift: the filters, the sort, the pagination, the empty states and the
 * grid are defined once. What differs is stated in exactly two places — the
 * query the data comes from, and the props below.
 *
 * In `public` mode the page fetches through the guild-scoped public resource,
 * which the API authorizes against the session's selected guild before it reads
 * a row. Nothing here filters by guild, and nothing here could: the viewer's
 * browser never names one.
 *
 * **There are no ownership actions to disable.** The Portal is a read-only
 * surface — it has no release, favourite, set-buddy, essence or care controls
 * anywhere, in either mode, because those are game actions that live in
 * Discord. The one component with a write path adjacent to it, the appearance
 * gallery, is omitted in public mode by `WaifumonDetail`. A test asserts the
 * absence rather than trusting this paragraph.
 */
import { LibraryBig, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { COLLECTION_PAGE_SIZE } from '@/api/collection';
import { useBuddy, useEntireCollection } from '@/api/hooks/useCollection';
import { useEntirePublicCollection } from '@/api/hooks/usePublicCollection';
import { usePlatformCapabilities } from '@/api/hooks/useCapabilities';
import { useCurrentSession, useSession } from '@/auth/useSession';
import type { CollectionEntryView, Race } from '@/api/types';
import type { CollectionMode } from '@/components/waifumon/WaifumonCard';
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

export interface CollectionPageProps {
  /** `'self'` (default) is the acting player's own collection. */
  mode?: CollectionMode;
  /** Public mode only: whose collection this is. */
  ownerPlayerId?: number | undefined;
  /** Public mode only: the owner's display name, for the heading. */
  ownerName?: string | undefined;
}

export function CollectionPage({
  mode = 'self',
  ownerPlayerId,
  ownerName,
}: CollectionPageProps = {}) {
  const session = useCurrentSession();
  const { session: rawSession } = useSession();
  const isPublic = mode === 'public';
  const api = useCollectionParams();
  const { params, setPage } = api;

  const capabilities = usePlatformCapabilities();
  // Art, always, until the player says otherwise. Deliberately component state
  // rather than URL state: the filters are a view of the collection worth
  // sharing in a link, and which image style someone prefers is not.
  const [view, setView] = useState<CardView>('art');
  // A capability that flips off mid-session (an API restart) takes the grid
  // back to artwork rather than leaving a page of broken images behind.
  // Cards are self-only — there is no public card endpoint, so public mode
  // neither offers the switch nor requests one.
  const cardsAvailable = capabilities.cards && !isPublic;
  const tileView: CardView = cardsAvailable ? view : 'art';

  // Both hooks are called unconditionally so hook order is stable, and each
  // disables itself in the mode it does not serve. That is what keeps the
  // viewer's own collection out of the public view's cache and vice versa —
  // the two use entirely different query keys, one keyed by the viewer's
  // player id and one by the guild plus the *owner's*.
  const selfCollection = useEntireCollection(session.playerId, { enabled: !isPublic });
  const publicCollection = useEntirePublicCollection({
    guildDbId: rawSession?.guildDbId,
    playerId: ownerPlayerId,
    enabled: isPublic,
  });
  const collection = isPublic ? publicCollection : selfCollection;

  // The viewer's own buddy is irrelevant to somebody else's grid; in public
  // mode the owner's buddy arrives on each entry as `isBuddy` instead.
  const buddy = useBuddy(session.playerId, { enabled: !isPublic });

  const entries = useMemo<CollectionEntryView[]>(() => collection.data ?? [], [collection.data]);

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
          // Which copy the "Buddy" filter means: the viewer's own in self mode,
          // the owner's in public mode. Never crossed.
          isPublic
            ? (entries.find((entry) => entry.isBuddy)?.waifu.id ?? null)
            : (buddy.data?.waifu.id ?? null),
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
      isPublic,
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
        title={isPublic && ownerName ? `${ownerName}'s Collection` : 'Collection'}
        description={
          isPublic
            ? `A read-only view of ${ownerName ?? 'this trainer'}'s Waifumon.`
            : 'Every Waifumon you have caught.'
        }
        actions={
          collection.data ? (
            <span className="tabular text-sm text-ink-muted">{formatNumber(total)} owned</span>
          ) : undefined
        }
      />

      <CollectionToolbar
        api={api}
        {...(isPublic && ownerName ? { ownerName } : {})}
        races={races}
        affinities={affinities}
        refreshing={refreshing}
        {...(cardsAvailable ? { view: tileView, onViewChange: setView } : {})}
      />

      {collection.isError ? (
        <ErrorState
          error={collection.error}
          onRetry={() => void collection.refetch()}
          title={isPublic ? "Couldn't load this collection." : "Couldn't load your collection."}
        />
      ) : showSkeletons ? (
        <div className={GRID} aria-busy="true" aria-label={isPublic ? 'Loading this collection' : 'Loading your collection'}>
          {Array.from({ length: 10 }, (_, index) => (
            <WaifumonCardSkeleton key={index} />
          ))}
        </div>
      ) : total === 0 ? (
        isPublic ? (
          <EmptyState
            icon={LibraryBig}
            title="No Waifumon yet"
            description={`${ownerName ?? 'This trainer'} has not caught anything yet.`}
          />
        ) : (
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
        )
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
                mode={mode}
                isBuddy={isPublic ? entry.isBuddy === true : entry.waifu.id === buddy.data?.waifu.id}
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
