/**
 * Admin — Boss Activity: what bosses are doing on this server right now, what
 * they did recently, and why the next one will or will not spawn.
 *
 * Everything here is about **one server** — the one this Portal session has
 * selected.
 *
 *   - **Spawn Now** goes through the normal spawn service: an ordinary
 *     encounter with its reward snapshot, one active encounter per server. The
 *     spawner may refuse, and says why. The one refusal that can be overridden
 *     is "outside its availability schedule" — deliberately, after an explicit
 *     confirmation, and audited.
 *   - **End Encounter** closes the active encounter now. Everyone who has
 *     committed is still paid in full.
 *   - **Diagnostics** never guesses. When this API process runs no boss
 *     scheduler, its health is reported as unknown, not as healthy.
 *
 * There is nothing here that edits a live encounter's numbers.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  BOSSES_QUERY_KEY,
  endBossEncounter,
  getBossActivity,
  getBossDiagnostics,
  invalidateBossQueries,
  listBosses,
  spawnBoss,
  type BossAnnouncement,
  type BossDiagnostics,
  type BossEncounter,
  type BossSpawnRefusal,
} from '@/api/adminBosses';
import { isPortalApiError } from '@/api/client';
import { useHasPermission } from '@/auth/useSession';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

import {
  ENCOUNTER_STATUS_LABELS,
  SCHEDULER_HEALTH_LABELS,
  VERDICTS,
  VERDICT_LABELS,
  bossPath,
  canEndEncounter,
  formatLocal,
  nextWindowLine,
  titleCase,
} from './bossModel';
import { BossStatusBadge, BossTabs, Section } from './bossParts';

/** How often the live views are re-read while the page is open. */
const REFRESH_MS = 30_000;

const ANNOUNCEMENT_NOTES: Record<BossAnnouncement, string> = {
  requested: 'The scheduler has been asked to post it to Discord now.',
  no_scheduler:
    'This API process runs no boss scheduler, so Discord is updated by whichever process does, on its next pass.',
};

const refusalOf = (error: unknown): BossSpawnRefusal | null =>
  isPortalApiError(error) && error.code === 'BOSS_SPAWN_REFUSED'
    ? (((error.details ?? {}) as { reason?: BossSpawnRefusal }).reason ?? null)
    : null;

function EncounterTable({
  encounters,
  testId,
  onEnd,
}: {
  encounters: BossEncounter[];
  testId: string;
  /** Present for the active table when the viewer may end an encounter. */
  onEnd?: (encounter: BossEncounter) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid={testId}>
        <thead className="text-xs uppercase text-ink-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Boss</th>
            <th className="py-1 pr-3 font-medium">Region</th>
            <th className="py-1 pr-3 font-medium">Status</th>
            <th className="py-1 pr-3 font-medium">Drawn</th>
            <th className="py-1 pr-3 font-medium">Opened</th>
            <th className="py-1 pr-3 font-medium">{onEnd ? 'Closes' : 'Ended'}</th>
            <th className="py-1 pr-3 font-medium">Players</th>
            <th className="py-1 pr-3 font-medium">Damage</th>
            {onEnd && <th className="py-1 font-medium">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {encounters.map((e) => (
            <tr key={e.id} className="align-top" data-testid="encounter-row">
              <td className="py-1.5 pr-3">
                <Link to={bossPath(e.bossId)} className="text-ink hover:underline">
                  {e.bossName}
                </Link>
                <span className="block text-xs text-ink-subtle">#{e.id}</span>
              </td>
              <td className="py-1.5 pr-3 text-ink-muted">{titleCase(e.region)}</td>
              <td className="py-1.5 pr-3">
                <span className="flex flex-wrap items-center gap-1">
                  <Badge variant={e.status === 'cancelled' ? 'danger' : 'default'}>
                    {ENCOUNTER_STATUS_LABELS[e.status]}
                  </Badge>
                  {e.forced && <Badge variant="outline">Manual</Badge>}
                </span>
                {e.resolutionReason && (
                  <span className="block text-xs text-ink-subtle">
                    {titleCase(e.resolutionReason)}
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-xs text-ink-muted">{formatLocal(e.scheduledAt)}</td>
              <td className="py-1.5 pr-3 text-xs text-ink-muted">
                {e.startedAt ? formatLocal(e.startedAt) : 'Not announced yet'}
              </td>
              <td className="py-1.5 pr-3 text-xs text-ink-muted">
                {formatLocal(onEnd ? e.expiresAt : e.resolvedAt)}
              </td>
              <td className="py-1.5 pr-3 text-ink">{e.participantCount}</td>
              <td className="py-1.5 pr-3 text-ink">{e.totalDamage.toLocaleString('en-US')}</td>
              {onEnd && (
                <td className="py-1.5">
                  {canEndEncounter(e) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      aria-label={`End encounter with ${e.bossName}`}
                      onClick={() => onEnd(e)}
                    >
                      End Encounter
                    </Button>
                  ) : (
                    <span className="text-xs text-ink-subtle">Already resolving</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BossActivityPage() {
  const queryClient = useQueryClient();
  // Spawning and ending act on players at once; they have their own grant.
  const canOperate = useHasPermission('bosses.operate');
  const activity = useQuery({
    queryKey: [...BOSSES_QUERY_KEY, 'activity'],
    queryFn: ({ signal }) => getBossActivity(signal),
    refetchInterval: REFRESH_MS,
  });
  const diagnostics = useQuery({
    queryKey: [...BOSSES_QUERY_KEY, 'diagnostics'],
    queryFn: ({ signal }) => getBossDiagnostics(signal),
    refetchInterval: REFRESH_MS,
  });
  const [ending, setEnding] = useState<BossEncounter | null>(null);

  const end = useMutation({
    mutationFn: (encounter: BossEncounter) => endBossEncounter(encounter.id),
    onSettled: () => {
      setEnding(null);
      invalidateBossQueries(queryClient);
    },
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Boss Activity"
        description="Live and recent boss encounters on this server, and why the next boss will or will not spawn."
        actions={
          <Button
            variant="outline"
            disabled={activity.isFetching || diagnostics.isFetching}
            onClick={() => invalidateBossQueries(queryClient)}
          >
            Refresh
          </Button>
        }
      />
      <BossTabs current="activity" />

      {activity.data && !activity.data.featureEnabled && (
        <Card className="p-4 text-sm text-danger" role="status" data-testid="boss-feature-off">
          Boss encounters are switched off on this server. Bosses can still be edited, but nothing
          is scheduled and nothing can be spawned.
        </Card>
      )}

      {canOperate && <SpawnNow />}

      <Section
        title="Active encounter"
        hint="A server has at most one. It runs to its own deadline, whatever the boss’s schedule says by then."
        testId="boss-active"
      >
        {activity.isPending && <Skeleton className="h-16 w-full" />}
        {activity.isError && (
          <ErrorState
            variant="inline"
            title="Could not load boss activity"
            error={activity.error}
            onRetry={() => void activity.refetch()}
          />
        )}
        {activity.data && activity.data.active.length === 0 && (
          <p className="text-sm text-ink-muted" data-testid="boss-no-active">
            No boss encounter is active on this server.
          </p>
        )}
        {activity.data && activity.data.active.length > 0 && (
          <EncounterTable
            encounters={activity.data.active}
            testId="active-encounters"
            {...(canOperate ? { onEnd: setEnding } : {})}
          />
        )}
        {end.isSuccess && (
          <p className="text-xs text-ink-muted" role="status" data-testid="boss-end-notice">
            Ended the encounter with {end.data.encounter.bossName}:{' '}
            {end.data.encounter.participantCount === 0
              ? 'nobody had committed, so it was cancelled.'
              : `${end.data.encounter.participantCount} committed player${end.data.encounter.participantCount === 1 ? ' is' : 's are'} paid in full.`}{' '}
            {ANNOUNCEMENT_NOTES[end.data.announcement]}
          </p>
        )}
        {end.isError && (
          <div className="space-y-1">
            <ErrorState variant="inline" title="Could not end the encounter" error={end.error} />
            {/* The server's own reason: "already resolving", "not found"… */}
            {isPortalApiError(end.error) && (
              <p className="text-xs text-ink-muted">{end.error.message}</p>
            )}
          </div>
        )}
      </Section>

      <Section
        title="Recent encounters"
        hint="Newest first. Damage is the combined total recorded when the encounter resolved — bosses have no HP."
        testId="boss-recent"
      >
        {activity.isPending && <Skeleton className="h-16 w-full" />}
        {activity.data && activity.data.recent.length === 0 && (
          <p className="text-sm text-ink-muted">No encounters recorded on this server yet.</p>
        )}
        {activity.data && activity.data.recent.length > 0 && (
          <EncounterTable encounters={activity.data.recent} testId="recent-encounters" />
        )}
      </Section>

      <Section
        title="Diagnostics"
        hint="Why the next boss will or will not spawn here."
        testId="boss-diagnostics"
      >
        {diagnostics.isPending && <Skeleton className="h-24 w-full" />}
        {diagnostics.isError && (
          <ErrorState
            variant="inline"
            title="Could not load diagnostics"
            error={diagnostics.error}
            onRetry={() => void diagnostics.refetch()}
          />
        )}
        {diagnostics.data && <Diagnostics data={diagnostics.data} />}
      </Section>

      <Dialog open={ending !== null} onOpenChange={(next) => !next && setEnding(null)}>
        <DialogContent closeLabel="Cancel ending">
          <div
            className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-surface p-5"
            data-testid="end-encounter-confirm"
          >
            <DialogTitle className="text-base font-semibold">
              End the encounter with {ending?.bossName}?
            </DialogTitle>
            <DialogDescription className="text-sm text-ink-muted">
              The encounter closes now instead of at its deadline. Players who have already
              committed are still paid in full from the encounter’s reward snapshot; nobody else can
              join. An encounter nobody joined is simply cancelled.
            </DialogDescription>
            <p className="text-xs text-ink-subtle">
              {ending?.participantCount ?? 0} player
              {ending?.participantCount === 1 ? ' has' : 's have'} committed so far. This is
              recorded in the audit trail and cannot be undone.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="danger"
                disabled={end.isPending}
                onClick={() => ending && end.mutate(ending)}
              >
                {end.isPending ? 'Ending…' : 'End encounter'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEnding(null)}>
                Keep it running
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Spawn an Active boss on this server now. A refusal is shown as the server
 * worded it; only "outside its schedule" offers a way through, and only after
 * the admin has read what overriding means.
 */
function SpawnNow() {
  const queryClient = useQueryClient();
  const bosses = useQuery({
    queryKey: [...BOSSES_QUERY_KEY, 'list'],
    queryFn: ({ signal }) => listBosses(signal),
  });
  const active = (bosses.data?.bosses ?? []).filter((b) => b.status === 'active');
  const [chosen, setChosen] = useState('');
  /** The boss whose schedule the admin is being asked about overriding. */
  const [overriding, setOverriding] = useState<string | null>(null);
  const bossId = active.some((b) => b.id === chosen) ? chosen : (active[0]?.id ?? '');
  const nameOf = (id: string) => active.find((b) => b.id === id)?.name ?? id;

  const spawn = useMutation({
    mutationFn: ({ id, overrideSchedule }: { id: string; overrideSchedule: boolean }) =>
      spawnBoss(id, overrideSchedule),
    onSuccess: () => setOverriding(null),
    onError: (error, { id, overrideSchedule }) => {
      // The one refusal an admin may deliberately step past.
      setOverriding(!overrideSchedule && refusalOf(error) === 'outside_schedule' ? id : null);
    },
    onSettled: () => invalidateBossQueries(queryClient),
  });
  const askingOverride = overriding !== null;

  return (
    <Section
      title="Spawn Now"
      hint="Spawns an Active boss on this server through the normal spawn service. The shuffle bag and the respawn cooldown are left untouched."
      testId="boss-spawn"
    >
      {bosses.isError && (
        <ErrorState variant="inline" title="Could not load bosses" error={bosses.error} />
      )}
      {bosses.data && active.length === 0 && (
        <p className="text-sm text-ink-muted" data-testid="boss-spawn-none">
          No boss is Active, so there is nothing to spawn. Activate one on the Bosses tab.
        </p>
      )}
      {active.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="w-72 text-xs text-ink-muted">
            Boss
            <select
              aria-label="Boss to spawn"
              className={selectClass}
              value={bossId}
              onChange={(e) => setChosen(e.target.value)}
            >
              {active.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.availability.availableNow ? '' : ' (outside its schedule)'}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="accent"
            disabled={spawn.isPending}
            onClick={() => spawn.mutate({ id: bossId, overrideSchedule: false })}
          >
            {spawn.isPending && !askingOverride ? 'Spawning…' : 'Spawn Now'}
          </Button>
        </div>
      )}
      {spawn.isSuccess && (
        <p className="text-sm text-ink" role="status" data-testid="boss-spawn-notice">
          Spawned {spawn.data.encounter.bossName} (encounter #{spawn.data.encounter.id}).{' '}
          {spawn.data.scheduleOverridden &&
            'Its availability schedule was overridden, and that has been recorded. '}
          {ANNOUNCEMENT_NOTES[spawn.data.announcement]}
        </p>
      )}
      {spawn.isError && !askingOverride && (
        <div data-testid="boss-spawn-refused">
          <ErrorState variant="inline" error={spawn.error} />
        </div>
      )}

      <Dialog open={askingOverride} onOpenChange={(next) => !next && setOverriding(null)}>
        <DialogContent closeLabel="Cancel overriding">
          <div
            className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-surface p-5"
            data-testid="override-schedule-confirm"
          >
            <DialogTitle className="text-base font-semibold">
              {overriding ? nameOf(overriding) : 'This boss'} is outside its availability schedule
            </DialogTitle>
            <DialogDescription className="text-sm text-ink-muted">
              {isPortalApiError(spawn.error) ? spawn.error.message : ''} Spawning it now overrides
              that schedule for this one encounter.
            </DialogDescription>
            <ul className="ml-4 list-disc space-y-1 text-sm text-ink-muted">
              <li>The schedule itself is not changed; only this spawn ignores it.</li>
              <li>The override is recorded in the audit trail under your name.</li>
              <li>The encounter then runs to its normal deadline like any other.</li>
            </ul>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="danger"
                disabled={spawn.isPending}
                onClick={() =>
                  overriding && spawn.mutate({ id: overriding, overrideSchedule: true })
                }
              >
                {spawn.isPending ? 'Spawning…' : 'Override schedule and spawn'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setOverriding(null)}>
                Do not spawn
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function Fact({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-44 shrink-0 text-ink-muted">{label}</dt>
      <dd className="text-ink" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function Diagnostics({ data }: { data: BossDiagnostics }) {
  const { scheduler, guild, bootstrap } = data;
  return (
    <div className="space-y-4">
      <div className="space-y-1" data-testid="boss-scheduler">
        <h3 className="text-xs font-semibold uppercase text-ink-muted">Scheduler</h3>
        {scheduler === null ? (
          <>
            <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
              <Badge variant="outline" data-testid="boss-scheduler-health">
                Unknown
              </Badge>
              This API process runs no boss scheduler.
            </p>
            <p className="text-xs text-ink-muted">
              Its health cannot be seen from here — the scheduler, if one is running, lives in
              another process, and nothing is assumed about it.
            </p>
          </>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
              <Badge
                variant={
                  scheduler.health === 'ok'
                    ? 'default'
                    : scheduler.health === 'starting'
                      ? 'outline'
                      : 'danger'
                }
                data-testid="boss-scheduler-health"
              >
                {SCHEDULER_HEALTH_LABELS[scheduler.health]}
              </Badge>
              {scheduler.explanation}
            </p>
            <p className="text-xs text-ink-muted">
              {scheduler.passes} pass{scheduler.passes === 1 ? '' : 'es'} · every{' '}
              {Math.round(scheduler.intervalMs / 1000)} s · last completed{' '}
              {scheduler.lastPassCompletedAt ? formatLocal(scheduler.lastPassCompletedAt) : 'never'}
              {scheduler.lastPassGuilds !== null &&
                ` · ${scheduler.lastPassUsableGuilds ?? 0} of ${scheduler.lastPassGuilds} servers usable`}
            </p>
            {scheduler.lastError && (
              <p className="text-xs text-danger">
                Last error {formatLocal(scheduler.lastError.at)}: {scheduler.lastError.message}
              </p>
            )}
          </>
        )}
      </div>

      <div className="space-y-1" data-testid="boss-bootstrap">
        <h3 className="text-xs font-semibold uppercase text-ink-muted">Definitions</h3>
        <p className="text-sm">
          {bootstrap.definitions} boss definition{bootstrap.definitions === 1 ? '' : 's'} in the
          database.
        </p>
        {bootstrap.missingShipped.length > 0 && (
          <p className="text-xs text-danger" role="alert">
            {bootstrap.missingShipped.length} shipped boss
            {bootstrap.missingShipped.length === 1 ? ' has' : 'es have'} no definition (
            {bootstrap.missingShipped.join(', ')}). The startup import did not complete — check the
            server log for <code>boss-definitions/bootstrap-failed</code> and restart.
          </p>
        )}
        {bootstrap.lastRun?.error && (
          <p className="text-xs text-danger" role="alert">
            The last startup import failed {formatLocal(bootstrap.lastRun.at)}:{' '}
            {bootstrap.lastRun.error}
          </p>
        )}
        {bootstrap.lastRun && bootstrap.lastRun.heldBack.length > 0 && (
          <p className="text-xs text-ink-muted">
            Imported disabled at the last start, waiting to be activated:{' '}
            {bootstrap.lastRun.heldBack.join(', ')}.
          </p>
        )}
      </div>

      <div className="space-y-1" data-testid="boss-guild-state">
        <h3 className="text-xs font-semibold uppercase text-ink-muted">This server</h3>
        <dl className="space-y-1">
          <Fact label="Region" value={titleCase(guild.region)} testId="guild-region" />
          <Fact
            label="Boss channel"
            value={
              guild.channelConfigured
                ? 'Configured'
                : 'Not configured — no boss can spawn until one is set'
            }
            testId="guild-channel"
          />
          <Fact
            label="Spawning"
            value={
              guild.suspendedReason
                ? `Suspended: ${guild.suspendedReason}${guild.suspendedAt ? ` (since ${formatLocal(guild.suspendedAt)})` : ''}`
                : guild.paused
                  ? 'Paused by an admin'
                  : 'Running'
            }
            testId="guild-paused"
          />
          <Fact
            label="Next spawn"
            value={
              guild.cooldownActive && guild.nextSpawnAt
                ? `On cooldown until ${formatLocal(guild.nextSpawnAt)}`
                : guild.nextSpawnAt
                  ? `Due since ${formatLocal(guild.nextSpawnAt)}`
                  : 'Due as soon as a boss is eligible'
            }
            testId="guild-next-spawn"
          />
          <Fact
            label="Shuffle bag"
            value={`${guild.bagRemaining} boss${guild.bagRemaining === 1 ? '' : 'es'} still owed`}
            testId="guild-bag"
          />
          <Fact
            label="Active encounter"
            value={
              data.active
                ? `${data.active.bossName} (#${data.active.id}, ${ENCOUNTER_STATUS_LABELS[data.active.status].toLowerCase()})`
                : 'None'
            }
            testId="guild-active"
          />
        </dl>
      </div>

      <div className="space-y-2" data-testid="boss-verdicts">
        <h3 className="text-xs font-semibold uppercase text-ink-muted">Bosses, by verdict</h3>
        {data.bosses.length === 0 && (
          <p className="text-sm text-ink-muted">
            {data.featureEnabled
              ? 'There are no bosses.'
              : 'Boss encounters are switched off, so no boss is being considered.'}
          </p>
        )}
        {VERDICTS.map((verdict) => {
          const group = data.bosses.filter((b) => b.verdict === verdict);
          if (group.length === 0) return null;
          return (
            <div key={verdict} data-testid={`verdict-${verdict}`}>
              <p className="text-sm font-medium text-ink">
                {VERDICT_LABELS[verdict]} ({group.length})
              </p>
              <ul className="space-y-0.5 text-sm">
                {group.map((b) => (
                  <li
                    key={b.id}
                    className="flex flex-wrap items-center gap-2"
                    data-testid="verdict-boss"
                  >
                    <Link to={bossPath(b.id)} className="text-ink hover:underline">
                      {b.name}
                    </Link>
                    {verdict === 'not_active' && <BossStatusBadge status={b.status} />}
                    {b.heldByCooldown && (
                      <Badge variant="outline" data-testid="held-by-cooldown">
                        Waiting on the respawn cooldown
                      </Badge>
                    )}
                    {verdict === 'outside_schedule' && (
                      <span className="text-xs text-ink-muted">
                        {b.scheduleSummary} · {nextWindowLine(b.availability, b.timezone)}
                      </span>
                    )}
                    {b.detail && <span className="text-xs text-ink-muted">{b.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-ink-subtle">Read {formatLocal(data.generatedAt)}.</p>
    </div>
  );
}
