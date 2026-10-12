/**
 * Reward Health: whether the rewards frozen into each published dungeon can
 * still be given to players. Read-only; nothing here repairs anything.
 */
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  DUNGEONS_QUERY_KEY,
  getDungeonRewardHealth,
  type DungeonRewardHealthEntry,
  type DungeonRewardHealthProblem,
} from '@/api/adminDungeons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/layout/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';

const editor = (d: DungeonRewardHealthEntry) =>
  `/admin/dungeons/definitions/${encodeURIComponent(d.key)}`;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Problems({ problems }: { problems: DungeonRewardHealthProblem[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {problems.map((problem, n) => (
        <li key={n} title={problem.key ?? problem.reason}>
          <span className="text-ink">{problem.message}</span>{' '}
          <span className="text-ink-muted">{problem.hint}</span>
        </li>
      ))}
    </ul>
  );
}

export function RewardHealthPanel() {
  const query = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'reward-health'],
    queryFn: ({ signal }) => getDungeonRewardHealth(signal),
  });
  const dungeons = query.data?.dungeons ?? [];
  const broken = dungeons.filter((d) => d.status === 'broken');
  // An older revision still being played that can no longer pay what it promised those runs.
  const stranded = (d: DungeonRewardHealthEntry) =>
    d.activeRevisions.filter((r) => r.status === 'broken');
  const strandedIn = dungeons.filter((d) => stranded(d).length > 0);
  const affected = dungeons.filter((d) => d.status === 'broken' || stranded(d).length > 0);
  // Not broken rewards: an event choice asks for an item that is gone or disabled.
  const noticesOf = (d: DungeonRewardHealthEntry) => [
    ...(d.notices ?? []),
    ...d.activeRevisions.flatMap((r) => r.notices ?? []),
  ];
  const noticed = dungeons.filter((d) => noticesOf(d).length > 0);
  // A draft problem on a dungeon whose rewards can all be paid is the author's to-do, not an outage.
  const draftOnly = dungeons.filter((d) => !affected.includes(d) && d.draftErrors > 0);
  const of = (status: DungeonRewardHealthEntry['status']) =>
    dungeons.filter((d) => d.status === status).length;
  return (
    <section className="space-y-2" aria-label="Reward Health" data-testid="reward-health">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase text-ink-muted">Reward Health</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Check again
        </Button>
      </div>
      <p className="text-xs text-ink-muted">
        Whether the rewards frozen into each published dungeon, and into any older revision a run is
        still on, can still be given to players. A loot table edited since a dungeon was published
        is not a problem here: a published dungeon keeps its own copy, and shows “Loot changed”
        above until you publish it again.
      </p>
      {query.isPending && <Skeleton className="h-16 w-full" />}
      {query.isError && (
        <ErrorState
          variant="inline"
          title="Could not check reward health"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && (
        <>
          {affected.length === 0 && (
            <Card className="p-4 text-sm" data-testid="reward-health-ok">
              {of('healthy') + of('no_rewards') === 0
                ? 'No dungeon is published yet, so there is nothing to check.'
                : 'Every published dungeon can deliver its rewards, and so can every older revision a run is still on.'}
            </Card>
          )}
          {broken.length > 0 && (
            <p className="text-sm font-medium text-danger" role="alert">
              {count(broken.length, 'published dungeon has', 'published dungeons have')} rewards
              that cannot be delivered. Players in these dungeons are told the reward cannot be
              given right now until it is repaired.
            </p>
          )}
          {strandedIn.length > 0 && (
            <p
              className="text-sm font-medium text-danger"
              role="alert"
              data-testid="reward-health-stranded"
            >
              {count(strandedIn.length, 'dungeon has', 'dungeons have')} runs in progress on an
              older revision whose rewards cannot be delivered. Publishing again does not change a
              run that has already started.
            </p>
          )}
          {affected.map((d) => (
            <Card key={d.key} className="space-y-2 p-4" data-testid={`reward-health-${d.key}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Link className="font-medium hover:underline" to={editor(d)}>
                  {d.name}
                </Link>
                {d.status === 'broken' ? (
                  <Badge variant="danger">Broken published rewards</Badge>
                ) : (
                  <Badge variant="outline">Current publication is healthy</Badge>
                )}
                {stranded(d).length > 0 && (
                  <Badge variant="danger">Runs in progress affected</Badge>
                )}
                <Badge>Published {d.revision}</Badge>
                {!d.enabled && <Badge>Disabled</Badge>}
              </div>
              {d.status === 'broken' && (
                <div className="space-y-1" data-testid={`reward-health-${d.key}-current`}>
                  <p className="text-xs text-ink-muted">
                    Published revision {d.revision}, which new runs start on
                    {d.activeRuns > 0
                      ? ` (${count(d.activeRuns, 'run', 'runs')} in progress on it)`
                      : ''}
                    :
                  </p>
                  <Problems problems={d.problems} />
                </div>
              )}
              {stranded(d).map((r) => (
                <div
                  key={r.revision}
                  className="space-y-1"
                  data-testid={`reward-health-${d.key}-revision-${r.revision}`}
                >
                  <p className="text-xs text-ink-muted">
                    Revision {r.revision}, no longer published, with{' '}
                    {count(r.activeRuns, 'run', 'runs')} still in progress:
                  </p>
                  <Problems problems={r.problems} />
                </div>
              ))}
              {d.draftErrors > 0 && (
                <p className="text-xs text-ink-muted">
                  Its draft also has {count(d.draftErrors, 'problem', 'problems')} to fix before it
                  can be published again.
                </p>
              )}
            </Card>
          ))}
          {noticed.length > 0 && (
            <Card className="space-y-1 p-4 text-sm" data-testid="reward-health-notices">
              <p className="font-medium">Event choices players cannot pick</p>
              <p className="text-xs text-ink-muted">
                No reward is affected. An event choice needs an item that is missing or disabled, so
                players see that choice as unavailable and use another.
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {noticed.map((d) => (
                  <li key={d.key}>
                    <Link className="hover:underline" to={editor(d)}>
                      {d.name}
                    </Link>
                    :{' '}
                    {[...new Map(noticesOf(d).map((n) => [n.key, n])).values()].map((n) => (
                      <span key={n.key} title={n.key}>
                        {n.message} <span className="text-ink-muted">{n.hint}</span>{' '}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {draftOnly.length > 0 && (
            <Card className="space-y-1 p-4 text-sm" data-testid="reward-health-drafts">
              <p className="font-medium">Drafts with problems</p>
              <p className="text-xs text-ink-muted">
                Players are not affected: these are in drafts only, and block the next publish.
              </p>
              <ul className="list-disc pl-5">
                {draftOnly.map((d) => (
                  <li key={d.key}>
                    <Link className="hover:underline" to={editor(d)}>
                      {d.name}
                    </Link>
                    : {count(d.draftErrors, 'thing', 'things')} to fix
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <p className="text-xs text-ink-subtle" data-testid="reward-health-counts">
            {count(of('healthy'), 'dungeon', 'dungeons')} healthy · {of('no_rewards')} published
            with the older treasure settings only (nothing frozen to check) · {of('unpublished')}{' '}
            not published
          </p>
        </>
      )}
    </section>
  );
}
