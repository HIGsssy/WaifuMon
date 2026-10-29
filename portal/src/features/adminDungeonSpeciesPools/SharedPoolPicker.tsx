import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listSharedPools, SHARED_POOL_QUERY } from '@/api/adminDungeonSpeciesPools';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
export function SharedPoolPicker({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (key: string, name: string) => void;
}) {
  const [search, setSearch] = useState('');
  const pools = useQuery({
    queryKey: SHARED_POOL_QUERY,
    queryFn: ({ signal }) => listSharedPools(signal),
  });
  return (
    <section aria-label="Shared WaifuMon pool picker" className="space-y-2">
      <Input
        aria-label="Search shared pools"
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {pools.isPending && <p role="status">Loading shared pools…</p>}
      {pools.isError && (
        <p role="alert">
          Shared pools could not be loaded.{' '}
          <Button onClick={() => void pools.refetch()}>Retry</Button>
        </p>
      )}
      <ul className="max-h-64 space-y-2 overflow-y-auto">
        {pools.data
          ?.filter((p) =>
            `${p.definition.name} ${p.definition.key}`.toLowerCase().includes(search.toLowerCase()),
          )
          .map(({ definition: p }) => (
            <li key={p.key} className="rounded border border-border p-2 text-sm">
              <p>
                {p.name} · {p.key} · {p.enabled ? 'Enabled' : 'Disabled'} · {p.entries.length}{' '}
                entries
              </p>
              <p>{p.description}</p>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !p.enabled}
                onClick={() => onSelect(p.key, p.name)}
              >
                Use shared pool {p.name}
              </Button>
            </li>
          ))}
      </ul>
    </section>
  );
}
