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
    difficulty?: number;
    affinityAdvantage?: string;
    raceAdvantage?: string[];
    baseBias?: number;
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
}: Props): JSX.Element {
  const patch = (changes: Partial<ChoiceDraft>) => onChange({ ...choice, ...changes });

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
                patch({
                  requirements: {
                    ...choice.requirements,
                    affinity: e.target.value || undefined,
                  },
                })
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
                patch({
                  requirements: {
                    ...choice.requirements,
                    requiresItem: e.target.value || undefined,
                  },
                })
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
                patch({
                  requirements: {
                    ...choice.requirements,
                    minPlayerLevel: e.target.value === '' ? undefined : Number(e.target.value),
                  },
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
                patch({
                  requirements: {
                    ...choice.requirements,
                    minBuddyLevel: e.target.value === '' ? undefined : Number(e.target.value),
                  },
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
                patch({
                  requirements: {
                    ...choice.requirements,
                    raceAny:
                      raw === ''
                        ? undefined
                        : raw
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                  },
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
              onChange={(e) =>
                patch({
                  check: { ...choice.check, type: e.target.value as 'none' | 'sp' },
                })
              }
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
            >
              <option value="none">Auto (no check)</option>
              <option value="sp">SP-based</option>
            </select>
          </label>
          {choice.check.type === 'sp' && (
            <>
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
                    patch({
                      check: {
                        ...choice.check,
                        affinityAdvantage: e.target.value || undefined,
                      },
                    })
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
                    patch({
                      check: {
                        ...choice.check,
                        raceAdvantage:
                          raw === ''
                            ? undefined
                            : raw
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean),
                      },
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
