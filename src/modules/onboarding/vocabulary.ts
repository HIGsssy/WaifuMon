/**
 * Equipment onboarding vocabulary — the fixed facts the flow is built on.
 *
 * Import-free apart from a type, so the content schema can require exactly
 * these step keys without pulling the service in.
 *
 * The flow's progress is never stored. It is read back from three things that
 * already exist: the player's level, the `equipment` feature unlock, and which
 * of the three fixed grant keys below have produced an instance. A key names
 * the player and the slot, so each starter is granted at most once per player
 * no matter how often a step is retried, abandoned or replayed.
 */
import type { EquipmentSlot } from '../equipment/vocabulary';

/** Trainer Level at which the onboarding is offered. Read live, never stored. */
export const EQUIPMENT_ONBOARDING_MIN_LEVEL = 35;

/** The flow name carried in custom ids and the content file. */
export const EQUIPMENT_ONBOARDING_FLOW = 'equipment';

/** Every screen of the flow, in order. */
export const EQUIPMENT_ONBOARDING_STEPS = [
  'intro',
  'attack',
  'defense',
  'health',
  'explain',
  'complete',
] as const;
export type EquipmentOnboardingStep = (typeof EQUIPMENT_ONBOARDING_STEPS)[number];

/** The starter for each slot, in the order the flow hands them over. */
export const STARTER_EQUIPMENT: Readonly<Record<EquipmentSlot, string>> = Object.freeze({
  attack: 'rusty_pipe',
  defense: 'scrap_plate',
  health: 'dented_lunchbox',
});

/** Slots in hand-over order. Identical to the slot steps of the flow. */
export const STARTER_SLOTS: readonly EquipmentSlot[] = ['attack', 'defense', 'health'];

/** `player_feature_unlocks.source_ref` for an unlock earned by completing the flow. */
export const EQUIPMENT_ONBOARDING_SOURCE_REF = 'equipment_onboarding:v1';

/**
 * The grant key handed to `grantEquipment` for one starter. Includes the
 * player because grant keys are unique across every player.
 */
export function onboardingGrantKey(playerId: number, slot: EquipmentSlot): string {
  return `onboarding:equipment:${playerId}:${slot}`;
}

/**
 * The key as stored on the instance. `grantEquipment` stores copy `i` of a
 * grant as `${grantKey}:${i}`, and a starter is always one copy.
 */
export function storedOnboardingGrantKey(playerId: number, slot: EquipmentSlot): string {
  return `${onboardingGrantKey(playerId, slot)}:0`;
}

export function isEquipmentOnboardingStep(value: unknown): value is EquipmentOnboardingStep {
  return (
    typeof value === 'string' && (EQUIPMENT_ONBOARDING_STEPS as readonly string[]).includes(value)
  );
}

/** The slot a hand-over step grants, or null for a step that grants nothing. */
export function slotOfStep(step: EquipmentOnboardingStep): EquipmentSlot | null {
  return step === 'attack' || step === 'defense' || step === 'health' ? step : null;
}
