/**
 * Player-side combatant construction.
 *
 * The caller supplies stats it already calculated — in practice
 * `combatStatsService.calculateCombatStats` (or `snapshotCombatStats` for a
 * fight frozen at entry). Combat never calls Equipment; it only accepts the
 * shape `CombatStats` already has, structurally, so combat imports nothing
 * from Equipment. (Equipment imports the modifier caps from `combatMath.ts`:
 * the caps are combat rules, and `aggregateCombatBonuses` applies them.)
 */
import { CombatStateInvalidError } from '../../shared/errors';
import type { CombatantInput } from './combatState';
import type { CombatModifiers } from './combatTypes';

/** Structurally `CombatStats['stats']` — null means the slot is empty. */
export interface PlayerCombatStatValues {
  attack: number | null;
  defense: number | null;
  maxHp: number | null;
}

/** Structurally `CombatStats['buddy']` — only the fields combat needs. */
export interface PlayerCombatBuddy {
  waifuId: number;
  name: string;
}

/**
 * The engine input for the player's Buddy. Id is `buddy:<waifuId>`. Throws
 * `CombatStateInvalidError` when there is no Buddy or a stat is unavailable —
 * combat entry requires a complete loadout, and an incomplete one must be
 * refused before a fight is created, not fought at zero.
 */
export function playerCombatantInput(input: {
  buddy: PlayerCombatBuddy | null;
  stats: PlayerCombatStatValues;
  /** Structurally `CombatStats['combatModifiers']` — aggregated and capped. Omitted = none. */
  modifiers?: CombatModifiers;
}): CombatantInput {
  const { buddy, stats } = input;
  if (buddy == null) throw new CombatStateInvalidError('player combatant needs an active Buddy');
  if (stats.attack == null || stats.defense == null || stats.maxHp == null) {
    throw new CombatStateInvalidError('player combatant needs ATK, DEF and HP (incomplete loadout)');
  }
  return {
    id: `buddy:${buddy.waifuId}`,
    name: buddy.name,
    attack: stats.attack,
    defense: stats.defense,
    maxHp: stats.maxHp,
    ...(input.modifiers ? { modifiers: input.modifiers } : {}),
  };
}
