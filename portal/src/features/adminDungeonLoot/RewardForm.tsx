/**
 * The one small form that says what a reward gives: a type first, then only
 * the fields that type needs. Shared by the Dungeon Loot editor and by an
 * activity's Rewards section.
 *
 * `RewardForm` is the controlled fields; `RewardEditor` wraps it with the
 * draft state and the confirm / cancel buttons a row uses. Both hand back a
 * schema-compatible grant, never a half-finished one.
 */
import { useCallback, useState, type ReactNode } from 'react';
import type { DungeonRewardGrant } from '@/api/adminDungeonLootTables';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { EquipmentPicker } from './EquipmentPicker';
import { ItemPicker } from './ItemPicker';
import {
  REWARD_KINDS,
  draftOfGrant,
  emptyRewardDraft,
  grantOfDraft,
  isAtRisk,
  type ItemRef,
  type RewardDraft,
} from './lootModel';

interface FormProps {
  draft: RewardDraft;
  onChange: (draft: RewardDraft) => void;
  items: readonly ItemRef[];
  disabled?: boolean;
  onEquipmentMatches?: (count: number | null) => void;
}

export function RewardForm({ draft, onChange, items, disabled, onEquipmentMatches }: FormProps) {
  const set = (patch: Partial<RewardDraft>) => onChange({ ...draft, ...patch });
  const kind = draft.kind;
  const noun = kind === 'item' ? 'How many' : 'Amount';
  return (
    <div className="space-y-3" data-testid="reward-form">
      <fieldset>
        <legend className="text-xs text-ink-muted">What to give</legend>
        <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Reward type">
          {REWARD_KINDS.map((option) => (
            <button
              key={option.kind}
              type="button"
              role="radio"
              aria-checked={kind === option.kind}
              disabled={disabled}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-sm',
                kind === option.kind
                  ? 'border-accent bg-surface-raised text-ink'
                  : 'border-border text-ink-muted hover:text-ink',
              )}
              onClick={() => set({ kind: option.kind })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>
      {kind === 'item' && (
        <ItemPicker
          items={items}
          value={draft.item}
          onChange={(item) => set({ item })}
          {...(disabled ? { disabled } : {})}
        />
      )}
      {kind === 'equipment' && (
        <EquipmentPicker
          selector={draft.selector}
          onChange={(selector) => set({ selector })}
          {...(disabled ? { disabled } : {})}
          {...(onEquipmentMatches ? { onMatches: onEquipmentMatches } : {})}
        />
      )}
      {kind && kind !== 'equipment' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-muted">
            {draft.ranged ? 'Lowest' : noun}
            <Input
              aria-label={draft.ranged ? 'Lowest amount' : noun}
              className="w-28"
              inputMode="numeric"
              value={draft.amount}
              disabled={disabled}
              onChange={(e) => set({ amount: e.target.value })}
            />
          </label>
          {draft.ranged && (
            <label className="text-xs text-ink-muted">
              Highest
              <Input
                aria-label="Highest amount"
                className="w-28"
                inputMode="numeric"
                value={draft.max}
                disabled={disabled}
                onChange={(e) => set({ max: e.target.value })}
              />
            </label>
          )}
          <Button
            type="button"
            variant="link"
            size="sm"
            disabled={disabled}
            onClick={() =>
              set({ ranged: !draft.ranged, max: draft.ranged ? draft.max : draft.amount })
            }
          >
            {draft.ranged ? 'Use a single amount' : 'Use a range'}
          </Button>
        </div>
      )}
      {kind && (
        <p className="text-xs text-ink-muted" data-testid="reward-note">
          {kind === 'affection'
            ? 'Goes to the WaifuMon the player brought into this run, even if they switch Buddy afterwards. Kept on defeat. The Buddy’s own affection bonus applies.'
            : isAtRisk(kind)
              ? 'At risk: held during the run and banked when the player extracts or completes the dungeon.'
              : kind === 'equipment'
                ? 'Kept: given straight away and never taken back.'
                : `Kept: given straight away and never taken back.${draft.ranged ? ' A random amount in the range is given each time.' : ''}`}
        </p>
      )}
    </div>
  );
}

interface EditorProps {
  /** The reward being changed; omit to add a new one. */
  initial?: DungeonRewardGrant;
  items: readonly ItemRef[];
  confirmLabel: string;
  onConfirm: (grant: DungeonRewardGrant) => void;
  onCancel: () => void;
  /** Extra fields a row needs with its reward, such as a chance or a share. */
  children?: ReactNode;
  /** Why those extra fields are not ready, if they are not. */
  blocked?: string | null;
}

export function RewardEditor({
  initial,
  items,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
  blocked = null,
}: EditorProps) {
  const [draft, setDraft] = useState(() => (initial ? draftOfGrant(initial) : emptyRewardDraft()));
  const [matches, setMatches] = useState<number | null>(null);
  const noteMatches = useCallback((count: number | null) => setMatches(count), []);
  const result = grantOfDraft(draft);
  // The picker states an empty equipment choice itself; here it only holds the button.
  const noGear = draft.kind === 'equipment' && matches === 0;
  const problem = 'problem' in result ? result.problem : blocked;
  return (
    <div
      className="space-y-3 rounded-lg border border-border-strong bg-surface p-3"
      data-testid="reward-editor"
    >
      {children}
      <RewardForm
        draft={draft}
        onChange={setDraft}
        items={items}
        onEquipmentMatches={noteMatches}
      />
      {draft.kind && problem && (
        <p className="text-xs text-danger" role="alert">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="accent"
          size="sm"
          disabled={'problem' in result || !!blocked || noGear}
          onClick={() => 'grant' in result && onConfirm(result.grant)}
        >
          {confirmLabel}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
