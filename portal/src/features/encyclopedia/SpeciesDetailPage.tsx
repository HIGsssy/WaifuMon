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
import { useState } from 'react';
import { ArrowLeft, BookOpen, Lock } from 'lucide-react';
import { Link, useParams } from 'react-router';

import { isPortalApiError } from '@/api/client';
import { usePlatformCapabilities } from '@/api/hooks/useCapabilities';
import { useContentSpecies, useContentSpeciesEntry } from '@/api/hooks/useContent';
import { useSpeciesDiscovery } from '@/api/hooks/useSpeciesDiscovery';
import { useCurrentSession } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { Artwork } from '@/components/media/Artwork';
import { SpeciesArtwork } from '@/components/media/SpeciesArtwork';
import { CardViewer } from '@/components/media/CardViewer';
import { CardViewToggle, type CardView } from '@/components/media/CardViewToggle';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { BuddyBonusCard } from '@/components/waifumon/BuddyBonusCard';
import { AffinityPill, ContentRatingPill, TypePill } from '@/components/waifumon/Pills';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { RelatedSpeciesStrip } from '@/components/waifumon/RelatedSpeciesStrip';
import { speciesLabel } from '@/content/species';
import { NotFoundPage } from '@/features/notFound/NotFoundPage';
import { speciesCardAsset } from '@/images/assets';
import { formatNumber } from '@/lib/format';
import { rarityStyle } from '@/lib/rarity';
import { ARTWORK_WIDTH } from '@/images/sizes';

export function SpeciesDetailPage() {
  const session = useCurrentSession();
  const { slug } = useParams<{ slug: string }>();
  const capabilities = usePlatformCapabilities();
  const [view, setView] = useState<CardView>('art');
  const [viewerOpen, setViewerOpen] = useState(false);

  const entry = useContentSpeciesEntry(slug);
  const allSpecies = useContentSpecies();
  const discovery = useSpeciesDiscovery(session.playerId);

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

  // The ownership overlay gates this page for the same reason it gates the
  // grid: until it lands, every entry would render as undiscovered, and
  // silhouetting a species the player already owns is the one wrong answer.
  // `isSettled` rather than `!isPending` — a placeholder overlay belonging to
  // the *previous* player is neither pending nor an answer about this one.
  if (entry.isPending || !entry.data || !discovery.isSettled) {
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
  // Past the gate above, so these are answers about *this* player rather than
  // absent-means-zero defaults. `discovered` stays tri-state all the way into
  // the components that gate on it — nothing here collapses it to a boolean.
  const ownedCount = discovery.copiesOf(species.slug) ?? 0;
  const bestCopy = discovery.bestCopyOf(species.slug);
  const discovered = discovery.isDiscovered(species.slug);
  const rarity = rarityStyle(species.rarity);

  /**
   * Card mode is offered only for a species the player has actually
   * discovered. The encyclopedia hides an undiscovered species behind a
   * silhouette, and a rendered card would show her artwork in full — the
   * toggle would become a way to walk around the spoiler.
   */
  const cardsOffered = capabilities.cards && discovered === true;
  const showingCard = cardsOffered && view === 'card';
  const cardAsset = speciesCardAsset(species);

  return (
    <>
      {backLink}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-8">
        <div className="space-y-3 lg:sticky lg:top-24 lg:self-start">
          <RarityGlowRing rarity={species.rarity} glow={discovered === true}>
            {showingCard ? (
              <button
                type="button"
                onClick={() => setViewerOpen(true)}
                className="block w-full cursor-zoom-in rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label={`Enlarge ${species.name} card`}
              >
                <Artwork
                  asset={cardAsset}
                  displayWidth={ARTWORK_WIDTH.hero}
                  name={`${species.name} card`}
                  rarityLabel={rarity.label}
                  priority
                  // The card's own proportions, not the artwork tile's 3:4.
                  aspect="aspect-[5/7]"
                  fit="contain"
                />
              </button>
            ) : (
              <SpeciesArtwork
                species={species}
                discovered={discovered}
                displayWidth={ARTWORK_WIDTH.hero}
                rarityLabel={rarity.label}
                priority
                aspect="aspect-[3/4]"
              />
            )}
          </RarityGlowRing>

          {cardsOffered && (
            <CardViewToggle
              value={showingCard ? 'card' : 'art'}
              onChange={setView}
              label="Species image view"
            />
          )}

          {showingCard && viewerOpen && (
            <CardViewer
              open={viewerOpen}
              onOpenChange={setViewerOpen}
              asset={cardAsset}
              name={species.name}
              rarityLabel={rarity.label}
            />
          )}
        </div>

        <div className="space-y-5">
          <header>
            <h1 className="font-display text-3xl leading-tight text-ink sm:text-4xl">
              {speciesLabel(species, discovered)}
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

          {/*
            Gated on discovery for the same reason the description is: the
            bonus is authored lore as much as it is a rule, and an undiscovered
            entry deliberately gives away nothing but the rarity. Most species
            grant no bonus at all, and those render no section rather than an
            empty one.
          */}
          {discovered && species.buddyBonus && <BuddyBonusCard bonus={species.buddyBonus} />}

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

          {/*
            The same rail the Collection copy page shows, and the same
            component — the two used to be separate copies that had drifted
            apart on exactly this question of gating.
          */}
          <RelatedSpeciesStrip subject={species} allSpecies={allSpecies.data} />

          <p className="flex items-center gap-2 text-xs text-ink-subtle">
            <BookOpen className="size-3.5" aria-hidden="true" />
            Entries unlock as you catch each species in Discord.
          </p>
        </div>
      </div>
    </>
  );
}
