/**
 * The shipped dungeon-exclusive species, end to end through the content loader
 * and the Region Pool rules: they load enabled (artwork preflight included),
 * no region file lists one, and a region pool refuses each of them at draft
 * and at publish. Regular species from the same content stay eligible.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../../../src/modules/content/loader';
import { DUNGEON_EXCLUSIVE_TAG } from '../../../src/modules/locations/regions';
import type { RegionCatalogueEntry } from '../../../src/modules/regionPools/regionCatalogue';
import {
  blockingIssues,
  validateRegionPool,
  type PoolSpeciesFacts,
} from '../../../src/modules/regionPools/regionPoolValidation';
import { silentLogger } from '../../helpers/testDb';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const content = loadContent(path.join(ROOT, 'content'), path.join(ROOT, 'assets'), silentLogger());
const dungeonExclusive = content.species.filter((s) => s.tags.includes(DUNGEON_EXCLUSIVE_TAG));

const facts = new Map<string, PoolSpeciesFacts>(
  content.species.map((s) => [
    s.slug,
    {
      slug: s.slug,
      name: s.name,
      rarity: s.rarity,
      enabled: s.enabled,
      tags: [...s.tags],
      inContent: true,
      race: 'human',
      affinity: s.affinity,
      perSpeciesWeight: s.perSpeciesWeight,
      imagePath: s.imagePath,
    },
  ]),
);
const HUNTED = ['N', 'R', 'SR', 'SSR', 'UR', 'LR'];
const REGION: RegionCatalogueEntry = { id: 'twin-peeks', name: 'Twin Peeks', released: true, isDefault: false, shippedPool: [] };

/** One enabled, untagged species per hunted rarity — a pool that is otherwise clean. */
const regularPool = HUNTED.map((rarity) => {
  const s = content.species.find((c) => c.enabled && c.rarity === rarity && c.tags.every((t) => t !== DUNGEON_EXCLUSIVE_TAG && t !== 'region_exclusive'));
  if (!s) throw new Error(`shipped content has no regular ${rarity} species`);
  return { species: s.slug, weight: 1 };
});

const validate = (entries: { species: string; weight: number }[], purpose: 'draft' | 'publish') =>
  validateRegionPool({
    regionId: REGION.id,
    region: REGION,
    entries,
    facts,
    huntedRarities: HUNTED,
    otherPublished: new Map(),
    fallbackRegionName: 'Waifu Valley',
    purpose,
  });

describe('shipped dungeon-exclusive species', () => {
  it('are loaded from content, enabled after artwork preflight', () => {
    expect(dungeonExclusive.length).toBeGreaterThanOrEqual(5);
    for (const s of dungeonExclusive) expect({ slug: s.slug, enabled: s.enabled }).toEqual({ slug: s.slug, enabled: true });
  });

  it('are listed in no shipped region encounter pool', () => {
    const slugs = new Set(dungeonExclusive.map((s) => s.slug));
    for (const region of content.regions) {
      expect(region.encounterPool.filter((e) => slugs.has(e.species))).toEqual([]);
    }
  });

  it('leave a pool of regular species from the same content valid', () => {
    expect(blockingIssues(validate(regularPool, 'publish'))).toEqual([]);
  });

  it.each(['draft', 'publish'] as const)('are each refused by a region pool at %s', (purpose) => {
    for (const s of dungeonExclusive) {
      const issues = blockingIssues(validate([...regularPool, { species: s.slug, weight: 1 }], purpose));
      expect(issues.map((i) => i.id)).toEqual([`species_dungeon_exclusive:${s.slug}`]);
    }
  });
});
