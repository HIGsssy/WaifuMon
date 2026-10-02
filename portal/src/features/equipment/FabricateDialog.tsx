/**
 * Fabricate Equipment with Patch: recipe → slot → confirm → reveal.
 *
 * Recipes, costs, balances, per-slot availability ("Health — 0 eligible") and
 * affordability all come from `GET …/equipment/workshop`; the dialog decides
 * none of them. An unavailable slot or an unaffordable recipe is disabled
 * because the server said so, and the fabricate route re-checks everything.
 *
 * The confirm step mints one request key. Clicking Confirm again after a
 * dropped connection sends the same key, so the server returns the item it
 * already made rather than charging twice or rolling again. "Fabricate Again"
 * is a new confirmation and gets a new key.
 */
import { useState, type ReactNode } from 'react';

import { isPortalApiError } from '@/api/client';
import { newRequestKey } from '@/api/equipment';
import { useWorkshop, useWorkshopActions } from '@/api/hooks/useEquipment';
import type { FabricationResult, WorkshopRecipe, WorkshopSlotChoice } from '@/api/types';
import { ErrorState } from '@/components/layout/ErrorState';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { formatNumber } from '@/lib/format';
import { SLOT_LABEL, SLOT_STAT, STAT_LABEL, formatMultiplier } from './format';
import { COMPONENTS_LABEL, SLOT_CHOICE_LABEL } from './workshopText';

type Step =
  | { step: 'recipe' }
  | { step: 'slot'; recipeKey: string }
  | { step: 'confirm'; recipeKey: string; slot: WorkshopSlotChoice; requestKey: string }
  | { step: 'result'; result: FabricationResult };

const costText = (r: Pick<WorkshopRecipe, 'componentCost' | 'waifubuxCost'>) =>
  `${formatNumber(r.componentCost)} Components + ${formatNumber(r.waifubuxCost)} WaifuBux`;

function shortfallText(r: WorkshopRecipe): string | null {
  if (r.affordable) return null;
  const parts = [
    r.shortfall.components > 0
      ? `${formatNumber(r.shortfall.components)} more ${COMPONENTS_LABEL}`
      : '',
    r.shortfall.waifubux > 0 ? `${formatNumber(r.shortfall.waifubux)} more WaifuBux` : '',
  ].filter(Boolean);
  return `Needs ${parts.join(' and ')}.`;
}

function describeError(error: unknown): string {
  if (isPortalApiError(error) && error.status > 0) return error.message;
  return "That didn't go through. Check your connection and try again — you won't be charged twice.";
}

function RecipeStep({
  recipes,
  onPick,
}: {
  recipes: WorkshopRecipe[];
  onPick: (key: string) => void;
}) {
  if (recipes.length === 0) {
    return <p className="text-sm text-ink-muted">Patch isn&apos;t taking orders right now.</p>;
  }
  return (
    <ul className="space-y-3" aria-label="Recipes">
      {recipes.map((r) => (
        <li key={r.key} className="rounded-xl border border-border bg-surface-sunken p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-ink">{r.name}</span>
            <RarityBadge rarity={r.rarity} />
          </div>
          <p className="text-sm text-ink-muted">{r.rarity} Equipment</p>
          <p className="tabular mt-1 text-sm text-ink">{costText(r)}</p>
          <ul className="mt-1 text-xs text-ink-muted" aria-label={`${r.name} availability`}>
            {r.slots.map((s) => (
              <li key={s.choice}>
                {SLOT_CHOICE_LABEL[s.choice].split(' ')[0]} —{' '}
                {s.available ? 'Available' : `${s.eligibleCount} eligible`}
              </li>
            ))}
          </ul>
          {shortfallText(r) && <p className="mt-1 text-xs text-warning">{shortfallText(r)}</p>}
          <Button
            className="mt-2"
            variant="outline"
            disabled={!r.available}
            onClick={() => onPick(r.key)}
            aria-label={`Choose ${r.name}`}
          >
            Choose
          </Button>
        </li>
      ))}
    </ul>
  );
}

function SlotStep({
  recipe,
  onPick,
  onBack,
}: {
  recipe: WorkshopRecipe;
  onPick: (slot: WorkshopSlotChoice) => void;
  onBack: () => void;
}) {
  return (
    <>
      <p className="text-sm text-ink">
        <span className="font-medium">{recipe.name}</span> · {recipe.rarity} · {costText(recipe)}
      </p>
      <p className="mt-1 text-sm text-ink-muted">Choose the slot Patch should build for.</p>
      <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="Slot">
        {recipe.slots.map((s) => (
          <Button
            key={s.choice}
            variant="outline"
            disabled={!s.available}
            onClick={() => onPick(s.choice)}
          >
            {s.available
              ? SLOT_CHOICE_LABEL[s.choice]
              : `${SLOT_CHOICE_LABEL[s.choice].split(' ')[0]} — ${s.eligibleCount} eligible`}
          </Button>
        ))}
      </div>
      <div className="mt-4">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
      </div>
    </>
  );
}

function ConfirmStep({
  playerId,
  recipe,
  slot,
  requestKey,
  balances,
  onBack,
  onDone,
}: {
  playerId: number;
  recipe: WorkshopRecipe;
  slot: WorkshopSlotChoice;
  requestKey: string;
  balances: { components: number; waifubux: number };
  onBack: () => void;
  onDone: (result: FabricationResult) => void;
}) {
  const { fabricate } = useWorkshopActions(playerId);
  const [failure, setFailure] = useState<string | null>(null);
  const available = recipe.slots.find((s) => s.choice === slot)?.available ?? false;
  return (
    <>
      <p className="text-sm text-ink" data-testid="fabricate-summary">
        <span className="font-medium">{recipe.name}</span> · {recipe.rarity} ·{' '}
        {SLOT_CHOICE_LABEL[slot]}
      </p>
      <dl className="tabular mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl border border-border bg-surface-sunken p-3 text-sm">
        <dt className="text-ink-muted">Cost</dt>
        <dd className="text-right text-ink" data-testid="fabricate-cost">
          {costText(recipe)}
        </dd>
        <dt className="text-ink-muted">You have</dt>
        <dd className="text-right text-ink">
          {formatNumber(balances.components)} Components · {formatNumber(balances.waifubux)}{' '}
          WaifuBux
        </dd>
      </dl>
      {shortfallText(recipe) && (
        <p className="mt-2 text-sm text-warning">{shortfallText(recipe)}</p>
      )}
      <p className="mt-2 text-xs text-ink-subtle">
        Patch guarantees the rarity — the piece, its multiplier and its affix are random.
      </p>
      {failure && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {failure}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          disabled={fabricate.isPending || !recipe.affordable || !available}
          onClick={() => {
            setFailure(null);
            fabricate
              .mutateAsync({ recipeKey: recipe.key, slot, requestKey })
              .then(onDone, (e: unknown) => setFailure(describeError(e)));
          }}
        >
          {fabricate.isPending ? 'Fabricating…' : 'Confirm'}
        </Button>
        <Button variant="outline" onClick={onBack} disabled={fabricate.isPending}>
          Back
        </Button>
      </div>
    </>
  );
}

function ResultStep({
  result,
  onInspect,
  onClose,
  onAgain,
}: {
  result: FabricationResult;
  onInspect: () => void;
  onClose: () => void;
  onAgain: () => void;
}) {
  const { item } = result;
  return (
    <>
      {result.replayed && (
        <p role="status" className="text-sm text-ink-muted">
          Patch already built this one — here it is.
        </p>
      )}
      <div
        className="mt-2 rounded-xl border border-success/40 bg-success-soft p-4"
        data-testid="fabricate-result"
      >
        <p className="text-xs text-ink-muted">Patch built</p>
        <p className="font-display text-xl break-words text-ink">{item.name}</p>
        <dl className="tabular mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">Rarity</dt>
          <dd className="text-right">
            <RarityBadge rarity={item.rarity} />
          </dd>
          <dt className="text-ink-muted">Slot</dt>
          <dd className="text-right text-ink">{SLOT_LABEL[item.slot]}</dd>
          <dt className="text-ink-muted">Multiplier</dt>
          <dd className="text-right font-semibold text-ink">
            {STAT_LABEL[SLOT_STAT[item.slot]]} {formatMultiplier(item.multiplier)}
          </dd>
          <dt className="text-ink-muted">Affix</dt>
          <dd className="text-right text-ink">{item.affix ?? 'None'}</dd>
        </dl>
      </div>
      <p className="tabular mt-3 text-sm text-ink-muted" data-testid="fabricate-remaining">
        Remaining: {formatNumber(result.balances.components)} {COMPONENTS_LABEL} ·{' '}
        {formatNumber(result.balances.waifubux)} WaifuBux
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={onInspect}>Inspect</Button>
        <Button variant="outline" onClick={onClose}>
          Back to Gear Bag
        </Button>
        <Button variant="outline" onClick={onAgain}>
          Fabricate Again
        </Button>
      </div>
    </>
  );
}

export function FabricateDialog({
  playerId,
  open,
  onClose,
  onInspect,
}: {
  playerId: number;
  open: boolean;
  onClose: () => void;
  onInspect: (item: { id: number; name: string }) => void;
}) {
  const workshop = useWorkshop(playerId);
  const [state, setState] = useState<Step>({ step: 'recipe' });
  const close = () => {
    setState({ step: 'recipe' });
    onClose();
  };
  const recipeOf = (key: string) => workshop.data?.recipes.find((r) => r.key === key);

  let body: ReactNode;
  if (workshop.isError) {
    body = (
      <ErrorState
        variant="inline"
        error={workshop.error}
        onRetry={() => void workshop.refetch()}
        title="Couldn't load Patch's recipes."
      />
    );
  } else if (!workshop.data) {
    body = <Skeleton className="h-32 w-full rounded-xl" />;
  } else if (state.step === 'result') {
    const { result } = state;
    body = (
      <ResultStep
        result={result}
        onInspect={() => {
          close();
          onInspect({ id: result.item.id, name: result.item.name });
        }}
        onClose={close}
        onAgain={() =>
          setState({
            step: 'confirm',
            recipeKey: result.recipe.key,
            slot: result.slotChoice,
            requestKey: newRequestKey(),
          })
        }
      />
    );
  } else if (state.step === 'recipe') {
    body = (
      <RecipeStep
        recipes={workshop.data.recipes}
        onPick={(recipeKey) => setState({ step: 'slot', recipeKey })}
      />
    );
  } else {
    const recipe = recipeOf(state.recipeKey);
    if (!recipe) {
      body = (
        <>
          <p className="text-sm text-ink-muted">Patch isn&apos;t taking that order right now.</p>
          <Button className="mt-3" variant="outline" onClick={() => setState({ step: 'recipe' })}>
            Back
          </Button>
        </>
      );
    } else if (state.step === 'slot') {
      body = (
        <SlotStep
          recipe={recipe}
          onBack={() => setState({ step: 'recipe' })}
          onPick={(slot) =>
            setState({ step: 'confirm', recipeKey: recipe.key, slot, requestKey: newRequestKey() })
          }
        />
      );
    } else {
      body = (
        <ConfirmStep
          key={state.requestKey}
          playerId={playerId}
          recipe={recipe}
          slot={state.slot}
          requestKey={state.requestKey}
          balances={workshop.data.balances}
          onBack={() => setState({ step: 'slot', recipeKey: recipe.key })}
          onDone={(result) => setState({ step: 'result', result })}
        />
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-lift)] sm:p-6">
          <DialogTitle className="pr-8 font-display text-2xl leading-tight text-ink">
            Fabricate Equipment
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-ink-muted">
            Spend {COMPONENTS_LABEL} and WaifuBux — Patch builds a new random piece of the rarity
            you choose.
          </DialogDescription>
          <div className="mt-4">{body}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
