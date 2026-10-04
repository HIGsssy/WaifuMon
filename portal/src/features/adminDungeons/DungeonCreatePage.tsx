/**
 * Admin — create a dungeon.
 *
 * Three questions and nothing else: what it is called, where it is open, and
 * how its rooms come to be. Create saves a small working starter — disabled,
 * so no player sees it — and opens the editor on it. Pools, rules, rewards
 * and artwork are all for later, in the editor, once the dungeon exists.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  DUNGEONS_QUERY_KEY,
  createDungeonZone,
  getDungeonReference,
  listDungeonZones,
  type DungeonLayoutMode,
  type DungeonZoneIssue,
} from '@/api/adminDungeons';
import { isPortalApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/layout/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { selectClass } from '@/features/adminEncounters/EntitySelect';

import { DUNGEON_KEY_PATTERN, keyFromName, starterZone } from './dungeonModel';
import { Issues } from './zoneFormParts';

const LAYOUTS: { mode: DungeonLayoutMode; label: string; description: string }[] = [
  {
    mode: 'procedural',
    label: 'Procedural',
    description:
      'Every run is generated fresh from enemy pools and a few rules. Starts with one combat pool, a boss, and a rest before it.',
  },
  {
    mode: 'authored',
    label: 'Build room-by-room',
    description:
      'You lay out the rooms and every run walks them. Starts with Start → Combat → Rest → Boss.',
  },
];

/** A key no existing dungeon has: the name's own, or the name's with a number. */
function freeKey(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

export function DungeonCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reference = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'reference'],
    queryFn: ({ signal }) => getDungeonReference(signal),
    staleTime: 60_000,
  });
  const zones = useQuery({
    queryKey: [...DUNGEONS_QUERY_KEY, 'zones'],
    queryFn: ({ signal }) => listDungeonZones(signal),
  });

  const regions = reference.data?.regions ?? [];
  const [name, setName] = useState('');
  const [regionChoice, setRegionChoice] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<DungeonLayoutMode | null>(null);
  /** Set only when the author chose to type their own key. */
  const [customKey, setCustomKey] = useState<string | null>(null);

  const region = regionChoice ?? regions.find((r) => r.enabled)?.id ?? regions[0]?.id ?? '';
  const suggested = freeKey(
    keyFromName(name),
    (zones.data?.zones ?? []).map((z) => z.key),
  );
  const key = customKey ?? suggested;
  const keyUsable = DUNGEON_KEY_PATTERN.test(key);
  const ready = name.trim() !== '' && region !== '' && layoutMode !== null && keyUsable;

  const create = useMutation({
    mutationFn: () =>
      createDungeonZone(
        starterZone(
          { name, key, regions: [region], layoutMode: layoutMode! },
          { enemies: reference.data?.enemies ?? [] },
        ),
      ),
    onSuccess: (detail) => {
      void queryClient.invalidateQueries({ queryKey: DUNGEONS_QUERY_KEY });
      navigate(`/admin/dungeons/zones/${encodeURIComponent(detail.key)}`, { replace: true });
    },
  });
  const refused =
    isPortalApiError(create.error) && create.error.code === 'DUNGEON_ZONE_INVALID'
      ? (((create.error.details ?? {}) as { issues?: DungeonZoneIssue[] }).issues ?? [])
      : null;
  const keyTaken = isPortalApiError(create.error) && create.error.code === 'DUNGEON_ZONE_KEY_TAKEN';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Create dungeon"
        description="Name it, say where it is open, and choose how its rooms are made. Everything else comes after, in the editor."
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/dungeons">Back to dungeons</Link>
          </Button>
        }
      />
      <Card className="max-w-2xl space-y-5 p-5" data-testid="dungeon-wizard">
        <label className="block text-sm text-ink">
          Name
          <Input
            aria-label="Dungeon name"
            className="mt-1"
            placeholder="Blacksite Lab"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="block text-sm text-ink">
          Available in
          <select
            aria-label="Available in"
            className={`${selectClass} mt-1 block`}
            value={region}
            onChange={(e) => setRegionChoice(e.target.value)}
          >
            {regions.length === 0 && <option value="">Loading regions…</option>}
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.enabled ? '' : ' (not released)'}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-ink-subtle">
            Where a player must be standing to start a run. You can add more regions later.
          </span>
        </label>

        <fieldset className="space-y-2">
          <legend className="text-sm text-ink">Layout</legend>
          {LAYOUTS.map((option) => (
            <label
              key={option.mode}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent"
            >
              <input
                type="radio"
                name="layout"
                className="mt-1"
                aria-label={option.label}
                checked={layoutMode === option.mode}
                onChange={() => setLayoutMode(option.mode)}
              />
              <span>
                <span className="text-sm font-medium text-ink">{option.label}</span>
                <span className="block text-xs text-ink-muted">{option.description}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-ink-subtle">
            The layout is chosen here. It can be changed later, but that is a deliberate step.
          </p>
        </fieldset>

        <details className="text-xs text-ink-muted" data-testid="wizard-key">
          <summary className="cursor-pointer">
            Internal key: <span className="font-mono text-ink">{key || '—'}</span>
          </summary>
          <label className="mt-2 block">
            Key (lower_snake_case, permanent)
            <Input
              aria-label="Dungeon key"
              className="mt-1 w-72 font-mono"
              value={key}
              onChange={(e) => setCustomKey(e.target.value)}
            />
          </label>
          <p className="mt-1 text-ink-subtle">
            Made from the name. It can never be changed once the dungeon exists — runs record it.
          </p>
        </details>
        {name.trim() !== '' && !keyUsable && (
          <p className="text-xs text-danger" role="alert">
            The internal key must be lower_snake_case — letters, digits and underscores.
          </p>
        )}

        {refused && <Issues issues={refused} />}
        {keyTaken && (
          <p className="text-xs text-danger" role="alert">
            A dungeon with the key “{key}” already exists — change the name or the internal key.
          </p>
        )}
        {create.isError && !refused && !keyTaken && (
          <ErrorState variant="inline" title="Could not create the dungeon" error={create.error} />
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="accent"
            disabled={!ready || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
          <span className="text-xs text-ink-subtle">
            It is created switched off — players do not see it until you enable it.
          </span>
        </div>
      </Card>
    </div>
  );
}
