/** Gear Bag filter state, shared by the page (which owns it) and the bag. */
import type { GearBagSort } from '@/api/equipment';
import type { EquipmentSlot, Rarity } from '@/api/types';

/** Everything the toolbar controls. `search` is the debounced value. */
export interface GearBagFilters {
  slot: EquipmentSlot | undefined;
  rarity: Rarity | undefined;
  equipped: boolean | undefined;
  favorite: true | undefined;
  locked: true | undefined;
  sort: GearBagSort;
}

export const DEFAULT_FILTERS: GearBagFilters = {
  slot: undefined,
  rarity: undefined,
  equipped: undefined,
  favorite: undefined,
  locked: undefined,
  sort: 'newest',
};
