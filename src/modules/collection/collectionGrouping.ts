/**
 * Collection grouping — pure helpers, no Discord, no DB.
 *
 * The Discord collection browser shows one line per *species* rather than one
 * line per owned copy, so a player holding twelve Sakuras sees a single
 * `Sakura ×12` entry instead of twelve near-identical rows.
 *
 * Nothing here mutates or merges an owned copy: a `SpeciesGroup` carries the
 * original `OwnedEntry` objects in `copies`, so the duplicate selector (and,
 * later, targeted Essence actions) can address each `player_waifus` row by its
 * own id. Grouping is a *view* over the rows, never a rewrite of them.
 *
 * Filter ordering is deliberate and load-bearing (see `buildGroupedView`):
 *   1. level range applies to **individual copies**, before grouping;
 *   2. grouping collapses the survivors by species;
 *   3. `minCopies` applies to the **surviving** copy count, after grouping.
 * So a player owning Sakura at levels 4/12/30 who filters `minLevel: 10` sees
 * Sakura with two matching copies — not three, and not zero.
 */
import type { SpeciesRow } from '../../db/schema';
import type { OwnedEntry } from './collectionService';

export type CollectionSortBy = 'name_asc' | 'level_desc' | 'copies_desc' | 'newest';

/** Every sort the collection browser offers, in menu order. */
export const COLLECTION_SORTS: readonly CollectionSortBy[] = [
  'name_asc',
  'level_desc',
  'copies_desc',
  'newest',
];

export const DEFAULT_COLLECTION_SORT: CollectionSortBy = 'name_asc';

export const COLLECTION_SORT_LABELS: Record<CollectionSortBy, string> = {
  name_asc: 'Name (A–Z)',
  level_desc: 'Highest level',
  copies_desc: 'Most copies',
  newest: 'Recently caught',
};

/** Narrowing guard for values arriving from a select menu / tracker patch. */
export function isCollectionSortBy(value: unknown): value is CollectionSortBy {
  return typeof value === 'string' && (COLLECTION_SORTS as readonly string[]).includes(value);
}

/** One species' worth of owned copies. `copies` are the original row objects. */
export interface SpeciesGroup {
  speciesId: number;
  species: SpeciesRow;
  /** Matching copies, in the order the query returned them. Never mutated. */
  copies: OwnedEntry[];
  /** Highest level among `copies` — the headline number on the group line. */
  maxLevel: number;
  /** `copies.length`, named for readability at call sites. */
  totalCopies: number;
  /** Most recent `caughtAt` among `copies`, for the "newest" sort. */
  newestCaughtAt: Date;
}

export interface GroupedViewOptions {
  minLevel?: number | null;
  maxLevel?: number | null;
  minCopies?: number | null;
  sortBy?: CollectionSortBy;
  page?: number;
  pageSize?: number;
}

export interface GroupedView {
  groups: SpeciesGroup[];
  page: number;
  pageSize: number;
  totalPages: number;
  /** Groups matching the filters, before pagination. */
  totalGroups: number;
  /** Individual copies across every matching group, before pagination. */
  totalCopies: number;
}

const DEFAULT_GROUP_PAGE_SIZE = 10;

/**
 * Keep only copies inside the level range. `null`/`undefined` bounds are open,
 * so `{ minLevel: 10 }` means "level 10 and up" with no upper bound.
 */
export function filterCopiesByLevel(
  rows: readonly OwnedEntry[],
  minLevel?: number | null,
  maxLevel?: number | null,
): OwnedEntry[] {
  const lo = minLevel ?? null;
  const hi = maxLevel ?? null;
  if (lo == null && hi == null) return [...rows];
  return rows.filter((row) => {
    if (lo != null && row.waifu.level < lo) return false;
    if (hi != null && row.waifu.level > hi) return false;
    return true;
  });
}

/**
 * Collapse copies into one group per species. Group order follows first
 * appearance in `rows`, so an already-sorted query stays meaningfully ordered
 * until `sortGroups` re-orders it.
 */
export function groupBySpecies(rows: readonly OwnedEntry[]): SpeciesGroup[] {
  const bySpecies = new Map<number, SpeciesGroup>();
  for (const row of rows) {
    const speciesId = row.species.id;
    const existing = bySpecies.get(speciesId);
    if (!existing) {
      bySpecies.set(speciesId, {
        speciesId,
        species: row.species,
        copies: [row],
        maxLevel: row.waifu.level,
        totalCopies: 1,
        newestCaughtAt: row.waifu.caughtAt,
      });
      continue;
    }
    existing.copies.push(row);
    existing.totalCopies = existing.copies.length;
    if (row.waifu.level > existing.maxLevel) existing.maxLevel = row.waifu.level;
    if (row.waifu.caughtAt.getTime() > existing.newestCaughtAt.getTime()) {
      existing.newestCaughtAt = row.waifu.caughtAt;
    }
  }
  return [...bySpecies.values()];
}

/**
 * Drop groups with fewer than `minCopies` matching copies. Applied *after*
 * grouping, so it counts copies that survived the level filter.
 */
export function filterByMinCopies(
  groups: readonly SpeciesGroup[],
  minCopies?: number | null,
): SpeciesGroup[] {
  const min = minCopies ?? 0;
  if (min <= 1) return [...groups];
  return groups.filter((group) => group.totalCopies >= min);
}

/** Sort a copy of `groups`; the input array is left untouched. */
export function sortGroups(
  groups: readonly SpeciesGroup[],
  sortBy: CollectionSortBy = DEFAULT_COLLECTION_SORT,
): SpeciesGroup[] {
  const byName = (a: SpeciesGroup, b: SpeciesGroup): number =>
    a.species.name.localeCompare(b.species.name) || a.speciesId - b.speciesId;
  const sorted = [...groups];
  switch (sortBy) {
    case 'level_desc':
      return sorted.sort((a, b) => b.maxLevel - a.maxLevel || byName(a, b));
    case 'copies_desc':
      return sorted.sort((a, b) => b.totalCopies - a.totalCopies || byName(a, b));
    case 'newest':
      return sorted.sort(
        (a, b) => b.newestCaughtAt.getTime() - a.newestCaughtAt.getTime() || byName(a, b),
      );
    case 'name_asc':
    default:
      return sorted.sort(byName);
  }
}

/**
 * Slice one page out of `groups`. An out-of-range page clamps to the last
 * valid page (matching the list screen's existing clamping behaviour), and an
 * empty result still reports `totalPages: 1` so "Page 1/1" reads sensibly.
 */
export function paginateGroups(
  groups: readonly SpeciesGroup[],
  page = 1,
  pageSize = DEFAULT_GROUP_PAGE_SIZE,
): GroupedView {
  const size = Math.max(1, Math.min(25, Math.floor(pageSize) || DEFAULT_GROUP_PAGE_SIZE));
  const totalGroups = groups.length;
  const totalPages = Math.max(1, Math.ceil(totalGroups / size));
  const clampedPage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (clampedPage - 1) * size;
  return {
    groups: groups.slice(start, start + size),
    page: clampedPage,
    pageSize: size,
    totalPages,
    totalGroups,
    totalCopies: groups.reduce((sum, group) => sum + group.totalCopies, 0),
  };
}

/**
 * The whole pipeline in filter-order: level → group → minCopies → sort → page.
 *
 * The service hands this every active copy matching the cheap SQL-side
 * predicates (player, not released, name) and lets the ordering above decide
 * the rest, so the level/minCopies interaction lives in exactly one place.
 */
export function buildGroupedView(
  rows: readonly OwnedEntry[],
  opts: GroupedViewOptions = {},
): GroupedView {
  const leveled = filterCopiesByLevel(rows, opts.minLevel, opts.maxLevel);
  const grouped = groupBySpecies(leveled);
  const enough = filterByMinCopies(grouped, opts.minCopies);
  const sorted = sortGroups(enough, opts.sortBy ?? DEFAULT_COLLECTION_SORT);
  return paginateGroups(sorted, opts.page ?? 1, opts.pageSize ?? DEFAULT_GROUP_PAGE_SIZE);
}
