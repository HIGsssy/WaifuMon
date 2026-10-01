/**
 * Gear Bag ordering, filtering and paging — pure, interface-agnostic.
 *
 * `equipmentService.listEquipmentGroups` already groups a player's gear into
 * truly identical copies (same definition, rolled multiplier and affix) and
 * returns every group. This module only decides the order a
 * quick-management screen shows them in and slices out one page. It never
 * reads the database and never decides ownership: every id it hands back came
 * from the service's own grouping, and every action re-validates it.
 */
import { RARITIES } from '../../db/schema';
import type { EquipmentGroup } from './equipmentService';
import { EQUIPMENT_SLOTS, type EquipmentSlot } from './vocabulary';

export const GEAR_BAG_FILTERS = ['all', 'attack', 'defense', 'health', 'fav'] as const;
export type GearBagFilter = (typeof GEAR_BAG_FILTERS)[number];

export function isGearBagFilter(value: unknown): value is GearBagFilter {
  return typeof value === 'string' && (GEAR_BAG_FILTERS as readonly string[]).includes(value);
}

/** Groups per page — fits one select menu and a readable embed. */
export const GEAR_BAG_PAGE_SIZE = 10;

const rank = (rarity: string) => (RARITIES as readonly string[]).indexOf(rarity);

/**
 * Usability order: equipped first, then favourites, then slot order, then
 * rarity and rolled multiplier (strongest first), then display name — and the
 * key and affix last, so the order is total over group identity and paging is
 * stable.
 */
export function sortGearBagGroups(groups: readonly EquipmentGroup[]): EquipmentGroup[] {
  return [...groups].sort(
    (a, b) =>
      Number(b.equippedCount > 0) - Number(a.equippedCount > 0) ||
      Number(b.favoriteCount > 0) - Number(a.favoriteCount > 0) ||
      EQUIPMENT_SLOTS.indexOf(a.definition.slot) - EQUIPMENT_SLOTS.indexOf(b.definition.slot) ||
      rank(b.definition.rarity) - rank(a.definition.rarity) ||
      b.rolledMultiplierBp - a.rolledMultiplierBp ||
      a.displayName.localeCompare(b.displayName) ||
      a.definition.key.localeCompare(b.definition.key) ||
      (a.affixKey ?? '').localeCompare(b.affixKey ?? ''),
  );
}

export function filterGearBagGroups(groups: readonly EquipmentGroup[], filter: GearBagFilter): EquipmentGroup[] {
  if (filter === 'all') return [...groups];
  if (filter === 'fav') return groups.filter((g) => g.favoriteCount > 0);
  return groups.filter((g) => g.definition.slot === filter);
}

export interface Page<T> {
  items: T[];
  /** 0-based, already clamped into range. */
  page: number;
  totalPages: number;
  totalItems: number;
}

/**
 * One page. An out-of-range page (a stale button after the bag shrank) is
 * clamped to the nearest valid page rather than refused — the player sees
 * their real bag, never an error.
 */
export function paginate<T>(items: readonly T[], page: number, pageSize = GEAR_BAG_PAGE_SIZE): Page<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safe = Number.isInteger(page) ? Math.min(Math.max(page, 0), totalPages - 1) : 0;
  return {
    items: items.slice(safe * pageSize, safe * pageSize + pageSize),
    page: safe,
    totalPages,
    totalItems: items.length,
  };
}

/**
 * The concrete copy a group stands for on a screen: the equipped copy when one
 * is equipped (so its detail shows "Equipped" and its flags), otherwise the
 * service's representative (the oldest unequipped copy).
 */
export function groupFocusId(group: EquipmentGroup, equippedIds: ReadonlySet<number>): number {
  return group.instanceIds.find((id) => equippedIds.has(id)) ?? group.representativeId;
}

/** Slot, for a gear filter that names one. */
export function filterSlot(filter: GearBagFilter): EquipmentSlot | null {
  return filter === 'attack' || filter === 'defense' || filter === 'health' ? filter : null;
}
