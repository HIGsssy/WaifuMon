/**
 * Choice editor — one row in the encounter's choices list.
 *
 * Move-up / move-down / remove controls in the header, structured fields
 * for the choice's shape below. The effect trees delegate to
 * {@link EffectEditor}.
 */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AdminEncounterReference } from '@/api/adminEncounters';
import { EffectEditor, type EffectShape } from './EffectEditor';

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
}

interface Props {
  index: number;
  choice: ChoiceDraft;
  reference: AdminEncounterReference | undefined;
  onChange: (next: ChoiceDraft) => void;
  onRemove: () => void;
  onMoveUp: (() => void) | undefined;
  onMoveDown: (() => void) | undefined;
}

export function ChoiceEditor({
  index,
  choice,
  reference,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: Props) {
  const patch = (changes: Partial<ChoiceDraft>) => onChange({ ...choice, ...changes });

  // Strip keys whose value is undefined, so exactOptionalPropertyTypes
  // does not reject `{ foo: undefined }` on shapes that declare `foo?: T`.
  function stripUndefined<T extends Record<string, unknown>>(o: T): T {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
    return out as T;
  }
  const patchRequirements = (updates: Record<string, unknown>) =>
    patch({ requirements: stripUndefined({ ...choice.requirements, ...updates }) as ChoiceDraft['requirements'] });
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

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <h4 className="font-medium">Choice #{index + 1}</h4>
        <div className="flex-1" />
        <Button type="button" size="sm" variant="outline" disabled={!onMoveUp} onClick={onMoveUp}>
          ↑
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!onMoveDown} onClick={onMoveDown}>
          ↓
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onRemove}>
          Remove
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-ink-muted">
          Label
          <Input value={choice.label} onChange={(e) => patch({ label: e.target.value })} />
        </label>
        <label className="text-xs text-ink-muted">
          Emoji (optional)
          <Input
            value={choice.emoji ?? ''}
            onChange={(e) => patch({ emoji: e.target.value || null })}
          />
        </label>
      </div>

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-xs uppercase text-ink-muted">Requirements</legend>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-ink-muted">
            Affinity
            <select
              value={choice.requirements.affinity ?? ''}
              onChange={(e) =>
                patchRequirements({ affinity: e.target.value || undefined })
              }
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
            >
              <option value="">— any —</option>
              {(reference?.affinities ?? []).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            Required item slug (optional)
            <Input
              value={choice.requirements.requiresItem ?? ''}
              onChange={(e) =>
                patchRequirements({ requiresItem: e.target.value || undefined })
              }
            />
          </label>
          <label className="text-xs text-ink-muted">
            Min player level
            <Input
              type="number"
              min="1"
              value={choice.requirements.minPlayerLevel ?? ''}
              onChange={(e) =>
                patchRequirements({
                  minPlayerLevel: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          </label>
          <label className="text-xs text-ink-muted">
            Min buddy level
            <Input
              type="number"
              min="1"
              value={choice.requirements.minBuddyLevel ?? ''}
              onChange={(e) =>
                patchRequirements({
                  minBuddyLevel: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          </label>
          <label className="text-xs text-ink-muted col-span-2">
            Race requirement (comma-separated)
            <Input
              value={(choice.requirements.raceAny ?? []).join(',')}
              onChange={(e) => {
                const raw = e.target.value.trim();
                patchRequirements({
                  raceAny:
                    raw === ''
                      ? undefined
                      : raw
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                });
              }}
              placeholder="e.g. valkyrie, demon"
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-xs uppercase text-ink-muted">Check</legend>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-ink-muted">
            Type
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
                    baseChance: choice.check.baseChance ?? (choice.check.difficulty === undefined ? 0.4 : undefined),
                    maxSpModifier:
                      choice.check.maxSpModifier ??
                      (choice.check.difficulty === undefined ? 0.15 : undefined),
                  }) as ChoiceDraft['check'],
                });
              }}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
            >
              <option value="none">Auto (no check)</option>
              <option value="sp">SP-based</option>
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
                      patchCheck({
                        baseChance: clamp01(Number(e.target.value) / 100),
                      })
                    }
                  />
                  <span className="text-ink-muted">%</span>
                </div>
              </label>

              <label className="flex items-center gap-2 self-end text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={(choice.check.maxSpModifier ?? 0.15) > 0}
                  onChange={(e) =>
                    patchCheck({ maxSpModifier: e.target.checked ? 0.15 : 0 })
                  }
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
                        patchCheck({
                          maxSpModifier: clampMaxSp(Number(e.target.value) / 100),
                        })
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
                  onChange={(e) =>
                    patchCheck({ affinityAdvantage: e.target.value || undefined })
                  }
                  className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
                >
                  <option value="">— none —</option>
                  {(reference?.affinities ?? []).map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-ink-muted col-span-2">
                Race advantage (+10%, any matching race)
                <Input
                  value={(choice.check.raceAdvantage ?? []).join(',')}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    patchCheck({
                      raceAdvantage:
                        raw === ''
                          ? undefined
                          : raw
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                    });
                  }}
                />
                <span className="mt-1 block text-[11px] text-ink-muted">
                  Listing several races means “any of these matches” — the +10% is
                  granted once, it does not stack per race.
                </span>
              </label>

              <p className="col-span-2 text-[11px] text-ink-muted">
                Final chance = base {Math.round((choice.check.baseChance ?? 0.4) * 100)}% ± up to{' '}
                {Math.round((choice.check.maxSpModifier ?? 0.15) * 100)}% from buddy SP
                {choice.check.affinityAdvantage ? ' + 15% affinity' : ''}
                {(choice.check.raceAdvantage ?? []).length > 0 ? ' + 10% race' : ''}
                {' '}
                + any Buddy Bonus, clamped to 5–95%. Use the Preview panel for exact numbers.
              </p>
            </>
          )}

          {isLegacyModelSpCheck && (
            <>
              <div className="col-span-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-ink-muted">
                <strong>Legacy difficulty model.</strong> This check uses the older
                SP-versus-difficulty formula and is left untouched. To move it to the
                new base-chance model, change the Type to “Auto”, then back to
                “SP-based”, and re-author it.
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
                  onChange={(e) =>
                    patchCheck({ affinityAdvantage: e.target.value || undefined })
                  }
                  className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
                >
                  <option value="">— none —</option>
                  {(reference?.affinities ?? []).map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-muted col-span-2">
                Race advantage (comma-separated)
                <Input
                  value={(choice.check.raceAdvantage ?? []).join(',')}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    patchCheck({
                      raceAdvantage:
                        raw === ''
                          ? undefined
                          : raw
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                    });
                  }}
                />
              </label>
            </>
          )}
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-xs uppercase text-ink-muted">Success effects</legend>
        <div className="space-y-2">
          {choice.successEffects.map((eff, i) => (
            <EffectEditor
              key={i}
              effect={eff}
              reference={reference}
              onChange={(next) => {
                const list = [...choice.successEffects];
                list[i] = next;
                patch({ successEffects: list });
              }}
              onRemove={() => {
                const list = choice.successEffects.filter((_, k) => k !== i);
                patch({ successEffects: list });
              }}
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              patch({
                successEffects: [...choice.successEffects, { type: 'waifubux_gain', amount: 100 }],
              })
            }
          >
            + Add success effect
          </Button>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-xs uppercase text-ink-muted">Failure effects</legend>
        <div className="space-y-2">
          {choice.failureEffects.map((eff, i) => (
            <EffectEditor
              key={i}
              effect={eff}
              reference={reference}
              onChange={(next) => {
                const list = [...choice.failureEffects];
                list[i] = next;
                patch({ failureEffects: list });
              }}
              onRemove={() => {
                const list = choice.failureEffects.filter((_, k) => k !== i);
                patch({ failureEffects: list });
              }}
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              patch({
                failureEffects: [...choice.failureEffects, { type: 'waifubux_loss', amount: 50 }],
              })
            }
          >
            + Add failure effect
          </Button>
        </div>
      </fieldset>
    </div>
  );
}
