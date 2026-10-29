/**
 * Admin — import an equipment package (`waifumon-equipment` v2 or v3).
 *
 * Upload or paste → preview → confirm → apply, with nothing written until the
 * last step:
 *
 *   - The **preview** is the server's plan: what would be created, updated or
 *     left alone, which changes it refuses (a locked slot or rarity, an
 *     invalid entry), whose enabled state it overrides, and which new N/R/SR
 *     gear could join automatic rewards once enabled.
 *   - **New definitions always arrive disabled**, and updated ones keep their
 *     current enabled state — an import never switches gear on.
 *   - **Apply is atomic and applies only what was previewed.** If the
 *     catalogue changed in between, the server refuses and the page asks for
 *     a fresh preview.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  applyEquipmentImport,
  invalidateCatalogueQueries,
  previewEquipmentImport,
  type ImportPreview,
} from '@/api/adminEquipment';
import { isPortalApiError } from '@/api/client';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import { IssueList } from './catalogueParts';
import { SOURCE_LABELS, WHEN_LABELS, equipmentPath, refusedIssues } from './equipmentModel';

/**
 * A first check on the file as saved. The server's ceiling (4 MiB + 64 KiB,
 * `EQUIPMENT_IMPORT_BODY_LIMIT_BYTES`) applies to the compact JSON this page
 * sends, and an exported file is pretty-printed, so the file may be larger;
 * anything past this is far beyond it. The server's 413 names the real limit.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const ACTION_LABELS: Record<ImportPreview['entries'][number]['action'], string> = {
  create: 'New',
  update: 'Update',
  unchanged: 'Unchanged',
};

export function EquipmentImportPage() {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<unknown>(null);
  const [confirmed, setConfirmed] = useState(false);

  const preview = useMutation({ mutationFn: (pkg: unknown) => previewEquipmentImport(pkg) });
  const apply = useMutation({
    mutationFn: () => applyEquipmentImport(parsed, preview.data!.planHash, filename ?? undefined),
    onSuccess: () => invalidateCatalogueQueries(queryClient),
  });

  const changeText = (next: string, name: string | null) => {
    setText(next);
    setFilename(name);
    setParseError(null);
    setParsed(null);
    setConfirmed(false);
    preview.reset();
    apply.reset();
  };
  const runPreview = () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (err) {
      setParseError(`That is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setParsed(value);
    setConfirmed(false);
    apply.reset();
    preview.mutate(value);
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setParseError('That file is too large for an equipment package.');
      return;
    }
    changeText(await file.text(), file.name);
  };

  const plan = preview.data;
  const stale =
    isPortalApiError(apply.error) &&
    ['EQUIPMENT_IMPORT_STALE', 'EQUIPMENT_IMPORT_CONFLICT'].includes(apply.error.code ?? '');
  const packageIssues = refusedIssues(preview.error);
  const applyIssues = refusedIssues(apply.error);
  const changes = plan ? plan.counts.create + plan.counts.update : 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Import equipment"
        description="Load a waifumon-equipment package (version 2 or 3). New equipment always arrives disabled; existing equipment keeps its enabled state."
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/equipment">Back to catalogue</Link>
          </Button>
        }
      />

      <Card className="space-y-3 p-4">
        <label className="block text-sm text-ink">
          Upload a JSON file
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Upload package file"
            className="mt-1 block text-sm"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </label>
        <label className="block text-xs text-ink-muted">
          …or paste the package
          <textarea
            aria-label="Package JSON"
            className="mt-1 block h-48 w-full rounded-md border border-border bg-surface p-2 font-mono text-xs text-ink"
            value={text}
            onChange={(e) => changeText(e.target.value, null)}
          />
        </label>
        {parseError && (
          <p className="text-sm text-danger" role="alert">
            {parseError}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={text.trim() === '' || preview.isPending}
          onClick={runPreview}
        >
          {preview.isPending ? 'Checking…' : 'Preview import'}
        </Button>
        {packageIssues.length > 0 && (
          <div className="space-y-1" data-testid="package-invalid">
            <p className="text-sm font-medium text-danger">The package is not valid:</p>
            <IssueList issues={packageIssues} testId="package-issues" />
          </div>
        )}
        {preview.isError && packageIssues.length === 0 && (
          <ErrorState variant="inline" title="Could not preview the import" error={preview.error} />
        )}
      </Card>

      {plan && !apply.isSuccess && (
        <Card className="space-y-3 p-4" data-testid="import-preview">
          <h2 className="text-sm font-semibold uppercase text-ink-muted">Preview</h2>
          <p className="text-sm text-ink" data-testid="import-counts">
            {plan.counts.create} new · {plan.counts.update} updated · {plan.counts.unchanged}{' '}
            unchanged
          </p>
          {!plan.ok && (
            <div className="space-y-1" data-testid="import-refusals">
              <p className="text-sm font-medium text-danger">
                Nothing can be imported until these are fixed:
              </p>
              <IssueList issues={plan.issues} testId="import-issues" />
            </div>
          )}
          <ul className="space-y-1 text-sm" data-testid="import-entries">
            {plan.entries.map((e) => (
              <li key={e.key} data-testid="import-entry">
                <Badge variant={e.action === 'unchanged' ? 'default' : 'outline'}>
                  {ACTION_LABELS[e.action]}
                </Badge>{' '}
                <span className="font-mono">{e.key}</span>
                {e.changedFields.length > 0 && (
                  <span className="text-ink-muted"> — changes {e.changedFields.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
          {plan.statusNotes.length > 0 && (
            <div className="space-y-1" data-testid="import-status-notes">
              <p className="text-xs font-semibold uppercase text-ink-muted">Enabled state</p>
              <ul className="text-sm text-ink-muted">
                {plan.statusNotes.map((n) => (
                  <li key={n.key}>
                    <span className="font-mono">{n.key}</span>:{' '}
                    {n.reason === 'new_definitions_start_disabled'
                      ? 'the file says enabled, but new equipment arrives disabled.'
                      : `stays ${n.enabled ? 'enabled' : 'disabled'} — an import never changes it.`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.rewardImpact.length > 0 && (
            <div className="space-y-1" data-testid="import-reward-impact">
              <p className="text-xs font-semibold uppercase text-ink-muted">
                Rewards these could join once enabled
              </p>
              <ul className="text-sm">
                {plan.rewardImpact.map((r) => (
                  <li key={r.key}>
                    <span className="font-mono">{r.key}</span>:{' '}
                    <span className="text-ink-muted">
                      {[...r.impact.automatic, ...r.impact.deferred]
                        .map(
                          (s) => `${SOURCE_LABELS[s.source]} “${s.name}” (${WHEN_LABELS[s.when]})`,
                        )
                        .join('; ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.artwork.warnings.length > 0 && (
            <div className="space-y-1" data-testid="import-artwork-warnings">
              <p className="text-xs font-semibold uppercase text-ink-muted">
                Artwork not on this server
              </p>
              <p className="text-sm text-ink-muted">
                Artwork is not part of the package. Deploy these files with the assets release, or
                the gear shows without a picture. This does not block the import.
              </p>
              <ul className="text-sm">
                {plan.artwork.warnings.map((w) => (
                  <li key={w.key}>
                    <span className="font-mono">{w.key}</span>:{' '}
                    <span className="font-mono text-ink-muted">{w.artworkPath}</span>
                    {w.status === 'unsafe' ? ' (outside the assets folder)' : ' (missing)'}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.ok && changes > 0 && (
            <>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  aria-label="Confirm import"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>
                  Apply these {changes} change{changes === 1 ? '' : 's'}. New equipment arrives
                  disabled. Changes reach future drops only.
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
          {plan.ok && changes === 0 && (
            <p className="text-sm text-ink-muted">
              Everything in this package is already in the catalogue.
            </p>
          )}
          {stale && (
            <p className="text-sm text-danger" role="alert" data-testid="import-stale">
              The catalogue changed since this preview, so nothing was imported. Preview it again.
            </p>
          )}
          <IssueList issues={applyIssues} testId="apply-issues" />
          {apply.isError && !stale && applyIssues.length === 0 && (
            <ErrorState variant="inline" title="Could not import" error={apply.error} />
          )}
        </Card>
      )}

      {apply.isSuccess && (
        <Card className="space-y-2 p-4 text-sm" role="status" data-testid="import-result">
          <p className="text-ink">
            Imported: {apply.data.plan.counts.create} new, {apply.data.plan.counts.update} updated
            (import #{apply.data.logId}).
          </p>
          <ul className="space-y-0.5">
            {apply.data.plan.entries
              .filter((e) => e.action !== 'unchanged')
              .map((e) => (
                <li key={e.key}>
                  <Link className="text-accent underline" to={equipmentPath(e.key)}>
                    {e.key}
                  </Link>
                </li>
              ))}
          </ul>
          <Button variant="outline" size="sm" onClick={() => changeText('', null)}>
            Import another
          </Button>
        </Card>
      )}
    </div>
  );
}
