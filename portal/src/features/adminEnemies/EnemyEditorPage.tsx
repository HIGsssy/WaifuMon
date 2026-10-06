/**
 * Admin — edit one enemy.
 *
 * The page reads in the order an author thinks about an enemy: what it is,
 * how it fights, what it looks like, where it is used — and, folded away,
 * where it stands relative to Git.
 *
 *   - **Stats live here and nowhere else.** A dungeon or a trial chooses an
 *     enemy; it never tunes one. Changing ATK here changes it everywhere the
 *     enemy is fought, from the next fight started.
 *   - **Artwork is uploaded in place.** Each picture is selected from the
 *     library or uploaded right here; clearing one falls back to the file
 *     shipped with the game, if there is one.
 *   - **Saves are optimistic.** A save names the revision it loaded. If someone
 *     else saved first the server refuses with 409, and this page says so and
 *     offers a reload — it never overwrites.
 *   - **Disable, don't delete.** Disabling keeps every reference. Delete sits
 *     under Advanced, for an enemy nothing names, and says why when refused.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  ENEMIES_QUERY_KEY,
  deleteEnemy,
  getEnemy,
  invalidateEnemyQueries,
  updateEnemy,
  type EnemyDetail,
  type EnemyIssue,
  type EnemyReference,
  type EnemyStaleDetails,
} from '@/api/adminEnemies';
import { dungeonArtworkBlob } from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AssetField } from '@/features/adminArtwork/AssetField';
import { PlacementControls, ScenePreview } from '@/features/adminArtwork/ScenePreview';
import { Section } from '@/features/adminDungeons/zoneFormParts';

import {
  ORIGIN_LABELS,
  formErrors,
  formOf,
  formatUpdated,
  groupReferences,
  inputOf,
  issuesAt,
  placementInEffect,
  shippedDiff,
  usageKindLabel,
  type EnemyForm,
} from './enemyModel';
import {
  DisableEnemyDialog,
  EnemyIssues,
  EnemyOriginBadge,
  StatFields,
  TagInput,
} from './enemyParts';

/** Keyed by enemy, so navigating between enemies starts from a clean draft. */
export function EnemyEditorPage() {
  const { key } = useParams<{ key: string }>();
  return <EnemyEditor key={key} enemyKey={key ?? ''} />;
}

/** Every path a section of this form shows issues for. */
const SECTION_PATHS = [
  'name',
  'description',
  'enabled',
  'tags',
  'attack',
  'defense',
  'hp',
  'artworkAssetId',
  'spriteAssetId',
  'spritePlacement',
];

/** Where an enemy is used, one line per dungeon or trial. */
function UsageList({ references }: { references: EnemyReference[] }) {
  if (references.length === 0) {
    return (
      <p className="text-xs text-ink-muted" data-testid="enemy-usage-list">
        Not used anywhere yet.
      </p>
    );
  }
  return (
    <ul className="space-y-1 text-sm" data-testid="enemy-usage-list">
      {groupReferences(references).map((group) => (
        <li key={`${group.kind}:${group.key}`} data-testid="enemy-usage-row">
          <Badge variant="outline">{usageKindLabel(group.kind)}</Badge>{' '}
          {group.to ? (
            <Link to={group.to} className="text-accent underline">
              {group.title}
            </Link>
          ) : (
            <span className="text-ink">{group.title}</span>
          )}{' '}
          <span className="text-ink-muted">— {group.usages.join(', ')}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One of an enemy's two pictures: the uploaded one (select, upload, clear),
 * the file shipped with the game that stands in when nothing is uploaded, and
 * a line saying which of the two players see now.
 */
function EnemyArtSlot({
  label,
  testId,
  category,
  assetId,
  shippedPath,
  none,
  disabled,
  onChange,
}: {
  label: string;
  testId: string;
  category: 'enemy_art' | 'enemy_sprite';
  assetId: string | null;
  shippedPath: string | null;
  /** What it means to have neither, e.g. "no sprite". */
  none: string;
  disabled: boolean;
  onChange: (assetId: string | null) => void;
}) {
  // Shipped files are served by the dungeon artwork route; without it, the path alone is shown.
  const canPreviewShipped = useHasPermission('dungeons.read');
  return (
    <div className="space-y-2">
      <AssetField
        label={label}
        testId={testId}
        category={category}
        value={assetId}
        fallback={shippedPath ? `the shipped file ${shippedPath}` : none}
        disabled={disabled}
        onChange={onChange}
      />
      <p className="text-xs text-ink-muted" data-testid={`${testId}-in-effect`}>
        In effect:{' '}
        {assetId !== null
          ? 'the uploaded artwork above'
          : shippedPath
            ? 'the shipped file'
            : `nothing — ${none}`}
        .{' '}
        {shippedPath && (
          <>
            Shipped fallback: <span className="font-mono">{shippedPath}</span>
          </>
        )}
      </p>
      {assetId === null && shippedPath && canPreviewShipped && (
        <AuthoredArtwork
          source={shippedPath}
          load={dungeonArtworkBlob}
          testIdPrefix={`${testId}-shipped`}
          emptyLabel=""
          missingLabel={() => 'The shipped file is not on this server yet.'}
          alt={() => `${label} (shipped)`}
        />
      )}
    </div>
  );
}

function EnemyEditor({ enemyKey }: { enemyKey: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('enemies.write');
  const canBrowseArtwork = useHasPermission('artwork.read');
  const readOnly = !canWrite;

  const detailQuery = useQuery({
    queryKey: [...ENEMIES_QUERY_KEY, 'enemy', enemyKey],
    queryFn: ({ signal }) => getEnemy(enemyKey, signal),
  });

  const [form, setForm] = useState<EnemyForm | null>(null);
  const [loaded, setLoaded] = useState<EnemyDetail | null>(null);
  const [stale, setStale] = useState<EnemyStaleDetails | null>(null);
  /** The author is being asked whether to disable an enemy that is in use. */
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** Only for the scene preview; never saved. */
  const [previewBackground, setPreviewBackground] = useState<string | null>(null);

  const adopt = (detail: EnemyDetail) => {
    setLoaded(detail);
    setForm(formOf(detail));
    setStale(null);
    setConfirmingDisable(false);
    setConfirmingDelete(false);
  };
  useEffect(() => {
    if (detailQuery.data && loaded === null) adopt(detailQuery.data);
  }, [detailQuery.data, loaded]);

  const noteStale = (err: unknown) => {
    if (isPortalApiError(err) && err.code === 'ENEMY_STALE')
      setStale((err.details ?? {}) as EnemyStaleDetails);
  };
  const save = useMutation({
    mutationFn: () => updateEnemy(enemyKey, inputOf(form!), loaded!.revision),
    onSuccess: (detail) => {
      adopt(detail);
      queryClient.setQueryData([...ENEMIES_QUERY_KEY, 'enemy', enemyKey], detail);
      invalidateEnemyQueries(queryClient);
    },
    onError: noteStale,
    onSettled: () => setConfirmingDisable(false),
  });
  const remove = useMutation({
    mutationFn: () => deleteEnemy(enemyKey, loaded!.revision),
    onSuccess: () => {
      invalidateEnemyQueries(queryClient);
      navigate('/admin/enemies', { replace: true });
    },
    onError: noteStale,
  });

  const reload = async () => {
    const result = await detailQuery.refetch();
    if (result.data) adopt(result.data);
  };

  if (detailQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (detailQuery.isError) {
    return (
      <ErrorState
        title="Could not load the enemy"
        error={detailQuery.error}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }
  if (form === null || loaded === null) return <Skeleton className="h-64 w-full" />;

  const set = (patch: Partial<EnemyForm>) => setForm({ ...form, ...patch });
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(loaded));
  const problems = formErrors(form);
  /** What the server refused the last save for, shown beside the fields it names. */
  const refused: EnemyIssue[] =
    isPortalApiError(save.error) && save.error.code === 'ENEMY_INVALID'
      ? (((save.error.details ?? {}) as { issues?: EnemyIssue[] }).issues ?? [])
      : [];
  // The stored enemy's standing problems, until an edit of that field replaces them.
  const issues = [...loaded.issues, ...refused];
  const at = (...paths: string[]) => paths.flatMap((p) => issuesAt(issues, p));
  const elsewhere = issues.filter((i) => !SECTION_PATHS.some((p) => issuesAt([i], p).length > 0));

  const disablingInUse = loaded.enabled && !form.enabled && loaded.references.length > 0;
  const placement = form.spritePlacement ?? placementInEffect(null);
  const spriteShown = form.spriteAssetId !== null || loaded.spriteArtworkPath !== null;

  const inUse =
    isPortalApiError(remove.error) && remove.error.code === 'ENEMY_IN_USE'
      ? ((remove.error.details ?? {}) as { references?: EnemyReference[]; shipped?: boolean })
      : null;
  const changes = loaded.shipped ? shippedDiff(loaded, loaded.shipped) : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Enemy — ${loaded.name}`}
        description="Changes reach the next fight started. A dungeon run already started keeps the enemy it started with."
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/enemies">Back to enemies</Link>
          </Button>
        }
      />

      {stale && (
        <Card
          className="space-y-2 border-danger/40 p-4 text-sm"
          data-testid="stale-banner"
          role="alert"
        >
          <p className="font-medium text-danger">
            This enemy was changed by someone else since you opened it.
          </p>
          <p className="text-ink-muted">
            It is now at revision {stale.currentRevision ?? '?'}
            {stale.updatedBy ? ` (saved by ${stale.updatedBy})` : ''}. Your change was not applied.
            Reload to see their version — your unsaved edits on this page will be discarded.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
            Reload latest version
          </Button>
        </Card>
      )}

      {loaded.issues.length > 0 && (
        <Card className="space-y-1 p-4" data-testid="enemy-warnings">
          <h2 className="text-sm font-semibold uppercase text-ink-muted">Needs attention</h2>
          <EnemyIssues issues={loaded.issues} testId="enemy-warning-list" />
        </Card>
      )}

      <Section
        title="Basics"
        hint="What the enemy is called and whether it can be used."
        testId="enemy-basics"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-muted">
            Name
            <Input
              aria-label="Enemy name"
              className="w-64"
              value={form.name}
              disabled={readOnly}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <div className="text-xs text-ink-muted">
            Key
            <span className="block h-9 pt-2 font-mono text-sm text-ink" data-testid="enemy-key">
              {loaded.key}
            </span>
          </div>
          <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              aria-label="Enemy enabled"
              checked={form.enabled}
              disabled={readOnly}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>
        <p className="text-xs text-ink-subtle">
          The key is permanent — dungeons and trials refer to the enemy by it. A disabled enemy
          keeps every reference to it; it only cannot be newly picked.
        </p>
        <label className="block text-xs text-ink-muted">
          Description
          <textarea
            aria-label="Enemy description"
            className="mt-1 block min-h-20 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
            value={form.description}
            disabled={readOnly}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
        <TagInput value={form.tags} disabled={readOnly} onChange={(tags) => set({ tags })} />
        <EnemyIssues
          issues={[
            ...problems.filter((i) => i.path === 'name'),
            ...issuesAt(refused, 'name'),
            ...issuesAt(refused, 'description'),
            ...issuesAt(refused, 'enabled'),
            ...issuesAt(refused, 'tags'),
          ]}
          testId="enemy-basics-issues"
        />
      </Section>

      <Section
        title="Combat Stats"
        hint="How hard it hits, how much it shrugs off, how much it takes. These are the enemy’s own — every dungeon and trial that uses it fights these numbers."
        testId="enemy-combat-stats"
      >
        <StatFields form={form} disabled={readOnly} onChange={set} />
        <EnemyIssues
          issues={['attack', 'defense', 'hp'].flatMap((p) => issuesAt(refused, p))}
          testId="enemy-stat-issues"
        />
      </Section>

      <Section
        title="Artwork"
        hint="Two pictures. A dungeon fight shows the sprite over the room’s background, or the full artwork when there is no sprite."
        testId="enemy-artwork"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <EnemyArtSlot
            label="Full artwork"
            testId="enemy-art-asset"
            category="enemy_art"
            assetId={form.artworkAssetId}
            shippedPath={loaded.artworkPath}
            none="no full artwork"
            disabled={readOnly}
            onChange={(artworkAssetId) => set({ artworkAssetId })}
          />
          <EnemyArtSlot
            label="Transparent sprite"
            testId="enemy-sprite-asset"
            category="enemy_sprite"
            assetId={form.spriteAssetId}
            shippedPath={loaded.spriteArtworkPath}
            none="no sprite"
            disabled={readOnly}
            onChange={(spriteAssetId) => set({ spriteAssetId })}
          />
        </div>
        <EnemyIssues issues={at('artworkAssetId', 'spriteAssetId')} testId="enemy-artwork-issues" />
        {canBrowseArtwork && (
          <p className="text-xs text-ink-subtle">
            Uploads made here are kept in the{' '}
            <Link to="/admin/artwork" className="text-accent underline">
              Artwork Assets
            </Link>{' '}
            library, where an image can be replaced or renamed.
          </p>
        )}

        <div className="space-y-3 border-t border-border pt-3" data-testid="enemy-placement">
          <div>
            <h3 className="text-xs font-semibold uppercase text-ink-muted">
              Default sprite placement
            </h3>
            <p className="mt-1 text-xs text-ink-muted">
              Where the sprite stands in every scene, unless a room places it differently. Scale is
              the sprite’s height as a share of the scene’s.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              aria-label="Use default placement"
              checked={form.spritePlacement === null}
              disabled={readOnly}
              onChange={(e) =>
                set({ spritePlacement: e.target.checked ? null : placementInEffect(null) })
              }
            />
            Use default placement
          </label>
          {form.spritePlacement !== null && (
            <PlacementControls
              value={form.spritePlacement}
              disabled={readOnly}
              onChange={(spritePlacement) => set({ spritePlacement })}
            />
          )}
          <EnemyIssues
            issues={issuesAt(refused, 'spritePlacement')}
            testId="enemy-placement-issues"
          />
          <AssetField
            label="Preview background"
            testId="enemy-preview-background"
            category="dungeon_background"
            value={previewBackground}
            fallback="nothing — choose a background to see the scene. This is only for the preview and is not saved"
            disabled={false}
            onChange={setPreviewBackground}
          />
          {spriteShown ? (
            <ScenePreview
              background={previewBackground ? { assetId: previewBackground } : null}
              sprite={{ assetId: form.spriteAssetId, artworkPath: loaded.spriteArtworkPath }}
              placement={placement}
            />
          ) : (
            <p className="text-xs text-ink-subtle" data-testid="enemy-no-sprite">
              This enemy has no sprite, so there is no scene to preview.
            </p>
          )}
        </div>
      </Section>

      <Section
        title="Usage"
        hint="Everywhere this enemy is named. It is chosen in those places and edited only here."
        testId="enemy-usage"
      >
        <UsageList references={loaded.references} />
      </Section>

      <details
        className="rounded-lg border border-border bg-surface p-4"
        data-testid="enemy-advanced"
        {...(confirmingDelete || remove.isError ? { open: true } : {})}
      >
        <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Advanced
        </summary>
        <div className="mt-3 space-y-4">
          <div className="space-y-1 text-xs text-ink-muted" data-testid="enemy-provenance">
            <p className="flex flex-wrap items-center gap-2">
              Origin: <EnemyOriginBadge origin={loaded.origin} />
              <span className="text-ink">{ORIGIN_LABELS[loaded.origin]}</span>
            </p>
            <p data-testid="enemy-matches-shipped">
              {loaded.matchesShipped === null
                ? 'This build ships no enemy with this key — it exists only here until exported.'
                : loaded.matchesShipped
                  ? 'Matches the copy shipped with the game.'
                  : 'Differs from the copy shipped with the game. Deploys will not overwrite it.'}
            </p>
            <p>
              Revision {loaded.revision} · last updated {formatUpdated(loaded.updatedAt)}
              {loaded.updatedBy ? ` by ${loaded.updatedBy}` : ''}
            </p>
          </div>

          {changes.length > 0 && (
            <div className="space-y-1" data-testid="enemy-shipped-diff">
              <p className="text-xs font-medium text-ink-muted">Changed from the shipped copy</p>
              <ul className="space-y-0.5 text-xs text-ink-muted">
                {changes.map((change) => (
                  <li key={change.field}>
                    <span className="text-ink">{change.field}</span>: {change.shipped} →{' '}
                    <span className="text-ink">{change.current}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canWrite && (
            <div className="space-y-2" data-testid="enemy-delete">
              <p className="text-xs text-ink-muted">
                Deleting is for an enemy made by mistake. One that is used anywhere, or that ships
                with the game, cannot be deleted — disable it instead.
              </p>
              {!confirmingDelete ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete enemy…
                </Button>
              ) : (
                <div
                  className="space-y-2 rounded-lg border border-danger/40 p-3 text-sm"
                  role="alertdialog"
                  aria-label="Delete enemy"
                  data-testid="enemy-delete-confirm"
                >
                  <p className="text-ink">Delete {loaded.name} for good?</p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="accent"
                      disabled={remove.isPending || stale !== null}
                      onClick={() => remove.mutate()}
                    >
                      {remove.isPending ? 'Deleting…' : 'Delete enemy'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setConfirmingDelete(false);
                        remove.reset();
                      }}
                    >
                      Keep it
                    </Button>
                  </div>
                </div>
              )}
              {inUse && (
                <div
                  className="space-y-2 rounded-lg border border-danger/40 p-3 text-sm"
                  role="alert"
                  data-testid="enemy-delete-refused"
                >
                  <p className="font-medium text-danger">This enemy cannot be deleted.</p>
                  {(inUse.references ?? []).length > 0 && (
                    <>
                      <p className="text-xs text-ink-muted">It is still used here:</p>
                      <UsageList references={inUse.references ?? []} />
                    </>
                  )}
                  {inUse.shipped && (
                    <p className="text-xs text-ink-muted">
                      It ships with the game, so a deleted copy would come back on the next restart.
                    </p>
                  )}
                  <p className="text-xs text-ink">
                    Disable it instead: untick Enabled under Basics and save. Every reference is
                    kept, and nothing new can pick it.
                  </p>
                </div>
              )}
              {remove.isError && !inUse && !stale && (
                <ErrorState
                  variant="inline"
                  title="Could not delete the enemy"
                  error={remove.error}
                />
              )}
            </div>
          )}
        </div>
      </details>

      <Card className="space-y-3 p-4" data-testid="enemy-save">
        <EnemyIssues issues={elsewhere} testId="enemy-other-issues" />
        <p className="text-xs text-ink-muted" data-testid="enemy-save-status">
          {problems.length > 0
            ? `${problems.length} problem${problems.length === 1 ? '' : 's'} to fix before saving.`
            : dirty
              ? 'Ready to save.'
              : save.isSuccess
                ? 'Saved.'
                : 'No unsaved changes.'}
        </p>
        {save.isError && !stale && refused.length === 0 && (
          <ErrorState variant="inline" title="Could not save" error={save.error} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="accent"
            disabled={readOnly || save.isPending || !dirty || stale !== null || problems.length > 0}
            onClick={() =>
              // Something still names it: say what disabling does before doing it.
              disablingInUse ? setConfirmingDisable(true) : save.mutate()
            }
          >
            {save.isPending ? 'Saving…' : 'Save enemy'}
          </Button>
          {dirty && (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => {
                  setForm(formOf(loaded));
                  save.reset();
                }}
              >
                Discard changes
              </Button>
              <Badge variant="outline" data-testid="unsaved-badge">
                Unsaved changes
              </Badge>
            </>
          )}
          {readOnly && (
            <span className="text-xs text-ink-muted">You do not have write permission.</span>
          )}
        </div>
      </Card>

      <DisableEnemyDialog
        open={confirmingDisable}
        name={loaded.name}
        usageCount={loaded.references.length}
        pending={save.isPending}
        onConfirm={() => save.mutate()}
        onClose={() => setConfirmingDisable(false)}
      />
    </div>
  );
}
