/**
 * One wave of a dungeon fight.
 *
 * No dungeon-specific combat math. A wave builds an ordinary `CombatState` —
 * the fighter's snapshotted ATK / DEF / max HP and modifiers at the run's
 * *current* HP, against the snapshotted enemy at full HP — and runs the
 * existing engine to the end with the basic-attack controllers on both sides.
 * Waves are sequential one-versus-one fights; HP is the only thing carried
 * from one to the next.
 */
import { rollWeighted } from '../../../shared/random';
import { basicAttackController } from '../../combat/combatController';
import { ZERO_COMBAT_MODIFIERS, clampCombatModifiers } from '../../combat/combatMath';
import { simulateCombat } from '../../combat/combatSimulator';
import { createCombatState } from '../../combat/combatState';
import type { CombatEvent, CombatModifiers, CombatRules } from '../../combat/combatTypes';
import { enemyCombatantInput, type CombatEnemyDefinition } from '../../combat/enemyDefinitions';
import type { CombatWave } from '../content/dungeonDefinition';
import type { DungeonRngSource, DungeonWaveResult, EngineDependencies, EngineFighter } from './types';

/** The modifiers a run's fighter fights with; all zero when the snapshot carries none. */
export function fighterModifiers(fighter: Pick<EngineFighter, 'modifiers'>): CombatModifiers {
  try {
    return clampCombatModifiers(fighter.modifiers);
  } catch {
    return { ...ZERO_COMBAT_MODIFIERS };
  }
}

/** A wave could not be fought because the run's snapshot lacks what it names. */
export class DungeonEngineContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DungeonEngineContentError';
  }
}

/**
 * Which enemy a wave fields in this run. A pooled wave draws once from its own
 * stream, keyed by where the wave is — so the answer is the same before the
 * fight (for the screen), during it, and on any later read.
 */
export function selectWaveEnemy(
  wave: CombatWave,
  place: { roomId: string; actionId: string; waveIndex: number },
  dependencies: EngineDependencies,
  rng: DungeonRngSource,
): CombatEnemyDefinition {
  const key =
    'key' in wave.enemy
      ? wave.enemy.key
      : rollWeighted(
          wave.enemy.pool.map((e) => ({ weight: e.weight, value: e.key })),
          rng.stream('enemy', place.roomId, place.actionId, place.waveIndex),
        );
  const enemy = dependencies.enemies[key];
  if (!enemy) {
    throw new DungeonEngineContentError(
      `room "${place.roomId}" action "${place.actionId}" wave ${place.waveIndex + 1} names enemy "${key}", which the run's snapshot lacks`,
    );
  }
  return enemy;
}

export interface WaveFight {
  result: DungeonWaveResult;
  /** The engine's structured events — for the run history, never shown raw. */
  events: CombatEvent[];
}

export function fightWave(input: {
  fighter: EngineFighter;
  currentHp: number;
  enemy: CombatEnemyDefinition;
  waveIndex: number;
  combatSeed: number;
  rng: DungeonRngSource;
  place: { roomId: string; actionId: string };
  rules?: Partial<CombatRules> | undefined;
}): WaveFight {
  const { fighter, currentHp, enemy, waveIndex, combatSeed } = input;
  const initial = createCombatState({
    player: {
      id: `buddy:${fighter.waifuId}`,
      name: fighter.name,
      attack: fighter.attack,
      defense: fighter.defense,
      maxHp: fighter.maxHp,
      currentHp,
      modifiers: fighterModifiers(fighter),
    },
    enemy: enemyCombatantInput(enemy),
    ...(input.rules ? { rules: input.rules } : {}),
  });
  const outcome = simulateCombat(
    initial,
    { player: basicAttackController, enemy: basicAttackController },
    { rng: input.rng.stream('combat', input.place.roomId, input.place.actionId, waveIndex) },
  );
  return {
    result: {
      waveIndex,
      enemyKey: enemy.key,
      enemyName: enemy.name,
      result: outcome.result,
      reason: outcome.reason,
      rounds: outcome.rounds,
      hpBefore: currentHp,
      hpAfter: outcome.finalState.player.currentHp,
      enemyMaxHp: initial.enemy.maxHp,
      enemyHpAfter: outcome.finalState.enemy.currentHp,
      lifestealHealed: outcome.events.reduce(
        (sum, e) => (e.type === 'lifesteal_heal' && e.actor === 'player' ? sum + e.amount : sum),
        0,
      ),
      playerCrits: outcome.events.filter((e) => e.type === 'critical_hit' && e.actor === 'player').length,
      playerBonusAttacks: outcome.events.filter((e) => e.type === 'bonus_attack_triggered' && e.actor === 'player').length,
      combatSeed,
    },
    events: outcome.events,
  };
}
