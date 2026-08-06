/**
 * The body of `/collection/:waifuId` (plan §8.3), split from the page so the
 * page keeps only routing, loading and error branches and this file keeps only
 * presentation.
 *
 * Three cards are deliberately placeholders rather than invented content:
 * capture history, combat stats and evolution. Each is a documented API or
 * content-model gap (§25.7, §25.11), and §16 is explicit that a placeholder is
 * the right answer — a fabricated stat block would be worse than an empty one.
 */
import { BookOpen, Heart, History, Sparkles, Star, Swords, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';

import type { ContentSpecies, OwnedEntry } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { AffectionMeter, XpBar } from '@/components/waifumon/Meters';
import { AffinityPill, ContentRatingPill, TypePill } from '@/components/waifumon/Pills';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { heroTransitionName } from '@/components/waifumon/WaifumonCard';
import { displayName, relatedSpecies, subtitleFor } from '@/content/species';
import { speciesAsset } from '@/images/assets';
import { formatDate, formatNumber, formatRelative } from '@/lib/format';
import { rarityStyle } from '@/lib/rarity';

/** A reserved slot for data the platform does not model yet (§16). */
function PlaceholderCard({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <Card className="border-dashed bg-surface/40">
      <div className="flex items-start gap-3">
        <div className="rounded-xl border border-border bg-surface-raised p-2.5 text-ink-subtle">
          <Icon className="size-4" aria-hidden="true" />
        </div>
        <div>
          <h3 className="font-medium text-ink">{title}</h3>
          <p className="mt-1 text-sm text-ink-muted">{body}</p>
        </div>
      </div>
    </Card>
  );
}

export interface WaifumonDetailProps {
  entry: OwnedEntry;
  isBuddy: boolean;
  /** The cached content snapshot, for the related-species strip. */
  allSpecies: ContentSpecies[] | undefined;
}

export function WaifumonDetail({ entry, isBuddy, allSpecies }: WaifumonDetailProps) {
  const { waifu, species, progress } = entry;
  const rarity = rarityStyle(species.rarity);
  const title = displayName(entry);
  const subtitle = subtitleFor(entry);
  const related = allSpecies ? relatedSpecies(allSpecies, species) : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr] lg:gap-8">
      {/*
        The hero carries the same view-transition name as the card that was
        clicked, so where the browser supports it the artwork animates from grid
        to hero instead of blinking out (§14). Nothing depends on that support.
      */}
      <div className="lg:sticky lg:top-24 lg:self-start">
        <RarityGlowRing rarity={species.rarity} glow>
          <Artwork
            asset={speciesAsset(species, waifu)}
            name={species.name}
            rarityLabel={rarity.label}
            priority
            aspect="aspect-[3/4]"
            viewTransitionName={heroTransitionName(waifu.id)}
          />
        </RarityGlowRing>
      </div>

      <div className="space-y-5">
        <header>
          <h1 className="font-display text-3xl leading-tight text-ink sm:text-4xl">{title}</h1>
          {subtitle && <p className="mt-1 text-ink-muted">{subtitle}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <RarityBadge rarity={species.rarity} variant="full" />
            <TypePill archetype={species.archetype} />
            <AffinityPill affinity={species.affinity} />
            <ContentRatingPill rating={species.contentRating} />
            {waifu.isFavorite && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                <Star className="size-3 fill-current" aria-hidden="true" />
                Favourite
              </span>
            )}
            {isBuddy && (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-800 dark:text-rose-200">
                <Heart className="size-3 fill-current" aria-hidden="true" />
                Buddy
              </span>
            )}
          </div>
        </header>

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

        <Card>
          <CardTitle>Progression</CardTitle>
          <div className="mt-4 space-y-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="tabular rounded-full border border-border bg-surface-raised px-2.5 py-0.5 text-sm font-medium text-ink">
                Level {waifu.level}
              </span>
              <span className="tabular text-sm text-ink-muted">
                {formatNumber(waifu.xp)} XP total
              </span>
            </div>
            <XpBar progress={progress} />
            <AffectionMeter affection={waifu.affection} />
          </div>
        </Card>

        <Card>
          <CardTitle>Capture</CardTitle>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-ink-muted">Caught</span>
              <span className="text-ink">
                {formatDate(waifu.caughtAt)}{' '}
                <span className="text-ink-subtle">({formatRelative(waifu.caughtAt)})</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-ink-muted">Variant</span>
              <span className="text-ink">{waifu.variant}</span>
            </div>
          </div>
          <p className="mt-4 border-t border-border pt-3 text-xs text-ink-subtle">
            The full capture history — attempts, items and odds behind this catch — is not exposed
            by the Platform API yet.
          </p>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          <PlaceholderCard
            icon={Swords}
            title="Stats"
            body="No stats yet — combat is not modelled in Waifumon."
          />
          <PlaceholderCard
            icon={Sparkles}
            title="Evolution"
            body="Evolution is not part of the content model yet."
          />
          <PlaceholderCard
            icon={History}
            title="Capture history"
            body="Coming once the API exposes the attempt chain for a catch."
          />
          <Card>
            <CardTitle>Species</CardTitle>
            <p className="mt-3 text-sm text-ink-muted">
              Read the encyclopedia entry for {species.name}.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-4">
              <Link to={`/encyclopedia/${species.slug}`}>
                <BookOpen aria-hidden="true" />
                View species
              </Link>
            </Button>
          </Card>
        </div>

        {related.length > 0 && (
          <section aria-labelledby="related-heading">
            <h2
              id="related-heading"
              className="mb-1 text-sm font-medium tracking-wide text-ink-muted uppercase"
            >
              Related species
            </h2>
            {/* Same-archetype neighbours: a presentation heuristic, labelled (§26). */}
            <p className="mb-3 text-xs text-ink-subtle">
              Others sharing the {species.archetype} type.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {related.map((candidate) => (
                <Link
                  key={candidate.slug}
                  to={`/encyclopedia/${candidate.slug}`}
                  className="lift block rounded-2xl"
                >
                  <RarityGlowRing rarity={candidate.rarity}>
                    <Artwork
                      asset={speciesAsset(candidate)}
                      name={candidate.name}
                      rarityLabel={rarityStyle(candidate.rarity).label}
                      aspect="aspect-[3/4]"
                    />
                    <div className="p-2.5">
                      <p className="truncate text-xs font-medium text-ink">{candidate.name}</p>
                    </div>
                  </RarityGlowRing>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
