/**
 * Choice editor — the full form for one choice, shown when its card is
 * expanded (see `ChoiceCard`).
 *
 * Progressive disclosure throughout: a requirement's control appears only once
 * that requirement is added; skill-check tuning only for a skill check; the
 * failure result only when the choice can fail. Nothing is removed from the
 * stored shape — a legacy check or a failure effect on an automatic choice is
 * still shown, with a note, rather than hidden where it cannot be fixed.
 */
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import type { AdminEncounterReference, SelectorPreviewEncounter } from '@/api/adminEncounters';
import { EntitySelect, selectClass } from './EntitySelect';
import type { EffectShape } from './EffectEditor';
import { OutcomeEditor } from './OutcomeEditor';

export interface ChoiceDraft {
  label: string;
  emoji: string | null;
  requirements: {
    affinity?: string;
    raceAny?: string[];
    minPlayerLevel?: number;
    minBuddyLevel?: number;
    requiresItem?: string;
  };
  check: {
    type: 'none' | 'sp';
    /** New model: author-set success chance (0–1). Its presence selects the new formula. */
    baseChance?: number;
    /** New model: max absolute SP contribution (0–0.5). */
    maxSpModifier?: number;
    /** Legacy model: SP target compared against the buddy. */
    difficulty?: number;
    /** Legacy model: flat shift to the fixed 50% base. */
    baseBias?: number;
    affinityAdvantage?: string;
    raceAdvantage?: string[];
  };
  successEffects: EffectShape[];
  failureEffects: EffectShape[];
  /**
   * Authored flavor text, as typed. Success/Failure Text stay here while the
   * check is switched off, so turning it back on restores them; `toPayload`
   * decides what is actually saved.
   */
  outcomeText?: string;
  successText?: string;
  failureText?: string;
}

const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-ink';

/** Matches the server's limit (`OUTCOME_TEXT_MAX_LENGTH`). */
const FLAVOR_MAX_LENGTH = 500;

type RequirementKey = keyof ChoiceDraft['requirements'];

const REQUIREMENT_LABELS: Record<RequirementKey, string> = {
  requiresItem: 'Owns an item',
  minPlayerLevel: 'Minimum player level',
  minBuddyLevel: 'Minimum buddy level',
  affinity: 'Buddy affinity',
  raceAny: 'Buddy race',
};

/** Starting value when a requirement is added, so what is shown is what is saved. */
const REQUIREMENT_DEFAULTS: Record<RequirementKey, unknown> = {
  requiresItem: '',
  minPlayerLevel: 1,
  minBuddyLevel: 1,
  affinity: '',
  raceAny: [],
};

interface Props {
  index: number;
  choice: ChoiceDraft;
  reference: AdminEncounterReference | undefined;
  /** Where the encounter can fire — handed to Waifumon selector previews. */
  encounterContext?: SelectorPreviewEncounter | undefined;
  onChange: (next: ChoiceDraft) => void;
  onRemove: () => void;
  onMoveUp: (() => void) | undefined;
  onMoveDown: (() => void) | undefined;
  /** Collapse back to the summary card. Absent when rendered on its own. */
  onDone?: () => void | undefined;
}

/**
 * Strip keys whose value is undefined, so exactOptionalPropertyTypes does not
 * reject `{ foo: undefined }` on shapes that declare `foo?: T`.
 */
function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Toggle chips for a small fixed vocabulary (races). */
function ChipMultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="text-xs text-ink-muted" role="group" aria-label={label}>
      <span className="block">{label}</span>
      <div className="mt-1 flex flex-wrap gap-1">
        {options.map((o) => {
          const on = value.includes(o);
          return (
            <Button
              key={o}
              type="button"
              size="sm"
              variant={on ? 'accent' : 'outline'}
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((v) => v !== o) : [...value, o])}
            >
              {on && <span aria-hidden="true">✓</span>}
              {titleCase(o)}
            </Button>
          );
        })}
        {/* Tags stored by older content that the vocabulary no longer lists. */}
        {value
          .filter((v) => !options.includes(v))
          .map((v) => (
            <Button
              key={v}
              type="button"
              size="sm"
              variant="default"
              aria-pressed
              onClick={() => onChange(value.filter((x) => x !== v))}
            >
              {v} ×
            </Button>
          ))}
      </div>
    </div>
  );
}

export function ChoiceEditor({
  index,
  choice,
  reference,
  encounterContext,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  onDone,
}: Props) {
  const patch = (changes: Partial<ChoiceDraft>) => onChange({ ...choice, ...changes });
  const patchRequirements = (updates: Record<string, unknown>) =>
    patch({
      requirements: stripUndefined({
        ...choice.requirements,
        ...updates,
      }) as ChoiceDraft['requirements'],
    });
  const patchCheck = (updates: Record<string, unknown>) =>
    patch({ check: stripUndefined({ ...choice.check, ...updates }) as ChoiceDraft['check'] });

  // A check is "legacy" only when it carries a `difficulty` and no `baseChance`.
  // Anything else that is SP-based (including a freshly created check) is the
  // new base-chance model. Legacy checks are shown as-is and never auto-migrated.
  const isSpCheck = choice.check.type === 'sp';
  const isLegacyModelSpCheck =
    isSpCheck && choice.check.baseChance === undefined && choice.check.difficulty !== undefined;
  const isNewModelSpCheck = isSpCheck && !isLegacyModelSpCheck;

  const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  const clampMaxSp = (n: number) => Math.max(0, Math.min(0.5, Number.isFinite(n) ? n : 0));

  // Requirements the author has turned on. A requirement added but not yet
  // filled in (an empty item) is kept visible via `pending` so its control
  // does not vanish before a value is chosen.
  const [pending, setPending] = useState<RequirementKey[]>([]);
  const present = (Object.keys(REQUIREMENT_LABELS) as RequirementKey[]).filter(
    (k) => choice.requirements[k] !== undefined || pending.includes(k),
  );
  const addable = (Object.keys(REQUIREMENT_LABELS) as RequirementKey[]).filter(
    (k) => !present.includes(k),
  );
  const removeRequirement = (k: RequirementKey) => {
    setPending((p) => p.filter((x) => x !== k));
    patchRequirements({ [k]: undefined });
  };

  const affinities = reference?.affinities ?? [];
  const races = reference?.races ?? [];
  const itemOptions = (reference?.items ?? []).map((i) => ({
    value: i.slug,
    label: i.name,
    hint: i.category,
  }));

  return (
    <div
      className="space-y-3 rounded-md border border-border bg-surface p-3"
      data-testid="choice-editor"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium">Choice #{index + 1}</h4>
        <div className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!onMoveUp}
          onClick={onMoveUp}
          aria-label="Move choice up"
        >
          ↑
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!onMoveDown}
          onClick={onMoveDown}
          aria-label="Move choice down"
        >
          ↓
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
        {onDone && (
          <Button type="button" size="sm" variant="outline" onClick={onDone}>
            Done
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <label className="text-xs text-ink-muted">
          Label
          <Input
            value={choice.label}
            maxLength={80}
            onChange={(e) => patch({ label: e.target.value })}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Emoji (optional)
          <Input
            value={choice.emoji ?? ''}
            onChange={(e) => patch({ emoji: e.target.value || null })}
          />
        </label>
      </div>

      {/* ── Requirements ── */}
      <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-xs uppercase text-ink-muted">Who can pick it</legend>
        {present.length === 0 && (
          <p className="text-xs text-ink-muted">Anyone. Add a requirement to limit it.</p>
        )}
        {present.map((k) => (
          <div key={k} className="flex items-end gap-2">
            <div className="flex-1">
              {k === 'requiresItem' && (
                <EntitySelect
                  label="Required item"
                  value={choice.requirements.requiresItem ?? ''}
                  options={itemOptions}
                  placeholder="— pick an item —"
                  searchLabel="Search required items"
                  onChange={(slug) => patchRequirements({ requiresItem: slug || undefined })}
                />
              )}
              {(k === 'minPlayerLevel' || k === 'minBuddyLevel') && (
                <label className="text-xs text-ink-muted">
                  {REQUIREMENT_LABELS[k]}
                  <Input
                    type="number"
                    min="1"
                    value={choice.requirements[k] ?? ''}
                    onChange={(e) =>
                      patchRequirements({
                        [k]: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                    className="w-28"
                  />
                </label>
              )}
              {k === 'affinity' && (
                <label className="text-xs text-ink-muted">
                  Buddy affinity
                  <select
                    value={choice.requirements.affinity ?? ''}
                    onChange={(e) => patchRequirements({ affinity: e.target.value || undefined })}
                    className={selectClass}
                  >
                    <option value="">— pick an affinity —</option>
                    {affinities.map((a) => (
                      <option key={a} value={a}>
                        {titleCase(a)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {k === 'raceAny' && (
                <ChipMultiSelect
                  label="Buddy race (any of)"
                  options={races}
                  value={choice.requirements.raceAny ?? []}
                  onChange={(next) =>
                    patchRequirements({ raceAny: next.length ? next : undefined })
                  }
                />
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove requirement: ${REQUIREMENT_LABELS[k]}`}
              onClick={() => removeRequirement(k)}
            >
              ×
            </Button>
          </div>
        ))}
        {addable.length > 0 && (
          <select
            aria-label="Add requirement"
            value=""
            onChange={(e) => {
              const k = e.target.value as RequirementKey;
              if (!k) return;
              setPending((p) => [...p, k]);
              // Numeric requirements start at a real value; pickers start empty
              // and are only saved once something is picked.
              if (k === 'minPlayerLevel' || k === 'minBuddyLevel') {
                patchRequirements({ [k]: REQUIREMENT_DEFAULTS[k] });
              }
            }}
            className={cn(selectClass, 'w-auto')}
          >
            <option value="">+ Add requirement…</option>
            {addable.map((k) => (
              <option key={k} value={k}>
                {REQUIREMENT_LABELS[k]}
              </option>
            ))}
          </select>
        )}
      </fieldset>

      {/* ── Resolution ── */}
      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-xs uppercase text-ink-muted">Resolution</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-muted">
            Resolution
            <select
              value={choice.check.type}
              onChange={(e) => {
                const type = e.target.value as 'none' | 'sp';
                if (type === 'none') {
                  patch({ check: { type: 'none' } });
                  return;
                }
                // New SP checks start on the new model with sensible defaults.
                // Existing legacy checks (a `difficulty` and no `baseChance`)
                // keep their shape and are never silently converted.
                patch({
                  check: stripUndefined({
                    ...choice.check,
                    type: 'sp',
                    baseChance:
                      choice.check.baseChance ??
                      (choice.check.difficulty === undefined ? 0.4 : undefined),
                    maxSpModifier:
                      choice.check.maxSpModifier ??
                      (choice.check.difficulty === undefined ? 0.15 : undefined),
                  }) as ChoiceDraft['check'],
                });
              }}
              className={selectClass}
            >
              <option value="none">Automatic — always succeeds</option>
              <option value="sp">Skill check — can fail</option>
            </select>
          </label>

          {isNewModelSpCheck && (
            <>
              <label className="text-xs text-ink-muted">
                Base success chance
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round((choice.check.baseChance ?? 0.4) * 100)}
                    onChange={(e) =>
                      patchCheck({ baseChance: clamp01(Number(e.target.value) / 100) })
                    }
                  />
                  <span className="text-ink-muted">%</span>
                </div>
              </label>

              <label className="flex items-center gap-2 self-end text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={(choice.check.maxSpModifier ?? 0.15) > 0}
                  onChange={(e) => patchCheck({ maxSpModifier: e.target.checked ? 0.15 : 0 })}
                />
                Buddy Strength affects this check
              </label>

              {(choice.check.maxSpModifier ?? 0.15) > 0 && (
                <label className="text-xs text-ink-muted">
                  Maximum SP effect
                  <div className="flex items-center gap-1">
                    <span className="text-ink-muted">±</span>
                    <Input
                      type="number"
                      min="0"
                      max="50"
                      step="1"
                      value={Math.round((choice.check.maxSpModifier ?? 0.15) * 100)}
                      onChange={(e) =>
                        patchCheck({ maxSpModifier: clampMaxSp(Number(e.target.value) / 100) })
                      }
                    />
                    <span className="text-ink-muted">%</span>
                  </div>
                </label>
              )}

              <label className="text-xs text-ink-muted">
                Affinity advantage (+15%)
                <select
                  value={choice.check.affinityAdvantage ?? ''}
                  onChange={(e) => patchCheck({ affinityAdvantage: e.target.value || undefined })}
                  className={selectClass}
                >
                  <option value="">— none —</option>
                  {affinities.map((a) => (
                    <option key={a} value={a}>
                      {titleCase(a)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="sm:col-span-2">
                <ChipMultiSelect
                  label="Race advantage (+10% if the buddy is any of these)"
                  options={races}
                  value={choice.check.raceAdvantage ?? []}
                  onChange={(next) => patchCheck({ raceAdvantage: next.length ? next : undefined })}
                />
              </div>

              <p className="text-[11px] text-ink-muted sm:col-span-2">
                Final chance = base {Math.round((choice.check.baseChance ?? 0.4) * 100)}% ± up to{' '}
                {Math.round((choice.check.maxSpModifier ?? 0.15) * 100)}% from buddy SP
                {choice.check.affinityAdvantage ? ' + 15% affinity' : ''}
                {(choice.check.raceAdvantage ?? []).length > 0 ? ' + 10% race' : ''} + any Buddy
                Bonus, clamped to 5–95%. Use Preview for exact numbers.
              </p>
            </>
          )}

          {isLegacyModelSpCheck && (
            <>
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-ink-muted sm:col-span-2">
                <strong>Legacy difficulty model.</strong> This check uses the older
                SP-versus-difficulty formula and is left untouched. To move it to the new
                base-chance model, set Resolution to “Automatic”, then back to “Skill check”, and
                re-author it.
              </div>
              <label className="text-xs text-ink-muted">
                Difficulty
                <Input
                  type="number"
                  min="0"
                  value={choice.check.difficulty ?? 50}
                  onChange={(e) =>
                    patch({ check: { ...choice.check, difficulty: Number(e.target.value) } })
                  }
                />
              </label>
              <label className="text-xs text-ink-muted">
                Base bias (−0.5 to 0.5)
                <Input
                  type="number"
                  step="0.05"
                  value={choice.check.baseBias ?? 0}
                  onChange={(e) =>
                    patch({ check: { ...choice.check, baseBias: Number(e.target.value) } })
                  }
                />
              </label>
              <label className="text-xs text-ink-muted">
                Affinity advantage
                <select
                  value={choice.check.affinityAdvantage ?? ''}
                  onChange={(e) => patchCheck({ affinityAdvantage: e.target.value || undefined })}
                  className={selectClass}
                >
                  <option value="">— none —</option>
                  {affinities.map((a) => (
                    <option key={a} value={a}>
                      {titleCase(a)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="sm:col-span-2">
                <ChipMultiSelect
                  label="Race advantage"
                  options={races}
                  value={choice.check.raceAdvantage ?? []}
                  onChange={(next) => patchCheck({ raceAdvantage: next.length ? next : undefined })}
                />
              </div>
            </>
          )}
        </div>
      </fieldset>

      {/* ── Results ── */}
      <div className="space-y-3" data-testid="flavor-fields">
        <OutcomeEditor
          title={isSpCheck ? 'On success' : 'Outcome'}
          tone={isSpCheck ? 'success' : 'neutral'}
          effects={choice.successEffects}
          onChange={(successEffects) => patch({ successEffects })}
          addLabel={isSpCheck ? '+ Add success effect' : '+ Add effect'}
          newEffectType="waifubux_gain"
          choiceIndex={index}
          branch="success"
          reference={reference}
          encounterContext={encounterContext}
        >
          {/*
            Hidden, not cleared, when there is no check: the draft keeps the
            branch text so re-enabling the check brings it straight back.
          */}
          {isSpCheck && (
            <label className="block text-xs text-ink-muted">
              Success Text
              <textarea
                rows={2}
                maxLength={FLAVOR_MAX_LENGTH}
                className={TEXTAREA_CLASS}
                value={choice.successText ?? ''}
                onChange={(e) => patch({ successText: e.target.value })}
              />
            </label>
          )}
        </OutcomeEditor>

        {(isSpCheck || choice.failureEffects.length > 0) && (
          <OutcomeEditor
            title="On failure"
            tone="failure"
            effects={choice.failureEffects}
            onChange={(failureEffects) => patch({ failureEffects })}
            addLabel="+ Add failure effect"
            newEffectType="waifubux_loss"
            choiceIndex={index}
            branch="failure"
            reference={reference}
            encounterContext={encounterContext}
            runs={isSpCheck}
            {...(isSpCheck
              ? {}
              : {
                  notice:
                    'This choice is automatic, so it always succeeds and these effects never run.',
                })}
          >
            {isSpCheck && (
              <label className="block text-xs text-ink-muted">
                Failure Text
                <textarea
                  rows={2}
                  maxLength={FLAVOR_MAX_LENGTH}
                  className={TEXTAREA_CLASS}
                  value={choice.failureText ?? ''}
                  onChange={(e) => patch({ failureText: e.target.value })}
                />
              </label>
            )}
          </OutcomeEditor>
        )}

        <label className="block text-xs text-ink-muted">
          Outcome Text
          <textarea
            rows={2}
            maxLength={FLAVOR_MAX_LENGTH}
            className={TEXTAREA_CLASS}
            value={choice.outcomeText ?? ''}
            onChange={(e) => patch({ outcomeText: e.target.value })}
            placeholder="What happens after this choice resolves."
          />
        </label>
        <p className="text-[11px] text-ink-muted">
          {isSpCheck
            ? 'Success/Failure Text overrides Outcome Text for that result. Outcome Text is used as the fallback. '
            : ''}
          Optional, up to {FLAVOR_MAX_LENGTH} characters each. Presentation only — never changes the
          check, effects or what follows.
        </p>
      </div>
    </div>
  );
}
