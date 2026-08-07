/**
 * `/profile` — the trainer, and how far they have come (plan §8.8).
 *
 * The placeholder tiles for Achievements, Seasonal Progress and Leaderboards
 * are not filler: they are reserved slots, so the layout does not shift when
 * those features land (§25.12). Leaderboards in particular are a deliberate
 * service-layer gap — every read service is scoped to one player, and a
 * cross-player ranking is a gameplay-design decision, not an adapter change.
 *
 * "Total captures" is deliberately absent. `owned` counts *active* copies, so
 * presenting it as a lifetime capture count would be wrong the moment a player
 * releases anything. A real lifetime figure needs an API field.
 */
import { CalendarRange, Heart, LibraryBig, Trophy } from 'lucide-react';
import { Link } from 'react-router';

import { useBuddy, useCollectionStats } from '@/api/hooks/useCollection';
import { usePlayerProfile } from '@/api/hooks/usePlayer';
import { useCurrentSession } from '@/auth/useSession';
import { ComingSoonTile } from '@/components/layout/ComingSoonTile';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Artwork } from '@/components/media/Artwork';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { DexProgressRing } from '@/components/waifumon/DexProgressRing';
import { displayName } from '@/content/species';
import { avatarAsset, speciesAsset } from '@/images/assets';
import { formatDate, formatNumber, formatRelative } from '@/lib/format';
import { rarityStyle } from '@/lib/rarity';
import { ARTWORK_WIDTH } from '@/images/sizes';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-sunken p-4">
      <dt className="text-xs tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className="tabular mt-1 text-xl font-semibold text-ink">{value}</dd>
    </div>
  );
}

export function ProfilePage() {
  const session = useCurrentSession();
  const profile = usePlayerProfile(session.playerId);
  const stats = useCollectionStats(session.playerId);
  const buddy = useBuddy(session.playerId);

  const player = profile.data?.player;
  const currencies = profile.data?.currencies;

  return (
    <>
      <PageHeader title="Trainer Profile" description="Who you are, and how far you have come." />

      {profile.isError && (
        <ErrorState
          error={profile.error}
          onRetry={() => void profile.refetch()}
          title="Couldn't load your profile."
          className="mb-6"
        />
      )}

      <div className="space-y-6">
        <Card>
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <Artwork
              asset={avatarAsset(session.playerId, session.avatarUrl)}
              displayWidth={ARTWORK_WIDTH.avatar}
              name={session.displayName}
              aspect="aspect-square"
              priority
              className="size-20 shrink-0 rounded-full border border-border"
            />
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-2xl text-ink sm:text-3xl">{session.displayName}</h2>
              {player ? (
                <p className="mt-1 text-sm text-ink-muted">
                  Level {player.level} · {formatNumber(player.xp)} XP · trainer since{' '}
                  {formatDate(player.createdAt)}
                </p>
              ) : (
                <Skeleton className="mt-2 h-4 w-64" />
              )}
              {player?.lastHuntAt && (
                <p className="mt-1 text-xs text-ink-subtle">
                  Last hunt {formatRelative(player.lastHuntAt)}
                </p>
              )}
            </div>
            {stats.data && (
              <DexProgressRing
                distinctSpecies={stats.data.distinctSpecies}
                totalSpecies={stats.data.totalSpecies}
                size={104}
              />
            )}
          </div>
        </Card>

        <section aria-labelledby="lifetime-heading">
          <h2
            id="lifetime-heading"
            className="mb-3 text-sm font-medium tracking-wide text-ink-muted uppercase"
          >
            Statistics
          </h2>
          {stats.isError ? (
            <ErrorState
              variant="inline"
              error={stats.error}
              onRetry={() => void stats.refetch()}
              title="Couldn't load your collection statistics."
            />
          ) : stats.data && player && currencies ? (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Owned" value={formatNumber(stats.data.owned)} />
              <Stat label="Species" value={formatNumber(stats.data.distinctSpecies)} />
              <Stat
                label="Of total"
                value={`${formatNumber(stats.data.distinctSpecies)}/${formatNumber(stats.data.totalSpecies)}`}
              />
              <Stat label="Level" value={formatNumber(player.level)} />
              <Stat label="WaifuBux" value={formatNumber(currencies.waifubux)} />
              <Stat label="Essence" value={formatNumber(currencies.essence)} />
            </dl>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-[5.25rem] rounded-xl" />
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-ink-subtle">
            "Owned" counts your active Waifumon. A lifetime capture total — including released
            copies — is not exposed by the Platform API yet.
          </p>
        </section>

        <section aria-labelledby="buddy-heading">
          <h2
            id="buddy-heading"
            className="mb-3 text-sm font-medium tracking-wide text-ink-muted uppercase"
          >
            Active buddy
          </h2>
          <Card flush className="overflow-hidden">
            {buddy.isPending ? (
              <Skeleton className="h-28 w-full" />
            ) : buddy.data ? (
              <Link
                to={`/collection/${buddy.data.waifu.id}`}
                viewTransition
                className="flex items-center gap-4 p-4 transition-colors hover:bg-surface-raised"
              >
                <RarityGlowRing rarity={buddy.data.species.rarity} className="w-20 shrink-0">
                  <Artwork
                    asset={speciesAsset(buddy.data.species, buddy.data.waifu)}
                    displayWidth={ARTWORK_WIDTH.strip}
                    name={buddy.data.species.name}
                    rarityLabel={rarityStyle(buddy.data.species.rarity).label}
                    aspect="aspect-[3/4]"
                  />
                </RarityGlowRing>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{displayName(buddy.data)}</p>
                  <p className="tabular text-sm text-ink-muted">
                    Level {buddy.data.waifu.level} · {buddy.data.waifu.affection} affection
                  </p>
                  <div className="mt-2">
                    <RarityBadge rarity={buddy.data.species.rarity} />
                  </div>
                </div>
              </Link>
            ) : (
              <div className="flex items-center gap-3 p-5 text-sm text-ink-muted">
                <Heart className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                No buddy set — choose one in Discord.
              </div>
            )}
          </Card>
        </section>

        <section aria-labelledby="soon-heading">
          <h2
            id="soon-heading"
            className="mb-3 text-sm font-medium tracking-wide text-ink-muted uppercase"
          >
            Coming later
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <ComingSoonTile
              icon={Trophy}
              title="Achievements"
              description="Milestones and badges, once the game services model them."
            />
            <ComingSoonTile
              icon={CalendarRange}
              title="Seasonal progress"
              description="Season tracks and rewards are not modelled yet."
            />
            <ComingSoonTile
              icon={LibraryBig}
              title="Leaderboards"
              description="Cross-player rankings need a service the API deliberately does not have."
            />
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline" size="sm">
            <Link to="/collection">Browse collection</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/buddy">Visit your buddy</Link>
          </Button>
        </div>
      </div>
    </>
  );
}
