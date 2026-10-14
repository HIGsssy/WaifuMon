import { useState } from 'react';
import { dungeonSpeciesArtworkBlob, type DungeonSpeciesRef } from '@/api/adminDungeons';
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
export function SpeciesAvailability({ species }: { species: DungeonSpeciesRef }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className={hint}>
        {species.rarity} · {species.race} · {species.affinity}
      </p>
      <p className={species.permitted ? hint : 'text-xs text-danger'}>
        {species.enabled ? 'Enabled' : 'Disabled'} ·{' '}
        {species.regionExclusive ? 'Region-exclusive' : 'No region exclusivity'} ·{' '}
        {species.dungeonExclusive ? 'Dungeon-exclusive' : 'No dungeon exclusivity'}
      </p>
      <p className={species.permitted ? hint : 'text-xs text-danger'}>
        {species.permitted
          ? 'Permitted in this dungeon'
          : speciesReasonText[species.unavailableReason ?? 'not_permitted']}
      </p>
      <p className={hint}>
        Acquisition limit:{' '}
        {species.perPlayerLimit === null
          ? 'Unlimited (no limit configured)'
          : species.perPlayerLimit === 'unlimited'
            ? 'Unlimited (explicit)'
            : species.perPlayerLimit}{' '}
        — per player, in this dungeon, across runs.
      </p>
      <p className={hint}>
        Direct rescue:{' '}
        {species.directRescue.available
          ? 'Authorized with a finite limit'
          : speciesReasonText[species.directRescue.reason ?? 'direct_not_permitted']}
        .
      </p>
      <p className={`${hint} break-words`}>
        Configured dungeon access:{' '}
        {species.dungeonAccess.length
          ? species.dungeonAccess
              .map(
                (a) =>
                  `${a.dungeon} (limit ${a.perPlayerLimit ?? 'unlimited by default'}${a.directRescue ? ', direct rescue authorized' : ''})`,
              )
              .join('; ')
          : 'None listed'}
        . Central policy is read-only.
      </p>
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
}: {
  species: DungeonSpeciesRef[];
  listed: Set<string>;
  disabled: boolean;
  onSelect: (slug: string) => void;
}) {
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
      (status === 'all' || (status === 'permitted' ? s.permitted : !s.permitted)),
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
        {rows.map((s) => (
          <li
            key={s.slug}
            className="space-y-2 rounded border border-border p-2"
            data-testid={`species-option-${s.slug}`}
          >
            <div className="flex gap-2">
              <SpeciesThumb species={s} />
              <div className="min-w-0">
                <p className="break-words text-sm font-medium">{s.name}</p>
                <SpeciesAvailability species={s} />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !s.permitted || listed.has(s.slug)}
              onClick={() => {
                if (s.permitted && !listed.has(s.slug)) onSelect(s.slug);
              }}
              aria-label={`Add species ${s.name}`}
            >
              {listed.has(s.slug)
                ? 'Already in this pool'
                : s.permitted
                  ? 'Add to pool'
                  : 'Unavailable in this dungeon'}
            </Button>
          </li>
        ))}
      </ul>
      {!rows.length && (
        <p role="status" className={hint}>
          No species match these filters.
        </p>
      )}
    </section>
  );
}
