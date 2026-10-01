/**
 * Equipment onboarding — Patch hands over three starters, explains how a
 * Buddy's Current SP becomes ATK / DEF / HP, and the `equipment` feature
 * unlocks.
 *
 * A dedicated coordinator, deliberately **not** a World Encounter: it never
 * touches the encounter tables, cannot expire, cannot be blocked by (or block)
 * a pending encounter, and its content cannot be disabled out from under a
 * player half-way through.
 *
 * ## Nothing new is stored
 *
 * Progress is read back from the player's level, the `equipment` unlock, and
 * the three fixed grant keys (`vocabulary.ts`). That makes every operation
 * resumable and idempotent by construction: a step's grant either exists or
 * it does not, and re-running a step finds it.
 *
 * ## Writes, in order
 *
 *  - The three hand-over steps each grant one starter, in their own
 *    transaction, with `allowDisabled` — the onboarding is an entitlement, not
 *    a drop, so retiring a starter from other sources never strands a player.
 *    Each is a **fixed** grant (`STARTER_ROLLS`): the starters' multipliers are
 *    the same for everyone and nothing here depends on RNG. A replayed grant
 *    reads the original copy back, roll included.
 *  - Completion is one transaction: re-ensure the three grants, require a
 *    Buddy, unlock, then fill only the **empty** slots with the starters. No
 *    loadout is ever written before the unlock exists.
 *
 * Stats are always `combatStats.calculateCombatStats` — the explanation
 * previews the starters with slot overrides before anything is equipped.
 * Feature access is this module's call to make; the stat calculation stays
 * policy-free.
 */
import { eq, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { equipmentDefinitions, players } from '../../db/schema';
import type { Logger } from '../../shared/logger';
import type { OwnedEntry } from '../collection/collectionService';
import type { LoadedContent } from '../content/schemas';
import type { EquipmentOnboardingContent, NpcContent } from '../content/onboardingSchemas';
import type { CombatStatsService } from '../equipment/combatStatsService';
import type { CombatStats } from '../equipment/equipmentMath';
import { toDefinitionView, type EquipmentDefinitionView } from '../equipment/equipmentQueries';
import { isMultiplierInRange } from '../equipment/equipmentRoll';
import type {
  EquipmentService,
  GrantKeyRecord,
  OnboardingEquipResult,
} from '../equipment/equipmentService';
import type { EquipmentSlot } from '../equipment/vocabulary';
import type { FeatureUnlockService } from '../features/featureUnlockService';
import {
  deriveEquipmentOnboardingState,
  equipmentEntryState,
  type EquipmentEntryState,
  type EquipmentOnboardingState,
} from './onboardingState';
import {
  EQUIPMENT_ONBOARDING_FLOW,
  EQUIPMENT_ONBOARDING_SOURCE_REF,
  STARTER_EQUIPMENT,
  STARTER_ROLLS,
  STARTER_SLOTS,
  onboardingGrantKey,
  slotOfStep,
  storedOnboardingGrantKey,
  type EquipmentOnboardingStep,
} from './vocabulary';

// ── View models handed to the presenter ───────────────────────────────────

/** One starter as the hand-over screen shows it. */
export interface StarterItemView {
  slot: EquipmentSlot;
  definition: EquipmentDefinitionView;
  /** The fixed multiplier this starter is (or will be) granted with. */
  multiplierBp: number;
  /** The starter's name as granted — starters are unaffixed, so the base name. */
  displayName: string;
}

export type UnavailableReason = 'disabled' | 'not_eligible' | 'not_ready';

export type EquipmentOnboardingView =
  | { kind: 'intro' }
  | { kind: 'handover'; step: 'attack' | 'defense' | 'health'; item: StarterItemView }
  /** The stat explanation, previewing the starters on the current Buddy. */
  | { kind: 'explain'; stats: CombatStats }
  | { kind: 'needs_buddy' }
  /**
   * The onboarding just finished (or had already). `report` is null when this
   * call did not run the completion — the unlock already existed.
   */
  | { kind: 'complete'; stats: CombatStats; report: OnboardingEquipResult | null }
  /** The read-only Equipment overview, for an unlocked player. */
  | { kind: 'overview'; stats: CombatStats }
  | { kind: 'unavailable'; reason: UnavailableReason };

export interface EquipmentOnboardingSnapshot {
  state: EquipmentOnboardingState;
  entry: EquipmentEntryState;
  level: number;
  unlocked: boolean;
  /** Each starter's onboarding instance, if granted (removed ones included). */
  starters: Record<EquipmentSlot, GrantKeyRecord | null>;
}

export interface OnboardingReadiness {
  ready: boolean;
  missingDefinitions: string[];
  /**
   * Starters whose definition's range no longer contains the fixed
   * `STARTER_ROLLS` value (an admin retuned it). Their grant would be refused,
   * so the flow is not ready rather than failing half-way through.
   */
  invalidStarterRolls: string[];
  contentMissing: boolean;
}

export interface EquipmentOnboardingService {
  /** `EQUIPMENT_ONBOARDING_ENABLED`. */
  isEnabled(): boolean;
  /** Starter definitions and narrative content both present. Ignores the switch. */
  isReady(tx?: DbOrTx): Promise<OnboardingReadiness>;
  getState(playerId: number): Promise<EquipmentOnboardingSnapshot>;
  /** Menu Begin/Resume: the current screen. Writes nothing. */
  open(playerId: number): Promise<EquipmentOnboardingView>;
  /**
   * The button on screen `fromStep` was pressed. Applies that step only if it
   * is still the current one — a stale or double-clicked button repaints the
   * current screen and writes nothing.
   */
  advance(playerId: number, fromStep: EquipmentOnboardingStep): Promise<EquipmentOnboardingView>;
  /** "Gear up": the atomic completion. */
  complete(playerId: number): Promise<EquipmentOnboardingView>;
  /** The read-only overview. Refused (as `not_eligible`) until unlocked. */
  overview(playerId: number): Promise<EquipmentOnboardingView>;
  /** The narrative and its NPC, or null when the content is missing. */
  content(): { flow: EquipmentOnboardingContent; npc: NpcContent | null } | null;
}

export interface EquipmentOnboardingDeps {
  db: Db;
  equipment: Pick<EquipmentService, 'grantEquipment' | 'findByGrantKeys' | 'equipForOnboarding'>;
  featureUnlocks: Pick<FeatureUnlockService, 'isUnlocked' | 'unlock'>;
  combatStats: Pick<CombatStatsService, 'calculateCombatStats'>;
  /** `collection.resolveActiveBuddy` — the canonical, self-healing Buddy read. */
  resolveActiveBuddy(tx: DbOrTx, playerId: number): Promise<OwnedEntry | null>;
  getContent(): LoadedContent;
  /** Read on every call, so a test (or a future live toggle) can flip it. */
  isEnabled(): boolean;
  logger?: Logger | undefined;
}

const STARTER_KEYS = STARTER_SLOTS.map((slot) => STARTER_EQUIPMENT[slot]);

/**
 * Whether a button pressed on screen `fromStep` belongs to the player's
 * current step. The intro is never recorded, so a player whose derived step is
 * still `intro` may be looking at either the intro or the attack hand-over
 * (reached from the intro with no write) — both buttons are live.
 */
export function isCurrentStep(fromStep: EquipmentOnboardingStep, current: EquipmentOnboardingStep): boolean {
  return fromStep === current || (current === 'intro' && fromStep === 'attack');
}

export function createEquipmentOnboardingService(
  deps: EquipmentOnboardingDeps,
): EquipmentOnboardingService {
  const { db, equipment, featureUnlocks, combatStats } = deps;

  function content(): { flow: EquipmentOnboardingContent; npc: NpcContent | null } | null {
    const loaded = deps.getContent();
    const flow = loaded.onboarding?.equipment ?? null;
    if (!flow) return null;
    return { flow, npc: loaded.npcs?.find((n) => n.key === flow.npc) ?? null };
  }

  async function readStarterDefinitions(tx: DbOrTx): Promise<Map<string, EquipmentDefinitionView>> {
    const rows = await tx
      .select()
      .from(equipmentDefinitions)
      .where(inArray(equipmentDefinitions.key, STARTER_KEYS));
    return new Map(rows.map((row) => [row.key, toDefinitionView(row)]));
  }

  async function isReady(tx: DbOrTx = db): Promise<OnboardingReadiness> {
    const found = await readStarterDefinitions(tx);
    const missingDefinitions = STARTER_KEYS.filter((key) => !found.has(key));
    const invalidStarterRolls = STARTER_SLOTS.filter((slot) => {
      const definition = found.get(STARTER_EQUIPMENT[slot]);
      return definition != null && !isMultiplierInRange(definition, STARTER_ROLLS[slot].rolledMultiplierBp);
    }).map((slot) => STARTER_EQUIPMENT[slot]);
    const contentMissing = content() === null;
    return {
      ready: missingDefinitions.length === 0 && invalidStarterRolls.length === 0 && !contentMissing,
      missingDefinitions,
      invalidStarterRolls,
      contentMissing,
    };
  }

  async function readStarters(tx: DbOrTx, playerId: number): Promise<Record<EquipmentSlot, GrantKeyRecord | null>> {
    const keys = STARTER_SLOTS.map((slot) => storedOnboardingGrantKey(playerId, slot));
    const found = await equipment.findByGrantKeys(tx, playerId, keys);
    return {
      attack: found.get(storedOnboardingGrantKey(playerId, 'attack')) ?? null,
      defense: found.get(storedOnboardingGrantKey(playerId, 'defense')) ?? null,
      health: found.get(storedOnboardingGrantKey(playerId, 'health')) ?? null,
    };
  }

  async function getState(playerId: number): Promise<EquipmentOnboardingSnapshot> {
    const [player] = await db.select({ level: players.level }).from(players).where(eq(players.id, playerId));
    const level = player?.level ?? 1;
    const [unlocked, starters, readiness] = await Promise.all([
      featureUnlocks.isUnlocked(playerId, 'equipment'),
      readStarters(db, playerId),
      isReady(),
    ]);
    const state = deriveEquipmentOnboardingState({
      level,
      unlocked,
      granted: {
        attack: starters.attack != null,
        defense: starters.defense != null,
        health: starters.health != null,
      },
      enabled: deps.isEnabled(),
      ready: readiness.ready,
    });
    if (state.phase === 'eligible_unavailable' && deps.isEnabled() && !readiness.ready) {
      deps.logger?.warn(
        { tag: 'equipment-onboarding/not-ready', playerId, ...readiness },
        'equipment onboarding is enabled but not ready — starter definitions missing or out of range, or narrative missing',
      );
    }
    return { state, entry: equipmentEntryState(state), level, unlocked, starters };
  }

  function unavailable(snapshot: EquipmentOnboardingSnapshot): EquipmentOnboardingView {
    if (snapshot.state.phase === 'not_eligible') return { kind: 'unavailable', reason: 'not_eligible' };
    return { kind: 'unavailable', reason: deps.isEnabled() ? 'not_ready' : 'disabled' };
  }

  /** Overrides pointing each slot at its unremoved onboarding instance. */
  function starterOverrides(
    starters: Record<EquipmentSlot, GrantKeyRecord | null>,
  ): Partial<Record<EquipmentSlot, number>> {
    const overrides: Partial<Record<EquipmentSlot, number>> = {};
    for (const slot of STARTER_SLOTS) {
      const record = starters[slot];
      if (record && !record.removed) overrides[slot] = record.equipmentId;
    }
    return overrides;
  }

  async function renderStep(
    playerId: number,
    step: EquipmentOnboardingStep,
    snapshot: EquipmentOnboardingSnapshot,
  ): Promise<EquipmentOnboardingView> {
    if (step === 'intro') return { kind: 'intro' };
    const slot = slotOfStep(step);
    if (slot) {
      const definition = (await readStarterDefinitions(db)).get(STARTER_EQUIPMENT[slot]);
      if (!definition) return { kind: 'unavailable', reason: 'not_ready' };
      return {
        kind: 'handover',
        step: slot,
        item: {
          slot,
          definition,
          multiplierBp: STARTER_ROLLS[slot].rolledMultiplierBp,
          displayName: definition.name,
        },
      };
    }
    if (step === 'explain') {
      const stats = await combatStats.calculateCombatStats(playerId, {
        slotOverrides: starterOverrides(snapshot.starters),
      });
      if (!stats.buddy) return { kind: 'needs_buddy' };
      return { kind: 'explain', stats };
    }
    return overviewOf(playerId);
  }

  async function overviewOf(playerId: number): Promise<EquipmentOnboardingView> {
    return { kind: 'overview', stats: await combatStats.calculateCombatStats(playerId) };
  }

  /** One starter's grant — identical on every call, so retries are no-ops. */
  function starterGrant(playerId: number, slot: EquipmentSlot) {
    return {
      playerId,
      definitionKey: STARTER_EQUIPMENT[slot],
      quantity: 1,
      source: { type: 'onboarding' as const, key: EQUIPMENT_ONBOARDING_FLOW },
      grantKey: onboardingGrantKey(playerId, slot),
      allowDisabled: true,
      roll: { kind: 'fixed' as const, ...STARTER_ROLLS[slot] },
    };
  }

  async function grantStarter(playerId: number, slot: EquipmentSlot): Promise<void> {
    await db.transaction((tx) => equipment.grantEquipment(tx, starterGrant(playerId, slot)));
  }

  async function open(playerId: number): Promise<EquipmentOnboardingView> {
    const snapshot = await getState(playerId);
    if (snapshot.state.phase === 'completed') return overviewOf(playerId);
    if (!snapshot.state.nextStep) return unavailable(snapshot);
    return renderStep(playerId, snapshot.state.nextStep, snapshot);
  }

  async function complete(playerId: number): Promise<EquipmentOnboardingView> {
    const before = await getState(playerId);
    if (before.state.phase === 'completed') {
      return { kind: 'complete', stats: await combatStats.calculateCombatStats(playerId), report: null };
    }
    if (!before.state.nextStep) return unavailable(before);
    // Completion is the `explain` screen's button. From anywhere earlier —
    // a forged or stale click — show the screen the player is actually on.
    if (before.state.nextStep !== 'explain') return renderStep(playerId, before.state.nextStep, before);

    const outcome = await db.transaction(async (tx) => {
      // 1. Unlocked in the meantime (a racing click): nothing to do.
      if (await featureUnlocks.isUnlocked(playerId, 'equipment', tx)) return { kind: 'already' as const };

      // 2. Re-ensure the three grants. Idempotent through their fixed keys;
      //    this only ever creates something if a grant is somehow missing.
      for (const slot of STARTER_SLOTS) {
        await equipment.grantEquipment(tx, starterGrant(playerId, slot));
      }

      // 3. A Buddy is required to finish. Stop before unlocking or equipping.
      const buddy = await deps.resolveActiveBuddy(tx, playerId);
      if (!buddy) return { kind: 'needs_buddy' as const };

      // 4. Unlock, then 5. fill empty slots — the unlock is visible to the
      //    equip through `tx`, and both commit together or not at all.
      await featureUnlocks.unlock(tx, {
        playerId,
        featureKey: 'equipment',
        source: 'onboarding',
        sourceRef: EQUIPMENT_ONBOARDING_SOURCE_REF,
      });
      const starters = await readStarters(tx, playerId);
      const report = await equipment.equipForOnboarding(tx, playerId, starterOverrides(starters));
      return { kind: 'done' as const, report };
    });

    if (outcome.kind === 'needs_buddy') return { kind: 'needs_buddy' };
    const stats = await combatStats.calculateCombatStats(playerId);
    if (outcome.kind === 'done') {
      deps.logger?.info(
        {
          tag: 'equipment-onboarding/completed',
          playerId,
          equipped: outcome.report.equipped.map((e) => e.slot),
          kept: outcome.report.kept.map((e) => e.slot),
          skipped: outcome.report.skipped,
        },
        'equipment onboarding completed — feature unlocked',
      );
    }
    return { kind: 'complete', stats, report: outcome.kind === 'done' ? outcome.report : null };
  }

  return {
    isEnabled: () => deps.isEnabled(),
    isReady,
    getState,
    open,
    content,

    async advance(playerId, fromStep) {
      if (fromStep === 'explain') return complete(playerId);
      const snapshot = await getState(playerId);
      if (snapshot.state.phase === 'completed') return overviewOf(playerId);
      const current = snapshot.state.nextStep;
      if (!current) return unavailable(snapshot);

      if (!isCurrentStep(fromStep, current)) return renderStep(playerId, current, snapshot);

      // The intro writes nothing: hearing Patch out just moves to the first
      // hand-over. Leaving now and coming back shows the intro again.
      if (fromStep === 'intro') return renderStep(playerId, 'attack', snapshot);

      const slot = slotOfStep(fromStep);
      if (!slot) return renderStep(playerId, current, snapshot);
      await grantStarter(playerId, slot);
      const after = await getState(playerId);
      if (!after.state.nextStep) return after.state.phase === 'completed' ? overviewOf(playerId) : unavailable(after);
      return renderStep(playerId, after.state.nextStep, after);
    },

    complete,

    async overview(playerId) {
      if (!(await featureUnlocks.isUnlocked(playerId, 'equipment'))) {
        return { kind: 'unavailable', reason: 'not_eligible' };
      }
      return overviewOf(playerId);
    },
  };
}
