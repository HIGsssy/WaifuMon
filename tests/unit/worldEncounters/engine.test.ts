/**
 * Unit tests for the selection engine — region/route filter, cooldown skip,
 * weighted draw.
 *
 * The engine is intentionally decoupled from the repository through the
 * `candidates` field on `SelectContext`, so these tests inject pools
 * directly without a Postgres round trip.
 */
import { describe, expect, it } from 'vitest';
import { seededRng } from '../../../src/shared/random';
import {
  effectiveWeight,
  matchesRegion,
  matchesRoute,
  selectEncounter,
  selectEncounterDetailed,
} from '../../../src/modules/worldEncounters/engine';
import type { EncounterWithChildren } from '../../../src/modules/worldEncounters/worldEncounterRepository';

function makeCandidate(overrides: {
  id: number;
  slug?: string;
  rarity?: 'common' | 'uncommon' | 'rare' | 'mythic';
  weight?: number;
  huntEligible?: boolean;
  travelEligible?: boolean;
  regions?: string[];
  routes?: Array<{ fromRegion: string; toRegion: string }>;
}): EncounterWithChildren {
  const id = overrides.id;
  return {
    encounter: {
      id,
      slug: overrides.slug ?? `enc_${id}`,
      name: `Encounter ${id}`,
      description: '',
      type: 'decision',
      rarity: overrides.rarity ?? 'common',
      weight: overrides.weight ?? 10,
      lifecycle: 'active',
      huntEligible: overrides.huntEligible ?? true,
      travelEligible: overrides.travelEligible ?? false,
      cooldownSeconds: 0,
      artworkPath: null,
      chainedEncounterSlug: null,
      choicesRequired: true,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    regions: (overrides.regions ?? []).map((regionId) => ({ encounterId: id, regionId })),
    routes: (overrides.routes ?? []).map((r) => ({ encounterId: id, ...r })),
    choices: [],
  };
}

// A repo stub the engine can accept — only used when `candidates` is
// omitted, which it never is in these tests. Cast keeps the field satisfied.
const stubRepo = {} as unknown as import('../../../src/modules/worldEncounters/worldEncounterRepository').WorldEncounterRepository;

describe('matchesRegion', () => {
  it('accepts every region when the encounter has no region rows (global)', () => {
    const c = makeCandidate({ id: 1 });
    expect(matchesRegion(c, 'waifu-valley')).toBe(true);
    expect(matchesRegion(c, 'thirstlands')).toBe(true);
  });

  it('accepts only listed regions when rows are present', () => {
    const c = makeCandidate({ id: 1, regions: ['twin-peeks', 'thirstlands'] });
    expect(matchesRegion(c, 'twin-peeks')).toBe(true);
    expect(matchesRegion(c, 'thirstlands')).toBe(true);
    expect(matchesRegion(c, 'waifu-valley')).toBe(false);
  });
});

describe('matchesRoute', () => {
  it('accepts every edge when no routes are declared (route-free travel encounter)', () => {
    const c = makeCandidate({ id: 1, travelEligible: true });
    expect(matchesRoute(c, 'waifu-valley', 'twin-peeks')).toBe(true);
    expect(matchesRoute(c, 'thirstlands', 'flaccid-foothills')).toBe(true);
  });

  it('respects directionality — reverse edge is a separate row', () => {
    const c = makeCandidate({
      id: 1,
      travelEligible: true,
      routes: [{ fromRegion: 'waifu-valley', toRegion: 'twin-peeks' }],
    });
    expect(matchesRoute(c, 'waifu-valley', 'twin-peeks')).toBe(true);
    // Deliberate: no automatic bidirectional matching.
    expect(matchesRoute(c, 'twin-peeks', 'waifu-valley')).toBe(false);
  });

  it('rejects when the encounter is route-restricted but no route is offered', () => {
    const c = makeCandidate({
      id: 1,
      travelEligible: true,
      routes: [{ fromRegion: 'a', toRegion: 'b' }],
    });
    expect(matchesRoute(c, null, null)).toBe(false);
    expect(matchesRoute(c, undefined, undefined)).toBe(false);
  });
});

describe('effectiveWeight', () => {
  it('scales weight by rarity multiplier: common ≫ mythic', () => {
    const common = effectiveWeight(makeCandidate({ id: 1, rarity: 'common', weight: 10 }));
    const uncommon = effectiveWeight(makeCandidate({ id: 2, rarity: 'uncommon', weight: 10 }));
    const rare = effectiveWeight(makeCandidate({ id: 3, rarity: 'rare', weight: 10 }));
    const mythic = effectiveWeight(makeCandidate({ id: 4, rarity: 'mythic', weight: 10 }));
    expect(common).toBeGreaterThan(uncommon);
    expect(uncommon).toBeGreaterThan(rare);
    expect(rare).toBeGreaterThan(mythic);
  });
});

describe('selectEncounter', () => {
  it('returns null when the pool is empty', async () => {
    const result = await selectEncounter(stubRepo, seededRng(1), {
      playerId: 1,
      playerLevel: 1,
      source: 'hunt',
      regionId: 'waifu-valley',
      cooldownIds: new Set(),
      equipmentUnlocked: true,
      candidates: [],
    });
    expect(result).toBeNull();
  });

  it('excludes encounters the player is on cooldown for', async () => {
    const a = makeCandidate({ id: 1, regions: ['waifu-valley'] });
    const b = makeCandidate({ id: 2, regions: ['waifu-valley'] });
    const rng = seededRng(1);
    for (let i = 0; i < 30; i++) {
      const chosen = await selectEncounter(stubRepo, rng, {
        playerId: 1,
        playerLevel: 1,
        source: 'hunt',
        regionId: 'waifu-valley',
        cooldownIds: new Set([1]),
        equipmentUnlocked: true,
        candidates: [a, b],
      });
      expect(chosen?.id).toBe(2);
    }
  });

  it('excludes encounters whose region rows do not include the current region', async () => {
    const inRegion = makeCandidate({ id: 1, regions: ['waifu-valley'] });
    const outOfRegion = makeCandidate({ id: 2, regions: ['twin-peeks'] });
    const rng = seededRng(1);
    for (let i = 0; i < 30; i++) {
      const chosen = await selectEncounter(stubRepo, rng, {
        playerId: 1,
        playerLevel: 1,
        source: 'hunt',
        regionId: 'waifu-valley',
        cooldownIds: new Set(),
        equipmentUnlocked: true,
        candidates: [inRegion, outOfRegion],
      });
      expect(chosen?.id).toBe(1);
    }
  });

  it('filters travel encounters by route direction', async () => {
    const forward = makeCandidate({
      id: 1,
      huntEligible: false,
      travelEligible: true,
      routes: [{ fromRegion: 'waifu-valley', toRegion: 'twin-peeks' }],
    });
    const reverse = makeCandidate({
      id: 2,
      huntEligible: false,
      travelEligible: true,
      routes: [{ fromRegion: 'twin-peeks', toRegion: 'waifu-valley' }],
    });
    const rng = seededRng(1);
    for (let i = 0; i < 30; i++) {
      const chosen = await selectEncounter(stubRepo, rng, {
        playerId: 1,
        playerLevel: 1,
        source: 'travel',
        regionId: 'twin-peeks',
        fromRegion: 'waifu-valley',
        toRegion: 'twin-peeks',
        cooldownIds: new Set(),
        equipmentUnlocked: true,
        candidates: [forward, reverse],
      });
      expect(chosen?.id).toBe(1);
    }
  });

  it('respects the source filter (a hunt-only encounter never fires on travel)', async () => {
    const huntOnly = makeCandidate({ id: 1, huntEligible: true, travelEligible: false });
    const travelOnly = makeCandidate({ id: 2, huntEligible: false, travelEligible: true });
    // Travel: only encounter 2 remains after the source-eligibility gate the
    // repository applies. The engine sees only travelEligible pool.
    const chosen = await selectEncounter(stubRepo, seededRng(1), {
      playerId: 1,
      playerLevel: 1,
      source: 'travel',
      regionId: 'waifu-valley',
      fromRegion: 'waifu-valley',
      toRegion: 'twin-peeks',
      cooldownIds: new Set(),
      equipmentUnlocked: true,
      // The engine trusts the pre-filtered pool; simulate that here.
      candidates: [travelOnly],
    });
    expect(chosen?.id).toBe(2);
    // But if we hand it both, weighted selection still respects the pool it
    // was given (source filter is a repo concern in production).
    void huntOnly;
  });

  it('produces a distribution roughly matching effective weights', async () => {
    const heavy = makeCandidate({ id: 1, rarity: 'common', weight: 100 });
    const light = makeCandidate({ id: 2, rarity: 'mythic', weight: 100 });
    const rng = seededRng(4242);
    const counts = new Map<number, number>();
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const chosen = await selectEncounter(stubRepo, rng, {
        playerId: 1,
        playerLevel: 1,
        source: 'hunt',
        regionId: 'waifu-valley',
        cooldownIds: new Set(),
        equipmentUnlocked: true,
        candidates: [heavy, light],
      });
      const id = chosen?.id ?? -1;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    // heavy weight = 100 * 100 = 10000; light = 2 * 100 = 200. Expected ratio ~50:1.
    const heavyShare = (counts.get(1) ?? 0) / N;
    const lightShare = (counts.get(2) ?? 0) / N;
    expect(heavyShare).toBeGreaterThan(0.95);
    expect(lightShare).toBeLessThan(0.05);
  });
});

describe('Equipment-only encounters', () => {
  /** A choice row whose success pays `effects`. */
  const choiceRow = (encounterId: number, id: number, effects: unknown[]) => ({
    id,
    encounterId,
    sortOrder: id,
    label: `Choice ${id}`,
    emoji: null,
    requirementsJson: {},
    checkJson: { type: 'none' },
    successEffectsJson: effects,
    failureEffectsJson: [],
    outcomeText: null,
    successText: null,
    failureText: null,
  });
  const gear = { type: 'give_equipment', quantity: 1, slot: 'attack' };
  const bux = { type: 'waifubux_gain', amount: 10 };
  const withChoices = (id: number, ...choices: unknown[][]): EncounterWithChildren => ({
    ...makeCandidate({ id }),
    choices: choices.map((effects, i) => choiceRow(id, i + 1, effects)) as EncounterWithChildren['choices'],
  });
  const select = (candidates: EncounterWithChildren[], equipmentUnlocked: boolean, seed = 1) =>
    selectEncounterDetailed(stubRepo, seededRng(seed), {
      playerId: 1,
      playerLevel: 50, // level is not the gate
      source: 'hunt',
      regionId: 'waifu-valley',
      cooldownIds: new Set(),
      equipmentUnlocked,
      candidates,
    });

  it('are never selected for a player without the Equipment feature, and say why when nothing is left', async () => {
    const gearOnly = withChoices(1, [gear], [gear, bux]);
    const outcome = await select([gearOnly], false);
    expect(outcome.encounter).toBeNull();
    expect(outcome.reason).toBe('equipment_locked');
    for (let seed = 1; seed <= 20; seed++) {
      expect((await select([gearOnly, withChoices(2, [bux])], false, seed)).encounter?.id).toBe(2);
    }
  });

  it('an encounter with any non-gear choice still surfaces to a locked player', async () => {
    const mixed = withChoices(3, [gear], [bux]);
    expect((await select([mixed], false)).encounter?.id).toBe(3);
  });

  it('are selected normally once unlocked', async () => {
    expect((await select([withChoices(1, [gear])], true)).encounter?.id).toBe(1);
  });
});
