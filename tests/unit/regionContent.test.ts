/**
 * Region, expansion and travel content validation — one test per §7 rule,
 * each with a crafted bad fixture asserting the specific error.
 *
 * Two layers are exercised on purpose. Some rules are enforceable by a single
 * file's schema (weights, unknown pass references) and belong in Zod; others
 * need the whole content set in hand (unknown species, disabled packs,
 * duplicate ids, the starting region) and belong in `validateRegionContent`.
 * Testing both here keeps the boundary honest: a rule that quietly moved from
 * one layer to the other still has to keep failing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readExpansionPacks,
  validateContentSet,
  validateRegionContent,
} from '../../src/modules/content/loader';
import {
  RegionContentSchema,
  TravelConfigSchema,
  type LoadedContent,
  type RegionContent,
  type SpeciesContent,
} from '../../src/modules/content/schemas';

function species(slug: string, tags: string[] = []): SpeciesContent {
  return {
    slug,
    name: slug,
    rarity: 'N',
    archetype: 'human',
    baseCaptureRate: null,
    description: '',
    tags,
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: `waifumon/${slug}/standard.png`,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
  } as SpeciesContent;
}

function region(over: Partial<RegionContent> & Pick<RegionContent, 'id' | 'name'>): RegionContent {
  return {
    description: '',
    emoji: null,
    enabled: true,
    starting: false,
    order: 0,
    flavor: [],
    encounterPool: [],
    shopItems: [],
    bannerImagePath: null,
    ...over,
  };
}

const TRAVEL_OFF = { enabled: false, passes: [], routes: [] };

function content(over: Partial<LoadedContent> = {}): LoadedContent {
  return {
    items: [],
    species: [species('valley_girl')],
    bosses: [],
    bossRewards: [],
    expansions: [],
    speciesOrigin: {},
    regions: [
      region({
        id: 'waifu-valley',
        name: 'Waifu Valley',
        starting: true,
        encounterPool: [{ species: 'valley_girl' }],
      }),
    ],
    tables: { travel: TRAVEL_OFF } as unknown as LoadedContent['tables'],
    ...over,
  };
}

describe('rule 1 — unknown species references fail', () => {
  it('names the region and the slug', () => {
    const bad = content();
    bad.regions[0]!.encounterPool = [{ species: 'nobody_by_that_name' }];
    expect(() => validateRegionContent(bad)).toThrow(
      /Region "waifu-valley" references unknown species slug: nobody_by_that_name/,
    );
  });
});

describe('rule 2 — duplicate ids fail', () => {
  it('rejects two region files claiming the same region', () => {
    const bad = content({
      regions: [
        region({
          id: 'waifu-valley',
          name: 'Waifu Valley',
          starting: true,
          encounterPool: [{ species: 'valley_girl' }],
        }),
        region({
          id: 'waifu-valley',
          name: 'Valley Again',
          encounterPool: [{ species: 'valley_girl' }],
        }),
      ],
    });
    expect(() => validateRegionContent(bad)).toThrow(/Duplicate region id: waifu-valley/);
  });

  it('rejects one species listed twice in the same pool', () => {
    const bad = content();
    bad.regions[0]!.encounterPool = [{ species: 'valley_girl' }, { species: 'valley_girl' }];
    expect(() => validateRegionContent(bad)).toThrow(/lists species "valley_girl" .* twice/);
  });
});

describe('rule 2 — global slug uniqueness spans disabled expansions', () => {
  it('rejects a disabled pack that collides with a core species', () => {
    // The collision that validates clean for months and then detonates the day
    // somebody flips `enabled`. `speciesOrigin` carries disabled packs for
    // exactly this reason.
    const bad = content({
      expansions: [
        {
          id: 'flaccid_foothills',
          name: 'Flaccid Foothills',
          description: '',
          enabled: false,
          order: 99,
          regionId: null,
        },
      ],
      speciesOrigin: { valley_girl: 'flaccid_foothills' },
    });
    expect(() => validateContentSet(bad)).toThrow(
      /Duplicate species slug "valley_girl": defined by the disabled expansion "flaccid_foothills"/,
    );
  });

  it('rejects two packs defining the same slug, whatever their enabled state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-dup-'));
    try {
      for (const [name, enabled] of [
        ['alpha', true],
        ['beta', false],
      ] as const) {
        const pack = path.join(dir, 'expansions', name);
        fs.mkdirSync(path.join(pack, 'species'), { recursive: true });
        fs.writeFileSync(
          path.join(pack, 'expansion.json'),
          JSON.stringify({ id: name, name, enabled }),
        );
        fs.writeFileSync(
          path.join(pack, 'species', 's.json'),
          JSON.stringify([species('contested_girl')]),
        );
      }
      expect(() => readExpansionPacks(dir)).toThrow(
        /Duplicate species slug "contested_girl": defined by both expansion "alpha" and expansion "beta"/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rule 3 — invalid weights fail', () => {
  it.each([0, -3, 2.5])('rejects a weight of %s at the schema layer', (weight) => {
    const parsed = RegionContentSchema.safeParse({
      id: 'twin-peeks',
      name: 'Twin Peeks',
      encounterPool: [{ species: 'valley_girl', weight }],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a positive integer weight', () => {
    const parsed = RegionContentSchema.safeParse({
      id: 'twin-peeks',
      name: 'Twin Peeks',
      encounterPool: [{ species: 'valley_girl', weight: 12 }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('rule 4 — unknown pass/region references fail', () => {
  it('rejects a route naming a pass that does not exist', () => {
    const parsed = TravelConfigSchema.safeParse({
      enabled: true,
      passes: [{ id: 'caravan_pass', name: 'Caravan Pass', price: 1000 }],
      routes: [{ regionId: 'twin-peeks', passId: 'ghost_pass' }],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toMatch(/unknown pass \\"ghost_pass\\"/);
  });

  it('rejects a region id outside the canonical set', () => {
    const parsed = TravelConfigSchema.safeParse({
      enabled: true,
      passes: [{ id: 'caravan_pass', name: 'Caravan Pass', price: 1000 }],
      routes: [{ regionId: 'atlantis', passId: 'caravan_pass' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a pass granting a destination no route declares', () => {
    const parsed = TravelConfigSchema.safeParse({
      enabled: true,
      passes: [
        { id: 'caravan_pass', name: 'Caravan Pass', price: 1000, grantsRoutes: ['twin-peeks'] },
      ],
      routes: [],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toMatch(/no entry in travel.routes/);
  });

  it('rejects a route to a region no region file defines', () => {
    const bad = content({
      tables: {
        travel: {
          enabled: true,
          passes: [
            {
              id: 'caravan_pass',
              name: 'Caravan Pass',
              description: '',
              emoji: null,
              price: 1000,
              currency: 'waifubux',
              requiredLevel: 15,
              grantsRoutes: ['twin-peeks'],
            },
          ],
          routes: [
            {
              regionId: 'twin-peeks',
              passId: 'caravan_pass',
              price: 0,
              currency: 'waifubux',
              requiredLevel: 15,
            },
          ],
        },
      } as unknown as LoadedContent['tables'],
    });
    expect(() => validateRegionContent(bad)).toThrow(
      /route to region "twin-peeks", which no region file defines/,
    );
  });

  it('refuses to sell a route to the starting region', () => {
    const parsed = TravelConfigSchema.safeParse({
      enabled: true,
      passes: [{ id: 'caravan_pass', name: 'Caravan Pass', price: 1000 }],
      routes: [{ regionId: 'waifu-valley', passId: 'caravan_pass' }],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toMatch(/always reachable/);
  });
});

describe('rule 5 — exactly one starting region is required', () => {
  it('rejects none', () => {
    const bad = content();
    bad.regions[0]!.starting = false;
    expect(() => validateRegionContent(bad)).toThrow(/Exactly one region must be marked/);
  });

  it('rejects two', () => {
    const bad = content({
      regions: [
        region({
          id: 'waifu-valley',
          name: 'Waifu Valley',
          starting: true,
          encounterPool: [{ species: 'valley_girl' }],
        }),
        region({
          id: 'twin-peeks',
          name: 'Twin Peeks',
          starting: true,
          encounterPool: [{ species: 'valley_girl' }],
        }),
      ],
    });
    expect(() => validateRegionContent(bad)).toThrow(/found 2: waifu-valley, twin-peeks/);
  });

  it('rejects a starting region that disagrees with DEFAULT_REGION', () => {
    const bad = content({
      regions: [
        region({
          id: 'twin-peeks',
          name: 'Twin Peeks',
          starting: true,
          encounterPool: [{ species: 'valley_girl' }],
        }),
      ],
    });
    expect(() => validateRegionContent(bad)).toThrow(/defaults to "waifu-valley"/);
  });

  it('rejects a disabled starting region', () => {
    const bad = content();
    bad.regions[0]!.enabled = false;
    expect(() => validateRegionContent(bad)).toThrow(/must be enabled/);
  });
});

describe('enabled regions require encounter pools', () => {
  it('rejects an enabled region with an empty pool', () => {
    const bad = content({
      regions: [
        region({
          id: 'waifu-valley',
          name: 'Waifu Valley',
          starting: true,
          encounterPool: [{ species: 'valley_girl' }],
        }),
        region({ id: 'twin-peeks', name: 'Twin Peeks' }),
      ],
    });
    expect(() => validateRegionContent(bad)).toThrow(
      /Region "twin-peeks" is enabled but defines no encounterPool/,
    );
  });

  it('allows a disabled region with an empty pool', () => {
    const ok = content({
      regions: [
        region({
          id: 'waifu-valley',
          name: 'Waifu Valley',
          starting: true,
          encounterPool: [{ species: 'valley_girl' }],
        }),
        region({ id: 'twin-peeks', name: 'Twin Peeks', enabled: false }),
      ],
    });
    expect(() => validateRegionContent(ok)).not.toThrow();
  });
});

describe('rule 6 — region-exclusive species may appear in only one live pool', () => {
  const exclusive = () =>
    content({
      species: [species('valley_girl'), species('peak_ghost', ['region_exclusive'])],
      regions: [
        region({
          id: 'waifu-valley',
          name: 'Waifu Valley',
          starting: true,
          encounterPool: [{ species: 'valley_girl' }, { species: 'peak_ghost' }],
        }),
        region({
          id: 'twin-peeks',
          name: 'Twin Peeks',
          encounterPool: [{ species: 'peak_ghost' }],
        }),
      ],
    });

  it('rejects a tagged species in two enabled pools', () => {
    expect(() => validateRegionContent(exclusive())).toThrow(
      /Species "peak_ghost" is tagged "region_exclusive" but appears in .* 2 enabled regions/,
    );
  });

  it('allows the same shared species in two pools when it is not tagged', () => {
    const shared = exclusive();
    shared.species[1]!.tags = [];
    expect(() => validateRegionContent(shared)).not.toThrow();
  });

  it('does not count a disabled region against the exclusivity budget', () => {
    // An unreleased region is not a place a player can be, so a species
    // listed in one live pool and one unreleased one is still exclusive.
    const staged = exclusive();
    staged.regions[1]!.enabled = false;
    staged.regions[0]!.encounterPool = [{ species: 'valley_girl' }, { species: 'peak_ghost' }];
    expect(() => validateRegionContent(staged)).not.toThrow();
  });
});

describe('rule 7 — disabled expansion species cannot be referenced', () => {
  it('says the pack is disabled rather than "unknown species"', () => {
    // The distinction is the whole point: same fatal outcome, completely
    // different fix, so the message must name the pack and its file.
    const bad = content({
      expansions: [
        {
          id: 'flaccid_foothills',
          name: 'Flaccid Foothills',
          description: '',
          enabled: false,
          order: 99,
          regionId: null,
        },
      ],
      speciesOrigin: { foothill_girl: 'flaccid_foothills' },
    });
    bad.regions[0]!.encounterPool = [{ species: 'valley_girl' }, { species: 'foothill_girl' }];
    expect(() => validateRegionContent(bad)).toThrow(
      /belongs to the disabled expansion "flaccid_foothills"/,
    );
  });
});

describe('shop membership references', () => {
  it('rejects an unknown item slug in a region shop', () => {
    const bad = content();
    bad.regions[0]!.shopItems = ['no_such_item'];
    expect(() => validateRegionContent(bad)).toThrow(
      /shopItems references unknown item slug: no_such_item/,
    );
  });
});

describe('expansion discovery', () => {
  const dirs: string[] = [];
  const makeDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-packs-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a directory with no expansion.json rather than scanning it', () => {
    // The orphan-content guard: before this rule, `content/expansions/x/` full
    // of species JSON would have gone live the moment discovery shipped.
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'expansions', 'orphan'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'expansions', 'orphan', 'things.json'), '[]');
    expect(() => readExpansionPacks(dir)).toThrow(
      /content\/expansions\/orphan\/ has no expansion.json/,
    );
  });

  it('records a disabled pack and loads none of its species or region', () => {
    const dir = makeDir();
    const pack = path.join(dir, 'expansions', 'shelved');
    fs.mkdirSync(path.join(pack, 'species'), { recursive: true });
    fs.writeFileSync(
      path.join(pack, 'expansion.json'),
      JSON.stringify({ id: 'shelved', name: 'Shelved', enabled: false }),
    );
    fs.writeFileSync(
      path.join(pack, 'species', 's.json'),
      JSON.stringify([species('shelved_girl')]),
    );
    fs.writeFileSync(
      path.join(pack, 'region.json'),
      JSON.stringify({ id: 'twin-peeks', name: 'Twin Peeks' }),
    );

    const scan = readExpansionPacks(dir);
    expect(scan.expansions.map((e) => e.id)).toEqual(['shelved']);
    expect(scan.expansionSpecies).toEqual([]);
    expect(scan.regions).toEqual([]);
    // Origin is still recorded — that is what makes rule 7's message possible.
    expect(scan.speciesOrigin).toEqual({ shelved_girl: 'shelved' });
  });

  it('loads an enabled pack’s species and region', () => {
    const dir = makeDir();
    const pack = path.join(dir, 'expansions', 'live');
    fs.mkdirSync(path.join(pack, 'species'), { recursive: true });
    fs.writeFileSync(
      path.join(pack, 'expansion.json'),
      JSON.stringify({ id: 'live', name: 'Live', enabled: true, regionId: 'twin-peeks' }),
    );
    fs.writeFileSync(
      path.join(pack, 'species', 's.json'),
      JSON.stringify([species('live_girl')]),
    );
    fs.writeFileSync(
      path.join(pack, 'region.json'),
      JSON.stringify({
        id: 'twin-peeks',
        name: 'Twin Peeks',
        encounterPool: [{ species: 'live_girl', weight: 5 }],
      }),
    );

    const scan = readExpansionPacks(dir);
    expect(scan.expansionSpecies.map((s) => s.slug)).toEqual(['live_girl']);
    expect(scan.regions.map((r) => r.id)).toEqual(['twin-peeks']);
    expect(scan.regions[0]!.encounterPool).toEqual([{ species: 'live_girl', weight: 5 }]);
  });

  it('refuses an enabled pack that claims a region but ships no region.json', () => {
    const dir = makeDir();
    const pack = path.join(dir, 'expansions', 'halfway');
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(
      path.join(pack, 'expansion.json'),
      JSON.stringify({ id: 'halfway', name: 'Halfway', enabled: true, regionId: 'twin-peeks' }),
    );
    expect(() => readExpansionPacks(dir)).toThrow(/ships\s+no region.json/);
  });
});

describe('shipped content', () => {
  it('keeps the flaccid_foothills pack switched off', () => {
    // It has never been wired to anything; this is the test that stops it
    // becoming live by accident now that discovery exists.
    const scan = readExpansionPacks(path.resolve(__dirname, '..', '..', 'content'));
    const foothills = scan.expansions.find((e) => e.id === 'flaccid_foothills');
    expect(foothills).toBeDefined();
    expect(foothills!.enabled).toBe(false);
    expect(scan.expansionSpecies.some((s) => s.slug === 'starfall_street_dancer')).toBe(false);
  });

  it('ships Waifu Valley as an explicit starting pool and Twin Peeks as a destination', () => {
    const scan = readExpansionPacks(path.resolve(__dirname, '..', '..', 'content'));
    const valley = scan.regions.find((r) => r.id === 'waifu-valley')!;
    const twin = scan.regions.find((r) => r.id === 'twin-peeks')!;
    expect(valley.starting).toBe(true);
    expect(valley.encounterPool.length).toBeGreaterThan(0);
    expect(twin.starting).toBe(false);
    expect(twin.encounterPool.length).toBeGreaterThan(0);
    // Twin Peeks is a curated slice at its own rates, not a copy of the valley.
    expect(twin.encounterPool.length).toBeLessThan(valley.encounterPool.length);
    expect(twin.encounterPool.every((e) => typeof e.weight === 'number')).toBe(true);
  });
});

describe('bannerImagePath � optional, safe local asset only', () => {
  it('accepts a safe relative asset path', () => {
    const parsed = RegionContentSchema.safeParse({
      id: 'twin-peeks',
      name: 'Twin Peeks',
      bannerImagePath: 'locations/twin-peeks/banner.png',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bannerImagePath).toBe('locations/twin-peeks/banner.png');
    }
  });

  it('defaults to null when omitted', () => {
    const parsed = RegionContentSchema.safeParse({
      id: 'waifu-valley',
      name: 'Waifu Valley',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.bannerImagePath).toBeNull();
  });

  it.each([
    ['http://evil.example/banner.png', /URL/i],
    ['https://cdn.discordapp.com/banner.png', /URL/i],
    ['/etc/passwd', /absolute/i],
    ['C:/Windows/banner.png', /drive letter/i],
    ['locations\\twin-peeks\\banner.png', /forward slashes/i],
    ['../../secrets/banner.png', /"\.\."/],
    ['', /at least 1/i],
  ])('rejects unsafe banner path %j', (bad, message) => {
    const parsed = RegionContentSchema.safeParse({
      id: 'twin-peeks',
      name: 'Twin Peeks',
      bannerImagePath: bad,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const joined = parsed.error.issues.map((i) => i.message).join(' | ');
      expect(joined).toMatch(message);
    }
  });
});
