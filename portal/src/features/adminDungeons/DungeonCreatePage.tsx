import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createDungeon, getDungeonReference, DUNGEONS_QUERY_KEY } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { useHasPermission } from '@/auth/useSession';
import { keyFromName, starterDungeon } from './dungeonModel';
import { DungeonIssues, errorIssues } from './zoneFormParts';
export function DungeonCreatePage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const canWrite = useHasPermission('dungeons.write');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [customKey, setCustomKey] = useState(false);
  const [regions, setRegions] = useState<string[]>([]);
  const reference = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'reference'],
    queryFn: ({ signal }) => getDungeonReference(signal),
  });
  const create = useMutation({
    mutationFn: () => createDungeon(starterDungeon(key, name.trim(), regions)),
    onSuccess: async (d) => {
      await client.invalidateQueries({ queryKey: DUNGEONS_QUERY_KEY });
      navigate(`/admin/dungeons/definitions/${encodeURIComponent(d.key)}`);
    },
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title="Create dungeon draft"
        description="Creates an unpublished draft with an empty entrance and extraction point. Rooms and sequences will be edited in the visual editor."
      />
      <Link to="/admin/dungeons">Back to dungeons</Link>
      {!canWrite && <p role="alert">You do not have permission to create dungeon drafts.</p>}
      {reference.isPending && <p>Loading regions…</p>}
      {reference.isError && (
        <ErrorState
          title="Could not load regions"
          error={reference.error}
          onRetry={() => void reference.refetch()}
        />
      )}
      <Card className="space-y-3 p-4">
        <label className="block">
          Dungeon name
          <Input
            aria-label="Dungeon name"
            maxLength={100}
            disabled={!canWrite || create.isPending}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!customKey) setKey(keyFromName(e.target.value));
            }}
          />
        </label>
        <label className="block">
          Dungeon key
          <Input
            aria-label="Dungeon key"
            maxLength={64}
            disabled={!canWrite || create.isPending}
            value={key}
            onChange={(e) => {
              setCustomKey(true);
              setKey(e.target.value);
            }}
          />
        </label>
        <fieldset disabled={!canWrite || create.isPending}>
          <legend>Available regions</legend>
          {reference.data?.regions.map((r) => (
            <label key={r.id} className="mr-4">
              <input
                type="checkbox"
                checked={regions.includes(r.id)}
                disabled={!r.enabled}
                onChange={(e) =>
                  setRegions(
                    e.target.checked ? [...regions, r.id] : regions.filter((id) => id !== r.id),
                  )
                }
              />{' '}
              {r.name}
              {!r.enabled && ' (disabled)'}
            </label>
          ))}
        </fieldset>
        {create.isError && (
          <div>
            <ErrorState title="Could not create draft" error={create.error} />
            <DungeonIssues issues={errorIssues(create.error)} />
          </div>
        )}
        {canWrite && (
          <Button
            disabled={
              create.isPending ||
              !reference.data ||
              !name.trim() ||
              !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(key) ||
              !regions.length
            }
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Create draft'}
          </Button>
        )}
      </Card>
    </div>
  );
}
