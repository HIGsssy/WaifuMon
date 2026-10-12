/**
 * Compile-time equality checks for the Portal's independent wire DTOs.
 * `npm run typecheck` checks these in the backend checkout; neither backend
 * source nor these tests are dependencies of the Portal production build.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type * as Portal from '../../../portal/src/api/dungeonLootTypes';
import type * as Api from '../../../src/api/schemas/dungeonLootTables';
import type * as Rewards from '../../../src/modules/dungeons/content/dungeonRewards';
import type { EquipmentRewardSelector } from '../../../src/modules/equipment/rewardSelector';

describe('Dungeon Loot Portal wire contracts', () => {
  it('keeps reward grants, Nothing alternatives and selector fields identical', () => {
    expectTypeOf<Portal.DungeonRewardGrant>().toEqualTypeOf<Rewards.DungeonRewardGrant>();
    expectTypeOf<Portal.DungeonLootTableBody>().toEqualTypeOf<Rewards.DungeonLootTableBody>();
    expectTypeOf<Portal.EquipmentRewardSelector>().toEqualTypeOf<EquipmentRewardSelector>();
  });
  it('keeps catalogue, usage, history and validation DTOs identical', () => {
    expectTypeOf<Portal.DungeonLootTable>().toEqualTypeOf<Api.DungeonLootTable>();
    expectTypeOf<Portal.DungeonLootTableUsage>().toEqualTypeOf<Api.DungeonLootTableUsage>();
    expectTypeOf<Portal.DungeonLootTableEvent>().toEqualTypeOf<Api.DungeonLootTableEvent>();
    expectTypeOf<Portal.DungeonLootTableValidation>().toEqualTypeOf<Api.DungeonLootTableValidation>();
  });
});
