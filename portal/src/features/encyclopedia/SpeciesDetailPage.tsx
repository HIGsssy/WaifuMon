/**
 * `/encyclopedia/:slug` — one species entry (plan §8.7).
 *
 * Works whether or not the player owns the species. Undiscovered entries keep
 * the silhouette, hide the description and lore, and say plainly that the entry
 * is locked — the rarity stays visible, because that is the hook.
 *
 * The "Discovered" panel links to the player's highest-level copy, which comes
 * from the same session-wide walk the encyclopedia grid uses.
 */
import { ArrowLeft, BookOpen, Lock } from 'lucide-react';
import { Link, useParams } from 'react-router';

import { isPortalApiError } from '@/api/client';
import { useContentSpecies, useContentSpeciesEntry } from '@/api/hooks/useContent';
import { useOwnedSlugs } from '@/api/hooks/useOwnedSlugs';
import { useCurrentSession } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { Artwork } from '@/components/media/Artwork';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AffinityPill, ContentRatingPill, TypePill } from '@/components/waifumon/Pills';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { relatedSpecies } from '@/content/species';
import { NotFoundPage } from '@/features/notFound/NotFoundPage';
import { speciesAsset } from '@/images/assets';
import { formatNumber } from '@/lib/format';
import { rarityStyle } from '@/lib/rarity';
import { ARTWORK_WIDTH } from '@/images/sizes';

export function SpeciesDetailPage() {
  const session = useCurrentSession();
  const { slug } = useParams<{ slug: string }>();

  const entry = useContentSpeciesEntry(slug);
  const allSpecies = useContentSpecies();
  const owned = useOwnedSlugs(session.playerId);

  const backLink = (
    <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
      <Link to="/encyclopedia">
        <ArrowLeft aria-hidden="true" />
        Back to Encyclopedia
      </Link>
    </Button>
  );

  if (entry.isError && isPortalApiError(entry.error) && entry.error.isNotFound) {
    return (
      <NotFoundPage
        title="No such species"
        description="There is no encyclopedia entry with that name."
        backTo="/encyclopedia"
        backLabel="Back to Encyclopedia"
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
          title="Couldn't load that species."
        />
      </>
    );
  }

  if (entry.isPending || !entry.data) {
    return (
      <>
        {backLink}
        <div
          className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_1fr]"
          aria-busy="true"
          aria-label="Loading this species"
        >
          <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
          <div className="space-y-4">
            <Skeleton className="h-10 w-56" />
            <Skeleton className="h-28 w-full rounded-2xl" />
            <Skeleton className="h-28 w-full rounded-2xl" />
          </div>
        </div>
      </>
    );
  }

  const species = entry.data;
  const ownedCount = owned.data?.countBySlug[species.slug] ?? 0;
  const bestCopy = owned.data?.bestCopyBySlug[species.slug];
  const discovered = ownedCount > 0;
  const rarity = rarityStyle(species.rarity);
  const related = allSpecies.data ? relatedSpecies(allSpecies.data, species) : [];

  return (
    <>
      {backLink}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-8">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <RarityGlowRing rarity={species.rarity} glow={discovered}>
            <Artwork
              asset={speciesAsset(species)}
              displayWidth={ARTWORK_WIDTH.hero}
              name={species.name}
              rarityLabel={rarity.label}
              silhouette={!discovered}
              priority
              aspect="aspect-[3/4]"
            />
          </RarityGlowRing>
        </div>

        <div className="space-y-5">
          <header>
            <h1 className="font-display text-3xl leading-tight text-ink sm:text-4xl">
              {discovered ? species.name : '???'}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <RarityBadge rarity={species.rarity} variant="full" />
              {discovered && (
                <>
                  <TypePill archetype={species.archetype} />
                  <AffinityPill affinity={species.affinity} />
                  <ContentRatingPill rating={species.contentRating} />
                </>
              )}
            </div>
          </header>

          {discovered ? (
            <Card>
              <p className="text-ink-muted">{species.description}</p>
              {species.tags.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {species.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-subtle"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          ) : (
            <Card className="border-dashed bg-surface/40">
              <div className="flex items-start gap-3">
                <div className="rounded-xl border border-border bg-surface-raised p-2.5 text-ink-subtle">
                  <Lock className="size-4" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="font-medium text-ink">Not yet discovered</h2>
                  <p className="mt-1 text-sm text-ink-muted">
                    Catch one in Discord to unlock this entry — the name, the art and the lore.
                  </p>
                </div>
              </div>
            </Card>
          )}

          <Card>
            <CardTitle>Your collection</CardTitle>
            {discovered ? (
              <div className="mt-4 space-y-3">
                <p className="tabular text-sm text-ink">
                  You own {formatNumber(ownedCount)} cop{ownedCount === 1 ? 'y' : 'ies'}.
                </p>
                {bestCopy !== undefined && (
                  <Button asChild variant="outline" size="sm">
                    <Link to={`/collection/${bestCopy}`} viewTransition>
                      View your highest-level copy
                    </Link>
                  </Button>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-muted">You have not caught this species yet.</p>
            )}
          </Card>

          {related.length > 0 && (
            <section aria-labelledby="related-heading">
              <h2
                id="related-heading"
                className="mb-1 text-sm font-medium tracking-wide text-ink-muted uppercase"
              >
                Related species
              </h2>
              <p className="mb-3 text-xs text-ink-subtle">
                Others sharing the {species.archetype} type.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {related.map((candidate) => {
                  const candidateOwned = (owned.data?.countBySlug[candidate.slug] ?? 0) > 0;
                  return (
                    <Link
                      key={candidate.slug}
                      to={`/encyclopedia/${candidate.slug}`}
                      className="lift block rounded-2xl"
                    >
                      <RarityGlowRing rarity={candidate.rarity}>
                        <Artwork
                          asset={speciesAsset(candidate)}
                          displayWidth={ARTWORK_WIDTH.strip}
                          name={candidate.name}
                          rarityLabel={rarityStyle(candidate.rarity).label}
                          silhouette={!candidateOwned}
                          aspect="aspect-[3/4]"
                        />
                        <div className="p-2.5">
                          <p className="truncate text-xs font-medium text-ink">
                            {candidateOwned ? candidate.name : '???'}
                          </p>
                        </div>
                      </RarityGlowRing>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          <p className="flex items-center gap-2 text-xs text-ink-subtle">
            <BookOpen className="size-3.5" aria-hidden="true" />
            Entries unlock as you catch each species in Discord.
          </p>
        </div>
      </div>
    </>
  );
}
