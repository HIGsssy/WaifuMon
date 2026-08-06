/**
 * An encyclopedia tile (plan §8.7).
 *
 * Undiscovered species render as a silhouette with `???` for a name and no
 * description — but the rarity badge stays visible, because knowing a tier
 * exists is part of what makes a dex worth filling.
 */
import { Link } from 'react-router';

import type { ContentSpecies } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { Badge } from '@/components/ui/badge';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { speciesAsset } from '@/images/assets';
import { rarityStyle } from '@/lib/rarity';
import { cn } from '@/lib/cn';

export interface SpeciesCardProps {
  species: ContentSpecies;
  /** How many copies the player owns; 0 means undiscovered. */
  ownedCount: number;
  priority?: boolean;
}

export function SpeciesCard({ species, ownedCount, priority = false }: SpeciesCardProps) {
  const discovered = ownedCount > 0;
  const rarity = rarityStyle(species.rarity);

  return (
    <Link
      to={`/encyclopedia/${species.slug}`}
      className="lift group block rounded-2xl outline-none"
      aria-label={
        discovered
          ? `${species.name}, ${rarity.label}, ${ownedCount} owned`
          : `Undiscovered ${rarity.label} species`
      }
    >
      <RarityGlowRing rarity={species.rarity} className={cn('h-full', !discovered && 'opacity-80')}>
        <div className="flex h-full flex-col">
          <div className="relative">
            <Artwork
              asset={speciesAsset(species)}
              name={species.name}
              rarityLabel={rarity.label}
              silhouette={!discovered}
              priority={priority}
              aspect="aspect-[3/4]"
            />
            {discovered && (
              <span className="tabular absolute top-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
                ×{ownedCount}
              </span>
            )}
          </div>

          <div className="flex flex-1 flex-col gap-1.5 p-3">
            <p
              className={cn(
                'truncate text-sm font-medium',
                discovered ? 'text-ink' : 'text-ink-subtle',
              )}
              title={discovered ? species.name : undefined}
            >
              {discovered ? species.name : '???'}
            </p>
            <div className="mt-auto flex flex-wrap items-center gap-1.5">
              <RarityBadge rarity={species.rarity} />
              {!discovered && <Badge variant="outline">Undiscovered</Badge>}
            </div>
          </div>
        </div>
      </RarityGlowRing>
    </Link>
  );
}
