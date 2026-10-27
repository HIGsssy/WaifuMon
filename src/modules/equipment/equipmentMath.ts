/**
 * Equipment combat math — the pure domain module.
 *
 * No DB, no Discord, no content loader. `combatStatsService` is the only
 * caller that assembles a player's stats, and it does so exclusively through
 * these functions, which is what keeps every surface (Discord, the Portal, a
 * future Dungeon snapshot) from ever computing a different number.
 *
 *   effective SP = Current SP + equipped flat SP          (formula version 3)
 *   ATK    = round(effective SP × attack multiplier)
 *   DEF    = round(effective SP × defense multiplier)
 *   MAX HP = round(effective SP × health multiplier)
 *
 * **Current SP**, never Base SP: a level-30 Buddy fights at her level, exactly
 * as she does in boss participation. It comes from `currentSeductivePower`
 * and is never changed here — `CombatBuddy.currentSp` stays the natural value
 * that progression, bosses, World Encounters and dungeon event checks read.
 *
 * **Flat SP** (Equipment 3.0) is the equipped copies' stored primary
 * `rolled_properties.flatSp` plus their additional `flat_sp` bonuses, summed
 * once ({@link flatSpOf}) and added before any stat is derived — so a flat SP
 * copy in one slot raises all three stats. Every term is a stored integer, so
 * nothing can feed back into itself. Without flat SP the numbers are exactly
 * formula version 2's.
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
import { additionalFlatSpOf, aggregateCombatBonuses, type CombatBonus } from './combatBonuses';
import {
  EQUIPMENT_FLAT_SP_MAX_PER_ITEM,
  EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT,
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
 *
 *  - 1 — fixed multipliers.
 *  - 2 — combat modifiers from rolled bonuses.
 *  - 3 — effective SP: equipped flat SP is added before stats are derived.
 *    Identical to 2 for a loadout without flat SP.
 */
export const EQUIPMENT_FORMULA_VERSION = 3;

/** 10000 bp = ×1.00. */
export const BASIS_POINTS = 10_000;

export { EQUIPMENT_MULTIPLIER_BP_MAX };

// ── Flat SP ───────────────────────────────────────────────────────────────

/** The `rolled_properties` key holding a copy's primary flat SP. */
export const PRIMARY_FLAT_SP_PROPERTY = 'flatSp';

/**
 * A copy's stored primary flat SP. Anything that is not a non-negative whole
 * number — `{}` on every pre-3.0 copy, a malformed value — reads as 0. Never
 * throws: an owned item must always load.
 */
export function readPrimaryFlatSp(rolledProperties: unknown): number {
  if (rolledProperties == null || typeof rolledProperties !== 'object' || Array.isArray(rolledProperties)) return 0;
  const value = (rolledProperties as Record<string, unknown>)[PRIMARY_FLAT_SP_PROPERTY];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** One copy's flat SP as stored, and what it contributes after the per-copy ceiling. */
export interface ItemFlatSp {
  primary: number;
  additional: number;
  /** `min(primary + additional, EQUIPMENT_FLAT_SP_MAX_PER_ITEM)`. */
  contribution: number;
}

export function itemFlatSpOf(
  item: { rolledProperties?: unknown; combatBonuses?: readonly CombatBonus[] | null } | null | undefined,
): ItemFlatSp {
  if (item == null) return { primary: 0, additional: 0, contribution: 0 };
  const primary = readPrimaryFlatSp(item.rolledProperties);
  const additional = Math.max(0, additionalFlatSpOf(item.combatBonuses));
  return { primary, additional, contribution: Math.min(primary + additional, EQUIPMENT_FLAT_SP_MAX_PER_ITEM) };
}

/** A Buddy's SP as one calculation used it. */
export interface CombatSp {
  /** Current SP from level and Base SP — the progression value, untouched. */
  natural: number;
  /** Sum of the equipped copies' stored primary flat SP. */
  primaryFlat: number;
  /** Sum of the equipped copies' stored additional `flat_sp` bonuses. */
  additionalFlat: number;
  /** What equipment adds to SP, after the per-copy and per-loadout ceilings. */
  equipmentBonus: number;
  /** `natural + equipmentBonus` — the SP every derived stat uses. */
  effective: number;
  /** True when a ceiling reduced `equipmentBonus` below `primaryFlat + additionalFlat`. */
  capped: boolean;
}

/**
 * The per-loadout flat SP ceiling a calculation applies: the published rules'
 * `flatSpLimits.perLoadoutMax` when the caller has it (Equipment 3.0), never
 * above the code rail {@link EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT}; the rail
 * itself otherwise. Published configuration can only lower it.
 */
export function loadoutFlatSpCeiling(limits?: { perLoadoutMax: number } | null): number {
  const configured = limits?.perLoadoutMax;
  return Number.isSafeInteger(configured) && configured! >= 0
    ? Math.min(configured!, EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT)
    : EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT;
}

/**
 * **The** flat SP sum. Each equipped copy counts once: its primary and
 * additional flat SP, held to the per-copy ceiling; then the loadout total,
 * held to the per-loadout ceiling ({@link loadoutFlatSpCeiling}).
 * Deterministic and lossless for storage — stored values are never
 * rewritten; only the amount added to SP is clamped (the same model
 * `aggregateCombatBonuses` applies to combat modifiers). Empty slots
 * contribute nothing.
 */
export function flatSpOf(
  items: Iterable<{ rolledProperties?: unknown; combatBonuses?: readonly CombatBonus[] | null } | null | undefined>,
  limits?: { perLoadoutMax: number } | null,
): Pick<CombatSp, 'primaryFlat' | 'additionalFlat' | 'equipmentBonus' | 'capped'> {
  let primaryFlat = 0;
  let additionalFlat = 0;
  let contributions = 0;
  for (const item of items) {
    const sp = itemFlatSpOf(item);
    primaryFlat += sp.primary;
    additionalFlat += sp.additional;
    contributions += sp.contribution;
  }
  const equipmentBonus = Math.min(contributions, loadoutFlatSpCeiling(limits));
  return { primaryFlat, additionalFlat, equipmentBonus, capped: equipmentBonus < primaryFlat + additionalFlat };
}

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
  /** The instance's own rolled combat bonuses (a `flat_sp` entry included); empty for a copy with none. */
  combatBonuses: CombatBonus[];
  /** Stored rolled properties — `{ flatSp }` for primary flat SP, `{}` otherwise. */
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
  /**
   * Natural, equipment and effective SP (formula 3). Null without a Buddy.
   * Absent from snapshots taken under formula 2 — readers must tolerate that.
   */
  sp: CombatSp | null;
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
  /** The published flat SP limits; omitted, the code rails apply. */
  flatSpLimits?: { perLoadoutMax: number } | null;
}): CombatStats {
  const { buddy, loadoutId } = input;
  const slots = { ...emptySlots(), ...input.slots };
  const stats: CombatStatValues = { attack: null, defense: null, maxHp: null };
  const missingSlots: EquipmentSlot[] = [];

  // Flat SP first, once, from every equipped copy — so it reaches all three
  // stats, whichever slot carries it.
  const flat = flatSpOf(
    EQUIPMENT_SLOTS.map((slot) => slots[slot]),
    input.flatSpLimits,
  );
  const sp: CombatSp | null =
    buddy == null ? null : { natural: buddy.currentSp, ...flat, effective: buddy.currentSp + flat.equipmentBonus };

  for (const slot of EQUIPMENT_SLOTS) {
    const item = slots[slot];
    if (item == null) {
      missingSlots.push(slot);
      continue;
    }
    if (sp != null) stats[SLOT_STAT[slot]] = deriveStat(sp.effective, item.multiplierBp);
  }

  const unavailableReason: CombatStatsUnavailableReason | null =
    buddy == null ? 'no_buddy' : missingSlots.length > 0 ? 'incomplete_loadout' : null;

  return {
    formulaVersion: EQUIPMENT_FORMULA_VERSION,
    buddy,
    sp,
    loadout: { loadoutId, slots },
    stats,
    combatModifiers: aggregateCombatBonuses(EQUIPMENT_SLOTS.map((slot) => slots[slot])).modifiers,
    missingSlots,
    isComplete: unavailableReason == null,
    unavailableReason,
    appliedEffects: [],
  };
}
