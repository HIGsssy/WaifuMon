/**
 * Buddy Bonus content validation.
 *
 * The schema is the guardrail that makes "author a bonus, no code change"
 * safe: a bonus that would silently never fire has to fail the load instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BuddyBonusSchema,
  SpeciesContentSchema,
  SpeciesFileSchema,
} from '../../src/modules/content/schemas';

const CONTENT_DIR = path.join(process.cwd(), 'content');

/** A complete, valid species; individual cases override just the bonus. */
function speciesWith(buddyBonus: unknown): unknown {
  return {
    slug: 'test_subject',
    name: 'Test Subject',
    rarity: 'R',
    archetype: 'human',
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: 'waifumon/test_subject/standard.png',
    buddyBonus,
  };
}

const valid = {
  name: 'Test Bonus',
  flavorText: 'Test Bonus: +10% of something.',
  effectId: 'capture_chance',
  value: 10,
};

describe('valid bonuses', () => {
  it('accepts an untargeted capture bonus (no target = all species)', () => {
    expect(BuddyBonusSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts every target type each effect declares', () => {
    for (const type of ['race', 'affinity', 'rarity_min', 'rarity_max', 'ownership'] as const) {
      const value = {
        race: 'demon',
        affinity: 'primal',
        rarity_min: 'SSR',
        rarity_max: 'SR',
        ownership: 'owned',
      }[type];
      expect(
        BuddyBonusSchema.safeParse({ ...valid, target: { type, value } }).success,
      ).toBe(true);
    }
    expect(
      BuddyBonusSchema.safeParse({
        ...valid,
        effectId: 'encounter_weight',
        target: { type: 'rarity', value: 'SR' },
      }).success,
    ).toBe(true);
  });

  it('accepts a species that authors no bonus at all', () => {
    const parsed = SpeciesContentSchema.safeParse(speciesWith(undefined));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.buddyBonus).toBeUndefined();
  });
});

describe('invalid combinations fail validation', () => {
  const cases: Array<[string, unknown]> = [
    ['an unknown effectId', { ...valid, effectId: 'moon_gravity' }],
    [
      'care_energy_gain with a target',
      { ...valid, effectId: 'care_energy_gain', target: { type: 'race', value: 'demon' } },
    ],
    ['encounter_weight with no target', { ...valid, effectId: 'encounter_weight' }],
    [
      'capture_chance targeting an unsupported target type',
      { ...valid, target: { type: 'rarity', value: 'SR' } },
    ],
    ['an unknown target type', { ...valid, target: { type: 'zodiac', value: 'virgo' } }],
    ['a race outside the enum', { ...valid, target: { type: 'race', value: 'elf' } }],
    ['an affinity outside the enum', { ...valid, target: { type: 'affinity', value: 'bratty' } }],
    [
      'a rarity outside the enum',
      { ...valid, effectId: 'encounter_weight', target: { type: 'rarity', value: 'SSS' } },
    ],
    ['an ownership value outside the enum', { ...valid, target: { type: 'ownership', value: 'maybe' } }],
    ['a missing effectId', { name: 'X', flavorText: 'Y', value: 5 }],
    ['a missing value', { name: 'X', flavorText: 'Y', effectId: 'essence_gain' }],
    ['an unknown extra key', { ...valid, stacksWith: 'everything' }],
    ['an empty name', { ...valid, name: '   ' }],
  ];

  for (const [label, bonus] of cases) {
    it(`rejects ${label}`, () => {
      expect(BuddyBonusSchema.safeParse(bonus).success).toBe(false);
      // …and rejects it as part of a whole species file, which is how content
      // actually reaches the loader.
      expect(SpeciesFileSchema.safeParse([speciesWith(bonus)]).success).toBe(false);
    });
  }

  it('explains which target types the effect does support', () => {
    const parsed = BuddyBonusSchema.safeParse({ ...valid, target: { type: 'rarity', value: 'SR' } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain('rarity_min');
    }
  });
});

describe('the shipped corpus', () => {
  const files = [
    path.join(CONTENT_DIR, 'species', 'starter.json'),
    ...fs
      .readdirSync(path.join(CONTENT_DIR, 'expansions'))
      .flatMap((pack) => {
        const dir = path.join(CONTENT_DIR, 'expansions', pack, 'species');
        if (!fs.existsSync(dir)) return [];
        return fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => path.join(dir, f));
      }),
  ];

  it('validates, bonuses included', () => {
    let withBonus = 0;
    for (const file of files) {
      const parsed = SpeciesFileSchema.safeParse(
        JSON.parse(fs.readFileSync(file, 'utf8')) as unknown,
      );
      expect(parsed.success, `${file}: ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`).toBe(
        true,
      );
      if (parsed.success) withBonus += parsed.data.filter((s) => s.buddyBonus).length;
    }
    // Not an exact count — content grows. The assertion is that bonuses are
    // actually being parsed rather than silently dropped.
    expect(withBonus).toBeGreaterThan(0);
  });
});
