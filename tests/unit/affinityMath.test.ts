/**
 * Buddy Affinity pure math (Milestone 5D) — the wheel, the switch rule, the
 * rarity-scaled bonus, and the player-facing affinity read.
 */
import { describe, expect, it } from 'vitest';
import {
  affinityLabel,
  applyBuddyAffinityToCaptureChance,
  formatAffinityBonus,
  formatAffinityRead,
  getAffinityMatchup,
  getBuddyAffinityModifier,
  normalizeAffinity,
  resolveBuddyAffinity,
} from '../../src/modules/capture/affinityMath';
import { BuddyAffinityConfigSchema } from '../../src/modules/content/schemas';
import { AFFINITIES, type Affinity, type Rarity } from '../../src/db/schema';
import { loadShippedContent } from '../helpers/fixtures';

/** Mirrors the shipped tables.json block. */
const config = BuddyAffinityConfigSchema.parse({
  styles: ['dominant', 'submissive', 'caregiver', 'primal', 'switch'],
  wheel: {
    dominant: 'submissive',
    submissive: 'caregiver',
    caregiver: 'primal',
    primal: 'dominant',
  },
  neutralStyles: ['switch'],
  strongBonusByRarity: { N: 0.01, R: 0.02, SR: 0.03, SSR: 0.04, UR: 0.05, LR: 0.06, EX: 0.06 },
  weakPenaltyByRarity: { N: 0, R: 0, SR: 0, SSR: 0, UR: 0, LR: 0, EX: 0 },
});

const NON_NEUTRAL: Affinity[] = ['dominant', 'submissive', 'caregiver', 'primal'];

describe('affinity wheel', () => {
  it.each([
    ['dominant', 'submissive'],
    ['submissive', 'caregiver'],
    ['caregiver', 'primal'],
    ['primal', 'dominant'],
  ] as const)('%s beats %s', (buddy, encounter) => {
    expect(getAffinityMatchup(buddy, encounter, config)).toBe('strong');
    // …and the reverse pairing is exactly weak, never strong.
    expect(getAffinityMatchup(encounter, buddy, config)).toBe('weak');
  });

  it('a style against itself is neutral', () => {
    for (const a of NON_NEUTRAL) {
      expect(getAffinityMatchup(a, a, config)).toBe('neutral');
    }
  });

  it('non-adjacent pairings on the wheel are neutral', () => {
    // dominant ↔ caregiver and submissive ↔ primal are the two "across" pairs.
    expect(getAffinityMatchup('dominant', 'caregiver', config)).toBe('neutral');
    expect(getAffinityMatchup('caregiver', 'dominant', config)).toBe('neutral');
    expect(getAffinityMatchup('submissive', 'primal', config)).toBe('neutral');
    expect(getAffinityMatchup('primal', 'submissive', config)).toBe('neutral');
  });

  it('every ordered pair resolves to exactly one matchup', () => {
    for (const b of AFFINITIES) {
      for (const e of AFFINITIES) {
        expect(['strong', 'neutral', 'weak']).toContain(getAffinityMatchup(b, e, config));
      }
    }
  });
});

describe('switch is always neutral', () => {
  it('a switch buddy is neutral against every encounter affinity', () => {
    for (const e of AFFINITIES) {
      expect(getAffinityMatchup('switch', e, config)).toBe('neutral');
    }
  });

  it('a switch encounter is neutral against every buddy affinity', () => {
    for (const b of AFFINITIES) {
      expect(getAffinityMatchup(b, 'switch', config)).toBe('neutral');
    }
  });

  it('switch has no strengths and no weaknesses in the shipped wheel', () => {
    expect(config.wheel.switch).toBeUndefined();
    expect(Object.values(config.wheel)).not.toContain('switch');
  });

  it('stays neutral even if a wheel edge tries to give switch an advantage', () => {
    // The neutral short-circuit runs before the wheel lookup, so a bad edge
    // cannot create a strength for a neutral style.
    const rogue = {
      ...config,
      wheel: { ...config.wheel, switch: 'dominant' as Affinity },
    };
    expect(getAffinityMatchup('switch', 'dominant', rogue)).toBe('neutral');
    expect(getAffinityMatchup('dominant', 'switch', rogue)).toBe('neutral');
  });
});

describe('normalizeAffinity', () => {
  it('passes through known affinities', () => {
    for (const a of AFFINITIES) expect(normalizeAffinity(a)).toBe(a);
  });

  it('falls back to switch for missing / unknown values', () => {
    expect(normalizeAffinity(undefined)).toBe('switch');
    expect(normalizeAffinity(null)).toBe('switch');
    expect(normalizeAffinity('')).toBe('switch');
    expect(normalizeAffinity('brat')).toBe('switch');
    expect(normalizeAffinity(42)).toBe('switch');
  });

  it('an unknown affinity therefore never creates a matchup', () => {
    expect(getAffinityMatchup('brat', 'submissive', config)).toBe('neutral');
    expect(getAffinityMatchup('dominant', 'brat', config)).toBe('neutral');
  });
});

describe('getBuddyAffinityModifier', () => {
  it('strong bonuses match the configured per-rarity values', () => {
    const expected: Record<Rarity, number> = {
      N: 0.01,
      R: 0.02,
      SR: 0.03,
      SSR: 0.04,
      UR: 0.05,
      LR: 0.06,
      EX: 0.06,
    };
    for (const [rarity, bonus] of Object.entries(expected) as [Rarity, number][]) {
      expect(getBuddyAffinityModifier(rarity, 'strong', config)).toBeCloseTo(bonus, 10);
    }
  });

  it('neutral is always 0', () => {
    for (const r of Object.keys(config.strongBonusByRarity) as Rarity[]) {
      expect(getBuddyAffinityModifier(r, 'neutral', config)).toBe(0);
    }
  });

  it('weak applies 0 in this milestone (penalties ship as all-zero)', () => {
    for (const r of Object.keys(config.weakPenaltyByRarity) as Rarity[]) {
      expect(getBuddyAffinityModifier(r, 'weak', config)).toBe(0);
    }
  });

  it('a weak matchup still reports as weak even though it costs nothing', () => {
    const res = resolveBuddyAffinity(
      { buddyAffinity: 'dominant', buddyRarity: 'LR', encounterAffinity: 'primal' },
      config,
    );
    expect(res.matchup).toBe('weak');
    expect(res.modifier).toBe(0);
  });

  it('honors a non-zero weak penalty if one is ever configured', () => {
    const tuned = { ...config, weakPenaltyByRarity: { ...config.weakPenaltyByRarity, LR: 0.02 } };
    expect(getBuddyAffinityModifier('LR', 'weak', tuned)).toBeCloseTo(-0.02, 10);
  });
});

describe('bonus is keyed on the buddy rarity, not the encounter rarity', () => {
  it('an LR buddy beating an N encounter grants the LR bonus', () => {
    const res = resolveBuddyAffinity(
      { buddyAffinity: 'dominant', buddyRarity: 'LR', encounterAffinity: 'submissive' },
      config,
    );
    expect(res.matchup).toBe('strong');
    expect(res.modifier).toBeCloseTo(config.strongBonusByRarity.LR, 10);
    expect(res.modifier).not.toBeCloseTo(config.strongBonusByRarity.N, 10);
  });

  it('an N buddy beating an LR encounter grants only the N bonus', () => {
    const res = resolveBuddyAffinity(
      { buddyAffinity: 'primal', buddyRarity: 'N', encounterAffinity: 'dominant' },
      config,
    );
    expect(res.matchup).toBe('strong');
    expect(res.modifier).toBeCloseTo(config.strongBonusByRarity.N, 10);
  });
});

describe('applyBuddyAffinityToCaptureChance', () => {
  const bounds = { minChance: 0.02, maxChance: 0.95 };

  it('adds the modifier flatly after the charm multiplier', () => {
    // R base 0.35 × Silk 1.5 = 0.525, then +0.06 (LR buddy) = 0.585.
    expect(applyBuddyAffinityToCaptureChance(0.35 * 1.5, 0.06, bounds)).toBeCloseTo(0.585, 10);
  });

  it('still clamps to the ceiling', () => {
    expect(applyBuddyAffinityToCaptureChance(0.94, 0.06, bounds)).toBe(bounds.maxChance);
    expect(applyBuddyAffinityToCaptureChance(2, 0.06, bounds)).toBe(bounds.maxChance);
  });

  it('still clamps to the floor', () => {
    expect(applyBuddyAffinityToCaptureChance(0.001, 0, bounds)).toBe(bounds.minChance);
  });

  it('a zero modifier leaves the chance untouched', () => {
    expect(applyBuddyAffinityToCaptureChance(0.42, 0, bounds)).toBeCloseTo(0.42, 10);
  });
});

describe('affinity read copy', () => {
  const read = (buddy: Affinity, encounter: Affinity, rarity: Rarity = 'SSR') =>
    formatAffinityRead(
      resolveBuddyAffinity(
        { buddyAffinity: buddy, buddyRarity: rarity, encounterAffinity: encounter },
        config,
      ),
    );

  it('strong names both styles and the bonus', () => {
    expect(read('dominant', 'submissive')).toBe(
      'Affinity Read: Dominant beats Submissive. Buddy bonus: +4%.',
    );
  });

  it('a switch buddy explains itself', () => {
    expect(read('switch', 'dominant')).toBe(
      'Affinity Read: Your buddy is Switch, so this matchup stays neutral.',
    );
  });

  it('a switch encounter explains itself', () => {
    expect(read('dominant', 'switch')).toBe(
      'Affinity Read: This Waifumon is Switch, making the matchup neutral.',
    );
  });

  it('an ordinary neutral pairing reports no advantage', () => {
    expect(read('dominant', 'caregiver')).toBe(
      'Affinity Read: No clear advantage. Buddy bonus: +0%.',
    );
  });

  it('weak reports an unfavorable matchup and no bonus', () => {
    expect(read('dominant', 'primal')).toBe(
      'Affinity Read: This matchup is unfavorable. No buddy bonus.',
    );
  });
});

describe('formatting helpers', () => {
  it('formats whole and fractional percentages', () => {
    expect(formatAffinityBonus(0.04)).toBe('+4%');
    expect(formatAffinityBonus(0)).toBe('+0%');
    expect(formatAffinityBonus(0.015)).toBe('+1.5%');
    expect(formatAffinityBonus(-0.02)).toBe('-2%');
  });

  it('labels affinities in title case, defaulting unknown values to Switch', () => {
    expect(affinityLabel('dominant')).toBe('Dominant');
    expect(affinityLabel('switch')).toBe('Switch');
    expect(affinityLabel('nonsense')).toBe('Switch');
  });
});

describe('shipped buddyAffinity config', () => {
  const shipped = loadShippedContent().tables.buddyAffinity;

  it('ships the four-style wheel with switch neutral', () => {
    expect(shipped.wheel).toEqual({
      dominant: 'submissive',
      submissive: 'caregiver',
      caregiver: 'primal',
      primal: 'dominant',
    });
    expect(shipped.neutralStyles).toEqual(['switch']);
  });

  it('ships the documented rarity bonus ladder and zero penalties', () => {
    expect(shipped.strongBonusByRarity).toEqual({
      N: 0.01,
      R: 0.02,
      SR: 0.03,
      SSR: 0.04,
      UR: 0.05,
      LR: 0.06,
      EX: 0.06,
    });
    expect(Object.values(shipped.weakPenaltyByRarity).every((v) => v === 0)).toBe(true);
  });
});
