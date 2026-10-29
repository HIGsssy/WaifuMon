/**
 * Admin — import an Enemy Catalogue package (a `.zip` exported from another
 * environment, with the enemies' artwork inside).
 *
 * Choose the file → the server checks it and says what it would do → decide
 * each changed enemy → confirm → import. Nothing is written before the last
 * step, and the import applies exactly what was previewed:
 *
 *   - **New enemies arrive disabled**; existing ones keep their enabled state.
 *   - **Changed enemies are never overwritten silently**: each needs Update or
 *     Keep current. One that this server's dungeons or Combat Trials already
 *     use is marked as a conflict and says where it is used.
 *   - **Artwork** is reused when this server already has the same image, and
 *     added otherwise. Hashes and ids are under "Technical details".
 *   - If anything changed since the preview, nothing is imported and the page
 *     asks for a fresh preview. Retrying the same import never applies it twice.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  applyEnemyPackage,
  invalidateEnemyQueries,
  previewEnemyPackage,
  type EnemyImportEntry,
  type EnemyImportOutcome,
  type EnemySlotPlan,
} from '@/api/adminEnemies';
import { isPortalApiError } from '@/api/client';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import { enemyPath } from './enemyModel';

/** The server's own limit is 48 MiB; checked here only to fail fast. */
const MAX_FILE_BYTES = 48 * 1024 * 1024;

const OUTCOME_LABELS: Record<EnemyImportOutcome, string> = {
  create: 'New',
  update: 'Changed',
  conflict: 'Changed — in use here',
  unchanged: 'Unchanged',
  invalid: 'Cannot import',
};

const FIELD_LABELS: Record<string, string> = {
  name: 'name',
  description: 'description',
  attack: 'attack',
  defense: 'defense',
  hp: 'HP',
  tags: 'tags',
  artworkPath: 'shipped artwork path',
  spriteArtworkPath: 'shipped sprite path',
  spritePlacement: 'sprite placement',
  artworkAssetId: 'full artwork',
  spriteAssetId: 'sprite',
};

/** One artwork slot, in words. */
export function describeSlot(plan: EnemySlotPlan): string {
  switch (plan.destination.kind) {
    case 'none':
      return 'none';
    case 'shipped_file':
      return 'already on this server';
    case 'reuse':
      return 'uses an image this server already has';
    case 'create':
      return 'new image added';
  }
}

type Decision = 'u' | 's';

export function EnemyImportPage() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [confirmed, setConfirmed] = useState(false);
  /** One per preview: a retry of the same import replays rather than applying twice. */
  const [requestId, setRequestId] = useState<string>('');

  const preview = useMutation({
    mutationFn: (f: File) => previewEnemyPackage(f),
    onSuccess: () => {
      setDecisions({});
      setConfirmed(false);
      setRequestId(crypto.randomUUID());
    },
  });
  const plan = preview.data;
  const apply = useMutation({
    mutationFn: () =>
      applyEnemyPackage(file!, {
        expectedPlanHash: plan!.planHash,
        requestId,
        decisions: plan!.decisionKeys.map((key) => decisions[key]).join(''),
      }),
    onSuccess: () => invalidateEnemyQueries(queryClient),
  });

  const choose = (next: File | undefined) => {
    preview.reset();
    apply.reset();
    setFileError(null);
    setFile(next ?? null);
    if (!next) return;
    if (next.size > MAX_FILE_BYTES) {
      setFileError('That file is larger than an enemy package can be (48 MB).');
      return;
    }
    preview.mutate(next);
  };

  const issuesOf = (error: unknown) =>
    isPortalApiError(error) && Array.isArray((error.details as { issues?: unknown } | undefined)?.issues)
      ? ((error.details as { issues: { path: string; message: string }[] }).issues)
      : [];
  const packageIssues = isPortalApiError(preview.error) && preview.error.code === 'ENEMY_PACKAGE_INVALID' ? issuesOf(preview.error) : [];
  const stale = isPortalApiError(apply.error) && apply.error.code === 'ENEMY_IMPORT_STALE';
  const undecided = plan ? plan.decisionKeys.filter((key) => !decisions[key]) : [];
  const writes = plan
    ? plan.counts.create + plan.decisionKeys.filter((key) => decisions[key] === 'u').length
    : 0;
  const newImages = plan ? plan.assets.filter((a) => a.action === 'create').length : 0;
  const reusedImages = plan ? plan.assets.filter((a) => a.action === 'reuse').length : 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Import enemies"
        description="Load an enemy package (.zip) exported from another environment. Its artwork comes with it. New enemies arrive disabled; existing enemies keep their enabled state."
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/enemies">Back to enemies</Link>
          </Button>
        }
      />

      <Card className="space-y-3 p-4">
        <label className="block text-sm text-ink">
          Choose an enemy package
          <input
            type="file"
            accept=".zip,application/zip"
            aria-label="Enemy package file"
            className="mt-1 block text-sm"
            onChange={(e) => choose(e.target.files?.[0])}
          />
        </label>
        {preview.isPending && <p className="text-sm text-ink-muted">Checking the package…</p>}
        {fileError && (
          <p className="text-sm text-danger" role="alert">
            {fileError}
          </p>
        )}
        {packageIssues.length > 0 && (
          <div className="space-y-1" data-testid="package-invalid">
            <p className="text-sm font-medium text-danger">This package cannot be used:</p>
            <ul className="list-disc pl-5 text-sm text-danger" data-testid="package-issues">
              {packageIssues.map((i, n) => (
                <li key={n}>
                  {i.path && <span className="font-mono">{i.path}</span>} {i.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {preview.isError && packageIssues.length === 0 && (
          <ErrorState variant="inline" title="Could not check the package" error={preview.error} />
        )}
      </Card>

      {plan && !apply.isSuccess && (
        <Card className="space-y-4 p-4" data-testid="enemy-import-preview">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold uppercase text-ink-muted">What this package would do</h2>
            <p className="text-sm text-ink" data-testid="enemy-import-counts">
              {plan.counts.create} new · {plan.counts.update + plan.counts.conflict} changed ·{' '}
              {plan.counts.unchanged} unchanged
              {plan.counts.invalid > 0 && ` · ${plan.counts.invalid} cannot be imported`}
            </p>
            <p className="text-xs text-ink-muted">
              From <span className="font-mono">{plan.package.sourceEnvironment}</span>, exported{' '}
              {new Date(plan.package.exportedAt).toLocaleString()}.{' '}
              Images: {newImages} to add, {reusedImages} already here.
            </p>
          </div>

          {plan.package.warnings.length > 0 && (
            <div className="space-y-1" data-testid="enemy-import-package-warnings">
              <p className="text-xs font-semibold uppercase text-ink-muted">Noted when it was exported</p>
              <ul className="text-sm text-ink-muted">
                {plan.package.warnings.map((w, n) => (
                  <li key={n}>
                    <span className="font-mono">{w.key}</span>: {w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ul className="divide-y divide-border rounded-md border border-border" data-testid="enemy-import-entries">
            {plan.entries.map((entry) => (
              <EntryRow
                key={entry.key}
                entry={entry}
                decision={decisions[entry.key]}
                onDecide={(d) => {
                  setDecisions((current) => ({ ...current, [entry.key]: d }));
                  setConfirmed(false);
                }}
              />
            ))}
          </ul>

          <details className="text-xs text-ink-muted" data-testid="enemy-import-technical">
            <summary className="cursor-pointer">Technical details</summary>
            <p className="mt-2">
              Plan <span className="font-mono">{plan.planHash}</span> · package{' '}
              <span className="font-mono">{plan.package.packageHash}</span>
            </p>
            <table className="mt-2 w-full text-left">
              <thead>
                <tr>
                  <th>Image</th>
                  <th>Category</th>
                  <th>Size</th>
                  <th>sha256</th>
                  <th>Here</th>
                </tr>
              </thead>
              <tbody>
                {plan.assets.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono">{a.id}</td>
                    <td>{a.category}</td>
                    <td>
                      {a.width}×{a.height}, {Math.round(a.bytes / 1024)} KB
                    </td>
                    <td className="font-mono">{a.sha256.slice(0, 16)}…</td>
                    <td>
                      {a.action === 'create'
                        ? 'added'
                        : a.action === 'reuse'
                          ? `reuses ${a.reuse.join(', ')}`
                          : 'not needed here'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          {!plan.ok && (
            <p className="text-sm font-medium text-danger" data-testid="enemy-import-refused">
              Nothing can be imported until the enemies marked “Cannot import” are fixed in the package.
            </p>
          )}
          {plan.ok && writes === 0 && undecided.length === 0 && (
            <p className="text-sm text-ink-muted" data-testid="enemy-import-nothing">
              Nothing to import: everything in this package is already here, or you chose to keep the current enemies.
            </p>
          )}
          {plan.ok && undecided.length > 0 && (
            <p className="text-sm text-ink" data-testid="enemy-import-undecided">
              Choose Update or Keep current for {undecided.length} changed{' '}
              {undecided.length === 1 ? 'enemy' : 'enemies'} before importing.
            </p>
          )}
          {plan.ok && writes > 0 && undecided.length === 0 && (
            <>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  aria-label="Confirm enemy import"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>
                  Import {writes} {writes === 1 ? 'enemy' : 'enemies'}
                  {newImages > 0 && ` and add ${newImages} ${newImages === 1 ? 'image' : 'images'}`}. New enemies
                  arrive disabled.
                </span>
              </label>
              <Button
                type="button"
                variant="accent"
                disabled={!confirmed || apply.isPending}
                onClick={() => apply.mutate()}
              >
                {apply.isPending ? 'Importing…' : 'Import'}
              </Button>
            </>
          )}
          {stale && (
            <div className="space-y-2" role="alert" data-testid="enemy-import-stale">
              <p className="text-sm text-danger">
                Enemies or artwork here changed since this preview, so nothing was imported. Check the package again.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => file && choose(file)}>
                Check again
              </Button>
            </div>
          )}
          {apply.isError && !stale && <ErrorState variant="inline" title="Could not import" error={apply.error} />}
        </Card>
      )}

      {apply.isSuccess && (
        <Card className="space-y-2 p-4 text-sm" role="status" data-testid="enemy-import-result">
          <p className="text-ink">
            {apply.data.replayed ? 'This import had already been applied: ' : 'Imported: '}
            {apply.data.created.length} new, {apply.data.updated.length} updated,{' '}
            {apply.data.skipped.length} kept as they were, {apply.data.unchanged.length} unchanged. Images:{' '}
            {apply.data.assets.created.length} added, {apply.data.assets.reused.length} reused.
          </p>
          {apply.data.created.length + apply.data.updated.length > 0 && (
            <ul className="space-y-0.5">
              {[...apply.data.created, ...apply.data.updated].map((key) => (
                <li key={key}>
                  <Link className="text-accent underline" to={enemyPath(key)}>
                    {key}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {apply.data.created.length > 0 && (
            <p className="text-xs text-ink-muted">New enemies are disabled — enable each one from its page when it is ready.</p>
          )}
          <Button variant="outline" size="sm" onClick={() => choose(undefined)}>
            Import another
          </Button>
        </Card>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  decision,
  onDecide,
}: {
  entry: EnemyImportEntry;
  decision: Decision | undefined;
  onDecide: (d: Decision) => void;
}) {
  const needsDecision = entry.outcome === 'update' || entry.outcome === 'conflict';
  const notes = [...entry.artwork.notes, ...entry.sprite.notes];
  return (
    <li className="space-y-1 px-3 py-2 text-sm" data-testid="enemy-import-entry">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={entry.outcome === 'invalid' || entry.outcome === 'conflict' ? 'danger' : entry.outcome === 'unchanged' ? 'default' : 'outline'}>
          {OUTCOME_LABELS[entry.outcome]}
        </Badge>
        <span className="font-medium text-ink">{entry.name}</span>
        <span className="font-mono text-xs text-ink-subtle">{entry.key}</span>
      </div>
      {entry.changedFields.length > 0 && (
        <p className="text-ink-muted">Changes {entry.changedFields.map((f) => FIELD_LABELS[f] ?? f).join(', ')}.</p>
      )}
      <p className="text-xs text-ink-muted">
        Full artwork: {describeSlot(entry.artwork)} · Sprite: {describeSlot(entry.sprite)}
      </p>
      {notes.map((note, n) => (
        <p key={n} className="text-xs text-ink-muted">
          {note}
        </p>
      ))}
      {entry.activation && (
        <p className="text-xs text-ink-muted" data-testid="enemy-import-activation">
          {entry.activation.reason === 'new_enemies_start_disabled'
            ? 'Enabled in the package, but new enemies arrive disabled.'
            : `Stays ${entry.activation.enabled ? 'enabled' : 'disabled'} here — an import never changes that.`}
        </p>
      )}
      {entry.outcome === 'conflict' && (
        <p className="text-xs text-danger" data-testid="enemy-import-conflict">
          Used here by{' '}
          {[...new Set(entry.references.map((r) => r.name ?? r.key))].join(', ')} — updating it changes the next fights there
          (fights already started keep the current version).
        </p>
      )}
      {entry.issues.map((issue, n) => (
        <p key={n} className="text-xs text-danger">
          {issue.message}
        </p>
      ))}
      {needsDecision && (
        <fieldset className="flex flex-wrap gap-4 pt-1 text-sm" aria-label={`Decision for ${entry.name}`}>
          <label className="flex items-center gap-1">
            <input type="radio" name={`decision-${entry.key}`} aria-label={`Update ${entry.name}`} checked={decision === 'u'} onChange={() => onDecide('u')} />
            Update
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name={`decision-${entry.key}`} aria-label={`Keep current ${entry.name}`} checked={decision === 's'} onChange={() => onDecide('s')} />
            Keep current
          </label>
        </fieldset>
      )}
    </li>
  );
}
