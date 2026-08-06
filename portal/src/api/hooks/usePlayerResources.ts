/**
 * Care, inventory and shop queries (plan §11, §13).
 *
 * Care and inventory are player-scoped and short-lived; the shop catalogue is
 * player-independent and long-lived, so it gets `SHOP_POLICY` — a stale price
 * is far less annoying than a shop that takes a second to appear.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { PLAYER_POLICY, SHOP_POLICY } from '../cachePolicy';
import { getCareState } from '../care';
import { getInventory } from '../inventory';
import { queryKeys } from '../queryKeys';
import { getShopCatalog } from '../shop';
import type { CareState, InventoryEntry, ShopCatalogEntry } from '../types';

export function useCareState(playerId: number): UseQueryResult<CareState> {
  return useQuery({
    queryKey: queryKeys.care(playerId),
    queryFn: ({ signal }) => getCareState(playerId, signal),
    ...PLAYER_POLICY,
  });
}

export function useInventory(playerId: number): UseQueryResult<InventoryEntry[]> {
  return useQuery({
    queryKey: queryKeys.inventory(playerId),
    queryFn: ({ signal }) => getInventory(playerId, signal),
    ...PLAYER_POLICY,
  });
}

export function useShopCatalog(): UseQueryResult<ShopCatalogEntry[]> {
  return useQuery({
    queryKey: queryKeys.shopCatalog(),
    queryFn: ({ signal }) => getShopCatalog(signal),
    ...SHOP_POLICY,
  });
}
