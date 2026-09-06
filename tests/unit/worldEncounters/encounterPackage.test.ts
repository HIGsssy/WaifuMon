/**
 * The promotion package format and its import planner.
 *
 * Both are pure, so everything below runs without a database — which is what
 * lets the planner's failure modes be enumerated properly. The properties
 * being pinned are the ones that make a package safe to carry between
 * environments:
 *
 *   - it contains authored fields and *only* authored fields;
 *   - identity is by slug, never by a surrogate key that means something
 *     different on the far side;
 *   - a reference is satisfiable by the package itself, so a chain or an
 *     encounter-plus-vendor promotes as one unit;
 *   - anything unresolvable is an error *before* anything is written.
 */
import { describe, expect, it } from 'vitest';
import {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  buildEncounterPackage,
  planImport,
  stableJson,
  toPackagedEncounter,
  vendorKeysReferencedBy,
  type ImportTargetState,
  type PackagedEncounter,
  type PackagedVendor,
} from '../../../src/modules/worldEncounters/encounterPackage';
import type { LoadedEncounter } from '../../../src/modules/worldEncounters/types';
import type { WorldEncounterVendorRow } from '../../../src/db/schema';

/** A fully-populated loaded encounter, including fields that must NOT travel. */
function loaded(overrides: Partial<LoadedEncounter> = {}): LoadedEncounter {
  return {
    id: 4242,
    slug: 'tv_bandit_ambush',
    name: 'Bandit Ambush',
    description: 'Rough company on the road.',
    type: 'combat',
    rarity: 'uncommon',
    weight: 10,
    lifecycle: 'active',
    huntEligible: false,
    travelEligible: true,
    cooldownSeconds: 1800,
    artworkPath: 'encounters/bandit.png',
    chainedEncounterSlug: null,
    choicesRequired: true,
    regions: [],
    routes: [],
    choices: [
      {
        id: 9001,
        sortOrder: 0,
        label: 'Fight',
        emoji: '⚔️',
        requirements: {},
        check: { type: 'sp', difficulty: 40 },
        successEffects: [{ type: 'waifubux_gain', amount: 50 }],
        failureEffects: [{ type: 'essence_loss', amount: 10 }],
      },
    ],
    metadata: {},
    ...overrides,
  };
}

function vendorRow(overrides: Partial<WorldEncounterVendorRow> = {}): WorldEncounterVendorRow {
  return {
    id: 77,
    vendorKey: 'wandering_merchant',
    name: 'The Wandering Merchant',
    description: 'Curiosities for travellers.',
    stockTemplateJson: [
      { itemSlug: 'basic_charm', quantity: 3, price: 150, currency: 'waifubux' },
    ],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  } as WorldEncounterVendorRow;
}

function target(overrides: Partial<ImportTargetState> = {}): ImportTargetState {
  return {
    existingEncounters: new Map(),
    existingVendors: new Map(),
    itemSlugs: new Set(['basic_charm', 'silk_charm']),
    speciesSlugs: new Set(['alley_catgirl']),
    ...overrides,
  };
}

function pkgOf(encounters: LoadedEncounter[], vendors: WorldEncounterVendorRow[] = []) {
  return buildEncounterPackage({
    encounters,
    vendors,
    exportedAt: new Date('2026-09-05T00:00:00Z'),
  });
}

/* ─────────────────────── Export shape ─────────────────────── */

describe('what a package carries', () => {
  it('has the versioned envelope', () => {
    const pkg = pkgOf([loaded()]);

    expect(pkg.format).toBe(PACKAGE_FORMAT);
    expect(pkg.version).toBe(PACKAGE_VERSION);
    expect(pkg.exportedAt).toBe('2026-09-05T00:00:00.000Z');
    expect(pkg.encounters).toHaveLength(1);
  });

  it('carries every authored field needed to recreate the encounter', () => {
    const [entry] = pkgOf([loaded()]).encounters;

    expect(entry).toMatchObject({
      slug: 'tv_bandit_ambush',
      name: 'Bandit Ambush',
      description: 'Rough company on the road.',
      type: 'combat',
      rarity: 'uncommon',
      weight: 10,
      lifecycle: 'active',
      huntEligible: false,
      travelEligible: true,
      cooldownSeconds: 1800,
      artworkPath: 'encounters/bandit.png',
      chainedEncounterSlug: null,
      choicesRequired: true,
    });
    expect(entry!.choices[0]).toMatchObject({
      label: 'Fight',
      emoji: '⚔️',
      check: { type: 'sp', difficulty: 40 },
      successEffects: [{ type: 'waifubux_gain', amount: 50 }],
      failureEffects: [{ type: 'essence_loss', amount: 10 }],
    });
  });

  it('contains no database ids at any depth', () => {
    // The strongest statement of the rule: the encounter row id (4242) and the
    // choice row id (9001) both exist on the source object and must not be
    // anywhere in the serialised package.
    const json = JSON.stringify(pkgOf([loaded()], [vendorRow()]));

    expect(json).not.toContain('4242');
    expect(json).not.toContain('9001');
    expect(json).not.toContain('"id"');
    expect(json).not.toContain('sortOrder');
  });

  it('carries no runtime state or local timestamps', () => {
    const json = JSON.stringify(pkgOf([loaded()], [vendorRow()]));

    for (const forbidden of [
      'activeEncounterId',
      'playerId',
      'active_world_encounters',
      'history',
      'cooldownExpiresAt',
      'remaining',
      'createdAt',
      'updatedAt',
      'startedAt',
      'resolvedAt',
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('exports a vendor’s authored template, not an instantiated one', () => {
    const encounter = loaded({
      choices: [
        {
          id: 1,
          sortOrder: 0,
          label: 'Shop',
          emoji: null,
          requirements: {},
          check: { type: 'none' },
          successEffects: [{ type: 'open_vendor', vendorKey: 'wandering_merchant' }],
          failureEffects: [],
        },
      ],
    });
    const pkg = pkgOf([encounter], [vendorRow()]);

    expect(pkg.vendors).toHaveLength(1);
    expect(pkg.vendors[0]).toMatchObject({
      vendorKey: 'wandering_merchant',
      name: 'The Wandering Merchant',
      stockTemplate: [
        { itemSlug: 'basic_charm', quantity: 3, price: 150, currency: 'waifubux' },
      ],
    });
    // `remaining` is instance state and never appears on a template.
    expect(JSON.stringify(pkg.vendors)).not.toContain('remaining');
  });

  it('includes only the vendors its encounters actually reference', () => {
    const unrelated = vendorRow({ id: 78, vendorKey: 'other_merchant' });
    const pkg = pkgOf([loaded()], [vendorRow(), unrelated]);

    // The encounter opens no vendor, so neither travels.
    expect(pkg.vendors).toEqual([]);
    expect(vendorKeysReferencedBy(pkg.encounters).size).toBe(0);
  });

  it('is deterministic — two exports of the same content are identical', () => {
    const a = pkgOf([loaded({ slug: 'b_second' }), loaded({ slug: 'a_first' })]);
    const b = pkgOf([loaded({ slug: 'a_first' }), loaded({ slug: 'b_second' })]);

    expect(stableJson(a)).toEqual(stableJson(b));
    expect(a.encounters.map((e) => e.slug)).toEqual(['a_first', 'b_second']);
  });
});

/* ─────────────────────── Round trip ─────────────────────── */

describe('round trip', () => {
  it('an exported encounter re-projects to itself', () => {
    // The property import relies on: what comes out of a package is what
    // `toPackagedEncounter` would produce from the row it creates.
    const source = loaded();
    const [packaged] = pkgOf([source]).encounters;

    expect(stableJson(packaged)).toEqual(stableJson(toPackagedEncounter(source)));
  });

  it('plans as unchanged when re-imported into the environment it came from', () => {
    const source = loaded();
    const pkg = pkgOf([source]);

    const plan = planImport(
      pkg,
      target({ existingEncounters: new Map([[source.slug, source]]) }),
    );

    expect(plan.ok).toBe(true);
    expect(plan.counts).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });
});

/* ─────────────────────── Planning ─────────────────────── */

describe('the planner classifies each record', () => {
  it('reports a new encounter as create', () => {
    const plan = planImport(pkgOf([loaded()]), target());

    expect(plan.ok).toBe(true);
    expect(plan.encounters[0]).toMatchObject({ slug: 'tv_bandit_ambush', status: 'create' });
    expect(plan.counts.created).toBe(1);
  });

  it('reports a changed encounter as update', () => {
    const existing = loaded({ name: 'Old Name' });
    const plan = planImport(
      pkgOf([loaded({ name: 'New Name' })]),
      target({ existingEncounters: new Map([[existing.slug, existing]]) }),
    );

    expect(plan.encounters[0]!.status).toBe('update');
    expect(plan.counts).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
  });

  it('does not propose deleting encounters absent from the package', () => {
    // A package is a statement about what it contains, never about what the
    // server should stop having.
    const keeper = loaded({ slug: 'hn_untouched' });
    const plan = planImport(
      pkgOf([loaded()]),
      target({ existingEncounters: new Map([[keeper.slug, keeper]]) }),
    );

    expect(plan.encounters.map((e) => e.slug)).toEqual(['tv_bandit_ambush']);
    expect(JSON.stringify(plan)).not.toContain('hn_untouched');
  });
});

describe('the planner refuses a package it cannot trust', () => {
  it('rejects an unsupported version, and says so plainly', () => {
    const plan = planImport(
      { ...pkgOf([loaded()]), version: 99 },
      target(),
    );

    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain('unsupported_version');
    // Reported as one clear cause, not as a pile of schema errors.
    expect(plan.issues).toHaveLength(1);
  });

  it('rejects a file that is not a package at all', () => {
    expect(planImport({ hello: 'world' }, target()).issues.map((i) => i.code)).toContain(
      'wrong_format',
    );
    expect(planImport('nonsense', target()).ok).toBe(false);
    expect(planImport(null, target()).ok).toBe(false);
  });

  it('rejects a duplicate slug rather than letting the last one win', () => {
    const pkg = { ...pkgOf([loaded()]), encounters: [
      toPackagedEncounter(loaded()),
      toPackagedEncounter(loaded({ name: 'Second' })),
    ] };

    const plan = planImport(pkg, target());

    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain('duplicate_slug');
  });

  it('rejects a duplicate vendor key', () => {
    const v: PackagedVendor = {
      vendorKey: 'wandering_merchant',
      name: 'A',
      description: '',
      stockTemplate: [],
    };
    const plan = planImport({ ...pkgOf([loaded()]), vendors: [v, { ...v, name: 'B' }] }, target());

    expect(plan.issues.map((i) => i.code)).toContain('duplicate_vendor_key');
  });

  it('reports field validation errors from the shared schema', () => {
    const bad = { ...toPackagedEncounter(loaded()), weight: -5, rarity: 'legendary' };
    const plan = planImport({ ...pkgOf([loaded()]), encounters: [bad] }, target());

    expect(plan.ok).toBe(false);
    expect(plan.issues.every((i) => i.severity === 'error')).toBe(true);
    expect(plan.issues.map((i) => i.code)).toContain('schema');
  });
});

describe('dependency resolution', () => {
  function withEffect(slug: string, effect: unknown): LoadedEncounter {
    return loaded({
      slug,
      choices: [
        {
          id: 1,
          sortOrder: 0,
          label: 'Go',
          emoji: null,
          requirements: {},
          check: { type: 'none' },
          successEffects: [effect as never],
          failureEffects: [],
        },
      ],
    });
  }

  it('fails when a chained encounter exists nowhere', () => {
    const plan = planImport(
      pkgOf([loaded({ chainedEncounterSlug: 'tv_bandit_aftermath' })]),
      target(),
    );

    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain('missing_chained_encounter');
  });

  it('resolves a chained encounter carried by the same package', () => {
    // The case the whole feature exists for: a chain promotes as one unit,
    // even though neither half is on the target yet.
    const parent = loaded({ slug: 'tv_bandit_ambush', chainedEncounterSlug: 'tv_aftermath' });
    const child = loaded({
      slug: 'tv_aftermath',
      huntEligible: false,
      travelEligible: false,
    });

    const plan = planImport(pkgOf([parent, child]), target());

    expect(plan.ok).toBe(true);
    expect(plan.counts.created).toBe(2);
  });

  it('resolves a chained encounter already on the target', () => {
    const existing = loaded({ slug: 'tv_aftermath' });
    const plan = planImport(
      pkgOf([loaded({ chainedEncounterSlug: 'tv_aftermath' })]),
      target({ existingEncounters: new Map([['tv_aftermath', existing]]) }),
    );

    expect(plan.ok).toBe(true);
  });

  it('resolves a trigger_encounter reference the same way', () => {
    const parent = withEffect('a_parent', { type: 'trigger_encounter', encounterSlug: 'a_child' });
    const child = loaded({ slug: 'a_child', huntEligible: false, travelEligible: false });

    expect(planImport(pkgOf([parent, child]), target()).ok).toBe(true);
    expect(planImport(pkgOf([parent]), target()).issues.map((i) => i.code)).toContain(
      'missing_chained_encounter',
    );
  });

  it('rejects an encounter that chains into itself', () => {
    const plan = planImport(pkgOf([loaded({ chainedEncounterSlug: 'tv_bandit_ambush' })]), target());

    expect(plan.issues.map((i) => i.code)).toContain('chain_self_reference');
  });

  it('resolves a vendor carried by the package, and fails without one', () => {
    const shop = withEffect('a_shop', { type: 'open_vendor', vendorKey: 'wandering_merchant' });

    expect(planImport(pkgOf([shop], [vendorRow()]), target()).ok).toBe(true);
    // Same encounter, vendor stripped from the package and absent on target.
    const without = { ...pkgOf([shop], [vendorRow()]), vendors: [] };
    expect(planImport(without, target()).issues.map((i) => i.code)).toContain('missing_vendor');
  });

  it('resolves a vendor already defined on the target', () => {
    const shop = withEffect('a_shop', { type: 'open_vendor', vendorKey: 'wandering_merchant' });
    const without = { ...pkgOf([shop], [vendorRow()]), vendors: [] };

    const plan = planImport(
      without,
      target({
        existingVendors: new Map([
          ['wandering_merchant', { vendorKey: 'wandering_merchant', name: 'x', description: '', stockTemplate: [] }],
        ]),
      }),
    );

    expect(plan.ok).toBe(true);
  });

  it('validates items, species and requirement items against the target', () => {
    const badItem = withEffect('a_item', { type: 'give_item', slug: 'nonexistent', quantity: 1 });
    expect(planImport(pkgOf([badItem]), target()).issues.map((i) => i.code)).toContain(
      'missing_item',
    );

    const badSpecies = withEffect('a_species', {
      type: 'trigger_waifumon_encounter',
      speciesSlug: 'nonexistent',
    });
    expect(planImport(pkgOf([badSpecies]), target()).issues.map((i) => i.code)).toContain(
      'missing_species',
    );

    // No species named = roll from the region pool, always valid.
    const anySpecies = withEffect('a_any', { type: 'trigger_waifumon_encounter' });
    expect(planImport(pkgOf([anySpecies]), target()).ok).toBe(true);
  });

  it('validates a vendor’s own stocked items', () => {
    const shop = withEffect('a_shop', { type: 'open_vendor', vendorKey: 'wandering_merchant' });
    const badStock = vendorRow({
      stockTemplateJson: [
        { itemSlug: 'not_an_item', quantity: 1, price: 10, currency: 'waifubux' },
      ],
    });

    const plan = planImport(pkgOf([shop], [badStock]), target());

    expect(plan.ok).toBe(false);
    expect(plan.issues.map((i) => i.code)).toContain('missing_item');
  });
});

describe('artwork', () => {
  it('warns, but does not fail, when the image is not deployed yet', () => {
    // Content and assets deploy on separate schedules; an encounter with a
    // missing image renders text-only rather than breaking.
    const plan = planImport(
      pkgOf([loaded({ artworkPath: 'encounters/not_yet.png' })]),
      target({ artworkExists: () => false }),
    );

    expect(plan.ok).toBe(true);
    const artwork = plan.issues.find((i) => i.code === 'missing_artwork');
    expect(artwork?.severity).toBe('warning');
    expect(plan.counts.warnings).toBeGreaterThan(0);
  });

  it('does not warn when the image is there', () => {
    const plan = planImport(pkgOf([loaded()]), target({ artworkExists: () => true }));

    expect(plan.issues.map((i) => i.code)).not.toContain('missing_artwork');
  });

  it('rejects a traversing path outright', () => {
    // Schema-level too, but stated here because it is a *security* property
    // rather than a content one.
    const bad = { ...toPackagedEncounter(loaded()), artworkPath: '../../etc/passwd' };
    const plan = planImport({ ...pkgOf([loaded()]), encounters: [bad] }, target());

    expect(plan.ok).toBe(false);
  });
});
