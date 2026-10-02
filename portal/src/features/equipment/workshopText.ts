/** Patch's Workshop wording, shared by the panel, the Gear Bag and both dialogs. Labels only. */
import type { DismantleBlocker, WorkshopSlotChoice } from '@/api/types';
import { SLOT_LABEL } from './format';

export const WORKSHOP_TITLE = "Patch's Workshop";
export const COMPONENTS_LABEL = 'Salvaged Components';

/** Why the server says a copy cannot be dismantled right now. */
export const BLOCKER_TEXT: Readonly<Record<DismantleBlocker, string>> = {
  equipped: 'Equipped — unequip it first',
  favorite: 'Favorite — unfavorite it first',
  locked: 'Locked — unlock it first',
  unsupported_rarity: "Patch can't salvage this rarity yet",
};

export const SLOT_CHOICE_LABEL: Readonly<Record<WorkshopSlotChoice, string>> = {
  ...SLOT_LABEL,
  any: 'Any / Surprise Me',
};
