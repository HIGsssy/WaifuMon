/**
 * Equipment queries and actions.
 *
 * Reads are ordinary player-scoped queries. Actions are mutations whose only
 * client-side effect is to invalidate the `['player', id, 'equipment']`
 * subtree once they settle — success *or* failure. That is deliberate: after
 * a `409 LOADOUT_CONFLICT` the page must show the slot as it really is now,
 * and after a success every number on screen must come back from the server
 * rather than be patched in locally.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import { PLAYER_POLICY } from '../cachePolicy';
import {
  equipItem,
  getEquipmentDetail,
  getEquipmentOverview,
  getGearBagPage,
  setEquipmentFlag,
  unequipSlot,
  type EquipmentFlag,
  type GearBagQuery,
} from '../equipment';
import { queryKeys } from '../queryKeys';
import type { EquipmentDetail, EquipmentOverview, EquipmentSlot } from '../types';

export function useEquipmentOverview(playerId: number): UseQueryResult<EquipmentOverview> {
  return useQuery({
    queryKey: queryKeys.equipmentOverview(playerId),
    queryFn: ({ signal }) => getEquipmentOverview(playerId, signal),
    ...PLAYER_POLICY,
  });
}

/**
 * Cursor-paged. Only mounted once the overview says Equipment is unlocked, so a
 * locked player's page never asks for gear at all.
 */
export function useGearBag(playerId: number, query: GearBagQuery) {
  return useInfiniteQuery({
    queryKey: queryKeys.gearBag(playerId, query),
    queryFn: ({ signal, pageParam }) => getGearBagPage(playerId, query, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    ...PLAYER_POLICY,
  });
}

export function useEquipmentDetail(
  playerId: number,
  equipmentId: number | null,
): UseQueryResult<EquipmentDetail> {
  return useQuery({
    queryKey: queryKeys.equipmentDetail(playerId, equipmentId ?? 0),
    queryFn: ({ signal }) => getEquipmentDetail(playerId, equipmentId!, signal),
    enabled: equipmentId != null,
    ...PLAYER_POLICY,
  });
}

export function useEquipmentActions(playerId: number) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.equipment(playerId) });

  const equip = useMutation({
    mutationFn: (v: { equipmentId: number; expectedCurrentId: number | null }) =>
      equipItem(playerId, v.equipmentId, v.expectedCurrentId),
    onSettled: refresh,
  });
  const unequip = useMutation({
    mutationFn: (v: { slot: EquipmentSlot; expectedCurrentId: number | null }) =>
      unequipSlot(playerId, v.slot, v.expectedCurrentId),
    onSettled: refresh,
  });
  const flag = useMutation({
    mutationFn: (v: { equipmentId: number; flag: EquipmentFlag; value: boolean }) =>
      setEquipmentFlag(playerId, v.equipmentId, v.flag, v.value),
    onSettled: refresh,
  });

  return { equip, unequip, flag };
}
