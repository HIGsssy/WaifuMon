/**
 * Equipment instance generation — the pure rules behind every roll: which
 * multipliers a range admits, how one is chosen, which affix pool a definition
 * draws from and how an affix is chosen from it, what a fixed grant may
 * dictate, and how the result is named.
 */
import { describe, expect, it } from 'vitest';
import {
  EQUIPMENT_AFFIX_POOLS,
  affixPoolOf,
  buildAffixCatalogue,
  type EquipmentAffix,
} from '../../src/modules/equipment/affixCatalogue';
import {
  UNKNOWN_AFFIX_LABEL,
  equipmentDisplayName,
  isMultiplierInRange,
  multiplierRangeIssues,
  multiplierValues,
  rollEquipmentInstance,
  validateFixedRoll,
  type MultiplierRange,
} from '../../src/modules/equipment/equipmentRoll';
import { EquipmentAffixPoolEmptyError } from '../../src/shared/errors';
import { seededRng, type Rng } from '../../src/shared/random';

const RANGE = { multiplierMinBp: 4_000, multiplierMaxBp: 6_000, multiplierStepBp: 500 } as const;
const def = (slot: string, rarity: string, over: Partial<MultiplierRange> = {}) => ({
  key: `${slot}_${rarity.toLowerCase()}_thing`,
  slot,
  rarity,
  ...RANGE,
  ...(slot === 'health' ? { multiplierMinBp: 18_000, multiplierMaxBp: 26_000, multiplierStepBp: 2_000 } : {}),
  ...over,
});
const PIPE = def('attack', 'N');

/** Three enabled + one retired per pool, keyed `<slot>_<rarity>_<n>`. */
const LIST: EquipmentAffix[] = EQUIPMENT_AFFIX_POOLS.flatMap((pool) => {
  const [slot, rarity] = pool.split('.') as [string, string];
  const base = `${slot}_${rarity.toLowerCase()}`;
  return [
    ...[1, 2, 3].map((n) => ({ key: `${base}_${n}`, suffix: `of ${base} ${n}`, pool, enabled: true })),
    { key: `${base}_retired`, suffix: `of ${base} retired`, pool, enabled: false },
  ];
});
const AFFIXES = buildAffixCatalogue(LIST);

/** An RNG that answers `intInclusive` from a script, to pin exact picks. */
function scripted(...picks: number[]): Rng {
  let i = 0;
  return {
    next: () => 0,
    intInclusive(min, max) {
      const v = picks[i++ % picks.length]!;
      if (v < min || v > max) throw new Error(`scripted pick ${v} outside [${min}, ${max}]`);
      return v;
    },
  };
}

describe('multiplier ranges', () => {
  it('lists exactly the discrete values of a range', () => {
    expect(multiplierValues(RANGE)).toEqual([4_000, 4_500, 5_000, 5_500, 6_000]);
    expect(multiplierValues({ multiplierMinBp: 4_500, multiplierMaxBp: 4_500, multiplierStepBp: 100 })).toEqual([4_500]);
  });

  it('knows which values are in range', () => {
    for (const v of [4_000, 4_500, 6_000]) expect(isMultiplierInRange(RANGE, v)).toBe(true);
    for (const v of [3_500, 4_250, 6_500, 4_500.5, Number.NaN]) expect(isMultiplierInRange(RANGE, v)).toBe(false);
    expect(isMultiplierInRange(RANGE, '4500' as unknown as number)).toBe(false);
  });

  it('accepts a valid range and names each problem with an invalid one', () => {
    expect(multiplierRangeIssues('attack', RANGE)).toEqual([]);
    const paths = (r: Partial<MultiplierRange>, slot = 'attack') =>
      multiplierRangeIssues(slot, { ...RANGE, ...r }).map((i) => i.path);
    expect(paths({ multiplierMinBp: 0 })).toEqual(['multiplierMinBp']);
    expect(paths({ multiplierMinBp: 7_000 })).toEqual(['multiplierMaxBp']);
    expect(paths({ multiplierStepBp: 0 })).toEqual(['multiplierStepBp']);
    expect(paths({ multiplierStepBp: -500 })).toEqual(['multiplierStepBp']);
    expect(paths({ multiplierStepBp: 300 })).toEqual(['multiplierStepBp']);
    expect(paths({ multiplierMaxBp: 20_500 })).toEqual(['multiplierMaxBp']);
    expect(paths({ multiplierMinBp: 20_000, multiplierMaxBp: 80_000, multiplierStepBp: 10_000 }, 'health')).toEqual([]);
    expect(paths({ multiplierMinBp: 20_000, multiplierMaxBp: 90_000, multiplierStepBp: 10_000 }, 'health')).toEqual(['multiplierMaxBp']);
  });
});

describe('affixPoolOf', () => {
  it('derives slot.rarity', () => {
    expect(affixPoolOf({ slot: 'attack', rarity: 'R' })).toBe('attack.R');
    expect(affixPoolOf({ slot: 'health', rarity: 'SR' })).toBe('health.SR');
  });
});

describe('rollEquipmentInstance — multiplier', () => {
  it('only ever produces one of the range\'s discrete values, and reaches both ends', () => {
    const rng = seededRng(42);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const { rolledMultiplierBp } = rollEquipmentInstance(PIPE, { rng, affixes: AFFIXES });
      expect(multiplierValues(RANGE)).toContain(rolledMultiplierBp);
      seen.add(rolledMultiplierBp);
    }
    expect([...seen].sort()).toEqual(multiplierValues(RANGE));
  });

  it('maps an injected pick to exactly that step', () => {
    expect(rollEquipmentInstance(PIPE, { rng: scripted(0, 0), affixes: AFFIXES }).rolledMultiplierBp).toBe(4_000);
    expect(rollEquipmentInstance(PIPE, { rng: scripted(3, 0), affixes: AFFIXES }).rolledMultiplierBp).toBe(5_500);
    expect(rollEquipmentInstance(PIPE, { rng: scripted(4, 0), affixes: AFFIXES }).rolledMultiplierBp).toBe(6_000);
  });

  it('is deterministic for a seeded RNG', () => {
    const roll = (seed: number) => {
      const rng = seededRng(seed);
      return Array.from({ length: 10 }, () => rollEquipmentInstance(PIPE, { rng, affixes: AFFIXES }));
    };
    expect(roll(7)).toEqual(roll(7));
  });

  it('refuses to roll from an invalid range', () => {
    expect(() => rollEquipmentInstance({ ...PIPE, multiplierStepBp: 0 }, { rng: seededRng(1), affixes: AFFIXES })).toThrow(RangeError);
  });
});

describe('rollEquipmentInstance — affix pool', () => {
  it.each(EQUIPMENT_AFFIX_POOLS.map((pool) => pool.split('.') as [string, string]))(
    'a %s %s item draws only enabled affixes of its own pool',
    (slot, rarity) => {
      const rng = seededRng(11);
      const pool = `${slot}.${rarity}`;
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const { affixKey } = rollEquipmentInstance(def(slot, rarity), { rng, affixes: AFFIXES });
        expect(AFFIXES.get(affixKey!)?.pool).toBe(pool);
        seen.add(affixKey!);
      }
      const base = `${slot}_${rarity.toLowerCase()}`;
      // Every enabled entry is reachable, and the retired one never is.
      expect([...seen].sort()).toEqual([`${base}_1`, `${base}_2`, `${base}_3`]);
    },
  );

  it('picks uniformly by index from the pool, in catalogue order', () => {
    expect(rollEquipmentInstance(def('defense', 'R'), { rng: scripted(0, 2), affixes: AFFIXES }).affixKey).toBe('defense_r_3');
    expect(rollEquipmentInstance(def('defense', 'R'), { rng: scripted(0, 0), affixes: AFFIXES }).affixKey).toBe('defense_r_1');
  });

  it('chooses the affix independently of the multiplier', () => {
    // Top multiplier with the first affix; bottom multiplier with the last.
    expect(rollEquipmentInstance(PIPE, { rng: scripted(4, 0), affixes: AFFIXES })).toEqual({
      rolledMultiplierBp: 6_000,
      affixKey: 'attack_n_1',
      combatBonuses: [],
    });
    expect(rollEquipmentInstance(PIPE, { rng: scripted(0, 2), affixes: AFFIXES })).toEqual({
      rolledMultiplierBp: 4_000,
      affixKey: 'attack_n_3',
      combatBonuses: [],
    });
  });

  it('fails explicitly when the pool has no enabled affix — no fallback, no unaffixed item', () => {
    // attack.R exists but is entirely retired; attack.N and defense.R are full.
    const lopsided = buildAffixCatalogue([
      ...LIST.filter((a) => a.pool !== 'attack.R'),
      { key: 'only_retired', suffix: 'of Only Retired', pool: 'attack.R', enabled: false },
    ]);
    let err: unknown;
    try {
      rollEquipmentInstance(def('attack', 'R'), { rng: scripted(0, 0), affixes: lopsided });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EquipmentAffixPoolEmptyError);
    expect(err).toMatchObject({ pool: 'attack.R', definitionKey: 'attack_r_thing' });
    expect(String((err as Error).message)).toContain('no enabled affixes');
  });

  it('fails explicitly for a rarity that has no pool', () => {
    expect(() => rollEquipmentInstance(def('attack', 'SSR'), { rng: seededRng(1), affixes: AFFIXES })).toThrow(
      /attack\.SSR.*not a supported pool/,
    );
  });

  it('consumes no randomness when it refuses', () => {
    const calls: number[] = [];
    const counting: Rng = { next: () => 0, intInclusive: (min) => (calls.push(min), min) };
    expect(() => rollEquipmentInstance(def('attack', 'UR'), { rng: counting, affixes: AFFIXES })).toThrow();
    expect(calls).toEqual([]);
  });
});

describe('validateFixedRoll', () => {
  it('accepts an in-range value with no affix, a same-pool affix, or a retired same-pool affix', () => {
    expect(validateFixedRoll(PIPE, { rolledMultiplierBp: 4_500, affixKey: null }, AFFIXES)).toEqual([]);
    expect(validateFixedRoll(PIPE, { rolledMultiplierBp: 6_000, affixKey: 'attack_n_2' }, AFFIXES)).toEqual([]);
    // Deliberate restore of a retired affix: allowed for a fixed grant only.
    expect(validateFixedRoll(PIPE, { rolledMultiplierBp: 4_000, affixKey: 'attack_n_retired' }, AFFIXES)).toEqual([]);
  });

  it.each([
    ['another rarity', 'attack_r_1', 'attack.R'],
    ['another slot', 'defense_n_1', 'defense.N'],
    ['another slot and rarity', 'health_sr_1', 'health.SR'],
  ])('refuses an affix from %s', (_label, affixKey, pool) => {
    expect(validateFixedRoll(PIPE, { rolledMultiplierBp: 4_500, affixKey }, AFFIXES)).toEqual([
      { path: 'roll.affixKey', message: `affix "${affixKey}" belongs to pool ${pool}; this definition rolls from attack.N` },
    ]);
  });

  it('gives the caller no way to name a pool', () => {
    expect(validateFixedRoll(PIPE, { rolledMultiplierBp: 4_500, affixKey: 'attack_r_1', pool: 'attack.R' }, AFFIXES).map((i) => i.path)).toEqual([
      'roll',
      'roll.affixKey',
    ]);
  });

  it.each([
    ['below the range', 3_500],
    ['above the range', 6_500],
    ['off the step', 4_250],
    ['fractional', 4_500.5],
    ['a numeric string', '4500'],
    ['missing', undefined],
  ])('refuses a multiplier %s', (_label, rolledMultiplierBp) => {
    const issues = validateFixedRoll(PIPE, { rolledMultiplierBp, affixKey: null }, AFFIXES);
    expect(issues.map((i) => i.path)).toEqual(['roll.rolledMultiplierBp']);
  });

  it.each([['an uncatalogued key', 'of_doom'], ['a non-string', 7], ['a missing affix', undefined]])(
    'refuses %s as the affix',
    (_label, affixKey) => {
      const issues = validateFixedRoll(PIPE, { rolledMultiplierBp: 4_500, affixKey }, AFFIXES);
      expect(issues.map((i) => i.path)).toEqual(['roll.affixKey']);
    },
  );

  it('refuses smuggled extra properties and non-objects', () => {
    expect(validateFixedRoll(PIPE, { rolledMultiplierBp: 4_500, affixKey: null, bonusAtk: 500 }, AFFIXES)).toEqual([
      { path: 'roll', message: 'unknown field(s): bonusAtk' },
    ]);
    expect(validateFixedRoll(PIPE, null, AFFIXES).map((i) => i.path)).toEqual(['roll']);
    expect(validateFixedRoll(PIPE, [4_500], AFFIXES).map((i) => i.path)).toEqual(['roll']);
  });
});

describe('equipmentDisplayName', () => {
  it('appends the complete suffix, prepending nothing', () => {
    const catalogue = buildAffixCatalogue([
      { key: 'the_desperate_swings', suffix: 'of the Desperate Swings', pool: 'attack.N', enabled: true },
    ]);
    expect(equipmentDisplayName('Rusty Pipe', 'the_desperate_swings', catalogue)).toBe('Rusty Pipe of the Desperate Swings');
  });

  it('is the base name for an unaffixed copy', () => {
    expect(equipmentDisplayName('Rusty Pipe', null, AFFIXES)).toBe('Rusty Pipe');
  });

  it('still names a retired affix — owned copies keep their suffix', () => {
    expect(equipmentDisplayName('Rusty Pipe', 'attack_n_retired', AFFIXES)).toBe('Rusty Pipe of attack_n retired');
  });

  it('marks an affix the catalogue no longer knows visibly, and reports it', () => {
    const missed: string[] = [];
    const catalogue = buildAffixCatalogue(LIST, { onUnknownKey: (k) => missed.push(k) });
    expect(equipmentDisplayName('Rusty Pipe', 'deleted_affix', catalogue)).toBe(`Rusty Pipe ${UNKNOWN_AFFIX_LABEL}`);
    expect(UNKNOWN_AFFIX_LABEL).toBe('[Unknown Affix]');
    expect(missed).toEqual(['deleted_affix']);
    // A known key reports nothing.
    equipmentDisplayName('Rusty Pipe', 'attack_n_1', catalogue);
    expect(missed).toEqual(['deleted_affix']);
  });
});
