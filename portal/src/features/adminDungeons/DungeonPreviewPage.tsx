/**
 * Admin — Dungeon generation preview: generate one run of a saved zone and
 * look at it, or generate hundreds and look at the distribution.
 *
 * A dry run. It calls the same generator a real run will and persists
 * nothing — no player run is created. The same seed always produces the same
 * graph, so a seed worth discussing can be pasted to someone else.
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';

import {
  DUNGEONS_QUERY_KEY,
  DUNGEON_NODE_TYPES,
  MAX_DUNGEON_SEED,
  listDungeonZones,
  previewDungeon,
  simulateDungeon,
  type DungeonSimulationReport,
} from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { DungeonGraphView } from './DungeonGraphView';
import { NODE_TYPE_LABELS, formatPercent } from './dungeonModel';

const SIMULATION_RUNS = 1000;

/** The seed field: empty means "pick one for me"; anything else must be a valid seed. */
function parseSeed(text: string): { seed: number | undefined; error: string | null } {
  if (text.trim() === '') return { seed: undefined, error: null };
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DUNGEON_SEED) {
    return { seed: undefined, error: `A seed is a whole number from 0 to ${MAX_DUNGEON_SEED}.` };
  }
  return { seed: n, error: null };
}

/** Why the generator gave up, when the server sent its diagnostics. */
function GenerationFailure({ error }: { error: unknown }) {
  if (!isPortalApiError(error) || error.code !== 'DUNGEON_GENERATION_FAILED') {
    return <ErrorState variant="inline" title="Could not generate a preview" error={error} />;
  }
  const details = (error.details ?? {}) as {
    seed?: number;
    attempts?: number;
    failures?: Record<string, number>;
  };
  return (
    <Card
      className="space-y-2 border-danger/40 p-4 text-sm"
      role="alert"
      data-testid="generation-failure"
    >
      <p className="font-medium text-danger">
        This zone could not generate a run for seed {details.seed ?? '?'}.
      </p>
      <p className="text-ink-muted">
        The generator tried {details.attempts ?? '?'} times. Its rules cannot all be met — fix the
        zone, then preview again.
      </p>
      <ul className="text-xs text-ink-muted">
        {Object.entries(details.failures ?? {}).map(([reason, count]) => (
          <li key={reason}>
            ×{count} — {reason}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function DungeonPreviewPage() {
  const [params, setParams] = useSearchParams();
  const zonesQuery = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'zones'],
    queryFn: ({ signal }) => listDungeonZones(signal),
  });
  const zones = zonesQuery.data?.zones ?? [];
  const zoneKey = params.get('zone') ?? zones[0]?.key ?? '';
  const [seedText, setSeedText] = useState(params.get('seed') ?? '');
  const { seed, error: seedError } = parseSeed(seedText);

  const preview = useMutation({
    mutationFn: (explicit: number | undefined) => previewDungeon({ key: zoneKey }, explicit),
  });
  const simulation = useMutation({
    mutationFn: () => simulateDungeon({ key: zoneKey }, SIMULATION_RUNS),
  });
  // A result belongs to the zone it was generated for.
  useEffect(() => {
    preview.reset();
    simulation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneKey]);

  const generate = (explicit: number | undefined) =>
    preview.mutate(explicit, {
      // Show the seed that was used, so the same run can be generated again.
      onSuccess: (result) => setSeedText(String(result.seed)),
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dungeon generation preview"
        description="A dry run of the generator. Nothing is saved and no player run is created."
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/dungeons">Back to dungeons</Link>
          </Button>
        }
      />

      {zonesQuery.isPending && <Skeleton className="h-24 w-full" />}
      {zonesQuery.isError && (
        <ErrorState
          title="Could not load dungeon zones"
          error={zonesQuery.error}
          onRetry={() => void zonesQuery.refetch()}
        />
      )}
      {zonesQuery.data && zones.length === 0 && (
        <Card className="p-6 text-center text-sm text-ink-muted">No dungeon zones to preview.</Card>
      )}

      {zones.length > 0 && (
        <Card className="space-y-3 p-4" data-testid="preview-controls">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-ink-muted">
              Zone
              <select
                aria-label="Zone"
                className={selectClass}
                value={zoneKey}
                onChange={(e) => setParams({ zone: e.target.value })}
              >
                {zones.map((z) => (
                  <option key={z.key} value={z.key}>
                    {z.name}
                    {z.enabled ? '' : ' (disabled)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              Seed
              <Input
                aria-label="Seed"
                className="w-44 font-mono"
                inputMode="numeric"
                placeholder="random"
                value={seedText}
                onChange={(e) => setSeedText(e.target.value)}
              />
            </label>
            <Button
              type="button"
              variant="accent"
              disabled={preview.isPending || seedError !== null}
              onClick={() => generate(seed)}
            >
              {seedText.trim() === '' ? 'Generate with a random seed' : 'Generate this seed'}
            </Button>
            {seed !== undefined && (
              <Button
                type="button"
                variant="outline"
                disabled={preview.isPending}
                onClick={() => generate(undefined)}
              >
                New random seed
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={simulation.isPending}
              onClick={() => simulation.mutate()}
            >
              {simulation.isPending
                ? 'Simulating…'
                : `Simulate ${SIMULATION_RUNS.toLocaleString()} runs`}
            </Button>
          </div>
          {seedError && <p className="text-xs text-danger">{seedError}</p>}
        </Card>
      )}

      {preview.isPending && <Skeleton className="h-48 w-full" />}
      {preview.isError && <GenerationFailure error={preview.error} />}
      {preview.data && (
        <Card className="p-4">
          <DungeonGraphView preview={preview.data} />
        </Card>
      )}

      {simulation.isError && (
        <ErrorState
          variant="inline"
          title="Could not run the simulation"
          error={simulation.error}
        />
      )}
      {simulation.data && <SimulationReport report={simulation.data} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}

function SimulationReport({ report }: { report: DungeonSimulationReport }) {
  const failures = Object.entries(report.failures);
  return (
    <Card className="space-y-4 p-4" data-testid="simulation-report">
      <h2 className="text-sm font-semibold uppercase text-ink-muted">
        {report.runs.toLocaleString()} runs, seeds {report.firstSeed}–
        {report.firstSeed + report.runs - 1}
      </h2>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Could not be generated"
          value={`${report.invalid} (${formatPercent(report.invalidRate)})`}
        />
        <Stat
          label="Nodes per run"
          value={`${report.averageNodeCount.toFixed(2)} (${report.minNodeCount}–${report.maxNodeCount})`}
        />
        <Stat label="Average depth" value={report.averageDepth.toFixed(2)} />
        <Stat label="Runs with a branch" value={formatPercent(report.branchRate)} />
        <Stat label="Runs with a boss" value={formatPercent(report.bossRate)} />
        <Stat label="Runs with a rest" value={formatPercent(report.restRate)} />
        <Stat label="Runs with an extraction point" value={formatPercent(report.extractionRate)} />
        <Stat label="Extraction points per run" value={report.averageExtractionPoints.toFixed(2)} />
      </dl>
      {failures.length > 0 && (
        <ul className="text-xs text-danger" data-testid="simulation-failures">
          {failures.map(([reason, count]) => (
            <li key={reason}>
              ×{count} — {reason}
            </li>
          ))}
        </ul>
      )}
      <table className="w-full text-left text-xs" data-testid="simulation-node-types">
        <thead className="text-ink-muted">
          <tr>
            <th className="py-1 font-medium">Node type</th>
            <th className="py-1 font-medium">Share of nodes</th>
            <th className="py-1 font-medium">Runs with at least one</th>
          </tr>
        </thead>
        <tbody>
          {DUNGEON_NODE_TYPES.map((type) => (
            <tr key={type} className="border-t border-border">
              <td className="py-1 text-ink">{NODE_TYPE_LABELS[type]}</td>
              <td className="py-1">{formatPercent(report.nodeTypeShare[type] ?? 0)}</td>
              <td className="py-1">{formatPercent(report.nodeTypeRunRate[type] ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {[
        { title: 'Enemies', rows: report.enemies },
        { title: 'Events', rows: report.events },
      ].map(({ title, rows }) =>
        rows.length === 0 ? null : (
          <table key={title} className="w-full text-left text-xs">
            <thead className="text-ink-muted">
              <tr>
                <th className="py-1 font-medium">{title}</th>
                <th className="py-1 font-medium">Nodes</th>
                <th className="py-1 font-medium">Runs it appears in</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <td className="py-1 font-mono text-ink">{row.key}</td>
                  <td className="py-1">{row.nodes.toLocaleString()}</td>
                  <td className="py-1">{formatPercent(row.runRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ),
      )}
    </Card>
  );
}
