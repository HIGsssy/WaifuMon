import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '@/api/adminEquipmentAffixes';
import { getDraft, RULES_QUERY_KEY } from '@/api/adminEquipmentRules';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { RulesDialog } from './RulesReview';
import {
  AffixDiff,
  AffixEntries,
  AffixEntryDialog,
  AffixNavigation,
  AffixUnsavedGuard,
  AffixValidation,
  SnapshotNotice,
} from './affixLibraryParts';
import { affixIssues, isAffixStale } from './affixLibraryModel';
import { downloadJson } from './equipmentModel';

export function AffixLibraryEditorPage() {
  const { libraryKey = '' } = useParams<{ libraryKey: string }>();
  const canRead = useHasPermission('equipment.read');
  const query = useQuery({
    queryKey: [...api.AFFIX_QUERY_KEY, libraryKey],
    queryFn: ({ signal }) => api.loadLibrary(libraryKey, signal),
    enabled: canRead,
    refetchOnWindowFocus: false,
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Affix Library"
        description="Inspect published entries and manage a separate working draft."
      />
      <AffixNavigation />
      {!canRead ? (
        <p role="alert">
          equipment.read is required to inspect affix libraries. Write and publish permissions do
          not grant read access.
        </p>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <Skeleton className="h-48" />
      ) : query.data.library.readOnly ? (
        <Card className="space-y-4 p-4">
          <h2 className="font-display text-xl">{query.data.library.name}</h2>
          <p className="text-sm">
            Legacy {query.data.library.rarity} · read-only shipped library · not revisioned
          </p>
          <p className="text-sm text-ink-muted">{query.data.library.description}</p>
          <p className="text-sm">
            N/R/SR entries cannot be edited, imported over or republished. Their original order and
            slot pools are unchanged.
          </p>
          <AffixEntries entries={query.data.library.entries} />
        </Card>
      ) : (
        <ManagedAffixEditor
          key={libraryKey}
          initial={query.data.library}
          initialHistory={query.data.revisions}
        />
      )}
    </div>
  );
}

function ManagedAffixEditor({
  initial,
  initialHistory,
}: {
  initial: api.ManagedLibrary;
  initialHistory: api.LibraryRevision[];
}) {
  const canWrite = useHasPermission('equipment.write');
  const canPublish = useHasPermission('equipment.publish');
  const client = useQueryClient();
  const [saved, setSaved] = useState(initial);
  const [meta, setMeta] = useState<api.LibraryMeta>({
    name: initial.name,
    description: initial.description,
  });
  const [entries, setEntries] = useState(initial.draftEntries);
  const [history, setHistory] = useState(initialHistory);
  const [view, setView] = useState('draft');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [status, setStatus] = useState('');
  const [validation, setValidation] = useState<api.LibraryValidation | null>(null);
  const [review, setReview] = useState<api.LibraryPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [editing, setEditing] = useState<{ index: number | null; entry: api.AffixEntry } | null>(
    null,
  );
  const [removing, setRemoving] = useState<number | null>(null);
  const [reloading, setReloading] = useState(false);
  const [rollback, setRollback] = useState<api.LibraryRevision | null>(null);
  const [rollbackConfirmed, setRollbackConfirmed] = useState(false);
  const metaDirty = meta.name !== saved.name || meta.description !== saved.description;
  const entriesDirty = JSON.stringify(entries) !== JSON.stringify(saved.draftEntries);
  const unsaved = metaDirty || entriesDirty;
  const editable = canWrite && !busy && !stale && view === 'draft';
  const draftRules = useQuery({
    queryKey: [...RULES_QUERY_KEY, 'draft-assignments'],
    queryFn: ({ signal }) => getDraft(signal),
    refetchOnWindowFocus: false,
  });
  const draftAssignments = Object.entries(draftRules.data?.rules.rarities ?? {})
    .filter(([, rule]) => rule?.affixes.mode === 'library' && rule.affixes.library === saved.key)
    .map(([rarity]) => rarity);
  function clearReview() {
    setReview(null);
    setValidation(null);
    setConfirmed(false);
    setStatus('');
    setError(null);
  }
  function changeEntries(next: api.AffixEntry[]) {
    setEntries(next);
    clearReview();
  }
  function adopt(library: api.ManagedLibrary, part?: 'meta' | 'entries') {
    setSaved(library);
    if (part !== 'entries') setMeta({ name: library.name, description: library.description });
    if (part !== 'meta') setEntries(library.draftEntries);
    setStale(false);
    clearReview();
  }
  function failure(err: unknown) {
    setError(err);
    setConfirmed(false);
    setRollbackConfirmed(false);
    if (isAffixStale(err)) {
      setStale(true);
      setReview(null);
      setValidation(null);
    } else if (affixIssues(err).length) {
      const value = { ok: false, errors: affixIssues(err) };
      setValidation(value);
      setReview((current) => (current ? { ...current, validation: value } : null));
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
  async function refresh() {
    const next = await api.loadLibrary(saved.key);
    if (next.library.readOnly) throw new Error('Managed library is unavailable.');
    adopt(next.library);
    setHistory(next.revisions);
    await draftRules.refetch();
  }
  async function preview() {
    const next = await api.previewLibrary(saved.key);
    if (
      next.draftRevision !== saved.draftRevision ||
      next.publishedRevision !== saved.publishedRevision
    ) {
      setStale(true);
      setReview(null);
      setValidation(null);
      return;
    }
    setValidation(next.validation);
    setReview(next);
    setConfirmed(false);
  }
  async function afterPublication(library: api.ManagedLibrary) {
    adopt(library);
    setHistory(await api.getHistory(library.key));
    await api.invalidateEquipment(client);
  }
  const publishReady =
    canPublish && !busy && !stale && !unsaved && saved.dirty && !!review?.validation.ok;
  return (
    <>
      <AffixUnsavedGuard when={unsaved || busy} busy={busy} />
      <Card className="space-y-3 p-4">
        <h2 className="font-display text-xl">{saved.name}</h2>
        <p className="font-mono text-xs">{saved.key}</p>
        <SnapshotNotice />
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p>
              Draft revision {saved.draftRevision} ·{' '}
              {saved.dirty ? 'unpublished changes' : 'matches published'}
            </p>
            <p>
              Metadata: {metaDirty ? 'unsaved changes' : 'saved'} · Entries:{' '}
              {entriesDirty ? 'unsaved changes' : 'saved'}
            </p>
            <p>
              Last modified {new Date(saved.updatedAt).toLocaleString()} ·{' '}
              {saved.updatedBy ?? 'Unknown editor'}
            </p>
          </div>
          <div>
            <p>
              {saved.publishedRevision === null
                ? 'Unpublished — no active library revision'
                : `Published revision ${saved.publishedRevision}`}
            </p>
            <p>Used by (published rules): {saved.assignedTo.join(', ') || 'None'}</p>
            <p>
              Draft rule assignments:{' '}
              {draftRules.isError
                ? 'unavailable'
                : draftRules.isPending
                  ? 'loading…'
                  : draftAssignments.join(', ') || 'None'}
            </p>
          </div>
        </div>
        <p className="text-sm text-ink-muted">
          {saved.publishedRevision === null
            ? 'Publish this library before selecting it as a rarity dependency. '
            : 'Publishing does not assign this library automatically. '}
          Change assignments in{' '}
          <Link className="text-accent underline" to="/admin/equipment/rarity-rules">
            Rarity Rules
          </Link>
          ; published assignments control live unpinned rolls.
        </p>
        {!canWrite && (
          <p className="text-sm">Editing, importing and validation require equipment.write.</p>
        )}
        {!canPublish && (
          <p className="text-sm">
            Publishing and rollback require equipment.publish. Draft saves never publish.
          </p>
        )}
        {unsaved && (
          <p role="status" className="text-sm font-medium">
            Unsaved local changes. Save metadata and entries separately before validation or
            publication.
          </p>
        )}
        {stale && (
          <p role="alert" className="text-sm text-danger">
            This library changed while you were editing. Local values are preserved. Reload the
            current draft and review again. Nothing was automatically retried.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || stale || unsaved || !canWrite}
            onClick={() =>
              void run(async () => setValidation(await api.validateLibrary(saved.key)))
            }
          >
            Validate saved draft
          </Button>
          <Button
            variant="outline"
            disabled={busy || stale || unsaved}
            onClick={() => void run(preview)}
          >
            Review Changes
          </Button>
          <Button
            disabled={!canPublish || busy || stale || unsaved || !saved.dirty}
            onClick={() => void run(preview)}
          >
            Publish library…
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => (unsaved ? setReloading(true) : void run(refresh))}
          >
            Reload current draft
          </Button>
        </div>
        {busy && <p role="status">Working…</p>}
        {status && (
          <p role="status" className="text-sm text-success">
            {status}
          </p>
        )}
      </Card>
      {error !== null && <ErrorState error={error} />}
      {validation && <AffixValidation value={validation} />}
      <Card className="space-y-3 p-4">
        <h2 className="font-display text-lg">Draft metadata</h2>
        <fieldset className="space-y-3" disabled={!editable}>
          <label className="grid gap-1 text-sm">
            Display name
            <Input
              value={meta.name}
              onChange={(e) => {
                setMeta({ ...meta, name: e.target.value });
                clearReview();
              }}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Description
            <textarea
              className="w-full rounded border border-line bg-surface p-2 text-sm"
              value={meta.description}
              onChange={(e) => {
                setMeta({ ...meta, description: e.target.value });
                clearReview();
              }}
            />
          </label>
        </fieldset>
        <Button
          disabled={!editable || !metaDirty}
          onClick={() =>
            void run(async () => {
              adopt(await api.saveMeta(saved.key, meta, saved.draftRevision), 'meta');
              void api.invalidateEquipment(client);
              setStatus('Metadata saved to the draft. Local entry edits, if any, remain unsaved.');
            })
          }
        >
          Save metadata
        </Button>
      </Card>
      <Card className="space-y-4 p-4">
        <label className="grid max-w-sm gap-1 text-sm">
          Entries to inspect
          <select
            className={selectClass}
            value={view}
            disabled={busy}
            onChange={(e) => setView(e.target.value)}
          >
            <option value="draft">Draft entries</option>
            <option value="published">Published entries (read-only)</option>
          </select>
        </label>
        <p className="text-xs text-ink-subtle">
          Metadata above always shows the draft. Published metadata is included in exports and the
          change review.
        </p>
        <AffixEntries
          entries={view === 'draft' ? entries : saved.publishedEntries}
          editable={editable}
          add={() =>
            setEditing({ index: null, entry: { key: '', suffix: '', slots: [], enabled: true } })
          }
          edit={(index) => setEditing({ index, entry: structuredClone(entries[index]!) })}
          duplicate={(index) =>
            setEditing({ index: null, entry: { ...structuredClone(entries[index]!), key: '' } })
          }
          remove={setRemoving}
          change={(index) =>
            changeEntries(entries.map((e, i) => (i === index ? { ...e, enabled: !e.enabled } : e)))
          }
          move={(index, delta) => {
            const next = [...entries];
            [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
            changeEntries(next);
          }}
        />
        <Button
          disabled={!editable || !entriesDirty}
          onClick={() =>
            void run(async () => {
              adopt(await api.saveEntries(saved.key, entries, saved.draftRevision), 'entries');
              void api.invalidateEquipment(client);
              setStatus(
                'Entries saved to the draft in library order. Local metadata edits, if any, remain unsaved.',
              );
            })
          }
        >
          Save entries
        </Button>
      </Card>
      <Card className="space-y-3 p-4">
        <h2 className="font-display text-lg">JSON import and export</h2>
        <p className="text-sm text-ink-muted">
          Exports contain saved library metadata and affix entries, never player-owned equipment or
          unsaved local edits. Import modifies drafts only.
        </p>
        <div className="flex flex-wrap gap-2">
          {(['draft', 'published'] as const).map((kind) => (
            <Button
              key={kind}
              variant="outline"
              disabled={busy || (kind === 'published' && saved.publishedRevision === null)}
              onClick={() =>
                void run(async () =>
                  downloadJson(
                    `affix-library-${saved.key}-${kind}.json`,
                    await api.exportLibrary(saved.key, kind),
                  ),
                )
              }
            >
              Export {kind}
            </Button>
          ))}
          {canWrite && (
            <Button asChild variant="outline">
              <Link
                to={`/admin/equipment/affix-libraries/import?library=${encodeURIComponent(saved.key)}`}
              >
                Import into this library
              </Link>
            </Button>
          )}
        </div>
      </Card>
      <Card className="space-y-3 p-4">
        <h2 className="font-display text-lg">Published revision history</h2>
        {!history.length ? (
          <p className="text-sm">No published revisions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>Published</th>
                  <th>Actor</th>
                  <th>Entries</th>
                  <th>Origin</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr className="border-t border-line" key={r.revision}>
                    <td className="py-2">
                      {r.revision}
                      {r.current ? ' (current)' : ''}
                    </td>
                    <td>{new Date(r.publishedAt).toLocaleString()}</td>
                    <td>{r.publishedBy ?? 'Unknown'}</td>
                    <td>{r.entryCount}</td>
                    <td>
                      {r.rolledBackFrom === null
                        ? r.source
                        : `Rollback of revision ${r.rolledBackFrom}`}
                    </td>
                    <td>
                      {!r.current && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canPublish || busy || stale || unsaved}
                          onClick={() => {
                            setRollback(r);
                            setRollbackConfirmed(false);
                            setError(null);
                            setValidation(null);
                          }}
                        >
                          Roll back to revision {r.revision}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && canWrite && (
        <AffixEntryDialog
          initial={editing.entry}
          existing={editing.index !== null}
          close={() => setEditing(null)}
          apply={(entry) => {
            changeEntries(
              editing.index === null
                ? [...entries, entry]
                : entries.map((e, i) => (i === editing.index ? entry : e)),
            );
            setEditing(null);
          }}
        />
      )}
      {removing !== null && (
        <RulesDialog
          title="Remove draft entry?"
          description={`Remove ${entries[removing]?.key ?? 'this entry'} from your local draft. Nothing changes until you save and publish. Existing owned equipment keeps its suffix snapshot.`}
          close={() => setRemoving(null)}
        >
          <Button
            disabled={!editable}
            onClick={() => {
              changeEntries(entries.filter((_, i) => i !== removing));
              setRemoving(null);
            }}
          >
            Remove from local draft
          </Button>
        </RulesDialog>
      )}
      {reloading && (
        <RulesDialog
          title="Reload current library?"
          description="Reloading replaces unsaved metadata and entries with the current saved draft. Cancel to preserve local values."
          close={() => {
            if (!busy) setReloading(false);
          }}
        >
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await refresh();
                setReloading(false);
              })
            }
          >
            Discard local edits and reload
          </Button>
          {error !== null && <ErrorState error={error} />}
        </RulesDialog>
      )}
      {review && (
        <RulesDialog
          title="Review affix library publication"
          description="The server validates this saved draft against current namespaces and published rarity assignments. Review the changes before publishing."
          close={() => {
            if (!busy) setReview(null);
          }}
        >
          <AffixValidation value={review.validation} />
          <AffixDiff preview={review} />
          <SnapshotNotice />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!publishReady}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Publish draft revision {review.draftRevision} for future unpinned rolls.
          </label>
          <Button
            disabled={!publishReady || !confirmed}
            onClick={() =>
              void run(async () => {
                const next = await api.publishLibrary(saved.key, review.draftRevision);
                await afterPublication(next);
                setStatus('Library published. Existing owned equipment names are unchanged.');
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
          title={`Roll back library to revision ${rollback.revision}`}
          description="Rollback publishes a new library revision and replaces its saved draft. Current rarity assignments are revalidated and are not changed by this action."
          close={() => {
            if (!busy) setRollback(null);
          }}
        >
          <SnapshotNotice />
          <p className="text-sm">
            Future unpinned grants using this library receive the restored entries. Existing owned
            equipment names remain unchanged.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rollbackConfirmed}
              disabled={busy || stale}
              onChange={(e) => setRollbackConfirmed(e.target.checked)}
            />
            Restore library revision {rollback.revision} as a new publication.
          </label>
          <Button
            disabled={!canPublish || busy || stale || !rollbackConfirmed}
            onClick={() =>
              void run(async () => {
                const next = await api.rollbackLibrary(
                  saved.key,
                  rollback.revision,
                  saved.draftRevision,
                );
                setRollback(null);
                await afterPublication(next);
                setStatus(
                  'Rollback published as a new library revision. Rarity assignments are unchanged.',
                );
              })
            }
          >
            Confirm rollback
          </Button>
          {error !== null && <ErrorState error={error} />}
          {validation && <AffixValidation value={validation} />}
        </RulesDialog>
      )}
    </>
  );
}
