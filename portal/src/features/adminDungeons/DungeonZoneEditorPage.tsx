/**
 * Admin — edit one dungeon.
 *
 * A dungeon is one document, and this page edits it in the order an author
 * thinks about it: what it is (name, where it is open, its cover and default
 * background), then how its rooms come to be — which depends on the layout
 * chosen when it was created:
 *
 *   - **Procedural** — the generator's settings ({@link ProceduralSettings}),
 *     with the tuning folded under Advanced;
 *   - **Room by room** — the rooms themselves ({@link AuthoredRoomsEditor}).
 *
 * Things an author rarely needs — the key, the list order, the shipped
 * artwork paths, changing the layout — sit under Internal details.
 *
 *   - **Validation is the server's.** Every change is sent to the dry-run
 *     `validate` route; its issues are shown against the part they name, and
 *     Save stays disabled while any is an error. The same checks run again in
 *     the save transaction.
 *   - **Saves are optimistic.** A save names the revision it loaded. If someone
 *     else saved first the server refuses with 409, and this page says so and
 *     offers a reload — it never overwrites.
 *   - **Nothing saves by itself.** Room edits, uploads and all change the
 *     draft; Save dungeon writes it, and leaving with unsaved changes warns.
 *
 * A save reaches the next run started. A run already started keeps the
 * dungeon it started with. New dungeons are made on the creation page.
 */
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  DUNGEONS_QUERY_KEY,
  dungeonArtworkBlob,
  getDungeonReference,
  getDungeonZone,
  layoutModeOf,
  previewDungeon,
  updateDungeonZone,
  validateDungeonZone,
  zoneArtworkConvention,
  zoneBackgroundConvention,
  type DungeonLayoutMode,
  type DungeonZoneDetail,
  type DungeonZoneDoc,
} from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import { AuthoredArtwork } from '@/components/media/AuthoredArtwork';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';
import { AssetField } from '@/features/adminArtwork/AssetField';
import { AuthoredRoomsEditor } from './AuthoredRoomsEditor';
import { DungeonGraphView } from './DungeonGraphView';
import { ProceduralSettings } from './ProceduralSettings';
import { RewardsSection } from './RewardsSection';
import { ZoneArtworkField } from './ZoneArtworkField';
import { ZoneOriginBadge } from './DungeonsListPage';
import {
  LAYOUT_MODE_LABELS,
  basisPointsToPercent,
  issuesAt,
  issuesOutside,
  parseTags,
  percentToBasisPoints,
  starterZone,
} from './dungeonModel';
import { Issues, NumberField, RegionChecks, Section } from './zoneFormParts';

/** Keyed by zone, so navigating between zones starts from a clean draft. */
export function DungeonZoneEditorPage() {
  const { key } = useParams<{ key: string }>();
  return <DungeonZoneEditor key={key} zoneKey={key ?? ''} />;
}

interface StaleInfo {
  currentRevision?: number;
  updatedBy?: string | null;
}

/** Every path prefix a section of this form shows issues for. */
const SECTION_PREFIXES = [
  'key',
  'name',
  'description',
  'order',
  'tags',
  'artworkPath',
  'backgroundArtworkPath',
  'artworkAssetId',
  'backgroundAssetId',
  'backgrounds',
  'availableRegions',
  'nodeSettings',
  'generation',
  'pools',
  'rewards',
  'authored',
  'layoutMode',
];

/** Warn before the tab is closed or reloaded with a draft that was never saved. */
function useUnsavedWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Some browsers only prompt when a value is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

/**
 * One of the two pictures every dungeon has. The author picks, uploads or
 * clears an image; whether it is an uploaded asset or a file shipped with the
 * game is not something they need to know — a shipped image simply shows as
 * what is in use until they choose another.
 */
function ZoneArtSlot({
  label,
  use,
  testId,
  category,
  assetId,
  shippedPath,
  disabled,
  onChange,
}: {
  label: string;
  /** Where the picture is used, in a sentence. */
  use: string;
  testId: string;
  category: 'dungeon_zone' | 'dungeon_background';
  assetId: string | null;
  shippedPath: string | null;
  disabled: boolean;
  onChange: (assetId: string | null) => void;
}) {
  return (
    <div className="space-y-2">
      <AssetField
        label={label}
        testId={testId}
        category={category}
        value={assetId}
        fallback={
          shippedPath ? 'the image shipped with the game' : 'no image, so screens show text'
        }
        disabled={disabled}
        onChange={onChange}
      />
      {assetId === null && shippedPath && (
        <AuthoredArtwork
          source={shippedPath}
          load={dungeonArtworkBlob}
          testIdPrefix={`${testId}-shipped`}
          emptyLabel=""
          missingLabel={() => 'The shipped image is not on this server yet.'}
          alt={() => `${label} (shipped)`}
        />
      )}
      <p className="text-xs text-ink-subtle">{use}</p>
    </div>
  );
}

function DungeonZoneEditor({ zoneKey }: { zoneKey: string }) {
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('dungeons.write');
  const readOnly = !canWrite;

  const detailQuery = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'zone', zoneKey],
    queryFn: ({ signal }) => getDungeonZone(zoneKey, signal),
  });
  const reference = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'reference'],
    queryFn: ({ signal }) => getDungeonReference(signal),
    staleTime: 60_000,
  }).data;

  const [form, setForm] = useState<DungeonZoneDoc | null>(null);
  const [loaded, setLoaded] = useState<DungeonZoneDetail | null>(null);
  const [stale, setStale] = useState<StaleInfo | null>(null);
  /** The author is being asked whether to change the layout mode. */
  const [confirmingLayout, setConfirmingLayout] = useState(false);

  const adopt = (detail: DungeonZoneDetail) => {
    setLoaded(detail);
    setForm(detail.zone);
    setStale(null);
    setConfirmingLayout(false);
  };
  useEffect(() => {
    if (detailQuery.data && loaded === null) adopt(detailQuery.data);
  }, [detailQuery.data, loaded]);

  // Server-side dry run of the draft. Deferred so typing stays responsive.
  const draft = useDeferredValue(form);
  const draftJson = useMemo(() => (draft ? JSON.stringify(draft) : ''), [draft]);
  const validation = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'validate', zoneKey, draftJson],
    queryFn: ({ signal }) => validateDungeonZone(draft!, zoneKey, signal),
    enabled: draft !== null,
    placeholderData: keepPreviousData,
  });
  const issues = validation.data?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  // Still checking while the deferred draft has not caught up with the form:
  // until then the issues on screen describe the edit before this one.
  const checking = validation.isFetching || draft !== form;

  const layoutChanged =
    form !== null && loaded !== null && layoutModeOf(form) !== layoutModeOf(loaded.zone);
  const save = useMutation({
    mutationFn: () =>
      // The server refuses a layout change that does not say it is one.
      layoutChanged
        ? updateDungeonZone(zoneKey, form!, loaded!.revision, { confirmLayoutChange: true })
        : updateDungeonZone(zoneKey, form!, loaded!.revision),
    onSuccess: (detail) => {
      adopt(detail);
      void queryClient.invalidateQueries({ queryKey: DUNGEONS_QUERY_KEY });
    },
    onError: (err) => {
      if (isPortalApiError(err) && err.code === 'DUNGEON_ZONE_STALE')
        setStale((err.details ?? {}) as StaleInfo);
    },
  });
  const draftPreview = useMutation({ mutationFn: () => previewDungeon({ zone: form! }) });

  const dirty =
    form !== null && loaded !== null && JSON.stringify(form) !== JSON.stringify(loaded.zone);
  useUnsavedWarning(dirty);

  const reload = async () => {
    const result = await detailQuery.refetch();
    if (result.data) adopt(result.data);
  };

  if (detailQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (detailQuery.isError) {
    return (
      <ErrorState
        title="Could not load the dungeon"
        error={detailQuery.error}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }
  if (form === null) return <Skeleton className="h-64 w-full" />;

  const set = (patch: Partial<DungeonZoneDoc>) => setForm({ ...form, ...patch });
  const mode = layoutModeOf(form);
  const authored = mode === 'authored';
  const otherMode: DungeonLayoutMode = authored ? 'procedural' : 'authored';

  /** Switch the draft to the other layout. Nothing is thrown away: both halves stay in the document. */
  const switchLayout = () => {
    const hasRooms = (form.authored?.rooms.length ?? 0) > 0;
    setForm({
      ...form,
      layoutMode: otherMode,
      // Going room-by-room for the first time: start from the same four rooms a new dungeon gets.
      ...(otherMode === 'authored' && !hasRooms
        ? {
            authored: starterZone(
              { name: form.name, key: form.key, regions: [], layoutMode: 'authored' },
              { enemies: reference?.enemies ?? [] },
            ).authored!,
          }
        : {}),
    });
    setConfirmingLayout(false);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Dungeon — ${loaded?.name ?? zoneKey}`}
        description="Changes reach the next run started. A run already started keeps the dungeon it started with."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to={`/admin/dungeons/preview?zone=${encodeURIComponent(zoneKey)}`}>
                Preview dungeon
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/admin/dungeons">Back to dungeons</Link>
            </Button>
          </div>
        }
      />

      {stale && (
        <Card
          className="space-y-2 border-danger/40 p-4 text-sm"
          data-testid="stale-banner"
          role="alert"
        >
          <p className="font-medium text-danger">
            Someone else saved this dungeon since you opened it.
          </p>
          <p className="text-ink-muted">
            It is now at revision {stale.currentRevision ?? '?'}
            {stale.updatedBy ? ` (saved by ${stale.updatedBy})` : ''}. Your save was not applied.
            Reload to see their version — your unsaved edits on this page will be discarded.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
            Reload latest version
          </Button>
        </Card>
      )}

      <Section
        title="Basics"
        hint="What the dungeon is called, whether players can see it, and where it is open."
        testId="zone-fields"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-muted">
            Name
            <Input
              aria-label="Zone name"
              className="w-64"
              value={form.name}
              disabled={readOnly}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              aria-label="Zone enabled"
              checked={form.enabled}
              disabled={readOnly}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Enabled
          </label>
          <Badge variant="outline" data-testid="zone-layout-mode">
            {LAYOUT_MODE_LABELS[mode]}
          </Badge>
        </div>
        <label className="block text-xs text-ink-muted">
          Description
          <textarea
            aria-label="Zone description"
            className="mt-1 block min-h-20 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
            value={form.description}
            disabled={readOnly}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
        <div className="space-y-2" data-testid="zone-availability">
          <RegionChecks
            regions={reference?.regions ?? []}
            value={form.availableRegions ?? []}
            disabled={readOnly}
            onChange={(availableRegions) => set({ availableRegions })}
          />
          <p className="text-xs text-ink-subtle">
            A player must be standing in one of these regions to start a run. A run already started
            is playable wherever they travel afterwards.
          </p>
          {loaded?.regionBackfill === 'all_enabled_regions' && (
            <p className="text-xs text-danger" role="status" data-testid="region-backfill-notice">
              This zone was made before regions existed, so it was opened in every released region
              to keep it available. Choose the regions it belongs in and save.
            </p>
          )}
          <Issues issues={issuesAt(issues, 'availableRegions')} />
        </div>
        <label className="block text-xs text-ink-muted">
          Tags (comma separated)
          <Input
            aria-label="Zone tags"
            // Uncontrolled so a half-typed list is not normalised mid-keystroke;
            // keyed so a reload or discard shows the adopted tags.
            key={form.tags.join(',')}
            defaultValue={form.tags.join(', ')}
            disabled={readOnly}
            onBlur={(e) => set({ tags: parseTags(e.target.value) })}
          />
        </label>
        <p className="text-xs text-ink-subtle">
          The daily run limit and the progression currency are shared by every dungeon — they are
          set on the{' '}
          <Link to="/admin/dungeons" className="text-accent underline">
            Dungeons page
          </Link>
          .
        </p>
        <Issues issues={['name', 'description', 'tags'].flatMap((p) => issuesAt(issues, p))} />
      </Section>

      <Section
        title="Artwork"
        hint="Two pictures cover the whole dungeon. Rooms use the default background unless one is given its own."
        testId="zone-artwork"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <ZoneArtSlot
            label="Zone cover"
            use="Shown where players choose a dungeon and start a run."
            testId="zone-artwork-asset"
            category="dungeon_zone"
            assetId={form.artworkAssetId ?? null}
            shippedPath={form.artworkPath}
            disabled={readOnly}
            onChange={(artworkAssetId) => set({ artworkAssetId })}
          />
          <ZoneArtSlot
            label="Default background"
            use="Used by every room that has no background of its own."
            testId="zone-background-asset"
            category="dungeon_background"
            assetId={form.backgroundAssetId ?? null}
            shippedPath={form.backgroundArtworkPath}
            disabled={readOnly}
            onChange={(backgroundAssetId) => set({ backgroundAssetId })}
          />
        </div>
        <Issues
          issues={['artworkAssetId', 'backgroundAssetId'].flatMap((p) => issuesAt(issues, p))}
        />
      </Section>

      {authored ? (
        <>
          <AuthoredRoomsEditor
            form={form}
            set={set}
            issues={issues}
            reference={reference}
            readOnly={readOnly}
          />
          <Section
            title="Rest"
            hint="What a Rest room heals unless the room sets its own."
            testId="zone-rest"
          >
            <NumberField
              label="Rest heals (% of max HP)"
              step={0.01}
              className="w-44"
              value={basisPointsToPercent(form.nodeSettings?.rest.healBasisPoints ?? 3000)}
              disabled={readOnly}
              onChange={(percent) =>
                set({ nodeSettings: { rest: { healBasisPoints: percentToBasisPoints(percent) } } })
              }
            />
            <Issues issues={issuesAt(issues, 'nodeSettings')} />
          </Section>
          <RewardsSection
            form={form}
            set={set}
            issues={issues}
            reference={reference}
            readOnly={readOnly}
            authored
          />
        </>
      ) : (
        <ProceduralSettings
          form={form}
          set={set}
          issues={issues}
          reference={reference}
          readOnly={readOnly}
        />
      )}

      <details
        className="rounded-lg border border-border bg-surface p-4"
        data-testid="zone-internal"
        {...(['key', 'order', 'artworkPath', 'backgroundArtworkPath', 'layoutMode'].some(
          (p) => issuesAt(issues, p).length > 0,
        ) || confirmingLayout
          ? { open: true }
          : {})}
      >
        <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Internal details
        </summary>
        <div className="mt-3 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="text-xs text-ink-muted">
              Key
              <span className="block h-9 pt-2 font-mono text-sm text-ink" data-testid="zone-key">
                {form.key}
              </span>
            </div>
            <NumberField
              label="Order"
              value={form.order}
              disabled={readOnly}
              onChange={(order) => set({ order })}
            />
            {loaded && <ZoneOriginBadge summary={loaded} />}
          </div>
          <p className="text-xs text-ink-subtle">
            The key is permanent — runs record it. Order sorts the dungeon list, lowest first.
          </p>
          <Issues issues={['key', 'order'].flatMap((p) => issuesAt(issues, p))} />

          <div className="space-y-2" data-testid="zone-layout-change">
            <p className="text-xs text-ink-muted">
              Layout: <span className="text-ink">{LAYOUT_MODE_LABELS[mode]}</span>
              {layoutChanged && ' — changed, not saved yet'}
            </p>
            {!readOnly && !confirmingLayout && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirmingLayout(true)}
              >
                Change layout to {LAYOUT_MODE_LABELS[otherMode].toLowerCase()}…
              </Button>
            )}
            {confirmingLayout && (
              <div
                className="space-y-2 rounded-lg border border-danger/40 p-3 text-sm"
                role="alertdialog"
                aria-label="Change layout"
                data-testid="layout-change-confirm"
              >
                <p className="text-ink">
                  Change this dungeon from {LAYOUT_MODE_LABELS[mode].toLowerCase()} to{' '}
                  {LAYOUT_MODE_LABELS[otherMode].toLowerCase()}?
                </p>
                <p className="text-xs text-ink-muted">
                  {otherMode === 'authored'
                    ? 'Runs will walk rooms you build by hand instead of being generated. The generator settings and pools are kept, unused, so you can change back.'
                    : 'Runs will be generated from the generator settings instead of walking your rooms. The rooms are kept, unused, so you can change back.'}{' '}
                  Nothing changes for players until you save.
                </p>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="accent" onClick={switchLayout}>
                    Change layout
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmingLayout(false)}
                  >
                    Keep {LAYOUT_MODE_LABELS[mode].toLowerCase()}
                  </Button>
                </div>
              </div>
            )}
            <Issues issues={issuesAt(issues, 'layoutMode')} />
          </div>

          <div className="space-y-2">
            <p className="text-xs text-ink-muted">
              Shipped artwork — files deployed with the game, used when no image is uploaded above.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <ZoneArtworkField
                label="Artwork"
                testId="zone-artwork-main"
                value={form.artworkPath}
                expectedPath={zoneArtworkConvention(form.key)}
                disabled={readOnly}
                onChange={(artworkPath) => set({ artworkPath })}
              />
              <ZoneArtworkField
                label="Background artwork"
                testId="zone-artwork-background"
                value={form.backgroundArtworkPath}
                expectedPath={zoneBackgroundConvention(form.key)}
                disabled={readOnly}
                onChange={(backgroundArtworkPath) => set({ backgroundArtworkPath })}
              />
            </div>
            <Issues
              issues={['artworkPath', 'backgroundArtworkPath'].flatMap((p) => issuesAt(issues, p))}
            />
          </div>
        </div>
      </details>

      <Card className="space-y-3 p-4" data-testid="zone-save">
        {validation.isError && (
          <ErrorState
            variant="inline"
            title="Could not check the dungeon"
            error={validation.error}
          />
        )}
        <Issues
          issues={[
            ...issuesAt(issues, 'generation').filter((i) => i.path === 'generation'),
            ...issuesOutside(issues, SECTION_PREFIXES),
          ]}
        />
        <p className="text-xs text-ink-muted" data-testid="validation-status">
          {checking
            ? 'Checking…'
            : errors.length > 0
              ? `${errors.length} problem${errors.length === 1 ? '' : 's'} to fix before saving.`
              : dirty
                ? 'Ready to save.'
                : 'No unsaved changes.'}
        </p>
        {save.isError && !stale && (
          <ErrorState variant="inline" title="Could not save" error={save.error} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="accent"
            disabled={
              readOnly ||
              save.isPending ||
              !dirty ||
              stale !== null ||
              errors.length > 0 ||
              checking
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save dungeon'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={draftPreview.isPending}
            onClick={() => draftPreview.mutate()}
          >
            {draftPreview.isPending ? 'Building…' : 'Preview this draft'}
          </Button>
          {dirty && (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => loaded && adopt(loaded)}
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
        {draftPreview.isError && (
          <ErrorState
            variant="inline"
            title={
              authored
                ? 'This draft’s rooms do not form a dungeon yet'
                : 'This draft could not generate a run'
            }
            error={draftPreview.error}
          />
        )}
        {draftPreview.data && <DungeonGraphView preview={draftPreview.data} />}
      </Card>
    </div>
  );
}
