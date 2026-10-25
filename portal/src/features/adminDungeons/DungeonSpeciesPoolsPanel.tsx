import { useContext, useState } from 'react';
import { Copy, Pencil, Trash2 } from 'lucide-react';
import type { DungeonDefinition } from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EventEditorContext } from './eventEditorContext';
import {
  createSpeciesPool,
  deleteSpeciesPool,
  duplicateSpeciesPool,
  speciesPoolUsage,
  SPECIES_POOL_LIMITS,
} from './dungeonSpeciesModel';
export function DungeonSpeciesPoolsPanel({
  definition,
  disabled,
  onChange,
}: {
  definition: DungeonDefinition;
  disabled: boolean;
  onChange: (d: DungeonDefinition) => void;
}) {
  const host = useContext(EventEditorContext);
  const [removing, setRemoving] = useState<string | null>(null);
  const pools = definition.speciesPools ?? [];
  const pool = pools.find((p) => p.id === removing);
  const uses = removing ? speciesPoolUsage(definition, removing) : [];
  return (
    <section aria-label="WaifuMon Pools" data-testid="dungeon-species-pools" className="space-y-3">
      <h2 className="text-sm font-semibold">WaifuMon Pools</h2>
      <p className="text-xs text-ink-muted">
        Species pools belong to this dungeon. Encounter activities use their stable identities.
      </p>
      <div className="flex items-start gap-2 rounded border border-border p-2" data-testid="species-access-summary">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Species access</p>
          <p className="text-xs text-ink-muted">
            {(definition.speciesPolicies ?? []).length
              ? `${definition.speciesPolicies!.length} species with this dungeon’s own terms.`
              : 'No species terms yet.'}{' '}
            Dungeon-exclusive WaifuMon need an entry here before they can be offered.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!host}
          onClick={() => host?.open({ kind: 'speciesAccess', id: '' })}
        >
          {disabled ? 'View' : 'Edit'} Species access
        </Button>
      </div>
      {!pools.length && <p className="text-sm text-ink-muted">No WaifuMon pools yet.</p>}
      <ul aria-label="WaifuMon pools in this dungeon" className="space-y-2">
        {pools.map((p) => (
          <li
            key={p.id}
            className="flex items-start gap-1 rounded border border-border p-2"
            data-testid="species-pool-row"
            title={`Pool ID: ${p.id}`}
          >
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{p.name || 'Unnamed WaifuMon pool'}</p>
              <p className="text-xs text-ink-muted">{p.entries.length} entries</p>
              <p className="break-words text-xs text-ink-muted">
                {speciesPoolUsage(definition, p.id)
                  .map((u) => u.name)
                  .join('; ') || 'Not used yet'}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              disabled={!host}
              aria-label={`${disabled ? 'View' : 'Edit'} WaifuMon pool ${p.name}`}
              onClick={() => host?.open({ kind: 'speciesPool', id: p.id })}
            >
              <Pencil />
            </Button>
            {!disabled && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={pools.length >= SPECIES_POOL_LIMITS.pools}
                  aria-label={`Duplicate WaifuMon pool ${p.name}`}
                  onClick={() => onChange(duplicateSpeciesPool(definition, p.id).definition)}
                >
                  <Copy />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete WaifuMon pool ${p.name}`}
                  onClick={() => setRemoving(p.id)}
                >
                  <Trash2 />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {!disabled && (
        <Button
          variant="outline"
          size="sm"
          disabled={pools.length >= SPECIES_POOL_LIMITS.pools}
          onClick={() => {
            const made = createSpeciesPool(definition);
            onChange(made.definition);
            if (made.id) host?.open({ kind: 'speciesPool', id: made.id, field: 'name' });
          }}
        >
          + New WaifuMon pool
        </Button>
      )}
      <Dialog open={!!pool} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogTitle>
            {uses.length ? 'Can’t delete' : 'Delete'} “{pool?.name}”{uses.length ? ' yet' : '?'}
          </DialogTitle>
          <DialogDescription>
            {uses.length
              ? 'This pool is still used. Change these encounter sources first:'
              : 'Remove this pool from the dungeon draft.'}
          </DialogDescription>
          {!!uses.length && (
            <ul role="alert" className="space-y-1 text-sm">
              {uses.map((u) => (
                <li key={`${u.roomId}:${u.actionId}`}>{u.name}</li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex gap-2">
            {!uses.length && (
              <Button
                variant="danger"
                disabled={disabled}
                onClick={() => {
                  if (removing) onChange(deleteSpeciesPool(definition, removing));
                  setRemoving(null);
                }}
              >
                Delete WaifuMon pool
              </Button>
            )}
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {uses.length ? 'OK' : 'Keep it'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
