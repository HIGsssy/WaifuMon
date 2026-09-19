/**
 * One species in the Admin Waifumon Gallery grid.
 *
 * Priorities, in order: the default artwork, who she is, whether she is live,
 * whether anything is wrong. Everything else is on the detail page. The whole
 * tile is one link, and it stays one even when the artwork is missing — a
 * broken species is exactly the one an admin needs to open.
 */
import { Link } from 'react-router';

import type { GallerySpeciesSummary } from '@/api/adminGallery';
import { AdminGalleryArtwork } from '@/components/media/AdminGalleryArtwork';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { ARTWORK_WIDTH } from '@/images/sizes';
import { titleCase } from '@/lib/format';

import { EnabledBadge, GalleryZoneBadge, IssueBadge, RuntimeBadge } from './GalleryBadges';

export interface GallerySpeciesTileProps {
  species: GallerySpeciesSummary;
  /** The gallery's current query string (with `?`), carried to the detail page. */
  search: string;
  priority?: boolean;
}

export function GallerySpeciesTile({ species, search, priority = false }: GallerySpeciesTileProps) {
  const { primary } = species;
  return (
    <Link
      to={`/admin/gallery/${species.slug}${search}`}
      className="lift group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface"
      data-testid={`gallery-tile-${species.slug}`}
    >
      <div className="relative">
        <AdminGalleryArtwork
          slug={species.slug}
          appearanceId={primary.appearanceId}
          status={primary.status}
          label={`${species.name} — default artwork`}
          displayWidth={ARTWORK_WIDTH.gridTile}
          priority={priority}
        />
        {species.issues.length > 0 && (
          <IssueBadge
            count={species.issues.length}
            className="absolute top-2 right-2 shadow-sm backdrop-blur-sm"
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink" title={species.name}>
            {species.name}
          </p>
          <p className="truncate font-mono text-xs text-ink-subtle" title={species.slug}>
            {species.slug}
          </p>
        </div>
        <p className="truncate text-xs text-ink-muted">
          <span className="sr-only">Type: </span>
          {titleCase(species.race)}
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, Affinity: </span>
          {titleCase(species.affinity)}
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          {species.appearanceCounts.authored}{' '}
          {species.appearanceCounts.authored === 1 ? 'appearance' : 'appearances'}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-1">
          <RarityBadge rarity={species.rarity} />
          <GalleryZoneBadge species={species} />
          <RuntimeBadge species={species} />
          <EnabledBadge species={species} />
        </div>
      </div>
    </Link>
  );
}
