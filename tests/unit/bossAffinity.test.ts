/**
 * Boss affinity advantage — the Stage 1 five-way cycle.
 *
 * Pinned separately from the capture wheel on purpose: the two tables disagree
 * about `switch` (neutral in capture, a full participant here), and a test that
 * shared a fixture between them would not catch one being wired into the other.
 */
import { describe, expect, it } from 'vitest';
import {
  BOSS_AFFINITY_VERSION,
  DEFAULT_BOSS_AFFINITY_CONFIG,
  DEFAULT_BOSS_AFFINITY_WHEEL,
  advantageLabelFor,
  bossAffinityBonus,
  bossAffinityMatchup,
  superiorAffinityAgainst,
} from '../../src/modules/bosses/bossAffinity';
import { AFFINITIES, type Affinity } from '../../src/db/schema';
import { loadShippedContent } from '../helpers/fixtures';

/** The specification's table, transcribed independently of the source. */
const SPEC_TABLE: ReadonlyArray<[Affinity, Affinity]> = [
  ['dominant', 'switch'],
  ['submissive', 'dominant'],
  ['caregiver', 'submissive'],
  ['primal', 'caregiver'],
  ['switch', 'primal'],
];

describe('boss affinity wheel', () => {
  it.each(SPEC_TABLE)('%s is beaten by %s', (boss, superior) => {
    expect(superiorAffinityAgainst(boss)).toBe(superior);
    expect(bossAffinityMatchup(superior, boss)).toBe('advantage');
    expect(bossAffinityBonus(superior, boss)).toBe(0.1);
  });

  it('is a single closed cycle over all five affinities', () => {
    // Walking the wheel from any start must visit every affinity once and
    // return home — that is what makes each affinity beat exactly one and lose
    // to exactly one.
    const seen: Affinity[] = [];
    let current: Affinity = 'dominant';
    for (let i = 0; i < AFFINITIES.length; i++) {
      seen.push(current);
      current = superiorAffinityAgainst(current);
    }
    expect(new Set(seen).size).toBe(AFFINITIES.length);
    expect(current).toBe('dominant');
  });

  it('gives no bonus to the inferior side — Stage 1 has no penalty either', () => {
    for (const [boss, superior] of SPEC_TABLE) {
      // The reverse pairing: the boss's own affinity against the one it beats.
      expect(bossAffinityMatchup(boss, superior)).toBe('neutral');
      expect(bossAffinityBonus(boss, superior)).toBe(0);
    }
  });

  it('is neutral for every pairing that is not the wheel edge', () => {
    let advantages = 0;
    for (const buddy of AFFINITIES) {
      for (const boss of AFFINITIES) {
        const matchup = bossAffinityMatchup(buddy, boss);
        if (matchup === 'advantage') advantages += 1;
        expect(bossAffinityBonus(buddy, boss)).toBe(matchup === 'advantage' ? 0.1 : 0);
      }
    }
    // Exactly one advantageous buddy per boss, across a 5×5 grid.
    expect(advantages).toBe(AFFINITIES.length);
  });

  it('is neutral for a style against itself', () => {
    for (const affinity of AFFINITIES) {
      expect(bossAffinityMatchup(affinity, affinity)).toBe('neutral');
    }
  });

  it('normalizes unknown affinities rather than throwing', () => {
    // Old rows and hand-edited content must degrade to the neutral style, not
    // crash a resolution an hour after anyone could have fixed it.
    expect(bossAffinityMatchup('archdemon', 'dominant')).toBe('advantage'); // → switch
    expect(bossAffinityBonus(null, 'primal')).toBe(0);
  });

  it('falls back to a self-edge for a wheel with a missing entry', () => {
    // A hand-edited wheel that drops a key must not hand the neutral style a
    // free bonus against that boss.
    const broken = { wheel: { dominant: 'switch' } as Record<string, Affinity>, advantageBonus: 0.1 };
    expect(superiorAffinityAgainst('primal', broken)).toBe('primal');
    expect(bossAffinityBonus('caregiver', 'primal', broken)).toBe(0);
  });

  it('honours a retuned advantage magnitude', () => {
    const retuned = { wheel: DEFAULT_BOSS_AFFINITY_WHEEL, advantageBonus: 0.25 };
    expect(bossAffinityBonus('switch', 'dominant', retuned)).toBe(0.25);
  });

  it('exposes the advantage for an announcement from the boss affinity alone', () => {
    expect(advantageLabelFor('caregiver')).toBe('submissive');
  });

  it('carries a version so a historical result records which rulebook applied', () => {
    expect(BOSS_AFFINITY_VERSION).toBe(1);
    expect(DEFAULT_BOSS_AFFINITY_CONFIG.advantageBonus).toBe(0.1);
  });
});

describe('shipped content agrees with the code table', () => {
  it('tables.json carries exactly the shipped wheel and bonus', () => {
    // The schema defaults to the code table, so a disagreement can only come
    // from content having been edited — which is legal, but must be visible.
    const { bossEncounters } = loadShippedContent().tables;
    expect(bossEncounters.affinityWheel).toEqual(DEFAULT_BOSS_AFFINITY_WHEEL);
    expect(bossEncounters.affinityAdvantageBonus).toBe(0.1);
  });

  it('every shipped boss affinity has a defined superior', () => {
    const content = loadShippedContent();
    for (const boss of content.bosses) {
      const superior = superiorAffinityAgainst(boss.affinity, {
        wheel: content.tables.bossEncounters.affinityWheel as Record<string, Affinity>,
        advantageBonus: content.tables.bossEncounters.affinityAdvantageBonus,
      });
      expect(superior).not.toBe(boss.affinity);
    }
  });
});
