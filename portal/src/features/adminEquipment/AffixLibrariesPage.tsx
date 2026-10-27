import { useRef, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '@/api/adminEquipmentAffixes';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import {
  AffixIssues,
  AffixNavigation,
  AffixUnsavedGuard,
  SnapshotNotice,
} from './affixLibraryParts';
import { affixIssues } from './affixLibraryModel';

export function AffixLibrariesPage() {
  const canRead = useHasPermission('equipment.read');
  const canWrite = useHasPermission('equipment.write');
  const query = useQuery({
    queryKey: api.AFFIX_QUERY_KEY,
    queryFn: ({ signal }) => api.listLibraries(signal),
    enabled: canRead,
  });
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('all');
  const [publication, setPublication] = useState('all');
  const [assignment, setAssignment] = useState('all');
  const rows = query.data
    ? [...query.data.managed.map((l) => ({ ...l, entries: undefined })), ...query.data.legacy]
    : [];
  const filtered = rows.filter((l) => {
    const published = l.readOnly || l.publishedRevision !== null;
    const assignments = l.readOnly ? [] : l.assignedTo;
    return (
      `${l.key} ${l.name} ${l.description}`.toLowerCase().includes(search.toLowerCase()) &&
      (source === 'all' || (source === 'legacy') === l.readOnly) &&
      (publication === 'all' || (publication === 'published') === published) &&
      (assignment === 'all' ||
        (assignment === 'assigned'
          ? assignments.length > 0
          : assignment === 'unassigned'
            ? !assignments.length
            : assignments.includes(assignment as 'SSR' | 'UR' | 'LR')))
    );
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Affix Libraries"
        description="Manage naming libraries for high-rarity equipment. Shipped N/R/SR affixes remain read-only."
        actions={
          canRead &&
          canWrite && (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" disabled={!canWrite}>
                <Link
                  to="/admin/equipment/affix-libraries/import"
                  aria-disabled={!canWrite}
                  onClick={(e) => {
                    if (!canWrite) e.preventDefault();
                  }}
                >
                  Import library JSON
                </Link>
              </Button>
              <Button asChild disabled={!canWrite}>
                <Link
                  to="/admin/equipment/affix-libraries/new"
                  aria-disabled={!canWrite}
                  onClick={(e) => {
                    if (!canWrite) e.preventDefault();
                  }}
                >
                  New Affix Library
                </Link>
              </Button>
            </div>
          )
        }
      />
      <AffixNavigation />
      {!canRead ? (
        <p role="alert">
          equipment.read is required to inspect affix libraries. Write and publish permissions do
          not grant read access.
        </p>
      ) : (
        <>
          <SnapshotNotice />
          {!canWrite && (
            <p className="text-sm text-ink-muted">
              Read-only access. Creating, importing and editing drafts require equipment.write.
            </p>
          )}
          <Card className="space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="grid gap-1 text-sm">
                Search libraries
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Name, key or description"
                />
              </label>
              <label className="grid gap-1 text-sm">
                Library source
                <select
                  className={selectClass}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="all">Managed and legacy</option>
                  <option value="managed">Managed only</option>
                  <option value="legacy">Legacy only</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Publication status
                <select
                  className={selectClass}
                  value={publication}
                  onChange={(e) => setPublication(e.target.value)}
                >
                  <option value="all">All statuses</option>
                  <option value="published">Published or shipped</option>
                  <option value="unpublished">Unpublished</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Rarity assignment
                <select
                  className={selectClass}
                  value={assignment}
                  onChange={(e) => setAssignment(e.target.value)}
                >
                  <option value="all">All assignments</option>
                  <option value="assigned">Assigned to a high rarity</option>
                  <option value="unassigned">No high-rarity assignment</option>
                  {['SSR', 'UR', 'LR'].map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
            </div>
            {query.isError ? (
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : query.isPending ? (
              <Skeleton className="h-32" />
            ) : !filtered.length ? (
              <p>
                {rows.length
                  ? 'No libraries match these filters.'
                  : 'No affix libraries are available.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>Library</th>
                      <th>Source</th>
                      <th>Draft / Published</th>
                      <th>Entries</th>
                      <th>Used by (published rules)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((l) => (
                      <tr key={l.key} className="border-t border-line">
                        <td className="py-3 pr-4">
                          <Link className="text-accent underline" to={api.libraryPath(l.key)}>
                            {l.name}
                          </Link>
                          <p className="font-mono text-xs">{l.key}</p>
                          <p className="max-w-sm text-xs text-ink-muted">{l.description}</p>
                        </td>
                        <td className="pr-4">
                          {l.readOnly ? `Legacy ${l.rarity} · read-only` : 'Managed'}
                        </td>
                        <td className="pr-4">
                          {l.readOnly ? (
                            'Shipped · not revisioned'
                          ) : (
                            <>
                              <p>
                                Draft {l.draftRevision}
                                {l.dirty ? ' · unpublished changes' : ' · matches published'}
                              </p>
                              <p>
                                {l.publishedRevision === null
                                  ? 'Unpublished'
                                  : `Published revision ${l.publishedRevision}`}
                              </p>
                            </>
                          )}
                        </td>
                        <td className="pr-4">
                          {l.readOnly
                            ? l.entries.length
                            : `${l.draftEntryCount} draft / ${l.publishedEntryCount} published`}
                        </td>
                        <td>
                          {l.readOnly ? 'Original legacy pools' : l.assignedTo.join(', ') || 'None'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {query.data && !query.data.managed.length && (
              <p className="text-sm text-ink-muted">
                No managed libraries yet. Create or import one to prepare a draft; it will not be
                assigned automatically.
              </p>
            )}
            <p className="text-xs text-ink-subtle">
              Modification time and editor are available inside each managed library.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

export function AffixLibraryCreatePage() {
  const canRead = useHasPermission('equipment.read');
  const canWrite = useHasPermission('equipment.write');
  const client = useQueryClient();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<string | null>(null);
  const submitting = useRef(false);
  if (created) return <Navigate replace to={api.libraryPath(created)} />;
  return (
    <div className="space-y-4">
      <PageHeader
        title="New Affix Library"
        description="Create an empty unpublished library. Nothing is created until you submit this form."
      />
      <AffixNavigation />
      {!canRead || !canWrite ? (
        <p role="alert">
          Creating a library here requires equipment.read and equipment.write. Permissions are
          independent.
        </p>
      ) : (
        <Card className="p-4">
          <AffixUnsavedGuard when={!!(key || name || description) || busy} busy={busy} />
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (submitting.current) return;
              submitting.current = true;
              setBusy(true);
              setError(null);
              void api
                .createLibrary({ key, name, description })
                .then((l) => {
                  void api.invalidateEquipment(client);
                  setCreated(l.key);
                })
                .catch(setError)
                .finally(() => {
                  submitting.current = false;
                  setBusy(false);
                });
            }}
          >
            <fieldset className="space-y-3" disabled={busy}>
              <label className="grid gap-1 text-sm">
                Library key
                <Input
                  required
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="lowercase_snake_case"
                />
              </label>
              <p className="text-xs text-ink-muted">
                Permanent library identifier. The legacy namespace is reserved for shipped
                libraries. The backend validates this key.
              </p>
              <label className="grid gap-1 text-sm">
                Display name
                <Input required value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="grid gap-1 text-sm">
                Description
                <textarea
                  className="w-full rounded border border-line bg-surface p-2 text-sm"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
            </fieldset>
            {error !== null && (
              <>
                <ErrorState error={error} />
                <AffixIssues issues={affixIssues(error)} />
              </>
            )}
            <Button disabled={busy} type="submit">
              {busy ? 'Creating…' : 'Create unpublished library'}
            </Button>
            <p className="text-sm text-ink-muted">
              Creation never assigns or publishes this library. Assignments are managed in Rarity
              Rules after library publication.
            </p>
          </form>
        </Card>
      )}
    </div>
  );
}
