/**
 * The one definition of a valid equipment definition, shared by the seed,
 * package import and the future Portal editor. Invalid content fails loudly,
 * with every problem named by path.
 */
import { describe, expect, it } from 'vitest';
import {
  changedDefinitionFields,
  parseEquipmentDefinition,
  validateEquipmentDefinition,
} from '../../src/modules/equipment/definitionSchema';
import { EquipmentValidationError } from '../../src/shared/errors';

const valid = (over: Record<string, unknown> = {}) => ({
  key: 'spiked_combat_ring',
  name: 'Spiked Combat Ring',
  slot: 'attack',
  rarity: 'R',
  multiplierMinBp: 6_000,
  multiplierMaxBp: 8_000,
  multiplierStepBp: 500,
  ...over,
});

function issuesOf(raw: unknown): { path: string; message: string }[] {
  const result = validateEquipmentDefinition(raw);
  return result.ok ? [] : result.issues;
}

describe('EquipmentDefinitionInputSchema', () => {
  it('accepts a minimal definition and fills the defaults', () => {
    const def = parseEquipmentDefinition(valid());
    expect(def).toEqual({
      key: 'spiked_combat_ring',
      name: 'Spiked Combat Ring',
      description: '',
      slot: 'attack',
      rarity: 'R',
      multiplierMinBp: 6_000,
      multiplierMaxBp: 8_000,
      multiplierStepBp: 500,
      secondaryEffects: [],
      tags: [],
      regionId: null,
      artworkPath: null,
      enabled: true,
      shopRegions: [],
      buyPrice: null,
      priceCurrency: 'waifubux',
    });
  });

  it('accepts one of each slot', () => {
    expect(validateEquipmentDefinition(valid({ key: 'belt', slot: 'defense' })).ok).toBe(true);
    expect(
      validateEquipmentDefinition(
        valid({ key: 'corset', slot: 'health', multiplierMinBp: 28_000, multiplierMaxBp: 34_000, multiplierStepBp: 2_000 }),
      ).ok,
    ).toBe(true);
  });

  it.each(['Spiked_Ring', 'spiked-ring', 'spiked ring', '_ring', 'ring_', 'a'.repeat(65), ''])(
    'refuses the key %j',
    (key) => {
      expect(issuesOf(valid({ key })).some((i) => i.path === 'key')).toBe(true);
    },
  );

  it('refuses an unknown slot', () => {
    expect(issuesOf(valid({ slot: 'relic' })).some((i) => i.path === 'slot')).toBe(true);
  });

  it.each(['LR', 'EX', 'mythic'])('refuses rarity %s in V1', (rarity) => {
    expect(issuesOf(valid({ rarity })).some((i) => i.path === 'rarity')).toBe(true);
  });

  describe('multiplier range', () => {
    const paths = (over: Record<string, unknown>) => issuesOf(valid(over)).map((i) => i.path);

    it('accepts a valid min/max/step, and a single-value range', () => {
      expect(validateEquipmentDefinition(valid()).ok).toBe(true);
      expect(validateEquipmentDefinition(valid({ multiplierMinBp: 4_500, multiplierMaxBp: 4_500 })).ok).toBe(true);
    });

    it('requires all three fields — there is no default multiplier', () => {
      for (const field of ['multiplierMinBp', 'multiplierMaxBp', 'multiplierStepBp']) {
        expect(paths({ [field]: undefined })).toContain(field);
      }
    });

    it('refuses min > max', () => {
      expect(issuesOf(valid({ multiplierMinBp: 8_000, multiplierMaxBp: 6_000 }))).toContainEqual({
        path: 'multiplierMaxBp',
        message: 'must be at least multiplierMinBp (8000)',
      });
    });

    it.each([0, -500])('refuses a step of %d', (multiplierStepBp) => {
      expect(paths({ multiplierStepBp })).toContain('multiplierStepBp');
    });

    it.each([0, -1])('refuses a min of %d', (multiplierMinBp) => {
      expect(paths({ multiplierMinBp })).toContain('multiplierMinBp');
    });

    it('refuses a range the step does not divide', () => {
      expect(issuesOf(valid({ multiplierStepBp: 300 }))).toContainEqual({
        path: 'multiplierStepBp',
        message: 'must divide the range evenly (8000 - 6000 = 2000 is not a multiple of 300)',
      });
    });

    it('enforces the per-slot ceilings', () => {
      expect(validateEquipmentDefinition(valid({ multiplierMaxBp: 20_000 })).ok).toBe(true);
      expect(paths({ multiplierMaxBp: 20_500 })).toContain('multiplierMaxBp');
      const health = { slot: 'health', multiplierMinBp: 40_000, multiplierStepBp: 10_000 };
      expect(validateEquipmentDefinition(valid({ ...health, multiplierMaxBp: 80_000 })).ok).toBe(true);
      expect(paths({ ...health, multiplierMaxBp: 90_000 })).toContain('multiplierMaxBp');
    });

    it('refuses fractional basis points', () => {
      expect(paths({ multiplierMinBp: 6_000.5 })).toContain('multiplierMinBp');
      expect(paths({ multiplierStepBp: 0.5 })).toContain('multiplierStepBp');
    });

    it('has no field for another slot: the old per-stat fields are unknown', () => {
      expect(issuesOf(valid({ defenseBp: 100 }))[0]!.message).toMatch(/unknown field\(s\): defenseBp/);
    });
  });

  it('refuses secondary effects in V1', () => {
    const issues = issuesOf(valid({ secondaryEffects: [{ effectId: 'damage_bonus', value: 0.1 }] }));
    expect(issues).toContainEqual({
      path: 'secondaryEffects',
      message: 'secondary effects are not supported in V1',
    });
  });

  it('checks regions', () => {
    expect(validateEquipmentDefinition(valid({ regionId: 'base-80085' })).ok).toBe(true);
    expect(issuesOf(valid({ regionId: 'narnia' })).some((i) => i.path === 'regionId')).toBe(true);
    expect(issuesOf(valid({ shopRegions: ['narnia'] })).some((i) => i.path.startsWith('shopRegions'))).toBe(true);
  });

  it.each(['../secrets.png', 'equipment/../../x.png', '/etc/passwd', 'C:\\x.png', '\\x.png'])(
    'refuses the artwork path %j',
    (artworkPath) => {
      expect(issuesOf(valid({ artworkPath })).some((i) => i.path === 'artworkPath')).toBe(true);
    },
  );

  it('accepts a relative artwork path', () => {
    expect(validateEquipmentDefinition(valid({ artworkPath: 'equipment/spiked_ring.webp' })).ok).toBe(true);
  });

  it('requires a price for a shop listing', () => {
    expect(issuesOf(valid({ shopRegions: ['waifu-valley'] }))).toContainEqual({
      path: 'buyPrice',
      message: 'is required when shopRegions is not empty',
    });
    expect(validateEquipmentDefinition(valid({ shopRegions: ['waifu-valley'], buyPrice: 250 })).ok).toBe(true);
  });

  it('refuses duplicate tags and shop regions', () => {
    expect(issuesOf(valid({ tags: ['ring', 'ring'] })).some((i) => i.path === 'tags')).toBe(true);
    expect(
      issuesOf(valid({ shopRegions: ['waifu-valley', 'waifu-valley'], buyPrice: 1 })).some(
        (i) => i.path === 'shopRegions',
      ),
    ).toBe(true);
  });

  it('refuses a numeric id with a message that says why', () => {
    expect(issuesOf(valid({ id: 12 }))).toContainEqual({
      path: '',
      message: 'definitions are identified by key; numeric ids are not allowed',
    });
  });

  it('refuses unknown fields rather than dropping them', () => {
    expect(issuesOf(valid({ atkMultiplier: 0.8 }))[0]!.message).toMatch(/unknown field\(s\): atkMultiplier/);
  });

  it('prefixes issue paths for package entries', () => {
    const result = validateEquipmentDefinition(valid({ multiplierStepBp: 0 }), 'definitions[3]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.path).toBe('definitions[3].multiplierStepBp');
  });

  it('throws EquipmentValidationError carrying every issue', () => {
    try {
      parseEquipmentDefinition(valid({ key: 'Bad Key', rarity: 'EX' }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EquipmentValidationError);
      const paths = (err as EquipmentValidationError).issues.map((i) => i.path).sort();
      expect(paths).toEqual(['key', 'rarity']);
    }
  });
});

describe('changedDefinitionFields', () => {
  it('names exactly the fields that differ', () => {
    const a = parseEquipmentDefinition(valid());
    const b = parseEquipmentDefinition(valid({ name: 'Renamed', multiplierMaxBp: 9_000, tags: ['ring'] }));
    expect(changedDefinitionFields(a, b)).toEqual(['name', 'multiplierMaxBp', 'tags']);
    expect(changedDefinitionFields(a, a)).toEqual([]);
  });
});
