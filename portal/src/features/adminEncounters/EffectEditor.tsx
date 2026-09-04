/**
 * Effect editor — a structured control for one {@link Effect}. The
 * discriminated `type` field drives which secondary fields are visible;
 * server-side Zod validation still gates every save, so the frontend never
 * bans a valid combination client-side.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AdminEncounterReference } from '@/api/adminEncounters';

const EFFECT_TYPES = [
  'waifubux_gain',
  'waifubux_loss',
  'waifubux_loss_percent',
  'essence_gain',
  'essence_loss',
  'energy_gain',
  'energy_loss',
  'player_xp',
  'buddy_xp',
  'give_item',
  'consume_item',
  'trigger_encounter',
  'trigger_waifumon_encounter',
  'temp_buff',
  'open_vendor',
] as const;

export type EffectShape = Record<string, unknown> & { type: string };

interface Props {
  effect: EffectShape;
  reference: AdminEncounterReference | undefined;
  onChange: (next: EffectShape) => void;
  onRemove: () => void;
}

/** Merge helper — returns a new object with the given patch applied. */
function patch(effect: EffectShape, changes: Partial<EffectShape>): EffectShape {
  return { ...effect, ...changes };
}

export function EffectEditor({ effect, reference, onChange, onRemove }: Props) {
  const type = String(effect.type ?? 'waifubux_gain');
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <div className="mb-2 flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => onChange(patch(effect, { type: e.target.value }))}
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
          type === 'buddy_xp') && (
          <label className="text-xs text-ink-muted">
            Amount
            <Input
              type="number"
              value={Number(effect.amount ?? 0)}
              onChange={(e) => onChange(patch(effect, { amount: Number(e.target.value) }))}
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
                value={Number(effect.percent ?? 0.1)}
                onChange={(e) => onChange(patch(effect, { percent: Number(e.target.value) }))}
              />
            </label>
            <label className="text-xs text-ink-muted">
              Cap (WB, optional)
              <Input
                type="number"
                value={effect.maxAmount == null ? '' : Number(effect.maxAmount)}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange(
                    patch(effect, v === '' ? { maxAmount: undefined } : { maxAmount: Number(v) }),
                  );
                }}
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
                min="1"
                value={Number(effect.quantity ?? 1)}
                onChange={(e) => onChange(patch(effect, { quantity: Number(e.target.value) }))}
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
        {type === 'trigger_waifumon_encounter' && (
          <label className="text-xs text-ink-muted col-span-2">
            Wild Waifumon
            {/*
              Canonical selector rather than a free-text slug: a typo here
              used to be invisible until a player hit the choice and met
              nobody. Leaving it on "any" hands the pick to the same
              region/rarity draw a hunt uses.
            */}
            <select
              value={String(effect.speciesSlug ?? '')}
              onChange={(e) =>
                onChange(patch(effect, { speciesSlug: e.target.value || undefined }))
              }
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
            >
              <option value="">— any (region/rarity roll) —</option>
              {(reference?.species ?? []).map((sp) => (
                <option key={sp.slug} value={sp.slug}>
                  {sp.name} ({sp.rarity})
                </option>
              ))}
            </select>
          </label>
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
                value={Number(effect.durationSeconds ?? 3600)}
                onChange={(e) =>
                  onChange(patch(effect, { durationSeconds: Number(e.target.value) }))
                }
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}
