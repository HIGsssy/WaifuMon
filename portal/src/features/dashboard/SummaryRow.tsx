/**
 * The Dashboard's lower summary row: collection progress and current location.
 *
 * **There is no "Today" card here, and its absence is deliberate.** The recap
 * the bot shows (`hunts · caught · escaped · SR+ · level-ups`) is stored per
 * `(player, channel)` in `waifumon_sessions.summary_json`, so the only endpoint
 * that serves it — `GET /players/{id}/sessions/{channelId}` — answers for one
 * Discord channel rather than for the player's day. The Portal holds no channel
 * id and has no honest way to choose one. A reserved slot would therefore be a
 * slot for numbers that would be wrong, so the row is built to be complete
 * without it and the two cards take the width.
 *
 * When a player-wide recap resource lands, this row becomes three columns and
 * nothing else here changes.
 */
import { ArrowRight, LibraryBig, MapPin } from 'lucide-react';
import { Link } from 'react-router';

import type { CurrentRegion, DexStats } from '@/api/types';
import { ErrorState } from '@/components/layout/ErrorState';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DexProgressRing } from '@/components/waifumon/DexProgressRing';
import { formatNumber } from '@/lib/format';

/** One label/value line, so the two cards' figures share a baseline grid. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className="tabular text-sm font-medium text-ink">{value}</span>
    </div>
  );
}

export interface CollectionProgressCardProps {
  stats: DexStats | undefined;
  error: unknown;
  onRetry: () => void;
}

export function CollectionProgressCard({ stats, error, onRetry }: CollectionProgressCardProps) {
  if (error && !stats) {
    return (
      <Card>
        <CardTitle>Collection</CardTitle>
        <ErrorState
          variant="inline"
          error={error}
          onRetry={onRetry}
          title="Couldn't load your collection progress."
          className="mt-4 w-full"
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Collection</CardTitle>
      {stats ? (
        <div className="mt-4 flex items-center gap-4">
          {/*
            Compact: the ring shows the percentage, the figures beside it show
            the counts. Between them every number appears exactly once.
          */}
          <DexProgressRing
            distinctSpecies={stats.distinctSpecies}
            totalSpecies={stats.totalSpecies}
            size={84}
            compact
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Figure
              label="Discovered"
              value={`${formatNumber(stats.distinctSpecies)} / ${formatNumber(stats.totalSpecies)}`}
            />
            <Figure label="Owned" value={formatNumber(stats.owned)} />
            {/*
              Subtraction over two figures the API returned — presentation, not
              a dex rule. The API models no duplicate count of its own, and this
              is the only figure on the page it does not state outright.
            */}
            <Figure label="Duplicates" value={formatNumber(stats.owned - stats.distinctSpecies)} />
          </div>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-4">
          <Skeleton className="size-[84px] shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      )}
    </Card>
  );
}

export interface CurrentLocationCardProps {
  region: CurrentRegion | undefined;
}

export function CurrentLocationCard({ region }: CurrentLocationCardProps) {
  return (
    <Card>
      <CardTitle>Location</CardTitle>
      {region ? (
        <div className="mt-4 flex items-start gap-3">
          <div className="rounded-xl border border-border bg-surface-raised p-2.5 text-ink-subtle">
            <MapPin className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            {/*
              The name is the API's, resolved from the authored region file. The
              Portal deliberately does not title-case an id — content is free to
              name a place something the id does not spell.
            */}
            <p className="truncate font-medium text-ink" title={region.name}>
              {region.name}
            </p>
            <p className="mt-1 text-sm text-ink-muted">
              Where you are hunting now. Travel from Discord.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex items-start gap-3">
          <Skeleton className="size-9 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-full" />
          </div>
        </div>
      )}
    </Card>
  );
}

/** A quiet link out to the collection, replacing the button the big card had. */
export function BrowseCollectionCard() {
  return (
    <Card className="flex flex-col justify-between">
      <div>
        <CardTitle>Browse</CardTitle>
        <p className="mt-3 text-sm text-ink-muted">
          Filter, sort and search every Waifumon you own.
        </p>
      </div>
      <Button asChild variant="outline" size="sm" className="mt-4 self-start">
        <Link to="/collection" viewTransition>
          <LibraryBig aria-hidden="true" />
          Collection
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </Card>
  );
}
