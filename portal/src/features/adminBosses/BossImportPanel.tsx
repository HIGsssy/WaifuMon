/**
 * Import boss definitions: paste or upload a document, see what it would do,
 * choose what happens to bosses that already exist, then apply.
 *
 * Nothing is written until Apply. A boss that already exists and differs is a
 * **conflict**, and is left alone unless the admin deliberately chooses to
 * overwrite and confirms it. An overwrite names each conflicting boss's
 * revision from the plan, so the server refuses (409) if any of them changed
 * in between — what is applied is exactly what was reviewed.
 */
import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  applyBossImport,
  invalidateBossQueries,
  planBossImport,
  type BossImportAction,
  type BossImportConflictMode,
  type BossImportPlan,
  type BossIssue,
} from '@/api/adminBosses';
import { isPortalApiError } from '@/api/client';
import { ErrorState } from '@/components/layout/ErrorState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

import { BossIssues } from './bossParts';

const ACTION_LABELS: Record<BossImportAction, string> = {
  create: 'New',
  conflict: 'Conflict',
  unchanged: 'Unchanged',
  invalid: 'Invalid',
};

const plural = (n: number, one: string, many = `${one}es`) => `${n} ${n === 1 ? one : many}`;

export function BossImportPanel({ canWrite, onClose }: { canWrite: boolean; onClose: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  /** The parsed document the plan on screen was made from — and the one Apply sends. */
  const [checked, setChecked] = useState<unknown>(null);
  const [mode, setMode] = useState<BossImportConflictMode>('skip');
  const [confirmedOverwrite, setConfirmedOverwrite] = useState(false);

  const plan = useMutation({ mutationFn: (document: unknown) => planBossImport(document) });
  const apply = useMutation({
    mutationFn: (reviewed: BossImportPlan) =>
      applyBossImport(
        checked,
        mode,
        mode === 'overwrite'
          ? Object.fromEntries(
              reviewed.entries
                .filter((e) => e.action === 'conflict' && e.currentRevision !== null)
                .map((e) => [e.id, e.currentRevision!]),
            )
          : undefined,
      ),
    onSuccess: () => {
      invalidateBossQueries(queryClient);
      plan.reset();
    },
  });

  /** A different document is a different import: what was reviewed no longer applies. */
  const startOver = (next: string) => {
    setText(next);
    setReadError(null);
    setChecked(null);
    setMode('skip');
    setConfirmedOverwrite(false);
    plan.reset();
    apply.reset();
  };

  const check = (source: string) => {
    try {
      const document: unknown = JSON.parse(source);
      setChecked(document);
      plan.mutate(document);
    } catch {
      setReadError('That is not valid JSON.');
    }
  };

  const onFile = async (file: File | null) => {
    if (!file) return;
    const content = await file.text();
    startOver(content);
    check(content);
  };

  const entries = plan.data?.entries ?? [];
  const creates = entries.filter((e) => e.action === 'create');
  const conflicts = entries.filter((e) => e.action === 'conflict');
  const overwriting = mode === 'overwrite' && conflicts.length > 0;
  const nothingToDo = creates.length === 0 && !overwriting;
  const staleApply = isPortalApiError(apply.error) && apply.error.code === 'BOSS_DEFINITION_STALE';
  const refused: BossIssue[] =
    isPortalApiError(apply.error) && apply.error.code === 'BOSS_DEFINITION_INVALID'
      ? (((apply.error.details ?? {}) as { issues?: BossIssue[] }).issues ?? [])
      : [];

  return (
    <Card className="space-y-3 p-4" data-testid="boss-import">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase text-ink-muted">Import bosses</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Paste a document exported from this page, or choose the file. New ids are created;
            bosses not in the document are left alone. Nothing is written until you apply.
          </p>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close import
        </Button>
      </div>
      <input
        type="file"
        accept="application/json,.json"
        aria-label="Import file"
        onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
      />
      <textarea
        aria-label="Import JSON"
        className="block min-h-28 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-ink"
        placeholder='{ "format": "waifumon-boss-definitions", "version": 1, "bosses": [ … ] }'
        value={text}
        onChange={(e) => startOver(e.target.value)}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={text.trim() === '' || plan.isPending}
        onClick={() => check(text)}
      >
        {plan.isPending ? 'Checking…' : 'Check import'}
      </Button>
      {readError && (
        <p className="text-xs text-danger" role="alert">
          {readError}
        </p>
      )}
      {plan.isPending && <Skeleton className="h-16 w-full" />}
      {plan.isError && (
        <ErrorState variant="inline" title="Could not check the document" error={plan.error} />
      )}

      {plan.data && (
        <div className="space-y-3" data-testid="import-plan">
          <BossIssues issues={plan.data.issues} testId="import-document-issues" />
          {entries.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-ink-muted">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Boss</th>
                    <th className="py-1 pr-3 font-medium">Result</th>
                    <th className="py-1 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {entries.map((entry) => (
                    <tr key={entry.id} data-testid="import-entry" className="align-top">
                      <td className="py-1.5 pr-3">
                        <span className="text-ink">{entry.name ?? entry.id}</span>
                        <span className="block font-mono text-xs text-ink-subtle">{entry.id}</span>
                      </td>
                      <td className="py-1.5 pr-3">
                        <Badge
                          variant={
                            entry.action === 'invalid'
                              ? 'danger'
                              : entry.action === 'conflict'
                                ? 'solid'
                                : entry.action === 'create'
                                  ? 'default'
                                  : 'outline'
                          }
                        >
                          {ACTION_LABELS[entry.action]}
                        </Badge>
                      </td>
                      <td className="py-1.5 text-xs text-ink-muted">
                        {entry.action === 'create' && 'Will be created.'}
                        {entry.action === 'unchanged' && 'Matches the boss on this server.'}
                        {entry.action === 'conflict' && (
                          <span data-testid="import-changed-fields">
                            Already exists and differs in: {entry.changedFields.join(', ')}
                          </span>
                        )}
                        <BossIssues issues={entry.issues} testId="import-entry-issues" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!plan.data.canApply && (
            <p className="text-xs text-danger" role="alert" data-testid="import-blocked">
              This document cannot be applied until every problem above is fixed.
            </p>
          )}

          {plan.data.canApply && conflicts.length > 0 && (
            <fieldset
              className="space-y-2 rounded-lg border border-border p-3"
              disabled={!canWrite}
            >
              <legend className="px-1 text-xs text-ink-muted">
                {plural(conflicts.length, 'boss')} already exist{conflicts.length === 1 ? 's' : ''}{' '}
                and differ{conflicts.length === 1 ? 's' : ''}
              </legend>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="radio"
                  className="mt-1"
                  name={`${id}-conflicts`}
                  aria-label="Skip existing bosses"
                  checked={mode === 'skip'}
                  onChange={() => {
                    setMode('skip');
                    setConfirmedOverwrite(false);
                  }}
                />
                <span>
                  Skip existing bosses
                  <span className="block text-xs text-ink-muted">
                    Every boss that already exists is left exactly as it is.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="radio"
                  className="mt-1"
                  name={`${id}-conflicts`}
                  aria-label={`Overwrite the ${plural(conflicts.length, 'conflicting boss')}`}
                  checked={mode === 'overwrite'}
                  onChange={() => setMode('overwrite')}
                />
                <span>
                  Overwrite the {plural(conflicts.length, 'conflicting boss')}
                  <span className="block text-xs text-ink-muted">
                    Their current definitions, schedules included, are replaced by the document’s.
                  </span>
                </span>
              </label>
              {mode === 'overwrite' && (
                <label
                  className="flex items-start gap-2 rounded-lg border border-danger/40 p-2 text-sm text-ink"
                  data-testid="import-overwrite-confirm"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label="Confirm overwrite"
                    checked={confirmedOverwrite}
                    onChange={(e) => setConfirmedOverwrite(e.target.checked)}
                  />
                  <span>
                    I understand this replaces {plural(conflicts.length, 'existing boss')}:{' '}
                    <span className="font-mono text-xs">
                      {conflicts.map((e) => e.id).join(', ')}
                    </span>
                  </span>
                </label>
              )}
            </fieldset>
          )}

          {plan.data.canApply && nothingToDo && (
            <p className="text-xs text-ink-muted" data-testid="import-nothing">
              {conflicts.length > 0
                ? 'Nothing new to create. Existing bosses are skipped unless you choose to overwrite them.'
                : 'Nothing to change — every boss in the document matches this server.'}
            </p>
          )}

          {canWrite ? (
            <Button
              type="button"
              variant={overwriting ? 'danger' : 'accent'}
              size="sm"
              disabled={
                !plan.data.canApply ||
                nothingToDo ||
                apply.isPending ||
                (overwriting && !confirmedOverwrite)
              }
              onClick={() => apply.mutate(plan.data)}
            >
              {apply.isPending
                ? 'Applying…'
                : overwriting
                  ? `Apply: create ${creates.length}, overwrite ${conflicts.length}`
                  : `Apply: create ${creates.length}`}
            </Button>
          ) : (
            <p className="text-xs text-ink-muted">You do not have write permission to apply it.</p>
          )}
        </div>
      )}

      {staleApply && (
        <p className="text-xs text-danger" role="alert" data-testid="import-stale">
          A boss changed on this server after the document was checked, so nothing was applied.
          Check the import again to review the current differences.
        </p>
      )}
      <BossIssues issues={refused} testId="import-refused-issues" />
      {apply.isError && !staleApply && refused.length === 0 && (
        <ErrorState variant="inline" title="Could not apply the import" error={apply.error} />
      )}
      {apply.isSuccess && (
        <div className="text-xs text-ink-muted" role="status" data-testid="import-applied">
          <p className="text-ink">
            Import applied: {apply.data.created.length} created, {apply.data.overwritten.length}{' '}
            overwritten, {apply.data.skipped.length} skipped, {apply.data.unchanged.length}{' '}
            unchanged.
          </p>
          {(
            [
              ['Created', apply.data.created],
              ['Overwritten', apply.data.overwritten],
              ['Skipped', apply.data.skipped],
            ] as const
          )
            .filter(([, ids]) => ids.length > 0)
            .map(([label, ids]) => (
              <p key={label}>
                {label}: <span className="font-mono">{ids.join(', ')}</span>
              </p>
            ))}
        </div>
      )}
    </Card>
  );
}
