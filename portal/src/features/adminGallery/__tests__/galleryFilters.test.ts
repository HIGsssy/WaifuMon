/**
 * Gallery filtering over the fixture catalog — every filter, combinations, the
 * URL vocabulary, safe degradation and previous/next ordering.
 */
import { describe, expect, it } from 'vitest';

import { adminGalleryCatalog } from '../../../../msw/fixtures';
import {
  distinctValues,
  filterGallerySpecies,
  isEnabled,
  neighboursOf,
  NO_ZONE,
  readGalleryFilters,
  type GalleryFilters,
} from '../galleryFilters';
import { describeDiagnostic, describeIssue, summarizeIssues } from '../galleryLabels';

const LIST = adminGalleryCatalog.species;
const VOCAB = { races: distinctValues(LIST, 'race'), affinities: distinctValues(LIST, 'affinity') };
const NONE: GalleryFilters = readGalleryFilters(new URLSearchParams(), VOCAB);

const slugs = (patch: Partial<GalleryFilters>) =>
  filterGallerySpecies(LIST, { ...NONE, ...patch }).map((s) => s.slug);

describe('filterGallerySpecies', () => {
  it('shows everything with no filters, in catalog order', () => {
    expect(slugs({})).toEqual(LIST.map((s) => s.slug));
    expect(slugs({})).toHaveLength(6);
  });

  it('searches names, case-insensitively', () => {
    expect(slugs({ search: 'ONSEN' })).toEqual(['onsen_maid']);
  });

  it('searches slugs', () => {
    expect(slugs({ search: 'star_mar' })).toEqual(['star_marshal']);
  });

  it.each<[Partial<GalleryFilters>, string[]]>([
    [{ rarity: 'SR' }, ['onsen_maid']],
    [{ race: 'android' }, ['star_marshal']],
    [{ affinity: 'submissive' }, ['chrome_corsair', 'retired_idol']],
    [{ zone: 'twin_peeks' }, ['onsen_maid']],
    [{ zone: 'waifu_valley' }, ['alley_catgirl', 'ghost_girl']],
    [{ zone: NO_ZONE }, ['chrome_corsair', 'star_marshal']],
    [{ runtime: 'loaded' }, ['alley_catgirl', 'ghost_girl', 'onsen_maid', 'retired_idol']],
    [{ runtime: 'future' }, ['chrome_corsair', 'star_marshal']],
    [{ enabled: 'enabled' }, ['alley_catgirl', 'chrome_corsair', 'onsen_maid', 'star_marshal']],
    [{ enabled: 'disabled' }, ['ghost_girl', 'retired_idol']],
    [{ health: 'issues' }, ['chrome_corsair', 'ghost_girl', 'onsen_maid']],
    [{ health: 'clean' }, ['alley_catgirl', 'retired_idol', 'star_marshal']],
    [{ rating: 'explicit' }, ['ghost_girl', 'star_marshal']],
  ])('filters %o', (patch, expected) => {
    expect(slugs(patch)).toEqual(expected);
  });

  it('combines every filter', () => {
    expect(slugs({ runtime: 'future', health: 'issues' })).toEqual(['chrome_corsair']);
    expect(slugs({ runtime: 'future', enabled: 'enabled', rating: 'explicit' })).toEqual([
      'star_marshal',
    ]);
    expect(slugs({ runtime: 'loaded', enabled: 'disabled', health: 'clean' })).toEqual([
      'retired_idol',
    ]);
    expect(slugs({ zone: NO_ZONE, runtime: 'loaded' })).toEqual([]);
  });

  it('keeps Loaded and Enabled separate: a future species can be enabled', () => {
    const future = LIST.find((s) => s.slug === 'star_marshal')!;
    expect(future.runtime.loaded).toBe(false);
    expect(isEnabled(future)).toBe(true);
    const loaderDisabled = LIST.find((s) => s.slug === 'ghost_girl')!;
    expect(loaderDisabled.authoredEnabled).toBe(true);
    expect(isEnabled(loaderDisabled)).toBe(false);
  });
});

describe('readGalleryFilters', () => {
  it('reads every parameter', () => {
    const params = new URLSearchParams(
      'q=maid&rarity=SR&type=human&affinity=caregiver&zone=twin_peeks&runtime=loaded&enabled=enabled&health=issues&rating=mature',
    );
    expect(readGalleryFilters(params, VOCAB)).toEqual({
      search: 'maid',
      rarity: 'SR',
      race: 'human',
      affinity: 'caregiver',
      zone: 'twin_peeks',
      runtime: 'loaded',
      enabled: 'enabled',
      health: 'issues',
      rating: 'mature',
    });
  });

  it('degrades unknown values to All', () => {
    const params = new URLSearchParams(
      'rarity=ZZ&type=dragon&affinity=grumpy&zone=twin_peaks&runtime=maybe&enabled=yes&health=bad&rating=gory',
    );
    expect(readGalleryFilters(params, VOCAB)).toEqual({ ...NONE });
  });

  it('accepts the explicit No Zone value', () => {
    expect(readGalleryFilters(new URLSearchParams('zone=none'), VOCAB).zone).toBe(NO_ZONE);
  });
});

describe('neighboursOf', () => {
  it('follows the filtered order', () => {
    const filtered = filterGallerySpecies(LIST, { ...NONE, runtime: 'loaded' });
    const n = neighboursOf(LIST, filtered, 'onsen_maid');
    expect(n.previous?.slug).toBe('ghost_girl');
    expect(n.next?.slug).toBe('retired_idol');
    expect([n.position, n.total]).toEqual([3, 4]);
  });

  it('falls back to the whole catalog when the species is filtered out', () => {
    const filtered = filterGallerySpecies(LIST, { ...NONE, runtime: 'future' });
    const n = neighboursOf(LIST, filtered, 'alley_catgirl');
    expect(n.previous).toBeNull();
    expect(n.next?.slug).toBe('chrome_corsair');
    expect(n.total).toBe(6);
  });
});

describe('labels', () => {
  it('words every issue code the server emits', () => {
    for (const code of [
      'species_disabled_by_loader',
      'default_artwork_missing',
      'appearance_artwork_missing',
      'artwork_unsafe',
      'appearance_not_in_runtime',
      'artwork_png_only',
      'renditions_missing',
    ]) {
      expect(describeIssue(code)).toMatchObject({ known: true });
      expect(describeIssue(code).label).not.toContain('_');
    }
    expect(describeIssue('appearance_not_in_runtime').label).toBe('Not present in runtime catalog');
    expect(describeIssue('renditions_missing').label).toBe('Missing thumbnails');
  });

  it('renders an unknown code as itself rather than failing', () => {
    expect(describeIssue('brand_new_problem')).toEqual({
      label: 'brand_new_problem',
      description: null,
      known: false,
      code: 'brand_new_problem',
    });
    expect(describeDiagnostic('mystery').known).toBe(false);
  });

  it('groups issues by code', () => {
    const summary = summarizeIssues([
      { code: 'appearance_artwork_missing', severity: 'error', appearanceId: 'a' },
      { code: 'appearance_artwork_missing', severity: 'error', appearanceId: 'b' },
      { code: 'artwork_png_only', severity: 'warning', appearanceId: 'c' },
    ]);
    expect(summary.map((s) => [s.issue.label, s.count])).toEqual([
      ['Artwork missing', 2],
      ['PNG only', 1],
    ]);
  });
});
