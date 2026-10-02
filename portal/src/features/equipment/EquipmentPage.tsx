/**
 * `/equipment` — manage the active loadout and the Gear Bag.
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
import type { EquipmentItem, EquipmentSlot } from '@/api/types';
import { useCurrentSession } from '@/auth/useSession';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { EquipmentDetailDialog } from './EquipmentDetailDialog';
import { DEFAULT_FILTERS, type GearBagFilters } from './filters';
import { GearBag } from './GearBag';
import { LoadoutSummary } from './LoadoutSummary';

/** Matches the onboarding's own gate (`EQUIPMENT_ONBOARDING_MIN_LEVEL`). */
const UNLOCK_LEVEL = 35;

export function EquipmentPage() {
  const session = useCurrentSession();
  const overview = useEquipmentOverview(session.playerId);
  const [selected, setSelected] = useState<EquipmentItem | null>(null);
  const [filters, setFilters] = useState<GearBagFilters>(DEFAULT_FILTERS);
  const [searchDraft, setSearchDraft] = useState('');
  const search = useDebouncedValue(searchDraft);

  const browseSlot = (slot: EquipmentSlot) => setFilters({ ...filters, slot });

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
          <GearBag
            playerId={session.playerId}
            filters={filters}
            onFiltersChange={setFilters}
            searchDraft={searchDraft}
            onSearchDraftChange={setSearchDraft}
            search={search}
            onOpen={setSelected}
          />
          <EquipmentDetailDialog
            playerId={session.playerId}
            target={selected}
            onClose={() => setSelected(null)}
          />
        </div>
      )}
    </>
  );
}
