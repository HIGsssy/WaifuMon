/**
 * Effect editor — a structured control for one {@link Effect}. The
 * discriminated `type` field drives which secondary fields are visible;
 * server-side Zod validation still gates every save, so the frontend never
 * bans a valid combination client-side.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AdminEncounterReference, SelectorPreviewEncounter } from '@/api/adminEncounters';

import {
  EFFECT_TYPES,
  ITEM_QUANTITY_MAX,
  ITEM_QUANTITY_MIN,
  switchEffectType,
} from './effectDefaults';
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
function setNumber(effect: EffectShape, field: string, raw: string): EffectShape {
  if (raw === '') {
    const { [field]: _removed, ...rest } = effect;
    return rest as EffectShape;
  }
  return patch(effect, { [field]: Number(raw) });
}

export function EffectEditor({ effect, reference, encounterContext, onChange, onRemove }: Props) {
  const type = String(effect.type);
  return (
    <div
      className="rounded-md border border-border bg-surface-sunken p-3"
      data-testid="effect-editor"
    >
      <div className="mb-2 flex items-center gap-2">
        <select
          aria-label="Effect type"
          value={type}
          onChange={(e) => {
            // The new type's required defaults, plus only the fields it
            // shares with the old one — see `switchEffectType`.
            onChange(switchEffectType(effect, e.target.value));
          }}
          className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
        >
          {EFFECT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <Button type="button" size="sm" variant="outline" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(type === 'waifubux_gain' ||
          type === 'waifubux_loss' ||
          type === 'essence_gain' ||
          type === 'essence_loss' ||
          type === 'energy_gain' ||
          type === 'energy_loss' ||
          type === 'player_xp' ||
          type === 'buddy_xp' ||
          type === 'affection_gain') && (
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
              Percent (0–1)
              <Input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={shown(effect.percent)}
                onChange={(e) => onChange(setNumber(effect, 'percent', e.target.value))}
              />
            </label>
            <label className="text-xs text-ink-muted">
              Cap (WB, optional)
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
            <label className="text-xs text-ink-muted">
              Item
              <select
                value={String(effect.slug ?? '')}
                onChange={(e) => onChange(patch(effect, { slug: e.target.value }))}
                className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
              >
                <option value="">— pick an item —</option>
                {(reference?.items ?? []).map((i) => (
                  <option key={i.slug} value={i.slug}>
                    {i.name} ({i.slug})
                  </option>
                ))}
              </select>
            </label>
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
          <label className="text-xs text-ink-muted col-span-2">
            Chained encounter
            <select
              value={String(effect.encounterSlug ?? '')}
              onChange={(e) => onChange(patch(effect, { encounterSlug: e.target.value }))}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
            >
              <option value="">— pick an encounter —</option>
              {(reference?.encounters ?? []).map((e) => (
                <option key={e.slug} value={e.slug}>
                  {e.name} ({e.slug})
                </option>
              ))}
            </select>
          </label>
        )}
        {type === WAIFUMON_EFFECT && (
          <div className="col-span-2">
            <WaifumonSelectorEditor
              effect={effect}
              reference={reference}
              encounterContext={encounterContext}
              onChange={onChange}
            />
          </div>
        )}
        {type === 'open_vendor' && (
          <label className="text-xs text-ink-muted col-span-2">
            Vendor
            <select
              value={String(effect.vendorKey ?? '')}
              onChange={(e) => onChange(patch(effect, { vendorKey: e.target.value }))}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
            >
              <option value="">— pick a vendor —</option>
              {(reference?.vendors ?? []).map((v) => (
                <option key={v.vendorKey} value={v.vendorKey}>
                  {v.name} ({v.vendorKey})
                </option>
              ))}
            </select>
          </label>
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
            <label className="text-xs text-ink-muted">
              Duration (s)
              <Input
                type="number"
                min="1"
                step="1"
                value={shown(effect.durationSeconds)}
                onChange={(e) => onChange(setNumber(effect, 'durationSeconds', e.target.value))}
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}
