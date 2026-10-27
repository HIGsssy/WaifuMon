import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EQUIPMENT_RARITIES,
  type EquipmentIssue,
  type EquipmentRarity,
} from '@/api/adminEquipment';
import * as api from '@/api/adminEquipmentRules';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { downloadJson } from './equipmentModel';
import { HighRarityFields, LegacyRules, NumberField, RuleIssues } from './RulesFields';
import { RulesDialog, RulesDiff, RulesImportDialog, ValidationResult } from './RulesReview';
import { emptyRarity, formOfRules, inputOfRules, type RulesForm } from './rulesModel';

export function EquipmentRarityRulesPage() {
  const canRead = useHasPermission('equipment.read');
  const query = useQuery({
    queryKey: api.RULES_QUERY_KEY,
    queryFn: ({ signal }) => api.loadRules(signal),
    enabled: canRead,
    refetchOnWindowFocus: false,
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Equipment Rarity Rules"
        description="Edit drafts, review changes and explicitly publish rules for future equipment rolls."
      />
      {!canRead ? (
        <p role="alert">
          equipment.read is required to inspect rules and revisions. Write and publish permissions
          do not grant read access.
        </p>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data ? (
        <RulesEditor initial={query.data} />
      ) : (
        <Skeleton className="h-48" />
      )}
    </div>
  );
}

function RulesEditor({ initial }: { initial: api.RulesBundle }) {
  const canWrite = useHasPermission('equipment.write');
  const canPublish = useHasPermission('equipment.publish');
  const client = useQueryClient();
  const [bundle, setBundle] = useState(initial);
  const [form, setForm] = useState(() => formOfRules(initial.draft.rules));
  const [rarity, setRarity] = useState<EquipmentRarity>('SSR');
  const [view, setView] = useState<'draft' | 'published'>('draft');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [status, setStatus] = useState('');
  const [validation, setValidation] = useState<api.RollRulesValidation | null>(null);
  const [review, setReview] = useState<api.RollRulesPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [rollback, setRollback] = useState<api.RulesRevision | null>(null);
  const [rollbackConfirmed, setRollbackConfirmed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const baseline = JSON.stringify(formOfRules(bundle.draft.rules));
  const unsaved = JSON.stringify(form) !== baseline;
  const parsed = inputOfRules(form, bundle.draft.rules);
  const issues = [...parsed.issues, ...(validation?.errors ?? [])];
  const high = rarity === 'SSR' || rarity === 'UR' || rarity === 'LR';
  const shownRules = view === 'draft' ? bundle.draft.rules : bundle.published.rules;
  const shownForm = view === 'draft' ? form : formOfRules(bundle.published.rules);
  const editable = canWrite && view === 'draft' && !busy && !stale;

  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);
  function failure(err: unknown) {
    setError(err);
    setConfirmed(false);
    setRollbackConfirmed(false);
    if (
      isPortalApiError(err) &&
      (err.code === 'EQUIPMENT_CONFIG_STALE' || err.code === 'EQUIPMENT_CONFIG_CONFLICT')
    ) {
      setStale(true);
      setReview(null);
      setValidation(null);
    } else if (isPortalApiError(err) && err.code === 'EQUIPMENT_CONFIG_INVALID') {
      const errors = (err.details?.issues ?? []) as EquipmentIssue[];
      setValidation({ ok: false, errors, warnings: [], value: null });
      setReview((current) =>
        current
          ? { ...current, validation: { ok: false, errors, warnings: [], value: null } }
          : null,
      );
    }
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      await action();
    } catch (err) {
      failure(err);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function edit(next: RulesForm) {
    setForm(next);
    setValidation(null);
    setReview(null);
    setConfirmed(false);
    setStatus('');
    setError(null);
  }
  function adopt(next: api.RulesBundle) {
    setBundle(next);
    setForm(formOfRules(next.draft.rules));
    setStale(false);
    setValidation(null);
    setReview(null);
    setConfirmed(false);
    client.setQueryData(api.RULES_QUERY_KEY, next);
  }
  async function refresh() {
    adopt(await api.loadRules());
  }
  async function save() {
    if (!parsed.rules) return;
    const draft = await api.saveDraft(parsed.rules, bundle.draft.draftRevision);
    adopt({ ...bundle, draft });
    setStatus('Draft saved. Published rules are unchanged. Validate and review before publishing.');
  }
  async function reviewChanges() {
    if (!parsed.rules) return;
    const value = await api.previewRules(parsed.rules);
    if (
      value.draftRevision !== bundle.draft.draftRevision ||
      value.publishedRevision !== bundle.published.revision
    ) {
      setStale(true);
      setValidation(null);
      setReview(null);
      return;
    }
    setValidation(value.validation);
    setConfirmed(false);
    setReview(value);
  }
  const publishReady =
    canPublish &&
    !unsaved &&
    !stale &&
    !!review?.validation.ok &&
    review.changes.length > 0 &&
    bundle.draft.dirty;
  return (
    <>
      <nav className="flex flex-wrap gap-4 text-sm">
        <Link className="text-accent underline" to="/admin/equipment">
          Equipment Catalogue
        </Link>
        <span aria-current="page">Rarity Rules</span>
        <Link className="text-accent underline" to="/admin/equipment/affix-libraries">
          Affix Libraries
        </Link>
      </nav>
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <h2 className="font-medium">Published revision {bundle.published.revision}</h2>
            <p className="text-sm text-ink-muted">
              {new Date(bundle.published.publishedAt).toLocaleString()} ·{' '}
              {bundle.published.publishedBy ?? 'Unknown publisher'}
            </p>
          </div>
          <div>
            <h2 className="font-medium">Draft revision {bundle.draft.draftRevision}</h2>
            <p className="text-sm">
              {bundle.draft.dirty
                ? 'Draft differs from published rules'
                : 'Draft matches published rules'}
            </p>
            <p className="text-sm text-ink-muted">
              Last edited {new Date(bundle.draft.updatedAt).toLocaleString()} ·{' '}
              {bundle.draft.updatedBy ?? 'Unknown editor'}
            </p>
          </div>
        </div>
        <p role="status" className="text-sm font-medium">
          {unsaved ? 'Unsaved local changes' : 'No unsaved local changes'}
        </p>
        <p className="text-sm text-ink-muted">
          Owned equipment keeps its stored rolls. Published per-loadout SP limits also apply when
          calculating current combat stats; natural SP never changes.
        </p>
        {!canWrite && (
          <p className="text-sm">
            Editing and validation require equipment.write. You can inspect rules and review
            changes.
          </p>
        )}
        {!canPublish && (
          <p className="text-sm">
            Publishing and rollback require equipment.publish. Saving a draft never publishes it.
          </p>
        )}
        {stale && (
          <div role="alert" className="space-y-2 text-sm text-danger">
            <p>
              This configuration changed while you were editing. Your local values have been
              preserved. Reload the current draft, then validate and review again. Nothing was
              automatically retried.
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!canWrite || busy || stale || !unsaved || !parsed.rules}
            onClick={() => void run(save)}
          >
            Save Draft
          </Button>
          <Button
            variant="outline"
            disabled={!canWrite || busy || stale || !parsed.rules}
            onClick={() =>
              void run(async () => {
                setValidation(await api.validateRules(parsed.rules!));
              })
            }
          >
            Validate
          </Button>
          <Button
            variant="outline"
            disabled={busy || stale || !parsed.rules}
            onClick={() => void run(reviewChanges)}
          >
            Review Changes
          </Button>
          <Button
            variant="accent"
            disabled={
              !canPublish || busy || stale || unsaved || !bundle.draft.dirty || !parsed.rules
            }
            onClick={() => void run(reviewChanges)}
          >
            Publish…
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => (unsaved ? setReloadConfirm(true) : void run(refresh))}
          >
            Reload current draft
          </Button>
        </div>
        {busy && <p role="status">Working…</p>}
        {unsaved && (
          <p className="text-sm text-ink-muted">
            Save your changes before publishing. Publication uses only the saved draft.
          </p>
        )}
        {status && (
          <p role="status" className="text-sm text-success">
            {status}
          </p>
        )}
      </Card>
      {error !== null && <ErrorState error={error} />}
      <RuleIssues issues={issues} label="Fields to check" />
      {validation && <ValidationResult value={validation} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          Configuration to inspect
          <select
            className={selectClass}
            value={view}
            disabled={busy}
            onChange={(e) => setView(e.target.value as typeof view)}
          >
            <option value="draft">Draft configuration</option>
            <option value="published">Published configuration (read-only)</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Rarity
          <select
            className={selectClass}
            value={rarity}
            disabled={busy}
            onChange={(e) => setRarity(e.target.value as EquipmentRarity)}
          >
            {EQUIPMENT_RARITIES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
      </div>
      {high ? (
        <>
          <Card className="space-y-2 p-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!shownForm.rarities[rarity]}
                disabled={!editable}
                onChange={(e) => {
                  const next = { ...form.rarities };
                  if (e.target.checked) next[rarity] = emptyRarity();
                  else delete next[rarity];
                  edit({ ...form, rarities: next });
                }}
              />
              Configure {rarity} rolls
            </label>
            <p className="text-sm text-ink-muted">
              An unconfigured rarity cannot roll. New configurations start blank; enter approved
              values. Removing a rule takes effect only after publication.
            </p>
          </Card>
          {shownForm.rarities[rarity] && (
            <HighRarityFields
              key={`${rarity}:${view}`}
              rarity={rarity}
              form={shownForm.rarities[rarity]!}
              onChange={(next) => edit({ ...form, rarities: { ...form.rarities, [rarity]: next } })}
              disabled={!editable}
              issues={view === 'draft' ? issues : []}
              libraries={bundle.libraries}
            />
          )}
        </>
      ) : (
        <LegacyRules rarity={rarity} rules={shownRules} />
      )}
      <details className="rounded-xl border border-line p-4">
        <summary className="cursor-pointer font-medium">Equipment SP safety limits</summary>
        <p className="my-3 text-sm text-ink-muted">
          These limits cover equipment SP bonuses, never natural SP. The maximum supported by code
          is +200 SP per copy and +400 SP per loadout. Primary SP plus additional Flat SP must fit
          the per-copy limit. Values are validated, never silently clamped by this editor.
        </p>
        <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-2">
          <NumberField
            label="Per-equipment-copy maximum"
            unit="SP"
            value={shownForm.perItemMax}
            path="flatSpLimits.perItemMax"
            issues={issues}
            onChange={(value) => edit({ ...form, perItemMax: value })}
          />
          <NumberField
            label="Per-loadout maximum"
            unit="SP"
            value={shownForm.perLoadoutMax}
            path="flatSpLimits.perLoadoutMax"
            issues={issues}
            onChange={(value) => edit({ ...form, perLoadoutMax: value })}
          />
        </fieldset>
      </details>
      <Card className="space-y-3 p-4">
        <h2 className="font-display text-lg">JSON import and export</h2>
        <p className="text-sm text-ink-muted">
          Exports contain the server's saved draft or published rules. Save local changes first to
          include them in a draft export.
        </p>
        <div className="flex flex-wrap gap-2">
          {(['draft', 'published'] as const).map((kind) => (
            <Button
              key={kind}
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  downloadJson(`equipment-rules-${kind}.json`, await api.exportRules(kind)),
                )
              }
            >
              Export {kind}
            </Button>
          ))}
          <Button
            variant="outline"
            disabled={!canWrite || busy || stale || unsaved}
            onClick={() => setImporting(true)}
          >
            Import JSON
          </Button>
        </div>
      </Card>
      <Card className="space-y-3 p-4">
        <h2 className="font-display text-lg">Published revision history</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>Revision</th>
                <th>Published</th>
                <th>Actor</th>
                <th>Origin</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {bundle.revisions.map((row) => (
                <tr key={row.revision} className="border-t border-line">
                  <td className="py-2">
                    {row.revision}
                    {row.current ? ' (current)' : ''}
                  </td>
                  <td>{new Date(row.publishedAt).toLocaleString()}</td>
                  <td>{row.publishedBy ?? 'Unknown'}</td>
                  <td>
                    {row.rolledBackFrom !== null
                      ? `Rollback of revision ${row.rolledBackFrom}`
                      : row.source}
                  </td>
                  <td>
                    {!row.current && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canPublish || busy || stale || unsaved}
                        onClick={() => {
                          setRollback(row);
                          setRollbackConfirmed(false);
                          setError(null);
                        }}
                      >
                        Roll back to revision {row.revision}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-sm text-ink-muted">
        For deterministic equipment samples, use the{' '}
        <Link className="text-accent underline" to="/admin/equipment">
          Equipment Catalogue preview
        </Link>
        . It uses published rules.
      </p>
      {review && (
        <RulesDialog
          title="Review rarity rule changes"
          description="Review the backend validation and diff before publishing the saved draft."
          close={() => {
            if (!busy) setReview(null);
          }}
        >
          <ValidationResult value={review.validation} />
          <RulesDiff preview={review} />
          {unsaved && (
            <p role="alert">These changes are unsaved. Save and review again before publishing.</p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!publishReady || busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Publish draft revision {review.draftRevision} for future unpinned grants. Existing owned
            equipment rolls stay unchanged.
          </label>
          <Button
            disabled={!publishReady || !confirmed || busy}
            onClick={() =>
              void run(async () => {
                await api.publishRules(review.draftRevision);
                setReview(null);
                await refresh();
                void client.invalidateQueries({ queryKey: ['admin', 'equipment'] });
                setStatus('Rules published successfully.');
              })
            }
          >
            Confirm publication
          </Button>
          {error !== null && <ErrorState error={error} />}
        </RulesDialog>
      )}
      {rollback && (
        <RulesDialog
          title={`Roll back to revision ${rollback.revision}`}
          description="This publishes the selected historical configuration as a new revision and replaces the saved draft. The backend rechecks current library and equipment dependencies."
          close={() => {
            if (!busy) setRollback(null);
          }}
        >
          <p className="text-sm">
            Future unpinned equipment grants use the restored rules. Existing owned equipment
            remains unchanged. Published per-loadout SP limits still affect current combat
            calculations.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rollbackConfirmed}
              disabled={busy || stale}
              onChange={(e) => setRollbackConfirmed(e.target.checked)}
            />
            Restore revision {rollback.revision} as a new publication.
          </label>
          <Button
            disabled={busy || stale || !canPublish || !rollbackConfirmed}
            onClick={() =>
              void run(async () => {
                await api.rollbackRules(rollback.revision, bundle.draft.draftRevision);
                setRollback(null);
                await refresh();
                void client.invalidateQueries({ queryKey: ['admin', 'equipment'] });
                setStatus('Rollback published as a new revision.');
              })
            }
          >
            Confirm rollback
          </Button>
          {error !== null && <ErrorState error={error} />}
          {validation && <ValidationResult value={validation} />}
        </RulesDialog>
      )}
      {importing && (
        <RulesImportDialog
          revision={bundle.draft.draftRevision}
          onFailure={failure}
          close={() => setImporting(false)}
          onApplied={async () => {
            setImporting(false);
            await refresh();
            setStatus('Import saved to the draft only. Validate and review before publication.');
          }}
        />
      )}
      {reloadConfirm && (
        <RulesDialog
          title="Reload current draft?"
          description="Reloading replaces your unsaved local values with the current saved draft. Cancel to keep editing or copy your values first."
          close={() => setReloadConfirm(false)}
        >
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await refresh();
                setReloadConfirm(false);
              })
            }
          >
            Discard local changes and reload
          </Button>
          {error !== null && <ErrorState error={error} />}
        </RulesDialog>
      )}
    </>
  );
}
