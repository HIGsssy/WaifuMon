/**
 * The shapes the dungeon engine reads and writes: the run state it advances,
 * the inputs it accepts, the effects and log entries it emits, and the frozen
 * dependencies it is handed.
 *
 * Types only, and nothing here knows about a database row, a Discord
 * component or a service — `dungeonRunService` maps these to and from
 * `dungeon_runs`, and the sandbox keeps them in memory.
 */
import type { CombatEndReason, CombatEvent, CombatModifiers, CombatResultKind, CombatRules } from '../../combat/combatTypes';
import type { CombatEnemyDefinition } from '../../combat/enemyDefinitions';
import type { ExpeditionRewardTable } from '../../content/schemas';
import type { ExpeditionEquipmentDraw, ExpeditionItemGrant } from '../../expeditions/expeditionRewards';
import type { EquipmentRewardCandidate } from '../../rewardTables/rewardTableCore';
import type { Rng } from '../../../shared/random';
import type { DungeonActionType, DungeonDefinition, DungeonFlagScope } from '../content/dungeonDefinition';

// ── what a run is handed ────────────────────────────────────────────────────

/** The stats a run fights with. The engine needs nothing else of the Buddy. */
export interface EngineFighter {
  waifuId: number;
  name: string;
  attack: number;
  defense: number;
  maxHp: number;
  modifiers?: CombatModifiers | undefined;
}

/** A reward table as a run was promised it, with the gear it may pay. */
export interface DungeonRewardTableSnapshot {
  table: ExpeditionRewardTable;
  /** Eligible Equipment definitions per selector, keyed by `equipmentSelectorKey`. */
  equipmentPools: Record<string, EquipmentRewardCandidate[]>;
}

/**
 * The mutable global content a run depends on, frozen when it started. The
 * engine reads enemies and reward tables from here and nowhere else, so a
 * balance edit reaches new runs and never one already under way.
 */
export interface EngineDependencies {
  enemies: Record<string, CombatEnemyDefinition>;
  /** Null for a table that was disabled at the start: it pays nothing. */
  rewardTables: Record<string, DungeonRewardTableSnapshot | null>;
}

export interface DungeonEngineContext {
  /** A validated definition: the published revision's content, or a draft in the sandbox. */
  definition: DungeonDefinition;
  dependencies: EngineDependencies;
  fighter: EngineFighter;
  /** Namespaces claim and settlement keys: the run id live, any label in a sandbox. */
  runKey: string;
  /** Persistent flags, read-only to the engine. Empty until their store exists. */
  playerFlags?: Readonly<Record<string, boolean>> | undefined;
  /** Overrides for the combat engine's rules. Production passes none. */
  combatRules?: Partial<CombatRules> | undefined;
}

/** Named, independent random streams derived from the run seed. */
export interface DungeonRngSource {
  /** The same `parts` always give the same stream for one run. */
  stream(...parts: (string | number)[]): Rng;
  /** The seed `stream(...parts)` starts from, for the log. */
  seedOf(...parts: (string | number)[]): number;
}

// ── run state ───────────────────────────────────────────────────────────────

export const DUNGEON_RUN_STATUSES = ['active', 'extracted', 'defeated', 'completed', 'abandoned'] as const;
export type DungeonRunStatus = (typeof DUNGEON_RUN_STATUSES)[number];
export type DungeonRunOutcome = Exclude<DungeonRunStatus, 'active'>;

/**
 * Where the run stands. `actionId` is null when the room's sequence is over
 * and the player is choosing where to go. `waveIndex` is the next wave of a
 * combat action to fight. Later phases add their own frames (an event's, a
 * rescue's) as further optional fields; nothing reads a field it does not own.
 */
export interface DungeonCursor {
  roomId: string;
  actionId: string | null;
  waveIndex: number;
  /** The room the player arrived from; where a `retreat` goes back to. */
  cameFrom: string | null;
}

/**
 * How an action ended. The four terminal states are deliberately distinct:
 *
 *   completed          it ran and reported a success outcome
 *   failed             it ran and reported a failure outcome (a lost fight
 *                      that was routed on, a gate that did not open)
 *   declined           it was optional and the player said no
 *   condition_skipped  its `when` was false; the player never saw it
 *
 * `in_progress` is a combat action between waves.
 */
export type DungeonActionStatus = 'in_progress' | 'completed' | 'failed' | 'declined' | 'condition_skipped';

export interface DungeonWaveResult {
  waveIndex: number;
  enemyKey: string;
  enemyName: string;
  result: CombatResultKind;
  reason: CombatEndReason;
  rounds: number;
  hpBefore: number;
  hpAfter: number;
  enemyMaxHp: number;
  enemyHpAfter: number;
  lifestealHealed: number;
  playerCrits: number;
  playerBonusAttacks: number;
  /** The seed the fight's draws came from: same seed, same HP in, same fight. */
  combatSeed: number;
}

/** What resolving something paid, before any of it is granted. */
export interface DungeonRewardPlan {
  /** Unbanked progression currency. */
  currency: number;
  waifubux: number;
  items: ExpeditionItemGrant[];
  equipment: ExpeditionEquipmentDraw[];
}

export type DungeonActionDetail =
  | { kind: 'combat'; waves: DungeonWaveResult[]; waveCount: number }
  | { kind: 'rest'; healBasisPoints: number; hpBefore: number; hpAfter: number }
  | { kind: 'gate'; passed: boolean }
  | { kind: 'set_flag'; flag: string; scope: DungeonFlagScope; value: boolean }
  | { kind: 'reward'; claimKey: string; plan: DungeonRewardPlan }
  | { kind: 'leave'; connectionId: string | null };

export interface DungeonActionRecord {
  status: DungeonActionStatus;
  type: DungeonActionType;
  /** The outcome it reported; null while in progress or when skipped by its condition. */
  outcome: string | null;
  /** The step that last touched it. */
  step: number;
  detail: DungeonActionDetail | null;
}

export interface DungeonRoomState {
  visits: number;
  completed: boolean;
  /** The action a `retreat` left unfinished; the sequence resumes there on return. */
  resumeAt: string | null;
  actions: Record<string, DungeonActionRecord>;
}

/** The pure part of how a run ended. What was actually banked is the adapter's receipt. */
export interface DungeonRunEnd {
  outcome: DungeonRunOutcome;
  cause: 'extraction' | 'exit_reached' | 'hp_zero' | 'stalemate' | 'abandoned' | 'scripted';
  roomId: string;
  finalHp: number;
  /** Unbanked currency carried into the settlement. */
  earned: number;
  /** Share of `earned` kept: 10000 unless defeated or abandoned. */
  retentionBasisPoints: number;
  banked: number;
  lost: number;
}

/** One thing the latest step did, compact enough to keep on the run for redisplay. */
export type DungeonRecentEntry =
  | { kind: 'wave'; roomId: string; actionId: string; wave: DungeonWaveResult; waveCount: number }
  | { kind: 'rest'; roomId: string; actionId: string; hpBefore: number; hpAfter: number; healBasisPoints: number }
  | { kind: 'gate'; roomId: string; actionId: string; passed: boolean; blockedText: string }
  | { kind: 'flag'; roomId: string; actionId: string; flag: string; value: boolean }
  | { kind: 'reward'; roomId: string; actionId: string; claimKey: string; plan: DungeonRewardPlan }
  | { kind: 'declined'; roomId: string; actionId: string }
  | { kind: 'room_completed'; roomId: string }
  | { kind: 'retreated'; fromRoomId: string; toRoomId: string }
  | { kind: 'moved'; connectionId: string; fromRoomId: string; toRoomId: string };

export interface DungeonRunState {
  status: DungeonRunStatus;
  /** Bumped by every applied step. A button names the step it was drawn for. */
  step: number;
  /** Unsigned 32-bit. Every random draw of the run derives from it. */
  seed: number;
  cursor: DungeonCursor;
  hp: number;
  /** Run-scoped flags. Unset means false. */
  flags: Record<string, boolean>;
  rooms: Record<string, DungeonRoomState>;
  /** Paid plans by stable claim key; navigation never clears these. */
  rewardClaims: Record<string, DungeonRewardPlan>;
  unbankedCurrency: number;
  /** What the latest applied step did. Replaced, not appended, each step. */
  recent: DungeonRecentEntry[];
  end: DungeonRunEnd | null;
}

// ── inputs ──────────────────────────────────────────────────────────────────

export type DungeonInput = (
  | { type: 'advance' }
  | { type: 'decline' }
  | { type: 'move'; connectionId: string }
  | { type: 'extract' }
  | { type: 'abandon' }
) & {
  /**
   * The step the caller believes the run is at. A mismatch is refused as
   * `stale` and changes nothing — the guard against a replayed or raced
   * interaction. Omitted only by callers that own the state outright.
   */
  expectedStep?: number | undefined;
};

export type DungeonRefusal =
  | 'stale'
  | 'run_over'
  | 'no_action'
  | 'action_pending'
  | 'not_optional'
  | 'not_available'
  | 'locked'
  | 'not_extractable';

// ── effects ─────────────────────────────────────────────────────────────────

/**
 * Something the world must do because of a step. The engine only describes
 * it; an adapter (`DungeonEffectsPort`) carries it out — for real, or not at
 * all. Every effect carries the key that makes carrying it out idempotent.
 */
export type DungeonEffect =
  | {
      type: 'grant_rewards';
      /** `run:<runKey>:<roomId>:<actionId>` — the Phase 2 claim key, already in its final shape. */
      claimKey: string;
      roomId: string;
      actionId: string;
      /** WaifuBux, items and gear to hand over now. Its currency is already on the run, unbanked. */
      plan: DungeonRewardPlan;
    }
  | {
      type: 'settle_run';
      /** `dungeon_run:v1:<runKey>:settlement`. */
      requestKey: string;
      end: DungeonRunEnd;
      currencyKey: string | null;
    };

/** A gear drop as handed over. */
export interface DungeonEquipmentGrant {
  rewardIndex: number;
  equipmentId: number;
  definitionKey: string;
  displayName: string;
  slot: string;
  rarity: string;
  rolledMultiplierBp: number;
  combatBonuses?: unknown[] | undefined;
}

export type DungeonEffectReceipt =
  | {
      type: 'grant_rewards';
      claimKey: string;
      waifubux: number;
      items: ExpeditionItemGrant[];
      equipment: DungeonEquipmentGrant[];
    }
  | {
      type: 'settle_run';
      banked: number;
      /** Why nothing could be banked, when the currency is missing or disabled. */
      bankingSkipped: 'no_currency' | 'currency_disabled' | null;
      balanceAfter: number | null;
    };

/**
 * How effects reach the world. Two implementations and no others: the live
 * one inside `dungeonRunService`'s transaction, and the sandbox, which records
 * the effect and touches nothing.
 */
export interface DungeonEffectsPort {
  apply(effect: DungeonEffect): Promise<DungeonEffectReceipt>;
}

// ── log ─────────────────────────────────────────────────────────────────────

export const DUNGEON_RUN_EVENT_TYPES = [
  'run_started',
  'room_entered',
  'action_skipped',
  'action_declined',
  'combat_wave_resolved',
  'action_completed',
  'action_failed',
  'room_completed',
  'room_retreated',
  'connection_taken',
  'extraction',
  'defeat',
  'completion',
  'abandon',
  'currency_banked',
  'rewards_granted',
] as const;
export type DungeonRunEventType = (typeof DUNGEON_RUN_EVENT_TYPES)[number];

/** One structured entry for the run's append-only history. */
export interface DungeonLogEntry {
  type: DungeonRunEventType;
  roomId: string | null;
  actionId: string | null;
  payload: Record<string, unknown>;
}

// ── step result ─────────────────────────────────────────────────────────────

export interface DungeonStepResult {
  /** `applied`: the state moved. `refused`: nothing changed, and `state` is the input state. */
  status: 'applied' | 'refused';
  refusal: DungeonRefusal | null;
  state: DungeonRunState;
  effects: DungeonEffect[];
  log: DungeonLogEntry[];
  /** The engine's combat events for each wave fought this step, in order. Never stored on the state. */
  combat: { roomId: string; actionId: string; waveIndex: number; events: CombatEvent[] }[];
}
