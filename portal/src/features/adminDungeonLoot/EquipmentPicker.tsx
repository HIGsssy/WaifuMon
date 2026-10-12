/**
 * Chooses which kind of gear a reward hands out: the selector the Equipment
 * system already takes (an optional slot, an optional N/R/SR rarity, and
 * optionally specific pieces) and nothing more. Shared by the Dungeon Loot
 * editor and by an activity's Rewards section.
 *
 * The "can drop" list is asked of the server, which runs the game's own
 * selector rules, so what is shown is what a run would choose between. These
 * are equipment *definitions*: which one lands and its stats are rolled when
 * it drops.
 */
import { useEffect } from 'react';
import type { EquipmentRewardSelector } from '@/api/adminDungeonLootTables';
import { ErrorState } from '@/components/layout/ErrorState';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { cn } from '@/lib/cn';
import { SLOT_LABELS, type EquipmentPiece } from './lootModel';
import { useEquipmentMatches } from './useEquipmentMatches';

const SLOTS = ['attack', 'defense', 'health'] as const;
const RARITIES = ['N', 'R', 'SR'] as const;
const NAMED_AT_ONCE = 6;

interface Props {
  selector: EquipmentRewardSelector;
  onChange: (selector: EquipmentRewardSelector) => void;
  disabled?: boolean;
  /** How many pieces currently match; null while that is not known. */
  onMatches?: (count: number | null) => void;
}

export function EquipmentPicker({ selector, onChange, disabled = false, onMatches }: Props) {
  const matches = useEquipmentMatches(selector);
  // Every piece a reward may hand out, to offer as specific choices.
  const catalogue = useEquipmentMatches({});
  const chosen = selector.definitionKeys ?? [];
  const count = matches.data ? matches.data.length : null;
  useEffect(() => onMatches?.(count), [count, onMatches]);

  const fits = (piece: EquipmentPiece, next: EquipmentRewardSelector) =>
    (!next.slot || piece.slot === next.slot) && (!next.rarity || piece.rarity === next.rarity);
  /** Changing slot or rarity drops chosen pieces that no longer fit, so the choice stays possible. */
  const set = (patch: { slot?: string; rarity?: string; keys?: string[] }) => {
    const slot = 'slot' in patch ? patch.slot : selector.slot;
    const rarity = 'rarity' in patch ? patch.rarity : selector.rarity;
    const next: EquipmentRewardSelector = {
      ...(slot ? { slot: slot as (typeof SLOTS)[number] } : {}),
      ...(rarity ? { rarity: rarity as (typeof RARITIES)[number] } : {}),
    };
    const known = new Map((catalogue.data ?? []).map((p) => [p.key, p]));
    const keys = (patch.keys ?? chosen).filter((key) => {
      const piece = known.get(key);
      return patch.keys || !piece || fits(piece, next);
    });
    onChange(keys.length > 0 ? { ...next, definitionKeys: keys } : next);
  };
  const offered = (catalogue.data ?? []).filter(
    (piece) => chosen.includes(piece.key) || fits(piece, selector),
  );

  return (
    <div className="space-y-2" data-testid="equipment-picker">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          Rarity
          <select
            aria-label="Equipment rarity"
            className={selectClass}
            value={selector.rarity ?? ''}
            disabled={disabled}
            onChange={(e) => set({ rarity: e.target.value })}
          >
            <option value="">Any rarity (N, R or SR)</option>
            {RARITIES.map((rarity) => (
              <option key={rarity} value={rarity}>
                {rarity}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Slot
          <select
            aria-label="Equipment slot"
            className={selectClass}
            value={selector.slot ?? ''}
            disabled={disabled}
            onChange={(e) => set({ slot: e.target.value })}
          >
            <option value="">Any slot</option>
            {SLOTS.map((slot) => (
              <option key={slot} value={slot}>
                {SLOT_LABELS[slot]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="text-xs text-ink-muted" open={chosen.length > 0}>
        <summary className="cursor-pointer">
          Only specific pieces{' '}
          <span className="text-ink-subtle">
            — {chosen.length === 0 ? 'any matching piece' : `one of ${chosen.length} chosen`}
          </span>
        </summary>
        {catalogue.isPending ? (
          <p className="mt-1">Loading equipment…</p>
        ) : offered.length === 0 ? (
          <p className="mt-1">No equipment has this rarity and slot.</p>
        ) : (
          <ul className="mt-1 max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-border bg-surface p-2">
            {offered.map((piece) => (
              <li key={piece.key}>
                <label className="flex items-center gap-2 text-ink" title={piece.key}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(piece.key)}
                    disabled={disabled}
                    onChange={() =>
                      set({
                        keys: chosen.includes(piece.key)
                          ? chosen.filter((k) => k !== piece.key)
                          : [...chosen, piece.key],
                      })
                    }
                  />
                  <span>{piece.name}</span>
                  <span className="text-ink-muted">
                    {piece.rarity} · {SLOT_LABELS[piece.slot] ?? piece.slot}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </details>
      {matches.isError ? (
        <ErrorState
          variant="inline"
          title="Could not check which equipment matches"
          error={matches.error}
        />
      ) : (
        <p
          className={cn('text-xs', count === 0 ? 'text-danger' : 'text-ink')}
          role={count === 0 ? 'alert' : 'status'}
          data-testid="equipment-matches"
        >
          {matches.data === undefined
            ? 'Checking which pieces match…'
            : count === 0
              ? 'Nothing matches this. Pick a different rarity or slot.'
              : `${count} ${count === 1 ? 'piece' : 'pieces'} can drop: ${matches.data
                  .slice(0, NAMED_AT_ONCE)
                  .map((p) => p.name)
                  .join(
                    ', ',
                  )}${matches.data.length > NAMED_AT_ONCE ? ` and ${matches.data.length - NAMED_AT_ONCE} more` : ''}.`}
        </p>
      )}
      <p className="text-xs text-ink-muted">
        Gives one piece. The exact piece is random among these, and its stats are rolled when it
        drops.
      </p>
    </div>
  );
}
