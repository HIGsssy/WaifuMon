/**
 * Admin — import an Enemy Catalogue package (a `.zip` exported from another
 * environment, with the enemies' artwork inside).
 *
 * Choose the file → the server checks it and says what it would do → decide
 * each changed enemy → Apply Import → confirm. Nothing is written before the
 * last step, and the import applies exactly what was previewed:
 *
 *   - **The review always ends in Apply Import.** The action stays on screen
 *     (it sticks to the bottom of the viewport) and says what still blocks it.
 *     A review with nothing to write still applies: the decisions reach the
 *     server, and the receipt says what was kept.
 *   - **New enemies arrive disabled**; existing ones keep their enabled state.
 *   - **Changed enemies are never overwritten silently**: each needs Update or
 *     Keep Existing. One that this server's dungeons or Combat Trials already
 *     use is marked as a conflict and says where it is used.
 *   - **Artwork** is reused when this server already has the same image, and
 *     added otherwise. Hashes and ids are under "Technical details".
 *   - If anything changed since the preview, nothing is imported and the page
 *     asks for a fresh preview. Retrying the same import never applies it twice.
 */
import { useEffect, useRef, useState } from 'react';
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
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

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

/** Names shown in the action bar; the rows themselves mark every one. */
const MAX_NAMES_LISTED = 5;

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES_LISTED).join(', ');
  return names.length > MAX_NAMES_LISTED ? `${shown} and ${names.length - MAX_NAMES_LISTED} more` : shown;
}

const decisionFieldId = (key: string) => `enemy-import-decision-${key}`;

export function EnemyImportPage() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // A Map, so an enemy keyed `constructor` is not already "decided" by Object.prototype.
  const [decisions, setDecisions] = useState<ReadonlyMap<string, Decision>>(new Map());
  const [confirming, setConfirming] = useState(false);
  /** Remounts the file input, so "Import another" can pick the same file again. */
  const [fileInputKey, setFileInputKey] = useState(0);
  /**
   * One per preview and set of decisions: a retry of the same import replays
   * rather than applying twice, while changed decisions are a different request.
   */
  const [requestId, setRequestId] = useState<string>('');
  const canWriteArtwork = useHasPermission('artwork.write');
  /** Two clicks can land before a render disables the button. */
  const submitting = useRef(false);
  const resultRef = useRef<HTMLDivElement>(null);

  const preview = useMutation({
    mutationFn: (f: File) => previewEnemyPackage(f),
    onSuccess: () => {
      setDecisions(new Map());
      setConfirming(false);
      setRequestId(crypto.randomUUID());
    },
  });
  const plan = preview.data;
  const apply = useMutation({
    mutationFn: () =>
      applyEnemyPackage(file!, {
        expectedPlanHash: plan!.planHash,
        requestId,
        decisions: plan!.decisionKeys.map((key) => decisions.get(key)).join(''),
      }),
    onSuccess: () => invalidateEnemyQueries(queryClient),
    onSettled: () => {
      submitting.current = false;
    },
  });

  // The review it replaces was much taller, so bring the receipt to the admin.
  useEffect(() => {
    if (apply.isSuccess) resultRef.current?.focus();
  }, [apply.isSuccess]);

  const choose = (next: File | undefined) => {
    preview.reset();
    apply.reset();
    setConfirming(false);
    setFileError(null);
    setFile(next ?? null);
    if (!next) {
      setFileInputKey((current) => current + 1);
      return;
    }
    if (next.size > MAX_FILE_BYTES) {
      setFileError('That file is larger than an enemy package can be (48 MB).');
      return;
    }
    preview.mutate(next);
  };

  const confirmApply = () => {
    setConfirming(false);
    if (submitting.current) return;
    submitting.current = true;
    apply.mutate();
  };

  const issuesOf = (error: unknown) =>
    isPortalApiError(error) && Array.isArray((error.details as { issues?: unknown } | undefined)?.issues)
      ? ((error.details as { issues: { path: string; message: string }[] }).issues)
      : [];
  const packageIssues = isPortalApiError(preview.error) && preview.error.code === 'ENEMY_PACKAGE_INVALID' ? issuesOf(preview.error) : [];
  const applyCode = isPortalApiError(apply.error) ? apply.error.code : null;
  const stale = applyCode === 'ENEMY_IMPORT_STALE';
  const stillRunning =
    isPortalApiError(apply.error) &&
    applyCode === 'ENEMY_IMPORT_REQUEST_CONFLICT' &&
    (apply.error.details as { inProgress?: unknown } | undefined)?.inProgress === true;
  const needsFreshCheck =
    applyCode === 'ENEMY_IMPORT_DECISIONS_REQUIRED' || (applyCode === 'ENEMY_IMPORT_REQUEST_CONFLICT' && !stillRunning);

  const nameOf = (key: string) => plan?.entries.find((e) => e.key === key)?.name ?? key;
  const undecided = plan ? plan.decisionKeys.filter((key) => !decisions.has(key)) : [];
  const invalidNames = plan ? plan.entries.filter((e) => e.outcome === 'invalid').map((e) => e.name) : [];
  const toUpdate = plan ? plan.decisionKeys.filter((key) => decisions.get(key) === 'u') : [];
  const toKeep = plan ? plan.decisionKeys.filter((key) => decisions.get(key) === 's') : [];
  const writes = plan ? plan.counts.create + toUpdate.length : 0;
  const newImages = plan ? plan.assets.filter((a) => a.action === 'create').length : 0;
  const reusedImages = plan ? plan.assets.filter((a) => a.action === 'reuse').length : 0;
  // Only an enemy that is written adds its images; a kept one adds nothing.
  const imagesAdded = new Set(
    (plan?.entries ?? [])
      .filter((e) => e.outcome === 'create' || decisions.get(e.key) === 'u')
      .flatMap((e) => [e.artwork.destination, e.sprite.destination])
      .flatMap((d) => (d.kind === 'create' ? [d.asset] : [])),
  ).size;
  const reviewComplete = plan !== undefined && plan.ok && undecided.length === 0;
  // Retrying a plan the server has refused as outdated can only fail again.
  const awaitingFreshCheck = stale || needsFreshCheck;
  const canApply = reviewComplete && canWriteArtwork && !awaitingFreshCheck && !apply.isPending;

  const goToNextDecision = () => {
    const next = undecided[0];
    if (!next) return;
    const field = document.getElementById(decisionFieldId(next));
    field?.scrollIntoView?.({ block: 'center' });
    field?.querySelector('input')?.focus({ preventScroll: true });
  };

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
            key={fileInputKey}
            type="file"
            accept=".zip,application/zip"
            aria-label="Enemy package file"
            disabled={apply.isPending}
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
                decision={decisions.get(entry.key)}
                disabled={apply.isPending}
                onDecide={(d) => {
                  setDecisions((current) => new Map(current).set(entry.key, d));
                  setRequestId(crypto.randomUUID());
                  apply.reset();
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

          <div
            className="sticky bottom-0 z-10 -mx-4 -mb-4 space-y-3 rounded-b-2xl border-t border-border bg-surface p-4"
            data-testid="enemy-import-actions"
          >
            <div className="max-h-[40dvh] space-y-2 overflow-y-auto">
              <div aria-live="polite" id="enemy-import-status">
                {!plan.ok && (
                  <p className="text-sm font-medium text-danger" data-testid="enemy-import-refused">
                    Nothing can be imported until {listNames(invalidNames)}{' '}
                    {invalidNames.length === 1 ? 'is' : 'are'} fixed in the package.
                  </p>
                )}
                {plan.ok && undecided.length > 0 && (
                  <p className="text-sm text-ink" data-testid="enemy-import-undecided">
                    Choose Update or Keep Existing for {undecided.length}{' '}
                    {undecided.length === 1 ? 'enemy' : 'enemies'} before applying:{' '}
                    {listNames(undecided.map(nameOf))}.
                  </p>
                )}
                {reviewComplete && !canWriteArtwork && (
                  <p className="text-sm text-danger" data-testid="enemy-import-no-permission">
                    Applying an import also needs the artwork.write permission, which you do not have. Ask an
                    administrator who has it to apply this package.
                  </p>
                )}
                {reviewComplete && canWriteArtwork && !awaitingFreshCheck && writes > 0 && (
                  <p className="text-sm text-ink" data-testid="enemy-import-ready">
                    Ready to apply: {plan.counts.create} new, {toUpdate.length} updated, {toKeep.length} kept,{' '}
                    {plan.counts.unchanged} unchanged.
                  </p>
                )}
                {reviewComplete && canWriteArtwork && !awaitingFreshCheck && writes === 0 && (
                  <p className="text-sm text-ink" data-testid="enemy-import-nothing">
                    Ready to apply: no enemy will change. {toKeep.length} kept, {plan.counts.unchanged} unchanged.
                  </p>
                )}
              </div>
              {stale && (
                <p className="text-sm text-danger" role="alert" data-testid="enemy-import-stale">
                  Enemies or artwork here changed since this preview, so nothing was imported. Check the package again.
                </p>
              )}
              {stillRunning && (
                <p className="text-sm text-danger" role="alert" data-testid="enemy-import-running">
                  This import is still running. Wait a moment and apply it again: it will not be applied twice.
                </p>
              )}
              {apply.isError && !stale && !stillRunning && (
                <div className="space-y-1" data-testid="enemy-import-error">
                  <ErrorState variant="inline" title="Could not import" error={apply.error} showReason />
                  {issuesOf(apply.error).length > 0 && (
                    <ul className="list-disc pl-5 text-sm text-danger">
                      {issuesOf(apply.error).map((issue, n) => (
                        <li key={n}>
                          <span className="font-mono">{issue.path}</span> {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="accent"
                disabled={!canApply}
                aria-describedby="enemy-import-status"
                onClick={() => setConfirming(true)}
              >
                {apply.isPending ? 'Applying…' : 'Apply Import'}
              </Button>
              {plan.ok && undecided.length > 0 && (
                <Button type="button" variant="outline" onClick={goToNextDecision}>
                  Go to next decision
                </Button>
              )}
              {awaitingFreshCheck && (
                <Button type="button" variant="outline" onClick={() => file && choose(file)}>
                  Check again
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      <Dialog open={confirming && reviewComplete} onOpenChange={setConfirming}>
        <DialogContent closeLabel="Cancel import">
          <div
            className="max-h-full w-full max-w-lg space-y-3 overflow-y-auto rounded-lg border border-border bg-surface p-5"
            data-testid="enemy-import-confirm"
          >
            <DialogTitle className="text-base font-semibold">Apply this import?</DialogTitle>
            <DialogDescription className="text-sm text-ink-muted">
              {writes > 0
                ? 'This changes this server’s Enemy Catalogue, all at once or not at all.'
                : 'No enemy will change. The import is recorded with what you kept.'}
            </DialogDescription>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
              {plan && plan.counts.create > 0 && <li>{plan.counts.create} new, arriving disabled</li>}
              {toUpdate.length > 0 && (
                <li>
                  {toUpdate.length} updated, keeping their enabled state: {listNames(toUpdate.map(nameOf))}
                </li>
              )}
              {toKeep.length > 0 && (
                <li>
                  {toKeep.length} kept as they are: {listNames(toKeep.map(nameOf))}
                </li>
              )}
              {plan && plan.counts.unchanged > 0 && <li>{plan.counts.unchanged} already the same</li>}
              {imagesAdded > 0 && (
                <li>
                  {imagesAdded} {imagesAdded === 1 ? 'image' : 'images'} added
                </li>
              )}
            </ul>
            <div className="flex flex-wrap justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="button" variant="accent" onClick={confirmApply}>
                Confirm import
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {apply.isSuccess && (
        <Card ref={resultRef} tabIndex={-1} className="space-y-2 p-4 text-sm outline-none" role="status" data-testid="enemy-import-result">
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
          {apply.data.skipped.length > 0 && (
            <p className="text-xs text-ink-muted" data-testid="enemy-import-kept">
              Kept as they were: {apply.data.skipped.join(', ')}.
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="accent" size="sm" asChild>
              <Link to="/admin/enemies">Back to Enemy Catalogue</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => choose(undefined)}>
              Import another
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  decision,
  disabled,
  onDecide,
}: {
  entry: EnemyImportEntry;
  decision: Decision | undefined;
  disabled: boolean;
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
        {needsDecision && !decision && <Badge variant="outline">Decision needed</Badge>}
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
        <fieldset id={decisionFieldId(entry.key)} className="flex flex-wrap gap-4 pt-1 text-sm" aria-label={`Decision for ${entry.name}`} disabled={disabled}>
          <label className="flex min-h-11 items-center gap-1 sm:min-h-0">
            <input type="radio" name={`decision-${entry.key}`} aria-label={`Update ${entry.name}`} checked={decision === 'u'} onChange={() => onDecide('u')} />
            Update
          </label>
          <label className="flex min-h-11 items-center gap-1 sm:min-h-0">
            <input type="radio" name={`decision-${entry.key}`} aria-label={`Keep Existing ${entry.name}`} checked={decision === 's'} onChange={() => onDecide('s')} />
            Keep Existing
          </label>
        </fieldset>
      )}
    </li>
  );
}
