/**
 * `/players/:playerId` — another trainer's public profile.
 *
 * ## Why this exists rather than reusing `/profile`
 *
 * `ProfilePage` is *self* by construction, not by convention: it reads
 * `session.playerId` and calls `/players/{id}/profile`, `/collection/stats` and
 * `/collection/buddy` — three player-scoped endpoints the Platform API refuses
 * for anyone but the session's own player, and two of which return data
 * (WaifuBux, Essence) that must never be shown for somebody else. Pointing it
 * at another id would not have been a smaller change; it would have been a
 * larger one, and one that had to *remove* things.
 *
 * So the split is by audience: `/profile` is the self view and is unchanged,
 * and this is the public-within-guild view, backed by the single
 * `/v1/players/{id}/public` resource that decides server-side what a guild-mate
 * may see. This page renders that payload and asks for nothing else — it cannot
 * show more than the API sends, because it has nothing else to show.
 *
 * Access is the API's call, not this component's: a player outside the
 * session's selected guild is a 404, indistinguishable from an id that does not
 * exist, and lands on the same "not available" state below.
 */
import { ArrowLeft, Heart, LibraryBig, MapPin, Users } from 'lucide-react';
import { Link, useParams } from 'react-router';

import { usePublicPlayerProfile } from '@/api/hooks/usePlayerDirectory';
import type { Rarity } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Artwork } from '@/components/media/Artwork';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { DexProgressRing } from '@/components/waifumon/DexProgressRing';
import { avatarAsset } from '@/images/assets';
import { ARTWORK_WIDTH } from '@/images/sizes';
import { formatDate, formatNumber, formatRelative } from '@/lib/format';
import { isPortalApiError } from '@/api/client';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-sunken p-4">
      <dt className="text-xs tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className="tabular mt-1 text-xl font-semibold text-ink">{value}</dd>
    </div>
  );
}

export function PublicProfilePage() {
  const { session } = useSession();
  const params = useParams();
  const playerId = Number(params.playerId);
  const profile = usePublicPlayerProfile(session?.guildDbId, playerId);

  const player = profile.data;
  // A 404 here is the access rule doing its job as often as it is a typo — the
  // API answers the same way for "no such player" and "not in your server", on
  // purpose — so both render as unavailable rather than as an error.
  const unavailable =
    (profile.isError && isPortalApiError(profile.error) && profile.error.isNotFound) ||
    !Number.isInteger(playerId) ||
    playerId <= 0;

  return (
    <>
      <PageHeader
        title={player?.displayName ?? 'Trainer'}
        description="A trainer in your server."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/players">
              <ArrowLeft className="size-4" aria-hidden="true" />
              All players
            </Link>
          </Button>
        }
      />

      {unavailable ? (
        <EmptyState
          icon={Users}
          title="That profile isn't available."
          description="This trainer either doesn't exist or doesn't play in the server you have selected."
          hint={<Link to="/players" className="underline">Back to Players</Link>}
        />
      ) : profile.isError ? (
        <ErrorState
          error={profile.error}
          onRetry={() => void profile.refetch()}
          title="Couldn't load this profile."
        />
      ) : !player ? (
        <div className="space-y-6">
          <Skeleton className="h-32 w-full rounded-2xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      ) : (
        <div className="space-y-6">
          <Card>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <Artwork
                asset={avatarAsset(player.id, player.avatarUrl)}
                displayWidth={ARTWORK_WIDTH.avatar}
                name={player.displayName}
                aspect="aspect-square"
                priority
                className="size-20 shrink-0 rounded-full border border-border"
              />
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-2xl text-ink sm:text-3xl">{player.displayName}</h2>
                <p className="mt-1 text-sm text-ink-muted">
                  Level {player.level} · trainer since {formatDate(player.createdAt)}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-subtle">
                  <MapPin className="size-3.5" aria-hidden="true" />
                  {player.currentRegion.name} · last active {formatRelative(player.lastActiveAt)}
                </p>
              </div>
              <DexProgressRing
                distinctSpecies={player.collection.distinctSpecies}
                totalSpecies={player.collection.totalSpecies}
                size={104}
              />
            </div>
          </Card>

          <section aria-labelledby="public-stats-heading">
            <h2
              id="public-stats-heading"
              className="mb-3 text-sm font-medium tracking-wide text-ink-muted uppercase"
            >
              Statistics
            </h2>
            {/* Counts only. Currencies, XP and the collection itself are not in
                this payload and are not fetched — see the file header. */}
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Level" value={formatNumber(player.level)} />
              <Stat label="Owned" value={formatNumber(player.collection.owned)} />
              <Stat
                label="Species"
                value={`${formatNumber(player.collection.distinctSpecies)}/${formatNumber(player.collection.totalSpecies)}`}
              />
            </dl>
          </section>

          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline" size="sm">
              <Link to={`/players/${player.id}/collection`} viewTransition>
                <LibraryBig className="size-4" aria-hidden="true" />
                View Collection
              </Link>
            </Button>
          </div>

          <section aria-labelledby="public-achievements-heading">
            <h2
              id="public-achievements-heading"
              className="mb-3 text-sm font-medium tracking-wide text-ink-muted uppercase"
            >
              Achievements
            </h2>
            <Card>
              <p className="tabular text-sm text-ink-muted">
                <span className="font-semibold text-ink">
                  {formatNumber(player.achievements.unlocked)}
                </span>{' '}
                of {formatNumber(player.achievements.total)} unlocked
              </p>
              {player.achievements.recent.length > 0 ? (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {/* Only unlocked, non-hidden-locked badges ever reach this
                      list — the API omits everything else. */}
                  {player.achievements.recent.map((badge) => (
                    <li
                      key={badge.id}
                      className="flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken px-3 py-1 text-sm text-ink"
                    >
                      <span aria-hidden="true">{badge.icon ?? '🏅'}</span>
                      <span>{badge.name}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-ink-subtle">No achievements earned yet.</p>
              )}
            </Card>
          </section>

          <section aria-labelledby="public-buddy-heading">
            <h2
              id="public-buddy-heading"
              className="mb-3 text-sm font-medium tracking-wide text-ink-muted uppercase"
            >
              Active buddy
            </h2>
            <Card flush className="overflow-hidden">
              {player.buddy ? (
                <div className="flex items-center gap-4 p-4">
                  <Artwork
                    asset={{ ...player.buddy.assetId, baseArtwork: true }}
                    displayWidth={ARTWORK_WIDTH.strip}
                    name={player.buddy.speciesName}
                    aspect="aspect-[3/4]"
                    className="w-20 shrink-0 overflow-hidden rounded-lg border border-border"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink">{player.buddy.speciesName}</p>
                    <p className="tabular text-sm text-ink-muted">Level {player.buddy.level}</p>
                    <div className="mt-2">
                      <RarityBadge rarity={player.buddy.rarity as Rarity} />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 p-5 text-sm text-ink-muted">
                  <Heart className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                  No buddy set.
                </div>
              )}
            </Card>
          </section>
        </div>
      )}
    </>
  );
}
