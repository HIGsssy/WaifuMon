import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '@/api/adminEquipmentAffixes';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  AffixIssues,
  AffixNavigation,
  AffixUnsavedGuard,
  AffixValidation,
  SnapshotNotice,
} from './affixLibraryParts';
import { affixIssues, importContents, isAffixStale } from './affixLibraryModel';

type Inspection = NonNullable<ReturnType<typeof importContents>>;
interface ImportReview {
  file: unknown;
  contents: Inspection;
  revision: number | undefined;
  legacy: boolean;
}
function FileContents({ contents }: { contents: Inspection }) {
  const [page, setPage] = useState(0);
  return (
    <div className="space-y-3 text-sm">
      <h2 className="font-display text-lg">File contents — local inspection</h2>
      <p>
        {contents.name} · {contents.key}
      </p>
      <p>{contents.description}</p>
      <p>{contents.affixes.length} entries in file order.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Key</th>
              <th>Suffix</th>
              <th>Slots</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {contents.affixes.slice(page * 25, page * 25 + 25).map((raw, i) => {
              const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
              return (
                <tr className="border-t border-line" key={i}>
                  <td className="py-2">
                    {typeof e.key === 'string' ? e.key : 'Invalid / missing key'}
                  </td>
                  <td>{typeof e.suffix === 'string' ? e.suffix : 'Invalid / missing suffix'}</td>
                  <td>
                    {Array.isArray(e.slots)
                      ? e.slots.map(String).join(', ')
                      : 'Invalid / missing slots'}
                  </td>
                  <td>
                    {typeof e.enabled === 'boolean'
                      ? String(e.enabled)
                      : 'Invalid / missing status'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {contents.affixes.length > 25 && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={!page} onClick={() => setPage(page - 1)}>
            Previous file entries
          </Button>
          <span>Page {page + 1}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={(page + 1) * 25 >= contents.affixes.length}
            onClick={() => setPage(page + 1)}
          >
            Next file entries
          </Button>
        </div>
      )}
    </div>
  );
}

export function AffixLibraryImportPage() {
  const canRead = useHasPermission('equipment.read');
  const canWrite = useHasPermission('equipment.write');
  const client = useQueryClient();
  const [params] = useSearchParams();
  const expectedKey = params.get('library');
  const query = useQuery({
    queryKey: api.AFFIX_QUERY_KEY,
    queryFn: ({ signal }) => api.listLibraries(signal),
    enabled: canRead && canWrite,
    refetchOnWindowFocus: false,
  });
  const [text, setText] = useState('');
  const [review, setReview] = useState<ImportReview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [result, setResult] = useState<api.ManagedLibrary | null>(null);
  const [validation, setValidation] = useState<api.LibraryValidation | null>(null);
  function change(next: string) {
    setText(next);
    setReview(null);
    setConfirmed(false);
    setStale(false);
    setError(null);
    setResult(null);
    setValidation(null);
  }
  function inspect(list: api.LibraryList | undefined = query.data) {
    setError(null);
    setConfirmed(false);
    setReview(null);
    try {
      if (!list) throw new Error('Load the destination libraries before reviewing this file.');
      const file: unknown = JSON.parse(text);
      const contents = importContents(file);
      if (!contents)
        throw new Error(
          'The file must contain library key/name metadata and an affixes array. The backend validates the complete package on import.',
        );
      if (expectedKey && contents.key !== expectedKey)
        throw new Error(
          `This import is for ${expectedKey}, but the file names ${contents.key}. Use the catalogue import page for a different library.`,
        );
      const existing = list.managed.find((l) => l.key === contents.key);
      setReview({
        file,
        contents,
        revision: existing?.draftRevision,
        legacy:
          contents.key === 'legacy' ||
          contents.key.startsWith('legacy_') ||
          list.legacy.some((l) => l.key === contents.key),
      });
    } catch (err) {
      setError(err);
    }
  }
  async function apply() {
    if (!review || lock.current || !confirmed || stale || review.legacy) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setConfirmed(false);
    try {
      const next = await api.importLibrary(review.file, review.revision);
      setResult(next);
      setReview(null);
      await api.invalidateEquipment(client);
      setValidation(await api.validateLibrary(next.key));
    } catch (err) {
      setError(err);
      if (isAffixStale(err)) setStale(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <PageHeader
        title="Import Affix Library"
        description="Import a library JSON file into an unpublished draft. This never changes the active published revision."
      />
      <AffixNavigation />
      {!canRead || !canWrite ? (
        <p role="alert">
          Importing here requires equipment.read and equipment.write. Publish permission does not
          grant either.
        </p>
      ) : (
        <>
          <AffixUnsavedGuard
            when={(!result && !!text) || busy || fileLoading}
            busy={busy || fileLoading}
          />
          <SnapshotNotice />
          <Card className="space-y-3 p-4">
            <p className="text-sm">
              Use a waifumon-equipment-affix-library JSON export. There is no server pre-import
              preview endpoint: file inspection below only displays your file. The backend validates
              the package when importing; publication is separate.
            </p>
            <label className="grid gap-1 text-sm">
              Upload library JSON
              <input
                type="file"
                accept="application/json,.json"
                disabled={busy || fileLoading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  change('');
                  if (file.size > 900000) {
                    setError(new Error('Choose a JSON file smaller than 900 KB.'));
                    return;
                  }
                  setFileLoading(true);
                  void file
                    .text()
                    .then(change)
                    .catch(setError)
                    .finally(() => setFileLoading(false));
                }}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Library JSON
              <textarea
                className="min-h-40 w-full rounded border border-line bg-surface p-2 font-mono text-xs"
                value={text}
                disabled={busy || fileLoading}
                onChange={(e) => change(e.target.value)}
              />
            </label>
            <Button
              variant="outline"
              disabled={busy || fileLoading || !text.trim() || !query.data || stale || !!result}
              onClick={() => inspect()}
            >
              Inspect file contents
            </Button>
            {query.isError && (
              <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            )}
            {query.isPending && <p role="status">Loading destination revisions…</p>}
            {error !== null && (
              <>
                <ErrorState error={error} />
                <AffixIssues issues={affixIssues(error)} />
              </>
            )}
            {stale && (
              <div className="space-y-2 text-sm text-danger" role="alert">
                <p>
                  The destination draft changed. Your file is preserved. Reload its revision,
                  inspect again and explicitly confirm. No automatic retry was made.
                </p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void query
                      .refetch({ throwOnError: true })
                      .then((next) => {
                        setStale(false);
                        inspect(next.data);
                      })
                      .catch(setError)
                      .finally(() => setBusy(false));
                  }}
                >
                  Reload destination revision
                </Button>
              </div>
            )}
          </Card>
          {review && (
            <Card className="space-y-4 p-4">
              <FileContents key={text} contents={review.contents} />
              {review.legacy ? (
                <p role="alert" className="text-danger">
                  Shipped N/R/SR libraries are read-only. Import cannot replace a legacy library.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    {review.revision === undefined
                      ? 'This key was not in the loaded catalogue. The backend will atomically create the library and import its draft; a rejected import creates nothing.'
                      : `This replaces the existing saved draft at revision ${review.revision}. Its published revision stays unchanged.`}
                  </p>
                  <p className="text-sm text-ink-muted">
                    The backend checks the complete schema, keys, suffixes and namespace on
                    submission. This inspection is not a validation result.
                  </p>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={busy || stale}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    {review.revision === undefined
                      ? 'Create this library draft from the imported contents. Do not publish.'
                      : `Replace draft revision ${review.revision} with these imported contents. Do not publish.`}
                  </label>
                  <Button disabled={!confirmed || busy || stale} onClick={() => void apply()}>
                    {busy ? 'Importing…' : 'Import to draft only'}
                  </Button>
                </>
              )}
            </Card>
          )}
          {result && (
            <Card className="space-y-3 p-4">
              <h2 className="font-display text-lg">
                Imported to draft revision {result.draftRevision}
              </h2>
              <p className="text-sm">
                {result.name} · {result.draftEntryCount} entries ·{' '}
                {result.publishedRevision === null
                  ? 'still unpublished'
                  : `published revision ${result.publishedRevision} unchanged`}
              </p>
              {validation ? (
                <AffixValidation value={validation} />
              ) : (
                <p className="text-sm">
                  {busy
                    ? 'Validating the imported draft…'
                    : 'The draft was imported. Validation could not finish; run it again from the editor.'}
                </p>
              )}
              <Button asChild variant="outline">
                <Link to={api.libraryPath(result.key)}>Open library editor</Link>
              </Button>
              <p className="text-sm text-ink-muted">
                Review the saved draft and publish separately if appropriate.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
