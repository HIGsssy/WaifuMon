/**
 * Admin — Reward Tables: every live boss and expedition reward table, where it
 * stands relative to Git, what pays from it, and export/import.
 *
 * The live tables are database rows seeded from `content/bossRewards.json` and
 * `content/expeditionRewards.json`. A table edited here is never overwritten
 * by a deploy; **Export** writes the file format back so the edit can be
 * committed to Git (or imported on another server).
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  REWARD_TABLES_QUERY_KEY,
  REWARD_TABLE_KINDS,
  applyRewardTableImport,
  exportRewardTables,
  listRewardTables,
  planRewardTableImport,
  type RewardTableImportPlan,
  type RewardTableKind,
  type RewardTableSummary,
} from '@/api/adminRewardTables';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';
import { cn } from '@/lib/cn';
import { KIND_LABELS } from './rewardTableModel';

/** Where a table stands relative to Git, in one badge. */
export function OriginBadge({ summary }: { summary: Pick<RewardTableSummary, 'origin' | 'matchesShipped'> }) {
  if (summary.origin === 'custom') return <Badge variant="outline">Portal only</Badge>;
  if (summary.origin === 'shipped') return <Badge variant="default">Shipped</Badge>;
  return (
    <Badge variant="solid" title="Edited here; deploys will not overwrite it. Export to commit it to Git.">
      Edited — differs from Git
    </Badge>
  );
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function RewardTablesListPage() {
  const [params, setParams] = useSearchParams();
  const kind: RewardTableKind = params.get('kind') === 'expedition' ? 'expedition' : 'boss';
  const canWrite = useHasPermission('rewards.write');
  const query = useQuery({
    queryKey: [...REWARD_TABLES_QUERY_KEY, 'list', kind],
    queryFn: ({ signal }) => listRewardTables(kind, signal),
  });
  const tables = query.data?.tables ?? [];
  const exporting = useMutation({
    mutationFn: () => exportRewardTables(kind),
    onSuccess: (exported) => downloadJson(exported.file, exported.tables),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reward Tables"
        description="What bosses and expeditions pay. Edits reach the next boss spawn and mission deploy; nothing already running changes."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={exporting.isPending} onClick={() => exporting.mutate()}>
              Export {KIND_LABELS[kind].toLowerCase()} tables
            </Button>
            {canWrite && (
              <Button asChild variant="accent">
                <Link to={`/admin/reward-tables/${kind}/new`}>New {KIND_LABELS[kind].toLowerCase()} table</Link>
              </Button>
            )}
          </div>
        }
      />

      <div className="flex gap-2" role="tablist" aria-label="Reward table kind">
        {REWARD_TABLE_KINDS.map((k) => (
          <Button
            key={k}
            role="tab"
            aria-selected={k === kind}
            variant={k === kind ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setParams({ kind: k })}
          >
            {KIND_LABELS[k]}
          </Button>
        ))}
      </div>

      {exporting.isError && <ErrorState variant="inline" title="Could not export" error={exporting.error} />}
      {query.isPending && <Skeleton className="h-32 w-full" />}
      {query.isError && (
        <ErrorState title="Could not load reward tables" error={query.error} onRetry={() => void query.refetch()} />
      )}
      {query.data && tables.length === 0 && (
        <Card className="p-6 text-center text-sm text-ink-muted">No {kind} reward tables.</Card>
      )}
      {tables.length > 0 && (
        <Card className="divide-y divide-border">
          {tables.map((t) => (
            <div key={t.id} className="flex flex-wrap items-start gap-3 px-4 py-3" data-testid="reward-table-row">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/admin/reward-tables/${kind}/${encodeURIComponent(t.id)}`}
                    className={cn('font-mono font-medium text-ink hover:underline', !t.enabled && 'text-ink-muted')}
                  >
                    {t.id}
                  </Link>
                  <OriginBadge summary={t} />
                  {!t.enabled && <Badge variant="danger">Disabled</Badge>}
                  {t.equipmentRowCount > 0 && <Badge variant="outline">Pays gear</Badge>}
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  {t.groupCount} group{t.groupCount === 1 ? '' : 's'} · {t.itemRowCount} item row
                  {t.itemRowCount === 1 ? '' : 's'} · {t.equipmentRowCount} gear row{t.equipmentRowCount === 1 ? '' : 's'}
                </p>
                <p className="text-xs text-ink-subtle">
                  {t.references.length > 0
                    ? `Paid by ${t.references.map((r) => r.name).join(', ')}`
                    : 'Nothing pays from this table.'}
                </p>
              </div>
              <Button size="sm" variant="outline" asChild>
                <Link to={`/admin/reward-tables/${kind}/${encodeURIComponent(t.id)}`}>{canWrite ? 'Edit' : 'View'}</Link>
              </Button>
            </div>
          ))}
        </Card>
      )}

      <ImportPanel kind={kind} canWrite={canWrite} />
    </div>
  );
}

const ACTION_LABELS: Record<RewardTableImportPlan['entries'][number]['action'], string> = {
  create: 'New',
  update: 'Changed',
  unchanged: 'Unchanged',
  invalid: 'Invalid',
};

/**
 * Upload an exported file, see what it would change, then apply it. The plan
 * records each table's revision; applying refuses (409) if any of them moved
 * in between, so what is applied is exactly what was reviewed.
 */
function ImportPanel({ kind, canWrite }: { kind: RewardTableKind; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<{ name: string; tables: unknown } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const plan = useMutation({ mutationFn: (tables: unknown) => planRewardTableImport(kind, tables) });
  const apply = useMutation({
    mutationFn: (p: RewardTableImportPlan) =>
      applyRewardTableImport(
        kind,
        file!.tables,
        Object.fromEntries(p.entries.map((e) => [e.id, e.currentRevision])),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REWARD_TABLES_QUERY_KEY });
      plan.reset();
    },
  });

  const onFile = async (chosen: File | null) => {
    plan.reset();
    apply.reset();
    setReadError(null);
    setFile(null);
    if (!chosen) return;
    try {
      const tables: unknown = JSON.parse(await chosen.text());
      setFile({ name: chosen.name, tables });
      plan.mutate(tables);
    } catch {
      setReadError(`${chosen.name} is not valid JSON.`);
    }
  };

  const changes = plan.data?.entries.filter((e) => e.action !== 'unchanged') ?? [];
  return (
    <Card className="space-y-3 p-4" data-testid="reward-import">
      <h2 className="text-sm font-semibold uppercase text-ink-muted">Import {KIND_LABELS[kind].toLowerCase()} tables</h2>
      <p className="text-xs text-ink-muted">
        Choose a file exported from this page (or the shipped {kind === 'boss' ? 'bossRewards.json' : 'expeditionRewards.json'}).
        Tables in the file are created or replaced; tables not in it are left alone.
      </p>
      <input
        type="file"
        accept="application/json,.json"
        aria-label="Import file"
        onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
      />
      {readError && <p className="text-xs text-danger">{readError}</p>}
      {plan.isPending && <Skeleton className="h-16 w-full" />}
      {plan.isError && <ErrorState variant="inline" title="Could not check the file" error={plan.error} />}
      {plan.data && (
        <div className="space-y-2 text-xs" data-testid="import-plan">
          {plan.data.issues.map((i) => (
            <p key={`${i.path}:${i.message}`} className="text-danger">
              {i.path}: {i.message}
            </p>
          ))}
          {changes.length === 0 && plan.data.issues.length === 0 ? (
            <p className="text-ink-muted">Nothing to change — every table in the file matches this server.</p>
          ) : (
            <ul className="space-y-1">
              {changes.map((e) => (
                <li key={e.id}>
                  <span className={cn('font-medium', e.action === 'invalid' && 'text-danger')}>
                    {ACTION_LABELS[e.action]}
                  </span>{' '}
                  <span className="font-mono">{e.id}</span>
                  {e.issues
                    .filter((i) => i.severity === 'error')
                    .map((i) => (
                      <span key={`${i.path}:${i.message}`} className="block pl-4 text-danger">
                        {i.path}: {i.message}
                      </span>
                    ))}
                </li>
              ))}
            </ul>
          )}
          {canWrite && changes.length > 0 && (
            <Button
              type="button"
              variant="accent"
              size="sm"
              disabled={!plan.data.canApply || apply.isPending}
              onClick={() => apply.mutate(plan.data!)}
            >
              {apply.isPending ? 'Applying…' : `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>
      )}
      {apply.isError && <ErrorState variant="inline" title="Could not apply the import" error={apply.error} />}
      {apply.isSuccess && (
        <p className="text-xs text-ink-muted" data-testid="import-applied">
          Imported {file?.name}: {apply.data.created.length} created, {apply.data.updated.length} updated.
        </p>
      )}
    </Card>
  );
}
