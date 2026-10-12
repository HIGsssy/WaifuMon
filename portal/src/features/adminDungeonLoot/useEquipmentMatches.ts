import { useQuery } from '@tanstack/react-query';
import {
  DUNGEON_LOOT_TABLES_QUERY_KEY,
  validateDungeonLootTable,
  type EquipmentRewardSelector,
} from '@/api/adminDungeonLootTables';
import { selectorKey, type EquipmentPiece } from './lootModel';

/** The pieces a selector can drop right now, by the server's selector rules. Empty means none. */
export function useEquipmentMatches(selector: EquipmentRewardSelector) {
  return useQuery({
    queryKey: [...DUNGEON_LOOT_TABLES_QUERY_KEY, 'equipment-matches', selectorKey(selector)],
    queryFn: async ({ signal }): Promise<EquipmentPiece[]> => {
      const report = await validateDungeonLootTable(
        {
          guaranteed: [{ id: 'preview', grant: { type: 'equipment', selector } }],
          chances: [],
          pools: [],
        },
        signal,
      );
      return Object.values(report.equipmentPools)[0] ?? [];
    },
    staleTime: 30_000,
  });
}
