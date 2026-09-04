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
