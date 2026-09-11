/**
 * Species selectors through the promotion package: export → import preview →
 * validation → apply (hydration) → re-export, and the empty-candidate proof.
 *
 * "Apply" here is the same hydration a stored row goes through on load
 * (`hydrateChoice`), which is where a shape the schema no longer accepted
 * would be silently dropped.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEncounterPackage,
  planImport,
  stableJson,
  type CatalogSpecies,
  type ImportTargetState,
  type PackagedEncounter,
} from '../../../src/modules/worldEncounters/encounterPackage';
import { hydrateChoice } from '../../../src/modules/worldEncounters/hydrate';
import type { Effect, LoadedEncounter } from '../../../src/modules/worldEncounters/types';
import type { WorldEncounterChoiceRow } from '../../../src/modules/worldEncounters/worldEncounterRepository';

const T = 'trigger_waifumon_encounter' as const;

function encounter(effects: Effect[], overrides: Partial<LoadedEncounter> = {}): LoadedEncounter {
  return {
    id: 1,
    slug: 'lr_trail_end',
    name: 'The Trail Ends',
    description: '',
    type: 'discovery',
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
    choices: [
      {
        id: 11,
        sortOrder: 0,
        label: 'Follow the tracks',
        emoji: null,
        requirements: {},
        check: { type: 'none' },
        successEffects: effects,
        failureEffects: [],
      },
    ],
    metadata: {},
    ...overrides,
  };
}

const CATALOG: CatalogSpecies[] = [
  { slug: 'valley_n', rarity: 'N', affinity: 'switch', race: 'human', enabled: true, regionExclusive: false },
  { slug: 'valley_lr', rarity: 'LR', affinity: 'primal', race: 'demon', enabled: true, regionExclusive: false },
  { slug: 'peaks_ur', rarity: 'UR', affinity: 'dominant', race: 'angel', enabled: true, regionExclusive: true },
  { slug: 'retired_ex', rarity: 'EX', affinity: 'switch', race: 'spirit', enabled: false, regionExclusive: false },
];

function target(overrides: Partial<ImportTargetState> = {}): ImportTargetState {
  return {
    existingEncounters: new Map(),
    existingVendors: new Map(),
    itemSlugs: new Set(),
    speciesSlugs: new Set(CATALOG.map((s) => s.slug)),
    speciesCatalog: CATALOG,
    regionPools: new Map([
      ['waifu-valley', new Set(['valley_n', 'valley_lr', 'retired_ex'])],
      ['twin-peeks', new Set(['peaks_ur'])],
    ]),
    ...overrides,
  };
}

/** Export and put it through the wire, as a file download/upload would. */
function exported(loaded: LoadedEncounter): unknown {
  const pkg = buildEncounterPackage({
    encounters: [loaded],
    vendors: [],
    // Pinned so two exports differ only if their content does.
    exportedAt: new Date('2026-01-01T00:00:00Z'),
  });
  return JSON.parse(JSON.stringify(pkg));
}

/** Apply: store the authored JSON, then load it back the way the engine does. */
function applied(pkg: unknown): LoadedEncounter {
  const p = (pkg as { encounters: PackagedEncounter[] }).encounters[0]!;
  return {
    ...p,
    id: 99,
    choices: p.choices.map((c, i) =>
      hydrateChoice({
        id: 100 + i,
        sortOrder: i,
        label: c.label,
        emoji: c.emoji,
        requirementsJson: c.requirements,
        checkJson: c.check,
        successEffectsJson: JSON.parse(JSON.stringify(c.successEffects)),
        failureEffectsJson: JSON.parse(JSON.stringify(c.failureEffects)),
      } as unknown as WorldEncounterChoiceRow),
    ),
  };
}

function firstEffect(pkg: unknown): unknown {
  return (pkg as { encounters: PackagedEncounter[] }).encounters[0]!.choices[0]!.successEffects[0];
}

function roundTrip(loaded: LoadedEncounter) {
  const first = exported(loaded);
  const preview = planImport(first, target());
  const reloaded = applied(first);
  const second = exported(reloaded);
  const replay = planImport(second, target({ existingEncounters: new Map([[reloaded.slug, reloaded]]) }));
  return { first, second, preview, replay };
}

describe('round-trip', () => {
  it.each([
    ['legacy random', { type: T }],
    ['legacy specific', { type: T, speciesSlug: 'valley_lr' }],
  ] as const)('%s survives unchanged', (_label, effect) => {
    const { first, second, preview, replay } = roundTrip(encounter([effect as Effect]));
    expect(preview.ok).toBe(true);
    expect(firstEffect(first)).toEqual(effect);
    expect(stableJson(second)).toBe(stableJson(first));
    expect(replay.encounters[0]!.status).toBe('unchanged');
  });

  it('filtered selector survives with filters and poolScope exactly preserved', () => {
    const effect = {
      type: T,
      selection: {
        mode: 'random',
        poolScope: 'region',
        rarities: ['UR', 'LR'],
        races: ['demon', 'spirit'],
        affinities: ['primal', 'dominant'],
      },
    } as Effect;
    const { first, second, preview, replay } = roundTrip(encounter([effect]));

    expect(preview.ok).toBe(true);
    expect(firstEffect(first)).toEqual(effect);
    expect(firstEffect(second)).toEqual(effect);
    expect(stableJson(second)).toBe(stableJson(first));
    expect(replay.encounters[0]!.status).toBe('unchanged');
  });

  it('global scope is preserved', () => {
    const effect = {
      type: T,
      selection: { mode: 'random', poolScope: 'global', rarities: ['LR'] },
    } as Effect;
    const { first, second } = roundTrip(encounter([effect]));
    expect(firstEffect(first)).toEqual(effect);
    expect(firstEffect(second)).toEqual(effect);
  });

  it('specific selector survives', () => {
    const effect = { type: T, selection: { mode: 'specific', speciesSlug: 'valley_lr' } } as Effect;
    const { second, preview } = roundTrip(encounter([effect]));
    expect(preview.ok).toBe(true);
    expect(firstEffect(second)).toEqual(effect);
  });

  it('refuses a package carrying a non-canonical filter value', () => {
    const pkg = exported(encounter([{ type: T }])) as {
      encounters: Array<{ choices: Array<{ successEffects: unknown[] }> }>;
    };
    pkg.encounters[0]!.choices[0]!.successEffects = [
      { type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['XR'] } },
    ];
    const plan = planImport(pkg, target());
    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain('schema');
  });
});

describe('species references', () => {
  it('specific selector validates its species like the legacy slug does', () => {
    const bad = encounter([{ type: T, selection: { mode: 'specific', speciesSlug: 'nobody' } } as Effect]);
    expect(planImport(exported(bad), target()).issues.map((i) => i.code)).toContain('missing_species');

    const legacyBad = encounter([{ type: T, speciesSlug: 'nobody' }]);
    expect(planImport(exported(legacyBad), target()).issues.map((i) => i.code)).toContain(
      'missing_species',
    );
  });

  it('a random selector introduces no species dependency', () => {
    const random = encounter([
      { type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] } } as Effect,
    ]);
    const plan = planImport(exported(random), target({ speciesSlugs: new Set() }));
    expect(plan.issues.map((i) => i.code)).not.toContain('missing_species');
  });
});

describe('provably empty selectors', () => {
  const selector = (sel: Record<string, unknown>, overrides: Partial<LoadedEncounter> = {}) =>
    exported(encounter([{ type: T, selection: { mode: 'random', ...sel } } as Effect], overrides));

  it('errors when nothing matches anywhere — disabled species do not count', () => {
    const plan = planImport(selector({ poolScope: 'region', rarities: ['EX'] }), target());
    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain('selector_no_candidates');

    const global = planImport(selector({ poolScope: 'global', rarities: ['EX'] }), target());
    expect(global.issues.map((i) => i.code)).toContain('selector_no_candidates');
  });

  it('warns, not errors, for a region the encounter can fire in that has no match', () => {
    const plan = planImport(
      selector({ poolScope: 'region', rarities: ['LR'] }, { regions: ['waifu-valley', 'twin-peeks'] }),
      target(),
    );
    expect(plan.ok).toBe(true);
    const warning = plan.issues.find((i) => i.code === 'selector_region_no_candidates');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('twin-peeks');
    expect(warning?.message).not.toContain('waifu-valley');
    // Structured, so the Portal can label regions rather than parse the message.
    expect(warning?.regions).toEqual(['twin-peeks']);
  });

  it('checks a travel encounter against its destinations', () => {
    const plan = planImport(
      selector(
        { poolScope: 'region', rarities: ['LR'] },
        {
          huntEligible: false,
          travelEligible: true,
          routes: [{ fromRegion: 'waifu-valley', toRegion: 'twin-peeks' }],
        },
      ),
      target(),
    );
    const warning = plan.issues.find((i) => i.code === 'selector_region_no_candidates');
    expect(warning?.message).toContain('twin-peeks');
  });

  it('global scope reaches a region-exclusive only where she is pooled', () => {
    // The only UR is exclusive to Twin Peeks: reachable, but not from the valley.
    const plan = planImport(
      selector({ poolScope: 'global', rarities: ['UR'] }, { regions: ['waifu-valley'] }),
      target(),
    );
    expect(plan.ok).toBe(true);
    expect(plan.issues.map((i) => i.code)).toContain('selector_region_no_candidates');
  });

  it('is silent for a selector with candidates wherever it can fire', () => {
    const plan = planImport(
      selector({ poolScope: 'region', rarities: ['LR'] }, { regions: ['waifu-valley'] }),
      target(),
    );
    expect(plan.issues).toEqual([]);
  });

  it('skips the proof when the target cannot describe its species', () => {
    const plan = planImport(
      selector({ poolScope: 'region', rarities: ['EX'] }),
      target({ speciesCatalog: undefined, regionPools: undefined } as unknown as Partial<ImportTargetState>),
    );
    expect(plan.issues.map((i) => i.code)).not.toContain('selector_no_candidates');
  });
});
