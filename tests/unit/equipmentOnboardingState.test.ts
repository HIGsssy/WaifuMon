/**
 * The Equipment onboarding's derived state — every rule about who is offered
 * what, pinned as a table. Nothing about progress is stored, so this function
 * *is* the state machine.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveEquipmentOnboardingState,
  equipmentEntryState,
  equipmentOnboardingLevelLabels,
  type EquipmentOnboardingStateInput,
} from '../../src/modules/onboarding/onboardingState';
import {
  EQUIPMENT_ONBOARDING_MIN_LEVEL,
  EQUIPMENT_ONBOARDING_STEPS,
  STARTER_EQUIPMENT,
  isEquipmentOnboardingStep,
  onboardingGrantKey,
  slotOfStep,
  storedOnboardingGrantKey,
} from '../../src/modules/onboarding/vocabulary';
import { isCurrentStep } from '../../src/modules/onboarding/equipmentOnboardingService';

const NONE = { attack: false, defense: false, health: false };
const base: EquipmentOnboardingStateInput = { level: 35, unlocked: false, granted: NONE, enabled: true, ready: true };

describe('deriveEquipmentOnboardingState', () => {
  it.each<[string, Partial<EquipmentOnboardingStateInput>, string, string | null]>([
    ['level 34, nothing started', { level: 34 }, 'not_eligible', null],
    ['level 1', { level: 1 }, 'not_eligible', null],
    ['level 35, nothing started', {}, 'pending', 'intro'],
    ['level 90, nothing started (existing high-level player)', { level: 90 }, 'pending', 'intro'],
    ['attack granted', { granted: { ...NONE, attack: true } }, 'in_progress', 'defense'],
    ['attack + defense granted', { granted: { attack: true, defense: true, health: false } }, 'in_progress', 'health'],
    ['all three granted', { granted: { attack: true, defense: true, health: true } }, 'in_progress', 'explain'],
    ['a gap resumes at the first missing slot', { granted: { attack: false, defense: true, health: true } }, 'in_progress', 'attack'],
    ['started, then level lowered (staging)', { level: 10, granted: { ...NONE, attack: true } }, 'in_progress', 'defense'],
    ['unlocked', { unlocked: true }, 'completed', null],
    ['unlocked below the level (admin unlock)', { unlocked: true, level: 3 }, 'completed', null],
    ['unlocked while switched off', { unlocked: true, enabled: false }, 'completed', null],
    ['switched off', { enabled: false }, 'eligible_unavailable', null],
    ['switched off mid-flow', { enabled: false, granted: { ...NONE, attack: true } }, 'eligible_unavailable', null],
    ['not ready', { ready: false }, 'eligible_unavailable', null],
    ['level 34, switched off', { level: 34, enabled: false }, 'not_eligible', null],
  ])('%s → %s', (_label, over, phase, nextStep) => {
    const state = deriveEquipmentOnboardingState({ ...base, ...over });
    expect(state.phase).toBe(phase);
    expect(state.nextStep).toBe(nextStep);
  });

  it('reports whether anything was granted', () => {
    expect(deriveEquipmentOnboardingState(base).started).toBe(false);
    expect(deriveEquipmentOnboardingState({ ...base, granted: { ...NONE, health: true } }).started).toBe(true);
  });

  it('is eligible at exactly the minimum level', () => {
    expect(EQUIPMENT_ONBOARDING_MIN_LEVEL).toBe(35);
    expect(deriveEquipmentOnboardingState({ ...base, level: 35 }).phase).toBe('pending');
    expect(deriveEquipmentOnboardingState({ ...base, level: 34 }).phase).toBe('not_eligible');
  });
});

describe('equipmentEntryState (what the menu shows)', () => {
  it.each<[Partial<EquipmentOnboardingStateInput>, string]>([
    [{ level: 34 }, 'hidden'],
    [{ enabled: false }, 'hidden'],
    [{ ready: false }, 'hidden'],
    [{}, 'begin'],
    [{ granted: { ...NONE, attack: true } }, 'resume'],
    [{ granted: { attack: true, defense: true, health: true } }, 'resume'],
    [{ unlocked: true }, 'available'],
    [{ unlocked: true, enabled: false }, 'available'],
  ])('%j → %s', (over, entry) => {
    expect(equipmentEntryState(deriveEquipmentOnboardingState({ ...base, ...over }))).toBe(entry);
  });
});

describe('grant keys and steps', () => {
  it('builds per-player, per-slot keys in the Phase 1 per-copy form', () => {
    expect(onboardingGrantKey(42, 'attack')).toBe('onboarding:equipment:42:attack');
    expect(storedOnboardingGrantKey(42, 'health')).toBe('onboarding:equipment:42:health:0');
    expect(onboardingGrantKey(42, 'attack')).not.toBe(onboardingGrantKey(43, 'attack'));
  });

  it('names the three starters', () => {
    expect(STARTER_EQUIPMENT).toEqual({ attack: 'rusty_pipe', defense: 'scrap_plate', health: 'dented_lunchbox' });
  });

  it('has six steps in order, three of which grant', () => {
    expect(EQUIPMENT_ONBOARDING_STEPS).toEqual(['intro', 'attack', 'defense', 'health', 'explain', 'complete']);
    expect(EQUIPMENT_ONBOARDING_STEPS.map(slotOfStep)).toEqual([null, 'attack', 'defense', 'health', null, null]);
    expect(isEquipmentOnboardingStep('explain')).toBe(true);
    expect(isEquipmentOnboardingStep('gear_up')).toBe(false);
    expect(isEquipmentOnboardingStep(undefined)).toBe(false);
  });
});

describe('equipmentOnboardingLevelLabels', () => {
  const label = '🔧 Equipment training available — check the Waifumon menu.';

  it('labels exactly the onboarding level while enabled', () => {
    expect(equipmentOnboardingLevelLabels(35, { enabled: true, label })).toEqual([label]);
    expect(equipmentOnboardingLevelLabels(34, { enabled: true, label })).toEqual([]);
    expect(equipmentOnboardingLevelLabels(36, { enabled: true, label })).toEqual([]);
  });

  it('says nothing while disabled or without content', () => {
    expect(equipmentOnboardingLevelLabels(35, { enabled: false, label })).toEqual([]);
    expect(equipmentOnboardingLevelLabels(35, { enabled: true, label: null })).toEqual([]);
  });
});

describe('isCurrentStep (which buttons are live)', () => {
  it('accepts the current step, and the attack hand-over while the intro is current', () => {
    expect(isCurrentStep('defense', 'defense')).toBe(true);
    expect(isCurrentStep('intro', 'intro')).toBe(true);
    // The intro is never recorded: its button leads to the attack screen with no write.
    expect(isCurrentStep('attack', 'intro')).toBe(true);
  });

  it('refuses stale and skipped-ahead buttons', () => {
    expect(isCurrentStep('intro', 'attack')).toBe(false);
    expect(isCurrentStep('attack', 'defense')).toBe(false);
    expect(isCurrentStep('health', 'defense')).toBe(false);
    expect(isCurrentStep('defense', 'intro')).toBe(false);
    expect(isCurrentStep('explain', 'health')).toBe(false);
  });
});
