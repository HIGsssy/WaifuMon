/**
 * Building and checking combat state.
 *
 * `createCombatState` is how every fight begins; `assertValidCombatState` is
 * what the resolver runs on every state it is handed, so a corrupted or
 * hand-edited persisted fight is refused loudly instead of producing nonsense
 * numbers.
 */
import { CombatStateInvalidError } from '../../shared/errors';
import { DEFAULT_DAMAGE_VARIANCE, isValidDamageVariance } from './combatMath';
import {
  COMBAT_RESULTS,
  isCombatActor,
  type CombatActor,
  type CombatantSnapshot,
  type CombatantState,
  type CombatRules,
  type CombatState,
} from './combatTypes';

/** Default round cap: a fight still standing after 30 full rounds is a draw. */
export const DEFAULT_MAX_ROUNDS = 30;

/** The numeric stats a combatant is built from. Already calculated by the caller. */
export interface CombatantInput {
  id: string;
  name: string;
  attack: number;
  defense: number;
  maxHp: number;
  /** Defaults to `maxHp`. */
  currentHp?: number;
}

export function opponentOf(actor: CombatActor): CombatActor {
  return actor === 'player' ? 'enemy' : 'player';
}

export function createCombatant(input: CombatantInput): CombatantState {
  const combatant: CombatantState = {
    id: input.id,
    name: input.name,
    currentHp: input.currentHp ?? input.maxHp,
    maxHp: input.maxHp,
    attack: input.attack,
    defense: input.defense,
    statuses: [],
    cooldowns: {},
  };
  assertValidCombatant(combatant, 'combatant');
  return combatant;
}

/**
 * A fresh fight: round 1, the player's turn, both sides as given, under the
 * default rules unless `rules` overrides them. Throws `CombatStateInvalidError`
 * for malformed stats, malformed rules, or a side already at 0 HP.
 */
export function createCombatState(input: {
  player: CombatantInput;
  enemy: CombatantInput;
  rules?: Partial<CombatRules>;
}): CombatState {
  const state: CombatState = {
    round: 1,
    turn: 'player',
    status: 'active',
    rules: {
      maxRounds: input.rules?.maxRounds ?? DEFAULT_MAX_ROUNDS,
      damageVariance: { ...(input.rules?.damageVariance ?? DEFAULT_DAMAGE_VARIANCE) },
    },
    player: createCombatant(input.player),
    enemy: createCombatant(input.enemy),
  };
  assertValidCombatState(state);
  return state;
}

export function combatantSnapshot(c: CombatantState): CombatantSnapshot {
  return { id: c.id, name: c.name, currentHp: c.currentHp, maxHp: c.maxHp };
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new CombatStateInvalidError(message);
}

export function assertValidCombatant(value: unknown, label: string): asserts value is CombatantState {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const c = value;
  if (typeof c.id !== 'string' || c.id.length === 0) fail(`${label}.id must be a non-empty string`);
  if (typeof c.name !== 'string') fail(`${label}.name must be a string`);
  for (const stat of ['attack', 'defense', 'currentHp', 'maxHp'] as const) {
    if (!isNonNegativeInt(c[stat])) {
      fail(`${label}.${stat} must be a non-negative integer, got ${String(c[stat])}`);
    }
  }
  const maxHp = c.maxHp as number;
  const currentHp = c.currentHp as number;
  if (maxHp < 1) fail(`${label}.maxHp must be at least 1`);
  if (currentHp > maxHp) fail(`${label}.currentHp ${currentHp} exceeds maxHp ${maxHp}`);
  if (!Array.isArray(c.statuses)) fail(`${label}.statuses must be an array`);
  if (!isPlainObject(c.cooldowns)) fail(`${label}.cooldowns must be an object`);
}

/** Throws `CombatStateInvalidError` unless `value` is a well-formed combat state. */
export function assertValidCombatState(value: unknown): asserts value is CombatState {
  if (!isPlainObject(value)) fail('combat state must be an object');
  const s = value;
  if (!isPlainObject(s.rules) || !isNonNegativeInt(s.rules.maxRounds) || s.rules.maxRounds < 1) {
    fail('rules.maxRounds must be a positive integer');
  }
  if (!isValidDamageVariance(s.rules.damageVariance)) {
    fail('rules.damageVariance must be integer basis points with 1 <= min <= max');
  }
  if (!isNonNegativeInt(s.round) || s.round < 1) fail(`round must be a positive integer, got ${String(s.round)}`);
  if (s.round > s.rules.maxRounds) {
    fail(`round ${s.round} exceeds rules.maxRounds ${s.rules.maxRounds}`);
  }
  if (!isCombatActor(s.turn)) fail(`turn must be "player" or "enemy", got ${String(s.turn)}`);
  const validStatus = s.status === 'active' || (COMBAT_RESULTS as readonly unknown[]).includes(s.status);
  if (!validStatus) fail(`status is not a combat status: ${String(s.status)}`);
  assertValidCombatant(s.player, 'player');
  assertValidCombatant(s.enemy, 'enemy');
  if (s.status === 'active' && (s.player.currentHp === 0 || s.enemy.currentHp === 0)) {
    fail('an active fight cannot have a combatant at 0 HP');
  }
}
