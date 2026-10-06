/**
 * Equipment combat math — the pure domain module.
 *
 * No DB, no Discord, no content loader. `combatStatsService` is the only
 * caller that assembles a player's stats, and it does so exclusively through
 * these functions, which is what keeps every surface (Discord, the Portal, a
 * future Dungeon snapshot) from ever computing a different number.
 *
 *   ATK    = round(Current SP × attack multiplier)
 *   DEF    = round(Current SP × defense multiplier)
 *   MAX HP = round(Current SP × health multiplier)
 *
 * **Current SP**, never Base SP: a level-30 Buddy fights at her level, exactly
 * as she does in boss participation. It comes from `currentSeductivePower`.
 *
 * **No fallbacks.** An empty slot makes its stat *unavailable* (`null`), not
 * weak and not zero. Equipment is a progression unlock for combat activities
 * that will require a complete loadout at entry; existing gameplay does not
 * read these numbers at all. `null` rather than `0` so no consumer can mistake
 * "not equipped" for "equipped with something useless".
 *
 * **Combat modifiers** (formula version 2) are the equipped items' secondary
 * bonuses, summed and capped by `aggregateCombatBonuses` — never here, never
 * by a caller. They are derived on every calculation and stored only inside
 * a snapshot (a Trial attempt, a Delve run).
 */
import type { CombatModifiers } from '../combat/combatTypes';
import { aggregateCombatBonuses, type CombatBonus } from './combatBonuses';
import {
  EQUIPMENT_MULTIPLIER_BP_MAX,
  EQUIPMENT_SLOTS,
  type EquipmentSlot,
} from './vocabulary';

/**
 * Version of the stat derivation.
 *
 * Bumped when the *shape* of the calculation changes (a new term, different
 * rounding, secondary effects entering the arithmetic) — never when a
 * definition's multiplier is retuned. Carried on every `CombatStats`, so a
 * snapshot taken today stays interpretable after the formula moves.
 */
export const EQUIPMENT_FORMULA_VERSION = 2;

/** 10000 bp = ×1.00. */
export const BASIS_POINTS = 10_000;

export { EQUIPMENT_MULTIPLIER_BP_MAX };

/** Which stat each slot produces. */
export const SLOT_STAT: Readonly<Record<EquipmentSlot, keyof CombatStatValues>> = Object.freeze({
  attack: 'attack',
  defense: 'defense',
  health: 'maxHp',
});

/**
 * One derived stat: `round(currentSp × bp / 10000)`, half-up.
 *
 * Computed with integers only. The numerator `currentSp × bp` is an exact
 * integer, and the quotient and remainder are taken separately so the rounding
 * decision is an integer comparison rather than a float that might land a hair
 * either side of .5. The ceiling is far inside `Number.MAX_SAFE_INTEGER`: even
 * an absurd 10,000 SP Buddy with the maximum health multiplier is 8 × 10^8.
 *
 * @throws {RangeError} for a non-integer or negative input — a caller passing
 * a float has already lost precision somewhere, and that is a bug to surface
 * rather than a value to round.
 */
export function deriveStat(currentSp: number, multiplierBp: number): number {
  if (!Number.isInteger(currentSp) || currentSp < 0) {
    throw new RangeError(`currentSp must be a non-negative integer, got ${currentSp}`);
  }
  if (!Number.isInteger(multiplierBp) || multiplierBp < 0) {
    throw new RangeError(`multiplierBp must be a non-negative integer, got ${multiplierBp}`);
  }
  const numerator = currentSp * multiplierBp;
  const quotient = Math.floor(numerator / BASIS_POINTS);
  const remainder = numerator - quotient * BASIS_POINTS;
  return remainder * 2 >= BASIS_POINTS ? quotient + 1 : quotient;
}

// ── The CombatStats shape ─────────────────────────────────────────────────

/** The Buddy whose Current SP the stats are derived from. */
export interface CombatBuddy {
  waifuId: number;
  speciesSlug: string;
  /** Nickname when set, species name otherwise. */
  name: string;
  level: number;
  baseSp: number;
  currentSp: number;
}

/** One equipped item as the calculation saw it. */
export interface CombatSlotItem {
  equipmentId: number;
  definitionKey: string;
  /** The display name — base name plus affix suffix (`equipmentDisplayName`). */
  name: string;
  /** The definition's base name, without any affix. */
  definitionName: string;
  affixKey: string | null;
  rarity: string;
  /**
   * The multiplier this item applies to its slot's stat: the instance's own
   * `rolled_multiplier_bp`, never anything read from the definition.
   */
  multiplierBp: number;
  /** The instance's own rolled combat bonuses; empty for a copy with none. */
  combatBonuses: CombatBonus[];
  rolledProperties: Record<string, unknown>;
}

export interface CombatStatValues {
  attack: number | null;
  defense: number | null;
  maxHp: number | null;
}

export type CombatStatsUnavailableReason = 'no_buddy' | 'incomplete_loadout';

/**
 * The authoritative combat-stat result — and the snapshot shape a future
 * Dungeon run or Boss Attack stores at entry. Everything needed to explain the
 * numbers travels with them, so a stored snapshot is self-describing even
 * after the definitions it names are retuned.
 */
export interface CombatStats {
  formulaVersion: number;
  buddy: CombatBuddy | null;
  loadout: {
    /** Null when the player has never had a loadout written. */
    loadoutId: number | null;
    slots: Record<EquipmentSlot, CombatSlotItem | null>;
  };
  stats: CombatStatValues;
  /**
   * The equipped items' combat bonuses, added up and capped
   * (`aggregateCombatBonuses`). All zero when nothing equipped carries one.
   * Counts whatever is equipped, complete loadout or not.
   */
  combatModifiers: CombatModifiers;
  /** Slots with nothing equipped, in slot order. */
  missingSlots: EquipmentSlot[];
  /** A Buddy is present and every slot is filled. */
  isComplete: boolean;
  /** Why `isComplete` is false; null when it is true. No Buddy wins. */
  unavailableReason: CombatStatsUnavailableReason | null;
  /** Secondary effects that applied. Always empty in V1. */
  appliedEffects: never[];
}

export function emptySlots(): Record<EquipmentSlot, CombatSlotItem | null> {
  return { attack: null, defense: null, health: null };
}

/**
 * Assemble a `CombatStats` from a Buddy and a resolved set of slots. Pure: the
 * service resolves ownership, the Buddy and Current SP; this only does the
 * arithmetic and the bookkeeping, so every rule about `null` lives in one
 * place a unit test can pin.
 */
export function assembleCombatStats(input: {
  buddy: CombatBuddy | null;
  loadoutId: number | null;
  slots: Record<EquipmentSlot, CombatSlotItem | null>;
}): CombatStats {
  const { buddy, loadoutId } = input;
  const slots = { ...emptySlots(), ...input.slots };
  const stats: CombatStatValues = { attack: null, defense: null, maxHp: null };
  const missingSlots: EquipmentSlot[] = [];

  for (const slot of EQUIPMENT_SLOTS) {
    const item = slots[slot];
    if (item == null) {
      missingSlots.push(slot);
      continue;
    }
    if (buddy != null) stats[SLOT_STAT[slot]] = deriveStat(buddy.currentSp, item.multiplierBp);
  }

  const unavailableReason: CombatStatsUnavailableReason | null =
    buddy == null ? 'no_buddy' : missingSlots.length > 0 ? 'incomplete_loadout' : null;

  return {
    formulaVersion: EQUIPMENT_FORMULA_VERSION,
    buddy,
    loadout: { loadoutId, slots },
    stats,
    combatModifiers: aggregateCombatBonuses(EQUIPMENT_SLOTS.map((slot) => slots[slot])).modifiers,
    missingSlots,
    isComplete: unavailableReason == null,
    unavailableReason,
    appliedEffects: [],
  };
}
