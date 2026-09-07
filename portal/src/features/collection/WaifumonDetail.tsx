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

import type { CollectionEntryView, ContentSpecies, OwnedEntry } from '@/api/types';
import type { CollectionMode } from '@/components/waifumon/WaifumonCard';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { AffectionMeter, XpBar } from '@/components/waifumon/Meters';
import { BuddyBonusCard } from '@/components/waifumon/BuddyBonusCard';
import { AffinityPill, ContentRatingPill, TypePill } from '@/components/waifumon/Pills';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RelatedSpeciesStrip } from '@/components/waifumon/RelatedSpeciesStrip';
import { buddyBonusFor, displayName, subtitleFor } from '@/content/species';
import { AppearanceGallery } from './AppearanceGallery';
import { WaifumonHero } from './WaifumonHero';
import { formatDate, formatNumber, formatRelative } from '@/lib/format';

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
  entry: CollectionEntryView;
  isBuddy: boolean;
  /**
   * Whose copy this is.
   *
   * `'public'` is a guild-mate's, viewed read-only. It changes three things,
   * each of which would otherwise be a real defect rather than a cosmetic one:
   *
   *   - **The progression card loses XP and affection.** The public payload
   *     does not carry them (`progress` is absent, and `affection` is not a
   *     field), so rendering that card would print `undefined`.
   *   - **The appearance gallery is omitted.** Its endpoint is self-only *and*
   *     it writes — reading a gallery acknowledges pending unlocks and appends
   *     an audit row. A viewer must not be able to touch another player's
   *     progression bookkeeping by opening their copy.
   *   - **Artwork resolves through the guild-scoped public route**, because the
   *     self-only one would refuse.
   *
   * Passed explicitly rather than inferred from `waifu.playerId`: the mode is
   * an authorization fact the route already knows, and re-deriving it in a
   * component from server data is how a viewer ends up treating somebody else's
   * copy as their own.
   */
  mode?: CollectionMode;
  /** The cached content snapshot, for the related-species strip. */
  allSpecies: ContentSpecies[] | undefined;
  /** Whether the backend serves rendered cards — gates the Art/Card switch. */
  cardsAvailable?: boolean | undefined;
}

export function WaifumonDetail({
  entry,
  isBuddy,
  mode = 'self',
  allSpecies,
  cardsAvailable = false,
}: WaifumonDetailProps) {
  const { waifu, species, progress } = entry;
  const isPublic = mode === 'public';
  const title = displayName(entry);
  const subtitle = subtitleFor(entry);
  // The bonus is a species property and rides on the content snapshot, not on
  // the seeded row embedded here — see `buddyBonusFor`.
  const buddyBonus = buddyBonusFor(allSpecies, species.slug);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr] lg:gap-8">
      {/*
        The hero carries the same view-transition name as the card that was
        clicked, so where the browser supports it the artwork animates from grid
        to hero instead of blinking out (§14). Nothing depends on that support.
      */}
      <div className="lg:sticky lg:top-24 lg:self-start">
        <WaifumonHero entry={entry} mode={mode} cardsAvailable={cardsAvailable} />
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
                {isPublic ? 'Their buddy' : 'Buddy'}
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
              {/*
                XP and affection are self-only. They are not hidden here — the
                public payload simply does not contain them, so this branch is
                reading what it was given rather than choosing what to withhold.
              */}
              {'xp' in waifu && (
                <span className="tabular text-sm text-ink-muted">
                  {formatNumber((waifu as OwnedEntry['waifu']).xp)} XP total
                </span>
              )}
            </div>
            {progress && <XpBar progress={progress} />}
            {'affection' in waifu && (
              <AffectionMeter affection={(waifu as OwnedEntry['waifu']).affection} />
            )}
            {isPublic && (
              <p className="text-xs text-ink-subtle">
                Experience and affection are private to {'their trainer'}.
              </p>
            )}
          </div>
        </Card>

        {/*
          Shown on every copy whose species grants one, labelled by whether it
          is actually in force: the question a player has in front of a copy is
          "what would equipping her do?", which needs the panel present even
          when she is not the Buddy. Absent entirely when there is no bonus.
        */}
        {buddyBonus && (
          <BuddyBonusCard bonus={buddyBonus} status={isBuddy ? 'active' : 'inactive'} />
        )}

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
              <span className="text-ink-muted">Appearance</span>
              <span className="text-ink">{waifu.selectedAppearance.name}</span>
            </div>
          </div>
          <p className="mt-4 border-t border-border pt-3 text-xs text-ink-subtle">
            The full capture history — attempts, items and odds behind this catch — is not exposed
            by the Platform API yet.
          </p>
        </Card>

        {/*
          Self only. The gallery endpoint is scoped to the session's own player
          *and* has a write side effect (it acknowledges pending unlocks and
          writes an audit row), so it must never be reached for somebody else's
          copy. Omitted rather than disabled: a disabled component still mounts
          its query.
        */}
        {!isPublic && (
          <AppearanceGallery playerId={waifu.playerId} waifuId={waifu.id} waifuName={title} />
        )}

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

        {/*
          Gated inside the strip, not here: the tiles resolve discovery from
          the ownership overlay themselves and silhouette anything not
          positively unlocked. This page previously drew its own copy of this
          rail with no gate, which is the leak the shared component removes.
        */}
        <RelatedSpeciesStrip subject={species} allSpecies={allSpecies} />
      </div>
    </div>
  );
}
