import { describe, expect, it, vi } from 'vitest';
import type { DbOrTx } from '../../src/db/client';
import { buildAffixCatalogue } from '../../src/modules/equipment/affixCatalogue';
import { createEquipmentRewardService } from '../../src/modules/equipment/equipmentRewardService';
import type { GrantKeyRecord } from '../../src/modules/equipment/equipmentService';

const tx = {} as DbOrTx;
const source = { type: 'dungeon', key: 'test' } as const;
const record: GrantKeyRecord = {
  grantKey: 'dungeon:claim:g:gear:0', equipmentId: 17, slot: 'attack', sourceType: 'dungeon', removed: false,
  definition: {
    key: 'test_gear', name: 'Test Gear', description: '', slot: 'attack', rarity: 'SR',
    multiplierMinBp: 4_000, multiplierMaxBp: 6_000, multiplierStepBp: 500,
    tags: [], regionId: null, artworkPath: null, enabled: true,
  },
  rolledMultiplierBp: 5_000, affixKey: null,
  combatBonuses: [{ stat: 'crit_chance_bp', valueBp: 500 }, { stat: 'armor_penetration_bp', valueBp: 400 }],
};
const setup = (replay = false) => {
  const stop = new Error('grant forwarded');
  const grantEquipment = vi.fn(async () => { throw stop; });
  const findByGrantKeys = vi.fn(async () => new Map(replay ? [[record.grantKey, record]] : []));
  const isUnlocked = vi.fn(async () => true);
  const rewards = createEquipmentRewardService({
    equipment: { grantEquipment, findByGrantKeys },
    getAffixes: () => buildAffixCatalogue([]), featureUnlocks: { isUnlocked },
    rng: { next: () => { throw new Error('shared RNG consumed'); }, intInclusive: () => { throw new Error('shared RNG consumed'); } },
  });
  return { rewards, stop, grantEquipment, findByGrantKeys, isUnlocked };
};

describe('chosen equipment reward seed interface', () => {
  it.each([0, 42, 0xffff_ffff])('forwards seed %i with the existing grant options', async (rollSeed) => {
    const { rewards, stop, grantEquipment, isUnlocked } = setup();
    await expect(rewards.grantChosenEquipmentReward(tx, {
      playerId: 1, definitionKey: 'test_gear', source, rollSeed, grantKey: 'dungeon:claim:g:gear',
      allowDisabled: true, promised: true, actorDiscordId: 'actor',
    })).rejects.toBe(stop);
    expect(grantEquipment).toHaveBeenCalledTimes(1);
    expect(grantEquipment).toHaveBeenCalledWith(tx, {
      playerId: 1, definitionKey: 'test_gear', source, quantity: 1, rollSeed,
      grantKey: 'dungeon:claim:g:gear', allowDisabled: true, actorDiscordId: 'actor', roll: { kind: 'random' },
    });
    expect(isUnlocked).not.toHaveBeenCalled();
  });

  it('an unseeded caller forwards the same grant object and eligibility check as before', async () => {
    const { rewards, stop, grantEquipment, isUnlocked } = setup();
    await expect(rewards.grantChosenEquipmentReward(tx, {
      playerId: 1, definitionKey: 'test_gear', source,
    })).rejects.toBe(stop);
    expect(grantEquipment).toHaveBeenCalledTimes(1);
    expect(grantEquipment).toHaveBeenCalledWith(tx, {
      playerId: 1, definitionKey: 'test_gear', source, quantity: 1,
      grantKey: null, actorDiscordId: null, roll: { kind: 'random' },
    });
    expect(isUnlocked).toHaveBeenCalledTimes(1);
    expect(isUnlocked).toHaveBeenCalledWith(1, 'equipment', tx);
  });

  it('a committed grant-key replay bypasses generation regardless of the supplied seed', async () => {
    const { rewards, grantEquipment, findByGrantKeys, isUnlocked } = setup(true);
    const reward = await rewards.grantChosenEquipmentReward(tx, {
      playerId: 1, definitionKey: 'other_definition', source, grantKey: 'dungeon:claim:g:gear', rollSeed: NaN,
    });
    expect(reward).toMatchObject({
      equipmentId: record.equipmentId, definitionKey: record.definition.key, alreadyGranted: true,
      rolledMultiplierBp: record.rolledMultiplierBp, affixKey: record.affixKey, combatBonuses: record.combatBonuses,
    });
    expect(findByGrantKeys).toHaveBeenCalledTimes(1);
    expect(findByGrantKeys).toHaveBeenCalledWith(tx, 1, [record.grantKey]);
    expect(grantEquipment).not.toHaveBeenCalled();
    expect(isUnlocked).not.toHaveBeenCalled();
  });
});
