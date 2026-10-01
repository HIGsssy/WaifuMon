/**
 * The shared Equipment reward selector — pure rules only: the authored shape,
 * strict validation against a definition list, eligibility, the uniform pick,
 * and how boss and expedition reward groups carry gear entries through the
 * same gate and weighted pick as their items.
 */
import { describe, expect, it } from 'vitest';
import {
  BossRewardGroupSchema,
  ExpeditionRewardTableSchema,
  type BossRewardTable,
} from '../../src/modules/content/schemas';
import { EffectSchema } from '../../src/modules/worldEncounters/types';
import {
  EquipmentRewardSelectorSchema,
  describeEquipmentSelector,
  eligibleRewardDefinitions,
  equipmentSelectorIssues,
  equipmentSelectorKey,
  pickRewardDefinition,
  type RewardableDefinition,
} from '../../src/modules/equipment/rewardSelector';
import { auditRewardTableSelectors } from '../../src/modules/equipment/equipmentRewardService';
import { rollBossRewards } from '../../src/modules/bosses/bossRewards';
import { rollExpeditionTable } from '../../src/modules/expeditions/expeditionRewards';
import { EquipmentRewardConfigError } from '../../src/shared/errors';
import { seededRng, type Rng } from '../../src/shared/random';

const def = (key: string, slot: string, rarity: string, enabled = true): RewardableDefinition => ({
  key,
  name: key.replace(/_/g, ' '),
  slot,
  rarity,
  enabled,
});

const DEFS: RewardableDefinition[] = [
  def('rusty_pipe', 'attack', 'N'),
  def('starter_pistol', 'attack', 'N'),
  def('combat_knife', 'attack', 'R'),
  def('semi_auto_sidearm', 'attack', 'R'),
  def('throbbing_mace', 'attack', 'R', false),
  def('railcarbine', 'attack', 'SR'),
  def('scrap_plate', 'defense', 'N'),
  def('kevlar_carrier', 'defense', 'R'),
  def('tower_shield', 'defense', 'R'),
  def('dented_lunchbox', 'health', 'N'),
  def('golden_gun', 'attack', 'SSR'),
];

const keys = (selector: unknown) => eligibleRewardDefinitions(selector, DEFS).map((d) => d.key);

/** A scripted `intInclusive`: answers in order, then `min`. */
function scripted(...values: number[]): Rng {
  const queue = [...values];
  return {
    next: () => 0,
    intInclusive: (min, max) => {
      const v = queue.length > 0 ? queue.shift()! : min;
      if (v < min || v > max) throw new Error(`scripted ${v} outside [${min}, ${max}]`);
      return v;
    },
  };
}

describe('selector shape', () => {
  it('accepts every optional combination', () => {
    for (const selector of [{}, { slot: 'attack' }, { rarity: 'R' }, { slot: 'defense', rarity: 'SR' }, { definitionKeys: ['combat_knife'] }]) {
      expect(EquipmentRewardSelectorSchema.safeParse(selector).success).toBe(true);
    }
  });

  it.each([
    ['an affix key', { affixKey: 'poor_planning' }],
    ['a multiplier', { rolledMultiplierBp: 5000 }],
    ['a pool', { pool: 'attack.N' }],
    ['SSR rarity', { rarity: 'SSR' }],
    ['an unknown slot', { slot: 'relic' }],
    ['an empty whitelist', { definitionKeys: [] }],
    ['a duplicated key', { definitionKeys: ['combat_knife', 'combat_knife'] }],
    ['a malformed key', { definitionKeys: ['Combat Knife'] }],
  ])('refuses %s', (_label, selector) => {
    expect(EquipmentRewardSelectorSchema.safeParse(selector).success).toBe(false);
  });

  it('keys a selector independently of whitelist order', () => {
    expect(equipmentSelectorKey({ definitionKeys: ['b', 'a'], rarity: 'R' })).toBe(
      equipmentSelectorKey({ rarity: 'R', definitionKeys: ['a', 'b'] }),
    );
    expect(equipmentSelectorKey({ slot: 'attack' })).not.toBe(equipmentSelectorKey({}));
  });

  it('describes a selector for logs and authoring summaries', () => {
    expect(describeEquipmentSelector({})).toBe('Any Equipment');
    expect(describeEquipmentSelector({ slot: 'attack', rarity: 'N' })).toBe('Any N Attack Equipment');
    expect(describeEquipmentSelector({ rarity: 'R', definitionKeys: ['a', 'b'] })).toBe('One of 2 listed R Equipment');
  });
});

describe('eligibility', () => {
  it('any selector: every enabled N/R/SR definition, never SSR, never disabled', () => {
    const all = keys({});
    expect(all).toContain('railcarbine');
    expect(all).toContain('dented_lunchbox');
    expect(all).not.toContain('throbbing_mace');
    expect(all).not.toContain('golden_gun');
  });

  it('filters by slot', () => {
    expect(keys({ slot: 'defense' })).toEqual(['kevlar_carrier', 'scrap_plate', 'tower_shield']);
  });

  it('filters by rarity', () => {
    expect(keys({ rarity: 'R' })).toEqual(['combat_knife', 'kevlar_carrier', 'semi_auto_sidearm', 'tower_shield']);
  });

  it('combines slot and rarity', () => {
    expect(keys({ slot: 'attack', rarity: 'N' })).toEqual(['rusty_pipe', 'starter_pistol']);
  });

  it('honours an explicit whitelist', () => {
    expect(keys({ definitionKeys: ['semi_auto_sidearm', 'combat_knife'] })).toEqual(['combat_knife', 'semi_auto_sidearm']);
  });

  it('combines a whitelist with rarity', () => {
    expect(keys({ rarity: 'R', definitionKeys: ['combat_knife', 'kevlar_carrier'] })).toEqual([
      'combat_knife',
      'kevlar_carrier',
    ]);
  });

  it('works with whatever Health definitions exist, without special-casing', () => {
    expect(keys({ slot: 'health' })).toEqual(['dented_lunchbox']);
    expect(eligibleRewardDefinitions({ slot: 'health' }, [...DEFS, def('first_aid_pouch', 'health', 'N')]).map((d) => d.key))
      .toEqual(['dented_lunchbox', 'first_aid_pouch']);
  });
});

describe('strict validation', () => {
  const messages = (selector: unknown, defs = DEFS) => equipmentSelectorIssues(selector, defs).map((i) => i.message);

  it('rejects an unknown explicit key rather than dropping it', () => {
    expect(messages({ definitionKeys: ['combat_knife', 'nonexistent_blade'] })).toEqual([
      '"nonexistent_blade" is not an equipment definition',
    ]);
  });

  it('rejects a disabled explicit key — a whitelist cannot bypass the switch', () => {
    expect(messages({ definitionKeys: ['throbbing_mace'] })).toEqual(['"throbbing_mace" is disabled and cannot be acquired']);
  });

  it('rejects an explicit key that contradicts the slot or rarity', () => {
    expect(messages({ slot: 'defense', definitionKeys: ['combat_knife'] })[0]).toMatch(/attack gear, but this reward is defense only/);
    expect(messages({ rarity: 'N', definitionKeys: ['combat_knife'] })[0]).toMatch(/is R, but this reward is N only/);
  });

  it('rejects an explicit SSR key: no random SSR/UR acquisition', () => {
    expect(messages({ definitionKeys: ['golden_gun'] })[0]).toMatch(/random rewards hand out only N\/R\/SR/);
  });

  it('rejects a selector with no eligible definition rather than substituting one', () => {
    expect(messages({ slot: 'health', rarity: 'SR' })).toEqual([
      'no enabled equipment definition matches "Any SR Health Equipment"',
    ]);
    expect(() => eligibleRewardDefinitions({ slot: 'health', rarity: 'R' }, DEFS)).toThrow(EquipmentRewardConfigError);
  });

  it('reports a malformed stored selector instead of coercing it', () => {
    expect(equipmentSelectorIssues({ rarity: 'UR' }, DEFS)).not.toEqual([]);
  });
});

describe('the uniform pick', () => {
  it('is deterministic for an injected RNG', () => {
    const eligible = eligibleRewardDefinitions({ rarity: 'R' }, DEFS);
    const a = Array.from({ length: 20 }, (_, i) => pickRewardDefinition(eligible, seededRng(i)).key);
    const b = Array.from({ length: 20 }, (_, i) => pickRewardDefinition(eligible, seededRng(i)).key);
    expect(a).toEqual(b);
    expect(pickRewardDefinition(eligible, scripted(2)).key).toBe('semi_auto_sidearm');
  });

  it('reaches every eligible definition with equal weight', () => {
    const eligible = eligibleRewardDefinitions({ slot: 'attack', rarity: 'R' }, DEFS);
    const rng = seededRng(42);
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i += 1) {
      const key = pickRewardDefinition(eligible, rng).key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(['combat_knife', 'semi_auto_sidearm']);
    for (const n of counts.values()) expect(n / 4000).toBeGreaterThan(0.45);
  });
});

describe('authored containers share the selector', () => {
  it('a World Encounter give_equipment effect takes the selector and nothing else', () => {
    expect(EffectSchema.parse({ type: 'give_equipment', slot: 'attack', rarity: 'N' })).toEqual({
      type: 'give_equipment',
      slot: 'attack',
      rarity: 'N',
      quantity: 1,
    });
    expect(EffectSchema.safeParse({ type: 'give_equipment', affixKey: 'poor_planning' }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'give_equipment', rolledMultiplierBp: 9000 }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'give_equipment', quantity: 2 }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'give_equipment', rarity: 'UR' }).success).toBe(false);
  });

  it('a reward group carries gear entries beside its items', () => {
    const group = BossRewardGroupSchema.parse({
      id: 'gear',
      chanceBasisPoints: 800,
      equipment: [{ slot: 'attack', rarity: 'R', weight: 1 }],
    });
    expect(group.entries).toEqual([]);
    expect(group.equipment).toEqual([{ slot: 'attack', rarity: 'R', weight: 1, enabled: true }]);
  });

  it('refuses a group with nothing in it, a duplicated selector, and an authored affix', () => {
    expect(BossRewardGroupSchema.safeParse({ id: 'empty' }).success).toBe(false);
    expect(
      BossRewardGroupSchema.safeParse({
        id: 'dup',
        equipment: [
          { rarity: 'R', definitionKeys: ['a', 'b'], weight: 1 },
          { rarity: 'R', definitionKeys: ['b', 'a'], weight: 2 },
        ],
      }).success,
    ).toBe(false);
    expect(
      BossRewardGroupSchema.safeParse({ id: 'affix', equipment: [{ rarity: 'R', affixKey: 'x', weight: 1 }] }).success,
    ).toBe(false);
  });
});

describe('boss reward rolls', () => {
  const table = (equipment?: unknown[]): BossRewardTable => ({
    id: 't',
    enabled: true,
    buddyXp: 10,
    groups: [
      {
        id: 'mixed',
        enabled: true,
        rolls: 1,
        chanceBasisPoints: 10_000,
        entries: [{ itemId: 'basic_charm', enabled: true, weight: 1, quantity: 1 }],
        ...(equipment ? { equipment: equipment as never } : {}),
      },
    ],
  });

  it('a group without gear draws exactly what it drew before gear existed', () => {
    for (let p = 1; p <= 50; p += 1) {
      const before = rollBossRewards({ table: table(), encounterId: 7, participationId: p, buddyLevel: 1, maxLevel: 50 });
      const after = rollBossRewards({
        table: table([]),
        encounterId: 7,
        participationId: p,
        buddyLevel: 1,
        maxLevel: 50,
      });
      expect(after.items).toEqual(before.items);
      expect(after.equipment).toEqual([]);
    }
  });

  it('a picked gear entry becomes an equipment draw carrying only the selector', () => {
    const gearOnly = table();
    gearOnly.groups[0]!.entries = [];
    gearOnly.groups[0]!.equipment = [{ slot: 'attack', rarity: 'R', enabled: true, weight: 1 }];
    const roll = rollBossRewards({ table: gearOnly, encounterId: 1, participationId: 2, buddyLevel: 1, maxLevel: 50 });
    expect(roll.items).toEqual([]);
    expect(roll.equipment).toEqual([{ groupId: 'mixed', roll: 0, selector: { slot: 'attack', rarity: 'R' } }]);
  });

  it('gear competes by weight in the same pick as the items', () => {
    let gear = 0;
    for (let p = 1; p <= 2000; p += 1) {
      const roll = rollBossRewards({
        table: table([{ rarity: 'N', enabled: true, weight: 3 }]),
        encounterId: 3,
        participationId: p,
        buddyLevel: 1,
        maxLevel: 50,
      });
      gear += roll.equipment.length;
      expect(roll.items.length + roll.equipment.length).toBe(1);
    }
    expect(gear / 2000).toBeGreaterThan(0.7);
    expect(gear / 2000).toBeLessThan(0.8);
  });

  it('a disabled gear entry never drops', () => {
    for (let p = 1; p <= 200; p += 1) {
      const roll = rollBossRewards({
        table: table([{ rarity: 'N', enabled: false, weight: 1000 }]),
        encounterId: 3,
        participationId: p,
        buddyLevel: 1,
        maxLevel: 50,
      });
      expect(roll.equipment).toEqual([]);
    }
  });
});

describe('expedition reward rolls', () => {
  const gearTable = ExpeditionRewardTableSchema.parse({
    id: 'gear_table',
    groups: [{ id: 'gear', equipment: [{ rarity: 'R', weight: 1 }] }],
  });
  const pools = {
    [equipmentSelectorKey({ rarity: 'R' })]: [
      { key: 'combat_knife', name: 'Combat Knife', slot: 'attack' as const, rarity: 'R' },
      { key: 'kevlar_carrier', name: 'Kevlar Carrier', slot: 'defense' as const, rarity: 'R' },
    ],
  };

  it('chooses the base definition from the snapshotted pool, deterministically', () => {
    const a = rollExpeditionTable({ table: gearTable, expeditionId: 11, kind: 'success', equipmentPools: pools });
    const b = rollExpeditionTable({ table: gearTable, expeditionId: 11, kind: 'success', equipmentPools: pools });
    expect(a.equipment).toHaveLength(1);
    expect(a.equipment).toEqual(b.equipment);
    expect(a.equipment[0]!.drawKey).toBe('success:gear:0');
    expect(['combat_knife', 'kevlar_carrier']).toContain(a.equipment[0]!.definitionKey);
  });

  it('reaches every pooled definition across missions', () => {
    const seen = new Set<string>();
    for (let id = 1; id <= 100; id += 1) {
      seen.add(rollExpeditionTable({ table: gearTable, expeditionId: id, kind: 'success', equipmentPools: pools }).equipment[0]!.definitionKey);
    }
    expect([...seen].sort()).toEqual(['combat_knife', 'kevlar_carrier']);
  });

  it('refuses to invent a pool the deploy did not snapshot', () => {
    expect(() => rollExpeditionTable({ table: gearTable, expeditionId: 1, kind: 'success' })).toThrow(/no snapshotted equipment pool/);
  });
});

describe('startup audit', () => {
  it('names every enabled gear entry this server cannot pay, and only those', () => {
    const findings = auditRewardTableSelectors(
      [
        {
          label: 'bossRewards["t"]',
          enabled: true,
          groups: [
            {
              id: 'g',
              enabled: true,
              equipment: [
                { rarity: 'R', enabled: true, weight: 1 },
                { definitionKeys: ['throbbing_mace'], enabled: true, weight: 1 },
                { definitionKeys: ['nope'], enabled: false, weight: 1 },
              ],
            },
            { id: 'off', enabled: false, equipment: [{ slot: 'health', rarity: 'SR', enabled: true, weight: 1 }] },
          ],
        },
      ],
      DEFS,
    );
    expect(findings.map((f) => f.location)).toEqual(['bossRewards["t"].groups["g"].equipment[1]']);
  });
});
