/**
 * Combat engine types — state, actions, events and results.
 *
 * Everything here is **plain JSON data**: no classes, functions, Maps, Dates
 * or `undefined`-valued keys. A `CombatState` survives `JSON.stringify` /
 * `JSON.parse` unchanged, which is what lets a future interactive fight park
 * its state between button presses or API calls and resume it with the same
 * resolver.
 *
 * Kept free of runtime imports: no DB, no Discord, no Equipment. The engine
 * operates on numeric combatants that a caller has already built (see
 * `combatants.ts`).
 *
 * See `docs/combat-system.md` for the model as a whole.
 */
import type { Rng } from '../../shared/random';

/** The two sides of a V1 fight. */
export const COMBAT_ACTORS = ['player', 'enemy'] as const;
export type CombatActor = (typeof COMBAT_ACTORS)[number];

export function isCombatActor(value: unknown): value is CombatActor {
  return value === 'player' || value === 'enemy';
}

/** The terminal results. `draw` is only reached through the round limit in V1. */
export const COMBAT_RESULTS = ['player_victory', 'enemy_victory', 'draw'] as const;
export type CombatResultKind = (typeof COMBAT_RESULTS)[number];

export type CombatStatus = 'active' | CombatResultKind;

/**
 * A status effect on a combatant. **Reserved shape** — V1 never adds one and
 * no mechanic reads them; the field exists so abilities can arrive without
 * reshaping the state.
 */
export interface CombatStatusState {
  key: string;
  /** Turns left; null for "until removed". */
  remainingTurns: number | null;
  stacks: number;
}

export interface CombatantState {
  /** Caller-chosen stable id (`buddy:123`, `enemy:scrapyard_drone`). Opaque to the engine. */
  id: string;
  /** Display name, carried for presenters. The engine never formats it. */
  name: string;

  currentHp: number;
  maxHp: number;

  attack: number;
  defense: number;

  /** Always empty in V1. */
  statuses: CombatStatusState[];
  /** Ability key → turns until usable. Always empty in V1. */
  cooldowns: Record<string, number>;
}

/** Rules a fight was started under. Stored on the state so a resumed fight keeps them. */
export interface CombatRules {
  /**
   * The fight ends in a draw when round `maxRounds` completes with both sides
   * standing. See `combatEngine.ts` for the round convention.
   */
  maxRounds: number;
  /**
   * The range each hit's damage factor is rolled in (see `combatMath.ts`).
   * `{ 10000, 10000 }` is a fight with no variance.
   */
  damageVariance: { minBasisPoints: number; maxBasisPoints: number };
}

export interface CombatState {
  /** 1-based. Round 1 opens with the player's turn. */
  round: number;
  /** Whose action the engine will accept next. Meaningless once `status` is terminal. */
  turn: CombatActor;
  status: CombatStatus;
  rules: CombatRules;

  player: CombatantState;
  enemy: CombatantState;
}

/**
 * Something a combatant does on its turn — the one input to
 * `resolveCombatAction`. A Discord button, a dungeon client and an AI
 * controller all submit this same shape.
 *
 * Only `basic_attack` executes in V1. `special` and `defend` are part of the
 * vocabulary so callers and presenters are written against the final union,
 * but the engine refuses them (`unsupported_action`).
 */
export type CombatAction =
  | { type: 'basic_attack'; actor: CombatActor }
  | { type: 'special'; actor: CombatActor; abilityKey: string }
  | { type: 'defend'; actor: CombatActor };

export type CombatActionType = CombatAction['type'];

/** Action types the V1 engine executes. */
export const SUPPORTED_COMBAT_ACTIONS: readonly CombatActionType[] = ['basic_attack'];

/** A combatant as an event reports it: identity and HP, nothing a presenter must compute. */
export interface CombatantSnapshot {
  id: string;
  name: string;
  currentHp: number;
  maxHp: number;
}

/** Why a fight ended. */
export type CombatEndReason = 'defeat' | 'round_limit';

/**
 * What happened, as data. **No player-facing prose** — presenters (Discord,
 * Portal, a dungeon client) render or animate these; nothing parses strings.
 * Every event carries the round it happened in.
 */
export type CombatEvent =
  | {
      type: 'combat_started';
      round: number;
      player: CombatantSnapshot;
      enemy: CombatantSnapshot;
    }
  | { type: 'turn_started'; round: number; actor: CombatActor }
  | { type: 'action_started'; round: number; actor: CombatActor; action: CombatActionType }
  | {
      type: 'damage';
      round: number;
      actor: CombatActor;
      target: CombatActor;
      /** What the hit dealt: `baseAmount` × the rolled factor, rounded. */
      amount: number;
      /** The deterministic damage before variance. */
      baseAmount: number;
      /** The damage factor rolled for this hit, in basis points. */
      varianceBasisPoints: number;
      targetHpBefore: number;
      targetHpAfter: number;
    }
  | { type: 'combatant_defeated'; round: number; actor: CombatActor }
  | { type: 'combat_ended'; round: number; result: CombatResultKind; reason: CombatEndReason };

export type CombatEventType = CombatEvent['type'];

/** One resolver step: the next state and what happened on the way there. */
export interface CombatStep {
  state: CombatState;
  events: CombatEvent[];
}

/**
 * Everything the engine may consult that is not state. Randomness comes
 * **only** from `rng` — combat code never calls `Math.random()`. A basic
 * attack draws exactly once, for its damage factor; with a seeded `rng` the
 * same state and action sequence reproduce the same fight.
 */
export interface CombatContext {
  rng: Rng;
}

/** A finished (or capped) fight, presenter-neutral. JSON-safe. */
export interface CombatResult {
  result: CombatResultKind;
  reason: CombatEndReason;
  finalState: CombatState;
  events: CombatEvent[];
  /** The round the fight ended in. */
  rounds: number;
  /** Actions resolved. */
  actions: number;
}

/**
 * **Reserved shape** for future abilities (special attacks, defensive moves,
 * utility). Nothing executes these in V1 and nothing loads them; the type
 * fixes the direction so content and presenters agree when they arrive.
 *
 * Ability artwork follows `combat/abilities/<ability_key>.webp` relative to
 * the assets root (see `combatArtwork.ts`).
 */
export interface CombatAbilityDefinition {
  key: string;
  name: string;
  type: 'attack' | 'defense' | 'utility';
  artworkPath?: string | null;
}
