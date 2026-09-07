/**
 * `/leaderboards` — guild-scoped rankings (plan §13).
 *
 * A metric selector over a ranked list of the current guild's players. The
 * product rule is visible in what is *absent*: there is no score column, no
 * "points", no "N behind" — the backend returns ranks only (plan §10), and this
 * page has no metric value to render even if it wanted to.
 *
 * A row links to the player's existing public profile via `playerId`, reusing
 * the same-guild profile flow rather than inventing a new one.
 */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Trophy } from 'lucide-react';

import { useLeaderboard } from '@/api/hooks/useLeaderboards';
import type { LeaderboardEntry, LeaderboardMetric } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Artwork } from '@/components/media/Artwork';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { avatarAsset } from '@/images/assets';
import { ARTWORK_WIDTH } from '@/images/sizes';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

interface MetricTab {
  metric: LeaderboardMetric;
  label: string;
}

/** Player-facing category names mapped to their internal metric. */
const METRICS: readonly MetricTab[] = [
  { metric: 'trainer', label: 'Top Trainers' },
  { metric: 'collector', label: 'Master Collectors' },
  { metric: 'hunter', label: 'Elite Hunters' },
  { metric: 'devoted', label: 'Most Devoted' },
  { metric: 'legendary', label: 'Legendary Hunters' },
];

function isMetric(value: string | null): value is LeaderboardMetric {
  return value !== null && METRICS.some((m) => m.metric === value);
}

function LeaderboardRow({ entry }: { entry: LeaderboardEntry }) {
  return (
    <li>
      <Link
        to={`/players/${entry.playerId}`}
        viewTransition
        className={cn(
          'flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors',
          entry.isMe
            ? 'border-accent bg-accent-soft'
            : 'border-border bg-surface-raised hover:bg-surface-sunken',
        )}
      >
        <span className="tabular w-8 shrink-0 text-center text-sm font-semibold text-ink-muted">
          {entry.rank}
        </span>
        <Artwork
          asset={avatarAsset(entry.playerId, entry.avatarUrl)}
          displayWidth={ARTWORK_WIDTH.avatar}
          name={entry.displayName}
          aspect="aspect-square"
          className="size-9 shrink-0 rounded-full border border-border"
        />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">
          {entry.displayName}
          {entry.isMe && <span className="ml-2 text-xs text-ink-subtle">You</span>}
        </span>
      </Link>
    </li>
  );
}

export function LeaderboardsPage() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();

  const metric: LeaderboardMetric = useMemo(() => {
    const raw = params.get('metric');
    return isMetric(raw) ? raw : 'trainer';
  }, [params]);

  const query = useLeaderboard(session?.guildDbId, metric);
  const entries = query.data?.entries ?? [];
  const me = query.data?.me ?? null;
  const meInPage = entries.some((e) => e.isMe);

  return (
    <>
      <PageHeader
        title="Leaderboards"
        description="How you rank against the trainers in your server."
      />

      <div className="space-y-6">
        <div role="tablist" aria-label="Leaderboard category" className="flex flex-wrap gap-2">
          {METRICS.map(({ metric: m, label }) => {
            const active = m === metric;
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() =>
                  setParams(
                    (prev) => {
                      const copy = new URLSearchParams(prev);
                      if (m === 'trainer') copy.delete('metric');
                      else copy.set('metric', m);
                      return copy;
                    },
                    { replace: true },
                  )
                }
                className={cn(
                  'rounded-full border px-3 py-1 text-sm transition-colors',
                  active
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-border bg-surface-raised text-ink-muted hover:text-ink',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        {query.isError ? (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            title="Couldn't load the leaderboard."
          />
        ) : query.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title="No rankings yet."
            description="Once trainers in your server start playing, they'll appear here."
          />
        ) : (
          <Card flush className="overflow-hidden p-3">
            <ol className="space-y-1.5">
              {entries.map((entry) => (
                <LeaderboardRow key={entry.playerId} entry={entry} />
              ))}
            </ol>

            {me && !meInPage && (
              <div className="mt-3 border-t border-border pt-3">
                <div className="flex items-center gap-3 rounded-xl border border-accent bg-accent-soft px-3 py-2.5">
                  <span className="tabular w-8 shrink-0 text-center text-sm font-semibold text-ink">
                    {formatNumber(me.rank)}
                  </span>
                  <span className="flex-1 font-medium text-ink">
                    You
                    <span className="ml-2 text-xs text-ink-subtle">
                      not in the top {entries.length}
                    </span>
                  </span>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
