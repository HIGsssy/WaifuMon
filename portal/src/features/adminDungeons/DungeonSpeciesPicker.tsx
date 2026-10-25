import { useState } from 'react';
import {
  dungeonSpeciesArtworkBlob,
  type DungeonSpeciesPolicyEntry,
  type DungeonSpeciesRef,
} from '@/api/adminDungeons';
import { speciesAccessView, speciesSelectable } from './dungeonSpeciesModel';
import { ArtworkThumbnail } from '@/components/media/ArtworkThumbnail';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { DungeonSpeciesUnavailableReason } from '@/api/dungeonSpeciesTypes';
export const speciesReasonText: Record<DungeonSpeciesUnavailableReason, string> = {
  missing: 'Species is missing from the catalogue',
  disabled: 'Species is disabled',
  not_permitted: 'Not permitted in this dungeon',
  player_limit: 'This player has reached the limit in this dungeon',
  direct_not_permitted: 'Direct rescue is not authorized',
  direct_limit_missing: 'Direct rescue needs an explicit finite limit',
};
const hint = 'text-xs text-ink-muted';
export function SpeciesAvailability({
  species,
  dungeonKey,
  entry,
}: {
  species: DungeonSpeciesRef;
  /** With a key, availability includes this dungeon's own Species access entry. */
  dungeonKey?: string;
  entry?: DungeonSpeciesPolicyEntry | undefined;
}) {
  const view = dungeonKey
    ? speciesAccessView(species, dungeonKey, entry)
    : {
        permitted: species.permitted,
        reason: species.unavailableReason,
        limit: species.perPlayerLimit,
        directRescue: species.directRescue,
        source: null,
      };
  const admissible = !view.permitted && view.reason === 'not_permitted' && species.dungeonPolicyAllowed;
  return (
    <div className="min-w-0 space-y-1">
      <p className={hint}>
        {species.rarity} · {species.race} · {species.affinity}
      </p>
      <p className={view.permitted || admissible ? hint : 'text-xs text-danger'}>
        {species.enabled ? 'Enabled' : 'Disabled'} ·{' '}
        {species.regionExclusive ? 'Region-exclusive' : 'No region exclusivity'} ·{' '}
        {species.dungeonExclusive ? 'Dungeon-exclusive' : 'No dungeon exclusivity'}
      </p>
      <p className={view.permitted ? hint : admissible ? 'text-xs font-medium' : 'text-xs text-danger'}>
        {view.permitted
          ? view.source === 'dungeon' || view.source === 'both'
            ? 'Permitted by this dungeon’s Species access'
            : 'Permitted in this dungeon'
          : admissible
            ? 'Needs Species access in this dungeon before it can be offered'
            : speciesReasonText[view.reason ?? 'not_permitted']}
      </p>
      <p className={hint}>
        Maximum acquisitions per player from this dungeon:{' '}
        {view.limit === null
          ? 'unlimited (no limit configured)'
          : view.limit === 'unlimited'
            ? 'unlimited (explicit)'
            : view.limit}{' '}
        — across all runs.
      </p>
      <p className={hint}>
        Direct Rescue:{' '}
        {view.directRescue.available
          ? 'allowed, with a finite limit'
          : speciesReasonText[view.directRescue.reason ?? 'direct_not_permitted'].toLowerCase()}
        .
      </p>
      {!!species.dungeonAccess.length && (
        <p className={`${hint} break-words`}>
          Species content access (read-only):{' '}
          {species.dungeonAccess
            .map(
              (a) =>
                `${a.dungeon} (limit ${a.perPlayerLimit ?? 'unlimited by default'}${a.directRescue ? ', direct rescue authorized' : ''})`,
            )
            .join('; ')}
          {view.source === 'both' ? '. Where both set terms, the stricter applies.' : '.'}
        </p>
      )}
    </div>
  );
}
export function SpeciesThumb({ species }: { species: DungeonSpeciesRef }) {
  return (
    <div className="w-16 shrink-0" data-testid={`species-${species.slug}-thumbnail`}>
      <ArtworkThumbnail path={species.slug} load={dungeonSpeciesArtworkBlob} alt={species.name} />
    </div>
  );
}
export function DungeonSpeciesPicker({
  species,
  listed,
  disabled,
  onSelect,
  purpose = 'pool',
  dungeonKey,
  policies,
}: {
  species: DungeonSpeciesRef[];
  listed: Set<string>;
  disabled: boolean;
  onSelect: (slug: string) => void;
  purpose?: 'pool' | 'encounter';
  dungeonKey: string;
  /** The draft's Species access entries. */
  policies?: DungeonSpeciesPolicyEntry[] | undefined;
}) {
  const entryOf = (slug: string) => policies?.find((p) => p.species === slug);
  const permitted = (s: DungeonSpeciesRef) => speciesAccessView(s, dungeonKey, entryOf(s.slug)).permitted;
  const [search, setSearch] = useState('');
  const [rarity, setRarity] = useState('');
  const [race, setRace] = useState('');
  const [affinity, setAffinity] = useState('');
  const [status, setStatus] = useState('all');
  const needle = search.trim().toLowerCase();
  const rows = species.filter(
    (s) =>
      (!needle || `${s.name} ${s.slug}`.toLowerCase().includes(needle)) &&
      (!rarity || s.rarity === rarity) &&
      (!race || s.race === race) &&
      (!affinity || s.affinity === affinity) &&
      (status === 'all' || (status === 'permitted' ? permitted(s) : !permitted(s))),
  );
  return (
    <section aria-label="Species picker" className="space-y-2">
      <Input
        type="search"
        aria-label="Search species"
        placeholder="Search by name or slug…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-2">
        {[
          {
            label: 'Rarity',
            value: rarity,
            set: setRarity,
            options: [...new Set(species.map((s) => s.rarity))],
          },
          {
            label: 'Race',
            value: race,
            set: setRace,
            options: [...new Set(species.map((s) => s.race))],
          },
          {
            label: 'Affinity',
            value: affinity,
            set: setAffinity,
            options: [...new Set(species.map((s) => s.affinity))],
          },
        ].map((f) => (
          <label key={f.label} className={hint}>
            {f.label}
            <select
              aria-label={`Filter species by ${f.label.toLowerCase()}`}
              className="block w-full rounded border border-border bg-surface p-2 text-sm"
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
            >
              <option value="">All</option>
              {f.options.sort().map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
        ))}
        <label className={hint}>
          Availability
          <select
            aria-label="Filter species by availability"
            className="block w-full rounded border border-border bg-surface p-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All</option>
            <option value="permitted">Permitted</option>
            <option value="unavailable">Unavailable</option>
          </select>
        </label>
      </div>
      <ul className="max-h-96 space-y-2 overflow-y-auto" aria-label="Matching species">
        {rows.map((s) => {
          const selectable = speciesSelectable(s, dungeonKey, entryOf(s.slug));
          const ready = permitted(s);
          return (
          <li
            key={s.slug}
            className="space-y-2 rounded border border-border p-2"
            data-testid={`species-option-${s.slug}`}
          >
            <div className="flex gap-2">
              <SpeciesThumb species={s} />
              <div className="min-w-0">
                <p className="break-words text-sm font-medium">{s.name}</p>
                <SpeciesAvailability species={s} dungeonKey={dungeonKey} entry={entryOf(s.slug)} />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !selectable || listed.has(s.slug)}
              onClick={() => {
                if (selectable && !listed.has(s.slug)) onSelect(s.slug);
              }}
              aria-label={`${purpose === 'pool' ? 'Add species' : 'Select species'} ${s.name}`}
            >
              {listed.has(s.slug)
                ? 'Already in this pool'
                : !selectable
                  ? 'Unavailable in this dungeon'
                  : `${purpose === 'pool' ? 'Add to pool' : 'Select WaifuMon'}${ready ? '' : ' and set access'}`}
            </Button>
          </li>
          );
        })}
      </ul>
      {!rows.length && (
        <p role="status" className={hint}>
          No species match these filters.
        </p>
      )}
    </section>
  );
}
