/**
 * `/dashboard` — the landing page and visual anchor (plan §8.1).
 *
 * Four queries run in parallel and each owns its own region of the page: a
 * failing dex-stats call shows a compact inline error inside the progress card
 * while the hero and the catch strip render normally (§19 "partial responses").
 * There is no page-level loading branch, because there is no state in which the
 * whole page should disappear (§14).
 *
 * The page reads top-to-bottom as trainer → buddy → what you have been doing →
 * where you stand. Balances live inside the trainer card rather than in a band
 * of their own, and the collection figures are stated once, in one place.
 *
 * Deliberately absent, per §8.1's "known gaps":
 *   - an energy regeneration countdown — that is gameplay arithmetic (§16)
 *   - a "Today" recap tile — the only endpoint that serves one is scoped to a
 *     Discord channel, not to a player, and the Portal holds no channel id.
 *     See the note in `SummaryRow.tsx`; a placeholder would be worse than the
 *     omission, because the numbers would be wrong rather than missing.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useBuddy, useCollectionStats, useRecentCatches } from '@/api/hooks/useCollection';
import { useIdleTask } from '@/api/hooks/useIdlePrefetch';
import { usePlayerProfile } from '@/api/hooks/usePlayer';
import { getContentSpecies } from '@/api/content';
import { queryKeys } from '@/api/queryKeys';
import { CONTENT_POLICY } from '@/api/cachePolicy';
import { useCurrentSession } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { displayName } from '@/content/species';
import { QuickLaunch } from './QuickLaunch';
import { RecentCatches } from './RecentCatches';
import { CollectionProgressCard, CurrentLocationCard, BrowseCollectionCard } from './SummaryRow';
import { TrainerHero } from './TrainerHero';

export function DashboardPage() {
  const session = useCurrentSession();
  const queryClient = useQueryClient();

  const profile = usePlayerProfile(session.playerId);
  const buddy = useBuddy(session.playerId);
  const stats = useCollectionStats(session.playerId);
  const recent = useRecentCatches(session.playerId);

  // Priority 3. The species snapshot is effectively static (§13) and priming it
  // makes the Collection, Buddy and Encyclopedia pages instant — but no widget
  // on *this* page reads it, so it waits until the browser is idle rather than
  // competing with the queries first paint actually depends on. Verified still
  // load-bearing: `useContentSpecies` has four consumers across those routes.
  const prefetchSpecies = useCallback(() => {
    void queryClient.prefetchQuery({
      queryKey: queryKeys.contentSpecies(),
      queryFn: ({ signal }) => getContentSpecies({}, signal),
      ...CONTENT_POLICY,
    });
  }, [queryClient]);
  useIdleTask(prefetchSpecies);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your trainer, your buddy, and where your collection stands."
      />

      <div className="space-y-6 sm:space-y-8">
        {/*
          `&& !profile.data` is the §14 rule made mechanical: a *background*
          refresh that fails still has last-good data on screen, and replacing a
          working hero with an error banner because a refetch blipped is worse
          than showing slightly old numbers. The banner is for the case where
          there is genuinely nothing to show.
        */}
        {profile.isError && !profile.data && (
          <ErrorState
            variant="inline"
            error={profile.error}
            onRetry={() => void profile.refetch()}
            title="Couldn't load your trainer profile."
          />
        )}

        <TrainerHero
          playerId={session.playerId}
          displayName={session.displayName}
          avatarUrl={session.avatarUrl}
          profile={profile.data}
          buddy={buddy.data}
          buddyLoading={buddy.isPending}
        />

        <RecentCatches entries={recent.data} loading={recent.isPending} />

        {/*
          Two cards, not a three-column grid with a hole in it. `Today` is not
          reserved here — see `SummaryRow.tsx` — so the row is sized to what
          exists, and `Browse` fills the third column with a real destination
          rather than a placeholder for an unbuilt feature.
        */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <CollectionProgressCard
            stats={stats.data}
            error={stats.isError ? stats.error : null}
            onRetry={() => void stats.refetch()}
          />
          <CurrentLocationCard region={profile.data?.player.currentRegion} />
          <BrowseCollectionCard />
        </div>

        <QuickLaunch
          buddyName={buddy.isPending ? undefined : buddy.data ? displayName(buddy.data) : null}
        />
      </div>
    </>
  );
}
