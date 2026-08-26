/**
 * Grouping is a *view* over owned copies, so these tests pin the two things
 * that make it correct: the filter ordering (level before grouping, minCopies
 * after) and the promise that individual rows are never merged or mutated.
 */
import { describe, expect, it } from 'vitest';
import type { OwnedEntry } from '../../src/modules/collection/collectionService';
import {
  buildGroupedView,
  filterByMinCopies,
  filterCopiesByLevel,
  groupBySpecies,
  isCollectionSortBy,
  paginateGroups,
  sortGroups,
} from '../../src/modules/collection/collectionGrouping';

let nextWaifuId = 1;

function species(id: number, name: string, rarity = 'SR'): OwnedEntry['species'] {
  return { id, name, rarity } as OwnedEntry['species'];
}

function copy(
  speciesRow: OwnedEntry['species'],
  level: number,
  opts: { caughtAt?: Date; favorite?: boolean } = {},
): OwnedEntry {
  return {
    species: speciesRow,
    waifu: {
      id: nextWaifuId++,
      level,
      caughtAt: opts.caughtAt ?? new Date('2026-01-01T00:00:00Z'),
      isFavorite: opts.favorite ?? false,
    },
  } as OwnedEntry;
}

const SAKURA = species(1, 'Sakura');
const NEKO = species(2, 'Neko', 'R');
const YUKI = species(3, 'Yuki', 'UR');

describe('filterCopiesByLevel', () => {
  const rows = [copy(SAKURA, 4), copy(SAKURA, 12), copy(SAKURA, 30)];

  it('treats absent bounds as open', () => {
    expect(filterCopiesByLevel(rows)).toHaveLength(3);
  });

  it('keeps copies at or above the minimum', () => {
    expect(filterCopiesByLevel(rows, 10).map((r) => r.waifu.level)).toEqual([12, 30]);
  });

  it('keeps copies at or below the maximum', () => {
    expect(filterCopiesByLevel(rows, null, 12).map((r) => r.waifu.level)).toEqual([4, 12]);
  });

  it('applies both bounds inclusively', () => {
    expect(filterCopiesByLevel(rows, 12, 30).map((r) => r.waifu.level)).toEqual([12, 30]);
  });

  it('does not mutate the input', () => {
    const input = [...rows];
    filterCopiesByLevel(input, 10);
    expect(input).toHaveLength(3);
  });
});

describe('groupBySpecies', () => {
  it('collapses copies of one species into a single group', () => {
    const groups = groupBySpecies([copy(SAKURA, 4), copy(NEKO, 7), copy(SAKURA, 30)]);
    expect(groups).toHaveLength(2);
    const sakura = groups.find((g) => g.speciesId === SAKURA.id)!;
    expect(sakura.totalCopies).toBe(2);
    expect(sakura.maxLevel).toBe(30);
  });

  it('carries the original row objects rather than merged copies', () => {
    const a = copy(SAKURA, 4);
    const b = copy(SAKURA, 30);
    const [group] = groupBySpecies([a, b]);
    // Identity, not deep-equality: the duplicate selector addresses these rows
    // by their own player_waifus id, so they must be the same objects.
    expect(group!.copies[0]).toBe(a);
    expect(group!.copies[1]).toBe(b);
    expect(a.waifu.level).toBe(4);
  });

  it('tracks the newest caughtAt across the group', () => {
    const older = copy(SAKURA, 4, { caughtAt: new Date('2026-01-01T00:00:00Z') });
    const newer = copy(SAKURA, 6, { caughtAt: new Date('2026-06-01T00:00:00Z') });
    const [group] = groupBySpecies([older, newer]);
    expect(group!.newestCaughtAt.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('returns an empty list for no rows', () => {
    expect(groupBySpecies([])).toEqual([]);
  });
});

describe('filterByMinCopies', () => {
  const groups = groupBySpecies([copy(SAKURA, 4), copy(SAKURA, 30), copy(NEKO, 7)]);

  it('is a no-op for null, 0 and 1', () => {
    for (const min of [null, 0, 1]) {
      expect(filterByMinCopies(groups, min)).toHaveLength(2);
    }
  });

  it('keeps only groups with enough copies', () => {
    const kept = filterByMinCopies(groups, 2);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.speciesId).toBe(SAKURA.id);
  });

  it('can filter everything out', () => {
    expect(filterByMinCopies(groups, 99)).toEqual([]);
  });
});

describe('sortGroups', () => {
  const groups = groupBySpecies([
    copy(YUKI, 50, { caughtAt: new Date('2026-03-01T00:00:00Z') }),
    copy(SAKURA, 30, { caughtAt: new Date('2026-08-01T00:00:00Z') }),
    copy(SAKURA, 4),
    copy(SAKURA, 12),
    copy(NEKO, 40, { caughtAt: new Date('2026-01-01T00:00:00Z') }),
  ]);

  const names = (sort: Parameters<typeof sortGroups>[1]): string[] =>
    sortGroups(groups, sort).map((g) => g.species.name);

  it('sorts by name ascending', () => {
    expect(names('name_asc')).toEqual(['Neko', 'Sakura', 'Yuki']);
  });

  it('sorts by highest level descending', () => {
    expect(names('level_desc')).toEqual(['Yuki', 'Neko', 'Sakura']);
  });

  it('sorts by copy count descending', () => {
    expect(names('copies_desc')).toEqual(['Sakura', 'Neko', 'Yuki']);
  });

  it('sorts by most recently caught', () => {
    expect(names('newest')).toEqual(['Sakura', 'Yuki', 'Neko']);
  });

  it('leaves the input array untouched', () => {
    const before = groups.map((g) => g.species.name);
    sortGroups(groups, 'level_desc');
    expect(groups.map((g) => g.species.name)).toEqual(before);
  });
});

describe('paginateGroups', () => {
  const groups = groupBySpecies([copy(SAKURA, 1), copy(NEKO, 1), copy(YUKI, 1)]);

  it('slices the requested page', () => {
    const view = paginateGroups(groups, 2, 2);
    expect(view.groups).toHaveLength(1);
    expect(view.page).toBe(2);
    expect(view.totalPages).toBe(2);
    expect(view.totalGroups).toBe(3);
  });

  it('clamps an out-of-range page to the last one', () => {
    expect(paginateGroups(groups, 99, 2).page).toBe(2);
    expect(paginateGroups(groups, 0, 2).page).toBe(1);
  });

  it('reports one page when empty so "Page 1/1" reads sensibly', () => {
    const view = paginateGroups([], 1, 10);
    expect(view.totalPages).toBe(1);
    expect(view.totalGroups).toBe(0);
    expect(view.groups).toEqual([]);
  });

  it('counts every copy across matching groups', () => {
    const many = groupBySpecies([copy(SAKURA, 1), copy(SAKURA, 2), copy(NEKO, 3)]);
    expect(paginateGroups(many, 1, 10).totalCopies).toBe(3);
  });
});

describe('buildGroupedView', () => {
  /** The spec's worked example, end to end through the pipeline. */
  it('applies the level filter to copies before grouping', () => {
    const rows = [copy(SAKURA, 4), copy(SAKURA, 12), copy(SAKURA, 30)];
    const view = buildGroupedView(rows, { minLevel: 10 });
    expect(view.totalGroups).toBe(1);
    const sakura = view.groups[0]!;
    expect(sakura.totalCopies).toBe(2);
    expect(sakura.copies.map((c) => c.waifu.level)).toEqual([12, 30]);
    expect(sakura.maxLevel).toBe(30);
  });

  it('applies minCopies to the surviving count, not the owned count', () => {
    // Three owned, but only one clears level 10 — so "2+ copies" excludes her.
    const rows = [copy(SAKURA, 4), copy(SAKURA, 6), copy(SAKURA, 30)];
    expect(buildGroupedView(rows, { minCopies: 2 }).totalGroups).toBe(1);
    expect(buildGroupedView(rows, { minLevel: 10, minCopies: 2 }).totalGroups).toBe(0);
  });

  it('combines filter, sort and pagination', () => {
    const rows = [
      copy(SAKURA, 30),
      copy(SAKURA, 30),
      copy(NEKO, 40),
      copy(YUKI, 50),
      copy(YUKI, 12),
    ];
    const view = buildGroupedView(rows, { minLevel: 20, sortBy: 'copies_desc', pageSize: 2 });
    // Yuki drops to one copy at Lv 50; Sakura keeps two.
    expect(view.groups.map((g) => g.species.name)).toEqual(['Sakura', 'Neko']);
    expect(view.totalGroups).toBe(3);
    expect(view.totalPages).toBe(2);
  });

  it('returns an empty view when nothing matches', () => {
    const view = buildGroupedView([copy(SAKURA, 4)], { minLevel: 90 });
    expect(view.groups).toEqual([]);
    expect(view.totalGroups).toBe(0);
    expect(view.totalCopies).toBe(0);
    expect(view.page).toBe(1);
  });
});

describe('isCollectionSortBy', () => {
  it('accepts the known sorts and rejects anything else', () => {
    expect(isCollectionSortBy('name_asc')).toBe(true);
    expect(isCollectionSortBy('newest')).toBe(true);
    expect(isCollectionSortBy('by_vibes')).toBe(false);
    expect(isCollectionSortBy(undefined)).toBe(false);
  });
});
