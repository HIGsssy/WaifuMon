/**
 * Patch's Workshop — the card at the top of the Gear Bag.
 *
 * Balances, salvage values, the two actions and — when the server resolved
 * one — the Workshop's image (its own artwork, else Patch's portrait). Every
 * number and the image choice are the server's (`GET …/equipment/workshop`);
 * the panel only lays them out, and the bytes come through the image resolver. The page owns
 * what the actions do: Dismantle switches the Gear Bag into explicit
 * selection, Fabricate opens the fabrication dialog.
 */
import { Hammer, Wrench } from 'lucide-react';

import { useWorkshop } from '@/api/hooks/useEquipment';
import { ErrorState } from '@/components/layout/ErrorState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Artwork } from '@/components/media/Artwork';
import { formatNumber } from '@/lib/format';
import { COMPONENTS_LABEL, WORKSHOP_TITLE } from './workshopText';

export function WorkshopPanel({
  playerId,
  dismantling,
  onToggleDismantle,
  onFabricate,
}: {
  playerId: number;
  dismantling: boolean;
  onToggleDismantle: () => void;
  onFabricate: () => void;
}) {
  const workshop = useWorkshop(playerId);

  return (
    <section
      aria-labelledby="workshop-heading"
      className="rounded-2xl border border-border bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="workshop-heading" className="font-display text-lg text-ink">
            {WORKSHOP_TITLE}
          </h2>
          <p className="text-sm text-ink-muted">
            Patch · Scavenger &amp; Mechanic — dismantle gear you don&apos;t need, fabricate
            something new.
          </p>
        </div>
      </div>

      {workshop.isError ? (
        <div className="mt-3">
          <ErrorState
            variant="inline"
            error={workshop.error}
            onRetry={() => void workshop.refetch()}
            title="Couldn't load Patch's Workshop."
          />
        </div>
      ) : workshop.isPending ? (
        <div className="mt-3 space-y-2" aria-busy="true" aria-label="Loading Patch's Workshop">
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      ) : (
        <>
          {workshop.data.artwork && (
            <Artwork
              asset={{
                kind: 'ui',
                slug: 'equipment-workshop',
                workshop: { playerId, source: workshop.data.artwork.source },
              }}
              name={WORKSHOP_TITLE}
              aspect="aspect-[16/9]"
              className="mt-3 rounded-xl sm:max-w-md"
              displayWidth={448}
            />
          )}
          <dl className="tabular mt-3 grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="rounded-xl border border-border bg-surface-sunken p-3">
              <dt className="text-xs text-ink-muted">{COMPONENTS_LABEL}</dt>
              <dd className="text-xl font-semibold text-ink" data-testid="workshop-components">
                {formatNumber(workshop.data.balances.components)}
              </dd>
            </div>
            <div className="rounded-xl border border-border bg-surface-sunken p-3">
              <dt className="text-xs text-ink-muted">WaifuBux</dt>
              <dd className="text-xl font-semibold text-ink" data-testid="workshop-waifubux">
                {formatNumber(workshop.data.balances.waifubux)}
              </dd>
            </div>
          </dl>
          {workshop.data.salvageYields.length > 0 && (
            <p className="mt-2 text-xs text-ink-subtle" data-testid="workshop-yields">
              Salvage value:{' '}
              {workshop.data.salvageYields.map((y) => `${y.rarity} ${y.components}`).join(' · ')}
            </p>
          )}
        </>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant={dismantling ? 'default' : 'outline'}
          aria-pressed={dismantling}
          onClick={onToggleDismantle}
          disabled={!workshop.data}
        >
          <Wrench aria-hidden="true" />
          {dismantling ? 'Stop dismantling' : 'Dismantle Equipment'}
        </Button>
        <Button variant="outline" onClick={onFabricate} disabled={!workshop.data}>
          <Hammer aria-hidden="true" />
          Fabricate Equipment
        </Button>
      </div>
    </section>
  );
}
