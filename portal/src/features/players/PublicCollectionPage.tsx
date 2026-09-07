/**
 * `/players/:playerId/collection` — a guild-mate's collection, read-only.
 *
 * This file is deliberately thin. It resolves the owner from the route and
 * hands off to the **same** `CollectionPage` the viewer's own collection uses,
 * in `public` mode — so the grid, the filters, the sort, the pagination and
 * every empty state are defined exactly once. A second collection page that
 * could drift from the first is the outcome this shape exists to prevent.
 *
 * Guild scope is not decided here and could not be: the API reads the selected
 * guild from the session and answers 404 for a player outside it, which is what
 * the not-found branch below renders.
 */
import { useParams } from 'react-router';

import { isPortalApiError } from '@/api/client';
import { usePublicPlayerProfile } from '@/api/hooks/usePlayerDirectory';
import { useSession } from '@/auth/useSession';
import { Skeleton } from '@/components/ui/skeleton';
import { CollectionPage } from '@/features/collection/CollectionPage';
import { NotFoundPage } from '@/features/notFound/NotFoundPage';

export function PublicCollectionPage() {
  const { session } = useSession();
  const { playerId: rawPlayerId } = useParams<{ playerId: string }>();
  const playerId = Number(rawPlayerId);
  const valid = Number.isInteger(playerId) && playerId > 0;

  // The owner's public profile supplies the heading name, and — because the
  // API refuses it for anyone outside the selected guild — doubles as the
  // access check the page renders against.
  const owner = usePublicPlayerProfile(session?.guildDbId, playerId);

  if (!valid || (owner.isError && isPortalApiError(owner.error) && owner.error.isNotFound)) {
    return (
      <NotFoundPage
        title="That collection isn't available"
        description="This trainer either doesn't exist or doesn't play in the server you have selected."
        backTo="/players"
        backLabel="Back to Players"
      />
    );
  }

  // Wait for the name before rendering the grid: the heading is the one thing
  // that tells a viewer whose collection they are looking at, and showing a
  // page of somebody's Waifumon under the word "Collection" is exactly the
  // ambiguity this feature must not create.
  if (!owner.data) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading this collection">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <CollectionPage mode="public" ownerPlayerId={playerId} ownerName={owner.data.displayName} />
  );
}
