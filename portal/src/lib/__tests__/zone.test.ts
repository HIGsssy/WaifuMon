/**
 * Zone vocabulary tests.
 *
 * Zone membership is read from species **tags** and nothing else. The last
 * block checks that against the authored content itself, so a species that
 * loses its zone tag, or gains a second one, fails here rather than quietly
 * disappearing from the Zone filter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { filterEntries, type CollectionFilters } from '@/content/species';
import type { CollectionEntryView } from '@/api/types';
import * as fixtures from '../../../msw/fixtures';
import { isZoneTag, ZONES, zoneFor, zoneLabel } from '../zone';

describe('zoneFor', () => {
  it.each([
    ['waifu_valley', 'Waifu Valley'],
    ['twin_peeks', 'Twin Peeks'],
    ['flaccid_foothills', 'Flaccid Foothills'],
    ['thirstlands', 'Thirstlands'],
    ['base_80085', 'Base 80085'],
  ])('resolves %s to "%s"', (tag, label) => {
    expect(zoneFor({ tags: ['expansion', 'region_exclusive', tag] })).toEqual({ tag, label });
    expect(zoneLabel(tag)).toBe(label);
    expect(isZoneTag(tag)).toBe(true);
  });

  it('lists exactly the released zones, in filter order', () => {
    expect(ZONES.map((zone) => zone.label)).toEqual([
      'Waifu Valley',
      'Twin Peeks',
      'Flaccid Foothills',
      'Thirstlands',
      'Base 80085',
    ]);
  });

  it('does not recognise the legacy twin_peaks directory spelling', () => {
    expect(zoneFor({ tags: ['twin_peaks'] })).toBeNull();
    expect(isZoneTag('twin_peaks')).toBe(false);
  });

  it.each([
    ['no tags', { tags: [] }],
    ['only non-zone tags', { tags: ['starter', 'expansion', 'region_exclusive'] }],
    ['a missing tags array', {}],
    ['a null tags array', { tags: null }],
    ['non-string tags', { tags: [42, null, { zone: 'waifu_valley' }] }],
  ])('returns null for %s rather than throwing', (_case, species) => {
    expect(zoneFor(species as { tags?: unknown[] | null })).toBeNull();
  });

  it('never infers a zone from starter, expansion or region_exclusive', () => {
    expect(zoneFor({ tags: ['starter'] })).toBeNull();
    expect(zoneFor({ tags: ['expansion', 'region_exclusive'] })).toBeNull();
  });

  it('returns null labels for unrecognised tags', () => {
    expect(zoneLabel('assteroid_belt')).toBeNull();
    expect(isZoneTag(null)).toBe(false);
  });
});

describe('filterEntries — zone', () => {
  const NO_FILTERS: CollectionFilters = {
    rarity: null,
    search: '',
    race: null,
    affinity: null,
    ownership: 'all',
    zone: null,
  };

  function entry(id: number, tags: string[], rarity: 'N' | 'SR' = 'N'): CollectionEntryView {
    const source = fixtures.ownedEntries[0]!;
    return {
      ...source,
      waifu: { ...source.waifu, id },
      species: { ...source.species, tags, rarity },
    };
  }

  const entries = [
    entry(1, ['starter', 'waifu_valley']),
    entry(2, ['expansion', 'region_exclusive', 'twin_peeks'], 'SR'),
    entry(3, ['expansion', 'region_exclusive', 'twin_peeks']),
    entry(4, ['expansion', 'region_exclusive', 'thirstlands'], 'SR'),
    entry(5, ['expansion', 'region_exclusive']),
  ];

  const ids = (result: CollectionEntryView[]) => result.map((e) => e.waifu.id);

  it('keeps every entry, zoned or not, when no zone is selected', () => {
    expect(ids(filterEntries(entries, NO_FILTERS, null))).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps only entries tagged with the selected zone', () => {
    expect(ids(filterEntries(entries, { ...NO_FILTERS, zone: 'twin_peeks' }, null))).toEqual([
      2, 3,
    ]);
    expect(ids(filterEntries(entries, { ...NO_FILTERS, zone: 'flaccid_foothills' }, null))).toEqual(
      [],
    );
  });

  it('excludes zoneless species from every specific zone', () => {
    for (const zone of ZONES) {
      expect(ids(filterEntries(entries, { ...NO_FILTERS, zone: zone.tag }, null))).not.toContain(5);
    }
  });

  it('combines with the rarity filter', () => {
    expect(
      ids(filterEntries(entries, { ...NO_FILTERS, zone: 'twin_peeks', rarity: 'SR' }, null)),
    ).toEqual([2]);
  });
});

describe('authored species content', () => {
  const REPO = path.resolve(__dirname, '..', '..', '..', '..');

  // Directory names are only how we find the files; the expected zone below is
  // asserted from each species' tags, which is the thing under test.
  it.each([
    ['content/species/starter.json', 100, 'Waifu Valley'],
    ['content/expansions/twin_peaks/species/twin_peaks_species.json', 15, 'Twin Peeks'],
    [
      'content/expansions/flaccid_foothills/species/flaccid_foothills_species.json',
      15,
      'Flaccid Foothills',
    ],
    ['content/expansions/thirstlands/species/thirstlands_species.json', 15, 'Thirstlands'],
    ['content/expansions/base_80085/species/base_80085_species.json', 15, 'Base 80085'],
  ])('%s: all %i species resolve to %s', (file, count, label) => {
    const species = JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8')) as Array<{
      slug: string;
      tags?: string[];
    }>;
    expect(species).toHaveLength(count);
    for (const s of species) {
      expect({ slug: s.slug, zone: zoneFor(s)?.label }).toEqual({ slug: s.slug, zone: label });
      // Exactly one zone tag each, so "first recognised tag wins" never matters.
      expect((s.tags ?? []).filter(isZoneTag)).toHaveLength(1);
    }
  });
});
