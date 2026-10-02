/**
 * `/equipment` — manage the active loadout and the Gear Bag, and visit Patch's
 * Workshop (dismantle explicit Gear Bag selections; fabricate new pieces).
 *
 * A richer view over the same authoritative services Discord uses: the API
 * enforces the Equipment unlock, ownership, slot rules and the stale-slot
 * guard, and calculates every stat. The Portal renders responses and sends
 * actions; it holds no Equipment rules of its own.
 *
 * A player who has not unlocked Equipment gets `{ unlocked: false }` from the
 * overview and nothing else, so the locked page cannot show gear even by
 * accident — the Gear Bag is not even requested.
 */
import { Lock } from 'lucide-react';
import { useState } from 'react';

import { useEquipmentOverview } from '@/api/hooks/useEquipment';
import type { DismantleResult, EquipmentItem, EquipmentSlot } from '@/api/types';
import { useCurrentSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber } from '@/lib/format';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { DismantleReviewDialog } from './DismantleReviewDialog';
import { EquipmentDetailDialog } from './EquipmentDetailDialog';
import { FabricateDialog } from './FabricateDialog';
import { WorkshopPanel } from './WorkshopPanel';
import { COMPONENTS_LABEL } from './workshopText';
import { DEFAULT_FILTERS, type GearBagFilters } from './filters';
import { GearBag } from './GearBag';
import { LoadoutSummary } from './LoadoutSummary';

/** Matches the onboarding's own gate (`EQUIPMENT_ONBOARDING_MIN_LEVEL`). */
const UNLOCK_LEVEL = 35;

export function EquipmentPage() {
  const session = useCurrentSession();
  const overview = useEquipmentOverview(session.playerId);
  const [selected, setSelected] = useState<Pick<EquipmentItem, 'id' | 'name'> | null>(null);
  const [filters, setFilters] = useState<GearBagFilters>(DEFAULT_FILTERS);
  const [searchDraft, setSearchDraft] = useState('');
  const search = useDebouncedValue(searchDraft);

  // Patch's Workshop. Dismantling is explicit selection in the Gear Bag; the
  // selection survives filter and search changes until reviewed or cancelled.
  const [dismantling, setDismantling] = useState(false);
  const [picked, setPicked] = useState<ReadonlyMap<number, EquipmentItem>>(new Map());
  const [reviewing, setReviewing] = useState<EquipmentItem[] | null>(null);
  const [fabricating, setFabricating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const browseSlot = (slot: EquipmentSlot) => setFilters({ ...filters, slot });
  const stopDismantling = () => {
    setDismantling(false);
    setPicked(new Map());
  };
  const toggle = (item: EquipmentItem) => {
    const next = new Map(picked);
    if (next.has(item.id)) next.delete(item.id);
    else next.set(item.id, item);
    setPicked(next);
  };
  const dismantled = (result: DismantleResult) => {
    setReviewing(null);
    stopDismantling();
    setNotice(
      `${result.replayed ? 'Already dismantled' : 'Dismantled'} ${result.count} item${result.count === 1 ? '' : 's'} · +${formatNumber(result.totalComponents)} ${COMPONENTS_LABEL}.`,
    );
  };

  return (
    <>
      <PageHeader
        title="Equipment"
        description="Your Buddy's loadout, combat stats and Gear Bag."
      />

      {overview.isError ? (
        <ErrorState
          error={overview.error}
          onRetry={() => void overview.refetch()}
          title="Couldn't load your Equipment."
        />
      ) : overview.isPending ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading your Equipment">
          <Skeleton className="h-32 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      ) : !overview.data.unlocked ? (
        <EmptyState
          icon={Lock}
          title="Equipment is locked"
          description={`Equipment unlocks through the Level ${UNLOCK_LEVEL} Equipment onboarding in Discord.`}
          hint={`Reach Level ${UNLOCK_LEVEL}, then open /waifumon in Discord to begin.`}
        />
      ) : (
        <div className="space-y-8">
          <LoadoutSummary
            playerId={session.playerId}
            overview={overview.data}
            onOpen={setSelected}
            onBrowseSlot={browseSlot}
          />
          <WorkshopPanel
            playerId={session.playerId}
            dismantling={dismantling}
            onToggleDismantle={() => {
              setNotice(null);
              if (dismantling) stopDismantling();
              else setDismantling(true);
            }}
            onFabricate={() => {
              setNotice(null);
              setFabricating(true);
            }}
          />
          {notice && (
            <p
              role="status"
              className="rounded-xl border border-success/40 bg-success-soft p-3 text-sm text-ink"
            >
              {notice}
            </p>
          )}
          {dismantling && (
            <div
              className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/40 bg-surface p-3 shadow-[var(--shadow-lift)]"
              role="region"
              aria-label="Dismantle selection"
            >
              <p className="text-sm text-ink">
                <span className="font-medium" data-testid="dismantle-selected">
                  {picked.size} selected
                </span>{' '}
                <span className="text-ink-muted">
                  — pick copies below. Equipped, favorite and locked gear can&apos;t be picked.
                </span>
              </p>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  disabled={picked.size === 0}
                  onClick={() => setReviewing([...picked.values()])}
                >
                  Review dismantle
                </Button>
                <Button variant="outline" onClick={stopDismantling}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <GearBag
            playerId={session.playerId}
            filters={filters}
            onFiltersChange={setFilters}
            searchDraft={searchDraft}
            onSearchDraftChange={setSearchDraft}
            search={search}
            onOpen={setSelected}
            selection={dismantling ? { ids: new Set(picked.keys()), onToggle: toggle } : undefined}
          />
          <EquipmentDetailDialog
            playerId={session.playerId}
            target={selected}
            onClose={() => setSelected(null)}
          />
          <DismantleReviewDialog
            playerId={session.playerId}
            selection={reviewing}
            onClose={() => setReviewing(null)}
            onDone={dismantled}
          />
          <FabricateDialog
            playerId={session.playerId}
            open={fabricating}
            onClose={() => setFabricating(false)}
            onInspect={(item) => setSelected(item)}
          />
        </div>
      )}
    </>
  );
}
