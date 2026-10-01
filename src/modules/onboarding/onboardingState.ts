/**
 * Equipment onboarding state — derived, never stored.
 *
 * Pure, so every rule about who is offered what lives in one function a table
 * test can pin. The service gathers the inputs; this only decides.
 *
 *   not_eligible          level < 35, not started, not unlocked
 *   eligible_unavailable  eligible or started, but the switch is off or the
 *                         starter definitions / narrative are missing
 *   pending               offered, nothing granted yet         → Begin
 *   in_progress           offered, at least one starter granted → Resume
 *   completed             the `equipment` feature is unlocked, from any source
 *
 * "Interrupted" is not a state: it is `in_progress` with no screen open, and
 * resumes exactly the same way. Once any starter is granted the flow counts as
 * started regardless of level, so lowering a level on staging never hides it.
 */
import type { EquipmentSlot } from '../equipment/vocabulary';
import {
  EQUIPMENT_ONBOARDING_MIN_LEVEL,
  STARTER_SLOTS,
  type EquipmentOnboardingStep,
} from './vocabulary';

export type EquipmentOnboardingPhase =
  | 'not_eligible'
  | 'eligible_unavailable'
  | 'pending'
  | 'in_progress'
  | 'completed';

export interface EquipmentOnboardingStateInput {
  level: number;
  unlocked: boolean;
  /** Whether each starter's grant key has produced an instance (removed ones count). */
  granted: Readonly<Record<EquipmentSlot, boolean>>;
  /** `EQUIPMENT_ONBOARDING_ENABLED`. */
  enabled: boolean;
  /** The three starter definitions and the narrative content all exist. */
  ready: boolean;
  minLevel?: number;
}

export interface EquipmentOnboardingState {
  phase: EquipmentOnboardingPhase;
  /** The screen a Begin/Resume opens. Null unless the flow is offered. */
  nextStep: EquipmentOnboardingStep | null;
  /** At least one starter has been granted. */
  started: boolean;
}

export function deriveEquipmentOnboardingState(
  input: EquipmentOnboardingStateInput,
): EquipmentOnboardingState {
  const started = STARTER_SLOTS.some((slot) => input.granted[slot]);
  if (input.unlocked) return { phase: 'completed', nextStep: null, started };

  const minLevel = input.minLevel ?? EQUIPMENT_ONBOARDING_MIN_LEVEL;
  if (!started && input.level < minLevel) return { phase: 'not_eligible', nextStep: null, started };
  if (!input.enabled || !input.ready) {
    return { phase: 'eligible_unavailable', nextStep: null, started };
  }
  if (!started) return { phase: 'pending', nextStep: 'intro', started };

  const missing = STARTER_SLOTS.find((slot) => !input.granted[slot]);
  return { phase: 'in_progress', nextStep: missing ?? 'explain', started };
}

/** What the main menu shows. The only thing the menu consults. */
export type EquipmentEntryState = 'hidden' | 'begin' | 'resume' | 'available';

/**
 * `completed` is `available` even with the switch off: the switch gates the
 * onboarding, never an unlock a player already has.
 */
export function equipmentEntryState(state: EquipmentOnboardingState): EquipmentEntryState {
  switch (state.phase) {
    case 'completed':
      return 'available';
    case 'pending':
      return 'begin';
    case 'in_progress':
      return 'resume';
    default:
      return 'hidden';
  }
}

/**
 * The level-up labels the Equipment onboarding contributes: its content's
 * `levelUpLabel` on the level that makes a player eligible, while the
 * onboarding is switched on. Wired into `progression.extraLevelRewardLabels`.
 */
export function equipmentOnboardingLevelLabels(
  level: number,
  opts: { enabled: boolean; label: string | null | undefined; minLevel?: number },
): string[] {
  const minLevel = opts.minLevel ?? EQUIPMENT_ONBOARDING_MIN_LEVEL;
  return opts.enabled && level === minLevel && opts.label ? [opts.label] : [];
}
