/**
 * `/achievements` — the player's own achievement wall (plan §7).
 *
 * A summary (unlocked-of-total plus a progress meter) over a category-filtered
 * grid of badges. Filtering is URL state and purely client-side: the backend
 * resolves every badge in one call and the toolbar narrows the already-loaded
 * set, so switching category never refetches.
 *
 * The page renders resolved state and computes no achievement rules — hidden,
 * locked badges arrive pre-concealed and are shown as-is.
 */
import { Trophy } from 'lucide-react';

import { useAchievements } from '@/api/hooks/useAchievements';
import type { AchievementCategory } from '@/api/types';
import { useCurrentSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatNumber, titleCase } from '@/lib/format';
import { AchievementCard } from './AchievementCard';
import { useAchievementsParams, type CategoryFilter } from './useAchievementsParams';

/** Category order for the filter row; only those with badges are rendered. */
const CATEGORY_ORDER: readonly AchievementCategory[] = [
  'hunting',
  'collection',
  'rarity',
  'buddy',
  'progression',
  'travel',
  'bosses',
  'special',
];

export function AchievementsPage() {
  const session = useCurrentSession();
  const { category, setCategory } = useAchievementsParams();
  const query = useAchievements(session.playerId);

  const summary = query.data?.summary;
  const achievements = query.data?.achievements ?? [];

  const presentCategories = CATEGORY_ORDER.filter((c) =>
    achievements.some((a) => a.category === c),
  );
  const filters: CategoryFilter[] = ['all', ...presentCategories];

  const visible =
    category === 'all'
      ? achievements
      : achievements.filter((a) => a.category === category);

  return (
    <>
      <PageHeader
        title="Achievements"
        description="Milestones you've earned across your journey."
      />

      {query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          title="Couldn't load your achievements."
        />
      ) : query.isPending ? (
        <div className="space-y-6">
          <Skeleton className="h-16 w-full rounded-2xl" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-2xl" />
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {summary && (
            <section
              aria-label="Achievement progress"
              className="rounded-2xl border border-border bg-surface-raised p-5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="tabular text-lg font-semibold text-ink">
                  {formatNumber(summary.unlocked)} / {formatNumber(summary.total)} Unlocked
                </p>
                <p className="text-sm text-ink-muted">{summary.completionPercent}%</p>
              </div>
              <Progress
                value={summary.completionPercent}
                aria-label="Overall achievement completion"
                className="mt-3 h-2"
                indicatorClassName="bg-accent"
              />
            </section>
          )}

          <div
            role="tablist"
            aria-label="Filter by category"
            className="flex flex-wrap gap-2"
          >
            {filters.map((filter) => {
              const active = filter === category;
              return (
                <button
                  key={filter}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setCategory(filter)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-sm transition-colors',
                    active
                      ? 'border-accent bg-accent-soft text-ink'
                      : 'border-border bg-surface-raised text-ink-muted hover:text-ink',
                  )}
                >
                  {filter === 'all' ? 'All' : titleCase(filter)}
                </button>
              );
            })}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={Trophy}
              title="Nothing here yet."
              description="No achievements in this category. Keep playing to earn your first badges."
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((achievement) => (
                <AchievementCard key={achievement.id} achievement={achievement} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
