import { useQuery } from '@tanstack/react-query';
import { getDungeonSpeciesStatus } from '@/api/adminDungeons';
import { speciesReasonText } from './DungeonSpeciesPicker';
import type { DungeonSpeciesUnavailableReason } from '@/api/dungeonSpeciesTypes';
export function SpeciesDependencyStatus({
  dungeonKey,
  revision,
}: {
  dungeonKey: string;
  revision: number | undefined;
}) {
  const query = useQuery({
    queryKey: ['admin-dungeons', dungeonKey, 'species-status', revision],
    queryFn: ({ signal }) => getDungeonSpeciesStatus(dungeonKey, signal),
    enabled: revision !== undefined,
  });
  if (query.isLoading) return <p className="text-xs">Checking published species dependencies…</p>;
  if (query.isError)
    return (
      <p role="status" className="text-xs">
        Species dependency status is unavailable.{' '}
        <button className="underline" onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    );
  if (!query.data?.revisions.length) return null;
  return (
    <section
      className="space-y-2 rounded border border-border p-2"
      aria-label="Published species health"
      data-testid="species-dependency-status"
    >
      <h3 className="text-sm font-semibold">Published species dependencies</h3>
      <p className="text-xs text-ink-muted">
        Separate from draft validation. Definitions and active-run species draws stay pinned;
        acquisition always checks live policy. Per-player limits also apply at runtime.
      </p>
      {query.data.revisions.map((r) => (
        <div className="space-y-1 text-xs" key={r.revisionId}>
          <p className="font-semibold">
            Revision {r.revision} · {r.current ? 'current publication' : 'historical revision'} ·{' '}
            {r.activeRuns} active runs
          </p>
          <p>
            {r.evidence === 'unknown'
              ? 'No publication evidence for this older revision. Republish to record it; comparison unavailable.'
              : r.differs
                ? 'Published dependency warning: species policy or rarity differs from publication.'
                : 'Species dependencies match publication.'}
          </p>
          <ul>
            {r.dependencies.map((d) => (
              <li className="break-words" key={d.slug}>
                {d.slug}:{' '}
                {d.changes.join('; ') ||
                  (r.evidence === 'unknown' ? 'historical comparison unavailable' : 'unchanged')}
                {(d.liveRestriction || d.directRestriction) && (
                  <span className="text-danger">
                    {' '}
                    · Live acquisition restriction:{' '}
                    {speciesReasonText[
                      (d.liveRestriction ?? d.directRestriction) as DungeonSpeciesUnavailableReason
                    ] ??
                      d.liveRestriction ??
                      d.directRestriction}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
