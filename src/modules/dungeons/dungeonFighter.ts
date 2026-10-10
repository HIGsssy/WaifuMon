/**
 * The Buddy and stats a run fights with, snapshotted at start and never
 * recalculated. Self-describing, so the run screen needs nothing live:
 * changing gear or the active Buddy elsewhere never reaches a run in progress.
 */
import { CombatBuddyRequiredError, CombatLoadoutIncompleteError } from '../../shared/errors';
import type { CombatModifiers } from '../combat/combatTypes';
import type { CombatBonus } from '../equipment/combatBonuses';
import type { CombatStats } from '../equipment/equipmentMath';
import { EQUIPMENT_SLOTS, type EquipmentSlot } from '../equipment/vocabulary';

export { fighterModifiers } from './engine/combat';

export interface DungeonFighterGear {
  equipmentId: number;
  definitionKey: string;
  /** Display name — base name plus affix suffix — as it read at the start. */
  name: string;
  rarity: string;
  multiplierBp: number;
  /** The item's own rolled combat bonuses at the start. */
  combatBonuses?: CombatBonus[];
}

export interface DungeonFighter {
  /** `EQUIPMENT_FORMULA_VERSION` the stats were derived under. */
  formulaVersion: number;
  waifuId: number;
  speciesSlug: string;
  name: string;
  level: number;
  currentSp: number;
  attack: number;
  defense: number;
  maxHp: number;
  /** The aggregated, capped combat modifiers, frozen at start like ATK / DEF / HP. */
  modifiers?: CombatModifiers;
  gear: Record<EquipmentSlot, DungeonFighterGear>;
}

/**
 * Freeze a combat-stat calculation into a run's fighter.
 *
 * @throws {CombatBuddyRequiredError} without an active Buddy.
 * @throws {CombatLoadoutIncompleteError} with an empty Attack, Defense or Health slot.
 */
export function fighterFromCombatStats(stats: CombatStats): DungeonFighter {
  if (stats.buddy == null) throw new CombatBuddyRequiredError();
  const { attack, defense, maxHp } = stats.stats;
  if (!stats.isComplete || attack == null || defense == null || maxHp == null) {
    throw new CombatLoadoutIncompleteError();
  }
  const gear = {} as Record<EquipmentSlot, DungeonFighterGear>;
  for (const slot of EQUIPMENT_SLOTS) {
    const item = stats.loadout.slots[slot]!;
    gear[slot] = {
      equipmentId: item.equipmentId,
      definitionKey: item.definitionKey,
      name: item.name,
      rarity: item.rarity,
      multiplierBp: item.multiplierBp,
      combatBonuses: item.combatBonuses.map((b) => ({ ...b })),
    };
  }
  return {
    formulaVersion: stats.formulaVersion,
    waifuId: stats.buddy.waifuId,
    speciesSlug: stats.buddy.speciesSlug,
    name: stats.buddy.name,
    level: stats.buddy.level,
    currentSp: stats.buddy.currentSp,
    attack,
    defense,
    maxHp,
    modifiers: { ...stats.combatModifiers },
    gear,
  };
}
