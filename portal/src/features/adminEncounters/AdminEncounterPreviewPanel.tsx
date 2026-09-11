/**
 * Preview panel — invokes `POST /admin/encounters/:id/preview` for a
 * configurable buddy context and renders the computed choice chances plus
 * the discrete breakdown terms. Reuses the exact same math the Discord
 * runtime uses.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import {
  previewAdminEncounter,
  type AdminEncounterReference,
  type OutcomeFlavor,
  type PreviewBody,
  type PreviewResponse,
} from '@/api/adminEncounters';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface Props {
  encounterId: number;
  reference: AdminEncounterReference | undefined;
}

const DEFAULT_CTX: PreviewBody = {
  playerLevel: 20,
  buddy: { level: 10, currentSp: 60, affinity: 'switch', race: 'human' },
  buddyBonusPercent: 0,
};

/**
 * SP values that map to the new model's reference band (neutral 200, full
 * ±cap at 50/350). "Weak" is a fresh low-rarity buddy, "Average" the neutral
 * point, "Strong" a high-rarity end-game buddy that reaches the positive cap.
 */
const SP_PRESETS: ReadonlyArray<{ label: string; sp: number }> = [
  { label: 'Weak', sp: 90 },
  { label: 'Average', sp: 200 },
  { label: 'Strong', sp: 350 },
];

const OUTCOME_LABEL: Record<OutcomeFlavor['outcome'], string> = {
  auto: 'Auto-resolved',
  success: '✅ Success',
  failure: '❌ Failure',
};

/**
 * The Discord Result field for one choice, with its flavor line in the same
 * place Discord puts it: under the outcome, above the 🎲 Check block.
 *
 * The text is the server's resolved value for each outcome — this component
 * only chooses *which outcome to look at*, never which authored field wins.
 * Renders nothing when no outcome has flavor, so an unauthored encounter's
 * preview is unchanged.
 */
export function OutcomeFlavorPreview({
  label,
  chance,
  flavors,
}: {
  label: string;
  chance: number;
  flavors: OutcomeFlavor[];
}) {
  const [selected, setSelected] = useState<OutcomeFlavor['outcome'] | null>(null);
  if (flavors.every((f) => f.resolvedOutcomeText == null)) return null;
  const current = flavors.find((f) => f.outcome === selected) ?? flavors[0]!;
  const checked = current.outcome !== 'auto';

  return (
    <div className="mt-2 space-y-2" data-testid="flavor-preview">
      {flavors.length > 1 && (
        <div className="flex gap-2" role="group" aria-label="Preview outcome">
          {flavors.map((f) => (
            <Button
              key={f.outcome}
              type="button"
              size="sm"
              variant={f.outcome === current.outcome ? 'default' : 'outline'}
              aria-pressed={f.outcome === current.outcome}
              onClick={() => setSelected(f.outcome)}
            >
              {f.outcome === 'success' ? 'Success' : 'Failure'}
            </Button>
          ))}
        </div>
      )}
      <div className="rounded-md border border-border bg-surface p-2 text-xs">
        <p>
          <strong>Chose:</strong> {label}
        </p>
        <p>
          <strong>Outcome:</strong> {OUTCOME_LABEL[current.outcome]}
        </p>
        {current.resolvedOutcomeText != null && (
          <p className="mt-2 whitespace-pre-line" data-testid="flavor-text">
            {current.resolvedOutcomeText}
          </p>
        )}
        {checked && (
          <p className="mt-2 text-ink-muted">🎲 Check · Success Chance {Math.round(chance * 100)}%</p>
        )}
      </div>
    </div>
  );
}

export function AdminEncounterPreviewPanel({ encounterId, reference }: Props) {
  const [ctx, setCtx] = useState<PreviewBody>(DEFAULT_CTX);
  const [result, setResult] = useState<PreviewResponse | null>(null);

  const previewMutation = useMutation({
    mutationFn: (body: PreviewBody) => previewAdminEncounter(encounterId, body),
    onSuccess: (r) => setResult(r),
  });

  const buddyOn = ctx.buddy != null;

  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold uppercase text-ink-muted">Preview</h3>
      <div className="space-y-2 rounded-md border border-border p-2">
        <label className="block text-xs text-ink-muted">
          Player level
          <Input
            type="number"
            min="1"
            value={ctx.playerLevel}
            onChange={(e) => setCtx({ ...ctx, playerLevel: Number(e.target.value) })}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={buddyOn}
            onChange={(e) =>
              setCtx({
                ...ctx,
                buddy: e.target.checked
                  ? { level: 10, currentSp: 60, affinity: 'switch', race: 'human' }
                  : null,
              })
            }
          />
          With buddy
        </label>
        {buddyOn && ctx.buddy && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-ink-muted">
              Level
              <Input
                type="number"
                min="1"
                value={ctx.buddy.level}
                onChange={(e) =>
                  setCtx({ ...ctx, buddy: { ...ctx.buddy!, level: Number(e.target.value) } })
                }
              />
            </label>
            <label className="text-xs text-ink-muted">
              Current SP
              <Input
                type="number"
                min="0"
                value={ctx.buddy.currentSp}
                onChange={(e) =>
                  setCtx({
                    ...ctx,
                    buddy: { ...ctx.buddy!, currentSp: Number(e.target.value) },
                  })
                }
              />
            </label>
            <label className="text-xs text-ink-muted">
              Affinity
              <select
                value={ctx.buddy.affinity}
                onChange={(e) =>
                  setCtx({ ...ctx, buddy: { ...ctx.buddy!, affinity: e.target.value } })
                }
                className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
              >
                {(reference?.affinities ?? []).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              Race
              <select
                value={ctx.buddy.race}
                onChange={(e) =>
                  setCtx({ ...ctx, buddy: { ...ctx.buddy!, race: e.target.value } })
                }
                className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
              >
                {(reference?.races ?? []).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <label className="text-xs text-ink-muted">
          Encounter Buddy Bonus %
          <Input
            type="number"
            step="0.5"
            value={ctx.buddyBonusPercent}
            onChange={(e) => setCtx({ ...ctx, buddyBonusPercent: Number(e.target.value) })}
          />
        </label>
        {buddyOn && ctx.buddy && (
          <div className="space-y-1">
            <span className="block text-[11px] uppercase text-ink-muted">
              Buddy SP presets
            </span>
            <div className="flex flex-wrap gap-2">
              {SP_PRESETS.map((p) => (
                <Button
                  key={p.label}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const next = {
                      ...ctx,
                      buddy: { ...ctx.buddy!, currentSp: p.sp },
                    };
                    setCtx(next);
                    previewMutation.mutate(next);
                  }}
                >
                  {p.label} ({p.sp} SP)
                </Button>
              ))}
            </div>
            <span className="block text-[11px] text-ink-muted">
              Presets run the real resolver. Combine with matching affinity/race
              above to see an ideal-match chance. New-model checks read SP against
              a 200-neutral / 350-strong band.
            </span>
          </div>
        )}
        <Button
          type="button"
          size="sm"
          onClick={() => previewMutation.mutate(ctx)}
          disabled={previewMutation.isPending}
        >
          {previewMutation.isPending ? 'Computing…' : 'Compute preview'}
        </Button>
      </div>

      {result && (
        <div className="space-y-2">
          {result.choices.map((c) => (
            <div key={c.choiceId} className="rounded-md border border-border p-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">
                  {c.emoji ? `${c.emoji} ` : ''}
                  {c.label}
                </span>
                {c.available ? (
                  <Badge variant="outline">{Math.round(c.chance * 100)}%</Badge>
                ) : (
                  <Badge variant="outline">Unavailable</Badge>
                )}
              </div>
              {!c.available && c.unavailableReason && (
                <p className="text-xs text-ink-muted">{c.unavailableReason}</p>
              )}
              <OutcomeFlavorPreview
                label={c.label}
                chance={c.chance}
                flavors={c.outcomeFlavor ?? []}
              />
              <p className="text-xs text-ink-muted tabular">
                base {c.breakdown.base.toFixed(2)} · sp {c.breakdown.spTerm.toFixed(3)} · lvl{' '}
                {c.breakdown.levelTerm.toFixed(3)} · aff {c.breakdown.affinityMod.toFixed(2)} · race{' '}
                {c.breakdown.raceMod.toFixed(2)} · buddy {c.breakdown.buddyBonusMod.toFixed(3)} ·
                bias {c.breakdown.baseBias.toFixed(2)}
              </p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
