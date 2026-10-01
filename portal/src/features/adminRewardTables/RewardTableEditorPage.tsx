/**
 * Admin — edit one boss or expedition reward table.
 *
 * Reward Tables → Table → Group → rows. The draft is the table document
 * itself (the shape `bossRewards.json` / `expeditionRewards.json` hold), so
 * fields this editor does not render survive a save.
 *
 *   - **Validation is the server's.** Every change is sent to the dry-run
 *     `validate` route; its issues are shown against the row they name, and
 *     Save stays disabled while any is an error. The same checks run again in
 *     the save transaction.
 *   - **Previews are live.** Each gear row lists the base definitions its
 *     selector can pay on this server right now, and each group sums them.
 *   - **Saves are optimistic.** A save names the revision it loaded. If someone
 *     else saved first the server refuses with 409, and this page says so and
 *     offers a reload — it never overwrites.
 *
 * A save reaches the next boss spawn and the next mission deploy. Bosses
 * already announced and missions already running keep the table they started
 * with.
 */
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  REWARD_TABLES_QUERY_KEY,
  createRewardTable,
  deleteRewardTable,
  getRewardTable,
  getRewardTableReference,
  previewEquipmentSelectors,
  resetRewardTable,
  updateRewardTable,
  validateRewardTable,
  type EquipmentSelectorPreview,
  type RewardTableDetail,
  type RewardTableDoc,
  type RewardTableKind,
} from '@/api/adminRewardTables';
import { isPortalApiError } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';
import { RewardGroupCard } from './RewardGroupCard';
import { IssueList } from './RewardRows';
import { OriginBadge } from './RewardTablesListPage';
import {
  KIND_LABELS,
  REFERENCE_ROLE_LABELS,
  issuesFor,
  DRAFT_GROUP,
  newGroup,
  newTable,
  selectorOf,
  tidyGroup,
} from './rewardTableModel';

const isKind = (k: string | undefined): k is RewardTableKind => k === 'boss' || k === 'expedition';

/** Keyed by table, so navigating between tables starts from a clean draft. */
export function RewardTableEditorPage() {
  const { kind, id } = useParams<{ kind: string; id?: string }>();
  if (!isKind(kind)) {
    return <ErrorState title="Unknown reward table kind" error={new Error(`"${kind}" is not boss or expedition.`)} />;
  }
  return <RewardTableEditor key={`${kind}/${id ?? 'new'}`} kind={kind} id={id} />;
}

interface StaleInfo {
  currentRevision?: number;
  updatedBy?: string | null;
  updatedAt?: string;
}

function tidy(table: RewardTableDoc): RewardTableDoc {
  return { ...table, groups: table.groups.map(tidyGroup) };
}

function numberOr(text: string, fallback: number): number {
  const n = Number(text);
  return text.trim() === '' || !Number.isFinite(n) ? fallback : Math.trunc(n);
}

function RewardTableEditor({ kind, id }: { kind: RewardTableKind; id: string | undefined }) {
  const isNew = id === undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('rewards.write');
  const readOnly = !canWrite;

  const detailQuery = useQuery({
    queryKey: [...REWARD_TABLES_QUERY_KEY, kind, id],
    queryFn: ({ signal }) => getRewardTable(kind, id!, signal),
    enabled: !isNew,
  });
  const reference = useQuery({
    queryKey: [...REWARD_TABLES_QUERY_KEY, 'reference'],
    queryFn: ({ signal }) => getRewardTableReference(signal),
    staleTime: 60_000,
  }).data;

  const [form, setForm] = useState<RewardTableDoc | null>(isNew ? newTable(kind, '') : null);
  const [loaded, setLoaded] = useState<RewardTableDetail | null>(null);
  const [stale, setStale] = useState<StaleInfo | null>(null);

  const adopt = (detail: RewardTableDetail) => {
    setLoaded(detail);
    setForm(detail.table);
    setStale(null);
  };
  useEffect(() => {
    if (detailQuery.data && loaded === null) adopt(detailQuery.data);
  }, [detailQuery.data, loaded]);

  // Server-side dry run of the draft. Deferred so typing stays responsive.
  const draft = useDeferredValue(form);
  const draftJson = useMemo(() => (draft ? JSON.stringify(tidy(draft)) : ''), [draft]);
  const validation = useQuery({
    queryKey: [...REWARD_TABLES_QUERY_KEY, 'validate', kind, id ?? '', draftJson],
    queryFn: ({ signal }) => validateRewardTable(kind, tidy(draft!), id, signal),
    enabled: draft !== null && draft.id !== '',
    placeholderData: keepPreviousData,
  });
  const issues = validation.data?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');

  // Every gear row's selector, in order, for one preview request.
  const gearRows = useMemo(
    () => (draft?.groups ?? []).flatMap((g, gi) => (g.equipment ?? []).map((row, ri) => ({ gi, ri, row }))),
    [draft],
  );
  const selectorsJson = JSON.stringify(gearRows.map(({ row }) => selectorOf(row)));
  const preview = useQuery({
    queryKey: [...REWARD_TABLES_QUERY_KEY, 'preview', selectorsJson],
    queryFn: ({ signal }) => previewEquipmentSelectors(JSON.parse(selectorsJson) as unknown[], signal),
    enabled: gearRows.length > 0,
    placeholderData: keepPreviousData,
  });
  const previewsFor = (gi: number) => {
    const out: (EquipmentSelectorPreview | undefined)[] = [];
    gearRows.forEach(({ gi: g, ri }, index) => {
      if (g === gi) out[ri] = preview.data?.previews[index];
    });
    return out;
  };

  const invalidateList = () => void queryClient.invalidateQueries({ queryKey: REWARD_TABLES_QUERY_KEY });
  const onWriteError = (err: unknown) => {
    if (isPortalApiError(err) && err.code === 'REWARD_TABLE_STALE') setStale((err.details ?? {}) as StaleInfo);
  };

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? createRewardTable(kind, tidy(form!))
        : updateRewardTable(kind, id, tidy(form!), loaded!.revision),
    onSuccess: (detail) => {
      adopt(detail);
      invalidateList();
      if (isNew) navigate(`/admin/reward-tables/${kind}/${encodeURIComponent(detail.id)}`, { replace: true });
    },
    onError: onWriteError,
  });
  const reset = useMutation({
    mutationFn: () => resetRewardTable(kind, id!, loaded!.revision),
    onSuccess: (detail) => {
      adopt(detail);
      invalidateList();
    },
    onError: onWriteError,
  });
  const remove = useMutation({
    mutationFn: () => deleteRewardTable(kind, id!, loaded!.revision),
    onSuccess: () => {
      invalidateList();
      navigate(`/admin/reward-tables?kind=${kind}`);
    },
    onError: onWriteError,
  });

  const reload = async () => {
    const result = await detailQuery.refetch();
    if (result.data) adopt(result.data);
  };

  if (!isNew && detailQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (!isNew && detailQuery.isError) {
    return (
      <ErrorState
        title="Could not load reward table"
        error={detailQuery.error}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }
  if (form === null) return <Skeleton className="h-64 w-full" />;

  const dirty = isNew || (loaded !== null && JSON.stringify(tidy(form)) !== JSON.stringify(tidy(loaded.table)));
  const set = (patch: Partial<RewardTableDoc>) => setForm({ ...form, ...patch });
  const setGroups = (groups: RewardTableDoc['groups']) => set({ groups });
  const busy = save.isPending || reset.isPending || remove.isPending;

  return (
    <div className="space-y-4">
      <PageHeader
        title={isNew ? `New ${KIND_LABELS[kind].toLowerCase()} reward table` : `${KIND_LABELS[kind]} reward table — ${id}`}
        description="Changes reach the next boss spawn or mission deploy. Bosses already announced and missions already running keep the table they started with."
        actions={
          <Button variant="outline" asChild>
            <Link to={`/admin/reward-tables?kind=${kind}`}>Back to reward tables</Link>
          </Button>
        }
      />

      {stale && (
        <Card className="space-y-2 border-danger/40 p-4 text-sm" data-testid="stale-banner" role="alert">
          <p className="font-medium text-danger">Someone else saved this table since you opened it.</p>
          <p className="text-ink-muted">
            It is now at revision {stale.currentRevision ?? '?'}
            {stale.updatedBy ? ` (saved by ${stale.updatedBy})` : ''}. Your save was not applied. Reload to see
            their version — your unsaved edits on this page will be discarded.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
            Reload latest version
          </Button>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card className="space-y-3 p-4" data-testid="table-fields">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-ink-muted">
                Table id
                {isNew ? (
                  <Input
                    aria-label="Table id"
                    className="w-64"
                    value={form.id}
                    disabled={readOnly}
                    onChange={(e) => set({ id: e.target.value })}
                  />
                ) : (
                  <span className="block h-9 pt-2 font-mono text-sm text-ink">{form.id}</span>
                )}
              </label>
              <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  aria-label="Table enabled"
                  checked={form.enabled !== false}
                  disabled={readOnly}
                  onChange={(e) => set({ enabled: e.target.checked })}
                />
                Enabled
              </label>
              <label className="text-xs text-ink-muted">
                Version
                <Input
                  aria-label="Version"
                  className="w-48"
                  placeholder={form.id || 'defaults to the id'}
                  value={form.version ?? ''}
                  disabled={readOnly}
                  onChange={(e) => {
                    const { version: _v, ...rest } = form;
                    setForm(e.target.value ? { ...rest, version: e.target.value } : (rest as RewardTableDoc));
                  }}
                />
              </label>
            </div>
            {kind === 'boss' ? (
              <label className="block text-xs text-ink-muted">
                Buddy XP
                <Input
                  type="number"
                  min={0}
                  aria-label="Buddy XP"
                  className="w-32"
                  value={form.buddyXp ?? 0}
                  disabled={readOnly}
                  onChange={(e) => set({ buddyXp: numberOr(e.target.value, 0) })}
                />
              </label>
            ) : (
              <ExpeditionTableFields form={form} disabled={readOnly} onChange={setForm} />
            )}
            <IssueList issues={issuesFor(issues, { kind: 'table' })} />
          </Card>

          {form.groups.map((group, gi) => (
            <RewardGroupCard
              key={gi}
              group={group}
              index={gi}
              groupCount={form.groups.length}
              idEditable={isNew || group[DRAFT_GROUP] === true}
              issues={issues}
              reference={reference}
              previews={previewsFor(gi)}
              disabled={readOnly}
              onChange={(next) => setGroups(form.groups.map((g, j) => (j === gi ? next : g)))}
              onRemove={() => setGroups(form.groups.filter((_, j) => j !== gi))}
              onMove={(delta) => {
                const next = [...form.groups];
                const [moved] = next.splice(gi, 1);
                next.splice(gi + delta, 0, moved!);
                setGroups(next);
              }}
            />
          ))}
          {canWrite && (
            <Button type="button" variant="outline" onClick={() => setGroups([...form.groups, newGroup(form)])}>
              Add group
            </Button>
          )}

          <Card className="space-y-2 p-4">
            {validation.isError && (
              <ErrorState variant="inline" title="Could not check the table" error={validation.error} />
            )}
            <p className="text-xs text-ink-muted" data-testid="validation-status">
              {validation.isFetching
                ? 'Checking…'
                : errors.length > 0
                  ? `${errors.length} problem${errors.length === 1 ? '' : 's'} to fix before saving.`
                  : dirty
                    ? 'Ready to save.'
                    : 'No unsaved changes.'}
            </p>
            {save.isError && !stale && <ErrorState variant="inline" title="Could not save" error={save.error} />}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="accent"
                disabled={
                  readOnly || busy || !dirty || stale !== null || errors.length > 0 || validation.isFetching || form.id === ''
                }
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : isNew ? 'Create table' : 'Save table'}
              </Button>
              {!isNew && dirty && (
                <Button type="button" variant="ghost" disabled={busy} onClick={() => loaded && adopt(loaded)}>
                  Discard changes
                </Button>
              )}
              {readOnly && <span className="text-xs text-ink-muted">You do not have write permission.</span>}
            </div>
          </Card>
        </div>

        {!isNew && loaded && (
          <TableSidebar
            detail={loaded}
            canWrite={canWrite}
            busy={busy}
            onReset={() => {
              if (window.confirm('Replace this table with the version shipped in Git? Your edits will be lost.'))
                reset.mutate();
            }}
            onDelete={() => {
              if (window.confirm(`Delete reward table "${loaded.id}"?`)) remove.mutate();
            }}
            error={reset.error ?? remove.error}
          />
        )}
      </div>
    </div>
  );
}

function RangeField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: { min: number; max: number } | undefined;
  disabled: boolean;
  onChange: (next: { min: number; max: number } | undefined) => void;
}) {
  return (
    <fieldset className="text-xs text-ink-muted">
      <legend className="flex items-center gap-1">
        <input
          type="checkbox"
          aria-label={`Pays ${label}`}
          checked={value !== undefined}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? { min: 0, max: 0 } : undefined)}
        />
        {label}
      </legend>
      {value && (
        <div className="mt-1 flex gap-2">
          <Input
            type="number"
            min={0}
            aria-label={`${label} min`}
            className="w-24"
            value={value.min}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, min: numberOr(e.target.value, 0) })}
          />
          <span className="pt-2">to</span>
          <Input
            type="number"
            min={0}
            aria-label={`${label} max`}
            className="w-24"
            value={value.max}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, max: numberOr(e.target.value, 0) })}
          />
        </div>
      )}
    </fieldset>
  );
}

function ExpeditionTableFields({
  form,
  disabled,
  onChange,
}: {
  form: RewardTableDoc;
  disabled: boolean;
  onChange: (next: RewardTableDoc) => void;
}) {
  const setRange = (field: 'waifubux' | 'essence', value: { min: number; max: number } | undefined) => {
    const { [field]: _old, ...rest } = form;
    onChange(value ? { ...rest, [field]: value } : (rest as RewardTableDoc));
  };
  return (
    <div className="flex flex-wrap gap-4">
      <RangeField label="WaifuBux" value={form.waifubux} disabled={disabled} onChange={(v) => setRange('waifubux', v)} />
      <RangeField label="Essence" value={form.essence} disabled={disabled} onChange={(v) => setRange('essence', v)} />
      <label className="text-xs text-ink-muted">
        Waifu XP
        <Input
          type="number"
          min={0}
          aria-label="Waifu XP"
          className="w-24"
          value={form.waifuXp ?? 0}
          disabled={disabled}
          onChange={(e) => onChange({ ...form, waifuXp: numberOr(e.target.value, 0) })}
        />
      </label>
      <label className="text-xs text-ink-muted">
        Player XP
        <Input
          type="number"
          min={0}
          aria-label="Player XP"
          className="w-24"
          value={form.playerXp ?? 0}
          disabled={disabled}
          onChange={(e) => onChange({ ...form, playerXp: numberOr(e.target.value, 0) })}
        />
      </label>
    </div>
  );
}

function TableSidebar({
  detail,
  canWrite,
  busy,
  onReset,
  onDelete,
  error,
}: {
  detail: RewardTableDetail;
  canWrite: boolean;
  busy: boolean;
  onReset: () => void;
  onDelete: () => void;
  error: unknown;
}) {
  const canDelete = detail.origin === 'custom' && detail.references.length === 0;
  return (
    <Card className="space-y-3 p-4 text-sm" data-testid="table-sidebar">
      <div className="flex flex-wrap gap-2">
        <OriginBadge summary={detail} />
        {!detail.enabled && <Badge variant="danger">Disabled</Badge>}
        <Badge variant="outline">Revision {detail.revision}</Badge>
      </div>
      <p className="text-xs text-ink-muted">
        Last saved {new Date(detail.updatedAt).toLocaleString()}
        {detail.updatedBy ? ` by ${detail.updatedBy}` : ''}.
      </p>
      <div>
        <h2 className="text-sm font-semibold uppercase text-ink-muted">Paid by</h2>
        {detail.references.length === 0 ? (
          <p className="text-xs text-ink-muted">Nothing references this table.</p>
        ) : (
          <ul className="space-y-0.5 text-xs" data-testid="table-references">
            {detail.references.map((r) => (
              <li key={`${r.role}:${r.key}`}>
                {r.name} <span className="text-ink-muted">· {REFERENCE_ROLE_LABELS[r.role]}</span>
                {!r.enabled && <span className="text-ink-muted"> · disabled</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {canWrite && (
        <div className="space-y-2 border-t border-border pt-3">
          {detail.matchesShipped === false && (
            <div>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onReset}>
                Reset to shipped version
              </Button>
              <p className="mt-1 text-xs text-ink-muted">
                Replaces this table with the copy in this build’s content files; later deploys then update it again.
              </p>
            </div>
          )}
          <div>
            <Button type="button" variant="danger" size="sm" disabled={busy || !canDelete} onClick={onDelete}>
              Delete table
            </Button>
            {!canDelete && (
              <p className="mt-1 text-xs text-ink-muted">
                {detail.references.length > 0
                  ? 'Content pays from this table — disable it instead.'
                  : 'Shipped tables cannot be deleted — disable it instead.'}
              </p>
            )}
          </div>
          {error ? <ErrorState variant="inline" title="That did not work" error={error} /> : null}
        </div>
      )}
    </Card>
  );
}
