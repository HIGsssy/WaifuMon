/**
 * The "Give equipment" effect: which *kind* of gear an encounter hands out.
 *
 * The author picks only the selector the server's reward path takes — an
 * optional slot, an optional N/R/SR rarity, and optionally a short list of
 * definitions. Which definition lands, its multiplier and its affix are all
 * rolled by the Equipment system, so there are deliberately no controls for
 * them here. The server validates the selector on save (a disabled or
 * mismatched definition, or a selector nothing matches, is refused).
 */
import type { AdminEncounterReference } from '@/api/adminEncounters';
import { cn } from '@/lib/cn';
import { selectClass } from './EntitySelect';
import type { EffectShape } from './EffectEditor';

/** Slots and rarities a random reward may name — mirrors the server's selector. */
export const EQUIPMENT_REWARD_SLOTS = ['attack', 'defense', 'health'] as const;
export const EQUIPMENT_REWARD_RARITIES = ['N', 'R', 'SR'] as const;

const SLOT_LABELS: Record<string, string> = { attack: 'Attack', defense: 'Defense', health: 'Health' };

interface Props {
  effect: EffectShape;
  reference: AdminEncounterReference | undefined;
  onChange: (next: EffectShape) => void;
}

/** Set, or (for "Any" / an empty list) remove, one selector field. */
function withField(effect: EffectShape, field: string, value: unknown): EffectShape {
  const { [field]: _removed, ...rest } = effect;
  const empty = value === '' || (Array.isArray(value) && value.length === 0);
  return (empty ? rest : { ...rest, [field]: value }) as EffectShape;
}

export function EquipmentRewardFields({ effect, reference, onChange }: Props) {
  const slot = typeof effect.slot === 'string' ? effect.slot : '';
  const rarity = typeof effect.rarity === 'string' ? effect.rarity : '';
  const chosen = Array.isArray(effect.definitionKeys) ? (effect.definitionKeys as string[]) : [];
  const all = reference?.equipmentDefinitions ?? [];

  // Offered: enabled, randomly acquirable definitions matching the filters.
  // Anything already chosen stays listed (flagged) so it can be unticked even
  // after it stops matching — the server explains why it is refused.
  const offered = all.filter(
    (d) =>
      chosen.includes(d.key) ||
      (d.enabled &&
        (EQUIPMENT_REWARD_RARITIES as readonly string[]).includes(d.rarity) &&
        (slot === '' || d.slot === slot) &&
        (rarity === '' || d.rarity === rarity)),
  );

  const toggle = (key: string) =>
    onChange(
      withField(
        effect,
        'definitionKeys',
        chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key],
      ),
    );

  return (
    <div className="space-y-2" data-testid="equipment-reward-effect">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          Slot
          <select
            aria-label="Equipment slot"
            className={selectClass}
            value={slot}
            onChange={(e) => onChange(withField(effect, 'slot', e.target.value))}
          >
            <option value="">Any slot</option>
            {EQUIPMENT_REWARD_SLOTS.map((s) => (
              <option key={s} value={s}>
                {SLOT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Rarity
          <select
            aria-label="Equipment rarity"
            className={selectClass}
            value={rarity}
            onChange={(e) => onChange(withField(effect, 'rarity', e.target.value))}
          >
            <option value="">Any (N, R or SR)</option>
            {EQUIPMENT_REWARD_RARITIES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="text-xs text-ink-muted">
        <legend>
          Definitions{' '}
          <span className="text-ink-muted">
            — {chosen.length === 0 ? 'any matching definition' : `one of ${chosen.length} selected`}
          </span>
        </legend>
        {offered.length === 0 ? (
          <p className="mt-1" data-testid="equipment-reward-none">
            No enabled equipment matches this slot and rarity.
          </p>
        ) : (
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border bg-surface p-2">
            {offered.map((d) => (
              <li key={d.key}>
                <label className={cn('flex items-center gap-2 text-ink', !d.enabled && 'text-ink-muted')}>
                  <input type="checkbox" checked={chosen.includes(d.key)} onChange={() => toggle(d.key)} />
                  <span>{d.name}</span>
                  <span className="text-ink-muted">
                    {d.rarity} · {SLOT_LABELS[d.slot] ?? d.slot}
                    {d.enabled ? '' : ' · disabled'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <p className="text-xs text-ink-muted">
        Grants one item. Its multiplier and affix are rolled by the Equipment system.
      </p>
    </div>
  );
}
