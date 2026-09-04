/**
 * Client-side helpers over collection and content data.
 *
 * **Presentation only — no gameplay math.** Everything here sorts, filters,
 * groups or labels values the API already returned. Nothing computes a capture
 * rate, an XP threshold, a drop weight or any other rule the game services own
 * (plan §16). The one judgement call, "related species", is documented below.
 */
import type { ContentSpecies, OwnedEntry, Race } from '@/api/types';
import { byRarityDesc } from '@/lib/rarity';

/** How a copy is titled: its nickname if it has one, else the species name. */
export function displayName(entry: OwnedEntry): string {
  return entry.waifu.nickname?.trim() || entry.species.name;
}

/** The species name, shown as a subtitle only when a nickname replaced it. */
export function subtitleFor(entry: OwnedEntry): string | null {
  return entry.waifu.nickname?.trim() ? entry.species.name : null;
}

export type SortKey = 'rarity' | 'name' | 'level' | 'caught';

export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'rarity', label: 'Rarest first' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'level', label: 'Highest level' },
  { value: 'caught', label: 'Recently caught' },
];

/**
 * Orders one page of owned copies. The API already returns rarest-first, so
 * `rarity` reproduces the server order and the rest are alternative views of
 * the same 25 rows — never a claim about the whole collection.
 */
export function sortEntries(entries: OwnedEntry[], sort: SortKey): OwnedEntry[] {
  const sorted = [...entries];
  switch (sort) {
    case 'name':
      return sorted.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    case 'level':
      return sorted.sort(
        (a, b) => b.waifu.level - a.waifu.level || displayName(a).localeCompare(displayName(b)),
      );
    case 'caught':
      return sorted.sort(
        (a, b) => new Date(b.waifu.caughtAt).getTime() - new Date(a.waifu.caughtAt).getTime(),
      );
    case 'rarity':
    default:
      return sorted.sort(
        (a, b) =>
          byRarityDesc(a.species.rarity, b.species.rarity) ||
          displayName(a).localeCompare(displayName(b)),
      );
  }
}

export interface CollectionFilters {
  rarity: OwnedEntry['species']['rarity'] | null;
  search: string;
  race: Race | null;
  affinity: string | null;
  ownership: 'all' | 'favorites' | 'buddy';
}

/**
 * Client-side filtering of the complete owned collection. Callers sort and
 * paginate only after this function returns.
 */
export function filterEntries(
  entries: OwnedEntry[],
  filters: CollectionFilters,
  buddyWaifuId: number | null,
): OwnedEntry[] {
  const needle = filters.search.trim().toLowerCase();

  return entries.filter((entry) => {
    if (filters.rarity && entry.species.rarity !== filters.rarity) return false;
    if (needle) {
      const haystack = `${displayName(entry)} ${entry.species.name}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (filters.race && entry.species.race !== filters.race) return false;
    if (filters.affinity && entry.species.affinity !== filters.affinity) return false;
    if (filters.ownership === 'favorites' && !entry.waifu.isFavorite) return false;
    if (filters.ownership === 'buddy' && entry.waifu.id !== buddyWaifuId) return false;
    return true;
  });
}

/** Distinct values present in a set of entries, for building filter chips. */
export function distinctValues(entries: OwnedEntry[], key: 'race' | 'affinity'): string[] {
  return [...new Set(entries.map((entry) => entry.species[key]))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function distinctSpeciesValues(
  entries: ContentSpecies[],
  key: 'race' | 'affinity',
): string[] {
  return [...new Set(entries.map((entry) => entry[key]))].sort((a, b) => a.localeCompare(b));
}

/**
 * A species' Buddy Bonus, out of the cached content snapshot.
 *
 * An owned copy embeds the *seeded row*, and the row has no bonus by design —
 * content deliberately never copies it into the database. So a copy's page
 * reads it off the snapshot it has already fetched for the related strip, at no
 * extra request. Undefined while that snapshot is still loading, and for the
 * many species that grant no bonus at all; both render nothing.
 */
export function buddyBonusFor(
  all: ContentSpecies[] | undefined,
  slug: string,
): ContentSpecies['buddyBonus'] {
  return all?.find((candidate) => candidate.slug === slug)?.buddyBonus;
}

/**
 * "Related species" — same archetype, excluding the subject.
 *
 * A pure presentation heuristic over the cached content list, and labelled as
 * such in the UI. Anything richer (an authored `relatedTo` field, an evolution
 * line) needs an API field rather than a cleverer client rule (plan §26).
 */
export function relatedSpecies(
  all: ContentSpecies[],
  subject: { slug: string; archetype: string },
  limit = 4,
): ContentSpecies[] {
  return all
    .filter(
      (candidate) =>
        candidate.enabled &&
        candidate.slug !== subject.slug &&
        candidate.archetype === subject.archetype,
    )
    .sort((a, b) => byRarityDesc(a.rarity, b.rarity) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * A species' name, or the encyclopedia's `???` placeholder while the player is
 * not positively authorized to know it.
 *
 * Deliberately takes the **same tri-state** `discovered` value that
 * `<SpeciesArtwork>` gates the pixels on, and applies the same `=== true`
 * predicate to it. The name and the artwork used to be two independent
 * `discovered ? … : …` expressions at every call site, which is one more place
 * for them to disagree about what "not established yet" means.
 */
export function speciesLabel(
  species: { name: string },
  discovered: boolean | undefined,
): string {
  return discovered === true ? species.name : '???';
}
