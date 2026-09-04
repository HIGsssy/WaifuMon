/**
 * The "Related species" rail, shared by the Collection copy page (§8.3) and the
 * Encyclopedia species page (§8.7).
 *
 * It was previously duplicated between the two, and the copies had drifted:
 * the Encyclopedia's tiles consulted the ownership overlay and silhouetted
 * anything undiscovered, while the Collection's tiles rendered the raw content
 * list straight into `<Artwork>` with no gate at all. Same heading, same grid,
 * same helper feeding it, opposite privacy behaviour — which is exactly the
 * failure mode a second copy of a component produces.
 *
 * One component now, and it takes no `silhouette`-style opt-in: the tiles
 * resolve discovery themselves from `useSpeciesDiscovery` and render through
 * `<SpeciesArtwork>`, so there is no prop a caller can forget to pass.
 *
 * The "same archetype" rule itself is a labelled presentation heuristic and
 * lives in `content/species.ts` (§26) — this file only draws it.
 */
import { Link } from 'react-router';

import type { ContentSpecies } from '@/api/types';
import { useSpeciesDiscovery } from '@/api/hooks/useSpeciesDiscovery';
import { useCurrentSession } from '@/auth/useSession';
import { SpeciesArtwork } from '@/components/media/SpeciesArtwork';
import { RarityGlowRing } from '@/components/waifumon/RarityGlowRing';
import { relatedSpecies, speciesLabel } from '@/content/species';
import { ARTWORK_WIDTH } from '@/images/sizes';
import { rarityStyle } from '@/lib/rarity';

export interface RelatedSpeciesStripProps {
  /** The species the rail is "related to" — always excluded from itself. */
  subject: { slug: string; archetype: string };
  /** The cached content snapshot; `undefined` while it is still loading. */
  allSpecies: ContentSpecies[] | undefined;
}

export function RelatedSpeciesStrip({ subject, allSpecies }: RelatedSpeciesStripProps) {
  const session = useCurrentSession();
  const discovery = useSpeciesDiscovery(session.playerId);
  const related = allSpecies ? relatedSpecies(allSpecies, subject) : [];

  if (related.length === 0) return null;

  return (
    <section aria-labelledby="related-heading">
      <h2
        id="related-heading"
        className="mb-1 text-sm font-medium tracking-wide text-ink-muted uppercase"
      >
        Related species
      </h2>
      {/* Same-archetype neighbours: a presentation heuristic, labelled (§26). */}
      <p className="mb-3 text-xs text-ink-subtle">Others sharing the {subject.archetype} type.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {related.map((candidate) => {
          // Tri-state on purpose. The content snapshot routinely arrives before
          // the ownership walk finishes — that ordering is what made the leak
          // visible as a *flash* — and until the walk answers, this is
          // `undefined` and the tile stays locked.
          const discovered = discovery.isDiscovered(candidate.slug);
          return (
            <Link
              key={candidate.slug}
              to={`/encyclopedia/${candidate.slug}`}
              className="lift block rounded-2xl"
            >
              <RarityGlowRing rarity={candidate.rarity}>
                <SpeciesArtwork
                  species={candidate}
                  discovered={discovered}
                  displayWidth={ARTWORK_WIDTH.strip}
                  rarityLabel={rarityStyle(candidate.rarity).label}
                  aspect="aspect-[3/4]"
                />
                <div className="p-2.5">
                  <p className="truncate text-xs font-medium text-ink">
                    {speciesLabel(candidate, discovered)}
                  </p>
                </div>
              </RarityGlowRing>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
