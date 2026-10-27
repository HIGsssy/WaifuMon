/**
 * Equipment 3.0 separates four rarity questions that used to share one
 * constant. Authoring now admits N…LR; random rolls, random rewards, the
 * Workshop and the shipped bonus rules stay N/R/SR — so an enabled SSR, UR or
 * LR definition can exist without ever appearing in a reward that previously
 * offered only N/R/SR.
 */
import { describe, expect, it } from 'vitest';
import { EQUIPMENT_AFFIX_RARITIES, buildAffixCatalogue } from '../../src/modules/equipment/affixCatalogue';
import { COMBAT_BONUS_RARITIES, rollCombatBonuses } from '../../src/modules/equipment/combatBonuses';
import { rollEquipmentInstance } from '../../src/modules/equipment/equipmentRoll';
import {
  EQUIPMENT_REWARD_RARITIES,
  EquipmentRewardSelectorSchema,
  eligibleRewardDefinitions,
  equipmentSelectorIssues,
  type RewardableDefinition,
} from '../../src/modules/equipment/rewardSelector';
import {
  EQUIPMENT_AUTHORING_RARITIES,
  EQUIPMENT_RANDOM_ROLL_RARITIES,
  EQUIPMENT_SLOTS,
} from '../../src/modules/equipment/vocabulary';
import { WORKSHOP_RECIPE_RARITIES, WorkshopRecipeSchema } from '../../src/modules/equipment/workshopConfig';
import { EquipmentAffixPoolEmptyError } from '../../src/shared/errors';
import { seededRng, type Rng } from '../../src/shared/random';

describe('rarity capability lists', () => {
  it('pins each list', () => {
    expect(EQUIPMENT_AUTHORING_RARITIES).toEqual(['N', 'R', 'SR', 'SSR', 'UR', 'LR']);
    // E3-C: SSR/UR/LR are rollable when explicitly configured — never rewardable.
    expect(EQUIPMENT_RANDOM_ROLL_RARITIES).toEqual(['N', 'R', 'SR', 'SSR', 'UR', 'LR']);
    expect(EQUIPMENT_REWARD_RARITIES).toEqual(['N', 'R', 'SR']);
    expect(WORKSHOP_RECIPE_RARITIES).toEqual(['N', 'R', 'SR']);
    expect(COMBAT_BONUS_RARITIES).toEqual(['N', 'R', 'SR']);
    expect(EQUIPMENT_AFFIX_RARITIES).toEqual(['N', 'R', 'SR']);
  });

  it('are independent arrays — widening one cannot widen another', () => {
    const lists = [
      EQUIPMENT_AUTHORING_RARITIES,
      EQUIPMENT_RANDOM_ROLL_RARITIES,
      EQUIPMENT_REWARD_RARITIES,
      WORKSHOP_RECIPE_RARITIES,
      COMBAT_BONUS_RARITIES,
      EQUIPMENT_AFFIX_RARITIES,
    ];
    expect(new Set(lists).size).toBe(lists.length);
  });
});

describe('existing reward selectors keep their rarity restriction', () => {
  const def = (key: string, slot: string, rarity: string, enabled = true): RewardableDefinition => ({ key, name: key, slot, rarity, enabled });
  // The shipped shape plus an enabled SSR, UR and LR in every slot.
  const DEFS: RewardableDefinition[] = [
    ...EQUIPMENT_SLOTS.flatMap((slot) => [
      def(`${slot}_n`, slot, 'N'),
      def(`${slot}_r`, slot, 'R'),
      def(`${slot}_sr`, slot, 'SR'),
      def(`${slot}_ssr`, slot, 'SSR'),
      def(`${slot}_ur`, slot, 'UR'),
      def(`${slot}_lr`, slot, 'LR'),
    ]),
  ];

  it.each([{}, { slot: 'attack' }, { slot: 'defense' }, { slot: 'health' }, { rarity: 'N' }, { rarity: 'SR', slot: 'health' }])(
    'selector %j still resolves only N/R/SR definitions',
    (selector) => {
      const eligible = eligibleRewardDefinitions(selector, DEFS);
      expect(eligible.length).toBeGreaterThan(0);
      expect(new Set(eligible.map((d) => d.rarity))).toEqual(
        new Set(EQUIPMENT_REWARD_RARITIES.filter((r) => !('rarity' in selector) || r === selector.rarity)),
      );
    },
  );

  it('the default selector resolves exactly the same set with or without high-rarity definitions present', () => {
    const lowOnly = DEFS.filter((d) => ['N', 'R', 'SR'].includes(d.rarity));
    expect(eligibleRewardDefinitions({}, DEFS)).toEqual(eligibleRewardDefinitions({}, lowOnly));
  });

  it.each(['SSR', 'UR', 'LR'])('a selector cannot name rarity %s', (rarity) => {
    expect(EquipmentRewardSelectorSchema.safeParse({ rarity }).success).toBe(false);
  });

  it.each(['attack_ssr', 'attack_ur', 'attack_lr'])('an explicit whitelist entry %s is refused', (key) => {
    expect(equipmentSelectorIssues({ definitionKeys: [key] }, DEFS)[0]!.message).toMatch(/random rewards hand out only N\/R\/SR/);
  });

  it.each(['SSR', 'UR', 'LR'])('a Workshop recipe cannot guarantee %s', (rarity) => {
    const recipe = { key: 'x', name: 'X', rarity, componentCost: 1, waifubuxCost: 1, enabled: true };
    expect(WorkshopRecipeSchema.safeParse(recipe).success).toBe(false);
  });
});

describe('random rolls of SSR/UR/LR stay fail-closed without published rules', () => {
  const affixes = buildAffixCatalogue([]);
  const counting = (): Rng & { calls: number } => {
    const inner = seededRng(1);
    const rng = {
      calls: 0,
      next: () => {
        rng.calls += 1;
        return inner.next();
      },
      intInclusive: (a: number, b: number) => {
        rng.calls += 1;
        return inner.intInclusive(a, b);
      },
    };
    return rng;
  };

  it.each(['SSR', 'UR', 'LR'])('%s throws the unsupported-pool error before drawing anything', (rarity) => {
    const rng = counting();
    const definition = { key: 'relic', slot: 'attack', rarity, multiplierMinBp: 11_000, multiplierMaxBp: 11_000, multiplierStepBp: 100 };
    expect(() => rollEquipmentInstance(definition, { rng, affixes })).toThrow(EquipmentAffixPoolEmptyError);
    expect(() => rollEquipmentInstance(definition, { rng, affixes })).toThrow(/not a supported pool/);
    expect(rng.calls).toBe(0);
    expect(rollCombatBonuses(definition, { rng, catalogue: null })).toEqual([]);
  });
});
