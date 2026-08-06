/**
 * `/buddy` — the Waifumon at your side (plan §8.4).
 *
 * The same hero + progression treatment as the collection detail page, with the
 * Care card standing in for the Stats card. No "Enter Care" / "Exit Care" /
 * "Change Target" buttons: the game happens in Discord (§4).
 *
 * The two queries are independent — Care Mode has its own state even when no
 * buddy is set (it can target any owned copy), so a failing care read leaves
 * the buddy hero intact and vice versa (§19).
 */
import { Heart } from 'lucide-react';
import { Link } from 'react-router';

import { useBuddy } from '@/api/hooks/useCollection';
import { useCareState } from '@/api/hooks/usePlayerResources';
import { useContentSpecies } from '@/api/hooks/useContent';
import { useCurrentSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Artwork } from '@/components/media/Artwork';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AffectionMeter, XpBar } from '@/components/waifumon/Meters';
import { AffinityPill, TypePill } from '@/components/waifumon/Pills';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { displayName, subtitleFor } from '@/content/species';
import { speciesAsset } from '@/images/assets';
import { formatNumber } from '@/lib/format';
import { rarityStyle } from '@/lib/rarity';
import { CareCard } from './CareCard';

export function BuddyPage() {
  const session = useCurrentSession();
  const buddy = useBuddy(session.playerId);
  const care = useCareState(session.playerId);
  const species = useContentSpecies();

  // The care target need not be the buddy, so its name comes from whichever
  // source knows it: the care response embeds its own species row.
  const careTargetName = care.data?.target
    ? care.data.target.waifu.nickname?.trim() || care.data.target.species.name
    : null;

  return (
    <>
      <PageHeader title="Buddy" description="The Waifumon at your side." />

      {buddy.isError && (
        <ErrorState
          error={buddy.error}
          onRetry={() => void buddy.refetch()}
          title="Couldn't load your buddy."
          className="mb-6"
        />
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-8">
        <div className="lg:sticky lg:top-24 lg:self-start">
          {buddy.isPending ? (
            <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
          ) : buddy.data ? (
            <Link
              to={`/collection/${buddy.data.waifu.id}`}
              viewTransition
              className="lift block rounded-2xl outline-none"
            >
              <RarityGlowRing rarity={buddy.data.species.rarity} glow>
                <Artwork
                  asset={speciesAsset(buddy.data.species, buddy.data.waifu)}
                  name={buddy.data.species.name}
                  rarityLabel={rarityStyle(buddy.data.species.rarity).label}
                  priority
                  aspect="aspect-[3/4]"
                />
              </RarityGlowRing>
            </Link>
          ) : (
            <div className="aspect-[3/4] w-full">
              <EmptyState
                icon={Heart}
                title="No buddy set"
                description="Choose a companion in Discord and they will appear here."
                hint="A buddy earns affection and XP while Care Mode runs."
                className="h-full"
              />
            </div>
          )}
        </div>

        <div className="space-y-5">
          {buddy.data && (
            <>
              <header>
                <h2 className="font-display text-3xl leading-tight text-ink">
                  {displayName(buddy.data)}
                </h2>
                {subtitleFor(buddy.data) && (
                  <p className="mt-1 text-ink-muted">{subtitleFor(buddy.data)}</p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <RarityBadge rarity={buddy.data.species.rarity} variant="full" />
                  <TypePill archetype={buddy.data.species.archetype} />
                  <AffinityPill affinity={buddy.data.species.affinity} />
                </div>
              </header>

              <Card>
                <CardTitle>Progression</CardTitle>
                <div className="mt-4 space-y-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="tabular rounded-full border border-border bg-surface-raised px-2.5 py-0.5 text-sm font-medium text-ink">
                      Level {buddy.data.waifu.level}
                    </span>
                    <span className="tabular text-sm text-ink-muted">
                      {formatNumber(buddy.data.waifu.xp)} XP total
                    </span>
                  </div>
                  <XpBar progress={buddy.data.progress} />
                  <AffectionMeter affection={buddy.data.waifu.affection} />
                </div>
              </Card>
            </>
          )}

          {care.isError ? (
            <ErrorState
              variant="inline"
              error={care.error}
              onRetry={() => void care.refetch()}
              title="Couldn't load Care Mode state."
            />
          ) : care.data ? (
            <CareCard care={care.data} targetName={careTargetName} />
          ) : (
            <Skeleton className="h-64 w-full rounded-2xl" />
          )}

          {buddy.data && (
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline" size="sm">
                <Link to={`/collection/${buddy.data.waifu.id}`} viewTransition>
                  View full details
                </Link>
              </Button>
              {species.data && (
                <Button asChild variant="ghost" size="sm">
                  <Link to={`/encyclopedia/${buddy.data.species.slug}`}>View species</Link>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
