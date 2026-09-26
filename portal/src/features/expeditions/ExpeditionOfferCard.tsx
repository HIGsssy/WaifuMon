/**
 * One mission on a regional board — planning information only.
 *
 * Everything shown is what Discord's board shows: duration, recommended
 * level, the stated preferences and the reward preview. No Start button: the
 * Portal cannot deploy, and a greyed-out one would only suggest it might.
 */
import { Clock, Star } from 'lucide-react';

import type { ExpeditionOffer } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { formatMinutes, titleCase } from '@/lib/format';
import { PREVIEW_LABEL, expeditionTypeLabel, raceLabel } from './labels';

export interface ExpeditionOfferCardProps {
  offer: ExpeditionOffer;
  /** The region is held by an open mission: shown, but visibly informational. */
  muted?: boolean;
}

export function ExpeditionOfferCard({ offer, muted = false }: ExpeditionOfferCardProps) {
  const prefers = [
    offer.preferredAffinities.map(titleCase).join(' / '),
    offer.preferredRaces.map(raceLabel).join(' / '),
  ].filter(Boolean);

  return (
    <Card className={cn('flex h-full flex-col gap-3 p-4 sm:p-5', muted && 'opacity-70')}>
      <div>
        <h4 className="font-display text-base leading-tight text-ink">
          {offer.emoji && <span aria-hidden="true">{offer.emoji} </span>}
          {offer.name}
        </h4>
        {offer.description && (
          <p className="mt-1 text-sm text-ink-muted italic">{offer.description}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge variant="solid" className="gap-1">
          <Clock className="size-3 opacity-70" aria-hidden="true" />
          <span className="sr-only">Duration: </span>
          {formatMinutes(offer.durationMinutes)}
        </Badge>
        <Badge variant="outline" className="gap-1">
          <Star className="size-3 opacity-70" aria-hidden="true" />
          Recommended Lv {offer.recommendedLevel}
        </Badge>
        <Badge variant="outline">{expeditionTypeLabel(offer.type)}</Badge>
      </div>

      {prefers.length > 0 && (
        <p className="text-xs text-ink-muted">
          <span className="font-medium text-ink">Prefers:</span> {prefers.join(' • ')}
        </p>
      )}

      <p className="mt-auto text-xs text-ink-muted">
        <span className="sr-only">Possible rewards: </span>
        {offer.rewardPreview.length > 0
          ? offer.rewardPreview.map((p) => PREVIEW_LABEL[p]).join(' · ')
          : 'Rewards unknown.'}
      </p>
    </Card>
  );
}
