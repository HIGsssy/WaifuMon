/**
 * `/players/:playerId/collection/:waifuId` — inspecting a guild-mate's copy.
 *
 * Routing, loading and error branching only; `WaifumonDetail` in `public` mode
 * owns the presentation, so the inspect view is the same component the viewer's
 * own copies use rather than a parallel one that could drift.
 *
 * Two hazards this file exists to keep apart, both of which are the same
 * mistake — treating a viewed copy as the viewer's own:
 *
 *   1. **The query.** `usePublicCollectionEntry` is keyed by guild *and* owner
 *      *and* copy, and reads the guild-scoped public resource. It shares no
 *      cache entry with `useCollectionEntry`, so no amount of navigation can
 *      make one answer for the other.
 *   2. **The buddy flag.** `isBuddy` comes off the entry the server sent — the
 *      *owner's* buddy — and never from the viewer's `useBuddy`, which is not
 *      called here at all.
 *
 * Authorization is the API's: a copy belonging to a player outside the
 * session's selected guild is a 404, identical to a copy that does not exist,
 * and both land on the not-found page below.
 */
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';

import { isPortalApiError } from '@/api/client';
import { useContentSpecies } from '@/api/hooks/useContent';
import { usePublicCollectionEntry } from '@/api/hooks/usePublicCollection';
import { usePublicPlayerProfile } from '@/api/hooks/usePlayerDirectory';
import { useSession } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NotFoundPage } from '@/features/notFound/NotFoundPage';
import { WaifumonDetail } from '@/features/collection/WaifumonDetail';

export function PublicWaifumonDetailPage() {
  const { session } = useSession();
  const params = useParams<{ playerId: string; waifuId: string }>();
  const playerId = Number(params.playerId);
  const waifuId = Number(params.waifuId);
  const validIds =
    Number.isInteger(playerId) && playerId > 0 && Number.isInteger(waifuId) && waifuId > 0;

  // Hooks run unconditionally and disable themselves on an unusable id, so the
  // early returns below cannot change hook order between renders.
  const entry = usePublicCollectionEntry(session?.guildDbId, playerId, waifuId);
  // Only for the heading and the back link's label. The profile is already
  // cached from the page the viewer arrived through, so this is normally free.
  const owner = usePublicPlayerProfile(session?.guildDbId, playerId);
  const species = useContentSpecies();

  const backTo = `/players/${playerId}/collection`;
  const backLink = (
    <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
      <Link to={backTo} viewTransition>
        <ArrowLeft aria-hidden="true" />
        Back to {owner.data ? `${owner.data.displayName}'s Collection` : 'Collection'}
      </Link>
    </Button>
  );

  if (!validIds) {
    return (
      <NotFoundPage
        title="Not a Waifumon"
        description="That address does not point at a Waifumon in this trainer's collection."
        backTo="/players"
        backLabel="Back to Players"
      />
    );
  }

  // 404 covers three cases the API deliberately makes indistinguishable: the
  // copy does not exist, it is not this player's, or this player is not in the
  // guild the session has selected. None of them is an error to shout about.
  if (entry.isError && isPortalApiError(entry.error) && entry.error.isNotFound) {
    return (
      <NotFoundPage
        title="That Waifumon isn't available"
        description="It may have been released, or this trainer may not be in the server you have selected."
        backTo="/players"
        backLabel="Back to Players"
      />
    );
  }

  if (entry.isError) {
    return (
      <>
        {backLink}
        <ErrorState
          error={entry.error}
          onRetry={() => void entry.refetch()}
          title="Couldn't load that Waifumon."
        />
      </>
    );
  }

  return (
    <>
      {backLink}
      {entry.data ? (
        <WaifumonDetail
          entry={entry.data}
          mode="public"
          // The *owner's* buddy, as the server reported it on this entry. The
          // viewer's own buddy query is deliberately not consulted here.
          isBuddy={entry.data.isBuddy}
          allSpecies={species.data}
          // No public card endpoint exists, so the card view is never offered.
          cardsAvailable={false}
        />
      ) : (
        <div
          className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr] lg:gap-8"
          aria-busy="true"
          aria-label="Loading this Waifumon"
        >
          <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
          <div className="space-y-4">
            <Skeleton className="h-10 w-56" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-28 w-full rounded-2xl" />
          </div>
        </div>
      )}
    </>
  );
}
