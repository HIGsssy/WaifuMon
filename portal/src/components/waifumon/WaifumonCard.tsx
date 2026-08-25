/**
 * WaifumonCard — the Collection's unit of presentation (plan §8.2).
 *
 * The design bar is a collector's binder, not a table: artwork takes the top
 * ~70% of the tile, the rarity ring frames it, and the metadata strip below is
 * quiet enough that the art stays the loudest thing on the card.
 *
 * Behaviours worth knowing about:
 *   - The whole card is one link, so keyboard focus is a single stop and the
 *     hit target on touch is the entire tile.
 *   - Hover and focus share the same lift (§18: "card hover states have
 *     equivalent focus states"), and `prefers-reduced-motion` removes it.
 *   - `viewTransitionName` hands the artwork to the detail page's hero, so the
 *     art stays on screen across the navigation (§14).
 *
 * ## Art vs Card
 *
 * The tile draws one of two genuinely different images. `view: 'art'` is the
 * raw character artwork and remains the default. `view: 'card'` is the
 * server-rendered collectible — frame, rarity overlay, race and affinity icons,
 * her level shield and the CAUGHT badge — addressed by the **owned** route, so
 * it carries this copy's real level and equipped look rather than a species
 * preview's.
 *
 * A card that fails to load falls back to that copy's artwork, per tile. Not to
 * the silhouette (there is a better image right here), and emphatically not by
 * switching the whole grid back to Art: one species with a pre-composed source
 * image is content debt, and it must cost exactly one tile.
 */
import { Heart, Star } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import type { OwnedEntry } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { displayName, subtitleFor } from '@/content/species';
import { ownedCardAsset, speciesAsset } from '@/images/assets';
import { rarityStyle } from '@/lib/rarity';
import { cn } from '@/lib/cn';
import { ARTWORK_WIDTH } from '@/images/sizes';
import type { CardView } from '@/components/media/CardViewToggle';

export interface WaifumonCardProps {
  entry: OwnedEntry;
  /** True for the copy currently set as the player's buddy. */
  isBuddy?: boolean;
  /** Above-the-fold tiles load eagerly; the rest stay lazy (§15). */
  priority?: boolean;
  /**
   * Which image the tile draws. `'art'` — the raw character artwork — is the
   * default, and is what a grid shows unless the player has opted into cards
   * *and* the backend says it can render them.
   */
  view?: CardView;
  className?: string;
}

/**
 * The card's own proportions (1500 x 2250 master). Artwork tiles stay 3:4.
 *
 * Naming the true ratio rather than reusing the artwork box is what keeps a
 * `contain` fit from letterboxing every card in the grid.
 */
const CARD_ASPECT = 'aspect-[2/3]';

/** Stable across the card → detail navigation; must be unique on the page. */
export function heroTransitionName(waifuId: number): string {
  return `waifu-art-${waifuId}`;
}

export function WaifumonCard({
  entry,
  isBuddy = false,
  priority = false,
  view = 'art',
  className,
}: WaifumonCardProps) {
  const { waifu, species } = entry;
  const title = displayName(entry);
  const subtitle = subtitleFor(entry);
  const rarity = rarityStyle(species.rarity);

  // Per-tile, and never reset by a mode switch: a card that 404s once will 404
  // again, so re-requesting it on every toggle would be a guaranteed-failing
  // request each time.
  const [cardFailed, setCardFailed] = useState(false);
  const showingCard = view === 'card' && !cardFailed;

  return (
    <Link
      to={`/collection/${waifu.id}`}
      // Opts this navigation into `document.startViewTransition` where the
      // browser supports it; a no-op everywhere else (§14).
      viewTransition
      className={cn('lift group block rounded-2xl', className)}
      aria-label={`${title}, ${rarity.label}, level ${waifu.level}`}
    >
      <RarityGlowRing rarity={species.rarity} className="h-full">
        <div className="flex h-full flex-col">
          <div className="relative">
            {showingCard ? (
              <Artwork
                // The owned route, not the species preview: her level and the
                // look she is wearing are the server's to know, and sending the
                // Portal's copy of either would be stale the moment she levels
                // up in Discord.
                asset={ownedCardAsset(waifu.playerId, entry)}
                // The tile's CSS width. The resolver applies device pixel ratio
                // and picks 256 or 512 from it — the grid never names a bucket.
                displayWidth={ARTWORK_WIDTH.gridTile}
                name={`${species.name} card`}
                rarityLabel={rarity.label}
                priority={priority}
                aspect={CARD_ASPECT}
                fit="contain"
                // One tile's problem, not the grid's.
                onLoadFailure={() => setCardFailed(true)}
              />
            ) : (
              <Artwork
                asset={speciesAsset(species, waifu)}
                displayWidth={ARTWORK_WIDTH.gridTile}
                name={species.name}
                rarityLabel={rarity.label}
                priority={priority}
                aspect="aspect-[3/4]"
                // Only the artwork carries the morph to the detail hero, which
                // also shows artwork. Handing it to the card would animate one
                // image into a different one.
                viewTransitionName={heroTransitionName(waifu.id)}
              />
            )}

            {/* Badges float over the art rather than stealing a metadata row. */}
            <div className="absolute top-2 right-2 flex gap-1.5">
              {waifu.isFavorite && (
                <span
                  className="rounded-full bg-black/55 p-1.5 text-amber-300 backdrop-blur-sm"
                  title="Favourite"
                >
                  <Star className="size-3.5 fill-current" aria-hidden="true" />
                  <span className="sr-only">Favourite</span>
                </span>
              )}
              {isBuddy && (
                <span
                  className="rounded-full bg-black/55 p-1.5 text-rose-300 backdrop-blur-sm"
                  title="Your buddy"
                >
                  <Heart className="size-3.5 fill-current" aria-hidden="true" />
                  <span className="sr-only">Your buddy</span>
                </span>
              )}
            </div>

            {/*
              Level sits on the art so the strip below stays to two lines — but
              the rendered card already draws it in its own level shield, so in
              Card mode this chip would both duplicate it and cover the frame.
              The link's accessible name carries the level either way.
            */}
            {!showingCard && (
              <span className="tabular absolute bottom-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
                Lv {waifu.level}
              </span>
            )}
          </div>

          <div className="flex flex-1 flex-col gap-1.5 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink" title={title}>
                {title}
              </p>
              {subtitle && (
                <p className="truncate text-xs text-ink-subtle" title={subtitle}>
                  {subtitle}
                </p>
              )}
            </div>
            <div className="mt-auto">
              <RarityBadge rarity={species.rarity} />
            </div>
          </div>
        </div>
      </RarityGlowRing>
    </Link>
  );
}

/** Matches the card's footprint exactly, so the grid never shifts (§14). */
export function WaifumonCardSkeleton({ rarity = 'N' }: { rarity?: string }) {
  return (
    <RarityGlowRing rarity={rarity} className="h-full opacity-60">
      <div className="flex h-full flex-col">
        <div className="skeleton aspect-[3/4] w-full" />
        <div className="flex flex-col gap-2 p-3">
          <div className="skeleton h-4 w-3/4 rounded" />
          <div className="skeleton h-5 w-12 rounded-full" />
        </div>
      </div>
    </RarityGlowRing>
  );
}
