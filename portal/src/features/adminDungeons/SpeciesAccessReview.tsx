import { useState } from 'react';
import type { DungeonDefinition, DungeonSpeciesRef } from '@/api/adminDungeons';
import type { DungeonSpeciesAccessReview } from '@/api/dungeonSpeciesTypes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SpeciesThumb, speciesReasonText } from './DungeonSpeciesPicker';
import { approveEncounterSpeciesAccess, SPECIES_POLICY_LIMIT } from './dungeonSpeciesModel';

const authorizationText = {
  content: 'Central dungeonAccess authorization',
  dungeon: 'Dungeon-specific authorization',
  both: 'Central and dungeon-specific authorization (stricter terms apply)',
  unrestricted: 'Existing species policy permits capture',
  none: 'Missing acquisition authorization',
};
export function SpeciesAccessReview({
  definition,
  rows,
  catalogue,
  disabled,
  onChange,
}: {
  definition: DungeonDefinition;
  rows: DungeonSpeciesAccessReview[];
  catalogue: Map<string, DungeonSpeciesRef>;
  disabled: boolean;
  onChange: (d: DungeonDefinition) => void;
}) {
  const candidates = rows.filter((r) => r.canAdd);
  const [selected, setSelected] = useState(() => candidates.map((r) => r.species));
  const [limit, setLimit] = useState('');
  const [approved, setApproved] = useState(false);
  const [direct, setDirect] = useState(false);
  const validLimit =
    limit.trim() !== '' && Number.isSafeInteger(Number(limit)) && Number(limit) >= 1;
  const overCapacity =
    (definition.speciesPolicies?.length ?? 0) + selected.length > SPECIES_POLICY_LIMIT;
  const needsDirect = candidates.some(
    (r) => selected.includes(r.species) && r.references.some((ref) => ref.direct),
  );
  return (
    <section
      aria-label="Encounter Species Access review"
      className="space-y-3 rounded border border-border p-3"
    >
      <h3 className="font-semibold">Review Species Access from Encounters</h3>
      <p className="text-xs text-ink-muted">
        Reviews potentially reachable Wild Encounters and Rescues, including local and shared pools.
        Conditions and locks may still prevent a particular draw. Unused pools are excluded.
        Approval edits this draft only. Save and publish separately to change live access.
      </p>
      {!rows.length && <p>No species from reachable encounters to review.</p>}
      <ul aria-label="Encounter species authorization" className="space-y-2">
        {rows.map((row) => {
          const species = catalogue.get(row.species);
          return (
            <li
              key={row.species}
              className="space-y-1 rounded border border-border p-2"
              data-testid="species-access-review-row"
            >
              <div className="flex gap-2">
                {species && <SpeciesThumb species={species} />}
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{species?.name ?? row.species}</p>
                  <p className="text-xs">
                    {authorizationText[row.authorization]}
                    {row.perPlayerLimit !== null ? ` · Limit: ${row.perPlayerLimit}` : ''}
                  </p>
                  {row.captureReason && (
                    <p className="text-xs text-danger">
                      Capture: {speciesReasonText[row.captureReason]}
                    </p>
                  )}
                  {row.directReason && (
                    <p className="text-xs text-danger">
                      Direct Rescue: {speciesReasonText[row.directReason]}
                    </p>
                  )}
                  <ul className="text-xs text-ink-muted">
                    {row.references.map((ref) => (
                      <li key={`${ref.roomId}:${ref.actionId}`}>
                        {ref.roomName} — {ref.actionName}
                        {ref.direct ? ' (Direct Rescue)' : ''}
                        {ref.poolId
                          ? ` · ${ref.sharedPoolKey ? 'Shared' : 'Local'} pool “${ref.poolName}”`
                          : ''}
                        {ref.sharedPoolKey ? ` (${ref.sharedPoolKey})` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {row.canAdd ? (
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={selected.includes(row.species)}
                    aria-label={`Create access for ${species?.name ?? row.species}`}
                    onChange={(e) => {
                      setSelected(
                        e.target.checked
                          ? [...selected, row.species]
                          : selected.filter((s) => s !== row.species),
                      );
                      setApproved(false);
                    }}
                  />
                  Create dungeon-specific access
                </label>
              ) : (
                (row.captureReason || row.directReason) && (
                  <p className="text-xs">
                    {row.authorization === 'dungeon' || row.authorization === 'both'
                      ? 'Review the existing entry below; bulk approval preserves its terms.'
                      : 'Bulk creation cannot repair this restriction. Review central species policy or change the encounter.'}
                  </p>
                )
              )}
            </li>
          );
        })}
      </ul>
      {!!candidates.length && (
        <fieldset disabled={disabled} className="space-y-3">
          <label className="block text-sm">
            Maximum acquisitions per player from this dungeon for each selected species
            <Input
              type="number"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              value={limit}
              aria-label="Bulk per-player acquisition limit"
              placeholder="Choose a finite limit"
              className="mt-1 w-48"
              onChange={(e) => {
                setLimit(e.target.value);
                setApproved(false);
              }}
            />
          </label>
          <p className="text-xs text-ink-muted">
            Counts captures and rescues across all runs of this dungeon. Existing entries and
            central limits are preserved.
          </p>
          {needsDirect && (
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={direct}
                onChange={(e) => {
                  setDirect(e.target.checked);
                  setApproved(false);
                }}
              />
              Also allow Direct Rescue for selected species used by Direct Rescue
            </label>
          )}
          {needsDirect && !direct && (
            <p className="text-xs">
              Direct Rescue remains blocked until explicitly permitted. Capture access alone does
              not authorize Direct Rescue.
            </p>
          )}
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            I approve creating {selected.length} dungeon-specific access entries with the selected
            limit
          </label>
          {overCapacity && (
            <p role="alert">
              Select fewer species: this dungeon supports at most {SPECIES_POLICY_LIMIT} access
              entries.
            </p>
          )}
          <Button
            disabled={!approved || !validLimit || !selected.length || overCapacity}
            onClick={() => {
              const next = approveEncounterSpeciesAccess(
                definition,
                rows,
                selected,
                Number(limit),
                approved,
                direct,
              );
              if (next !== definition) {
                setApproved(false);
                onChange(next);
              }
            }}
          >
            Add {selected.length} access entries to draft
          </Button>
        </fieldset>
      )}
    </section>
  );
}
