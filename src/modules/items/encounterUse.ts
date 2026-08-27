/**
 * Which owned items are usable *during an encounter*.
 *
 * The encounter selector used to ask "is this item `category: 'capture'`?",
 * which is a question about how an item is filed rather than about what it
 * does. Microdose is filed as a consumable and yet its entire effect is a
 * capture-chance bonus, so the category test hid the one item a player most
 * wants after seeing what they are facing.
 *
 * The rule here is behavioural instead: an item is offered during an encounter
 * when it is a **direct capture item** (spent on the attempt) or when its
 * configured **effect** is one that changes the outcome of a capture attempt.
 * Energy restoration and everything else stay out — not because they are
 * consumables, but because using them mid-encounter accomplishes nothing.
 *
 * Adding a future encounter-usable item is therefore an entry in
 * {@link ENCOUNTER_USABLE_EFFECT_TYPES}, not a change to any selector.
 */
import type { ItemRow } from '../../db/schema';
import type { ItemEffectType } from '../content/schemas';

/**
 * Effect types that mean something while an encounter is on screen.
 *
 * `capture_bonus_charges` (Microdose) is the only member today: it is a
 * persistent capture buff, so activating it after the reveal is exactly when a
 * player would want to. `restore_energy_full` and `restore_energy_amount` are
 * deliberately absent — energy buys the *next* hunt, and spending one here
 * would be a misclick with no upside.
 */
export const ENCOUNTER_USABLE_EFFECT_TYPES: readonly ItemEffectType[] = [
  'capture_bonus_charges',
];

/**
 * How an item participates in an encounter.
 *
 *   - `direct`     — chosen now, consumed only when Capture is committed.
 *                    Charms, the restraints, Mythic Contract.
 *   - `consumable` — activated and consumed *immediately*, then applied to
 *                    this and later attempts while charges remain. Microdose.
 *
 * The distinction is the whole reason the two are labelled differently in the
 * UI: one is a plan, the other is a purchase.
 */
export type EncounterItemKind = 'direct' | 'consumable';

/** True when the item is spent on the capture attempt itself. */
export function isDirectCaptureItem(item: ItemRow): boolean {
  return item.enabled && item.category === 'capture';
}

/**
 * True when the item's effect is one that alters a capture attempt, and is
 * therefore worth offering mid-encounter.
 *
 * Note this asks about `effect_type`, never about `category` — which is the
 * bug this module exists to prevent recurring.
 */
export function isEncounterConsumable(item: ItemRow): boolean {
  if (!item.enabled || item.effectType == null) return false;
  return ENCOUNTER_USABLE_EFFECT_TYPES.includes(item.effectType as ItemEffectType);
}

/** How this item participates, or null when it has no place in an encounter. */
export function encounterItemKind(item: ItemRow): EncounterItemKind | null {
  if (isDirectCaptureItem(item)) return 'direct';
  if (isEncounterConsumable(item)) return 'consumable';
  return null;
}
