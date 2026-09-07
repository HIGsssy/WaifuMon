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
import {
  evaluateDestination,
  evaluateTravelReadiness,
  TRAVEL_ENERGY_COST,
} from '../../src/modules/travel/travelService';
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
    bannerImagePath: null,
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

/**
 * Travel readiness — the player-shaped blocks, as a pure rule.
 *
 * `evaluateTravelReadiness` plays the same role for the Travel button that
 * `evaluateDestination` plays for the Buy button: one function decides, and
 * both the Locations screen and `travelService.travel()` consult it. These
 * tests pin the verdicts and — more importantly — the *priority order*, since
 * that is what decides which message a player sees when several rules are
 * unmet at once, and it is invisible from either call site.
 */
describe('evaluateTravelReadiness', () => {
  const ready = { activeEncounterId: null, careModeActive: false, huntEnergy: 10 };

  it('permits travel with energy, no encounter and no care mode', () => {
    const r = evaluateTravelReadiness(ready);
    expect(r.canTravel).toBe(true);
    expect(r.blockedBy).toBeNull();
    // A permitted verdict carries no copy — there is nothing for a screen to
    // explain, and a non-null reason here would paint a warning banner on a
    // perfectly healthy map.
    expect(r.shortReason).toBeNull();
    expect(r.detail).toBeNull();
  });

  it('blocks on an open encounter', () => {
    const r = evaluateTravelReadiness({ ...ready, activeEncounterId: 42 });
    expect(r.canTravel).toBe(false);
    expect(r.blockedBy).toBe('active_encounter');
    expect(r.detail).toMatch(/before travelling/);
  });

  it('blocks in Care Mode even with a full tank', () => {
    const r = evaluateTravelReadiness({ ...ready, careModeActive: true, huntEnergy: 99 });
    expect(r.canTravel).toBe(false);
    expect(r.blockedBy).toBe('care_mode');
    expect(r.shortReason).toBe('💤 Resting in Care Mode');
  });

  it('blocks below the travel cost', () => {
    const r = evaluateTravelReadiness({ ...ready, huntEnergy: TRAVEL_ENERGY_COST - 1 });
    expect(r.canTravel).toBe(false);
    expect(r.blockedBy).toBe('insufficient_energy');
    expect(r.shortReason).toBe('⚡ Not enough Energy');
  });

  it('permits travel at exactly the travel cost', () => {
    // The boundary the whole gate turns on: the cost is affordable, not
    // merely exceeded.
    const r = evaluateTravelReadiness({ ...ready, huntEnergy: TRAVEL_ENERGY_COST });
    expect(r.canTravel).toBe(true);
  });

  it('reports Care Mode ahead of Energy when both apply', () => {
    // A resting player is nearly always also at zero. "Leave Care Mode" is the
    // instruction that moves them forward; "claim your daily" is advice for a
    // problem they are already solving.
    const r = evaluateTravelReadiness({
      activeEncounterId: null,
      careModeActive: true,
      huntEnergy: 0,
    });
    expect(r.blockedBy).toBe('care_mode');
  });

  it('reports an open encounter ahead of everything else', () => {
    // The encounter is the most immediate and the most recoverable: it is on
    // screen, and one click clears it.
    const r = evaluateTravelReadiness({
      activeEncounterId: 7,
      careModeActive: true,
      huntEnergy: 0,
    });
    expect(r.blockedBy).toBe('active_encounter');
  });

  it('gives every blocked verdict copy for both a button and a banner', () => {
    // The screens print these verbatim. A null on a blocked verdict would
    // paint an unlabelled dead button or a silent refusal.
    const blocked = [
      { activeEncounterId: 1, careModeActive: false, huntEnergy: 10 },
      { activeEncounterId: null, careModeActive: true, huntEnergy: 10 },
      { activeEncounterId: null, careModeActive: false, huntEnergy: 0 },
    ];
    for (const ctx of blocked) {
      const r = evaluateTravelReadiness(ctx);
      expect(r.canTravel).toBe(false);
      expect(r.shortReason).toBeTruthy();
      expect(r.detail).toBeTruthy();
    }
  });
});
