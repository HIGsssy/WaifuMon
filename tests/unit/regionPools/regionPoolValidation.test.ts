/** Region Pool draft and publish validation on hand-built facts (RP1 §8). */
import { describe, expect, it } from 'vitest';
import type { RegionCatalogueEntry } from '../../../src/modules/regionPools/regionCatalogue';
import {
  blockingIssues,
  parseRegionPoolEntries,
  requiredAcknowledgements,
  validateRegionPool,
  type PoolSpeciesFacts,
  type ValidateRegionPoolInput,
} from '../../../src/modules/regionPools/regionPoolValidation';

const REGION: RegionCatalogueEntry = { id: 'twin-peeks', name: 'Twin Peeks', released: true, isDefault: false, shippedPool: [] };
const HUNTED = ['N', 'R', 'SR', 'SSR', 'UR', 'LR'];

const fact = (slug: string, rarity: string, over: Partial<PoolSpeciesFacts> = {}): PoolSpeciesFacts => ({
  slug,
  name: slug,
  rarity,
  enabled: true,
  tags: [],
  inContent: true,
  race: 'human',
  affinity: 'switch',
  perSpeciesWeight: 1,
  imagePath: `waifumon/${slug}/standard.png`,
  ...over,
});
const FACTS = new Map(
  [
    ...HUNTED.map((r) => fact(`${r.toLowerCase()}_a`, r)),
    fact('off', 'N', { enabled: false }),
    fact('gone', 'R', { enabled: false, inContent: false }),
    fact('ex', 'EX'),
    fact('dungeon', 'SR', { tags: ['dungeon_exclusive'] }),
    fact('excl', 'UR', { tags: ['region_exclusive'] }),
  ].map((f) => [f.slug, f]),
);
const FULL = HUNTED.map((r) => ({ species: `${r.toLowerCase()}_a`, weight: 1 }));

const run = (over: Partial<ValidateRegionPoolInput>) =>
  validateRegionPool({
    regionId: 'twin-peeks',
    region: REGION,
    entries: FULL,
    facts: FACTS,
    huntedRarities: HUNTED,
    otherPublished: new Map(),
    fallbackRegionName: 'Waifu Valley',
    purpose: 'draft',
    ...over,
  });
const ids = (issues: ReturnType<typeof run>) => issues.map((i) => i.id);

describe('structure', () => {
  it('parses well-formed entries and reports the rest by index', () => {
    const { entries, issues } = parseRegionPoolEntries([
      { species: 'n_a', weight: 2 },
      { species: 'Bad Slug', weight: 1 },
      { species: 'r_a', weight: 1, extra: true },
      'nope',
    ]);
    expect(entries).toEqual([{ species: 'n_a', weight: 2 }]);
    expect(ids(issues)).toEqual(['entry_invalid:1', 'entry_invalid:2', 'entry_invalid:3']);
    expect(parseRegionPoolEntries({}).issues[0]!.code).toBe('entries_not_array');
  });

  it('refuses unknown regions, unknown and duplicate species, bad weights and too many entries', () => {
    expect(ids(run({ region: null, regionId: 'atlantis' }))).toEqual(['region_unknown']);
    const issues = run({
      entries: [...FULL, { species: 'nobody', weight: 1 }, { species: 'n_a', weight: 2 }, { species: 'excl', weight: 0 }],
    });
    expect(blockingIssues(issues).map((i) => i.id)).toEqual(['species_unknown:nobody', 'species_duplicate:n_a:7', 'weight_invalid:excl']);
    expect(ids(run({ entries: [{ species: 'n_a', weight: 1_000_001 }] }))).toContain('weight_invalid:n_a');
    expect(ids(run({ entries: [{ species: 'n_a', weight: 1.5 }] }))).toContain('weight_invalid:n_a');
    const many = Array.from({ length: 501 }, (_, i) => ({ species: `s${i}`, weight: 1 }));
    expect(ids(run({ entries: many }))).toContain('too_many_entries');
  });

  it('refuses a dungeon-exclusive species even in a draft', () => {
    const issues = run({ entries: [...FULL, { species: 'dungeon', weight: 1 }] });
    expect(blockingIssues(issues).map((i) => i.id)).toEqual(['species_dungeon_exclusive:dungeon']);
  });
});

describe('warnings and publish rules', () => {
  it('warns about disabled, missing-from-content and never-hunted species, and empty tiers', () => {
    const draft = run({ entries: [...FULL.filter((e) => e.species !== 'lr_a'), { species: 'off', weight: 1 }, { species: 'gone', weight: 1 }, { species: 'ex', weight: 1 }] });
    expect(blockingIssues(draft)).toEqual([]);
    expect(ids(draft)).toEqual([
      'species_disabled:off',
      'species_not_in_content:gone',
      'species_not_huntable:ex',
      'rarity_tier_empty:LR',
    ]);
    expect(draft.find((i) => i.code === 'rarity_tier_empty')!.message).toContain("Waifu Valley's LR species");
    // Only a publish requires acknowledgement.
    expect(requiredAcknowledgements(draft)).toEqual([]);
    const publish = run({ purpose: 'publish', entries: draft.length ? [...FULL.filter((e) => e.species !== 'lr_a'), { species: 'off', weight: 1 }] : [] });
    expect(requiredAcknowledgements(publish)).toEqual(['species_disabled:off', 'rarity_tier_empty:LR']);
  });

  it('a region-exclusive species published elsewhere is a draft warning and a publish error', () => {
    const otherPublished = new Map([['thirstlands', new Set(['excl'])]]);
    const entries = [...FULL, { species: 'excl', weight: 1 }];
    const draft = run({ entries, otherPublished });
    expect(draft.find((i) => i.code === 'region_exclusive_conflict')).toMatchObject({
      severity: 'warning',
      regions: ['thirstlands'],
    });
    const publish = run({ entries, otherPublished, purpose: 'publish' });
    expect(blockingIssues(publish).map((i) => i.id)).toEqual(['region_exclusive_conflict:excl']);
  });

  it('a released region needs at least one huntable species to publish', () => {
    const publish = run({ entries: [{ species: 'off', weight: 1 }], purpose: 'publish' });
    expect(blockingIssues(publish).map((i) => i.id)).toEqual(['pool_has_no_eligible_species']);
    const unreleased = run({ entries: [], purpose: 'publish', region: { ...REGION, released: false } });
    expect(blockingIssues(unreleased)).toEqual([]);
    expect(ids(unreleased)).toContain('region_not_released');
  });
});
