/**
 * `/expeditions` — who is away, and what each region is offering.
 *
 * Information only. The Portal cannot start, collect, recall or reroll an
 * Expedition; every one of those stays in Discord, and the page says so rather
 * than drawing controls it cannot honour.
 *
 * Nothing about the game is computed here. The boards are the server's
 * canonical per-player boards (the same ones Discord shows), occupancy is the
 * server's, match quality is the server's. The one thing the page does itself
 * is *tick the clocks*: countdowns are measured from `completesAt` and
 * `rotatesAt` against a local clock, so time passing costs no request. When a
 * board rotation actually passes, the boards really are stale, and the page
 * asks for them once.
 */
import { Compass, Info, Map as MapIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { useExpeditions } from '@/api/hooks/usePlayerResources';
import type { ActiveExpedition, ExpeditionRegion } from '@/api/types';
import { useCurrentSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCountdown } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { ActiveExpeditionCard } from './ActiveExpeditionCard';
import { ExpeditionOfferCard } from './ExpeditionOfferCard';

export function ExpeditionsPage() {
  const session = useCurrentSession();
  const expeditions = useExpeditions(session.playerId);
  const now = useNow();
  const data = expeditions.data;

  // One refetch per rotation, and only once it has actually happened.
  const refetchedFor = useRef<string | null>(null);
  const { refetch, isFetching } = expeditions;
  const rotatesAt = data?.rotatesAt;
  const rotated = rotatesAt != null && new Date(rotatesAt).getTime() <= now.getTime();
  useEffect(() => {
    if (!rotated || isFetching || refetchedFor.current === rotatesAt) return;
    refetchedFor.current = rotatesAt ?? null;
    void refetch();
  }, [rotated, rotatesAt, isFetching, refetch]);

  const rotationCountdown = rotatesAt ? formatCountdown(rotatesAt, now) : null;

  return (
    <>
      <PageHeader
        title="Expeditions"
        description="Who's away, when they're back, and what each region is offering."
      />

      <p
        className="mb-6 flex items-start gap-2 rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm text-ink-muted"
        role="note"
      >
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>Use Discord to start and manage Expeditions.</span>
      </p>

      {expeditions.isError && (
        <ErrorState
          error={expeditions.error}
          onRetry={() => void expeditions.refetch()}
          title="Couldn't load your Expeditions."
          className="mb-6"
        />
      )}

      <section aria-labelledby="active-expeditions" className="mb-10">
        <h2 id="active-expeditions" className="mb-4 font-display text-xl text-ink">
          Active Expeditions
        </h2>
        {expeditions.isPending ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-44 rounded-2xl" />
            <Skeleton className="h-44 rounded-2xl" />
          </div>
        ) : data && data.active.length > 0 ? (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Active Expeditions">
            {data.active.map((e) => (
              <li key={`${e.region}:${e.startedAt}`}>
                <ActiveExpeditionCard expedition={e} now={now} />
              </li>
            ))}
          </ul>
        ) : data ? (
          <EmptyState
            icon={Compass}
            title="No WaifuMon are currently away on an Expedition."
            description="Send one out from a region's board in Discord and she'll show up here."
          />
        ) : null}
      </section>

      <section aria-labelledby="available-expeditions">
        <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 id="available-expeditions" className="font-display text-xl text-ink">
            Available Expeditions
          </h2>
          {rotationCountdown && (
            <p className="text-sm text-ink-subtle" data-testid="rotation-countdown">
              Boards rotate in {rotationCountdown}
            </p>
          )}
        </div>

        {data && !data.enabled && (
          <p className="mb-4 text-sm text-ink-muted">
            New Expeditions are closed for now. Missions already underway carry on as normal.
          </p>
        )}

        {expeditions.isPending ? (
          <Skeleton className="h-64 rounded-2xl" />
        ) : data ? (
          <div className="space-y-8">
            {data.regions.map((region) => (
              <RegionBoard
                key={region.regionId}
                region={region}
                holder={data.active.find((a) => a.region === region.regionId) ?? null}
                now={now}
              />
            ))}
          </div>
        ) : null}
      </section>
    </>
  );
}

function RegionBoard({
  region,
  holder,
  now,
}: {
  region: ExpeditionRegion;
  /** The open mission holding this region, when `region.occupied`. */
  holder: ActiveExpedition | null;
  now: Date;
}) {
  const headingId = `region-${region.regionId}`;
  const holderCountdown = holder ? formatCountdown(holder.completesAt, now) : null;
  const holderReady = holder != null && (holder.readyToClaim || holderCountdown === null);

  return (
    <section aria-labelledby={headingId} data-testid={`region-${region.regionId}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="font-display text-lg text-ink">
          {region.emoji && <span aria-hidden="true">{region.emoji} </span>}
          {region.name}
        </h3>
        {region.isCurrent && <Badge variant="solid">You are here</Badge>}
        {region.occupied && <Badge variant="outline">Occupied</Badge>}
      </div>

      {region.occupied ? (
        <p className="mb-3 rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm text-ink-muted">
          <span aria-hidden="true">🚩 </span>
          {holder ? (
            <>
              <span className="font-medium text-ink">{holder.waifuName}</span> is working this
              region on <span className="font-medium text-ink">{holder.name}</span>
              {holderReady ? ' — complete, claim in Discord.' : ` — returns in ${holderCountdown}.`}
            </>
          ) : (
            'An Expedition is already underway here.'
          )}{' '}
          These offers are for planning only until she's collected.
        </p>
      ) : (
        !region.isCurrent &&
        region.offers.length > 0 && (
          <p className="mb-3 text-sm text-ink-subtle">Travel here in Discord to start one.</p>
        )
      )}

      {region.offers.length > 0 ? (
        <ul
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
          aria-label={`${region.name} Expeditions`}
        >
          {region.offers.map((offer) => (
            <li key={`${offer.durationMinutes}:${offer.name}`}>
              <ExpeditionOfferCard offer={offer} muted={region.occupied} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-surface/40 px-4 py-6 text-sm text-ink-muted">
          <MapIcon className="size-4 shrink-0" aria-hidden="true" />
          No Expeditions are currently available here.
        </p>
      )}
    </section>
  );
}
