/**
 * Admin — create or edit one boss.
 *
 * The page reads in the order an author thinks about a boss: what it is, where
 * it appears, how it fights, what it pays, what it says, and when it may be
 * drawn.
 *
 *   - **A boss has no numbers of its own beyond its affinity.** There is no HP
 *     pool. How long an encounter stays open and how long the server waits
 *     before the next one are global tuning shared by every boss; they are
 *     shown here read-only so an author is not left guessing, and changed in
 *     content, not here.
 *   - **The id is permanent.** It is chosen once, on creation; every encounter
 *     ever recorded names the boss by it.
 *   - **Saves are optimistic.** A save names the revision it loaded. If someone
 *     else saved first the server refuses with 409, and this page says so and
 *     offers a reload — it never overwrites.
 *   - **An encounter already drawn keeps the boss it froze.** Edits reach the
 *     next spawn.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  BOSSES_QUERY_KEY,
  BOSS_STATUSES,
  createBoss,
  getBoss,
  getBossReference,
  invalidateBossQueries,
  listBossEvents,
  updateBoss,
  type BossDetail,
  type BossIssue,
  type BossReference,
  type BossStaleDetails,
  type BossStatus,
} from '@/api/adminBosses';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

import {
  BOSSES_PATH,
  PROSE_FIELDS,
  STATUS_LABELS,
  blankBossForm,
  bossPath,
  describeEvent,
  formErrors,
  formOf,
  formatLocal,
  idError,
  inputOf,
  issuesAt,
  scheduleIssuesOf,
  titleCase,
  uniqueIssues,
  type BossForm,
  keyFromName,
} from './bossModel';
import { BossArtworkSection } from './BossArtworkSection';
import { BossIssues, Section } from './bossParts';
import { ScheduleEditor } from './ScheduleEditor';

/** `/admin/bosses/new` creates; `/admin/bosses/:id` edits, keyed so each boss starts from a clean draft. */
export function BossEditorPage() {
  const { id } = useParams<{ id: string }>();
  return id === undefined ? <BossCreator /> : <BossEditor key={id} bossId={id} />;
}

/** Every path a section of the form shows issues for. */
const SECTION_PATHS = [
  'id',
  'name',
  'description',
  'artwork',
  'artworkAssetId',
  'status',
  'regions',
  'affinity',
  'rewardTable',
  'scoutingText',
  'repelledText',
  'unchallengedText',
  'schedule',
];
const elsewhereOf = (issues: readonly BossIssue[]) =>
  issues.filter((i) => !SECTION_PATHS.some((p) => issuesAt([i], p).length > 0));

const refusedIssues = (error: unknown): BossIssue[] =>
  isPortalApiError(error) && error.code === 'BOSS_DEFINITION_INVALID'
    ? (((error.details ?? {}) as { issues?: BossIssue[] }).issues ?? [])
    : [];

const textareaClass =
  'mt-1 block min-h-20 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink disabled:opacity-60';

const minutes = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;

function useBossReference() {
  return useQuery({
    queryKey: [...BOSSES_QUERY_KEY, 'reference'],
    queryFn: ({ signal }) => getBossReference(signal),
  });
}

/** A value every boss shares, shown so it is known and marked so it is not mistaken for a field. */
function GlobalValue({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-52 shrink-0 text-ink-muted">{label}</dt>
      <dd className="text-ink" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

const SHARED_NOTE =
  'Shared by every boss. This is global encounter tuning, changed in content (tables.json), not here.';

/** The sections both the creation page and the editor show. */
function BossFields({
  form,
  set,
  readOnly,
  reference,
  issues,
  identity,
}: {
  form: BossForm;
  set: (patch: Partial<BossForm>) => void;
  readOnly: boolean;
  reference: BossReference;
  /** Local problems, the stored boss's standing issues and what the last save was refused for. */
  issues: BossIssue[];
  /** The id: an input while creating, fixed text afterwards. */
  identity: ReactNode;
}) {
  const at = (...paths: string[]) => paths.flatMap((p) => issuesAt(issues, p));
  const { tuning } = reference;

  // What the boss already names stays selectable even if this server no longer offers it.
  const regions = [
    ...reference.regions,
    ...form.regions
      .filter((id) => !reference.regions.some((r) => r.id === id))
      .map((id) => ({ id, label: id, enabled: false })),
  ];
  const tables = [
    ...reference.rewardTables,
    ...(form.rewardTable && !reference.rewardTables.some((t) => t.id === form.rewardTable)
      ? [{ id: form.rewardTable, enabled: false, missing: true }]
      : []),
  ] as Array<{ id: string; enabled: boolean; missing?: boolean }>;
  const affinities = [...new Set([...reference.affinities, form.affinity].filter(Boolean))];

  return (
    <>
      <Section
        title="Identity"
        hint="What the boss is called and whether it can spawn."
        testId="boss-identity"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-muted">
            Name
            <Input
              aria-label="Boss name"
              className="w-64"
              value={form.name}
              disabled={readOnly}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          {identity}
          <label className="text-xs text-ink-muted">
            Status
            <select
              aria-label="Boss status"
              className={selectClass}
              value={form.status}
              disabled={readOnly}
              onChange={(e) => set({ status: e.target.value as BossStatus })}
            >
              {BOSS_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-ink-subtle">
          Only an Active boss can spawn. A Draft may be unfinished; a Disabled boss keeps its
          history and is simply never drawn.
        </p>
        <BossIssues issues={at('name', 'id', 'status')} testId="boss-identity-issues" />
        <label className="block text-xs text-ink-muted">
          Description
          <textarea
            aria-label="Boss description"
            className={textareaClass}
            value={form.description}
            disabled={readOnly}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
        <BossIssues issues={at('description')} testId="boss-description-issues" />
      </Section>

      <BossArtworkSection
        form={form}
        set={set}
        readOnly={readOnly}
        shippedPaths={reference.artwork}
        managed={reference.managedArtwork === true}
        issues={issues}
      />

      <Section
        title="Regions"
        hint="Servers in these regions may draw this boss."
        testId="boss-regions"
      >
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {regions.map((region) => (
            <label key={region.id} className="flex items-center gap-1.5 text-sm text-ink">
              <input
                type="checkbox"
                aria-label={`Region ${region.label}`}
                checked={form.regions.includes(region.id)}
                disabled={readOnly}
                onChange={(e) =>
                  set({
                    regions: e.target.checked
                      ? [...form.regions, region.id]
                      : form.regions.filter((id) => id !== region.id),
                  })
                }
              />
              {region.label}
              {!region.enabled && (
                <span className="text-xs text-ink-subtle">(boss encounters not enabled)</span>
              )}
            </label>
          ))}
        </div>
        <BossIssues issues={at('regions')} testId="boss-regions-issues" />
      </Section>

      <Section
        title="Combat"
        hint="A boss has no HP and no stats of its own: players deal damage against the clock, and its affinity decides who is strong against it."
        testId="boss-combat"
      >
        <label className="block w-56 text-xs text-ink-muted">
          Affinity
          <select
            aria-label="Boss affinity"
            className={selectClass}
            value={form.affinity}
            disabled={readOnly}
            onChange={(e) => set({ affinity: e.target.value })}
          >
            {affinities.map((affinity) => (
              <option key={affinity} value={affinity}>
                {titleCase(affinity)}
              </option>
            ))}
          </select>
        </label>
        <BossIssues issues={at('affinity')} testId="boss-affinity-issues" />
        <dl className="space-y-1">
          <GlobalValue
            label="Attacks per participation"
            value={String(tuning.attacksPerParticipation)}
            testId="boss-tuning-attacks"
          />
        </dl>
        <p className="text-xs text-ink-subtle">{SHARED_NOTE}</p>
      </Section>

      <Section
        title="Spawning"
        hint="How long an encounter stays open, and how long the server waits before drawing the next boss."
        testId="boss-spawning"
      >
        <dl className="space-y-1">
          <GlobalValue
            label="Encounter window"
            value={minutes(tuning.scoutingMinutes)}
            testId="boss-tuning-window"
          />
          <GlobalValue
            label="Respawn cooldown"
            value={`${minutes(tuning.downtimeMinutesMin)} to ${minutes(tuning.downtimeMinutesMax)}`}
            testId="boss-tuning-cooldown"
          />
        </dl>
        <p className="text-xs text-ink-subtle">{SHARED_NOTE}</p>
        {!tuning.enabled && (
          <p className="text-xs text-danger" data-testid="boss-feature-off">
            Boss encounters are switched off on this server, so no boss spawns whatever is set here.
          </p>
        )}
      </Section>

      <Section
        title="Rewards"
        hint="The boss reward table an encounter pays from. The tables themselves are content (bossRewards.json) and are not edited here."
        testId="boss-rewards"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="w-72 text-xs text-ink-muted">
            Reward table
            <select
              aria-label="Reward table"
              className={selectClass}
              value={form.rewardTable}
              disabled={readOnly}
              onChange={(e) => set({ rewardTable: e.target.value })}
            >
              <option value="">None yet</option>
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.id}
                  {table.missing ? ' (does not exist)' : table.enabled ? '' : ' (disabled)'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <BossIssues issues={at('rewardTable')} testId="boss-rewards-issues" />
      </Section>

      <Section
        title="Presentation"
        hint="What players read in Discord. An encounter freezes these lines when it is drawn."
        testId="boss-presentation"
      >
        {PROSE_FIELDS.map(([field, label, hint]) => (
          <div key={field}>
            <label className="block text-xs text-ink-muted">
              {label}
              <textarea
                aria-label={label}
                className={textareaClass}
                value={form[field]}
                disabled={readOnly}
                onChange={(e) => set({ [field]: e.target.value })}
              />
            </label>
            <p className="mt-1 text-xs text-ink-subtle">{hint}</p>
            <BossIssues issues={at(field)} testId={`boss-${field}-issues`} />
          </div>
        ))}
      </Section>

      <Section
        title="Availability"
        hint="When the spawner may draw this boss. A live encounter always runs to its own deadline, whatever the schedule says by then."
        testId="boss-availability"
      >
        <ScheduleEditor
          value={form.schedule}
          disabled={readOnly}
          issues={scheduleIssuesOf(issues)}
          onChange={(schedule) => set({ schedule })}
        />
      </Section>
    </>
  );
}

function BossCreator() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const referenceQuery = useBossReference();
  const [form, setForm] = useState<BossForm | null>(null);
  /** Set once the author types their own id; until then it follows the name. */
  const [customId, setCustomId] = useState<string | null>(null);

  useEffect(() => {
    if (referenceQuery.data && form === null) setForm(blankBossForm(referenceQuery.data));
  }, [referenceQuery.data, form]);

  const id = customId ?? keyFromName(form?.name ?? '');
  const create = useMutation({
    mutationFn: () => createBoss(id, inputOf(form!)),
    onSuccess: (detail) => {
      invalidateBossQueries(queryClient);
      navigate(bossPath(detail.id), { replace: true });
    },
  });

  if (referenceQuery.isError) {
    return (
      <ErrorState
        title="Could not load the boss editor"
        error={referenceQuery.error}
        onRetry={() => void referenceQuery.refetch()}
      />
    );
  }
  if (!referenceQuery.data || form === null) return <Skeleton className="h-64 w-full" />;

  const named = form.name.trim() !== '';
  const badId = idError(id);
  const problems = formErrors(form);
  const refused = refusedIssues(create.error);
  const idTaken =
    isPortalApiError(create.error) && create.error.code === 'BOSS_DEFINITION_KEY_TAKEN';
  const issues = uniqueIssues([...problems, ...refused]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="New boss"
        description="A new boss starts as a Draft unless you say otherwise. Nothing spawns until it is Active."
        actions={
          <Button variant="outline" asChild>
            <Link to={BOSSES_PATH}>Back to bosses</Link>
          </Button>
        }
      />
      <BossFields
        form={form}
        set={(patch) => setForm({ ...form, ...patch })}
        readOnly={false}
        reference={referenceQuery.data}
        issues={issues}
        identity={
          <div>
            <label className="text-xs text-ink-muted">
              Id (lower_snake_case, permanent)
              <Input
                aria-label="Boss id"
                className="w-64 font-mono"
                value={id}
                onChange={(e) => setCustomId(e.target.value)}
              />
            </label>
            {(named || customId !== null) && badId && (
              <p className="text-xs text-danger" role="alert" data-testid="boss-id-error">
                {badId}
              </p>
            )}
            {idTaken && (
              <p className="text-xs text-danger" role="alert" data-testid="boss-id-taken">
                A boss with the id “{id}” already exists — change the name or the id.
              </p>
            )}
          </div>
        }
      />
      <Card className="space-y-3 p-4" data-testid="boss-save">
        <BossIssues issues={elsewhereOf(issues)} testId="boss-other-issues" />
        {create.isError && !idTaken && refused.length === 0 && (
          <ErrorState variant="inline" title="Could not create the boss" error={create.error} />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="accent"
            disabled={problems.length > 0 || badId !== null || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Create boss'}
          </Button>
          <span className="text-xs text-ink-subtle">
            The id cannot be changed once the boss exists.
          </span>
        </div>
      </Card>
    </div>
  );
}

/** The last few audit events of one boss, newest first. */
function RecentChanges({ bossId }: { bossId: string }) {
  const query = useQuery({
    queryKey: [...BOSSES_QUERY_KEY, 'events', bossId],
    queryFn: ({ signal }) => listBossEvents({ bossId, limit: 10 }, signal),
  });
  const events = query.data?.events ?? [];
  return (
    <Section
      title="Recent changes"
      hint="Edits, lifecycle changes, imports, manual spawns and manual ends of this boss."
      testId="boss-events"
    >
      {query.isPending && <Skeleton className="h-10 w-full" />}
      {query.isError && (
        <ErrorState variant="inline" title="Could not load recent changes" error={query.error} />
      )}
      {query.data && events.length === 0 && (
        <p className="text-xs text-ink-muted">Nothing recorded yet.</p>
      )}
      {events.length > 0 && (
        <ul className="space-y-1 text-sm">
          {events.map((event) => (
            <li key={event.id} data-testid="boss-event">
              <span className="text-ink">{describeEvent(event)}</span>{' '}
              <span className="text-xs text-ink-muted">
                — {event.actor ?? 'system'} · {formatLocal(event.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function BossEditor({ bossId }: { bossId: string }) {
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('bosses.write');
  const readOnly = !canWrite;
  const referenceQuery = useBossReference();
  const detailQuery = useQuery({
    queryKey: [...BOSSES_QUERY_KEY, 'boss', bossId],
    queryFn: ({ signal }) => getBoss(bossId, signal),
  });

  const [form, setForm] = useState<BossForm | null>(null);
  const [loaded, setLoaded] = useState<BossDetail | null>(null);
  const [stale, setStale] = useState<BossStaleDetails | null>(null);

  const adopt = (detail: BossDetail) => {
    setLoaded(detail);
    setForm(formOf(detail));
    setStale(null);
  };
  useEffect(() => {
    if (detailQuery.data && loaded === null) adopt(detailQuery.data);
  }, [detailQuery.data, loaded]);

  const save = useMutation({
    mutationFn: () => updateBoss(bossId, inputOf(form!), loaded!.revision),
    onSuccess: (detail) => {
      adopt(detail);
      queryClient.setQueryData([...BOSSES_QUERY_KEY, 'boss', bossId], detail);
      invalidateBossQueries(queryClient);
    },
    onError: (err) => {
      if (isPortalApiError(err) && err.code === 'BOSS_DEFINITION_STALE')
        setStale((err.details ?? {}) as BossStaleDetails);
    },
  });

  const reload = async () => {
    const result = await detailQuery.refetch();
    if (result.data) {
      adopt(result.data);
      save.reset();
    }
  };

  if (detailQuery.isError || referenceQuery.isError) {
    return (
      <ErrorState
        title="Could not load the boss"
        error={detailQuery.error ?? referenceQuery.error}
        onRetry={() => {
          void detailQuery.refetch();
          void referenceQuery.refetch();
        }}
      />
    );
  }
  if (!referenceQuery.data || form === null || loaded === null) {
    return <Skeleton className="h-64 w-full" />;
  }

  const dirty = JSON.stringify(inputOf(form)) !== JSON.stringify(inputOf(formOf(loaded)));
  const problems = formErrors(form);
  const refused = refusedIssues(save.error);
  // The stored boss's standing problems, beside the fields they name, with what the last save was refused for.
  const issues = uniqueIssues([...problems, ...loaded.issues, ...refused]);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Boss — ${loaded.name}`}
        description="Changes reach the next spawn. An encounter already drawn keeps the boss it started with."
        actions={
          <Button variant="outline" asChild>
            <Link to={BOSSES_PATH}>Back to bosses</Link>
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
            This boss was changed by someone else since you opened it.
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

      <BossFields
        form={form}
        set={(patch) => setForm({ ...form, ...patch })}
        readOnly={readOnly}
        reference={referenceQuery.data}
        issues={issues}
        identity={
          <div className="text-xs text-ink-muted">
            Id (permanent)
            <span className="block h-9 pt-2 font-mono text-sm text-ink" data-testid="boss-id">
              {loaded.id}
            </span>
          </div>
        }
      />

      <RecentChanges bossId={bossId} />

      <Card className="space-y-3 p-4" data-testid="boss-save">
        <p className="text-xs text-ink-muted" data-testid="boss-provenance">
          Revision {loaded.revision} · last updated {formatLocal(loaded.updatedAt)}
          {loaded.updatedBy ? ` by ${loaded.updatedBy}` : ''} ·{' '}
          {loaded.shipped ? 'ships with the game' : 'exists only on this server until exported'} ·{' '}
          {loaded.encounterCount === 0
            ? 'no encounters yet'
            : `${loaded.encounterCount} encounter${loaded.encounterCount === 1 ? '' : 's'}`}
        </p>
        <BossIssues issues={elsewhereOf(issues)} testId="boss-other-issues" />
        <p className="text-xs text-ink-muted" data-testid="boss-save-status">
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
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save boss'}
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
    </div>
  );
}
