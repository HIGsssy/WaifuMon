/**
 * Admin — edit one dungeon zone.
 *
 * The draft is the zone document itself (the shape `dungeons/zones.json`
 * holds). Four parts, top to bottom: what the zone is, how a run is shaped
 * (weights say what the generator prefers; constraints say what is legal),
 * the pools it draws content from, and what it pays.
 *
 *   - **Validation is the server's.** Every change is sent to the dry-run
 *     `validate` route, which also trial-generates runs; its issues are shown
 *     against the part they name, and Save stays disabled while any is an
 *     error. The same checks run again in the save transaction.
 *   - **Saves are optimistic.** A save names the revision it loaded. If someone
 *     else saved first the server refuses with 409, and this page says so and
 *     offers a reload — it never overwrites.
 *   - **The key is permanent.** It is chosen when the zone is created and
 *     shown read-only afterwards: runs record it.
 *
 * A save reaches the next run generated. A run already generated keeps the
 * zone it started with.
 */
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  DUNGEONS_QUERY_KEY,
  DUNGEON_NODE_TYPES,
  DUNGEON_POOL_KEYS,
  DUNGEON_WEIGHTED_NODE_TYPES,
  NO_REST_RULES,
  createDungeonZone,
  getDungeonReference,
  getDungeonZone,
  previewDungeon,
  updateDungeonZone,
  validateDungeonZone,
  zoneArtworkConvention,
  zoneBackgroundConvention,
  type AmountRange,
  type DepthRange,
  type DungeonBonusDoc,
  type DungeonContentRef,
  type DungeonExtractionWindow,
  type DungeonGenerationDoc,
  type DungeonNodeType,
  type DungeonPoolEntryDoc,
  type DungeonPoolKey,
  type DungeonReferenceData,
  type DungeonRegionRef,
  type DungeonRestRules,
  type DungeonRewardBandDoc,
  type DungeonZoneDetail,
  type DungeonZoneDoc,
  type DungeonZoneIssue,
} from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { useHasPermission } from '@/auth/useSession';
import { AssetField } from '@/features/adminArtwork/AssetField';
import { selectClass } from '@/features/adminEncounters/EntitySelect';
import { DungeonGraphView } from './DungeonGraphView';
import { ZoneArtworkField } from './ZoneArtworkField';
import { ZoneBackgroundPool, ZoneScenePreview } from './ZoneBackgroundPool';
import { ZoneOriginBadge } from './DungeonsListPage';
import {
  DUNGEON_KEY_PATTERN,
  NODE_TYPE_LABELS,
  POOL_LABELS,
  basisPointsToPercent,
  intOrNull,
  issuesAt,
  issuesOutside,
  newPoolEntry,
  newRewardBand,
  newZone,
  parseTags,
  percentToBasisPoints,
} from './dungeonModel';

/** Keyed by zone, so navigating between zones starts from a clean draft. */
export function DungeonZoneEditorPage() {
  const { key } = useParams<{ key?: string }>();
  return <DungeonZoneEditor key={key ?? 'new'} zoneKey={key} />;
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
];

function Issues({ issues }: { issues: DungeonZoneIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-xs" data-testid="zone-issues">
      {issues.map((i) => (
        <li
          key={`${i.path}:${i.message}`}
          className={i.severity === 'error' ? 'text-danger' : 'text-ink-muted'}
        >
          {i.severity === 'error' ? '' : '⚠ '}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  hint,
  testId,
  children,
}: {
  title: string;
  hint?: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Card className="space-y-3 p-4" data-testid={testId}>
      <div>
        <h2 className="text-sm font-semibold uppercase text-ink-muted">{title}</h2>
        {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

/**
 * A required number. The field keeps what was typed while it has focus, so it
 * can be cleared and retyped; the draft only changes when the text is a
 * number, and an abandoned empty field shows the draft's value again on blur.
 */
function NumberField({
  label,
  value,
  onChange,
  disabled,
  min = 0,
  step,
  className = 'w-24',
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  disabled: boolean;
  min?: number;
  step?: number;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <Input
        type="number"
        min={min}
        step={step}
        aria-label={label}
        className={className}
        value={text ?? value}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const n = Number(raw);
          if (raw.trim() !== '' && Number.isFinite(n)) onChange(step ? n : Math.trunc(n));
        }}
        onBlur={() => setText(null)}
      />
    </label>
  );
}

/**
 * Where guaranteed extraction points go. Each window holds one main-path
 * extraction node between its depths; an optional window is skipped in a run
 * too short to have room for it.
 */
function ExtractionWindows({
  windows,
  readOnly,
  onChange,
}: {
  windows: DungeonExtractionWindow[];
  readOnly: boolean;
  onChange: (next: DungeonExtractionWindow[]) => void;
}) {
  const update = (i: number, patch: Partial<DungeonExtractionWindow>) =>
    onChange(windows.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <div className="space-y-2" data-testid="extraction-windows">
      <p className="text-xs text-ink-muted">
        Extraction windows — each guarantees one extraction point on the main path between its
        depths. With none, guaranteed points land at any depth from the extraction depth.
      </p>
      {windows.map((w, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3">
          <NumberField
            label={`Window ${i + 1} min depth`}
            min={1}
            value={w.minDepth}
            disabled={readOnly}
            onChange={(minDepth) => update(i, { minDepth })}
          />
          <OptionalNumberField
            label={`Window ${i + 1} max depth`}
            value={w.maxDepth}
            disabled={readOnly}
            onChange={(maxDepth) => update(i, { maxDepth })}
          />
          <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              aria-label={`Window ${i + 1} required in every run`}
              checked={w.required}
              disabled={readOnly}
              onChange={(e) => update(i, { required: e.target.checked })}
            />
            Required in every run
          </label>
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove window ${i + 1}`}
              onClick={() => onChange(windows.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {!readOnly && windows.length < 5 && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange([...windows, { minDepth: 1, maxDepth: null, required: false }])}
        >
          Add extraction window
        </Button>
      )}
    </div>
  );
}

/**
 * The regions a zone is open in, as checkboxes: names shown, stable ids stored,
 * in the catalogue's order. An id the catalogue no longer has stays visible
 * (and checked) so it can be seen and removed rather than silently carried.
 */
function RegionChecks({
  regions,
  value,
  onChange,
  disabled,
}: {
  regions: DungeonRegionRef[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const unknown = value.filter((id) => !regions.some((r) => r.id === id));
  const options = [
    ...regions,
    ...unknown.map((id) => ({ id, name: id, enabled: true, unknown: true })),
  ];
  return (
    <fieldset className="text-xs text-ink-muted" data-testid="region-checks">
      <legend>Available in</legend>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {options.map((region) => (
          <label key={region.id} className="flex items-center gap-1 text-sm text-ink">
            <input
              type="checkbox"
              aria-label={`Available in ${region.name}`}
              checked={value.includes(region.id)}
              disabled={disabled}
              onChange={(e) =>
                // Kept in catalogue order, so a toggle never reorders the document.
                onChange(
                  options
                    .map((r) => r.id)
                    .filter((id) => (id === region.id ? e.target.checked : value.includes(id))),
                )
              }
            />
            {region.name}
            {'unknown' in region && <span className="text-xs text-danger">(unknown region)</span>}
            {!region.enabled && <span className="text-xs text-ink-subtle">(not released)</span>}
          </label>
        ))}
      </div>
      {value.length === 0 && (
        <p className="mt-2 text-xs text-ink-subtle">
          No region selected — the zone cannot be started anywhere.
        </p>
      )}
    </fieldset>
  );
}

/** An optional depth or count: empty means "no limit". */
function OptionalNumberField({
  label,
  value,
  onChange,
  disabled,
  placeholder = 'no limit',
  min = 1,
}: {
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
  disabled: boolean;
  placeholder?: string;
  min?: number;
}) {
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <Input
        type="number"
        min={min}
        aria-label={label}
        className="w-24"
        placeholder={placeholder}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(intOrNull(e.target.value))}
      />
    </label>
  );
}

function TypeChecks({
  label,
  value,
  onChange,
  disabled,
  types = DUNGEON_NODE_TYPES,
}: {
  label: string;
  value: DungeonNodeType[];
  onChange: (next: DungeonNodeType[]) => void;
  disabled: boolean;
  types?: readonly DungeonNodeType[];
}) {
  return (
    <fieldset className="text-xs text-ink-muted">
      <legend>{label}</legend>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {types.map((type) => (
          <label key={type} className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={`${label}: ${NODE_TYPE_LABELS[type]}`}
              checked={value.includes(type)}
              disabled={disabled}
              onChange={(e) =>
                // Kept in vocabulary order so a toggle never reorders the document.
                onChange(types.filter((t) => (t === type ? e.target.checked : value.includes(t))))
              }
            />
            {NODE_TYPE_LABELS[type]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RangeFields({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: AmountRange;
  onChange: (next: AmountRange) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-end gap-2">
      <NumberField
        label={`${label} min`}
        value={value.min}
        disabled={disabled}
        onChange={(min) => onChange({ ...value, min })}
      />
      <NumberField
        label={`${label} max`}
        value={value.max}
        disabled={disabled}
        onChange={(max) => onChange({ ...value, max })}
      />
    </div>
  );
}

function TableSelect({
  label,
  value,
  onChange,
  disabled,
  tables,
}: {
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
  disabled: boolean;
  tables: DungeonReferenceData['rewardTables'];
}) {
  const known = value === null || tables.some((t) => t.id === value);
  return (
    <label className="text-xs text-ink-muted">
      {label}
      <select
        aria-label={label}
        className={selectClass}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">None</option>
        {!known && <option value={value ?? ''}>{value} (unknown)</option>}
        {tables.map((t) => (
          <option key={t.id} value={t.id}>
            {t.id}
            {t.enabled ? '' : ' (disabled)'}
          </option>
        ))}
      </select>
    </label>
  );
}

function DungeonZoneEditor({ zoneKey }: { zoneKey: string | undefined }) {
  const isNew = zoneKey === undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('dungeons.write');
  const readOnly = !canWrite;

  const detailQuery = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'zone', zoneKey],
    queryFn: ({ signal }) => getDungeonZone(zoneKey!, signal),
    enabled: !isNew,
  });
  const reference = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'reference'],
    queryFn: ({ signal }) => getDungeonReference(signal),
    staleTime: 60_000,
  }).data;

  const [form, setForm] = useState<DungeonZoneDoc | null>(isNew ? newZone() : null);
  const [loaded, setLoaded] = useState<DungeonZoneDetail | null>(null);
  const [stale, setStale] = useState<StaleInfo | null>(null);

  const adopt = (detail: DungeonZoneDetail) => {
    setLoaded(detail);
    setForm(detail.zone);
    setStale(null);
  };
  useEffect(() => {
    if (detailQuery.data && loaded === null) adopt(detailQuery.data);
  }, [detailQuery.data, loaded]);

  // Server-side dry run of the draft. Deferred so typing stays responsive.
  const draft = useDeferredValue(form);
  const draftJson = useMemo(() => (draft ? JSON.stringify(draft) : ''), [draft]);
  const keyUsable = draft !== null && DUNGEON_KEY_PATTERN.test(draft.key);
  const validation = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'validate', zoneKey ?? '', draftJson],
    queryFn: ({ signal }) => validateDungeonZone(draft!, zoneKey, signal),
    enabled: keyUsable,
    placeholderData: keepPreviousData,
  });
  const issues = validation.data?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');

  const save = useMutation({
    mutationFn: () =>
      isNew ? createDungeonZone(form!) : updateDungeonZone(zoneKey, form!, loaded!.revision),
    onSuccess: (detail) => {
      adopt(detail);
      void queryClient.invalidateQueries({ queryKey: DUNGEONS_QUERY_KEY });
      if (isNew)
        navigate(`/admin/dungeons/zones/${encodeURIComponent(detail.key)}`, { replace: true });
    },
    onError: (err) => {
      if (isPortalApiError(err) && err.code === 'DUNGEON_ZONE_STALE')
        setStale((err.details ?? {}) as StaleInfo);
    },
  });
  const draftPreview = useMutation({ mutationFn: () => previewDungeon({ zone: form! }) });

  const reload = async () => {
    const result = await detailQuery.refetch();
    if (result.data) adopt(result.data);
  };

  if (!isNew && detailQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (!isNew && detailQuery.isError) {
    return (
      <ErrorState
        title="Could not load dungeon zone"
        error={detailQuery.error}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }
  if (form === null) return <Skeleton className="h-64 w-full" />;

  const dirty = isNew || (loaded !== null && JSON.stringify(form) !== JSON.stringify(loaded.zone));
  const set = (patch: Partial<DungeonZoneDoc>) => setForm({ ...form, ...patch });
  const gen = form.generation;
  const setGen = (patch: Partial<DungeonGenerationDoc>) =>
    set({ generation: { ...gen, ...patch } });
  const setRewards = (patch: Partial<DungeonZoneDoc['rewards']>) =>
    set({ rewards: { ...form.rewards, ...patch } });
  const setPool = (pool: DungeonPoolKey, entries: DungeonPoolEntryDoc[]) =>
    set({ pools: { ...form.pools, [pool]: entries } });
  const tables = reference?.rewardTables ?? [];
  const rest = gen.rest ?? NO_REST_RULES;
  const setRest = (patch: Partial<DungeonRestRules>) => setGen({ rest: { ...rest, ...patch } });

  const setDepthRange = (type: DungeonNodeType, patch: Partial<DepthRange>) => {
    const next = { minDepth: 1, maxDepth: null, ...gen.depthRanges[type], ...patch };
    const { [type]: _removed, ...rest } = gen.depthRanges;
    // "Anywhere" is the absence of a range, not a range of 1..∞.
    setGen({
      depthRanges: next.minDepth === 1 && next.maxDepth === null ? rest : { ...rest, [type]: next },
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={isNew ? 'New dungeon zone' : `Dungeon zone — ${loaded?.name ?? zoneKey}`}
        description="Changes reach the next run generated. A run already generated keeps the zone it started with."
        actions={
          <div className="flex flex-wrap gap-2">
            {!isNew && (
              <Button variant="outline" asChild>
                <Link to={`/admin/dungeons/preview?zone=${encodeURIComponent(zoneKey)}`}>
                  Preview saved zone
                </Link>
              </Button>
            )}
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
            Someone else saved this zone since you opened it.
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
        hint="What the zone is called and whether players can see it. Where it is open, its artwork and how its runs are generated are below."
        testId="zone-fields"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-muted">
            Key
            {isNew ? (
              <Input
                aria-label="Zone key"
                className="w-64 font-mono"
                placeholder="lower_snake_case"
                value={form.key}
                disabled={readOnly}
                onChange={(e) => set({ key: e.target.value })}
              />
            ) : (
              <span className="block h-9 pt-2 font-mono text-sm text-ink" data-testid="zone-key">
                {form.key}
              </span>
            )}
          </label>
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
          <NumberField
            label="Order"
            value={form.order}
            disabled={readOnly}
            onChange={(order) => set({ order })}
          />
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
          {loaded && <ZoneOriginBadge summary={loaded} />}
        </div>
        {isNew && (
          <p className="text-xs text-ink-subtle">
            The key cannot be changed after the zone is created — runs record it.
          </p>
        )}
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
        <Issues
          issues={['key', 'name', 'description', 'order', 'tags'].flatMap((p) =>
            issuesAt(issues, p),
          )}
        />
      </Section>

      <Section
        title="Availability"
        hint="The regions a player must be standing in to see this zone and start a run. A run already started is playable wherever they travel afterwards."
        testId="zone-availability"
      >
        <RegionChecks
          regions={reference?.regions ?? []}
          value={form.availableRegions ?? []}
          disabled={readOnly}
          onChange={(availableRegions) => set({ availableRegions })}
        />
        {loaded?.regionBackfill === 'all_enabled_regions' && (
          <p className="text-xs text-danger" role="status" data-testid="region-backfill-notice">
            This zone was made before regions existed, so it was opened in every released region to
            keep it available. Choose the regions it belongs in and save.
          </p>
        )}
        <Issues issues={issuesAt(issues, 'availableRegions')} />
      </Section>

      <Section
        title="Zone Artwork"
        hint="Shown on the Delve screens. Uploaded artwork wins over the shipped file while it is active; clear it to fall back to the shipped path, then to text only."
        testId="zone-artwork"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <AssetField
              label="Zone artwork"
              testId="zone-artwork-asset"
              category="dungeon_zone"
              value={form.artworkAssetId ?? null}
              fallback={
                form.artworkPath ? `the shipped file ${form.artworkPath}` : 'the shipped path below'
              }
              disabled={readOnly}
              onChange={(artworkAssetId) => set({ artworkAssetId })}
            />
            <ZoneArtworkField
              label="Artwork"
              testId="zone-artwork-main"
              value={form.artworkPath}
              expectedPath={zoneArtworkConvention(form.key)}
              disabled={readOnly}
              onChange={(artworkPath) => set({ artworkPath })}
            />
          </div>
          <div className="space-y-3">
            <AssetField
              label="Zone background"
              testId="zone-background-asset"
              category="dungeon_background"
              value={form.backgroundAssetId ?? null}
              fallback={
                form.backgroundArtworkPath
                  ? `the shipped file ${form.backgroundArtworkPath}`
                  : 'the shipped path below'
              }
              disabled={readOnly}
              onChange={(backgroundAssetId) => set({ backgroundAssetId })}
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
        </div>
        <Issues
          issues={[
            'artworkPath',
            'backgroundArtworkPath',
            'artworkAssetId',
            'backgroundAssetId',
          ].flatMap((p) => issuesAt(issues, p))}
        />
      </Section>

      <Section
        title="Background Pool"
        hint="Backgrounds this zone’s rooms are drawn against. Each node of a run draws one by weight from those covering its depth, once, when the run is generated."
        testId="zone-backgrounds"
      >
        <ZoneBackgroundPool
          backgrounds={form.backgrounds ?? []}
          issues={issues}
          readOnly={readOnly}
          onChange={(backgrounds) => set({ backgrounds })}
        />
        <Issues issues={issues.filter((i) => i.path === 'backgrounds')} />
      </Section>

      <Section
        title="Scene Rules"
        hint="What a Delve screen shows, first match wins."
        testId="zone-scene-rules"
      >
        <div className="grid gap-4 text-xs text-ink-muted md:grid-cols-2">
          <div>
            <p className="font-medium text-ink">A fight</p>
            <ol className="ml-4 list-decimal space-y-0.5">
              <li>The node’s background with the enemy’s sprite over it</li>
              <li>The enemy’s full artwork</li>
              <li>The node’s background on its own</li>
              <li>The zone artwork, then the zone background</li>
              <li>Text only</li>
            </ol>
          </div>
          <div>
            <p className="font-medium text-ink">Event, rest, reward, exit</p>
            <ol className="ml-4 list-decimal space-y-0.5">
              <li>The event’s own artwork</li>
              <li>The node’s background on its own</li>
              <li>The zone artwork, then the zone background</li>
              <li>Text only</li>
            </ol>
          </div>
        </div>
        <p className="text-xs text-ink-muted">
          Sprites and where they stand are set per enemy under{' '}
          <Link to="/admin/dungeons/enemies" className="text-accent underline">
            Enemy Artwork
          </Link>
          . A run keeps the backgrounds, sprites and placement it started with.
        </p>
        <ZoneScenePreview zone={form} />
      </Section>

      <Section
        title="Layout"
        hint="How long a generated run is, whether it ends on a boss, and how often it forks. Every run is generated fresh inside these limits."
        testId="zone-shape"
      >
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            label="Min nodes"
            min={2}
            value={gen.minNodes}
            disabled={readOnly}
            onChange={(minNodes) => setGen({ minNodes })}
          />
          <NumberField
            label="Max nodes"
            min={2}
            value={gen.maxNodes}
            disabled={readOnly}
            onChange={(maxNodes) => setGen({ maxNodes })}
          />
          <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              aria-label="Final boss required"
              checked={gen.boss.required}
              disabled={readOnly}
              onChange={(e) => setGen({ boss: { required: e.target.checked } })}
            />
            Ends on a boss
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            label="Min branches"
            value={gen.branching.minBranches}
            disabled={readOnly}
            onChange={(minBranches) => setGen({ branching: { ...gen.branching, minBranches } })}
          />
          <NumberField
            label="Max branches"
            value={gen.branching.maxBranches}
            disabled={readOnly}
            onChange={(maxBranches) => setGen({ branching: { ...gen.branching, maxBranches } })}
          />
          <NumberField
            label="Branch chance (%)"
            step={0.01}
            className="w-32"
            value={basisPointsToPercent(gen.branching.chanceBasisPoints)}
            disabled={readOnly}
            onChange={(percent) =>
              setGen({
                branching: { ...gen.branching, chanceBasisPoints: percentToBasisPoints(percent) },
              })
            }
          />
          <NumberField
            label="Max branch length"
            min={1}
            className="w-32"
            value={gen.branching.maxLength}
            disabled={readOnly}
            onChange={(maxLength) => setGen({ branching: { ...gen.branching, maxLength } })}
          />
        </div>
        <Issues
          issues={[
            'generation.minNodes',
            'generation.maxNodes',
            'generation.branching',
            'generation.boss',
          ].flatMap((p) => issuesAt(issues, p))}
        />
      </Section>

      <Section
        title="Extraction"
        hint="Where a player may leave with what they carry. A node offers extraction when it is deep enough and of a checked type — a Rest that also offers extraction and a bare Exit are both possible, and independent of the Rest rules below."
        testId="zone-extraction"
      >
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            label="Extraction from depth"
            min={1}
            className="w-36"
            value={gen.extraction.minDepth}
            disabled={readOnly}
            onChange={(minDepth) => setGen({ extraction: { ...gen.extraction, minDepth } })}
          />
          <NumberField
            label="Guaranteed extraction points"
            className="w-44"
            value={gen.extraction.minPoints}
            disabled={readOnly}
            onChange={(minPoints) => setGen({ extraction: { ...gen.extraction, minPoints } })}
          />
        </div>
        <TypeChecks
          label="Extraction offered at"
          value={gen.extraction.nodeTypes}
          disabled={readOnly}
          types={DUNGEON_WEIGHTED_NODE_TYPES}
          onChange={(nodeTypes) => setGen({ extraction: { ...gen.extraction, nodeTypes } })}
        />
        <ExtractionWindows
          windows={gen.extraction.windows ?? []}
          readOnly={readOnly}
          onChange={(windows) => setGen({ extraction: { ...gen.extraction, windows } })}
        />
        <Issues issues={issuesAt(issues, 'generation.extraction')} />
      </Section>

      <Section
        title="Rest & Recovery"
        hint="How much a Rest heals, and where the generator places them. These are guardrails for every generated run, not a fixed map."
        testId="zone-rest"
      >
        <div className="flex flex-wrap items-end gap-3">
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
        </div>
        <p className="text-xs text-ink-subtle">
          A rest restores this share of the fighter’s max HP, never above max. Runs already in
          progress keep the value they started with.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <NumberField
            label="Minimum Rest nodes"
            className="w-36"
            value={rest.minNodes}
            disabled={readOnly}
            onChange={(minNodes) => setRest({ minNodes })}
          />
          <OptionalNumberField
            label="Maximum Rest nodes"
            min={0}
            value={rest.maxNodes}
            disabled={readOnly}
            onChange={(maxNodes) => setRest({ maxNodes })}
          />
          <NumberField
            label="Earliest Rest depth"
            min={1}
            className="w-36"
            value={rest.minDepth}
            disabled={readOnly}
            onChange={(minDepth) => setRest({ minDepth })}
          />
          <OptionalNumberField
            label="Latest Rest depth"
            value={rest.maxDepth}
            disabled={readOnly}
            onChange={(maxDepth) => setRest({ maxDepth })}
          />
        </div>
        <p className="text-xs text-ink-subtle">
          The minimum is guaranteed on the main path, where no branch can skip it. The maximum
          counts every Rest in the run. Depth 1 is the first node.
        </p>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-1"
            aria-label="Always Rest before final Boss"
            checked={rest.beforeBoss}
            disabled={readOnly}
            onChange={(e) => setRest({ beforeBoss: e.target.checked })}
          />
          <span>
            Always Rest Before Boss
            <span className="block text-xs text-ink-muted">
              Guarantees the final approach is Rest → Boss on every generated run. That depth is
              kept off every branch, so no route can bypass it. It counts toward the minimum and
              maximum above — it is not an extra Rest.
            </span>
          </span>
        </label>
        <Issues issues={['generation.rest', 'nodeSettings'].flatMap((p) => issuesAt(issues, p))} />
      </Section>

      <Section
        title="Node types & weights"
        hint="Weight is preference among the types that are legal at a slot. Depths and “no repeats” are legality — a weight never overrides them. Rest depths here and in Rest & Recovery both apply."
        testId="zone-node-types"
      >
        <div className="space-y-2">
          {DUNGEON_WEIGHTED_NODE_TYPES.map((type) => {
            const range = gen.depthRanges[type];
            return (
              <div
                key={type}
                className="flex flex-wrap items-end gap-3"
                data-testid={`node-type-${type}`}
              >
                <span className="w-20 pb-2 text-sm text-ink">{NODE_TYPE_LABELS[type]}</span>
                <NumberField
                  label={`${NODE_TYPE_LABELS[type]} weight`}
                  value={gen.nodeWeights[type]}
                  disabled={readOnly}
                  onChange={(weight) =>
                    setGen({ nodeWeights: { ...gen.nodeWeights, [type]: weight } })
                  }
                />
                <NumberField
                  label={`${NODE_TYPE_LABELS[type]} min depth`}
                  min={1}
                  value={range?.minDepth ?? 1}
                  disabled={readOnly}
                  onChange={(minDepth) => setDepthRange(type, { minDepth })}
                />
                <OptionalNumberField
                  label={`${NODE_TYPE_LABELS[type]} max depth`}
                  value={range?.maxDepth ?? null}
                  disabled={readOnly}
                  onChange={(maxDepth) => setDepthRange(type, { maxDepth })}
                />
                <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    aria-label={`${NODE_TYPE_LABELS[type]} never twice in a row`}
                    checked={gen.noConsecutive.includes(type)}
                    disabled={readOnly}
                    onChange={(e) =>
                      setGen({
                        noConsecutive: DUNGEON_NODE_TYPES.filter((t) =>
                          t === type ? e.target.checked : gen.noConsecutive.includes(t),
                        ),
                      })
                    }
                  />
                  Never twice in a row
                </label>
              </div>
            );
          })}
        </div>
        <Issues
          issues={[
            'generation.nodeWeights',
            'generation.depthRanges',
            'generation.noConsecutive',
          ].flatMap((p) => issuesAt(issues, p))}
        />
      </Section>

      {DUNGEON_POOL_KEYS.map((pool) => (
        <PoolCard
          key={pool}
          pool={pool}
          entries={form.pools[pool]}
          options={(pool === 'event' ? reference?.events : reference?.enemies) ?? []}
          issues={issuesAt(issues, `pools.${pool}`)}
          disabled={readOnly}
          onChange={(entries) => setPool(pool, entries)}
        />
      ))}

      <Section
        title="Rewards"
        hint="Depth bands say what a node pays. A node takes the first band that names its type, else the first that names none."
        testId="zone-rewards"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-muted">
            Progression currency
            <select
              aria-label="Progression currency"
              className={selectClass}
              value={form.rewards.currencyKey}
              disabled={readOnly}
              onChange={(e) => setRewards({ currencyKey: e.target.value })}
            >
              {!(reference?.currencies ?? []).some((c) => c.key === form.rewards.currencyKey) && (
                <option value={form.rewards.currencyKey}>{form.rewards.currencyKey}</option>
              )}
              {(reference?.currencies ?? []).map((c) => (
                <option key={c.key} value={c.key}>
                  {c.pluralName} ({c.key}){c.enabled ? '' : ' — disabled'}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            label="Kept on defeat (%)"
            step={0.01}
            className="w-36"
            value={basisPointsToPercent(form.rewards.defeatCurrencyRetentionBasisPoints)}
            disabled={readOnly}
            onChange={(percent) =>
              setRewards({ defeatCurrencyRetentionBasisPoints: percentToBasisPoints(percent) })
            }
          />
        </div>
        <p className="text-xs text-ink-subtle">
          The share of unbanked currency a defeated player keeps. Extraction and completion bank all
          of it.
        </p>
        <Issues
          issues={['rewards.currencyKey', 'rewards.defeatCurrencyRetentionBasisPoints'].flatMap(
            (p) => issuesAt(issues, p),
          )}
        />

        {form.rewards.bands.map((band, i) => (
          <BandRow
            key={i}
            band={band}
            index={i}
            tables={tables}
            issues={issuesAt(issues, `rewards.bands[${i}]`)}
            disabled={readOnly}
            onChange={(next) =>
              setRewards({ bands: form.rewards.bands.map((b, j) => (j === i ? next : b)) })
            }
            onRemove={() => setRewards({ bands: form.rewards.bands.filter((_, j) => j !== i) })}
          />
        ))}
        {canWrite && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setRewards({ bands: [...form.rewards.bands, newRewardBand(form.rewards.bands)] })
            }
          >
            Add depth band
          </Button>
        )}

        <BonusFields
          label="Completion bonus"
          value={form.rewards.completion}
          tables={tables}
          disabled={readOnly}
          onChange={(completion) => setRewards({ completion })}
        />
        <BonusFields
          label="Extraction bonus"
          value={form.rewards.extraction}
          tables={tables}
          disabled={readOnly}
          onChange={(extraction) => setRewards({ extraction })}
        />
        <Issues
          issues={['rewards.completion', 'rewards.extraction'].flatMap((p) => issuesAt(issues, p))}
        />
      </Section>

      <Section
        title="Advanced rules"
        hint="Extra guarantees and limits by node type — for example “at least one Cache or Event”. Guarantees are counted on the main path only (a node on a fork can be walked around); limits count the whole run. Rest counts belong in Rest & Recovery."
        testId="zone-constraints"
      >
        {gen.required.map((group, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3" data-testid="required-row">
            <NumberField
              label={`Guarantee ${i + 1}: at least`}
              min={1}
              className="w-28"
              value={group.min}
              disabled={readOnly}
              onChange={(min) =>
                setGen({ required: gen.required.map((g, j) => (j === i ? { ...g, min } : g)) })
              }
            />
            <TypeChecks
              label={`Guarantee ${i + 1} of`}
              value={group.types}
              disabled={readOnly}
              onChange={(types) =>
                setGen({ required: gen.required.map((g, j) => (j === i ? { ...g, types } : g)) })
              }
            />
            {canWrite && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove guarantee ${i + 1}`}
                onClick={() => setGen({ required: gen.required.filter((_, j) => j !== i) })}
              >
                Remove
              </Button>
            )}
            <Issues issues={issuesAt(issues, `generation.required[${i}]`)} />
          </div>
        ))}
        {gen.limits.map((limit, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3" data-testid="limit-row">
            <NumberField
              label={`Limit ${i + 1}: at most`}
              className="w-28"
              value={limit.max}
              disabled={readOnly}
              onChange={(max) =>
                setGen({ limits: gen.limits.map((l, j) => (j === i ? { ...l, max } : l)) })
              }
            />
            <TypeChecks
              label={`Limit ${i + 1} of`}
              value={limit.types}
              disabled={readOnly}
              onChange={(types) =>
                setGen({ limits: gen.limits.map((l, j) => (j === i ? { ...l, types } : l)) })
              }
            />
            {canWrite && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove limit ${i + 1}`}
                onClick={() => setGen({ limits: gen.limits.filter((_, j) => j !== i) })}
              >
                Remove
              </Button>
            )}
            <Issues issues={issuesAt(issues, `generation.limits[${i}]`)} />
          </div>
        ))}
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setGen({ required: [...gen.required, { types: ['rest'], min: 1 }] })}
            >
              Add guarantee
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setGen({ limits: [...gen.limits, { types: ['elite'], max: 1 }] })}
            >
              Add limit
            </Button>
          </div>
        )}
        <OptionalNumberField
          label="Same enemy in a row, at most"
          value={gen.maxConsecutiveSameEnemy}
          disabled={readOnly}
          onChange={(maxConsecutiveSameEnemy) => setGen({ maxConsecutiveSameEnemy })}
        />
        <Issues issues={issuesAt(issues, 'generation.maxConsecutiveSameEnemy')} />
      </Section>

      <Card className="space-y-3 p-4" data-testid="zone-save">
        {validation.isError && (
          <ErrorState variant="inline" title="Could not check the zone" error={validation.error} />
        )}
        <Issues
          issues={[
            ...issuesAt(issues, 'generation').filter((i) => i.path === 'generation'),
            ...issuesOutside(issues, SECTION_PREFIXES),
          ]}
        />
        <p className="text-xs text-ink-muted" data-testid="validation-status">
          {!keyUsable
            ? 'Give the zone a lower_snake_case key to check it.'
            : validation.isFetching
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
              validation.isFetching ||
              !keyUsable
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : isNew ? 'Create zone' : 'Save zone'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={draftPreview.isPending || !keyUsable}
            onClick={() => draftPreview.mutate()}
          >
            {draftPreview.isPending ? 'Generating…' : 'Preview this draft'}
          </Button>
          {!isNew && dirty && (
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => loaded && adopt(loaded)}
            >
              Discard changes
            </Button>
          )}
          {readOnly && (
            <span className="text-xs text-ink-muted">You do not have write permission.</span>
          )}
        </div>
        {draftPreview.isError && (
          <ErrorState
            variant="inline"
            title="This draft could not generate a run"
            error={draftPreview.error}
          />
        )}
        {draftPreview.data && <DungeonGraphView preview={draftPreview.data} />}
      </Card>
    </div>
  );
}

function PoolCard({
  pool,
  entries,
  options,
  issues,
  disabled,
  onChange,
}: {
  pool: DungeonPoolKey;
  entries: DungeonPoolEntryDoc[];
  options: DungeonContentRef[];
  issues: DungeonZoneIssue[];
  disabled: boolean;
  onChange: (next: DungeonPoolEntryDoc[]) => void;
}) {
  const field = pool === 'event' ? 'eventKey' : 'enemyKey';
  const what = pool === 'event' ? 'Event' : 'Enemy';
  const update = (i: number, patch: Partial<DungeonPoolEntryDoc>) =>
    onChange(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <Section title={POOL_LABELS[pool]} testId={`pool-${pool}`}>
      {entries.length === 0 && <p className="text-xs text-ink-subtle">No entries.</p>}
      {entries.map((entry, i) => {
        const current = entry[field] ?? '';
        const known = options.some((o) => o.key === current);
        const label = `${POOL_LABELS[pool]} ${i + 1}`;
        return (
          <div
            key={i}
            className="space-y-1 border-t border-border pt-2 first:border-t-0 first:pt-0"
            data-testid="pool-entry"
          >
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-ink-muted">
                {what}
                <select
                  aria-label={`${label} ${what.toLowerCase()}`}
                  className={selectClass}
                  value={current}
                  disabled={disabled}
                  onChange={(e) => update(i, { [field]: e.target.value })}
                >
                  {!known && (
                    <option value={current}>
                      {current || `Choose an ${what.toLowerCase()}`} (unknown)
                    </option>
                  )}
                  {options.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.name}
                      {o.enabled ? '' : ' (disabled)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-muted">
                Entry id
                <Input
                  aria-label={`${label} id`}
                  className="w-40 font-mono"
                  value={entry.id}
                  disabled={disabled}
                  onChange={(e) => update(i, { id: e.target.value })}
                />
              </label>
              <NumberField
                label={`${label} weight`}
                value={entry.weight}
                disabled={disabled}
                onChange={(weight) => update(i, { weight })}
              />
              <NumberField
                label={`${label} min depth`}
                min={1}
                value={entry.minDepth}
                disabled={disabled}
                onChange={(minDepth) => update(i, { minDepth })}
              />
              <OptionalNumberField
                label={`${label} max depth`}
                value={entry.maxDepth}
                disabled={disabled}
                onChange={(maxDepth) => update(i, { maxDepth })}
              />
              <label className="text-xs text-ink-muted">
                Tags
                <Input
                  aria-label={`${label} tags`}
                  className="w-40"
                  key={entry.tags.join(',')}
                  defaultValue={entry.tags.join(', ')}
                  disabled={disabled}
                  onBlur={(e) => update(i, { tags: parseTags(e.target.value) })}
                />
              </label>
              <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  aria-label={`${label} enabled`}
                  checked={entry.enabled}
                  disabled={disabled}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                />
                Enabled
              </label>
              {!disabled && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${label}`}
                  onClick={() => onChange(entries.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              )}
            </div>
            <Issues issues={issuesAt(issues, `pools.${pool}[${i}]`)} />
          </div>
        );
      })}
      <Issues issues={issues.filter((i) => i.path === `pools.${pool}`)} />
      {!disabled && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={options.length === 0}
          onClick={() => onChange([...entries, newPoolEntry(pool, options[0]?.key ?? '', entries)])}
        >
          Add {what.toLowerCase()}
        </Button>
      )}
    </Section>
  );
}

function BandRow({
  band,
  index,
  tables,
  issues,
  disabled,
  onChange,
  onRemove,
}: {
  band: DungeonRewardBandDoc;
  index: number;
  tables: DungeonReferenceData['rewardTables'];
  issues: DungeonZoneIssue[];
  disabled: boolean;
  onChange: (next: DungeonRewardBandDoc) => void;
  onRemove: () => void;
}) {
  const label = `Band ${index + 1}`;
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="reward-band">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-muted">
          Band id
          <Input
            aria-label={`${label} id`}
            className="w-36 font-mono"
            value={band.id}
            disabled={disabled}
            onChange={(e) => onChange({ ...band, id: e.target.value })}
          />
        </label>
        <NumberField
          label={`${label} min depth`}
          min={1}
          value={band.minDepth}
          disabled={disabled}
          onChange={(minDepth) => onChange({ ...band, minDepth })}
        />
        <OptionalNumberField
          label={`${label} max depth`}
          value={band.maxDepth}
          disabled={disabled}
          onChange={(maxDepth) => onChange({ ...band, maxDepth })}
        />
        <RangeFields
          label={`${label} currency`}
          value={band.currency}
          disabled={disabled}
          onChange={(currency) => onChange({ ...band, currency })}
        />
        <label className="flex items-center gap-1 pb-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            aria-label={`${label} enabled`}
            checked={band.enabled}
            disabled={disabled}
            onChange={(e) => onChange({ ...band, enabled: e.target.checked })}
          />
          Enabled
        </label>
        {!disabled && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Remove ${label}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <TableSelect
          label={`${label} reward table`}
          value={band.rewardTable}
          tables={tables}
          disabled={disabled}
          onChange={(rewardTable) => onChange({ ...band, rewardTable })}
        />
        <TableSelect
          label={`${label} Equipment reward table`}
          value={band.equipmentRewardTable}
          tables={tables}
          disabled={disabled}
          onChange={(equipmentRewardTable) => onChange({ ...band, equipmentRewardTable })}
        />
      </div>
      <TypeChecks
        label={`${label} applies to (none ticked = every type)`}
        value={band.nodeTypes}
        disabled={disabled}
        onChange={(nodeTypes) => onChange({ ...band, nodeTypes })}
      />
      <Issues issues={issues} />
    </div>
  );
}

function BonusFields({
  label,
  value,
  tables,
  disabled,
  onChange,
}: {
  label: string;
  value: DungeonBonusDoc;
  tables: DungeonReferenceData['rewardTables'];
  disabled: boolean;
  onChange: (next: DungeonBonusDoc) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
      <span className="w-36 pb-2 text-sm text-ink">{label}</span>
      <RangeFields
        label={`${label} currency`}
        value={value.currency}
        disabled={disabled}
        onChange={(currency) => onChange({ ...value, currency })}
      />
      <TableSelect
        label={`${label} reward table`}
        value={value.rewardTable}
        tables={tables}
        disabled={disabled}
        onChange={(rewardTable) => onChange({ ...value, rewardTable })}
      />
    </div>
  );
}
