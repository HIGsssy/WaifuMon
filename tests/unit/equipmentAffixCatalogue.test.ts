/**
 * The affix catalogue: the shipped file, and the schema every version of it
 * must pass. Affixes are flavour only and belong to exactly one of nine pools,
 * so anything beyond a key, suffix, pool and enabled flag is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EQUIPMENT_AFFIX_FILE,
  EQUIPMENT_AFFIX_POOLS,
  EquipmentAffixFileSchema,
  buildAffixCatalogue,
} from '../../src/modules/equipment/affixCatalogue';
import { readContentFiles } from '../../src/modules/content/loader';
import { CONTENT_DIR } from '../helpers/fixtures';

const file = (affixes: unknown[]) => ({ format: 'waifumon-equipment-affixes', version: 2, affixes });
const affix = { key: 'mild_regret', suffix: 'of Mild Regret', pool: 'attack.N', enabled: true };
const issues = (raw: unknown) => {
  const r = EquipmentAffixFileSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
};
const ok = (raw: unknown) => issues(raw).length === 0;

describe('shipped affix catalogue', () => {
  const shipped = EquipmentAffixFileSchema.parse(
    JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, EQUIPMENT_AFFIX_FILE), 'utf8')),
  );

  it('has entries in every one of the nine pools, all enabled', () => {
    const counts = Object.fromEntries(EQUIPMENT_AFFIX_POOLS.map((p) => [p, shipped.affixes.filter((a) => a.pool === p).length]));
    expect(counts).toEqual({
      'attack.N': 52,
      'attack.R': 52,
      'attack.SR': 52,
      'defense.N': 52,
      'defense.R': 52,
      'defense.SR': 52,
      'health.N': 52,
      'health.R': 54,
      'health.SR': 52,
    });
    expect(shipped.affixes.every((a) => a.enabled)).toBe(true);
  });

  it('carries complete "of …" suffixes', () => {
    for (const a of shipped.affixes) expect(a.suffix, a.key).toMatch(/^of \S/);
  });

  it('is loaded with the rest of the content', () => {
    const content = readContentFiles(CONTENT_DIR);
    expect(content.equipmentAffixes).toHaveLength(470);
    expect(content.equipmentAffixes?.[0]).toEqual({
      key: 'the_desperate_swings',
      suffix: 'of the Desperate Swings',
      pool: 'attack.N',
      enabled: true,
    });
  });
});

describe('EquipmentAffixFileSchema', () => {
  it('accepts all nine pools', () => {
    expect(EQUIPMENT_AFFIX_POOLS).toEqual([
      'attack.N', 'attack.R', 'attack.SR',
      'defense.N', 'defense.R', 'defense.SR',
      'health.N', 'health.R', 'health.SR',
    ]);
    const all = EQUIPMENT_AFFIX_POOLS.map((pool, i) => ({ key: `a_${i}`, suffix: `of A${i}`, pool, enabled: true }));
    expect(ok(file(all))).toBe(true);
  });

  it.each(['attack.UR', 'attack.SSR', 'weapon.N', 'attack.normal', 'defence.R', 'Attack.N', 'attack', ''])(
    'refuses the pool %j',
    (pool) => {
      expect(issues(file([{ ...affix, pool }])).map((i) => i.path)).toEqual(['affixes.0.pool']);
    },
  );

  it('requires a pool', () => {
    const { pool: _pool, ...noPool } = affix;
    expect(issues(file([noPool])).map((i) => i.path)).toEqual(['affixes.0.pool']);
  });

  it('refuses duplicate keys', () => {
    expect(issues(file([affix, { ...affix, suffix: 'of Something Else' }]))).toContainEqual({
      path: 'affixes.1.key',
      message: 'duplicate affix key "mild_regret" (also affixes[0])',
    });
  });

  it('refuses duplicate suffixes, which would make two affixes look identical', () => {
    expect(ok(file([affix, { ...affix, key: 'other', suffix: 'OF MILD REGRET' }]))).toBe(false);
  });

  const paths = (raw: unknown) => [...new Set(issues(raw).map((i) => i.path))];

  it.each(['Mild Regret', 'mild-regret', 'MildRegret', '_mild', 'mild_', '', 'x'.repeat(65)])('refuses the key %j', (key) => {
    expect(paths(file([{ ...affix, key }]))).toEqual(['affixes.0.key']);
  });

  it.each(['', ' of Mild Regret', 'of Mild Regret ', '\tof Mild Regret', 'x'.repeat(61)])('refuses the suffix %j', (suffix) => {
    expect(paths(file([{ ...affix, suffix }]))).toEqual(['affixes.0.suffix']);
  });

  it.each(['true', 1, null, undefined])('requires enabled to be a boolean, not %j', (enabled) => {
    expect(issues(file([{ ...affix, enabled }])).map((i) => i.path)).toEqual(['affixes.0.enabled']);
  });

  it('refuses gameplay fields — affixes are flavour only', () => {
    for (const extra of [{ attackBp: 500 }, { effects: [] }, { weight: 3 }, { rarity: 'SR' }, { region: 'thirstlands' }]) {
      expect(ok(file([{ ...affix, ...extra }]))).toBe(false);
    }
  });

  it('refuses another format, and the pool-less version 1', () => {
    expect(ok({ ...file([]), format: 'waifumon-equipment' })).toBe(false);
    expect(ok({ ...file([]), version: 1 })).toBe(false);
  });
});

describe('buildAffixCatalogue', () => {
  const catalogue = buildAffixCatalogue([
    { key: 'a', suffix: 'of A', pool: 'attack.N', enabled: true },
    { key: 'b', suffix: 'of B', pool: 'attack.N', enabled: false },
    { key: 'c', suffix: 'of C', pool: 'attack.R', enabled: true },
  ]);

  it('looks up every affix but rolls only enabled ones, per pool', () => {
    expect(catalogue.get('b')?.suffix).toBe('of B');
    expect(catalogue.get('zzz')).toBeUndefined();
    expect(catalogue.rollable('attack.N').map((a) => a.key)).toEqual(['a']);
    expect(catalogue.rollable('attack.R').map((a) => a.key)).toEqual(['c']);
    expect(catalogue.rollable('defense.N')).toEqual([]);
    expect(catalogue.rollable('attack.SSR')).toEqual([]);
  });
});
