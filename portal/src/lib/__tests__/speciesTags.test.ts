/**
 * Species tag presentation: raw tags are internal unless listed.
 *
 * The content block reads every species file the server loads, so a tag added
 * to content without a decision here fails the suite instead of either leaking
 * or silently vanishing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  INTERNAL_TAGS,
  isClassifiedTag,
  PLAYER_FACING_TAGS,
  playerFacingTags,
} from '../speciesTags';
import { isZoneTag, ZONES } from '../zone';

describe('playerFacingTags', () => {
  it('labels region_exclusive for players', () => {
    expect(playerFacingTags({ tags: ['expansion', 'region_exclusive', 'twin_peeks'] })).toEqual([
      { tag: 'region_exclusive', label: 'Region Exclusive' },
    ]);
  });

  it.each(ZONES.map((zone) => [zone.tag]))('never returns the zone tag %s', (tag) => {
    expect(playerFacingTags({ tags: [tag] })).toEqual([]);
  });

  it('hides the internal starter and expansion classifications', () => {
    expect(playerFacingTags({ tags: ['starter', 'waifu_valley'] })).toEqual([]);
    expect(playerFacingTags({ tags: ['expansion'] })).toEqual([]);
  });

  it('hides tags it does not recognise rather than printing them raw', () => {
    expect(playerFacingTags({ tags: ['placeholder', 'Region Exclusive', 'twin_peaks'] })).toEqual(
      [],
    );
  });

  it('tolerates missing, null, duplicate and non-string tags', () => {
    expect(playerFacingTags({})).toEqual([]);
    expect(playerFacingTags({ tags: null })).toEqual([]);
    expect(
      playerFacingTags({ tags: [7, null, 'region_exclusive', 'region_exclusive'] }),
    ).toHaveLength(1);
  });

  it('keeps the three vocabularies disjoint', () => {
    const facing = PLAYER_FACING_TAGS.map((t) => t.tag);
    for (const tag of facing) {
      expect(isZoneTag(tag)).toBe(false);
      expect(INTERNAL_TAGS).not.toContain(tag);
    }
    for (const tag of INTERNAL_TAGS) expect(isZoneTag(tag)).toBe(false);
  });
});

describe('authored species content', () => {
  const CONTENT = path.resolve(__dirname, '..', '..', '..', '..', 'content');

  /** Every species file the loader reads: `species/*.json` plus every pack's. */
  function speciesFiles(): string[] {
    const files = fs
      .readdirSync(path.join(CONTENT, 'species'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(CONTENT, 'species', f));
    for (const pack of fs.readdirSync(path.join(CONTENT, 'expansions'))) {
      const dir = path.join(CONTENT, 'expansions', pack, 'species');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) files.push(path.join(dir, f));
      }
    }
    return files;
  }

  const allTags = new Set(
    speciesFiles().flatMap((file) =>
      (JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ tags?: string[] }>).flatMap(
        (s) => s.tags ?? [],
      ),
    ),
  );

  it('finds tags to check', () => {
    expect(allTags.size).toBeGreaterThan(0);
  });

  it('has classified every tag that appears in content', () => {
    expect([...allTags].filter((tag) => !isClassifiedTag(tag))).toEqual([]);
  });

  it('only ever renders tags that carry an explicit player-facing label', () => {
    const rendered = playerFacingTags({ tags: [...allTags] });
    expect(rendered.map((t) => t.tag).every((tag) => allTags.has(tag))).toBe(true);
    for (const { label } of rendered) expect(label).not.toMatch(/_/);
  });
});
