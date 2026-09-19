/**
 * Status badges for the Admin Waifumon Gallery.
 *
 * Every badge carries its meaning in text (and an icon), never colour alone:
 * "Loaded" vs "Future", "Enabled" vs "Disabled", "3 issues". The two state
 * pairs are separate badges on purpose — a future species can be authored
 * enabled, and a loaded one can be disabled.
 */
import { AlertTriangle, CheckCircle2, CircleSlash, Hourglass, MapPin, Power } from 'lucide-react';

import type { GallerySpeciesSummary } from '@/api/adminGallery';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { zoneFor } from '@/lib/zone';

import { isEnabled } from './galleryFilters';
import { issueCountLabel } from './galleryLabels';

export function RuntimeBadge({ species }: { species: GallerySpeciesSummary }) {
  return species.runtime.loaded ? (
    <Badge variant="default" title="In the gameplay snapshot">
      <CheckCircle2 className="size-3" aria-hidden="true" />
      Loaded
    </Badge>
  ) : (
    <Badge variant="outline" title="Authored, but its expansion pack is not loaded">
      <Hourglass className="size-3" aria-hidden="true" />
      Future
    </Badge>
  );
}

export function EnabledBadge({ species }: { species: GallerySpeciesSummary }) {
  if (isEnabled(species)) {
    return (
      <Badge variant="default">
        <Power className="size-3" aria-hidden="true" />
        Enabled
      </Badge>
    );
  }
  const byLoader = species.runtime.disabledByLoader;
  return (
    <Badge
      variant="danger"
      title={byLoader ? 'Disabled by the loader: no default artwork' : 'Disabled in content'}
    >
      <CircleSlash className="size-3" aria-hidden="true" />
      {byLoader ? 'Disabled (loader)' : 'Disabled'}
    </Badge>
  );
}

export function IssueBadge({
  count,
  showNone = false,
  className,
}: {
  count: number;
  showNone?: boolean;
  className?: string;
}) {
  if (count === 0) {
    return showNone ? (
      <Badge variant="default" className={className}>
        <CheckCircle2 className="size-3" aria-hidden="true" />
        No issues
      </Badge>
    ) : null;
  }
  return (
    <Badge variant="danger" className={className}>
      <AlertTriangle className="size-3" aria-hidden="true" />
      {issueCountLabel(count)}
    </Badge>
  );
}

/** The species' zone from `lib/zone.ts`, or an explicit "No Zone". */
export function GalleryZoneBadge({
  species,
  className,
}: {
  species: { tags: readonly string[] };
  className?: string;
}) {
  const zone = zoneFor(species);
  return (
    <Badge variant="outline" className={cn('gap-1', !zone && 'border-dashed', className)}>
      <MapPin className="size-3 opacity-70" aria-hidden="true" />
      <span className="sr-only">Zone: </span>
      {zone ? zone.label : 'No Zone'}
    </Badge>
  );
}
