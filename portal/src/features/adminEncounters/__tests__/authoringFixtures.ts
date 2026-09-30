/**
 * A small World Encounter content set shared by the authoring tests:
 *
 *   A Strange Door (Travel, 15 min repeat)
 *   ├ “Open it” (skill check)
 *   │  ├ On success → Security Override (chain-only, draft)
 *   │  │  └ “Hack terminal” → Hidden Laboratory (chain-only)
 *   │  └ On failure → Alarm Triggered (also appears in Hunt)
 *   ├ “Knock”
 *   └ “Leave”
 *   Lonely Room — chain-only, nothing links to it
 *   Market Stall — Hunt, Twin Peeks only, opens the Wandering Merchant
 *   Broken Bridge — Hunt, continues to an encounter that does not exist
 */
import type {
  AdminEncounter,
  AdminEncounterChoice,
  AdminEncounterReference,
} from '@/api/adminEncounters';
import type { AdminVendor } from '@/api/adminVendors';

export function enc(
  over: Partial<AdminEncounter> & Pick<AdminEncounter, 'id' | 'slug' | 'name'>,
): AdminEncounter {
  return {
    description: '',
    type: 'decision',
    rarity: 'common',
    weight: 10,
    lifecycle: 'active',
    huntEligible: true,
    travelEligible: false,
    cooldownSeconds: 0,
    artworkPath: null,
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    choices: [],
    metadata: {},
    ...over,
  };
}

export function choice(
  id: number,
  label: string,
  check: Record<string, unknown>,
  successEffects: Array<Record<string, unknown>> = [],
  failureEffects: Array<Record<string, unknown>> = [],
  requirements: Record<string, unknown> = {},
): AdminEncounterChoice {
  return {
    id,
    sortOrder: 0,
    label,
    emoji: null,
    requirements,
    check,
    successEffects,
    failureEffects,
  };
}

const AUTO = { type: 'none' };

export const DOOR = enc({
  id: 1,
  slug: 'a_strange_door',
  name: 'A Strange Door',
  huntEligible: false,
  travelEligible: true,
  cooldownSeconds: 900,
  artworkPath: 'encounters/door.webp',
  choices: [
    choice(
      10,
      'Open it',
      { type: 'sp', baseChance: 0.5, maxSpModifier: 0.15 },
      [
        { type: 'energy_gain', amount: 3 },
        { type: 'player_xp', amount: 10 },
        { type: 'trigger_encounter', encounterSlug: 'security_override' },
      ],
      [
        { type: 'energy_loss', amount: 2 },
        { type: 'trigger_encounter', encounterSlug: 'alarm_triggered' },
      ],
    ),
    choice(11, 'Knock', AUTO),
    choice(12, 'Leave', AUTO),
  ],
});

export const OVERRIDE = enc({
  id: 2,
  slug: 'security_override',
  name: 'Security Override',
  lifecycle: 'draft',
  huntEligible: false,
  choices: [
    choice(20, 'Hack terminal', AUTO, [
      { type: 'trigger_encounter', encounterSlug: 'hidden_laboratory' },
    ]),
  ],
});

export const LAB = enc({
  id: 3,
  slug: 'hidden_laboratory',
  name: 'Hidden Laboratory',
  huntEligible: false,
  choices: [choice(30, 'Look around', AUTO)],
});

export const ALARM = enc({
  id: 4,
  slug: 'alarm_triggered',
  name: 'Alarm Triggered',
  huntEligible: true,
  choices: [choice(40, 'Run', AUTO)],
});

export const ORPHAN = enc({
  id: 5,
  slug: 'lonely_room',
  name: 'Lonely Room',
  huntEligible: false,
  lifecycle: 'draft',
  choices: [choice(50, 'Wait', AUTO)],
});

export const STALL = enc({
  id: 6,
  slug: 'market_stall',
  name: 'Market Stall',
  type: 'vendor',
  regions: ['twin-peeks'],
  artworkPath: 'encounters/stall.webp',
  choices: [choice(60, 'Browse', AUTO, [{ type: 'open_vendor', vendorKey: 'wandering_merchant' }])],
});

export const BRIDGE = enc({
  id: 7,
  slug: 'broken_bridge',
  name: 'Broken Bridge',
  lifecycle: 'disabled',
  choices: [choice(70, 'Cross', AUTO, [{ type: 'trigger_encounter', encounterSlug: 'nowhere' }])],
});

export const ALL = [DOOR, OVERRIDE, LAB, ALARM, ORPHAN, STALL, BRIDGE];

export const REFERENCE: AdminEncounterReference = {
  regions: ['waifu-valley', 'twin-peeks'],
  regionNames: { 'waifu-valley': 'Waifu Valley', 'twin-peeks': 'Twin Peeks' },
  enabledRegions: ['waifu-valley', 'twin-peeks'],
  speciesRarities: ['N', 'R'],
  affinities: ['primal', 'arcane'],
  races: ['demon', 'human'],
  items: [
    { slug: 'basic_charm', name: 'Basic Charm', category: 'charm' },
    { slug: 'energy_drink', name: 'Energy Drink', category: 'consumable' },
  ],
  encounters: ALL.map((e) => ({ slug: e.slug, name: e.name })),
  species: [],
  vendors: [{ vendorKey: 'wandering_merchant', name: 'The Wandering Merchant' }],
  types: ['decision', 'skill_check', 'vendor'],
  rarities: ['common', 'uncommon', 'rare', 'mythic'],
  lifecycles: ['draft', 'active', 'disabled'],
};

export const MERCHANT: AdminVendor = {
  vendorKey: 'wandering_merchant',
  name: 'The Wandering Merchant',
  description: 'Rare curiosities.',
  stock: [
    { itemSlug: 'basic_charm', quantity: 3, price: 75, currency: 'waifubux' },
    { itemSlug: 'energy_drink', quantity: 1, price: 125, currency: 'waifubux' },
  ],
  updatedAt: '2026-09-01T00:00:00.000Z',
  usedBy: [{ id: 6, slug: 'market_stall', name: 'Market Stall', lifecycle: 'active' }],
};

export const EMPTY_SHOP: AdminVendor = {
  vendorKey: 'empty_shop',
  name: 'Empty Shop',
  description: '',
  stock: [],
  updatedAt: '2026-09-01T00:00:00.000Z',
  usedBy: [],
};

export const SETTINGS = {
  huntChance: 0.35,
  travelChance: 0.2,
  defaultExpirySeconds: 600,
  forceTrigger: false,
  updatedAt: null,
  updatedBy: null,
  bounds: { chance: { min: 0, max: 1 }, expirySeconds: { min: 30, max: 86_400 } },
};
