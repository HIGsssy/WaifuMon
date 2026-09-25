/**
 * Match quality and candidate ordering. Pure — no DB, no clock.
 *
 * The regression this file exists for: playtesters saw EXCELLENT on copies
 * that met only some of what a mission asked for, because the label used to
 * be a success-chance threshold. Match quality grades fit against the stated
 * requirements, and the top label is reserved for meeting all of them.
 */
import { describe, expect, it } from 'vitest';
import {
  compareCandidates,
  evaluateMatch,
  parseStoredMatch,
  type RankableCandidate,
} from '../../src/modules/expeditions/expeditionMatch';
import {
  evaluateSuitability,
  type SuitabilityCandidate,
} from '../../src/modules/expeditions/expeditionMath';
import {
  ExpeditionsConfigSchema,
  MATCH_QUALITIES,
  type ExpeditionsConfig,
  type MatchQuality,
} from '../../src/modules/content/schemas';
import { loadShippedContent } from '../helpers/fixtures';
import type { RaceCode } from '../../src/modules/cards/race';
import type { Affinity } from '../../src/db/schema';

const CONFIG: ExpeditionsConfig = ExpeditionsConfigSchema.parse({});
const SHIPPED = loadShippedContent();
const AFFINITY = SHIPPED.tables.buddyAffinity;

type Def = {
  baseSuccessChance: number;
  recommendedLevel: number;
  preferredAffinities: Affinity[];
  preferredRaces: RaceCode[];
};

/** Prefers dominant + demon at level 20 unless told otherwise. */
function definition(over: Partial<Def> = {}): Def {
  return {
    baseSuccessChance: 0.5,
    recommendedLevel: 20,
    preferredAffinities: ['dominant'],
    preferredRaces: ['demon'],
    ...over,
  };
}

const match = (
  waifu: SuitabilityCandidate,
  defOver: Partial<Def> = {},
  config: ExpeditionsConfig = CONFIG,
) =>
  evaluateMatch({
    definition: definition(defOver),
    waifu,
    config,
    affinityConfig: AFFINITY,
  });

// The wheel is dominant → submissive → caregiver → primal → dominant, so
// against a dominant preference: `dominant` meets it, `submissive` is beaten
// by it (against), `caregiver` is neither (missed).
const W = (affinity: Affinity, race: RaceCode, level: number): SuitabilityCandidate => ({
  affinity,
  race,
  level,
});

describe('match quality', () => {
  it.each<[string, SuitabilityCandidate, MatchQuality]>([
    ['all three met', W('dominant', 'demon', 20), 'PERFECT_MATCH'],
    ['all three met, over-levelled', W('dominant', 'demon', 60), 'PERFECT_MATCH'],
    ['affinity + level, race missed', W('dominant', 'human', 20), 'STRONG_MATCH'],
    ['race + level, affinity missed', W('caregiver', 'demon', 20), 'STRONG_MATCH'],
    ['affinity + race, level just short', W('dominant', 'demon', 18), 'STRONG_MATCH'],
    ['affinity + race, badly under-levelled', W('dominant', 'demon', 10), 'WEAK_MATCH'],
    ['affinity, level just short, race missed', W('dominant', 'human', 18), 'PARTIAL_MATCH'],
    ['level only', W('caregiver', 'human', 20), 'WEAK_MATCH'],
    ['race + level, affinity works against', W('submissive', 'demon', 20), 'WEAK_MATCH'],
    ['level just short, nothing else', W('caregiver', 'human', 19), 'POOR_MATCH'],
    ['nothing met', W('caregiver', 'human', 5), 'POOR_MATCH'],
    ['affinity works against, level met', W('submissive', 'human', 20), 'POOR_MATCH'],
  ])('%s → %s', (_label, waifu, expected) => {
    expect(match(waifu).quality).toBe(expected);
  });

  // The playtest complaint, stated as an invariant over every combination.
  it('never gives the top label to a copy that misses any stated requirement', () => {
    const affinities: Affinity[] = ['dominant', 'submissive', 'caregiver', 'primal', 'switch'];
    const races: RaceCode[] = ['demon', 'human'];
    for (const affinity of affinities) {
      for (const race of races) {
        for (const level of [5, 17, 19, 20, 40]) {
          const m = match(W(affinity, race, level));
          const allMet = m.affinity === 'met' && m.race === 'met' && m.level === 'met';
          expect(m.quality === 'PERFECT_MATCH').toBe(allMet);
        }
      }
    }
  });

  it('reports a verdict per axis', () => {
    expect(match(W('submissive', 'human', 18))).toMatchObject({
      affinity: 'against',
      race: 'missed',
      level: 'near',
    });
    expect(match(W('dominant', 'demon', 10)).level).toBe('against');
  });

  it('skips axes the mission states no preference on', () => {
    const noPrefs = { preferredAffinities: [], preferredRaces: [] };
    const ready = match(W('caregiver', 'human', 20), noPrefs);
    expect(ready).toMatchObject({ affinity: 'none', race: 'none', quality: 'PERFECT_MATCH' });
    expect(match(W('caregiver', 'human', 18), noPrefs).quality).toBe('PARTIAL_MATCH');
    expect(match(W('caregiver', 'human', 5), noPrefs).quality).toBe('POOR_MATCH');
  });

  it('grades a two-requirement mission over two, not three', () => {
    const affinityOnly = { preferredRaces: [] };
    expect(match(W('dominant', 'human', 20), affinityOnly).quality).toBe('PERFECT_MATCH');
    expect(match(W('caregiver', 'human', 20), affinityOnly).quality).toBe('PARTIAL_MATCH');
    expect(match(W('dominant', 'human', 18), affinityOnly).quality).toBe('STRONG_MATCH');
  });

  /**
   * The root cause of the old labels: they read the success chance, and an
   * easy mission's base chance alone pushed nearly anyone to the top band.
   */
  it('ignores the mission base chance entirely', () => {
    const waifu = W('caregiver', 'human', 20);
    const easy = match(waifu, { baseSuccessChance: 0.9 });
    const hard = match(waifu, { baseSuccessChance: 0.1 });
    expect(easy).toEqual(hard);
    // …while the hidden chance does move, as it should.
    const chance = (base: number) =>
      evaluateSuitability({
        definition: definition({ baseSuccessChance: base }),
        waifu,
        config: CONFIG,
        affinityConfig: AFFINITY,
      }).successChance;
    expect(chance(0.9)).toBeGreaterThan(chance(0.1));
    expect(easy.quality).toBe('WEAK_MATCH');
  });

  it('follows retuned thresholds from content', () => {
    const lenient = ExpeditionsConfigSchema.parse({
      match: { thresholds: { strong: 0.3, partial: 0.2, weak: 0.1 } },
    });
    expect(match(W('caregiver', 'human', 20), {}, lenient).quality).toBe('STRONG_MATCH');
    // PERFECT is a rule, not a threshold: no retune hands it to a partial fit.
    const generous = ExpeditionsConfigSchema.parse({
      match: { thresholds: { strong: 0.02, partial: 0.015, weak: 0.01 } },
    });
    expect(match(W('dominant', 'human', 20), {}, generous).quality).toBe('STRONG_MATCH');
  });

  it('rejects thresholds that do not strictly descend', () => {
    const result = ExpeditionsConfigSchema.safeParse({
      match: { thresholds: { strong: 0.4, partial: 0.5, weak: 0.3 } },
    });
    expect(result.success).toBe(false);
  });
});

describe('the shipped Stockroom Squeeze — the playtest case', () => {
  const corner = SHIPPED.expeditions.find((e) => e.key === 'valley_stockroom_squeeze')!;
  const evaluate = (waifu: SuitabilityCandidate) => {
    const input = {
      definition: corner,
      waifu,
      config: SHIPPED.tables.expeditions,
      affinityConfig: AFFINITY,
    };
    return { match: evaluateMatch(input), chance: evaluateSuitability(input).successChance };
  };

  it('no longer calls a two-of-three copy the best possible match', () => {
    // Caregiver, level-ready, wrong race: under the old bands this clamped to
    // the ceiling and read EXCELLENT.
    const { match: m, chance } = evaluate(W('caregiver', 'angel', 12));
    expect(chance).toBe(SHIPPED.tables.expeditions.suitability.maxChance);
    expect(m.quality).toBe('STRONG_MATCH');
  });

  it('calls a level-ready copy with nothing else going for her a weak match', () => {
    const { match: m, chance } = evaluate(W('switch', 'angel', 12));
    expect(chance).toBeGreaterThanOrEqual(0.8); // the old EXCELLENT threshold
    expect(m.quality).toBe('WEAK_MATCH');
  });
});

describe('parseStoredMatch', () => {
  it('reads every current token', () => {
    for (const q of MATCH_QUALITIES) expect(parseStoredMatch(q)).toBe(q);
  });

  // `POOR` existed in the old vocabulary too; the `_MATCH` suffix is what keeps
  // a legacy success band from being mistaken for a match quality.
  it.each(['EXCELLENT', 'GOOD', 'FAIR', 'RISKY', 'POOR', '', null, undefined])(
    'reads legacy or missing value %s as null',
    (value) => {
      expect(parseStoredMatch(value as string | null | undefined)).toBeNull();
    },
  );
});

describe('compareCandidates', () => {
  const c = (
    waifuId: number,
    quality: MatchQuality,
    successChance: number,
    level = 20,
    unavailable = false,
  ): RankableCandidate => ({
    waifuId,
    level,
    successChance,
    match: { quality },
    unavailableReasons: unavailable ? ['on_expedition'] : [],
  });
  const order = (list: RankableCandidate[]) => [...list].sort(compareCandidates).map((x) => x.waifuId);

  it('puts every available copy ahead of every unavailable one', () => {
    expect(order([c(1, 'PERFECT_MATCH', 0.95, 20, true), c(2, 'POOR_MATCH', 0.1)])).toEqual([2, 1]);
  });

  // A WEAK copy can out-roll a STRONG one (an easy mission clamps both), but
  // the list must never show a worse label above a better one.
  it('ranks by match quality before hidden chance', () => {
    expect(order([c(1, 'WEAK_MATCH', 0.95), c(2, 'STRONG_MATCH', 0.7)])).toEqual([2, 1]);
  });

  it('breaks a tie in quality on the hidden chance, then level, then id', () => {
    expect(
      order([
        c(5, 'STRONG_MATCH', 0.8, 20),
        c(4, 'STRONG_MATCH', 0.9, 20),
        c(3, 'STRONG_MATCH', 0.8, 30),
        c(2, 'STRONG_MATCH', 0.8, 20),
      ]),
    ).toEqual([4, 3, 2, 5]);
  });

  it('is total: the same set sorts the same way from any starting order', () => {
    const set = Array.from({ length: 40 }, (_, i) =>
      c(i + 1, MATCH_QUALITIES[i % 5]!, 0.5 + (i % 3) * 0.1, 10 + (i % 4), i % 11 === 0),
    );
    const forward = order(set);
    expect(order([...set].reverse())).toEqual(forward);
    expect(order([...set].sort((a, b) => (a.waifuId * 7919) % 41 - (b.waifuId * 7919) % 41))).toEqual(forward);
  });

  it('fills the first 25 slots with the best available copies', () => {
    // 30 poor copies listed before 5 perfect ones: the 25-cap must not drop them.
    const set = [
      ...Array.from({ length: 30 }, (_, i) => c(i + 1, 'POOR_MATCH', 0.3)),
      ...Array.from({ length: 5 }, (_, i) => c(100 + i, 'PERFECT_MATCH', 0.9)),
    ];
    expect(order(set).slice(0, 5)).toEqual([100, 101, 102, 103, 104]);
  });
});
