/**
 * An encyclopedia tile (plan §8.7).
 *
 * Undiscovered species render as a silhouette with `???` for a name and no
 * description — but the rarity badge stays visible, because knowing a tier
 * exists is part of what makes a dex worth filling.
 */
import { Link } from 'react-router';

import type { ContentSpecies } from '@/api/types';
import { SpeciesArtwork } from '@/components/media/SpeciesArtwork';
import { Badge } from '@/components/ui/badge';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { speciesLabel } from '@/content/species';
import { rarityStyle } from '@/lib/rarity';
import { cn } from '@/lib/cn';
import { ARTWORK_WIDTH } from '@/images/sizes';

export interface SpeciesCardProps {
  species: ContentSpecies;
  /**
   * How many copies the player owns, or `undefined` while the Portal has no
   * trustworthy overlay for this player.
   *
   * Tri-state rather than "0 means undiscovered": those are genuinely different
   * facts, and collapsing them is how a tile ends up deciding what to reveal
   * from a default rather than from an answer.
   */
  ownedCount: number | undefined;
  priority?: boolean;
}

export function SpeciesCard({ species, ownedCount, priority = false }: SpeciesCardProps) {
  const discovered = ownedCount === undefined ? undefined : ownedCount > 0;
  const rarity = rarityStyle(species.rarity);

  return (
    <Link
      to={`/encyclopedia/${species.slug}`}
      className="lift group block rounded-2xl"
      aria-label={
        discovered === true
          ? `${species.name}, ${rarity.label}, ${ownedCount} owned`
          : `Undiscovered ${rarity.label} species`
      }
    >
      <RarityGlowRing
        rarity={species.rarity}
        className={cn('h-full', discovered !== true && 'opacity-80')}
      >
        <div className="flex h-full flex-col">
          <div className="relative">
            <SpeciesArtwork
              species={species}
              discovered={discovered}
              displayWidth={ARTWORK_WIDTH.gridTile}
              rarityLabel={rarity.label}
              priority={priority}
              aspect="aspect-[3/4]"
            />
            {discovered === true && (
              <span className="tabular absolute top-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
                ×{ownedCount}
              </span>
            )}
          </div>

          <div className="flex flex-1 flex-col gap-1.5 p-3">
            <p
              className={cn(
                'truncate text-sm font-medium',
                discovered === true ? 'text-ink' : 'text-ink-subtle',
              )}
              title={discovered === true ? species.name : undefined}
            >
              {speciesLabel(species, discovered)}
            </p>
            <div className="mt-auto flex flex-wrap items-center gap-1.5">
              <RarityBadge rarity={species.rarity} />
              {discovered !== true && <Badge variant="outline">Undiscovered</Badge>}
            </div>
          </div>
        </div>
      </RarityGlowRing>
    </Link>
  );
}
