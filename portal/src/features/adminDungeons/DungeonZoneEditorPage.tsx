/** Dungeon draft management and room map editor. */
import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { Link, useParams, useBlocker, UNSAFE_DataRouterContext } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AssetPickerDialog } from '@/features/adminArtwork/AssetPickerDialog';
import { ZoneArtworkField } from './ZoneArtworkField';
import { DungeonIssues, errorIssues } from './zoneFormParts';
import { DungeonGraphView } from './DungeonGraphView';
import { DungeonImportHistory } from './DungeonImportHistory';
import { DungeonEditorHeader, type DungeonEditorView } from './DungeonEditorHeader';
import { useViewportFill } from './useViewportFill';

function downloadPackage(
  pkg: api.DungeonPackage,
  origin: 'draft' | 'published' | { revision: number },
) {
  const label = typeof origin === 'string' ? origin : `published-r${origin.revision}`;
  const filename = `${pkg.dungeon.key}.${label}.dungeon.json`;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return filename;
}
export function DungeonZoneEditorPage() {
  const { key = '' } = useParams();
  const query = useQuery({
    queryKey: [...api.DUNGEONS_QUERY_KEY, 'definition', key],
    queryFn: ({ signal }) => api.getDungeon(key, signal),
  });
  return (
    <div className="space-y-4">
      {!query.data && <Link to="/admin/dungeons">Back to dungeons</Link>}
      {query.isPending && <p>Loading dungeon…</p>}
      {query.isError && (
        <ErrorState
          title={
            isPortalApiError(query.error) && query.error.isNotFound
              ? 'Dungeon not found'
              : 'Could not load dungeon'
          }
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && <Management key={key} initial={query.data} />}
    </div>
  );
}
function Management({ initial }: { initial: api.DungeonDetail }) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const client = useQueryClient();
  const canWrite = useHasPermission('dungeons.write');
  const canPublish = useHasPermission('dungeons.publish');
  const [loaded, setLoaded] = useState(initial);
  const [draft, setDraft] = useState(initial.draft);
  const [layout, setLayout] = useState(initial.layout);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [viewRevision, setViewRevision] = useState<number | null>(null);
  const [view, setView] = useState<DungeonEditorView>('map');
  const [problemsRequest, setProblemsRequest] = useState(0);
  const workspace = useViewportFill<HTMLDivElement>();
  const [validation, setValidation] = useState<{
    signature: string;
    report: api.DungeonValidation;
  } | null>(null);
  const gameplayDirty = JSON.stringify(draft) !== JSON.stringify(loaded.draft);
  const dirty = gameplayDirty || JSON.stringify(layout) !== JSON.stringify(loaded.layout);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const navigate = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.('a[href]');
      if (anchor && !window.confirm('Discard unsaved dungeon edits and leave this page?')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    if (!dataRouter) document.addEventListener('click', navigate, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', navigate, true);
    };
  }, [dirty, dataRouter]);
  const prefix = [...api.DUNGEONS_QUERY_KEY, 'definition', loaded.key];
  const reference = useQuery({
    queryKey: [...api.DUNGEONS_QUERY_KEY, 'reference'],
    queryFn: ({ signal }) => api.getDungeonReference(signal),
  });
  const revisions = useQuery({
    queryKey: [...prefix, 'revisions'],
    queryFn: ({ signal }) => api.listDungeonRevisions(loaded.key, signal),
  });
  const history = useQuery({
    queryKey: [...prefix, 'history'],
    queryFn: ({ signal }) => api.getDungeonHistory(loaded.key, signal),
  });
  const revision = useQuery({
    queryKey: [...prefix, 'revision', viewRevision],
    enabled: viewRevision !== null,
    queryFn: ({ signal }) => api.getDungeonRevision(loaded.key, viewRevision!, signal),
  });
  const refresh = () => void client.invalidateQueries({ queryKey: api.DUNGEONS_QUERY_KEY });
  const accept = (d: api.DungeonDetail, message: string) => {
    setLoaded(d);
    setDraft(d.draft);
    setLayout(d.layout);
    setValidation(null);
    setConflict(false);
    setNotice(message);
    client.setQueryData(prefix, d);
    refresh();
  };
  const failed = (error: unknown) => {
    setNotice('');
    if (isPortalApiError(error) && error.status === 409) setConflict(true);
  };
  const save = useMutation({
    mutationFn: () =>
      api.saveDungeonDraft(loaded.key, {
        definition: draft,
        layout,
        expectedRevision: loaded.draftRevision,
      }),
    onSuccess: (d) => accept(d, 'Draft saved. Publication is unchanged.'),
    onError: failed,
  });
  const validate = useMutation({
    mutationFn: (definition: api.DungeonDefinition) => api.validateDungeon(definition),
    onSuccess: (report, definition) =>
      setValidation({ signature: JSON.stringify(definition), report }),
    onError: failed,
  });
  const publish = useMutation({
    mutationFn: () => api.publishDungeon(loaded.key, loaded.draftRevision),
    onSuccess: (r) =>
      accept(
        r.dungeon,
        r.unchanged ? 'Draft already published.' : `Published revision ${r.revision.number}.`,
      ),
    onError: failed,
  });
  const rollback = useMutation({
    mutationFn: (number: number) => api.rollbackDungeon(loaded.key, number),
    onSuccess: (r) => {
      setRollbackTarget(null);
      accept(r.dungeon, `Published pointer moved to revision ${r.revision.number}.`);
    },
    onError: failed,
  });
  const reload = useMutation({
    mutationFn: () => api.getDungeon(loaded.key),
    onSuccess: (d) => {
      save.reset();
      publish.reset();
      rollback.reset();
      accept(d, 'Latest draft loaded.');
    },
  });
  const exporting = useMutation({
    mutationFn: (origin: 'draft' | 'published' | { revision: number }) =>
      api.exportDungeonPackage(loaded.key, origin),
    onSuccess: (pkg, origin) => {
      const filename = downloadPackage(pkg, origin);
      setNotice(`Download started: ${filename}`);
      refresh();
    },
  });
  const busy = save.isPending || publish.isPending || rollback.isPending || reload.isPending;
  const report = validation?.signature === JSON.stringify(draft) ? validation.report : null;
  const issues = report?.issues ?? (gameplayDirty ? [] : loaded.issues);
  useEffect(() => {
    if (!gameplayDirty || conflict) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api
        .validateDungeon(draft, controller.signal)
        .then((report) => setValidation({ signature: JSON.stringify(draft), report }))
        .catch((error) => {
          if (!controller.signal.aborted)
            setNotice(
              `Validation failed: ${error instanceof Error ? error.message : 'Request failed'}`,
            );
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft, gameplayDirty, conflict]);
  const errors = [
    save.error,
    publish.error,
    rollback.error,
    validate.error,
    reload.error,
    exporting.error,
  ].filter(Boolean);
  const patch = (p: Partial<api.DungeonDefinition>) => {
    setDraft({ ...draft, ...p });
    setNotice('');
  };
  const settings = (
    <div className="space-y-5">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Dungeon settings</h2>
        <p className="text-sm text-ink-muted">
          Progression currency: {draft.settings.progressionCurrency ?? 'None'} · Defeat retention:{' '}
          {draft.settings.defeatCurrencyRetentionBasisPoints / 100}% · {draft.flags.length} flags
        </p>
        <label className="block">
          Name
          <Input
            aria-label="Dungeon name"
            maxLength={100}
            value={draft.name}
            disabled={!canWrite || busy || conflict}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </label>
        <label className="block">
          Description
          <textarea
            aria-label="Dungeon description"
            maxLength={1000}
            className="w-full rounded border p-2"
            value={draft.description}
            disabled={!canWrite || busy || conflict}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </label>
        {reference.isError && (
          <ErrorState
            title="Could not load authoring references"
            error={reference.error}
            onRetry={() => void reference.refetch()}
          />
        )}
        <fieldset disabled={!canWrite || busy || conflict}>
          <legend>Available regions</legend>
          {reference.data?.regions.map((r) => (
            <label key={r.id} className="mr-4">
              <input
                type="checkbox"
                checked={draft.availableRegions.includes(r.id)}
                disabled={!r.enabled && !draft.availableRegions.includes(r.id)}
                onChange={(e) =>
                  patch({
                    availableRegions: e.target.checked
                      ? [...draft.availableRegions, r.id]
                      : draft.availableRegions.filter((id) => id !== r.id),
                  })
                }
              />{' '}
              {r.name}
              {!r.enabled && ' (disabled)'}
            </label>
          ))}
        </fieldset>
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Artwork</h2>
        <ArtworkField
          label="Artwork"
          field="artwork"
          draft={draft}
          disabled={!canWrite || busy || conflict}
          onChange={(ref) => patch({ artwork: ref })}
        />
        <ArtworkField
          label="Background artwork"
          field="background"
          draft={draft}
          disabled={!canWrite || busy || conflict}
          onChange={(ref) => patch({ background: ref })}
        />
      </section>
    </div>
  );
  return (
    <div
      ref={workspace.ref}
      style={{ '--dungeon-workspace-height': `${workspace.height ?? 640}px` } as CSSProperties}
      className="flex flex-col gap-3 lg:-mx-6 lg:h-(--dungeon-workspace-height)"
      data-testid="dungeon-workspace"
    >
      {dataRouter && <UnsavedNavigationGuard dirty={dirty} />}
      <DungeonEditorHeader
        name={loaded.name}
        dungeonKey={loaded.key}
        enabled={loaded.enabled}
        draftRevision={loaded.draftRevision}
        publishedRevision={loaded.published?.number ?? null}
        dirty={dirty}
        validationPending={gameplayDirty && !report}
        notice={notice}
        errorCount={issues.filter((i) => i.severity === 'error').length}
        warningCount={issues.filter((i) => i.severity !== 'error').length}
        canWrite={canWrite}
        canPublish={canPublish}
        saveDisabled={!dirty || !draft.name.trim() || busy || conflict}
        publishDisabled={dirty || busy || conflict || issues.some((i) => i.severity === 'error')}
        validateDisabled={busy || validate.isPending || conflict}
        view={view}
        onSave={() => save.mutate()}
        onPublish={() => publish.mutate()}
        onValidate={() => validate.mutate(draft)}
        onShowProblems={() => {
          setView('map');
          setProblemsRequest((n) => n + 1);
        }}
        onViewChange={setView}
      />
      {(conflict || errors.length > 0) && (
        <div className="max-h-48 shrink-0 space-y-2 overflow-y-auto">
          {conflict && (
            <Card className="space-y-2 p-4">
              <p role="alert">
                A newer draft exists. Your edits are preserved; saving and publishing are blocked
                until you reload.
              </p>
              <Button disabled={busy} onClick={() => reload.mutate()}>
                Reload latest draft (discard local edits)
              </Button>
            </Card>
          )}
          {errors.map((error, n) => (
            <div key={n}>
              <ErrorState title="Dungeon request failed" error={error} />
              <DungeonIssues issues={errorIssues(error)} />
            </div>
          ))}
        </div>
      )}
      {/* Kept mounted behind the secondary view so selection and the canvas survive a visit. */}
      <div hidden={view !== 'map'} className="min-h-0 lg:flex-1">
        <DungeonGraphView
          reference={reference.data}
          definition={draft}
          layout={layout}
          issues={issues}
          disabled={!canWrite || busy || conflict}
          settings={settings}
          problemsRequest={problemsRequest}
          onChange={(definition, nextLayout) => {
            setDraft(definition);
            setLayout(nextLayout);
            setNotice('');
          }}
        />
      </div>
      {view === 'manage' && (
        <div
          role="region"
          aria-label="History and export"
          className="min-h-0 space-y-4 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain"
        >
          <Card className="space-y-3 p-4">
            <h2>Export</h2>
            {dirty && <p>Save your draft changes before exporting the draft or rolling back.</p>}
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={exporting.isPending || dirty}
                onClick={() => exporting.mutate('draft')}
              >
                Export saved draft
              </Button>
              {loaded.published && (
                <Button
                  variant="outline"
                  disabled={exporting.isPending}
                  onClick={() => exporting.mutate('published')}
                >
                  Export current published package
                </Button>
              )}
            </div>
          </Card>
          <Card className="space-y-2 p-4">
            <h2>Published revisions</h2>
            {revisions.isPending && <p>Loading revisions…</p>}
            {revisions.isError && (
              <ErrorState
                title="Could not load revisions"
                error={revisions.error}
                onRetry={() => void revisions.refetch()}
              />
            )}
            {revisions.data?.revisions.length === 0 && <p>No published revisions.</p>}
            {revisions.data?.revisions.map((r) => (
              <div key={r.number} className="flex flex-wrap items-center gap-2">
                <span>
                  Revision {r.number}
                  {r.current ? ' (current)' : ''} · {r.activeRuns} active runs
                </span>
                <Button variant="outline" onClick={() => setViewRevision(r.number)}>
                  View revision {r.number}
                </Button>
                <Button
                  variant="outline"
                  disabled={exporting.isPending}
                  onClick={() => exporting.mutate({ revision: r.number })}
                >
                  Export revision {r.number}
                </Button>
                {canPublish && !r.current && (
                  <Button
                    disabled={busy || dirty || conflict}
                    onClick={() => setRollbackTarget(r.number)}
                  >
                    Roll back to revision {r.number}
                  </Button>
                )}
              </div>
            ))}
            {revision.isPending && viewRevision !== null && <p>Loading revision…</p>}
            {revision.isError && (
              <ErrorState title="Could not load revision" error={revision.error} />
            )}
            {revision.data && (
              <details open>
                <summary>Revision {revision.data.number} content and layout</summary>
                <pre className="max-h-80 overflow-auto text-xs">
                  {JSON.stringify(
                    { content: revision.data.content, layout: revision.data.layout },
                    null,
                    2,
                  )}
                </pre>
              </details>
            )}
          </Card>
          <DungeonImportHistory dungeonKey={loaded.key} />
          <Card className="space-y-2 p-4">
            <h2>Content history</h2>
            {history.isPending && <p>Loading history…</p>}
            {history.isError && (
              <ErrorState
                title="Could not load history"
                error={history.error}
                onRetry={() => void history.refetch()}
              />
            )}
            {history.data?.events.length === 0 && <p>No history yet.</p>}
            <ul>
              {history.data?.events.map((e) => (
                <li key={e.id}>
                  {new Date(e.createdAt).toLocaleString()} · {e.action} · {e.actor ?? 'system'}
                  <details>
                    <summary>Details</summary>
                    <pre className="overflow-auto text-xs">
                      {JSON.stringify(e.details, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
      <Dialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open && !rollback.isPending) setRollbackTarget(null);
        }}
      >
        <DialogContent>
          <Card className="space-y-3 p-6">
            <DialogTitle>
              Roll back {loaded.name} to revision {rollbackTarget}?
            </DialogTitle>
            <DialogDescription>
              New runs will use revision {rollbackTarget}. Existing runs and the draft remain
              unchanged.
            </DialogDescription>
            <Button
              disabled={busy}
              onClick={() => rollbackTarget !== null && rollback.mutate(rollbackTarget)}
            >
              Confirm rollback to revision {rollbackTarget}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setRollbackTarget(null)}>
              Cancel
            </Button>
          </Card>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function UnsavedNavigationGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm('Discard unsaved dungeon edits and leave this page?')) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  return null;
}
function ArtworkField({
  label,
  field,
  draft,
  disabled,
  onChange,
}: {
  label: string;
  field: 'artwork' | 'background';
  draft: api.DungeonDefinition;
  disabled: boolean;
  onChange: (ref: api.DungeonArtworkRef | null) => void;
}) {
  const [picker, setPicker] = useState(false);
  const canBrowse = useHasPermission('artwork.read');
  const value = draft[field];
  return (
    <div className="space-y-2">
      <ZoneArtworkField
        label={label}
        testId={`dungeon-${field}`}
        value={value?.kind === 'shipped' ? value.path : null}
        expectedPath={
          field === 'artwork'
            ? api.zoneArtworkConvention(draft.key)
            : api.zoneBackgroundConvention(draft.key)
        }
        disabled={disabled}
        onChange={(path) => onChange(path ? { kind: 'shipped', path } : null)}
      />
      {value?.kind === 'managed' && (
        <p>
          {label}: {value.name ?? value.category} · {value.contentHash}
          <Button disabled={disabled} variant="ghost" onClick={() => onChange(null)}>
            Clear uploaded {label.toLowerCase()}
          </Button>
        </p>
      )}
      {!disabled && canBrowse && (
        <Button variant="outline" onClick={() => setPicker(true)}>
          Choose uploaded {label.toLowerCase()}
        </Button>
      )}
      {canBrowse && (
        <Link className="block text-sm underline" to="/admin/artwork">
          Manage uploaded artwork
        </Link>
      )}
      <AssetPickerDialog
        open={picker}
        title={`Choose ${label.toLowerCase()}`}
        category={field === 'artwork' ? 'dungeon_zone' : 'dungeon_background'}
        selectedId={null}
        onClose={() => setPicker(false)}
        onSelect={(asset) =>
          onChange({
            kind: 'managed',
            category: asset.category,
            contentHash: asset.contentHash,
            name: asset.name,
          })
        }
      />
    </div>
  );
}
