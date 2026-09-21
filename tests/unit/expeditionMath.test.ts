/**
 * Suitability maths. Pure — no DB, no clock.
 *
 * Each test isolates one term, because the whole point of the `factors` list
 * is that a chance can be explained. A test that only asserted the final
 * number would pass just as happily if two terms were wrong in opposite
 * directions.
 */
import { describe, expect, it } from 'vitest';
import {
  bandFor,
  evaluateSuitability,
  resolveAffinityFit,
  type SuitabilityCandidate,
} from '../../src/modules/expeditions/expeditionMath';
import {
  ExpeditionsConfigSchema,
  type ExpeditionsConfig,
} from '../../src/modules/content/schemas';
import { loadShippedContent } from '../helpers/fixtures';
import type { RaceCode } from '../../src/modules/cards/race';
import type { Affinity } from '../../src/db/schema';

const CONFIG: ExpeditionsConfig = ExpeditionsConfigSchema.parse({});
/**
 * The *shipped* affinity wheel, not a hand-built one — so these expectations
 * break if content ever retunes the wheel out from under the expedition read,
 * which is exactly the drift worth catching.
 */
const AFFINITY = loadShippedContent().tables.buddyAffinity;

function definition(over: Partial<Parameters<typeof evaluateSuitability>[0]['definition']> = {}) {
  return {
    baseSuccessChance: 0.4,
    recommendedLevel: 20,
    preferredAffinities: [] as Affinity[],
    preferredRaces: [] as RaceCode[],
    ...over,
  };
}

function waifu(over: Partial<SuitabilityCandidate> = {}): SuitabilityCandidate {
  return { level: 20, affinity: 'switch', race: 'human', ...over };
}

const evaluate = (
  defOver: Parameters<typeof definition>[0] = {},
  waifuOver: Partial<SuitabilityCandidate> = {},
  config: ExpeditionsConfig = CONFIG,
) =>
  evaluateSuitability({
    definition: definition(defOver),
    waifu: waifu(waifuOver),
    config,
    affinityConfig: AFFINITY,
  });

const factorIds = (r: ReturnType<typeof evaluate>) => r.factors.map((f) => f.id);
const deltaOf = (r: ReturnType<typeof evaluate>, id: string) =>
  r.factors.find((f) => f.id === id)?.delta;

describe('resolveAffinityFit', () => {
  it('is neutral when the mission prefers nothing', () => {
    expect(resolveAffinityFit('dominant', [], AFFINITY)).toBe('neutral');
  });

  it('is strong when her affinity is one the mission asked for', () => {
    expect(resolveAffinityFit('dominant', ['dominant'], AFFINITY)).toBe('strong');
  });

  // The wheel is dominant → submissive → caregiver → primal → dominant.
  it('is weak when a preferred affinity beats hers on the wheel', () => {
    expect(resolveAffinityFit('submissive', ['dominant'], AFFINITY)).toBe('weak');
  });

  it('is neutral when hers beats the preferred one — she is not what was asked for, but she is not outmatched', () => {
    expect(resolveAffinityFit('dominant', ['submissive'], AFFINITY)).toBe('neutral');
  });

  // `switch` is neutral on both sides of the wheel, which is what keeps it
  // from silently becoming the best or worst pick for every mission.
  it('is neutral for a switch copy whatever the mission prefers', () => {
    expect(resolveAffinityFit('switch', ['dominant'], AFFINITY)).toBe('neutral');
  });

  it('is neutral when the mission prefers switch', () => {
    expect(resolveAffinityFit('dominant', ['switch'], AFFINITY)).toBe('neutral');
  });

  // Being exactly what was asked for is not undone by also being beaten by a
  // second preference the mission listed.
  it('prefers strong over weak when both could apply', () => {
    expect(resolveAffinityFit('submissive', ['dominant', 'submissive'], AFFINITY)).toBe('strong');
  });
});

describe('individual factors', () => {
  it('starts from the mission base chance alone', () => {
    const result = evaluate();
    expect(deltaOf(result, 'base')).toBe(0.4);
    // Level 20 vs recommended 20 still earns the readiness bonus.
    expect(factorIds(result)).toEqual(['base', 'level_at_or_above']);
    expect(result.successChance).toBeCloseTo(0.5, 10);
  });

  it('adds the strong-affinity term', () => {
    const result = evaluate({ preferredAffinities: ['dominant'] }, { affinity: 'dominant' });
    expect(deltaOf(result, 'affinity_strong')).toBe(CONFIG.suitability.affinityStrong);
    expect(result.successChance).toBeCloseTo(0.7, 10);
  });

  it('subtracts the weak-affinity term', () => {
    const result = evaluate({ preferredAffinities: ['dominant'] }, { affinity: 'submissive' });
    expect(deltaOf(result, 'affinity_weak')).toBe(CONFIG.suitability.affinityWeak);
    expect(result.successChance).toBeCloseTo(0.35, 10);
  });

  it('adds the race term only on a match', () => {
    const matched = evaluate({ preferredRaces: ['demon'] }, { race: 'demon' });
    expect(deltaOf(matched, 'race_match')).toBe(CONFIG.suitability.raceMatch);
    const unmatched = evaluate({ preferredRaces: ['demon'] }, { race: 'angel' });
    expect(factorIds(unmatched)).not.toContain('race_match');
  });

  it('adds nothing for race when the mission prefers none', () => {
    expect(factorIds(evaluate({ preferredRaces: [] }, { race: 'demon' }))).not.toContain(
      'race_match',
    );
  });

  it('scales the under-level penalty per level', () => {
    const result = evaluate({ recommendedLevel: 20 }, { level: 15 });
    // 5 levels under x -0.02 = -0.10
    expect(deltaOf(result, 'level_below')).toBeCloseTo(-0.1, 10);
    expect(factorIds(result)).not.toContain('level_at_or_above');
    expect(result.successChance).toBeCloseTo(0.3, 10);
  });

  it('scales the over-level bonus per level', () => {
    const result = evaluate({ recommendedLevel: 20 }, { level: 25 });
    expect(deltaOf(result, 'level_above')).toBeCloseTo(0.05, 10);
  });

  // The cap is what stops over-levelling from replacing every other
  // consideration on an old mission.
  it('caps the over-level bonus', () => {
    const result = evaluate({ recommendedLevel: 1 }, { level: 80 });
    expect(deltaOf(result, 'level_above')).toBe(CONFIG.suitability.levelAboveCap);
  });

  it('applies the readiness bonus exactly at the recommended level, with no over-level term', () => {
    const result = evaluate({ recommendedLevel: 20 }, { level: 20 });
    expect(deltaOf(result, 'level_at_or_above')).toBe(CONFIG.suitability.levelAtOrAbove);
    expect(factorIds(result)).not.toContain('level_above');
  });
});

describe('clamping', () => {
  it('never reaches certainty, however well matched', () => {
    const result = evaluate(
      {
        baseSuccessChance: 0.9,
        recommendedLevel: 1,
        preferredAffinities: ['dominant'],
        preferredRaces: ['demon'],
      },
      { level: 80, affinity: 'dominant', race: 'demon' },
    );
    expect(result.successChance).toBe(CONFIG.suitability.maxChance);
    expect(factorIds(result)).toContain('clamped');
  });

  it('never reaches impossibility, however badly matched', () => {
    const result = evaluate(
      { baseSuccessChance: 0.1, recommendedLevel: 60, preferredAffinities: ['dominant'] },
      { level: 1, affinity: 'submissive' },
    );
    expect(result.successChance).toBe(CONFIG.suitability.minChance);
    expect(factorIds(result)).toContain('clamped');
  });

  it('records no clamp factor when nothing was clamped', () => {
    expect(factorIds(evaluate())).not.toContain('clamped');
  });
});

describe('bands', () => {
  it.each([
    [0.95, 'EXCELLENT'],
    [0.8, 'EXCELLENT'],
    [0.79, 'GOOD'],
    [0.65, 'GOOD'],
    [0.64, 'FAIR'],
    [0.5, 'FAIR'],
    [0.49, 'RISKY'],
    [0.35, 'RISKY'],
    [0.34, 'POOR'],
    [0.05, 'POOR'],
  ])('maps %s to %s', (chance, expected) => {
    expect(bandFor(chance, CONFIG)).toBe(expected);
  });

  // Each boundary is inclusive at the bottom of its own band, which is the
  // only reading that makes the four thresholds partition the range.
  it('treats every threshold as the floor of its own band', () => {
    expect(bandFor(CONFIG.bands.excellent, CONFIG)).toBe('EXCELLENT');
    expect(bandFor(CONFIG.bands.good, CONFIG)).toBe('GOOD');
    expect(bandFor(CONFIG.bands.fair, CONFIG)).toBe('FAIR');
    expect(bandFor(CONFIG.bands.risky, CONFIG)).toBe('RISKY');
  });
});

describe('exceptional chance', () => {
  it('is the base chance when the deployment added no margin', () => {
    // Level far under, so the clamp floors it below the mission base.
    const result = evaluate({ baseSuccessChance: 0.6, recommendedLevel: 90 }, { level: 1 });
    expect(result.successChance).toBeLessThan(0.6);
    expect(result.exceptionalChance).toBe(CONFIG.exceptional.baseChance);
  });

  // The margin — not the absolute chance — is what earns it, so a generous
  // mission does not hand out exceptional results for free.
  it('rises with the margin the deployment earned', () => {
    const plain = evaluate({ baseSuccessChance: 0.4 });
    const matched = evaluate(
      { baseSuccessChance: 0.4, preferredAffinities: ['dominant'] },
      { affinity: 'dominant' },
    );
    expect(matched.exceptionalChance).toBeGreaterThan(plain.exceptionalChance);
    // margin 0.3 x 0.25 + 0.05 = 0.125
    expect(matched.exceptionalChance).toBeCloseTo(0.125, 10);
  });

  it('is capped once the config lets the margin reach the ceiling', () => {
    const generous = ExpeditionsConfigSchema.parse({ exceptional: { perSuitabilityPoint: 1 } });
    const result = evaluate(
      {
        baseSuccessChance: 0.05,
        recommendedLevel: 1,
        preferredAffinities: ['dominant'],
        preferredRaces: ['demon'],
      },
      { level: 80, affinity: 'dominant', race: 'demon' },
      generous,
    );
    expect(result.exceptionalChance).toBe(generous.exceptional.maxChance);
  });

  /**
   * Under the *shipped* numbers the cap is a rail, not a target: the largest
   * margin any deployment can earn is `maxChance - baseSuccessChance` = 0.90,
   * which converts to 0.05 + 0.90 x 0.25 = 0.275 — below the 0.30 ceiling.
   *
   * Pinned deliberately. If a future retune makes the cap binding, that is a
   * real balance change and this test is where it gets noticed rather than
   * discovered from drop rates.
   */
  it('tops out below the shipped cap, which is therefore currently inert', () => {
    const best = evaluate(
      {
        baseSuccessChance: 0.05,
        recommendedLevel: 1,
        preferredAffinities: ['dominant'],
        preferredRaces: ['demon'],
      },
      { level: 999, affinity: 'dominant', race: 'demon' },
    );
    const ceiling =
      CONFIG.exceptional.baseChance +
      (CONFIG.suitability.maxChance - 0.05) * CONFIG.exceptional.perSuitabilityPoint;
    expect(ceiling).toBeCloseTo(0.275, 10);
    expect(ceiling).toBeLessThan(CONFIG.exceptional.maxChance);
    expect(best.exceptionalChance).toBeLessThanOrEqual(ceiling);
  });

  it('never goes negative', () => {
    const result = evaluate({ baseSuccessChance: 0.9, recommendedLevel: 99 }, { level: 1 });
    expect(result.exceptionalChance).toBeGreaterThanOrEqual(0);
  });
});

describe('content drives every constant', () => {
  // The design calls these values provisional. This asserts they are genuinely
  // tunable from content rather than baked into the module.
  it('follows a retuned config with no code change', () => {
    const retuned = ExpeditionsConfigSchema.parse({
      suitability: { affinityStrong: 0.5, minChance: 0.01, maxChance: 0.99 },
      bands: { excellent: 0.9, good: 0.7, fair: 0.4, risky: 0.2 },
    });
    const result = evaluate(
      { preferredAffinities: ['dominant'] },
      { affinity: 'dominant' },
      retuned,
    );
    expect(deltaOf(result, 'affinity_strong')).toBe(0.5);
    // 0.4 base + 0.5 affinity + 0.1 readiness = 1.0, clamped to 0.99
    expect(result.successChance).toBe(0.99);
    expect(result.band).toBe('EXCELLENT');
  });
});

describe('a table-driven matrix of affinity x race x level', () => {
  const cases: [Affinity, RaceCode, number, number][] = [
    // affinity, race, level, expected chance (base 0.4, prefers dominant+demon, rec 20)
    ['dominant', 'demon', 20, 0.8], // 0.4 +0.2 +0.1 +0.1
    ['dominant', 'human', 20, 0.7], // no race match
    ['submissive', 'demon', 20, 0.45], // 0.4 -0.15 +0.1 +0.1
    ['switch', 'human', 20, 0.5], // 0.4 +0.1
    ['dominant', 'demon', 10, 0.5], // 0.4 +0.2 +0.1 -0.2
    ['dominant', 'demon', 30, 0.9], // 0.4 +0.2 +0.1 +0.1 +0.1
  ];

  it.each(cases)('%s / %s / level %s → %s', (affinity, race, level, expected) => {
    const result = evaluate(
      { preferredAffinities: ['dominant'], preferredRaces: ['demon'], recommendedLevel: 20 },
      { affinity, race, level },
    );
    expect(result.successChance).toBeCloseTo(expected, 10);
  });
});
