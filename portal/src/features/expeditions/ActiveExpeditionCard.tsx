/**
 * One open Expedition: who is away, where, on what, and when she is back.
 *
 * No Collect, no Recall, no buttons of any kind — both live in Discord. A
 * finished mission says so and points there; its result is not shown here
 * (the API does not send it), exactly as Discord keeps it for the Collect.
 */
import { CheckCircle2, Clock, MapPin } from 'lucide-react';
import { Link } from 'react-router';

import type { ActiveExpedition } from '@/api/types';
import { CopyArtwork } from '@/components/media/CopyArtwork';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ARTWORK_WIDTH } from '@/images/sizes';
import { formatCountdown, formatDateTime, formatMinutes } from '@/lib/format';
import { rarityStyle } from '@/lib/rarity';
import { MATCH_LABEL, PREVIEW_LABEL, expeditionTypeLabel } from './labels';

export interface ActiveExpeditionCardProps {
  expedition: ActiveExpedition;
  now: Date;
}

export function ActiveExpeditionCard({ expedition: e, now }: ActiveExpeditionCardProps) {
  const countdown = formatCountdown(e.completesAt, now);
  // The server's verdict, or the same `completesAt <= now` rule applied to the
  // local clock once the countdown runs out — display only, nothing resolves.
  const ready = e.readyToClaim || countdown === null;

  const start = new Date(e.startedAt).getTime();
  const end = new Date(e.completesAt).getTime();
  const progress = ready ? 100 : ((now.getTime() - start) / Math.max(1, end - start)) * 100;

  return (
    <Card flush className="flex gap-4 overflow-hidden p-4 sm:p-5">
      <div className="w-20 shrink-0 sm:w-24">
        {e.waifu ? (
          <Link
            to={`/collection/${e.waifu.waifu.id}`}
            className="lift block rounded-xl"
            aria-label={`View ${e.waifuName}`}
          >
            <CopyArtwork
              entry={e.waifu}
              mode="self"
              displayWidth={ARTWORK_WIDTH.strip}
              rarityLabel={rarityStyle(e.waifu.species.rarity).label}
              aspect="aspect-[3/4]"
              className="rounded-xl"
            />
          </Link>
        ) : (
          <div className="aspect-[3/4] rounded-xl bg-surface-sunken" aria-hidden="true" />
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2.5">
        <div>
          <h3 className="truncate font-display text-lg leading-tight text-ink">
            {e.emoji && <span aria-hidden="true">{e.emoji} </span>}
            {e.name}
          </h3>
          <p className="mt-0.5 text-sm text-ink-muted">
            <span className="font-medium text-ink">{e.waifuName}</span>
            {e.waifu && <> · Lv {e.waifu.waifu.level}</>}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="gap-1">
            <MapPin className="size-3 opacity-70" aria-hidden="true" />
            {e.regionName}
          </Badge>
          {e.match && (
            <Badge variant="solid">
              <span aria-hidden="true">{MATCH_LABEL[e.match].icon}</span>
              {MATCH_LABEL[e.match].label}
            </Badge>
          )}
          {e.type && <Badge variant="outline">{expeditionTypeLabel(e.type)}</Badge>}
          <Badge variant="outline" className="gap-1">
            <Clock className="size-3 opacity-70" aria-hidden="true" />
            {formatMinutes(e.durationMinutes)}
          </Badge>
        </div>

        {ready ? (
          <p
            className="flex items-center gap-1.5 text-sm font-medium text-accent"
            data-testid="expedition-ready"
          >
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Complete — claim in Discord
          </p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-sm text-ink">Returns in {countdown}</p>
            <Progress value={progress} aria-label={`${e.name} progress`} />
          </div>
        )}

        <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-subtle">
          <div>
            <dt className="sr-only">Started</dt>
            <dd>Started {formatDateTime(e.startedAt)}</dd>
          </div>
          <div>
            <dt className="sr-only">Returns</dt>
            <dd>Back {formatDateTime(e.completesAt)}</dd>
          </div>
        </dl>

        {e.rewardPreview.length > 0 && (
          <p className="text-xs text-ink-muted">
            <span className="sr-only">Possible rewards: </span>
            {e.rewardPreview.map((p) => PREVIEW_LABEL[p]).join(' · ')}
          </p>
        )}
      </div>
    </Card>
  );
}
