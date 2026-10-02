/**
 * `/api/v1/players/{id}/equipment/*` — the player's own Equipment.
 *
 * Every number on the page (ATK / DEF / HP, a comparison, roll quality) comes
 * from these responses; the Portal formats them and computes nothing. The
 * server enforces the Equipment unlock on every route, so the locked page is a
 * rendering of `{ unlocked: false }`, not a client-side gate.
 */
import { getData, postData, putData } from './client';
import type {
  DismantlePreview,
  DismantleResult,
  FabricationResult,
  WorkshopOverview,
  WorkshopSlotChoice,
  EquipmentDetail,
  EquipmentItem,
  EquipmentOverview,
  EquipmentPage,
  EquipmentSlot,
  EquipmentSlotChange,
  Rarity,
} from './types';

/** The API's own ceiling is 50; a page of 24 fills two- and three-column grids evenly. */
export const GEAR_BAG_PAGE_SIZE = 24;

export const GEAR_BAG_SORTS = [
  'newest',
  'oldest',
  'slot',
  'rarity',
  'name',
  'multiplier',
  'quality',
] as const;
export type GearBagSort = (typeof GEAR_BAG_SORTS)[number];

export interface GearBagQuery {
  slot?: EquipmentSlot | undefined;
  rarity?: Rarity | undefined;
  equipped?: boolean | undefined;
  favorite?: boolean | undefined;
  locked?: boolean | undefined;
  search?: string | undefined;
  sort: GearBagSort;
}

const base = (playerId: number) => `/v1/players/${playerId}/equipment`;

export function getEquipmentOverview(
  playerId: number,
  signal?: AbortSignal,
): Promise<EquipmentOverview> {
  return getData<EquipmentOverview>(base(playerId), signal ? { signal } : {});
}

export function getGearBagPage(
  playerId: number,
  query: GearBagQuery,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<EquipmentPage> {
  const params: Record<string, string | number> = { sort: query.sort, limit: GEAR_BAG_PAGE_SIZE };
  if (query.slot) params.slot = query.slot;
  if (query.rarity) params.rarity = query.rarity;
  if (query.equipped !== undefined) params.equipped = String(query.equipped);
  if (query.favorite !== undefined) params.favorite = String(query.favorite);
  if (query.locked !== undefined) params.locked = String(query.locked);
  if (query.search?.trim()) params.search = query.search.trim();
  if (cursor) params.cursor = cursor;
  return getData<EquipmentPage>(`${base(playerId)}/items`, {
    params,
    ...(signal ? { signal } : {}),
  });
}

export function getEquipmentDetail(
  playerId: number,
  equipmentId: number,
  signal?: AbortSignal,
): Promise<EquipmentDetail> {
  return getData<EquipmentDetail>(
    `${base(playerId)}/items/${equipmentId}`,
    signal ? { signal } : {},
  );
}

/**
 * `expectedCurrentId` is the copy the page showed in the slot (null for an
 * empty slot). If the slot changed since — in Discord, or another tab — the
 * API refuses with `409 LOADOUT_CONFLICT` instead of overwriting it.
 */
export function equipItem(
  playerId: number,
  equipmentId: number,
  expectedCurrentId: number | null,
): Promise<EquipmentSlotChange> {
  return postData<EquipmentSlotChange>(`${base(playerId)}/items/${equipmentId}/equip`, {
    expectedCurrentId,
  });
}

export function unequipSlot(
  playerId: number,
  slot: EquipmentSlot,
  expectedCurrentId: number | null,
): Promise<EquipmentSlotChange> {
  return postData<EquipmentSlotChange>(`${base(playerId)}/loadout/${slot}/unequip`, {
    expectedCurrentId,
  });
}

export type EquipmentFlag = 'favorite' | 'locked';

/** Sets (never toggles) one flag, so a doubled click lands on the same value. */
export function setEquipmentFlag(
  playerId: number,
  equipmentId: number,
  flag: EquipmentFlag,
  value: boolean,
): Promise<EquipmentItem> {
  return putData<EquipmentItem>(`${base(playerId)}/items/${equipmentId}/flags/${flag}`, {
    value,
  });
}

// ── Patch's Workshop ────────────────────────────────────────────────────────
//
// Every cost, yield, balance and availability comes from the server; the
// Portal sends the player's explicit choices and a request key, and renders
// what comes back.

export function getWorkshop(playerId: number, signal?: AbortSignal): Promise<WorkshopOverview> {
  return getData<WorkshopOverview>(`${base(playerId)}/workshop`, signal ? { signal } : {});
}

/** Writes nothing: what dismantling exactly these copies would pay, or a refusal naming each problem. */
export function previewDismantle(
  playerId: number,
  equipmentIds: number[],
): Promise<DismantlePreview> {
  return postData<DismantlePreview>(`${base(playerId)}/workshop/dismantle/preview`, {
    equipmentIds,
  });
}

/**
 * Dismantle exactly the reviewed copies. `requestKey` is minted once per
 * confirmation: a retry of the same confirmation replays instead of
 * destroying or paying again. `expectedComponents` is the reviewed total.
 */
export function dismantleEquipment(
  playerId: number,
  body: { equipmentIds: number[]; requestKey: string; expectedComponents: number },
): Promise<DismantleResult> {
  return postData<DismantleResult>(`${base(playerId)}/workshop/dismantle`, body);
}

/** Fabricate one piece. A retry with the same `requestKey` returns the same item, charged once. */
export function fabricateEquipment(
  playerId: number,
  body: { recipeKey: string; slot: WorkshopSlotChoice; requestKey: string },
): Promise<FabricationResult> {
  return postData<FabricationResult>(`${base(playerId)}/workshop/fabricate`, body);
}

/** A fresh idempotency key for one confirmation. */
export function newRequestKey(): string {
  return `portal:${crypto.randomUUID()}`;
}
