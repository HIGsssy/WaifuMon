/**
 * The pure core of filtered species selection: which species a selector
 * admits, and how one is drawn from the admitted set.
 *
 * The invariant everything else leans on: a draw never returns anything
 * outside the filtered candidate list, and an empty list returns null rather
 * than widening.
 */
import { describe, expect, it } from 'vitest';
import {
  matchesSpeciesFilter,
  pickFilteredCandidate,
  type SpeciesCandidate,
  type SpeciesFilter,
} from '../../../src/modules/encounters/speciesSelection';
import { seededRng } from '../../../src/shared/random';

const POOL = [
  { slug: 'n_demon_primal', rarity: 'N', race: 'demon', affinity: 'primal' },
  { slug: 'ur_demon_dominant', rarity: 'UR', race: 'demon', affinity: 'dominant' },
  { slug: 'ur_angel_primal', rarity: 'UR', race: 'angel', affinity: 'primal' },
  { slug: 'lr_spirit_primal', rarity: 'LR', race: 'spirit', affinity: 'primal' },
  { slug: 'lr_demon_caregiver', rarity: 'LR', race: 'demon', affinity: 'caregiver' },
  { slug: 'lr_human_dominant', rarity: 'LR', race: 'human', affinity: 'dominant' },
] as const;

function filter(fields: Partial<SpeciesFilter>): SpeciesFilter {
  return { poolScope: 'region', ...fields };
}

function admitted(f: SpeciesFilter): string[] {
  return POOL.filter((s) => matchesSpeciesFilter(s, f)).map((s) => s.slug);
}

function candidates(slugs?: readonly string[]): SpeciesCandidate<string>[] {
  return POOL.filter((s) => !slugs || slugs.includes(s.slug)).map((s) => ({
    value: s.slug,
    rarity: s.rarity,
    weight: 1,
  }));
}

describe('matchesSpeciesFilter', () => {
  it('admits everything when no dimension is constrained', () => {
    expect(admitted(filter({}))).toHaveLength(POOL.length);
  });

  it('rarities: ["LR"] admits only LR', () => {
    expect(admitted(filter({ rarities: ['LR'] }))).toEqual([
      'lr_spirit_primal',
      'lr_demon_caregiver',
      'lr_human_dominant',
    ]);
  });

  it('rarities: ["UR","LR"] admits only UR or LR', () => {
    const out = admitted(filter({ rarities: ['UR', 'LR'] }));
    expect(out).toHaveLength(5);
    expect(out).not.toContain('n_demon_primal');
  });

  it('race filter admits only matching races', () => {
    expect(admitted(filter({ races: ['demon'] }))).toEqual([
      'n_demon_primal',
      'ur_demon_dominant',
      'lr_demon_caregiver',
    ]);
  });

  it('affinity filter admits only matching affinities', () => {
    expect(admitted(filter({ affinities: ['primal'] }))).toEqual([
      'n_demon_primal',
      'ur_angel_primal',
      'lr_spirit_primal',
    ]);
  });

  it('values within one dimension are OR', () => {
    expect(admitted(filter({ races: ['demon', 'spirit'] }))).toEqual([
      'n_demon_primal',
      'ur_demon_dominant',
      'lr_spirit_primal',
      'lr_demon_caregiver',
    ]);
  });

  it('dimensions combine as AND', () => {
    // (UR or LR) and (demon or spirit) and (primal or dominant)
    expect(
      admitted(
        filter({
          rarities: ['UR', 'LR'],
          races: ['demon', 'spirit'],
          affinities: ['primal', 'dominant'],
        }),
      ),
    ).toEqual(['ur_demon_dominant', 'lr_spirit_primal']);
  });

  it('can admit nothing', () => {
    expect(admitted(filter({ rarities: ['EX'] }))).toEqual([]);
    expect(admitted(filter({ rarities: ['LR'], races: ['angel'] }))).toEqual([]);
  });
});

describe('pickFilteredCandidate', () => {
  const rng = () => seededRng(1234);

  it('returns null for an empty candidate set — never widens', () => {
    expect(pickFilteredCandidate([], new Map([['LR', 1]]), rng())).toBeNull();
  });

  it('never returns anything outside the candidate set', () => {
    const lrOnly = candidates(admitted(filter({ rarities: ['LR'] })));
    const r = rng();
    // Rarity weights that heavily favour rarities *not* in the set must not
    // leak them in: rarity is only ever drawn among the rarities present.
    const weights = new Map([
      ['N', 1000],
      ['UR', 100],
      ['LR', 1],
    ]);
    for (let i = 0; i < 500; i++) {
      const picked = pickFilteredCandidate(lrOnly, weights, r);
      expect(picked).toMatch(/^lr_/);
    }
  });

  it('keeps the rarity table ratio across a multi-rarity selector', () => {
    // Two UR and three LR candidates, UR weighted 3:1 over LR. The ratio is
    // per *rarity*, not per species, so UR should land ~75 % of the time.
    const set = candidates(admitted(filter({ rarities: ['UR', 'LR'] })));
    const r = rng();
    const weights = new Map([
      ['UR', 3],
      ['LR', 1],
    ]);
    let ur = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      if (pickFilteredCandidate(set, weights, r)!.startsWith('ur_')) ur++;
    }
    expect(ur / n).toBeGreaterThan(0.7);
    expect(ur / n).toBeLessThan(0.8);
  });

  it('weights eligible rarities equally when the table gives them nothing', () => {
    // A rarity the hunt table never rolls must still be reachable when it is
    // the only thing the author asked for.
    const set = candidates(['lr_spirit_primal']);
    expect(pickFilteredCandidate(set, new Map(), rng())).toBe('lr_spirit_primal');
    expect(pickFilteredCandidate(set, new Map([['LR', 0]]), rng())).toBe('lr_spirit_primal');
  });

  it('uses within-rarity weights inside the chosen rarity', () => {
    const set: SpeciesCandidate<string>[] = [
      { value: 'heavy', rarity: 'LR', weight: 9 },
      { value: 'light', rarity: 'LR', weight: 1 },
    ];
    const r = rng();
    let heavy = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (pickFilteredCandidate(set, new Map(), r) === 'heavy') heavy++;
    expect(heavy / n).toBeGreaterThan(0.85);
    expect(heavy / n).toBeLessThan(0.95);
  });
});
