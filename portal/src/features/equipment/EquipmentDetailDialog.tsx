/**
 * Inspect one owned copy: its roll, its range, roll quality, its states, a
 * comparison against what its slot holds now, and the four actions.
 *
 * The comparison is the API's `previewSlot` result, verbatim. Without an
 * active Buddy there is nothing to compare, and the dialog says so rather than
 * showing invented numbers.
 *
 * Equip sends the copy the comparison showed in the slot as the stale-view
 * guard. If the slot changed since (Discord, another tab), the API refuses with
 * `409 LOADOUT_CONFLICT`; the hook refreshes every Equipment query either way,
 * so the dialog re-renders against the slot as it really is now.
 */
import { Lock, LockOpen, Star, StarOff } from 'lucide-react';
import { useState } from 'react';

import { isPortalApiError } from '@/api/client';
import { useEquipmentActions, useEquipmentDetail } from '@/api/hooks/useEquipment';
import type { EquipmentDetail, EquipmentItem, EquipmentSlotChange } from '@/api/types';
import { ErrorState } from '@/components/layout/ErrorState';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { formatDate } from '@/lib/format';
import { EquipmentStateMarks } from './EquipmentItemCard';
import {
  SLOT_LABEL,
  SLOT_STAT,
  STAT_LABEL,
  formatDelta,
  formatMultiplier,
  formatRange,
  formatStat,
} from './format';

export const CONFLICT_MESSAGE =
  'Your equipment changed somewhere else since this page loaded. It has been refreshed — take another look before trying again.';

function describeActionError(error: unknown): string {
  if (isPortalApiError(error)) {
    if (error.code === 'LOADOUT_CONFLICT') return CONFLICT_MESSAGE;
    if (error.code === 'EQUIPMENT_NOT_OWNED')
      return 'That equipment is no longer in your Gear Bag.';
    if (error.status > 0) return error.message;
  }
  return "That didn't go through. Check your connection and try again.";
}

function changeMessage(verb: string, change: EquipmentSlotChange): string {
  const stat = STAT_LABEL[SLOT_STAT[change.slot]];
  if (!change.changed)
    return `Nothing changed — the ${SLOT_LABEL[change.slot]} slot was already like that.`;
  return `${verb}. ${stat} ${formatStat(change.before)} → ${formatStat(change.after)}.`;
}

function Comparison({ detail }: { detail: EquipmentDetail }) {
  const { comparison: c, item } = detail;
  const stat = STAT_LABEL[c.stat];

  if (!c.hasBuddy) {
    return (
      <p className="rounded-xl border border-border bg-surface-sunken p-3 text-sm text-ink-muted">
        Set an active Buddy in Discord to see how this changes your {stat}. Combat stats are
        calculated from your Buddy's Current SP.
      </p>
    );
  }

  if (item.equipped) {
    return (
      <div className="rounded-xl border border-success/40 bg-success-soft p-3 text-sm">
        <p className="font-medium text-success">
          Already active in your {SLOT_LABEL[item.slot]} slot.
        </p>
        <p className="tabular mt-1 text-ink">
          Current {stat}: {formatStat(c.current)}
        </p>
      </div>
    );
  }

  return (
    <dl className="tabular grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl border border-border bg-surface-sunken p-3 text-sm">
      <dt className="text-ink-muted">Current {stat}</dt>
      <dd className="text-right text-ink">{formatStat(c.current)}</dd>
      <dt className="text-ink-muted">With this item</dt>
      <dd className="text-right font-semibold text-ink">{formatStat(c.withItem)}</dd>
      {c.delta != null && (
        <>
          <dt className="text-ink-muted">Change</dt>
          <dd
            className={
              c.delta > 0
                ? 'text-right font-semibold text-success'
                : c.delta < 0
                  ? 'text-right font-semibold text-danger'
                  : 'text-right text-ink-muted'
            }
          >
            {formatDelta(c.delta)}
          </dd>
        </>
      )}
      <dt className="col-span-2 mt-1 text-xs text-ink-subtle">
        {c.equippedItem
          ? `Compared with ${c.equippedItem.name} (${formatMultiplier(c.equippedItem.multiplier)}).`
          : `Your ${SLOT_LABEL[item.slot]} slot is empty.`}
      </dt>
    </dl>
  );
}

function DetailBody({ playerId, detail }: { playerId: number; detail: EquipmentDetail }) {
  const { item, comparison } = detail;
  const actions = useEquipmentActions(playerId);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = actions.equip.isPending || actions.unequip.isPending || actions.flag.isPending;
  const stat = STAT_LABEL[SLOT_STAT[item.slot]];

  function run<T>(promise: Promise<T>, onDone: (result: T) => string) {
    setStatus(null);
    setFailure(null);
    promise.then(
      (result) => setStatus(onDone(result)),
      (error: unknown) => setFailure(describeActionError(error)),
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <RarityBadge rarity={item.rarity} variant="full" />
        <span className="text-sm text-ink-muted">{SLOT_LABEL[item.slot]}</span>
        <EquipmentStateMarks item={item} />
      </div>
      {item.description && <p className="mt-3 text-sm text-ink-muted italic">{item.description}</p>}

      <dl className="tabular mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-muted">Multiplier</dt>
        <dd className="text-right font-semibold text-ink">
          {stat} {formatMultiplier(item.multiplier)}
        </dd>
        <dt className="text-ink-muted">Range</dt>
        <dd className="text-right text-ink">{formatRange(item.range)}</dd>
        <dt className="text-ink-muted">Roll quality</dt>
        <dd className="text-right text-ink">{item.rollQuality}%</dd>
        <dt className="text-ink-muted">Acquired</dt>
        <dd className="text-right text-ink">
          {formatDate(item.acquiredAt)} · {item.source}
        </dd>
        {detail.identicalCopies > 1 && (
          <>
            <dt className="text-ink-muted">Identical copies</dt>
            <dd className="text-right text-ink">{detail.identicalCopies}</dd>
          </>
        )}
      </dl>

      <section aria-label="Comparison" className="mt-4">
        <Comparison detail={detail} />
      </section>

      <div className="mt-5 flex flex-wrap gap-2">
        {item.equipped ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(
                actions.unequip.mutateAsync({ slot: item.slot, expectedCurrentId: item.id }),
                (change) => changeMessage('Unequipped', change),
              )
            }
          >
            Unequip
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() =>
              run(
                actions.equip.mutateAsync({
                  equipmentId: item.id,
                  expectedCurrentId: comparison.equippedItem?.id ?? null,
                }),
                (change) => changeMessage('Equipped', change),
              )
            }
          >
            Equip
          </Button>
        )}
        <Button
          variant="outline"
          disabled={busy}
          aria-pressed={item.favorite}
          onClick={() =>
            run(
              actions.flag.mutateAsync({
                equipmentId: item.id,
                flag: 'favorite',
                value: !item.favorite,
              }),
              (next) => (next.favorite ? 'Added to favorites.' : 'Removed from favorites.'),
            )
          }
        >
          {item.favorite ? <StarOff aria-hidden="true" /> : <Star aria-hidden="true" />}
          {item.favorite ? 'Unfavorite' : 'Favorite'}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          aria-pressed={item.locked}
          onClick={() =>
            run(
              actions.flag.mutateAsync({
                equipmentId: item.id,
                flag: 'locked',
                value: !item.locked,
              }),
              (next) => (next.locked ? 'Locked.' : 'Unlocked.'),
            )
          }
        >
          {item.locked ? <LockOpen aria-hidden="true" /> : <Lock aria-hidden="true" />}
          {item.locked ? 'Unlock' : 'Lock'}
        </Button>
      </div>

      <div aria-live="polite" className="mt-3 min-h-5 text-sm">
        {failure ? (
          <p role="alert" className="text-danger">
            {failure}
          </p>
        ) : status ? (
          <p role="status" className="text-ink-muted">
            {status}
          </p>
        ) : null}
      </div>
    </>
  );
}

export function EquipmentDetailDialog({
  playerId,
  target,
  onClose,
}: {
  playerId: number;
  /** The card that was opened; shown as the heading while the detail loads. */
  target: EquipmentItem | null;
  onClose: () => void;
}) {
  const detail = useEquipmentDetail(playerId, target?.id ?? null);
  const name = detail.data?.item.name ?? target?.name ?? '';

  return (
    <Dialog open={target != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-lift)] sm:p-6">
          <DialogTitle className="pr-8 font-display text-2xl leading-tight break-words text-ink">
            {name}
          </DialogTitle>
          <DialogDescription className="sr-only">Equipment details and actions</DialogDescription>
          <div className="mt-3">
            {detail.isError ? (
              <ErrorState
                variant="inline"
                error={detail.error}
                onRetry={() => void detail.refetch()}
                title="Couldn't load this equipment."
              />
            ) : detail.data ? (
              <DetailBody key={detail.data.item.id} playerId={playerId} detail={detail.data} />
            ) : (
              <div className="space-y-3" aria-busy="true" aria-label="Loading equipment">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-24 w-full rounded-xl" />
                <Skeleton className="h-20 w-full rounded-xl" />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
