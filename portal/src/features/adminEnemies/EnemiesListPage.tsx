/**
 * Admin — Enemies: every combat enemy at a glance — its stats, its pictures,
 * whether it is enabled, how widely it is used — and where it stands relative
 * to Git.
 *
 * Enemies are shared content. Dungeons and Combat Trials name them; neither
 * owns them, so they are made and tuned here and only *chosen* elsewhere.
 * They are database rows seeded from `content/combat/enemies.json`; an enemy
 * edited here is never overwritten by a deploy, and **Export** writes the
 * file format back so the edit can be committed to Git.
 *
 * An enemy is switched off, not deleted: disabling keeps every reference to
 * it. Delete lives in the editor, for a mistake nothing uses.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  ENEMIES_QUERY_KEY,
  duplicateEnemy,
  exportEnemies,
  invalidateEnemyQueries,
  listEnemies,
  setEnemyEnabled,
  type EnemyIssue,
  type EnemySummary,
} from '@/api/adminEnemies';
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
import { ArtThumb } from '@/features/adminDungeons/ArtThumb';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { cn } from '@/lib/cn';

import { enemyPath, hasSprite, keyError, matchesSearch, statLine } from './enemyModel';
import { DisableEnemyDialog, EnemyIssues, EnemyOriginBadge } from './enemyParts';

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

type StatusFilter = 'all' | 'enabled' | 'disabled';
type UsageFilter = 'all' | 'used' | 'unused';

export function EnemiesListPage() {
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('enemies.write');
  const query = useQuery({
    queryKey: [...ENEMIES_QUERY_KEY, 'list'],
    queryFn: ({ signal }) => listEnemies(signal),
  });
  const enemies = query.data?.enemies ?? [];

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [tag, setTag] = useState('');
  const [usage, setUsage] = useState<UsageFilter>('all');
  const [duplicating, setDuplicating] = useState<EnemySummary | null>(null);
  /** The enemy the admin is being asked about disabling. */
  const [disabling, setDisabling] = useState<EnemySummary | null>(null);

  const tags = [...new Set(enemies.flatMap((e) => e.tags))].sort();
  const shown = enemies.filter(
    (e) =>
      matchesSearch(e, search) &&
      (status === 'all' || e.enabled === (status === 'enabled')) &&
      (tag === '' || e.tags.includes(tag)) &&
      (usage === 'all' || e.usageCount > 0 === (usage === 'used')),
  );

  const exporting = useMutation({
    mutationFn: exportEnemies,
    onSuccess: (exported) => downloadJson('enemies.json', exported.document),
  });
  const toggle = useMutation({
    mutationFn: (enemy: EnemySummary) => setEnemyEnabled(enemy.key, !enemy.enabled, enemy.revision),
    // Success or stale, the list is the source of truth for the next click.
    onSettled: () => {
      setDisabling(null);
      invalidateEnemyQueries(queryClient);
    },
  });
  const localArtwork = exporting.data?.environmentLocal.managedArtwork ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Enemies"
        description="Every enemy dungeons and Combat Trials can use. Edits reach the next fight started; a dungeon run already started keeps the enemies it started with."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={exporting.isPending}
              onClick={() => exporting.mutate()}
            >
              Export
            </Button>
            {canWrite && (
              <Button asChild variant="accent">
                <Link to="/admin/enemies/new">New Enemy</Link>
              </Button>
            )}
          </div>
        }
      />

      {exporting.isError && (
        <ErrorState variant="inline" title="Could not export" error={exporting.error} />
      )}
      {exporting.data && (
        <Card className="space-y-1 p-4 text-sm" role="status" data-testid="enemy-export-notice">
          <p className="text-ink">
            Downloaded <span className="font-mono">enemies.json</span> — it belongs at{' '}
            <span className="font-mono">content/{exporting.data.file}</span> in Git.
          </p>
          {localArtwork.length > 0 && (
            <>
              <p className="font-medium text-danger">
                Uploaded artwork is not in the file. It is stored in this environment only.
              </p>
              <p className="text-xs text-ink-muted">
                {exporting.data.environmentLocal.note} Affected:{' '}
                <span className="font-mono" data-testid="enemy-export-local">
                  {localArtwork.map((entry) => entry.key).join(', ')}
                </span>
                .
              </p>
            </>
          )}
        </Card>
      )}
      {toggle.isError && (
        <ErrorState
          variant="inline"
          title={
            isPortalApiError(toggle.error) && toggle.error.code === 'ENEMY_STALE'
              ? 'That enemy was changed by someone else — the list has been refreshed'
              : 'Could not change the enemy'
          }
          error={toggle.error}
        />
      )}

      <div className="flex flex-wrap items-end gap-3" data-testid="enemy-filters">
        <label className="min-w-48 flex-1 text-xs text-ink-muted">
          Search
          <Input
            aria-label="Search enemies"
            placeholder="Name, key or tag"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Status
          <select
            aria-label="Filter by status"
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="all">Enabled and disabled</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Tag
          <select
            aria-label="Filter by tag"
            className={selectClass}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            <option value="">Any tag</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Usage
          <select
            aria-label="Filter by usage"
            className={selectClass}
            value={usage}
            onChange={(e) => setUsage(e.target.value as UsageFilter)}
          >
            <option value="all">Used or not</option>
            <option value="used">Used somewhere</option>
            <option value="unused">Not used</option>
          </select>
        </label>
      </div>

      {query.isPending && <Skeleton className="h-32 w-full" />}
      {query.isError && (
        <ErrorState
          title="Could not load enemies"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && enemies.length === 0 && (
        <Card className="p-6 text-center text-sm text-ink-muted">No enemies yet.</Card>
      )}
      {enemies.length > 0 && (
        <p className="text-xs text-ink-muted" role="status" data-testid="enemy-count">
          {shown.length === enemies.length
            ? `${enemies.length} ${enemies.length === 1 ? 'enemy' : 'enemies'}`
            : `${shown.length} of ${enemies.length} shown`}
        </p>
      )}
      {shown.length > 0 && (
        <Card className="divide-y divide-border">
          {shown.map((e) => (
            <div
              key={e.key}
              className="flex flex-wrap items-start gap-3 px-4 py-3"
              data-testid="enemy-row"
            >
              <ArtThumb
                image={{ assetId: e.visual.artworkAssetId, artworkPath: e.visual.artworkPath }}
                label={`${e.name} artwork`}
                testId={`enemy-art-${e.key}`}
              />
              {hasSprite(e.visual) && (
                <ArtThumb
                  image={{
                    assetId: e.visual.spriteAssetId,
                    artworkPath: e.visual.spriteArtworkPath,
                  }}
                  label={`${e.name} sprite`}
                  testId={`enemy-sprite-${e.key}`}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={enemyPath(e.key)}
                    className={cn(
                      'font-medium text-ink hover:underline',
                      !e.enabled && 'text-ink-muted',
                    )}
                  >
                    {e.name}
                  </Link>
                  {e.enabled ? (
                    <Badge variant="default">Enabled</Badge>
                  ) : (
                    <Badge variant="danger">Disabled</Badge>
                  )}
                  <EnemyOriginBadge origin={e.origin} />
                  {e.tags.map((t) => (
                    <Badge key={t} variant="outline">
                      {t}
                    </Badge>
                  ))}
                </div>
                <p className="mt-1 text-sm text-ink-muted" data-testid="enemy-glance">
                  {statLine(e)} ·{' '}
                  <span data-testid="enemy-usage">
                    {e.usageCount === 0
                      ? 'Not used anywhere'
                      : `Used in ${e.usageCount} place${e.usageCount === 1 ? '' : 's'}`}
                  </span>
                </p>
                <p className="text-xs text-ink-subtle">
                  <span className="font-mono">{e.key}</span>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {canWrite && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={toggle.isPending}
                      aria-label={`${e.enabled ? 'Disable' : 'Enable'} ${e.name}`}
                      onClick={() =>
                        // Something still names it: say what disabling does first.
                        e.enabled && e.usageCount > 0 ? setDisabling(e) : toggle.mutate(e)
                      }
                    >
                      {e.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Duplicate ${e.name}`}
                      onClick={() => setDuplicating(e)}
                    >
                      Duplicate
                    </Button>
                  </>
                )}
                <Button size="sm" variant="outline" asChild>
                  <Link
                    to={enemyPath(e.key)}
                    aria-label={`${canWrite ? 'Edit' : 'View'} ${e.name}`}
                  >
                    {canWrite ? 'Edit' : 'View'}
                  </Link>
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {enemies.length > 0 && shown.length === 0 && (
        <Card className="p-6 text-center text-sm text-ink-muted" data-testid="enemy-no-match">
          No enemy matches these filters.
        </Card>
      )}

      <DisableEnemyDialog
        open={disabling !== null}
        name={disabling?.name ?? ''}
        usageCount={disabling?.usageCount ?? 0}
        pending={toggle.isPending}
        onConfirm={() => disabling && toggle.mutate(disabling)}
        onClose={() => setDisabling(null)}
      />
      {duplicating && (
        <DuplicateEnemyDialog
          key={duplicating.key}
          source={duplicating}
          onClose={() => setDuplicating(null)}
        />
      )}
    </div>
  );
}

/** Copy an enemy under a new key. The copy is a draft: it starts disabled. */
function DuplicateEnemyDialog({ source, onClose }: { source: EnemySummary; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [key, setKey] = useState(`${source.key}_copy`.slice(0, 64));
  const [name, setName] = useState('');
  const [copyArtwork, setCopyArtwork] = useState(true);

  const copy = useMutation({
    mutationFn: () =>
      duplicateEnemy(source.key, {
        key,
        ...(name.trim() !== '' ? { name: name.trim() } : {}),
        copyArtwork,
      }),
    onSuccess: (detail) => {
      invalidateEnemyQueries(queryClient);
      navigate(enemyPath(detail.key));
    },
  });
  const badKey = keyError(key);
  const keyTaken = isPortalApiError(copy.error) && copy.error.code === 'ENEMY_KEY_TAKEN';
  const refused =
    isPortalApiError(copy.error) && copy.error.code === 'ENEMY_INVALID'
      ? (((copy.error.details ?? {}) as { issues?: EnemyIssue[] }).issues ?? [])
      : null;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel="Cancel duplicating">
        <div
          className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-surface p-5"
          data-testid="duplicate-enemy-dialog"
        >
          <DialogTitle className="text-base font-semibold">Duplicate {source.name}</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            Makes a new enemy with the same stats, tags and description. The copy starts disabled,
            so nothing can pick it until you have looked it over and enabled it.
          </DialogDescription>
          <label className="block text-xs text-ink-muted">
            Key of the copy (lower_snake_case, permanent)
            <Input
              aria-label="Key of the copy"
              className="mt-1 font-mono"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          {badKey && (
            <p className="text-xs text-danger" role="alert">
              {badKey}
            </p>
          )}
          {keyTaken && (
            <p className="text-xs text-danger" role="alert">
              An enemy with the key “{key}” already exists — choose another key.
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
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              aria-label="Copy artwork"
              checked={copyArtwork}
              onChange={(e) => setCopyArtwork(e.target.checked)}
            />
            Copy its artwork and sprite placement
          </label>
          {refused && <EnemyIssues issues={refused} testId="duplicate-enemy-issues" />}
          {copy.isError && !keyTaken && !refused && (
            <ErrorState variant="inline" title="Could not duplicate the enemy" error={copy.error} />
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="accent"
              disabled={badKey !== null || copy.isPending}
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
