/**
 * The pure core shared by boss and expedition reward tables: the semantic
 * hash the seed decides divergence with, authoring validation, references,
 * and Equipment pool resolution.
 */
import { describe, expect, it } from 'vitest';
import {
  equipmentSelectorsOf,
  resolveEquipmentPools,
  rewardTableHash,
  rewardTableReferences,
  validateRewardTable,
  withoutEquipmentRewards,
  type RewardTableValidationContext,
} from '../../src/modules/rewardTables/rewardTableCore';
import { rollBossRewards } from '../../src/modules/bosses/bossRewards';
import { BossRewardTableSchema } from '../../src/modules/content/schemas';
import { EquipmentRewardConfigError } from '../../src/shared/errors';
import type { RewardableDefinition } from '../../src/modules/equipment/rewardSelector';

const DEFS: RewardableDefinition[] = [
  { key: 'combat_knife', name: 'Combat Knife', slot: 'attack', rarity: 'R', enabled: true },
  { key: 'semi_auto_sidearm', name: 'Semi-Auto Sidearm', slot: 'attack', rarity: 'R', enabled: true },
  { key: 'rusty_pipe', name: 'Rusty Pipe', slot: 'attack', rarity: 'N', enabled: true },
  { key: 'scrap_plate', name: 'Scrap Plate', slot: 'defense', rarity: 'N', enabled: true },
  { key: 'retired_blade', name: 'Retired Blade', slot: 'attack', rarity: 'R', enabled: false },
  { key: 'golden_gun', name: 'Golden Gun', slot: 'attack', rarity: 'SSR', enabled: true },
];

const ctx = (over: Partial<RewardTableValidationContext> = {}): RewardTableValidationContext => ({
  itemSlugs: new Set(['basic_charm', 'mythic_contract']),
  definitions: DEFS,
  references: [],
  ...over,
});

const bossTable = (groups: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'standard',
  buddyXp: 10,
  groups,
  ...extra,
});

const itemGroup = (entries: unknown[] = [{ itemId: 'basic_charm', weight: 1, quantity: 1 }], extra = {}) => ({
  id: 'items',
  entries,
  ...extra,
});

const gearGroup = (equipment: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  id: 'gear',
  entries: [],
  equipment: equipment.map((e) => ({ weight: 1, ...e })),
  ...extra,
});

const errors = (kind: 'boss' | 'expedition', table: unknown, c = ctx()) =>
  validateRewardTable(kind, table, c).issues.filter((i) => i.severity === 'error');
const warnings = (kind: 'boss' | 'expedition', table: unknown, c = ctx()) =>
  validateRewardTable(kind, table, c).issues.filter((i) => i.severity === 'warning');

describe('rewardTableHash', () => {
  it('ignores key order and spelled-out defaults', () => {
    const a = bossTable([itemGroup()]);
    const b = {
      groups: [
        {
          chanceBasisPoints: 10_000,
          rolls: 1,
          enabled: true,
          id: 'items',
          entries: [{ quantity: 1, weight: 1, enabled: true, itemId: 'basic_charm' }],
        },
      ],
      enabled: true,
      buddyXp: 10,
      id: 'standard',
    };
    expect(rewardTableHash('boss', a)).toBe(rewardTableHash('boss', b));
  });

  it('changes when entries are reordered, because order changes deterministic draws', () => {
    const entries = [
      { itemId: 'basic_charm', weight: 1, quantity: 1 },
      { itemId: 'mythic_contract', weight: 1, quantity: 1 },
    ];
    expect(rewardTableHash('boss', bossTable([itemGroup(entries)]))).not.toBe(
      rewardTableHash('boss', bossTable([itemGroup([...entries].reverse())])),
    );
  });

  it('changes with any value, and differs between kinds for the same document', () => {
    const base = rewardTableHash('expedition', { id: 't', groups: [itemGroup()] });
    expect(rewardTableHash('expedition', { id: 't', groups: [itemGroup()], playerXp: 1 })).not.toBe(base);
    // Expedition item quantity defaults to 1; boss requires it — both parse here.
    expect(rewardTableHash('expedition', { id: 't', groups: [itemGroup([{ itemId: 'basic_charm', weight: 1 }])] })).toBe(
      base,
    );
  });

  it('throws on a table that does not parse', () => {
    expect(() => rewardTableHash('boss', { id: 'x' })).toThrow();
  });
});

describe('validateRewardTable — schema', () => {
  it('accepts a valid boss and expedition table', () => {
    expect(validateRewardTable('boss', bossTable([itemGroup()]), ctx()).issues).toEqual([]);
    expect(validateRewardTable('expedition', { id: 'e', groups: [] }, ctx()).issues).toEqual([]);
  });

  it('reports schema failures with editor paths and stops there', () => {
    const result = validateRewardTable(
      'boss',
      bossTable([itemGroup([{ itemId: 'nope', weight: 0, quantity: 1 }])]),
      ctx(),
    );
    expect(result.table).toBeNull();
    expect(result.issues).toEqual([
      expect.objectContaining({ path: 'groups[0].entries[0].weight', severity: 'error' }),
    ]);
  });

  it('applies the per-kind table rules', () => {
    // Boss needs buddyXp and at least one group; expedition needs neither.
    expect(errors('boss', { id: 'b', groups: [] }).map((i) => i.path)).toEqual(
      expect.arrayContaining(['buddyXp', 'groups']),
    );
    expect(errors('expedition', { id: 'e' })).toEqual([]);
    // Boss item quantity is required.
    expect(errors('boss', bossTable([itemGroup([{ itemId: 'basic_charm', weight: 1 }])]))[0]!.path).toBe(
      'groups[0].entries[0].quantity',
    );
  });

  it('refuses an empty group, duplicate group ids and duplicate selectors', () => {
    expect(errors('boss', bossTable([{ id: 'empty', entries: [] }]))[0]!.message).toMatch(/at least one/);
    expect(errors('boss', bossTable([itemGroup(), itemGroup()]))[0]!.message).toMatch(/two groups/);
    expect(
      errors('boss', bossTable([gearGroup([{ slot: 'attack' }, { slot: 'attack' }])]))[0]!.message,
    ).toMatch(/same equipment selector twice/);
  });

  it('refuses multiplier, affix and pool fields on an Equipment row', () => {
    for (const field of ['multiplierBp', 'affixKey', 'affixPool', 'rolledMultiplierBp']) {
      expect(errors('boss', bossTable([gearGroup([{ slot: 'attack', [field]: 1 }])]))).not.toEqual([]);
    }
    // SSR/UR is not a selectable rarity.
    expect(errors('boss', bossTable([gearGroup([{ rarity: 'SSR' }])]))[0]!.path).toBe('groups[0].equipment[0].rarity');
  });
});

describe('validateRewardTable — items and Equipment against this server', () => {
  it('refuses an unknown item', () => {
    expect(errors('boss', bossTable([itemGroup([{ itemId: 'ghost_item', weight: 1, quantity: 1 }])]))).toEqual([
      { path: 'groups[0].entries[0].itemId', message: '"ghost_item" is not an item', severity: 'error' },
    ]);
  });

  it.each([
    ['a nonexistent definition', { definitionKeys: ['nope'] }, /not an equipment definition/],
    ['a disabled definition', { definitionKeys: ['retired_blade'] }, /disabled/],
    ['a slot conflict', { slot: 'defense', definitionKeys: ['combat_knife'] }, /attack gear, but this reward is defense/],
    ['a rarity conflict', { rarity: 'N', definitionKeys: ['combat_knife'] }, /is R, but this reward is N/],
    ['an SSR definition', { definitionKeys: ['golden_gun'] }, /random rewards hand out only/],
    ['no eligible definition', { slot: 'health' }, /no enabled equipment definition matches/],
  ])('refuses %s on a live row, with a path', (_label, selector, message) => {
    const found = errors('expedition', { id: 'e', groups: [gearGroup([selector])] });
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toMatch(/^groups\[0\]\.equipment\[0\]/);
    expect(found[0]!.message).toMatch(message);
  });

  it('points a whitelist problem at the offending key', () => {
    const found = errors('boss', bossTable([gearGroup([{ definitionKeys: ['combat_knife', 'nope'] }])]));
    expect(found.map((i) => i.path)).toEqual(['groups[0].equipment[0].definitionKeys[1]']);
  });

  it('only warns when the row, its group or its table is disabled', () => {
    const bad = { slot: 'health' };
    for (const table of [
      bossTable([gearGroup([{ ...bad, enabled: false }]), itemGroup()]),
      bossTable([gearGroup([bad], { enabled: false }), itemGroup()]),
      bossTable([gearGroup([bad])], { enabled: false }),
    ]) {
      expect(errors('boss', table)).toEqual([]);
      expect(warnings('boss', table)[0]!.message).toMatch(/not rolled while disabled/);
    }
  });

  it('accepts a valid selector', () => {
    expect(errors('boss', bossTable([gearGroup([{ slot: 'attack', rarity: 'R' }])]))).toEqual([]);
  });

  it('warns — never refuses — when disabling a table something live pays from', () => {
    const references = [
      { role: 'boss' as const, key: 'b1', name: 'Boss One', enabled: true },
      { role: 'boss' as const, key: 'b2', name: 'Boss Two', enabled: false },
    ];
    const table = bossTable([itemGroup()], { enabled: false });
    expect(errors('boss', table, ctx({ references }))).toEqual([]);
    expect(warnings('boss', table, ctx({ references })).map((i) => i.message)).toEqual([
      'boss "Boss One" (b1) will stop spawning while this table is disabled',
    ]);
  });
});

describe('rewardTableReferences', () => {
  const content = {
    bosses: [
      { id: 'b1', name: 'B1', enabled: true, rewardTable: 'standard' },
      { id: 'b2', name: 'B2', enabled: true, rewardTable: 'other' },
    ],
    expeditions: [
      {
        key: 'm1',
        name: 'M1',
        enabled: true,
        rewardTable: 'x',
        exceptionalRewardTable: 'x',
        failureRewardTable: 'y',
      },
    ],
  };
  it('finds bosses for a boss table and every mission role for an expedition table', () => {
    expect(rewardTableReferences('boss', 'standard', content).map((r) => r.key)).toEqual(['b1']);
    expect(rewardTableReferences('expedition', 'x', content).map((r) => r.role)).toEqual(['success', 'bonus']);
    expect(rewardTableReferences('expedition', 'y', content).map((r) => r.role)).toEqual(['failure']);
    expect(rewardTableReferences('expedition', 'standard', content)).toEqual([]);
  });
});

describe('Equipment pools', () => {
  it('collects live selectors only, deduplicated across tables', () => {
    const entry = (selector: object, enabled = true) => ({ enabled, weight: 1, ...selector });
    const a = {
      groups: [{ enabled: true, equipment: [entry({ slot: 'attack' }), entry({ slot: 'defense' }, false)] }],
    };
    const b = {
      groups: [
        { enabled: true, equipment: [entry({ slot: 'attack' })] },
        { enabled: false, equipment: [entry({ rarity: 'N' })] },
      ],
    };
    expect([...equipmentSelectorsOf([a as never, b as never, null]).keys()]).toEqual(['slot=attack;rarity=*;keys=*']);
  });

  it('resolves each selector to its sorted eligible definitions, and refuses a dead one', () => {
    const pools = resolveEquipmentPools(new Map([['k', { slot: 'attack' as const, rarity: 'R' as const }]]), DEFS);
    expect(pools.k!.map((c) => c.key)).toEqual(['combat_knife', 'semi_auto_sidearm']);
    expect(() => resolveEquipmentPools(new Map([['k', { slot: 'health' as const }]]), DEFS)).toThrow(
      EquipmentRewardConfigError,
    );
  });
});

describe('withoutEquipmentRewards — the table a player without Equipment rolls', () => {
  const mixed = {
    id: 'mixed',
    rolls: 3,
    entries: [
      { itemId: 'basic_charm', weight: 3, quantity: 1 },
      { itemId: 'mythic_contract', weight: 1, quantity: 1 },
    ],
    equipment: [{ slot: 'attack', weight: 4 }],
  };
  const table = BossRewardTableSchema.parse(
    bossTable([itemGroup(), mixed, gearGroup([{ rarity: 'R' }], { chanceBasisPoints: 5_000 })]),
  );

  it('removes every gear entry, drops gear-only groups, keeps ids, and leaves the input alone', () => {
    const before = JSON.stringify(table);
    const stripped = withoutEquipmentRewards(table);
    expect(stripped.groups.map((g) => g.id)).toEqual(['items', 'mixed']);
    expect(stripped.groups.every((g) => g.equipment === undefined)).toBe(true);
    expect(equipmentSelectorsOf([stripped]).size).toBe(0);
    expect(JSON.stringify(table)).toBe(before);
  });

  it('keeps an already-empty group, so the misconfiguration warning still fires', () => {
    const broken = BossRewardTableSchema.parse(bossTable([itemGroup([{ itemId: 'basic_charm', weight: 1, quantity: 1, enabled: false }])]));
    expect(withoutEquipmentRewards(broken).groups.map((g) => g.id)).toEqual(['items']);
  });

  it('rolls deterministically: gear never drops, and the result is exactly the gear-disabled table', () => {
    const disabled = BossRewardTableSchema.parse(
      JSON.parse(JSON.stringify(table), (key, value) =>
        key === 'equipment' ? (value as { enabled: boolean }[]).map((e) => ({ ...e, enabled: false })) : value,
      ),
    );
    const stripped = withoutEquipmentRewards(table);
    for (let participationId = 1; participationId <= 200; participationId += 1) {
      const input = { encounterId: 7, participationId, buddyLevel: 1, maxLevel: 100 };
      const locked = rollBossRewards({ ...input, table: stripped });
      expect(locked.equipment).toEqual([]);
      expect(locked).toEqual(rollBossRewards({ ...input, table: stripped }));
      const off = rollBossRewards({ ...input, table: disabled });
      expect(locked.items).toEqual(off.items);
      expect(locked.warnings).toEqual([]);
      // A group with no gear draws exactly what an eligible player's does.
      const full = rollBossRewards({ ...input, table });
      expect(locked.items[0]).toEqual(full.items[0]);
    }
  });
});
