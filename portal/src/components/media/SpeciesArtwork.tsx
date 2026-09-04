/**
 * `<SpeciesArtwork>` — the only component in the Portal allowed to draw a
 * species' artwork when no owned copy is in hand.
 *
 * ### Why this exists rather than a prop on `<Artwork>`
 *
 * `<Artwork silhouette={…}>` is an *optional* boolean, and the bug this file
 * closes was a call site that simply did not pass it: the Collection detail
 * page's related-species rail rendered `speciesAsset(candidate)` with no gate
 * at all, so every neighbouring species showed its real art regardless of
 * whether the player had ever met her. Nothing in the types objected, because
 * "no opinion about ownership" and "certainly owned" looked identical.
 *
 * Here the authorization input is **required** and tri-state, so the same
 * omission is a compile error rather than a leak, and `undefined` — the shape
 * "the Portal has not established this yet" takes — renders the silhouette.
 * The rule is one line and has no exceptions:
 *
 *     real artwork  ⟺  discovered === true
 *
 * `false`, `undefined`, an overlay belonging to another player, a query still
 * in flight, a refetch, a cache rehydration: all of them are "not `true`", and
 * all of them draw the silhouette. The reverse mistake — a locked treatment
 * shown briefly for a species the player does own — is the acceptable one, and
 * it is the only one this component can make.
 *
 * ### Owned copies do not come through here
 *
 * `speciesAsset(species, waifu)` resolves the look a *copy the player owns* is
 * wearing, addressed through the authenticated owned-artwork route. Ownership
 * is proven by the copy's presence in that player's collection, so those call
 * sites (`WaifumonHero`, `WaifumonCard`, `RecentCatches`, the buddy panels)
 * need no overlay and keep using `<Artwork>` directly.
 */
import { memo } from 'react';

import type { ContentSpecies, Species } from '@/api/types';
import { Artwork, type ArtworkProps } from '@/components/media/Artwork';
import { speciesAsset } from '@/images/assets';

export interface SpeciesArtworkProps
  extends Omit<ArtworkProps, 'asset' | 'silhouette' | 'name' | 'rarityLabel'> {
  species: Pick<Species | ContentSpecies, 'slug' | 'name' | 'appearances'>;
  /**
   * Whether the Portal has **positively established** that this player may see
   * this species' artwork. `undefined` means "not established yet" and is
   * treated exactly like `false` — see `useSpeciesDiscovery`.
   */
  discovered: boolean | undefined;
  /** Rarity label for the alt text; suppressed while locked, like the name. */
  rarityLabel?: string | undefined;
}

export const SpeciesArtwork = memo(function SpeciesArtwork({
  species,
  discovered,
  rarityLabel,
  ...rest
}: SpeciesArtworkProps) {
  // The single gate. Written as an equality against `true` rather than `!x` so
  // that widening `discovered` to some future third state cannot silently
  // become "unlocked".
  const authorized = discovered === true;

  return (
    <Artwork
      {...rest}
      asset={speciesAsset(species as Species | ContentSpecies)}
      silhouette={!authorized}
      // Withheld along with the pixels: `useImage` already substitutes the
      // generic silhouette alt text, and passing the real name would put it in
      // the accessibility tree for an entry the player has not unlocked.
      name={authorized ? species.name : undefined}
      rarityLabel={authorized ? rarityLabel : undefined}
    />
  );
});
