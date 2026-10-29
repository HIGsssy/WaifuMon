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
import type {
  DungeonSpeciesUnavailableReason,
  DungeonSpeciesRegion,
} from '@/api/dungeonSpeciesTypes';
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
  const admissible =
    !view.permitted && view.reason === 'not_permitted' && species.dungeonPolicyAllowed;
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
      <p
        className={
          view.permitted ? hint : admissible ? 'text-xs font-medium' : 'text-xs text-danger'
        }
      >
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
export function SpeciesThumb({
  species,
  compact = false,
}: {
  species: DungeonSpeciesRef;
  compact?: boolean;
}) {
  return (
    <div
      className={compact ? 'w-12 shrink-0' : 'w-16 shrink-0'}
      data-testid={`species-${species.slug}-thumbnail`}
    >
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
  regions = [],
  onRemove,
}: {
  species: DungeonSpeciesRef[];
  listed: Set<string>;
  disabled: boolean;
  onSelect: (slug: string) => void;
  onRemove?: (slug: string) => void;
  regions?: DungeonSpeciesRegion[];
  purpose?: 'pool' | 'encounter' | 'shared_pool';
  dungeonKey: string;
  /** The draft's Species access entries. */
  policies?: DungeonSpeciesPolicyEntry[] | undefined;
}) {
  const entryOf = (slug: string) => policies?.find((p) => p.species === slug);
  const permitted = (s: DungeonSpeciesRef) =>
    speciesAccessView(s, dungeonKey, entryOf(s.slug)).permitted;
  const [search, setSearch] = useState('');
  const [rarity, setRarity] = useState('');
  const [race, setRace] = useState('');
  const [affinity, setAffinity] = useState('');
  const [status, setStatus] = useState('all');
  const [region, setRegion] = useState('');
  const [exclusive, setExclusive] = useState('');
  const shared = purpose === 'shared_pool';
  const selectable = (s: DungeonSpeciesRef) =>
    shared
      ? s.enabled && (s.dungeonPolicyAllowed || s.dungeonAccess.length > 0)
      : speciesSelectable(s, dungeonKey, entryOf(s.slug));
  const needle = search.trim().toLowerCase();
  const rows = species.filter(
    (s) =>
      (!needle || `${s.name} ${s.slug}`.toLowerCase().includes(needle)) &&
      (!rarity || s.rarity === rarity) &&
      (!race || s.race === race) &&
      (!affinity || s.affinity === affinity) &&
      (status === 'all' ||
        (status === 'permitted'
          ? shared
            ? selectable(s)
            : permitted(s)
          : !(shared ? selectable(s) : permitted(s)))) &&
      (!shared ||
        !region ||
        (region === 'unassigned' ? s.regions?.length === 0 : s.regions?.includes(region))) &&
      (!shared ||
        !exclusive ||
        (exclusive === 'dungeon' ? s.dungeonExclusive : !s.dungeonExclusive)),
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
            <option value="permitted">{shared ? 'Can add to pool' : 'Permitted'}</option>
            <option value="unavailable">Unavailable</option>
          </select>
        </label>
        {shared && (
          <>
            <label className={hint}>
              Region
              <select
                aria-label="Filter species by region"
                className="block w-full rounded border border-border bg-surface p-2 text-sm"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              >
                <option value="">All regions</option>
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
                <option value="unassigned">Unassigned / No Region</option>
              </select>
            </label>
            <label className={hint}>
              Dungeon Exclusive
              <select
                aria-label="Filter species by dungeon exclusivity"
                className="block w-full rounded border border-border bg-surface p-2 text-sm"
                value={exclusive}
                onChange={(e) => setExclusive(e.target.value)}
              >
                <option value="">All species</option>
                <option value="dungeon">Dungeon Exclusive</option>
                <option value="other">Not Dungeon Exclusive</option>
              </select>
            </label>
          </>
        )}
      </div>
      {shared && (
        <p role="status" className={hint}>
          {rows.length} matching · {listed.size} selected. Region means published Region Pool
          membership.
        </p>
      )}
      <ul className="max-h-96 space-y-2 overflow-y-auto" aria-label="Matching species">
        {rows.map((s) => {
          const canAdd = selectable(s);
          if (shared)
            return (
              <li
                key={s.slug}
                className="flex items-center gap-2 rounded border border-border p-2"
                data-testid={`species-option-${s.slug}`}
              >
                <SpeciesThumb species={s} compact />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{s.name}</p>
                  <p className={hint}>
                    {s.rarity} · {s.race} · {s.affinity}
                    {s.dungeonExclusive ? ' · Dungeon Exclusive' : ''}
                  </p>
                  <p className={hint}>
                    {s.regions
                      ? s.regions
                          .map((id) => regions.find((r) => r.id === id)?.name ?? id)
                          .join(', ') || 'Unassigned / No Region'
                      : 'Region data unavailable'}
                  </p>
                  {!canAdd && (
                    <p className="text-xs text-danger">Unavailable for dungeon encounters</p>
                  )}
                  {listed.has(s.slug) && <p className="text-xs font-medium">In this pool</p>}
                </div>
                {listed.has(s.slug) && onRemove ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Remove species ${s.name}`}
                    onClick={() => onRemove(s.slug)}
                  >
                    Remove
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || !canAdd || listed.has(s.slug)}
                    aria-label={`Add species ${s.name}`}
                    onClick={() => {
                      if (canAdd && !listed.has(s.slug)) onSelect(s.slug);
                    }}
                  >
                    {listed.has(s.slug) ? 'In pool' : 'Add'}
                  </Button>
                )}
              </li>
            );
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
                  <SpeciesAvailability
                    species={s}
                    dungeonKey={dungeonKey}
                    entry={entryOf(s.slug)}
                  />
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || !canAdd || listed.has(s.slug)}
                onClick={() => {
                  if (canAdd && !listed.has(s.slug)) onSelect(s.slug);
                }}
                aria-label={`${purpose !== 'encounter' ? 'Add species' : 'Select species'} ${s.name}`}
              >
                {listed.has(s.slug)
                  ? 'Already in this pool'
                  : !canAdd
                    ? 'Unavailable in this dungeon'
                    : `${purpose !== 'encounter' ? 'Add to pool' : 'Select WaifuMon'}${ready ? '' : ' and set access'}`}
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
