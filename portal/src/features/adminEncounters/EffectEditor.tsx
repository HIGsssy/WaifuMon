/**
 * Effect editor — one effect, in plain language.
 *
 * The stored effect shape is unchanged (`{ type: 'energy_gain', amount: 3 }`);
 * the editor names each type for what it does ("Gain Energy"), shows a
 * one-line summary ("Gain 3 Energy"), and uses content pickers wherever an
 * effect names another entity (items, vendors, encounters, species), so an
 * author never types a slug. Server-side Zod validation still gates every
 * save, so nothing here bans a valid combination.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import type { AdminEncounterReference, SelectorPreviewEncounter } from '@/api/adminEncounters';

import { describeEffect, EFFECT_TYPE_LABELS, type NameLookups } from './describe';
import { DurationInput } from './DurationInput';
import {
  EFFECT_TYPES,
  ITEM_QUANTITY_MAX,
  ITEM_QUANTITY_MIN,
  switchEffectType,
} from './effectDefaults';
import { EntitySelect, selectClass } from './EntitySelect';
import { VendorEffectFields } from './VendorEffectFields';
import { WaifumonSelectorEditor } from './WaifumonSelectorEditor';
import { WAIFUMON_EFFECT } from './waifumonSelection';

export type EffectShape = Record<string, unknown> & { type: string };

interface Props {
  effect: EffectShape;
  reference: AdminEncounterReference | undefined;
  /** Where the owning encounter can fire — scopes the Waifumon selector preview. */
  encounterContext?: SelectorPreviewEncounter | undefined;
  onChange: (next: EffectShape) => void;
  onRemove: () => void;
  /** Types the picker offers. Follow-ups have their own control, so lists omit them. */
  types?: readonly string[] | undefined;
  names?: NameLookups | undefined;
}

/** Merge helper — returns a new object with the given patch applied. */
function patch(effect: EffectShape, changes: Partial<EffectShape>): EffectShape {
  return { ...effect, ...changes };
}

/**
 * A number input's value, exactly as the effect holds it. A missing field
 * shows empty rather than a made-up fallback, so the form never displays a
 * value Save would not send.
 */
function shown(value: unknown): number | '' {
  return typeof value === 'number' ? value : '';
}

/**
 * Set (or, when the input is cleared, remove) one numeric field. Clearing is
 * deliberate: the field is then absent, and Save is blocked or refused for it,
 * rather than a silent `Number('') === 0` being sent in its place.
 */
function setNumber(effect: EffectShape, field: string, raw: string, scale = 1): EffectShape {
  if (raw === '') {
    const { [field]: _removed, ...rest } = effect;
    return rest as EffectShape;
  }
  return patch(effect, { [field]: Number(raw) / scale });
}

const AMOUNT_TYPES = new Set([
  'waifubux_gain',
  'waifubux_loss',
  'essence_gain',
  'essence_loss',
  'energy_gain',
  'energy_loss',
  'player_xp',
  'buddy_xp',
  'affection_gain',
]);

export function EffectEditor({
  effect,
  reference,
  encounterContext,
  onChange,
  onRemove,
  types = EFFECT_TYPES,
  names = {},
}: Props) {
  const type = String(effect.type);
  const offered = types.includes(type) ? types : [type, ...types];
  const itemOptions = (reference?.items ?? []).map((i) => ({
    value: i.slug,
    label: i.name,
    hint: i.category,
  }));

  return (
    <div
      className="rounded-md border border-border bg-surface-sunken p-3"
      data-testid="effect-editor"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="Effect type"
          value={type}
          onChange={(e) => {
            // The new type's required defaults, plus only the fields it
            // shares with the old one — see `switchEffectType`.
            onChange(switchEffectType(effect, e.target.value));
          }}
          className={cn(selectClass, 'w-auto')}
        >
          {offered.map((t) => (
            <option key={t} value={t}>
              {EFFECT_TYPE_LABELS[t] ?? t}
            </option>
          ))}
        </select>
        <span className="flex-1 text-xs text-ink-muted" data-testid="effect-summary">
          {describeEffect(effect, names)}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {AMOUNT_TYPES.has(type) && (
          <label className="text-xs text-ink-muted">
            Amount
            <Input
              type="number"
              step="1"
              value={shown(effect.amount)}
              onChange={(e) => onChange(setNumber(effect, 'amount', e.target.value))}
            />
          </label>
        )}
        {type === 'waifubux_loss_percent' && (
          <>
            <label className="text-xs text-ink-muted">
              Percent of balance
              <Input
                type="number"
                step="1"
                min="0"
                max="100"
                value={
                  typeof effect.percent === 'number' ? Math.round(effect.percent * 1000) / 10 : ''
                }
                onChange={(e) => onChange(setNumber(effect, 'percent', e.target.value, 100))}
              />
            </label>
            <label className="text-xs text-ink-muted">
              At most (Waifubux, optional)
              <Input
                type="number"
                value={shown(effect.maxAmount)}
                onChange={(e) => onChange(setNumber(effect, 'maxAmount', e.target.value))}
              />
            </label>
          </>
        )}
        {(type === 'give_item' || type === 'consume_item') && (
          <>
            <EntitySelect
              label="Item"
              value={String(effect.slug ?? '')}
              options={itemOptions}
              placeholder="— pick an item —"
              searchLabel="Search items"
              onChange={(slug) => onChange(patch(effect, { slug }))}
            />
            <label className="text-xs text-ink-muted">
              Quantity
              <Input
                type="number"
                min={ITEM_QUANTITY_MIN}
                max={ITEM_QUANTITY_MAX}
                step="1"
                value={shown(effect.quantity)}
                onChange={(e) => onChange(setNumber(effect, 'quantity', e.target.value))}
              />
            </label>
          </>
        )}
        {type === 'trigger_encounter' && (
          <EntitySelect
            label="Continue to"
            className="sm:col-span-2"
            value={String(effect.encounterSlug ?? '')}
            options={(reference?.encounters ?? []).map((e) => ({ value: e.slug, label: e.name }))}
            placeholder="— pick an encounter —"
            searchLabel="Search encounters"
            onChange={(encounterSlug) => onChange(patch(effect, { encounterSlug }))}
          />
        )}
        {type === WAIFUMON_EFFECT && (
          <div className="sm:col-span-2">
            <WaifumonSelectorEditor
              effect={effect}
              reference={reference}
              encounterContext={encounterContext}
              onChange={onChange}
            />
          </div>
        )}
        {type === 'open_vendor' && (
          <div className="sm:col-span-2">
            <VendorEffectFields
              vendorKey={String(effect.vendorKey ?? '')}
              reference={reference}
              onChange={(vendorKey) => onChange(patch(effect, { vendorKey }))}
            />
          </div>
        )}
        {type === 'temp_buff' && (
          <>
            <label className="text-xs text-ink-muted">
              Key
              <Input
                value={String(effect.key ?? '')}
                onChange={(e) => onChange(patch(effect, { key: e.target.value }))}
              />
            </label>
            <DurationInput
              label="Duration"
              seconds={typeof effect.durationSeconds === 'number' ? effect.durationSeconds : 0}
              onChange={(durationSeconds) => onChange(patch(effect, { durationSeconds }))}
            />
          </>
        )}
      </div>
    </div>
  );
}
