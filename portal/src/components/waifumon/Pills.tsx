/**
 * Small labelled attribute pills.
 *
 * Two naming notes carried from plan §8.2, both deliberate:
 *
 *   - **`archetype` is labelled "Type".** The brief calls it "Spirit Type"; the
 *     content field is `archetype`. Same concept, so the UI uses the shorter
 *     word and the code keeps the API's name.
 *   - **"Personality" does not appear.** The brief lists it as a filter, but no
 *     content field backs it. Rather than approximate it from `affinity` — which
 *     is a capture-matchup rule, not a personality — the Portal omits it and the
 *     gap is filed as API feedback.
 */
import { MapPin, Sparkles, Tag } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { titleCase } from '@/lib/format';
import { cn } from '@/lib/cn';
import { zoneFor } from '@/lib/zone';

/** `archetype` — what a Waifumon *is*. */
export function TypePill({ archetype, className }: { archetype: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1', className)}>
      <Tag className="size-3 opacity-70" aria-hidden="true" />
      <span className="sr-only">Type: </span>
      {titleCase(archetype)}
    </Badge>
  );
}

/**
 * `affinity` — the buddy-vs-encounter capture matchup, not a personality.
 * The Portal displays it and computes nothing from it (plan §16).
 */
export function AffinityPill({ affinity, className }: { affinity: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1', className)}>
      <Sparkles className="size-3 opacity-70" aria-hidden="true" />
      <span className="sr-only">Affinity: </span>
      {titleCase(affinity)}
    </Badge>
  );
}

/** Content rating, shown quietly — it is metadata, not a warning. */
export function ContentRatingPill({ rating, className }: { rating: string; className?: string }) {
  return (
    <Badge variant="outline" className={className}>
      <span className="sr-only">Content rating: </span>
      {titleCase(rating)}
    </Badge>
  );
}

/**
 * The species' authored origin, by its player-facing name. This is content
 * provenance, not a complete list of regional hunt pools. Renders nothing for
 * a species with no recognised origin tag — see `@/lib/zone`.
 */
export function ZonePill({
  species,
  className,
}: {
  species: { tags?: readonly unknown[] | null | undefined };
  className?: string;
}) {
  const zone = zoneFor(species);
  if (!zone) return null;
  return (
    <Badge variant="outline" className={cn('gap-1', className)}>
      <MapPin className="size-3 opacity-70" aria-hidden="true" />
      <span className="sr-only">Origin: </span>
      {zone.label}
    </Badge>
  );
}
