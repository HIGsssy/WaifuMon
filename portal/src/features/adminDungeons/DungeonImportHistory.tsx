import { useQuery } from '@tanstack/react-query';
import { DUNGEONS_QUERY_KEY, getDungeonImportHistory } from '@/api/adminDungeons';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/layout/ErrorState';

const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : 'Unknown';
export function DungeonImportHistory({ dungeonKey }: { dungeonKey: string }) {
  const query = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'definition', dungeonKey, 'import-history'],
    queryFn: ({ signal }) => getDungeonImportHistory(dungeonKey, signal),
  });
  return (
    <Card className="space-y-2 p-4">
      <h2>Import history</h2>
      {query.isPending && <p>Loading import history…</p>}
      {query.isError && (
        <ErrorState
          title="Could not load import history"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data?.imports.length === 0 && <p>No imports yet.</p>}
      <ul className="space-y-3">
        {query.data?.imports.map((entry) => (
          <li key={entry.id} className="break-all">
            <p>
              {new Date(entry.importedAt).toLocaleString()} · {entry.sourceEnvironment} ·{' '}
              {entry.actor ?? 'Unknown administrator'}
            </p>
            <p>Package: {entry.packageId}</p>
            <p>
              Result: {text(entry.result.result)} · Draft revision{' '}
              {text(entry.result.draftRevision)}
            </p>
            <p>
              Draft decision: {text(entry.decisions.dungeon)} · Accept missing dependencies:{' '}
              {entry.decisions.allowMissingDependencies === true ? 'Yes' : 'No'}
            </p>
            {entry.decisions.enemies != null && typeof entry.decisions.enemies === 'object' && (
              <ul>
                {Object.entries(entry.decisions.enemies).map(([key, value]) => (
                  <li key={key}>
                    Enemy {key}: {text(value)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
