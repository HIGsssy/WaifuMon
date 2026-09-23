/**
 * `<CopyArtwork>` — artwork for one **owned copy**, whoever owns it.
 *
 * `<SpeciesArtwork>` is the gate for a species with no copy in hand. This is
 * its twin for the case that used to need no gate at all: a copy sitting in
 * somebody's collection. In `self` mode that reasoning still holds — the copy is
 * the viewer's, so the species is theirs — and this renders the owned artwork
 * exactly as before.
 *
 * In `public` mode it does not hold, and that was the leak. A guild-mate's copy
 * proves the *owner's* ownership; the viewer may never have met the species.
 * The Portal used to draw it anyway, through the ungated `<Artwork>`, because
 * every call site had been written when "there is a copy" and "the viewer owns
 * it" were the same sentence.
 *
 * So the gate lives here rather than at each call site, for the same reason
 * `<SpeciesArtwork>` exists: `silhouette` is an optional prop, and an optional
 * prop is one a tile can forget. There is nothing to pass — the component
 * resolves the viewer's dex itself via {@link useCopyKnowledge} and applies the
 * one rule the rest of the Portal already applies:
 *
 *     real artwork  ⟺  the viewer has discovered the species
 *
 * The server holds the same line independently: the public owned-artwork route
 * runs `assertSpeciesVisible` against the viewer, so a silhouette here is a
 * presentation of a refusal rather than a substitute for one.
 */
import { memo } from 'react';

import type { CollectionEntryView } from '@/api/types';
import { Artwork, type ArtworkProps } from '@/components/media/Artwork';
import type { CollectionMode } from '@/components/waifumon/WaifumonCard';
import { useCopyKnowledge } from '@/components/waifumon/useCopyKnowledge';
import { speciesAsset } from '@/images/assets';

export interface CopyArtworkProps
  extends Omit<ArtworkProps, 'asset' | 'silhouette' | 'name'> {
  entry: CollectionEntryView;
  /** Whose copy this is. `'public'` is the one that needs the viewer's dex. */
  mode: CollectionMode;
}

export const CopyArtwork = memo(function CopyArtwork({
  entry,
  mode,
  rarityLabel,
  ...rest
}: CopyArtworkProps) {
  const { species, waifu } = entry;
  // Equality against `true`, so a future third state cannot become "unlocked".
  const authorized = useCopyKnowledge(mode, species.slug) === true;

  return (
    <Artwork
      {...rest}
      // Still the owned route in public mode: the appearance she is *wearing*
      // is the owner's fact, and the server decides whether the bytes follow.
      asset={speciesAsset(species, waifu, { publicOwner: mode === 'public' })}
      silhouette={!authorized}
      // Withheld with the pixels — the name would otherwise sit in the
      // accessibility tree for a species the viewer has not unlocked.
      name={authorized ? species.name : undefined}
      rarityLabel={authorized ? rarityLabel : undefined}
    />
  );
});
