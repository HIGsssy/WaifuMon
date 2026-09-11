/**
 * Portal Admin — Preview & simulator.
 *
 * Side-by-side layout: the {@link AdminEncounterPreviewPanel} for the
 * discrete per-choice math, and a full simulator that runs N rolls of a
 * chosen choice and reports aggregate outcomes.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';

import {
  getAdminEncounter,
  getAdminEncounterReference,
  simulateAdminEncounter,
  type PreviewBody,
  type SimulateResponse,
} from '@/api/adminEncounters';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';

import { EncounterArtwork } from '@/components/media/EncounterArtwork';
import { AdminEncounterPreviewPanel } from './AdminEncounterPreviewPanel';
import { regionLabel, summarizeEffect } from './waifumonSelection';
import type { SimulatedSighting } from '@/api/adminEncounters';

const SIGHTING_RESULT_TEXT: Record<SimulatedSighting['result'], string> = {
  selected: 'Selected',
  no_matching_species: 'No matching species — no sighting would happen',
  unknown_species: 'Species not found or disabled — no sighting would happen',
  hunt_draw: 'Hunt draw — the species is decided by the region/rarity roll at runtime',
};

const DEFAULT_CTX: PreviewBody = {
  playerLevel: 20,
  buddy: { level: 10, currentSp: 60, affinity: 'switch', race: 'human' },
  buddyBonusPercent: 0,
};

const ROLL_PRESETS = [100, 1000, 5000] as const;

export function AdminEncounterPreviewPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const encounterId = idParam ? Number(idParam) : null;

  const encounterQuery = useQuery({
    queryKey: ['admin', 'encounters', encounterId],
    queryFn: ({ signal }) => (encounterId ? getAdminEncounter(encounterId, signal) : null),
    enabled: encounterId != null,
  });
  const referenceQuery = useQuery({
    queryKey: ['admin', 'encounters', 'reference'],
    queryFn: ({ signal }) => getAdminEncounterReference(signal),
  });

  const [ctx, setCtx] = useState<PreviewBody>(DEFAULT_CTX);
  const [choiceId, setChoiceId] = useState<number | null>(null);
  const [rolls, setRolls] = useState<number>(1000);
  const [simResult, setSimResult] = useState<SimulateResponse | null>(null);
  /** Region Waifumon sightings are sampled in; '' lets the server choose. */
  const [simRegion, setSimRegion] = useState<string>('');

  const simMutation = useMutation({
    mutationFn: () =>
      simulateAdminEncounter(encounterId!, {
        ...ctx,
        choiceId: choiceId!,
        rolls,
        ...(simRegion ? { regionId: simRegion } : {}),
      }),
    onSuccess: (r) => setSimResult(r),
  });

  const speciesName = (slug: string) =>
    referenceQuery.data?.species.find((s) => s.slug === slug)?.name;

  if (encounterQuery.isPending) {
    return (
      <Card className="p-4">
        <Skeleton className="h-64 w-full" />
      </Card>
    );
  }
  if (encounterQuery.isError) {
    return (
      <ErrorState
        title="Could not load encounter"
        error={encounterQuery.error}
        onRetry={() => void encounterQuery.refetch()}
      />
    );
  }
  const encounter = encounterQuery.data;
  if (!encounter) return null;

  const currentChoice = choiceId != null ? encounter.choices.find((c) => c.id === choiceId) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Preview — ${encounter.name}`}
        description={encounter.slug}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to={`/admin/encounters/${encounterId}`}>Edit</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/admin/encounters">Back to list</Link>
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Player-facing approximation. */}
        <Card className="space-y-3 p-4">
          <h3 className="text-sm font-semibold uppercase text-ink-muted">Player-facing preview</h3>
          <p className="text-sm">
            <Badge variant="outline">{encounter.type}</Badge>{' '}
            <Badge variant="outline">{encounter.rarity}</Badge>
          </p>
          {/*
            The artwork Discord will attach to the encounter embed. Shown here
            so the player-facing preview matches what actually ships; an
            encounter without artwork is normal and says so.
          */}
          <EncounterArtwork path={encounter.artworkPath} />
          <p className="whitespace-pre-line text-sm">{encounter.description || '—'}</p>
          <div className="space-y-2 pt-2">
            {encounter.choices.length === 0 && (
              <p className="text-xs text-ink-muted">No choices.</p>
            )}
            {encounter.choices.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                  choiceId === c.id ? 'border-primary bg-surface-sunken' : 'border-border'
                }`}
                onClick={() => setChoiceId(c.id)}
              >
                {c.emoji ? `${c.emoji} ` : ''}
                {c.label}
              </button>
            ))}
          </div>
        </Card>

        {/* Discrete math + admin details. */}
        <AdminEncounterPreviewPanel
          encounterId={encounterId!}
          reference={referenceQuery.data}
        />
      </div>

      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-semibold uppercase text-ink-muted">N-roll simulation</h3>
        <p className="text-xs text-ink-muted">
          Runs the same math the runtime uses without touching player state.
        </p>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-xs text-ink-muted">
            Choice
            <select
              value={choiceId ?? ''}
              onChange={(e) => setChoiceId(e.target.value === '' ? null : Number(e.target.value))}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
            >
              <option value="">— pick a choice —</option>
              {encounter.choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            Player level
            <Input
              type="number"
              min="1"
              value={ctx.playerLevel}
              onChange={(e) => setCtx({ ...ctx, playerLevel: Number(e.target.value) })}
            />
          </label>
          <label className="text-xs text-ink-muted">
            Rolls
            <Input
              type="number"
              min="1"
              max="10000"
              value={rolls}
              onChange={(e) => setRolls(Number(e.target.value))}
            />
          </label>
          <label className="text-xs text-ink-muted">
            Sighting region
            <select
              value={simRegion}
              onChange={(e) => setSimRegion(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
            >
              <option value="">Auto (encounter&rsquo;s first region)</option>
              {(referenceQuery.data?.regions ?? []).map((r) => (
                <option key={r} value={r}>
                  {regionLabel(r, referenceQuery.data?.regionNames)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            {ROLL_PRESETS.map((n) => (
              <Button
                key={n}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRolls(n)}
              >
                {n}
              </Button>
            ))}
          </div>
        </div>

        {ctx.buddy && (
          <div className="grid gap-2 md:grid-cols-4">
            <label className="text-xs text-ink-muted">
              Buddy level
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
                {(referenceQuery.data?.affinities ?? []).map((a) => (
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
                {(referenceQuery.data?.races ?? []).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <Button
          type="button"
          onClick={() => simMutation.mutate()}
          disabled={choiceId == null || simMutation.isPending}
        >
          {simMutation.isPending ? 'Simulating…' : `Run ${rolls.toLocaleString()} rolls`}
        </Button>

        {simMutation.isError && (
          <ErrorState title="Simulation failed" error={simMutation.error} />
        )}

        {simResult && currentChoice && (
          <div className="grid gap-3 md:grid-cols-2">
            <Card className="p-3">
              <h4 className="text-sm font-medium">Outcome distribution</h4>
              <dl className="mt-2 grid grid-cols-2 gap-1 text-sm tabular">
                <dt className="text-ink-muted">Rolls</dt>
                <dd className="text-right">{simResult.aggregate.rolls}</dd>
                <dt className="text-ink-muted">Successes</dt>
                <dd className="text-right">{simResult.aggregate.successes}</dd>
                <dt className="text-ink-muted">Failures</dt>
                <dd className="text-right">{simResult.aggregate.failures}</dd>
                <dt className="text-ink-muted">Observed rate</dt>
                <dd className="text-right">
                  {(simResult.aggregate.successRate * 100).toFixed(1)}%
                </dd>
                <dt className="text-ink-muted">Expected rate</dt>
                <dd className="text-right">
                  {(simResult.aggregate.expectedSuccessRate * 100).toFixed(1)}%
                </dd>
                <dt className="text-ink-muted">Deviation</dt>
                <dd className="text-right">
                  {(simResult.aggregate.successRateDeviation * 100).toFixed(2)} pp
                </dd>
                <dt className="text-ink-muted">Std. error</dt>
                <dd className="text-right">
                  ±{(simResult.aggregate.successRateStdError * 100).toFixed(2)} pp
                </dd>
              </dl>
              {/*
                The reading an author actually needs: is this run's gap from
                the formula ordinary luck, or a number worth changing? Two
                standard errors is the usual line.
              */}
              <p className="mt-2 text-xs text-ink-muted">
                {Math.abs(simResult.aggregate.successRateDeviation) <=
                2 * simResult.aggregate.successRateStdError
                  ? 'Within normal sampling noise for this roll count.'
                  : 'Outside two standard errors — worth re-running with more rolls.'}{' '}
                Seed {simResult.aggregate.seed}.
              </p>
            </Card>
            <Card className="p-3">
              <h4 className="text-sm font-medium">Currency</h4>
              <dl className="mt-2 grid grid-cols-2 gap-1 text-sm tabular">
                <dt className="text-ink-muted">Waifubux gained</dt>
                <dd className="text-right">{simResult.aggregate.waifubuxGained}</dd>
                <dt className="text-ink-muted">Waifubux lost</dt>
                <dd className="text-right">{simResult.aggregate.waifubuxLost}</dd>
                <dt className="text-ink-muted">Net (observed)</dt>
                <dd className="text-right">{simResult.aggregate.netWaifubux}</dd>
                <dt className="text-ink-muted">Net per roll</dt>
                <dd className="text-right">
                  {simResult.aggregate.netWaifubuxPerRoll.toFixed(2)}
                </dd>
                <dt className="text-ink-muted">Expected per roll</dt>
                <dd className="text-right">
                  {simResult.aggregate.expectedNetWaifubuxPerRoll.toFixed(2)}
                </dd>
                <dt className="text-ink-muted">Essence gained</dt>
                <dd className="text-right">{simResult.aggregate.essenceGained}</dd>
                <dt className="text-ink-muted">Essence lost</dt>
                <dd className="text-right">{simResult.aggregate.essenceLost}</dd>
                <dt className="text-ink-muted">Essence net</dt>
                <dd className="text-right">{simResult.aggregate.netEssence}</dd>
                {/*
                  Base, because a simulation has no equipped Buddy to read an
                  `affection_gain` bonus from. Labelled so an author is not
                  left guessing which of the two numbers this is.
                */}
                <dt className="text-ink-muted">Affection (base)</dt>
                <dd className="text-right">{simResult.aggregate.affectionGranted}</dd>
              </dl>
            </Card>
            <Card className="p-3 md:col-span-2">
              <h4 className="text-sm font-medium">Items and follow-ups (frequency)</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <h5 className="text-xs uppercase text-ink-muted">Items granted / consumed</h5>
                  {Object.keys(simResult.aggregate.itemFrequency).length === 0 && (
                    <p className="text-xs text-ink-muted">—</p>
                  )}
                  <ul className="tabular">
                    {Object.entries(simResult.aggregate.itemFrequency).map(([slug, n]) => (
                      <li key={slug} className="flex justify-between">
                        <span>{slug}</span>
                        <span>{n}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h5 className="text-xs uppercase text-ink-muted">Follow-ups fired</h5>
                  {Object.keys(simResult.aggregate.followUpFrequency).length === 0 && (
                    <p className="text-xs text-ink-muted">—</p>
                  )}
                  <ul className="tabular">
                    {Object.entries(simResult.aggregate.followUpFrequency).map(([k, n]) => (
                      <li key={k} className="flex justify-between">
                        <span>{k}</span>
                        <span>{n}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
            {(simResult.aggregate.outcomeTexts ?? []).some(
              (o) => o.resolvedOutcomeText != null,
            ) && (
              <Card className="p-3 md:col-span-2" data-testid="sim-outcome-flavor">
                <h4 className="text-sm font-medium">Outcome flavor</h4>
                <p className="text-xs text-ink-muted">
                  The text a player would read for each outcome this run actually produced.
                </p>
                {simResult.aggregate.outcomeTexts!.map((o) => (
                  <dl
                    key={o.outcome}
                    className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border p-2 text-sm"
                  >
                    <dt className="text-ink-muted">Outcome</dt>
                    <dd>
                      {o.outcome === 'auto'
                        ? 'Auto-resolved'
                        : o.outcome === 'success'
                          ? 'Success'
                          : 'Failure'}{' '}
                      <span className="text-ink-muted tabular">× {o.count}</span>
                    </dd>
                    <dt className="text-ink-muted">Flavor</dt>
                    <dd className="whitespace-pre-line">
                      {o.resolvedOutcomeText ?? (
                        <span className="text-ink-muted">— none —</span>
                      )}
                    </dd>
                  </dl>
                ))}
              </Card>
            )}
            {(simResult.sightings ?? []).length > 0 && (
              <Card className="p-3 md:col-span-2" data-testid="sim-sightings">
                <h4 className="text-sm font-medium">Wild Waifumon sightings</h4>
                <p className="text-xs text-ink-muted">
                  One sample draw per sighting effect, made by the live species selector — the
                  same code a real resolution runs. Nothing is spawned.
                </p>
                {simResult.sightings!.map((s, i) => (
                  <dl
                    key={i}
                    className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border p-2 text-sm"
                  >
                    <dt className="text-ink-muted">On</dt>
                    <dd>{s.outcome === 'success' ? 'Success' : 'Failure'}</dd>
                    <dt className="text-ink-muted">Selection</dt>
                    <dd>{summarizeEffect(s.effect, speciesName)}</dd>
                    <dt className="text-ink-muted">Region</dt>
                    <dd>
                      {s.regionId
                        ? regionLabel(s.regionId, referenceQuery.data?.regionNames)
                        : 'Any (a specific species ignores region pools)'}
                    </dd>
                    <dt className="text-ink-muted">Eligible species</dt>
                    <dd>{s.candidateCount ?? '—'}</dd>
                    {s.result === 'selected' && s.selectedSpecies ? (
                      <>
                        <dt className="text-ink-muted">Selected species</dt>
                        <dd>
                          {s.selectedSpecies.name} ({s.selectedSpecies.rarity})
                        </dd>
                      </>
                    ) : (
                      <>
                        <dt className="text-ink-muted">Result</dt>
                        <dd className={s.result === 'hunt_draw' ? '' : 'text-destructive'}>
                          {SIGHTING_RESULT_TEXT[s.result]}
                        </dd>
                      </>
                    )}
                  </dl>
                ))}
              </Card>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
