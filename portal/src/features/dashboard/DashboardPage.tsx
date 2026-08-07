/**
 * `/dashboard` — the landing page and visual anchor (plan §8.1).
 *
 * Three queries run in parallel and each owns its own region of the page: a
 * failing dex-stats call shows a compact inline error inside the progress card
 * while the hero and currencies render normally (§19 "partial responses").
 * There is no page-level loading branch, because there is no state in which the
 * whole page should disappear (§14).
 *
 * Deliberately absent, per §8.1's "known gaps":
 *   - an energy regeneration countdown — that is gameplay arithmetic (§16)
 *   - daily / quest tiles — the Guide presents those better, and a composite
 *     dashboard endpoint (§25.8) is the right way to feed them
 *   - a "Recent Captures" strip — needs §25.4
 */
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, LibraryBig } from 'lucide-react';
import { useCallback } from 'react';
import { Link } from 'react-router';

import { useBuddy, useCollectionStats } from '@/api/hooks/useCollection';
import { useIdleTask } from '@/api/hooks/useIdlePrefetch';
import { usePlayerProfile } from '@/api/hooks/usePlayer';
import { getContentSpecies } from '@/api/content';
import { queryKeys } from '@/api/queryKeys';
import { CONTENT_POLICY } from '@/api/cachePolicy';
import { useCurrentSession } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CurrencyTile } from '@/components/waifumon/CurrencyChip';
import { DexProgressRing } from '@/components/waifumon/DexProgressRing';
import { displayName } from '@/content/species';
import { formatNumber } from '@/lib/format';
import { QuickLaunch } from './QuickLaunch';
import { TrainerHero } from './TrainerHero';

export function DashboardPage() {
  const session = useCurrentSession();
  const queryClient = useQueryClient();

  const profile = usePlayerProfile(session.playerId);
  const buddy = useBuddy(session.playerId);
  const stats = useCollectionStats(session.playerId);

  // Priority 3. The species snapshot is effectively static (§13) and priming it
  // makes the Collection and Encyclopedia instant — but no widget on *this*
  // page reads it, so it waits until the browser is idle rather than competing
  // with the three queries first paint actually depends on.
  const prefetchSpecies = useCallback(() => {
    void queryClient.prefetchQuery({
      queryKey: queryKeys.contentSpecies(),
      queryFn: ({ signal }) => getContentSpecies({}, signal),
      ...CONTENT_POLICY,
    });
  }, [queryClient]);
  useIdleTask(prefetchSpecies);

  const currencies = profile.data?.currencies;

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

        <section aria-labelledby="balances-heading">
          <h2 id="balances-heading" className="sr-only">
            Balances
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {currencies ? (
              <>
                <CurrencyTile kind="energy" value={currencies.huntEnergy} caption="For hunting" />
                <CurrencyTile kind="waifubux" value={currencies.waifubux} caption="Shop currency" />
                <CurrencyTile kind="essence" value={currencies.essence} caption="Rare currency" />
              </>
            ) : (
              <>
                <Skeleton className="h-[5.5rem] rounded-2xl" />
                <Skeleton className="h-[5.5rem] rounded-2xl" />
                <Skeleton className="h-[5.5rem] rounded-2xl" />
              </>
            )}
          </div>
        </section>

        <Card>
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
            {stats.isError && !stats.data ? (
              <ErrorState
                variant="inline"
                error={stats.error}
                onRetry={() => void stats.refetch()}
                title="Couldn't load your collection progress."
                className="w-full"
              />
            ) : stats.data ? (
              <>
                <DexProgressRing
                  distinctSpecies={stats.data.distinctSpecies}
                  totalSpecies={stats.data.totalSpecies}
                />
                <div className="min-w-0 flex-1 text-center sm:text-left">
                  <h2 className="font-display text-xl text-ink">Collection progress</h2>
                  <p className="tabular mt-1 text-sm text-ink-muted">
                    {formatNumber(stats.data.owned)} owned ·{' '}
                    {formatNumber(stats.data.distinctSpecies)} of{' '}
                    {formatNumber(stats.data.totalSpecies)} species discovered
                  </p>
                  <Button asChild variant="outline" size="sm" className="mt-4">
                    <Link to="/collection">
                      <LibraryBig aria-hidden="true" />
                      Browse collection
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Skeleton className="size-[8.25rem] shrink-0 rounded-full" />
                <div className="w-full flex-1 space-y-3">
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-4 w-64" />
                  <Skeleton className="h-9 w-40 rounded-lg" />
                </div>
              </>
            )}
          </div>
        </Card>

        <QuickLaunch
          ownedCount={stats.data?.owned}
          distinctSpecies={stats.data?.distinctSpecies}
          totalSpecies={stats.data?.totalSpecies}
          buddyName={buddy.isPending ? undefined : buddy.data ? displayName(buddy.data) : null}
        />
      </div>
    </>
  );
}
