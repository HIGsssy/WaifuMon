/**
 * Review, then confirm, a dismantle — nothing is destroyed without this.
 *
 * Opening the dialog asks the server what exactly these copies would pay
 * (`…/dismantle/preview`, a POST that writes nothing). The summary — counts by
 * rarity, the Components total — is the server's. Confirm sends the same
 * selection, the reviewed total, and a request key minted once for this
 * review, so a retried click replays instead of destroying or paying twice.
 *
 * All or nothing: if any selected copy became protected or vanished since it
 * was picked, the server refuses the whole batch and names each copy, and the
 * dialog says which ones and why.
 */
import { useState } from 'react';

import { isPortalApiError } from '@/api/client';
import { newRequestKey } from '@/api/equipment';
import { useDismantlePreview, useWorkshopActions } from '@/api/hooks/useEquipment';
import type { DismantleProblemReason, DismantleResult, EquipmentItem } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber } from '@/lib/format';
import { BLOCKER_TEXT, COMPONENTS_LABEL } from './workshopText';

const PROBLEM_TEXT: Readonly<Record<DismantleProblemReason, string>> = {
  ...BLOCKER_TEXT,
  not_owned: 'No longer in your Gear Bag',
  duplicate: 'Selected twice',
};

interface Problem {
  id: number;
  reason: DismantleProblemReason;
}

function problemsOf(error: unknown): Problem[] {
  if (!isPortalApiError(error) || error.code !== 'EQUIPMENT_DISMANTLE_REFUSED') return [];
  const problems = (error.details as { problems?: Problem[] } | undefined)?.problems;
  return Array.isArray(problems) ? problems : [];
}

function describeError(error: unknown): string {
  if (isPortalApiError(error)) {
    if (error.code === 'EQUIPMENT_DISMANTLE_REFUSED')
      return 'Nothing was dismantled. Some of your selection can no longer be dismantled:';
    if (error.code === 'WORKSHOP_PREVIEW_STALE')
      return 'Salvage values changed since you reviewed this. Nothing was dismantled — review it again.';
    if (error.status > 0) return error.message;
  }
  return "That didn't go through. Check your connection and try again — nothing is dismantled twice.";
}

function Body({
  playerId,
  ids,
  names,
  onCancel,
  onDone,
}: {
  playerId: number;
  ids: number[];
  names: ReadonlyMap<number, string>;
  onCancel: () => void;
  onDone: (result: DismantleResult) => void;
}) {
  const preview = useDismantlePreview(playerId, ids);
  const { dismantle } = useWorkshopActions(playerId);
  // One key per review: a retried Confirm replays the same operation.
  const [requestKey] = useState(newRequestKey);
  const [failure, setFailure] = useState<unknown>(null);

  // A refusal or a stale review ends this review; anything else (a dropped
  // connection) leaves Confirm in place, so trying again sends the same key.
  const final = (e: unknown) =>
    isPortalApiError(e) &&
    (e.code === 'EQUIPMENT_DISMANTLE_REFUSED' || e.code === 'WORKSHOP_PREVIEW_STALE');
  const error = preview.isError ? preview.error : final(failure) ? failure : null;
  const transient = failure != null && !final(failure) ? failure : null;
  const problems = problemsOf(error);

  if (preview.isPending) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Reviewing your selection">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <>
        <div role="alert" className="text-sm text-danger">
          <p>{describeError(error)}</p>
          {problems.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5" aria-label="Problems">
              {problems.map((p) => (
                <li key={`${p.id}-${p.reason}`}>
                  {names.get(p.id) ?? 'An item'}: {PROBLEM_TEXT[p.reason] ?? 'Cannot be dismantled'}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="outline" onClick={onCancel}>
            Back to selection
          </Button>
        </div>
      </>
    );
  }

  const data = preview.data!;
  return (
    <>
      <p className="text-sm text-ink">
        <span data-testid="dismantle-count">
          {data.count} item{data.count === 1 ? '' : 's'}
        </span>
      </p>
      <ul className="tabular mt-1 text-sm text-ink" aria-label="By rarity">
        {data.byRarity.map((line) => (
          <li key={line.rarity}>
            {line.count} {line.rarity}
          </li>
        ))}
      </ul>
      <div className="mt-3 rounded-xl border border-border bg-surface-sunken p-3 text-sm">
        <p className="text-ink-muted">Receive</p>
        <p className="tabular text-lg font-semibold text-ink" data-testid="dismantle-total">
          {formatNumber(data.totalComponents)} {COMPONENTS_LABEL}
        </p>
        <p className="tabular text-xs text-ink-subtle">
          {COMPONENTS_LABEL} after: {formatNumber(data.componentsAfter)}
        </p>
      </div>
      <details className="mt-3 text-sm text-ink-muted">
        <summary className="cursor-pointer">Selected items</summary>
        <ul className="mt-1 space-y-0.5">
          {data.items.map((i) => (
            <li key={i.id}>
              {i.name} · {i.rarity} · +{i.components}
            </li>
          ))}
        </ul>
      </details>
      <p className="mt-3 text-sm font-medium text-danger">This cannot be undone.</p>
      {transient != null && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {describeError(transient)}
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          variant="danger"
          disabled={dismantle.isPending}
          onClick={() => {
            setFailure(null);
            dismantle
              .mutateAsync({
                equipmentIds: ids,
                requestKey,
                expectedComponents: data.totalComponents,
              })
              .then(onDone, setFailure);
          }}
        >
          {dismantle.isPending ? 'Dismantling…' : 'Confirm'}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={dismantle.isPending}>
          Cancel
        </Button>
      </div>
    </>
  );
}

export function DismantleReviewDialog({
  playerId,
  selection,
  onClose,
  onDone,
}: {
  playerId: number;
  /** The explicit selection under review, or null when closed. */
  selection: EquipmentItem[] | null;
  onClose: () => void;
  onDone: (result: DismantleResult) => void;
}) {
  const ids = selection?.map((item) => item.id) ?? [];
  const names = new Map(selection?.map((item) => [item.id, item.name]) ?? []);
  return (
    <Dialog open={selection != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-lift)] sm:p-6">
          <DialogTitle className="pr-8 font-display text-2xl leading-tight text-ink">
            Dismantle selected Equipment?
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-ink-muted">
            Patch breaks these down for {COMPONENTS_LABEL}.
          </DialogDescription>
          <div className="mt-4">
            {selection && (
              <Body
                key={ids.join(',')}
                playerId={playerId}
                ids={ids}
                names={names}
                onCancel={onClose}
                onDone={onDone}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
