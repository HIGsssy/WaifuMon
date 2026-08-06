/**
 * `/collection/:waifuId` — one owned copy (plan §8.3).
 *
 * This file owns only routing, loading and error branching; `WaifumonDetail`
 * owns the presentation. All hooks run unconditionally at the top so the early
 * returns below cannot change hook order between renders.
 */
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';

import { isPortalApiError } from '@/api/client';
import { useBuddy, useCollectionEntry } from '@/api/hooks/useCollection';
import { useContentSpecies } from '@/api/hooks/useContent';
import { useCurrentSession } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NotFoundPage } from '@/features/notFound/NotFoundPage';
import { WaifumonDetail } from './WaifumonDetail';

function DetailSkeleton() {
  return (
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
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    </div>
  );
}

export function WaifumonDetailPage() {
  const session = useCurrentSession();
  const { waifuId: rawWaifuId } = useParams<{ waifuId: string }>();
  const waifuId = Number(rawWaifuId);

  // `useCollectionEntry` disables itself for a non-positive id, so an unusable
  // URL costs no request while the hooks still run in a stable order.
  const entry = useCollectionEntry(session.playerId, waifuId);
  const buddy = useBuddy(session.playerId);
  const species = useContentSpecies();

  const backLink = (
    <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
      <Link to="/collection" viewTransition>
        <ArrowLeft aria-hidden="true" />
        Back to Collection
      </Link>
    </Button>
  );

  if (!Number.isInteger(waifuId) || waifuId <= 0) {
    return (
      <NotFoundPage
        title="Not a Waifumon"
        description="That address does not point at a Waifumon in your collection."
        backTo="/collection"
        backLabel="Back to Collection"
      />
    );
  }

  // A 404 here means "you do not own this copy" — a page-level not-found with a
  // link back to the parent list, not an error banner (§19).
  if (entry.isError && isPortalApiError(entry.error) && entry.error.isNotFound) {
    return (
      <NotFoundPage
        title="You do not own that Waifumon"
        description="It may have been released, or it belongs to another trainer."
        backTo="/collection"
        backLabel="Back to Collection"
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
          isBuddy={entry.data.waifu.id === buddy.data?.waifu.id}
          allSpecies={species.data}
        />
      ) : (
        <DetailSkeleton />
      )}
    </>
  );
}
