import { useContext, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  listSharedPools,
  SHARED_POOL_QUERY,
  type SharedPoolDefinition,
} from '@/api/adminDungeonSpeciesPools';
import type {
  DungeonDefinition,
  DungeonSpeciesRef,
  DungeonSpeciesPoolEntry,
} from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EventEditorContext } from './eventEditorContext';
import { SPECIES_POOL_LIMITS, speciesAccessView, speciesPolicyOf } from './dungeonSpeciesModel';

const speciesCount = (entries: DungeonSpeciesPoolEntry[]) =>
  new Set(entries.flatMap((e) => ('species' in e ? [e.species] : []))).size;
export function EncounterPoolPicker({
  definition,
  poolId,
  disabled,
  species,
  direct,
  onLocal,
  onShared,
}: {
  definition: DungeonDefinition;
  poolId: string;
  disabled: boolean;
  species: DungeonSpeciesRef[];
  direct: boolean;
  onLocal: (id: string) => void;
  onShared: (pool: SharedPoolDefinition) => void;
}) {
  const [search, setSearch] = useState('');
  const host = useContext(EventEditorContext);
  const catalogue = useQuery({
    queryKey: SHARED_POOL_QUERY,
    queryFn: ({ signal }) => listSharedPools(signal),
  });
  const attached = definition.speciesPools ?? [];
  const selected = attached.find((p) => p.id === poolId);
  const sharedKey = selected?.sharedPoolKey;
  const selectedShared = catalogue.data?.find((p) => p.definition.key === sharedKey)?.definition;
  const needle = search.trim().toLowerCase();
  const matches = (name: string, id: string) => `${name} ${id}`.toLowerCase().includes(needle);
  const value = sharedKey ? `shared:${sharedKey}` : poolId;
  const full = attached.length >= SPECIES_POOL_LIMITS.pools;
  const needsAccess =
    selectedShared?.entries.flatMap((e) => {
      if (!('species' in e)) return [];
      const ref = species.find((s) => s.slug === e.species);
      if (!ref) return [];
      const access = speciesAccessView(ref, definition.key, speciesPolicyOf(definition, ref.slug));
      return !access.permitted || (direct && !access.directRescue.available) ? [ref.name] : [];
    }) ?? [];
  return (
    <section aria-label="Encounter pool picker" className="space-y-2">
      <Input
        type="search"
        aria-label="Search WaifuMon pools"
        placeholder="Search local and shared pools…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        disabled={disabled}
      />
      <select
        aria-label="WaifuMon pool"
        className="w-full rounded border border-border bg-surface p-2 text-sm"
        disabled={disabled}
        value={value}
        onChange={(e) => {
          const key = e.target.value.startsWith('shared:') ? e.target.value.slice(7) : null;
          if (key !== null) {
            const shared = catalogue.data?.find((p) => p.definition.key === key)?.definition;
            if (
              shared?.enabled &&
              !catalogue.isError &&
              (!full || attached.some((p) => p.sharedPoolKey === key))
            )
              onShared(shared);
          } else onLocal(e.target.value);
        }}
      >
        <option value="">Choose a pool…</option>
        {poolId && !selected && (
          <option value={poolId} disabled>
            Missing pool ({poolId})
          </option>
        )}
        <optgroup label="Dungeon-local pools">
          {attached
            .filter((p) => !p.sharedPoolKey && (p.id === poolId || matches(p.name, p.id)))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · Dungeon-local · {speciesCount(p.entries)} species
              </option>
            ))}
        </optgroup>
        <optgroup label="Shared Dungeon WaifuMon pools">
          {sharedKey && !selectedShared && (
            <option value={value} disabled>
              {selected?.name} · Shared · {catalogue.isSuccess ? 'Missing' : 'Availability unknown'}{' '}
              ({sharedKey})
            </option>
          )}
          {catalogue.data
            ?.filter(
              (p) => p.definition.key === sharedKey || matches(p.definition.name, p.definition.key),
            )
            .map(({ definition: p }) => {
              const atLimit = full && !attached.some((ref) => ref.sharedPoolKey === p.key);
              return (
                <option
                  key={p.key}
                  value={`shared:${p.key}`}
                  disabled={!p.enabled || catalogue.isError || atLimit}
                >
                  {p.name} · Shared · {p.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                  {speciesCount(p.entries)} species{atLimit ? ' · Reference limit reached' : ''}
                </option>
              );
            })}
        </optgroup>
      </select>
      {catalogue.isPending && (
        <p role="status" className="text-xs text-ink-muted">
          Loading shared pools… Local pools are available.
        </p>
      )}
      {catalogue.isError && (
        <p role="alert" className="text-sm text-danger">
          Shared pools could not be loaded; availability cannot be verified.{' '}
          <Button variant="link" size="sm" onClick={() => void catalogue.refetch()}>
            Retry shared pools
          </Button>
        </p>
      )}
      {sharedKey && catalogue.isSuccess && !selectedShared && (
        <p role="alert" className="text-sm text-danger">
          Shared pool “{sharedKey}” is missing. This encounter keeps its reference; choose a
          replacement to repair it.
        </p>
      )}
      {selectedShared && !selectedShared.enabled && (
        <p role="alert" className="text-sm text-danger">
          Shared pool “{selectedShared.name}” is disabled. This encounter keeps its reference;
          enable the pool or choose a replacement before starting new runs.
        </p>
      )}
      {selectedShared && (
        <p className="text-xs text-ink-muted">
          {selectedShared.name} · Shared · {selectedShared.enabled ? 'Enabled' : 'Disabled'} ·{' '}
          {speciesCount(selectedShared.entries)} species
        </p>
      )}
      {full && (
        <p className="text-xs text-ink-muted">
          This dungeon has {SPECIES_POOL_LIMITS.pools} pool references. Reuse an attached pool or
          remove an unused one before attaching another.
        </p>
      )}
      {sharedKey && (
        <div className="space-y-1 text-xs text-ink-muted">
          <p>
            Pool membership does not authorize acquisition. This dungeon’s Species access and server
            validation still apply.
          </p>
          {!!needsAccess.length && (
            <p role="note">
              Review Species access for: {needsAccess.join(', ')}. Existing acquisition rules and
              limits are unchanged.
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!host}
            onClick={() => host?.open({ kind: 'speciesAccess', id: '' })}
          >
            Species access…
          </Button>
        </div>
      )}
    </section>
  );
}
