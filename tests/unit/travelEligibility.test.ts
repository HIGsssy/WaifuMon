/**
 * Travel eligibility and the content→catalog projection.
 *
 * `evaluateDestination` is the single rule both the Locations screen and
 * `purchaseDestination` consult, so these are the tests that keep the screen
 * from ever offering a Buy button the purchase would refuse. Pure functions,
 * no database.
 */
import { describe, expect, it } from 'vitest';
import { buildTravelCatalog, toRegion } from '../../src/modules/travel/travelCatalog';
import { evaluateDestination } from '../../src/modules/travel/travelService';
import type { LoadedContent, RegionContent } from '../../src/modules/content/schemas';

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
    ...over,
  };
}

function content(over: Partial<LoadedContent> = {}): LoadedContent {
  return {
    items: [],
    species: [],
    bosses: [],
    bossRewards: [],
    expansions: [],
    speciesOrigin: {},
    regions: [
      region({ id: 'waifu-valley', name: 'Waifu Valley', starting: true }),
      region({ id: 'twin-peeks', name: 'Twin Peeks', order: 1 }),
    ],
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
    ...over,
  };
}

const ctx = (over: Partial<Parameters<typeof evaluateDestination>[1]> = {}) => ({
  level: 20,
  currentRegion: 'waifu-valley',
  passIds: new Set<string>(),
  unlocked: new Set<string>(),
  ...over,
});

describe('travel catalog', () => {
  it('prices a pass-granted destination at the pass price, not the route fee', () => {
    // The route itself costs 0; the *reachable* price of Twin Peeks is the
    // 1,000 the Caravan Pass costs. Getting this wrong would render a free
    // destination behind a level gate.
    const twinPeeks = buildTravelCatalog(content()).get('twin-peeks')!;
    expect(twinPeeks.price).toBe(1000);
    expect(twinPeeks.currency).toBe('waifubux');
    expect(twinPeeks.grantedByPassPurchase).toBe(true);
    expect(twinPeeks.requiredLevel).toBe(15);
  });

  it('lists the starting region first and as always-reachable', () => {
    const cat = buildTravelCatalog(content());
    expect(cat.destinations[0]!.region.id).toBe('waifu-valley');
    expect(cat.destinations[0]!.access).toBe('starting');
    expect(cat.destinations[0]!.price).toBe(0);
  });

  it('hides disabled regions entirely rather than showing them as locked', () => {
    const cat = buildTravelCatalog(
      content({
        regions: [
          region({ id: 'waifu-valley', name: 'Waifu Valley', starting: true }),
          region({ id: 'twin-peeks', name: 'Twin Peeks', enabled: false }),
        ],
      }),
    );
    expect(cat.destinations.map((d) => d.region.id)).toEqual(['waifu-valley']);
    expect(cat.get('twin-peeks')).toBeNull();
  });

  it('takes the stricter of the pass and route level gates', () => {
    const c = content();
    c.tables.travel.routes[0]!.requiredLevel = 22;
    expect(buildTravelCatalog(c).get('twin-peeks')!.requiredLevel).toBe(22);
  });
});

describe('destination eligibility', () => {
  const twinPeeks = () => buildTravelCatalog(content()).get('twin-peeks')!;
  const valley = () => buildTravelCatalog(content()).get('waifu-valley')!;

  it('marks the region the player is standing in as current', () => {
    expect(evaluateDestination(valley(), ctx()).state).toBe('current');
    expect(
      evaluateDestination(twinPeeks(), ctx({ currentRegion: 'twin-peeks' })).state,
    ).toBe('current');
  });

  it('treats the starting region as unlocked without any route row', () => {
    // Waifu Valley deliberately has no `player_unlocked_routes` row — it is
    // reachable by rule. A player standing in Twin Peeks must still be able to
    // go home.
    const state = evaluateDestination(valley(), ctx({ currentRegion: 'twin-peeks' }));
    expect(state.state).toBe('unlocked');
    expect(state.requirements).toEqual([]);
  });

  it('is purchasable once the level gate is met and nothing is owned', () => {
    const result = evaluateDestination(twinPeeks(), ctx({ level: 15 }));
    expect(result.state).toBe('purchasable');
    expect(result.requirements).toEqual([]);
  });

  it('is ineligible below the level gate, and names the gate', () => {
    const result = evaluateDestination(twinPeeks(), ctx({ level: 14 }));
    expect(result.state).toBe('ineligible');
    expect(result.requirements).toEqual(['Trainer Level 15 (you are 14)']);
  });

  it('is unlocked once a route row exists, whatever the level says', () => {
    // An admin grant, or a level lost to a content retune, must not close a
    // road the player already owns.
    const result = evaluateDestination(
      twinPeeks(),
      ctx({ level: 1, unlocked: new Set(['twin-peeks']) }),
    );
    expect(result.state).toBe('unlocked');
  });

  it('requires the pass first for a destination the pass does not itself grant', () => {
    const c = content();
    c.tables.travel.passes[0]!.grantsRoutes = [];
    c.tables.travel.routes[0]!.price = 400;
    const destination = buildTravelCatalog(c).get('twin-peeks')!;

    const withoutPass = evaluateDestination(destination, ctx({ level: 20 }));
    expect(withoutPass.state).toBe('ineligible');
    expect(withoutPass.requirements).toEqual(['Caravan Pass (buy it first)']);

    const withPass = evaluateDestination(
      destination,
      ctx({ level: 20, passIds: new Set(['caravan_pass']) }),
    );
    expect(withPass.state).toBe('purchasable');
    expect(destination.price).toBe(400);
  });

  it('reports a region content never priced as ineligible rather than crashing', () => {
    const c = content();
    c.tables.travel.routes = [];
    c.tables.travel.passes[0]!.grantsRoutes = [];
    const destination = buildTravelCatalog(c).get('twin-peeks')!;
    const result = evaluateDestination(destination, ctx());
    expect(result.state).toBe('ineligible');
    expect(result.requirements[0]).toMatch(/no route/i);
  });
});

describe('toRegion', () => {
  it('passes through canonical ids and defaults anything else', () => {
    expect(toRegion('twin-peeks')).toBe('twin-peeks');
    expect(toRegion('waifu-valley')).toBe('waifu-valley');
    expect(toRegion(null)).toBe('waifu-valley');
    expect(toRegion('atlantis')).toBe('waifu-valley');
  });
});
