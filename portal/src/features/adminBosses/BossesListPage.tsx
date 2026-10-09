/**
 * Admin — Boss Management: every boss at a glance — where it appears, whether
 * it can spawn, when its schedule lets it, and how often it has.
 *
 * Bosses are database rows. The shipped `bosses.json` only adds bosses that
 * are missing; a boss edited here is never overwritten by a deploy, and
 * **Export** writes the document back so it can be committed or imported on
 * another server.
 *
 * A boss is switched off, not deleted: Disable keeps its encounter history.
 * Delete is for a boss made by mistake, and is refused for one that has ever
 * had an encounter or that ships with the game.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  BOSSES_QUERY_KEY,
  BOSS_STATUSES,
  deleteBoss,
  duplicateBoss,
  exportBosses,
  getBossReference,
  invalidateBossQueries,
  listBosses,
  setBossStatus,
  type BossInUseDetails,
  type BossIssue,
  type BossStatus,
  type BossSummary,
} from '@/api/adminBosses';
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
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { cn } from '@/lib/cn';

import { BossImportPanel } from './BossImportPanel';
import {
  STATUS_LABELS,
  bossPath,
  downloadJson,
  formatLocal,
  idError,
  matchesSearch,
  nextWindowLine,
  titleCase,
} from './bossModel';
import { BossIssues, BossStatusBadge, BossTabs, BossThumb } from './bossParts';

type StatusFilter = 'all' | BossStatus;

const issuesOf = (error: unknown): BossIssue[] | null =>
  isPortalApiError(error) && error.code === 'BOSS_DEFINITION_INVALID'
    ? (((error.details ?? {}) as { issues?: BossIssue[] }).issues ?? [])
    : null;
const isStale = (error: unknown) =>
  isPortalApiError(error) && error.code === 'BOSS_DEFINITION_STALE';

export function BossesListPage() {
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('bosses.write');
  const query = useQuery({
    queryKey: [...BOSSES_QUERY_KEY, 'list'],
    queryFn: ({ signal }) => listBosses(signal),
  });
  // Only for region names; the list stands without it.
  const reference = useQuery({
    queryKey: [...BOSSES_QUERY_KEY, 'reference'],
    queryFn: ({ signal }) => getBossReference(signal),
  });
  const bosses = query.data?.bosses ?? [];
  const regionLabel = (id: string) =>
    reference.data?.regions.find((r) => r.id === id)?.label ?? titleCase(id);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [region, setRegion] = useState('');
  const [duplicating, setDuplicating] = useState<BossSummary | null>(null);
  const [deleting, setDeleting] = useState<BossSummary | null>(null);
  const [importing, setImporting] = useState(false);

  const regions = [...new Set(bosses.flatMap((b) => b.regions))].sort();
  const shown = bosses.filter(
    (b) =>
      matchesSearch(b, search) &&
      (status === 'all' || b.status === status) &&
      (region === '' || b.regions.includes(region)),
  );

  const exporting = useMutation({
    mutationFn: exportBosses,
    onSuccess: (exported) => downloadJson(exported.file, exported.document),
  });
  const lifecycle = useMutation({
    mutationFn: ({ boss, to }: { boss: BossSummary; to: BossStatus }) =>
      setBossStatus(boss.id, to, boss.revision),
    // Success or refusal, the list is the source of truth for the next click.
    onSettled: () => invalidateBossQueries(queryClient),
  });
  const refusedActivation = issuesOf(lifecycle.error);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Boss Management"
        description="Every boss the spawner can draw, and when. Edits reach the next spawn; an encounter already drawn keeps the boss it started with."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={exporting.isPending}
              onClick={() => exporting.mutate()}
            >
              Export
            </Button>
            <Button variant="outline" onClick={() => setImporting(true)}>
              Import
            </Button>
            {canWrite && (
              <Button asChild variant="accent">
                <Link to="/admin/bosses/new">New Boss</Link>
              </Button>
            )}
          </div>
        }
      />
      <BossTabs current="bosses" />

      {exporting.isError && (
        <ErrorState variant="inline" title="Could not export" error={exporting.error} />
      )}
      {exporting.data && (
        <Card className="p-4 text-sm text-ink" role="status" data-testid="boss-export-notice">
          Downloaded <span className="font-mono">{exporting.data.file}</span> —{' '}
          {exporting.data.document.bosses.length} boss
          {exporting.data.document.bosses.length === 1 ? '' : 'es'}, schedules included.
        </Card>
      )}
      {importing && <BossImportPanel canWrite={canWrite} onClose={() => setImporting(false)} />}

      {lifecycle.isError && refusedActivation && (
        <Card
          className="space-y-2 border-danger/40 p-4 text-sm"
          data-testid="boss-activation-refused"
        >
          <p className="font-medium text-danger">
            {lifecycle.variables.boss.name} cannot be made {STATUS_LABELS[lifecycle.variables.to]}{' '}
            yet.
          </p>
          <BossIssues issues={refusedActivation} testId="boss-activation-issues" />
          <Link
            to={bossPath(lifecycle.variables.boss.id)}
            className="text-xs text-accent underline"
          >
            Open {lifecycle.variables.boss.name} to fix it
          </Link>
        </Card>
      )}
      {lifecycle.isError && !refusedActivation && (
        <ErrorState
          variant="inline"
          title={
            isStale(lifecycle.error)
              ? 'That boss was changed by someone else — the list has been refreshed'
              : 'Could not change the boss'
          }
          error={lifecycle.error}
        />
      )}

      <div className="flex flex-wrap items-end gap-3" data-testid="boss-filters">
        <label className="min-w-48 flex-1 text-xs text-ink-muted">
          Search
          <Input
            aria-label="Search bosses"
            placeholder="Name or id"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Region
          <select
            aria-label="Filter by region"
            className={selectClass}
            value={region}
            onChange={(e) => setRegion(e.target.value)}
          >
            <option value="">Any region</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {regionLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Status
          <select
            aria-label="Filter by status"
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="all">Any status</option>
            {BOSS_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {query.isPending && <Skeleton className="h-32 w-full" />}
      {query.isError && (
        <ErrorState
          title="Could not load bosses"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && bosses.length === 0 && (
        <Card className="p-6 text-center text-sm text-ink-muted">No bosses yet.</Card>
      )}
      {bosses.length > 0 && (
        <p className="text-xs text-ink-muted" role="status" data-testid="boss-count">
          {shown.length === bosses.length
            ? `${bosses.length} boss${bosses.length === 1 ? '' : 'es'}`
            : `${shown.length} of ${bosses.length} shown`}
        </p>
      )}
      {shown.length > 0 && (
        <Card className="divide-y divide-border">
          {shown.map((b) => (
            <div
              key={b.id}
              className="flex flex-wrap items-start gap-3 px-4 py-3"
              data-testid="boss-row"
            >
              <BossThumb path={b.artwork} label={`${b.name} artwork`} testId={`boss-art-${b.id}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={bossPath(b.id)}
                    className={cn(
                      'font-medium text-ink hover:underline',
                      b.status !== 'active' && 'text-ink-muted',
                    )}
                  >
                    {b.name}
                  </Link>
                  <BossStatusBadge status={b.status} />
                  <Badge variant="outline" data-testid="boss-affinity">
                    {titleCase(b.affinity)}
                  </Badge>
                  <Badge
                    variant={b.availability.availableNow ? 'solid' : 'outline'}
                    title="By its schedule alone. Status and the respawn cooldown are separate."
                    data-testid="boss-available-now"
                  >
                    {b.availability.availableNow ? 'Available now' : 'Not available now'}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-ink-muted">
                  <span data-testid="boss-regions">
                    {b.regions.length === 0 ? 'No region' : b.regions.map(regionLabel).join(', ')}
                  </span>{' '}
                  · <span data-testid="boss-schedule">{b.scheduleSummary}</span>
                </p>
                <p className="text-xs text-ink-muted">
                  <span data-testid="boss-next-window">
                    {nextWindowLine(b.availability, b.schedule.timezone)}
                  </span>{' '}
                  ·{' '}
                  <span data-testid="boss-encounters">
                    {b.encounterCount === 0
                      ? 'No encounters yet'
                      : `${b.encounterCount} encounter${b.encounterCount === 1 ? '' : 's'}, last ${formatLocal(b.lastEncounterAt)}`}
                  </span>
                </p>
                <p className="text-xs text-ink-subtle">
                  <span className="font-mono">{b.id}</span>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {canWrite && (
                  <>
                    {b.status !== 'active' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={lifecycle.isPending}
                        aria-label={`Activate ${b.name}`}
                        onClick={() => lifecycle.mutate({ boss: b, to: 'active' })}
                      >
                        Activate
                      </Button>
                    )}
                    {b.status !== 'disabled' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={lifecycle.isPending}
                        aria-label={`Disable ${b.name}`}
                        onClick={() => lifecycle.mutate({ boss: b, to: 'disabled' })}
                      >
                        Disable
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Duplicate ${b.name}`}
                      onClick={() => setDuplicating(b)}
                    >
                      Duplicate
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${b.name}`}
                      onClick={() => setDeleting(b)}
                    >
                      Delete
                    </Button>
                  </>
                )}
                <Button size="sm" variant="outline" asChild>
                  <Link to={bossPath(b.id)} aria-label={`${canWrite ? 'Edit' : 'View'} ${b.name}`}>
                    {canWrite ? 'Edit' : 'View'}
                  </Link>
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {bosses.length > 0 && shown.length === 0 && (
        <Card className="p-6 text-center text-sm text-ink-muted" data-testid="boss-no-match">
          No boss matches these filters.
        </Card>
      )}

      {duplicating && (
        <DuplicateBossDialog
          key={duplicating.id}
          source={duplicating}
          onClose={() => setDuplicating(null)}
        />
      )}
      {deleting && (
        <DeleteBossDialog key={deleting.id} boss={deleting} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

/** Copy a boss under a new id. The copy is a Draft, so it cannot spawn until it is activated. */
function DuplicateBossDialog({ source, onClose }: { source: BossSummary; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [id, setId] = useState(`${source.id}_copy`.slice(0, 64));
  const [name, setName] = useState('');

  const copy = useMutation({
    mutationFn: () =>
      duplicateBoss(source.id, { id, ...(name.trim() !== '' ? { name: name.trim() } : {}) }),
    onSuccess: (detail) => {
      invalidateBossQueries(queryClient);
      navigate(bossPath(detail.id));
    },
  });
  const badId = idError(id);
  const idTaken = isPortalApiError(copy.error) && copy.error.code === 'BOSS_DEFINITION_KEY_TAKEN';
  const refused = issuesOf(copy.error);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel="Cancel duplicating">
        <div
          className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-surface p-5"
          data-testid="duplicate-boss-dialog"
        >
          <DialogTitle className="text-base font-semibold">Duplicate {source.name}</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            Makes a new boss with the same regions, affinity, reward table, text and schedule. The
            copy starts as a Draft, so it cannot spawn until you have looked it over and activated
            it.
          </DialogDescription>
          <label className="block text-xs text-ink-muted">
            Id of the copy (lower_snake_case, permanent)
            <Input
              aria-label="Id of the copy"
              className="mt-1 font-mono"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          {badId && (
            <p className="text-xs text-danger" role="alert">
              {badId}
            </p>
          )}
          {idTaken && (
            <p className="text-xs text-danger" role="alert">
              A boss with the id “{id}” already exists — choose another id.
            </p>
          )}
          <label className="block text-xs text-ink-muted">
            Name of the copy (optional)
            <Input
              aria-label="Name of the copy"
              className="mt-1"
              placeholder={`${source.name} (copy)`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {refused && <BossIssues issues={refused} testId="duplicate-boss-issues" />}
          {copy.isError && !idTaken && !refused && (
            <ErrorState variant="inline" title="Could not duplicate the boss" error={copy.error} />
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="accent"
              disabled={badId !== null || copy.isPending}
              onClick={() => copy.mutate()}
            >
              {copy.isPending ? 'Duplicating…' : 'Duplicate'}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asked before a boss is deleted. The server refuses for a boss with encounter
 * history or one that ships with the game; the refusal is shown as given, with
 * the way out — disabling — one click away.
 */
function DeleteBossDialog({ boss, onClose }: { boss: BossSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteBoss(boss.id, boss.revision),
    onSuccess: () => {
      invalidateBossQueries(queryClient);
      onClose();
    },
  });
  const disable = useMutation({
    mutationFn: () => setBossStatus(boss.id, 'disabled', boss.revision),
    onSuccess: () => {
      invalidateBossQueries(queryClient);
      onClose();
    },
  });
  const inUse =
    isPortalApiError(remove.error) && remove.error.code === 'BOSS_DEFINITION_IN_USE'
      ? { message: remove.error.message, ...((remove.error.details ?? {}) as BossInUseDetails) }
      : null;
  const stale = isStale(remove.error) || isStale(disable.error);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel="Cancel deleting">
        <div
          className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-surface p-5"
          data-testid="delete-boss-dialog"
        >
          <DialogTitle className="text-base font-semibold">Delete {boss.name}?</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            Deleting is for a boss made by mistake, and cannot be undone. A boss that has ever had
            an encounter, or that ships with the game, cannot be deleted — disable it instead.
          </DialogDescription>
          {inUse && (
            <div
              className="space-y-2 rounded-lg border border-danger/40 p-3 text-sm"
              role="alert"
              data-testid="boss-delete-refused"
            >
              <p className="font-medium text-danger">{inUse.message}</p>
              {(inUse.encounterCount ?? 0) > 0 && (
                <p className="text-xs text-ink-muted">
                  It has {inUse.encounterCount} recorded encounter
                  {inUse.encounterCount === 1 ? '' : 's'}, which name it by id.
                </p>
              )}
              {inUse.shipped && (
                <p className="text-xs text-ink-muted">
                  It ships with the game, so a deleted copy would come back on the next restart.
                </p>
              )}
              <p className="text-xs text-ink">
                {boss.status === 'disabled'
                  ? 'It is already Disabled, so it will not spawn. Its history is kept.'
                  : 'Disable it instead: it keeps its history and is never drawn again.'}
              </p>
            </div>
          )}
          {stale && (
            <p className="text-xs text-danger" role="alert">
              This boss was changed by someone else. Close this and try again from the refreshed
              list.
            </p>
          )}
          {remove.isError && !inUse && !stale && (
            <ErrorState variant="inline" title="Could not delete the boss" error={remove.error} />
          )}
          {disable.isError && !stale && (
            <ErrorState variant="inline" title="Could not disable the boss" error={disable.error} />
          )}
          <div className="flex flex-wrap gap-2">
            {inUse ? (
              boss.status !== 'disabled' && (
                <Button
                  type="button"
                  variant="accent"
                  disabled={disable.isPending || stale}
                  onClick={() => disable.mutate()}
                >
                  {disable.isPending ? 'Disabling…' : 'Disable instead'}
                </Button>
              )
            ) : (
              <Button
                type="button"
                variant="danger"
                disabled={remove.isPending || stale}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? 'Deleting…' : 'Delete boss'}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              {inUse ? 'Close' : 'Keep it'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
