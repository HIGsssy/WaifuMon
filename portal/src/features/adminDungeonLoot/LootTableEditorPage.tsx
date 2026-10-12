/**
 * The Dungeon Loot Table editor: one reusable table of guaranteed rewards,
 * chance drops and random picks, written in sentences.
 *
 * Saving changes the catalogue only. A dungeon already published keeps the
 * loot it was published with until someone publishes it again, and this page
 * never publishes anything.
 */
import { useContext, useEffect, useState } from 'react';
import { Link, UNSAFE_DataRouterContext, useBlocker, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DUNGEON_LOOT_TABLES_QUERY_KEY,
  createDungeonLootTable,
  getDungeonLootTable,
  getDungeonLootTableHistory,
  getDungeonLootTableUsage,
  testRollDungeonLootTable,
  updateDungeonLootTable,
  validateDungeonLootTable,
  type DungeonLootTable,
  type DungeonLootTableBody,
  type DungeonLootTableConflict,
} from '@/api/adminDungeonLootTables';
import { DUNGEONS_QUERY_KEY, getDungeonReference } from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { keyFromName } from '@/features/adminDungeons/dungeonModel';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { formatDateTime } from '@/lib/format';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { LootOdds } from './LootOdds';
import { ChanceSection, GuaranteedSection, PoolsSection, type SectionTools } from './LootSections';
import { ArchiveDialog, DeleteDialog, DuplicateDialog } from './LootTableActions';
import { dungeonUses, invalidateLootTables, republishNote } from './lootUsage';
import { TestRollDialog } from './TestRollDialog';
import {
  LOOT_TIERS,
  TIER_LABELS,
  bodyOf,
  describeGrant,
  emptyForm,
  formOf,
  formatChance,
  friendlyLootIssues,
  rewardNames,
  shareFractions,
  type FormProblem,
  type LootForm,
  type LootTier,
  type RewardNames,
} from './lootModel';

/** How long the table must sit still before its odds and problems are asked for again. */
export const PREVIEW_DELAY_MS = 400;
const LIST = '/admin/dungeons/loot';
const KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const DISCARD = 'Discard unsaved loot table changes and leave this page?';
const textareaClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

export function LootTableEditorPage() {
  const { key } = useParams();
  if (!key) return <Editor key="new" initial={null} />;
  return <Existing tableKey={key} />;
}

/**
 * How the editor behaves inside another page (the dungeon editor's side sheet):
 * it never navigates, leaves page-level guards to its host, and reports its
 * own unsaved state so the host can protect it.
 */
export interface EmbeddedLootEditor {
  onDirtyChange: (dirty: boolean) => void;
}
/** One existing table's editor, for a page or a host panel. */
export function LootTableEditor({
  tableKey,
  embedded,
}: {
  tableKey: string;
  embedded?: EmbeddedLootEditor;
}) {
  return <Existing tableKey={tableKey} {...(embedded ? { embedded } : {})} />;
}

function Existing({ tableKey, embedded }: { tableKey: string; embedded?: EmbeddedLootEditor }) {
  const query = useQuery({
    queryKey: [...DUNGEON_LOOT_TABLES_QUERY_KEY, 'table', tableKey],
    queryFn: ({ signal }) => getDungeonLootTable(tableKey, signal),
  });
  if (query.data)
    return <Editor key={tableKey} initial={query.data} {...(embedded ? { embedded } : {})} />;
  return (
    <div className="space-y-4">
      {!embedded && <Link to={LIST}>Back to loot tables</Link>}
      {query.isPending && <Skeleton className="h-64 w-full" />}
      {query.isError && (
        <ErrorState
          title={
            isPortalApiError(query.error) && query.error.isNotFound
              ? 'Loot table not found'
              : 'Could not load the loot table'
          }
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
    </div>
  );
}

function UnsavedNavigationGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm(DISCARD)) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  return null;
}

/** A saved table read back as sentences, for comparing someone else's version. */
function TableSummary({ table, names }: { table: DungeonLootTable; names: RewardNames }) {
  const form = formOf(table);
  const empty = !form.guaranteed.length && !form.chances.length && !form.pools.length;
  return (
    <div className="space-y-2 text-sm text-ink" data-testid="table-summary">
      <p>
        <span className="font-medium">{table.name}</span>
        {table.tier && <span className="text-ink-muted"> · {TIER_LABELS[table.tier]}</span>}
      </p>
      {table.description && <p className="text-ink-muted">{table.description}</p>}
      {empty && <p className="text-ink-muted">Gives nothing yet.</p>}
      {form.guaranteed.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase text-ink-muted">Every time</p>
          <ul>
            {form.guaranteed.map((row) => (
              <li key={row.id}>{describeGrant(row.grant, names)}</li>
            ))}
          </ul>
        </div>
      )}
      {form.chances.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase text-ink-muted">Chance drops</p>
          <ul>
            {form.chances.map((row) => (
              <li key={row.id}>
                {row.percent}% chance: {describeGrant(row.grant, names)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {form.pools.map((pool) => {
        const fractions = shareFractions(pool.entries);
        return (
          <div key={pool.id}>
            <p className="text-xs font-semibold uppercase text-ink-muted">
              {pool.name} · {pool.picks} {pool.picks === '1' ? 'pick' : 'picks'}
            </p>
            <ul>
              {pool.entries.map((row, index) => (
                <li key={row.id}>
                  {'grant' in row ? describeGrant(row.grant, names) : 'Nothing'} —{' '}
                  {formatChance(fractions[index] ?? 0)}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function Editor({
  initial,
  embedded,
}: {
  initial: DungeonLootTable | null;
  embedded?: EmbeddedLootEditor;
}) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const navigate = useNavigate();
  const client = useQueryClient();
  const canWrite = useHasPermission('dungeons.write');
  const [loaded, setLoaded] = useState(initial);
  const [form, setForm] = useState<LootForm>(() => (initial ? formOf(initial) : emptyForm()));
  /** A new table's key, once the author has typed their own; otherwise it follows the name. */
  const [ownKey, setOwnKey] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rolls, setRolls] = useState(1);
  const [testing, setTesting] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState<DungeonLootTableConflict | null>(null);
  const [theirs, setTheirs] = useState<DungeonLootTable | null>(null);
  const [action, setAction] = useState<'duplicate' | 'archive' | 'delete' | null>(null);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);

  const readOnly = !canWrite;
  const baseline = loaded ? formOf(loaded) : emptyForm();
  const dirty = leaveTo === null && JSON.stringify(form) !== JSON.stringify(baseline);
  const update = (patch: Partial<LootForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setNotice('');
  };

  useEffect(() => {
    if (leaveTo !== null) navigate(leaveTo, { replace: true });
  }, [leaveTo, navigate]);
  const reportDirty = embedded?.onDirtyChange;
  useEffect(() => {
    reportDirty?.(dirty);
    return () => reportDirty?.(false);
  }, [dirty, reportDirty]);
  useEffect(() => {
    // Embedded, the host page owns leaving and reloading.
    if (!dirty || embedded) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const leave = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.('a[href]');
      if (anchor && !window.confirm(DISCARD)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    if (!dataRouter) document.addEventListener('click', leave, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', leave, true);
    };
  }, [dirty, dataRouter, embedded]);

  const reference = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'reference'],
    queryFn: ({ signal }) => getDungeonReference(signal),
  });
  const usage = useQuery({
    queryKey: [...DUNGEON_LOOT_TABLES_QUERY_KEY, 'usage', loaded?.key],
    queryFn: ({ signal }) => getDungeonLootTableUsage(loaded!.key, signal),
    enabled: loaded !== null,
  });
  const history = useQuery({
    queryKey: [...DUNGEON_LOOT_TABLES_QUERY_KEY, 'history', loaded?.key, loaded?.revision],
    queryFn: ({ signal }) => getDungeonLootTableHistory(loaded!.key, 20, signal),
    enabled: loaded !== null && advanced,
  });
  const uses = dungeonUses(usage.data);
  const items = reference.data?.items ?? [];

  const { body, problems: formProblems } = bodyOf(form);
  const newKey = ownKey ?? keyFromName(form.name);
  const problems: FormProblem[] = [...formProblems];
  if (!loaded && form.name.trim() && (!KEY_PATTERN.test(newKey) || newKey.length > 64))
    problems.push({
      at: 'key',
      message:
        'The table key needs lower-case letters, numbers and underscores, such as boss_hoard.',
    });

  // Odds and dependency problems for the table as it stands, asked for once it has sat still.
  const bodyJson = body ? JSON.stringify(body) : null;
  const settled = useDebouncedValue(bodyJson, PREVIEW_DELAY_MS);
  const preview = useQuery({
    queryKey: [...DUNGEON_LOOT_TABLES_QUERY_KEY, 'preview', settled, rolls],
    enabled: settled !== null,
    // Keyed by the content it describes, so an answer for older content is never shown as current.
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const tableBody = JSON.parse(settled!) as DungeonLootTableBody;
      const [validation, odds] = await Promise.all([
        validateDungeonLootTable(tableBody, signal),
        testRollDungeonLootTable({ tableBody, draws: rolls, seed: 0 }, signal),
      ]);
      return { body: tableBody, validation, odds };
    },
  });
  const report = preview.data;
  const names = rewardNames(
    reference.data?.items,
    loaded?.equipmentPools,
    report?.validation.equipmentPools,
    report?.odds.equipmentPools,
  );
  // Until the first answer arrives, a saved table's own standing problems are what is known.
  const reported = report
    ? friendlyLootIssues(report.validation.issues, report.body, names, items)
    : loaded
      ? friendlyLootIssues(loaded.issues, loaded.body, names, items)
      : [];
  const tools: SectionTools = {
    names,
    items,
    readOnly,
    open,
    setOpen,
    problems: (at) => problems.filter((p) => p.at === at).map((p) => p.message),
    issues: (at) => reported.filter((i) => i.at === at),
  };
  // A blank new table is not yet a mistake; say what is missing once the author has started.
  const started = loaded !== null || dirty;
  const tableWide = reported.filter((i) => i.at === null);
  const toFix = reported.filter((i) => i.severity === 'error').length;

  const save = useMutation({
    mutationFn: () => {
      const input = {
        name: form.name.trim(),
        description: form.description.trim(),
        tier: form.tier,
        body: body!,
      };
      return loaded
        ? updateDungeonLootTable(loaded.key, { expectedRevision: loaded.revision, ...input })
        : createDungeonLootTable({ key: newKey, ...input });
    },
    onSuccess: (table) => {
      invalidateLootTables(client);
      client.setQueryData([...DUNGEON_LOOT_TABLES_QUERY_KEY, 'table', table.key], table);
      if (!loaded) return setLeaveTo(`${LIST}/${encodeURIComponent(table.key)}`);
      setLoaded(table);
      setForm(formOf(table));
      setOpen(null);
      setNotice(
        `Saved. ${republishNote(uses) ?? 'No dungeon was published or changed by saving this table.'}`,
      );
    },
    onError: (error) => {
      if (isPortalApiError(error) && error.code === 'DUNGEON_LOOT_TABLE_STALE')
        setConflict((error.details ?? {}) as unknown as DungeonLootTableConflict);
      if (isPortalApiError(error) && error.code === 'DUNGEON_LOOT_TABLE_KEY_TAKEN')
        setAdvanced(true);
    },
  });
  const review = useMutation({
    mutationFn: () => getDungeonLootTable(loaded!.key),
    onSuccess: setTheirs,
  });
  const saveError = isPortalApiError(save.error) ? save.error : null;
  const keyTaken = saveError?.code === 'DUNGEON_LOOT_TABLE_KEY_TAKEN';
  const refused =
    saveError?.code === 'DUNGEON_LOOT_TABLE_INVALID'
      ? ((saveError.details as { issues?: Array<{ path: string; message: string }> } | undefined)
          ?.issues ?? [])
      : [];

  const discard = () => {
    if (!window.confirm('Discard every unsaved change to this table?')) return;
    setForm(baseline);
    setOwnKey(null);
    setOpen(null);
    setNotice('');
  };
  const blockedReason =
    conflict !== null
      ? 'Review the newer version before saving.'
      : problems.length > 0 && started
        ? `Fix ${problems.length} highlighted ${problems.length === 1 ? 'field' : 'fields'} to save.`
        : '';

  return (
    <div className="space-y-4">
      {dataRouter && !embedded && <UnsavedNavigationGuard dirty={dirty} />}
      {!embedded && (
        <PageHeader
          title={loaded ? `Loot table — ${loaded.name}` : 'New loot table'}
          description="Reusable loot that dungeon activities can roll. Saving a table never publishes a dungeon."
          actions={
            <Button variant="outline" asChild>
              <Link to={LIST}>Back to loot tables</Link>
            </Button>
          }
        />
      )}
      {(readOnly || loaded?.archivedAt) && (
        <div className="flex flex-wrap items-center gap-2">
          {readOnly && <Badge>View only</Badge>}
          {loaded?.archivedAt && <Badge variant="danger">Archived</Badge>}
          <span className="text-xs text-ink-muted">
            {readOnly
              ? 'You can look at this table and test-roll it, but not change it.'
              : 'Archived tables cannot be chosen for dungeons until they are restored.'}
          </span>
        </div>
      )}

      {conflict && loaded && (
        <Card
          className="space-y-2 border-danger/40 p-4 text-sm"
          role="alert"
          data-testid="conflict-banner"
        >
          <p className="font-medium text-danger">
            Someone else saved this table while you were editing it.
          </p>
          <p className="text-ink-muted">
            It is now at revision {conflict.currentRevision ?? '?'}
            {conflict.updatedBy ? `, saved by ${conflict.updatedBy}` : ''}
            {conflict.updatedAt ? ` on ${formatDateTime(conflict.updatedAt)}` : ''}. Your changes
            are still on this page and were not saved, and theirs were not overwritten.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={review.isPending}
            onClick={() => review.mutate()}
          >
            Review their version
          </Button>
          {review.isError && (
            <ErrorState
              variant="inline"
              title="Could not load their version"
              error={review.error}
            />
          )}
        </Card>
      )}
      {theirs && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && setTheirs(null)}>
          <DialogContent>
            <Card className="max-h-full w-full max-w-xl space-y-3 overflow-y-auto p-5">
              <DialogTitle className="font-display text-lg text-ink">
                The newer saved version (revision {theirs.revision})
              </DialogTitle>
              <DialogDescription className="text-sm text-ink-muted">
                Compare it with your changes, then choose which to continue with. Nothing is saved
                until you press Save.
              </DialogDescription>
              <TableSummary
                table={theirs}
                names={rewardNames(reference.data?.items, theirs.equipmentPools)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setLoaded(theirs);
                    setTheirs(null);
                    setConflict(null);
                    save.reset();
                    setNotice(
                      `Your changes are kept. Saving now replaces revision ${theirs.revision} with your version.`,
                    );
                  }}
                >
                  Keep my changes
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setLoaded(theirs);
                    setForm(formOf(theirs));
                    setTheirs(null);
                    setConflict(null);
                    setOpen(null);
                    save.reset();
                    setNotice('Their version is loaded. Your unsaved changes were discarded.');
                  }}
                >
                  Use their version
                </Button>
                <Button variant="ghost" onClick={() => setTheirs(null)}>
                  Decide later
                </Button>
              </div>
            </Card>
          </DialogContent>
        </Dialog>
      )}

      <Card className="space-y-3 p-4" data-testid="loot-details">
        <div className="flex flex-wrap items-start gap-3">
          <label className="min-w-48 flex-1 text-xs text-ink-muted">
            Name
            <Input
              aria-label="Table name"
              placeholder="Scrapheap Boss Hoard"
              value={form.name}
              disabled={readOnly}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <label className="w-40 text-xs text-ink-muted">
            Tier (optional)
            <select
              aria-label="Tier"
              className={selectClass}
              value={form.tier ?? ''}
              disabled={readOnly}
              onChange={(e) => update({ tier: (e.target.value || null) as LootTier | null })}
            >
              <option value="">No tier</option>
              {LOOT_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {TIER_LABELS[tier]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(started ? tools.problems('name') : []).map((message) => (
          <p key={message} className="text-xs text-danger" role="alert">
            {message}
          </p>
        ))}
        <label className="block text-xs text-ink-muted">
          Description
          <textarea
            aria-label="Description"
            className={textareaClass}
            rows={2}
            placeholder="What this loot is for. Only authors see it."
            value={form.description}
            disabled={readOnly}
            onChange={(e) => update({ description: e.target.value })}
          />
        </label>
        {tools.problems('description').map((message) => (
          <p key={message} className="text-xs text-danger" role="alert">
            {message}
          </p>
        ))}
        <p className="text-xs text-ink-muted">
          The tier is only a label for finding tables. It does not change what drops.
        </p>
        {loaded && (
          <div className="text-sm" data-testid="where-used">
            <span className="text-ink-muted">Used by: </span>
            {usage.isPending ? (
              <span className="text-ink-muted">checking…</span>
            ) : usage.isError ? (
              <span className="text-danger">could not be checked</span>
            ) : uses.length === 0 ? (
              <span className="text-ink">no dungeon yet</span>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {uses.map((use) => (
                  <li key={use.dungeonKey}>
                    {embedded ? (
                      <span className="font-medium">{use.name}</span>
                    ) : (
                      <Link
                        className="font-medium hover:underline"
                        to={`/admin/dungeons/definitions/${encodeURIComponent(use.dungeonKey)}`}
                      >
                        {use.name}
                      </Link>
                    )}
                    <span className="text-ink-muted">
                      {' — '}
                      {[
                        use.draft && 'in its draft',
                        use.liveRevision !== null &&
                          `live in published revision ${use.liveRevision}`,
                        use.olderRevisions > 0 &&
                          `${use.olderRevisions} older ${use.olderRevisions === 1 ? 'revision' : 'revisions'}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {republishNote(uses) && (
              <p className="mt-1 text-xs text-ink-muted" data-testid="republish-note">
                {republishNote(uses)}
              </p>
            )}
          </div>
        )}
      </Card>

      {(tableWide.length > 0 || refused.length > 0) && (
        <Card className="space-y-1 p-4 text-sm" data-testid="loot-attention">
          <h2 className="text-sm font-semibold uppercase text-ink-muted">Needs attention</h2>
          <ul className="space-y-0.5">
            {tableWide.map((issue) => (
              <li
                key={issue.raw}
                title={issue.raw}
                className={issue.severity === 'error' ? 'text-danger' : 'text-ink-muted'}
              >
                {issue.severity === 'error' ? 'Fix: ' : 'Review: '}
                {issue.text}
              </li>
            ))}
            {refused.map((issue) => (
              <li key={`${issue.path}:${issue.message}`} className="text-danger" title={issue.path}>
                The server did not accept this table: {issue.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <GuaranteedSection form={form} update={update} tools={tools} />
      <ChanceSection form={form} update={update} tools={tools} />
      <PoolsSection form={form} update={update} tools={tools} />

      <LootOdds
        analysis={report ? report.odds.analysis : undefined}
        rolls={rolls}
        onRolls={setRolls}
        names={names}
        blocked={body === null}
        updating={preview.isFetching || settled !== bodyJson}
        failed={preview.isError}
      />

      <div className="space-y-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? '▾' : '▸'} Advanced (table key, revision, history)
        </Button>
        {(advanced || problems.some((p) => p.at === 'key')) && (
          <Card className="space-y-2 p-4 text-sm" data-testid="loot-advanced">
            {loaded ? (
              <>
                <p>
                  <span className="text-ink-muted">Table key: </span>
                  <code className="font-mono">{loaded.key}</code>
                </p>
                <p className="text-ink-muted">
                  Revision {loaded.revision} · last saved {formatDateTime(loaded.updatedAt)}
                  {loaded.updatedBy ? ` by ${loaded.updatedBy}` : ''}
                </p>
                <ul className="space-y-0.5 text-xs text-ink-muted" data-testid="loot-history">
                  {history.isPending && <li>Loading history…</li>}
                  {history.data?.events.map((event) => (
                    <li key={event.id}>
                      {formatDateTime(event.createdAt)} · {event.action} · revision {event.revision}
                      {event.actor ? ` · ${event.actor}` : ''}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <label className="block text-xs text-ink-muted">
                Table key
                <Input
                  aria-label="Table key"
                  className="font-mono"
                  value={newKey}
                  disabled={readOnly}
                  onChange={(e) => setOwnKey(e.target.value)}
                />
                <span className="mt-1 block">
                  Made from the name. Packages and dungeons refer to the table by it, so it cannot
                  be changed once the table is created.
                </span>
              </label>
            )}
            {tools.problems('key').map((message) => (
              <p key={message} className="text-xs text-danger" role="alert">
                {message}
              </p>
            ))}
          </Card>
        )}
      </div>

      {embedded && canWrite && (
        <p className="text-xs text-ink-muted">
          To duplicate, archive or delete this table, open it from Dungeon Loot Tables.
        </p>
      )}
      {loaded && canWrite && !embedded && (
        <div className="flex flex-wrap items-center gap-2" data-testid="table-actions">
          <Button variant="outline" size="sm" onClick={() => setAction('duplicate')}>
            Duplicate
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAction('archive')}>
            {loaded.archivedAt ? 'Restore' : 'Archive'}
          </Button>
          {loaded.archivedAt ? (
            <Button variant="danger" size="sm" onClick={() => setAction('delete')}>
              Delete
            </Button>
          ) : (
            <span className="text-xs text-ink-muted">Archive a table before deleting it.</span>
          )}
        </div>
      )}
      {loaded && action === 'duplicate' && (
        <DuplicateDialog
          table={loaded}
          unsaved={dirty}
          onClose={() => setAction(null)}
          onDone={(copy) => navigate(`${LIST}/${encodeURIComponent(copy.key)}`)}
        />
      )}
      {loaded && action === 'archive' && (
        <ArchiveDialog
          table={loaded}
          uses={uses}
          onClose={() => setAction(null)}
          onDone={(table) => {
            // Only the archive state and revision changed, so what the author is editing stays.
            setLoaded(table);
            setAction(null);
            setNotice(table.archivedAt ? 'Table archived.' : 'Table restored.');
          }}
        />
      )}
      {loaded && action === 'delete' && (
        <DeleteDialog
          table={loaded}
          uses={uses}
          onClose={() => setAction(null)}
          onDeleted={() => setLeaveTo(LIST)}
        />
      )}

      {body && (
        <TestRollDialog
          open={testing}
          onOpenChange={setTesting}
          target={{ kind: 'table', body, initialRolls: rolls }}
          title={form.name.trim() || 'this table'}
          items={items}
        />
      )}

      <div
        className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-border bg-surface px-1 py-3"
        data-testid="loot-save-bar"
      >
        <div className="min-w-0 flex-1 basis-48 text-sm">
          <p className={dirty ? 'font-medium text-ink' : 'text-ink-muted'} role="status">
            {notice ||
              (dirty
                ? 'Unsaved changes'
                : loaded
                  ? 'No unsaved changes'
                  : 'Nothing is saved until you create the table.')}
          </p>
          {blockedReason && canWrite && (
            <p className="text-xs text-danger" data-testid="save-blocked">
              {blockedReason}
            </p>
          )}
          {toFix > 0 && (
            <p className="text-xs text-ink-muted" data-testid="save-warning">
              {toFix} {toFix === 1 ? 'reward needs' : 'rewards need'} repair before a dungeon using
              this table can be published. You can still save and fix {toFix === 1 ? 'it' : 'them'}{' '}
              step by step.
            </p>
          )}
          {keyTaken ? (
            <p className="text-xs text-danger" role="alert">
              Another loot table already uses this key. Change the name, or set a different table
              key under Advanced.
            </p>
          ) : (
            save.isError &&
            !conflict &&
            refused.length === 0 && (
              <ErrorState variant="inline" title="Could not save the table" error={save.error} />
            )
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={body === null}
          title={body === null ? 'Fix the highlighted fields to test-roll this table.' : undefined}
          onClick={() => setTesting(true)}
        >
          Test roll
        </Button>
        {canWrite && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={!dirty || save.isPending}
              onClick={discard}
            >
              Discard changes
            </Button>
            <Button
              type="button"
              variant="accent"
              disabled={
                save.isPending ||
                conflict !== null ||
                problems.length > 0 ||
                body === null ||
                (loaded !== null && !dirty)
              }
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : loaded ? 'Save table' : 'Create table'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
