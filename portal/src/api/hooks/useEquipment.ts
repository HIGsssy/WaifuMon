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
  dismantleEquipment,
  fabricateEquipment,
  getWorkshop,
  previewDismantle,
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
import type {
  DismantlePreview,
  EquipmentDetail,
  EquipmentOverview,
  EquipmentSlot,
  WorkshopOverview,
  WorkshopSlotChoice,
} from '../types';

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

/** Patch's Workshop overview. Only mounted for an unlocked player (the page gates on the overview). */
export function useWorkshop(playerId: number): UseQueryResult<WorkshopOverview> {
  return useQuery({
    queryKey: queryKeys.workshop(playerId),
    queryFn: ({ signal }) => getWorkshop(playerId, signal),
    ...PLAYER_POLICY,
  });
}

/**
 * The review of one explicit selection. A POST that writes nothing, cached by
 * the selection, and never retried: a refusal (a protected or vanished copy)
 * is an answer to show, not a fault to retry.
 */
export function useDismantlePreview(
  playerId: number,
  equipmentIds: number[] | null,
): UseQueryResult<DismantlePreview> {
  return useQuery({
    queryKey: queryKeys.dismantlePreview(playerId, equipmentIds ?? []),
    queryFn: () => previewDismantle(playerId, equipmentIds!),
    enabled: equipmentIds != null && equipmentIds.length > 0,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

/**
 * Workshop actions. Like the other Equipment actions they refresh the whole
 * Equipment subtree once they settle — success or failure — so the Gear Bag,
 * loadout, counts and balances all come back from the server. The player
 * record (WaifuBux elsewhere in the Portal) is refreshed too.
 */
export function useWorkshopActions(playerId: number) {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.equipment(playerId) }),
      client.invalidateQueries({ queryKey: queryKeys.playerRecord(playerId) }),
      client.invalidateQueries({ queryKey: queryKeys.playerProfile(playerId) }),
    ]);

  const dismantle = useMutation({
    mutationFn: (v: { equipmentIds: number[]; requestKey: string; expectedComponents: number }) =>
      dismantleEquipment(playerId, v),
    onSettled: refresh,
  });
  const fabricate = useMutation({
    mutationFn: (v: { recipeKey: string; slot: WorkshopSlotChoice; requestKey: string }) =>
      fabricateEquipment(playerId, v),
    onSettled: refresh,
  });

  return { dismantle, fabricate };
}
