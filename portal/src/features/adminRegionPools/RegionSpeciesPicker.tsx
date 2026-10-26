/**
 * Species picker for a region pool.
 *
 * Laid out like the Dungeon editor's picker (search, then rarity / race /
 * affinity / availability filters, then thumbnail rows) but fed by the Region
 * Pools catalogue, whose rules differ: dungeon-exclusive species are shown and
 * never selectable; disabled, not-in-content and EX species can be added (the
 * server keeps them as warnings), and say so; species already published in
 * another region are named, because a region-exclusive one conflicts.
 */
import { useState } from 'react';

import type { RegionPoolSpecies, RegionRef } from '@/api/adminRegionPools';
import { RarityBadge } from '@/components/waifumon/RarityBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { RegionSpeciesThumb } from './regionPoolParts';

type Availability = 'all' | 'available' | 'restricted' | 'dungeon' | 'elsewhere' | 'unpooled';

const AVAILABILITY_LABELS: Record<Availability, string> = {
  all: 'All',
  available: 'Huntable and enabled',
  restricted: 'Disabled, EX or not in content',
  dungeon: 'Dungeon-exclusive (not selectable)',
  elsewhere: 'Published in another region',
  unpooled: 'In no published pool',
};

const restricted = (s: RegionPoolSpecies) => !s.enabled || !s.inContent || !s.huntable;

function speciesStatusText(s: RegionPoolSpecies): string {
  const parts: string[] = [];
  if (s.dungeonExclusive)
    parts.push('Dungeon-exclusive — never in a region pool; assign her in the Dungeon Editor');
  if (!s.inContent) parts.push('Not in loaded content');
  else if (!s.enabled) parts.push('Disabled');
  if (!s.huntable) parts.push('EX — the hunt never rolls her rarity');
  if (s.regionExclusive) parts.push('Region-exclusive');
  return parts.length ? parts.join(' · ') : 'Huntable';
}

export function RegionSpeciesPicker({
  regionId,
  species,
  listed,
  regionNames,
  onSelect,
}: {
  regionId: string;
  species: readonly RegionPoolSpecies[];
  /** Species on this page already. */
  listed: ReadonlySet<string>;
  regionNames: ReadonlyMap<string, RegionRef>;
  onSelect: (slug: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [rarity, setRarity] = useState('');
  const [race, setRace] = useState('');
  const [affinity, setAffinity] = useState('');
  const [availability, setAvailability] = useState<Availability>('all');
  const needle = search.trim().toLowerCase();
  const elsewhere = (s: RegionPoolSpecies) => s.publishedIn.filter((r) => r !== regionId);
  const rows = species.filter(
    (s) =>
      (!needle || `${s.name} ${s.slug}`.toLowerCase().includes(needle)) &&
      (!rarity || s.rarity === rarity) &&
      (!race || s.race === race) &&
      (!affinity || s.affinity === affinity) &&
      (availability === 'all' ||
        (availability === 'available' && !restricted(s) && !s.dungeonExclusive) ||
        (availability === 'restricted' && (restricted(s) || s.dungeonExclusive)) ||
        (availability === 'dungeon' && s.dungeonExclusive) ||
        (availability === 'elsewhere' && elsewhere(s).length > 0) ||
        (availability === 'unpooled' && s.publishedIn.length === 0)),
  );
  const options = (pick: (s: RegionPoolSpecies) => string) =>
    [...new Set(species.map(pick))].sort();

  return (
    <section aria-label="Add species" className="space-y-2" data-testid="region-species-picker">
      <Input
        type="search"
        aria-label="Search species"
        placeholder="Search by name or slug…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'Rarity', value: rarity, set: setRarity, options: options((s) => s.rarity) },
          { label: 'Race', value: race, set: setRace, options: options((s) => s.race) },
          {
            label: 'Affinity',
            value: affinity,
            set: setAffinity,
            options: options((s) => s.affinity),
          },
        ].map((f) => (
          <label key={f.label} className="text-xs text-ink-muted">
            {f.label}
            <select
              aria-label={`Filter species by ${f.label.toLowerCase()}`}
              className="block h-11 w-full rounded border border-border bg-surface px-2 text-sm text-ink sm:h-9"
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
            >
              <option value="">All</option>
              {f.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
        ))}
        <label className="text-xs text-ink-muted">
          Availability
          <select
            aria-label="Filter species by availability"
            className="block h-11 w-full rounded border border-border bg-surface px-2 text-sm text-ink sm:h-9"
            value={availability}
            onChange={(e) => setAvailability(e.target.value as Availability)}
          >
            {(Object.keys(AVAILABILITY_LABELS) as Availability[]).map((a) => (
              <option key={a} value={a}>
                {AVAILABILITY_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-ink-muted" role="status">
        {rows.length} of {species.length} species
      </p>
      <ul className="max-h-[28rem] space-y-2 overflow-y-auto" aria-label="Matching species">
        {rows.map((s) => {
          const other = elsewhere(s);
          const already = listed.has(s.slug);
          return (
            <li
              key={s.slug}
              className="flex items-start gap-2 rounded border border-border p-2"
              data-testid={`region-species-option-${s.slug}`}
            >
              <RegionSpeciesThumb slug={s.slug} name={s.name} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="flex flex-wrap items-center gap-1 text-sm font-medium">
                  <RarityBadge rarity={s.rarity} />
                  <span className="break-words">{s.name}</span>
                  {s.dungeonExclusive && (
                    <Badge variant="outline" data-testid={`region-species-dungeon-${s.slug}`}>
                      Dungeon-exclusive
                    </Badge>
                  )}
                </p>
                <p className="font-mono text-xs text-ink-subtle">{s.slug}</p>
                <p className="text-xs text-ink-muted">
                  {s.race} · {s.affinity}
                </p>
                <p
                  className={`text-xs ${s.dungeonExclusive || restricted(s) ? 'text-danger' : 'text-ink-muted'}`}
                >
                  {speciesStatusText(s)}
                </p>
                {other.length > 0 && (
                  <p className={`text-xs ${s.regionExclusive ? 'text-danger' : 'text-ink-muted'}`}>
                    Published in {other.map((r) => regionNames.get(r)?.name ?? r).join(', ')}
                    {s.regionExclusive && ' — adding her here is a region-exclusive conflict'}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={s.dungeonExclusive || already}
                aria-label={`Add ${s.name} to this pool`}
                onClick={() => {
                  if (!s.dungeonExclusive && !already) onSelect(s.slug);
                }}
              >
                {already ? 'In this pool' : s.dungeonExclusive ? 'Not selectable' : 'Add'}
              </Button>
            </li>
          );
        })}
      </ul>
      {!rows.length && <p className="text-xs text-ink-muted">No species match these filters.</p>}
    </section>
  );
}
