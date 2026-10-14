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
import type { DungeonActionType, DungeonDefinition, DungeonEventBranch, DungeonFlagScope } from '../content/dungeonDefinition';
import type { DungeonRewardSnapshot } from '../content/dungeonRewardSnapshot';
import type { DungeonRewardPlanV2 } from './lootResolver';

// ── what a run is handed ────────────────────────────────────────────────────

/** The stats a run fights with. The engine needs nothing else of the Buddy. */
export interface EngineFighter {
  waifuId: number;
  name: string;
  attack: number;
  defense: number;
  maxHp: number;
  modifiers?: CombatModifiers | undefined;
  /** The pinned SP an event check reads. Absent: the check takes its full negative modifier. */
  currentSp?: number | undefined;
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
  /** Verified snapshot from this run's pinned revision. Never the live catalogue. */
  rewards?: DungeonRewardSnapshot | null | undefined;
  fighter: EngineFighter;
  /** Namespaces claim and settlement keys: the run id live, any label in a sandbox. */
  runKey: string;
  /** Persistent flags, read-only to the engine. Empty until their store exists. */
  playerFlags?: Readonly<Record<string, boolean>> | undefined;
  /**
   * How many of each item the player holds, by slug — a fact handed in, since
   * the engine cannot look. Only the items a pending event's choices name are
   * needed; an absent slug is zero. Spending one leaves as a `consume_items` effect.
   */
  inventory?: Readonly<Record<string, number>> | undefined;
  /** Overrides for the combat engine's rules. Production passes none. */
  encounterFacts?: DungeonEncounterFacts | undefined;
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

// ── encounters (JSON-safe, independent of transient action records) ──────────
export type DungeonEncounterUnavailableReason = 'missing' | 'disabled' | 'not_permitted' | 'player_limit' | 'direct_not_permitted' | 'direct_limit_missing';
export interface DungeonEncounterFacts {
  /** Read live on arrival and every attempt; missing facts fail closed. */
  species: Readonly<Record<string, { available: boolean; reason?: DungeonEncounterUnavailableReason; name: string; rarity: string;
    /** Explicit authorization + finite cross-run limit checked by the fact provider. */
    directRescue?: { available: boolean; reason?: DungeonEncounterUnavailableReason };
  }>>;
  /** Quotes from the existing capture formula using the run's pinned Buddy. */
  items?: Readonly<Record<string, { owned: number; eligible: boolean; permitted: boolean; guaranteed: boolean; chance: number; consumesMicrodose?: boolean }>>;
}
export interface DungeonCaptureAttempt {
  n: number; item: string; chance: number; roll: number; success: boolean; step: number;
}
export interface DungeonEncounterInstance {
  species: string | null;
  status: 'offered' | 'captured' | 'rescued' | 'escaped' | 'left' | 'nothing' | 'unavailable';
  unavailableReason?: DungeonEncounterUnavailableReason;
  selectedStep: number;
  pool?: { poolId: string; entryId: string | null; eligible: string[]; totalWeight: number; roll: number | null };
  selectedItem?: string | null;
  attempts: DungeonCaptureAttempt[];
  grantKey?: string;
  resolvedStep?: number;
}

// ── events ──────────────────────────────────────────────────────────────────

/** The numbers behind an SP check, kept so a result can be explained and replayed. */
export interface DungeonEventCheckResult {
  /** The pinned SP read; null when the fighter carried none. */
  sp: number | null;
  chanceBasisPoints: number;
  /** 0–9999; the check succeeds when it is below the chance. */
  roll: number;
  success: boolean;
}

/**
 * What an `event` action presents in this run, decided once when the sequence
 * first reaches it and never again. Ids and numbers only: the text, choices
 * and outcomes are read from the run's pinned revision.
 *
 *   offered   the player is (or will be, on return) choosing
 *   resolved  a choice was made and its outcome applied
 *   nothing   a pool drew no event
 */
export interface DungeonEventInstance {
  eventId: string | null;
  status: 'offered' | 'resolved' | 'nothing';
  selectedStep: number;
  /** How a pool arrived at it. `entryId` is null when no entry was eligible. */
  pool?: { poolId: string; entryId: string | null; eligible: string[]; totalWeight: number; roll: number | null };
  resolution?: { choiceId: string; branch: DungeonEventBranch; step: number; check?: DungeonEventCheckResult };
}

/** What resolving something paid, before any of it is granted. */
export interface DungeonRewardPlan {
  /** Unbanked progression currency. */
  currency: number;
  waifubux: number;
  items: ExpeditionItemGrant[];
  equipment: ExpeditionEquipmentDraw[];
}

/** Legacy stored claims lack a version; v2 uses the existing T2 plan verbatim. */
export type DungeonResolvedRewardPlan = DungeonRewardPlan | DungeonRewardPlanV2;

export type DungeonActionDetail =
  | { kind: 'encounter'; species: string | null; status: DungeonEncounterInstance['status'] }
  | { kind: 'combat'; waves: DungeonWaveResult[]; waveCount: number }
  | { kind: 'rest'; healBasisPoints: number; hpBefore: number; hpAfter: number }
  | { kind: 'gate'; passed: boolean }
  | { kind: 'set_flag'; flag: string; scope: DungeonFlagScope; value: boolean }
  | { kind: 'reward'; claimKey: string; plan: DungeonResolvedRewardPlan }
  | { kind: 'leave'; connectionId: string | null }
  | {
      kind: 'event';
      /** Null when a pool drew nothing. */
      eventId: string | null;
      choiceId: string | null;
      branch: DungeonEventBranch | null;
      check: DungeonEventCheckResult | null;
    };

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
  /** Absent on legacy settlements. Both currencies use the same retention. */
  waifubux?: { earned: number; banked: number; lost: number };
}

/** One thing the latest step did, compact enough to keep on the run for redisplay. */
export type DungeonRecentEntry =
  | { kind: 'encounter'; roomId: string; actionId: string; species: string | null; outcome: DungeonEncounterInstance['status'] | 'failure'; text: string }
  | { kind: 'wave'; roomId: string; actionId: string; wave: DungeonWaveResult; waveCount: number }
  | { kind: 'rest'; roomId: string; actionId: string; hpBefore: number; hpAfter: number; healBasisPoints: number }
  | { kind: 'gate'; roomId: string; actionId: string; passed: boolean; blockedText: string }
  | { kind: 'flag'; roomId: string; actionId: string; flag: string; value: boolean }
  | { kind: 'reward'; roomId: string; actionId: string; claimKey: string; plan: DungeonResolvedRewardPlan }
  | { kind: 'declined'; roomId: string; actionId: string }
  | {
      kind: 'event';
      roomId: string;
      actionId: string;
      eventId: string;
      choiceId: string;
      branch: DungeonEventBranch;
      check: DungeonEventCheckResult | null;
      flags: { flag: string; value: boolean }[];
      consumed: { item: string; quantity: number }[];
      hpBefore: number;
      hpAfter: number;
      /** The player stepped back; the event is still open. */
      walkedAway: boolean;
    }
  | { kind: 'event_nothing'; roomId: string; actionId: string; text: string }
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
  rewardClaims: Record<string, DungeonResolvedRewardPlan>;
  /**
   * Event selections by `<roomId>:<actionId>`. Apart from the action records
   * for the reason `rewardClaims` is: a retreat erases those. Absent until the
   * run first reaches an event, and on states from before events.
   */
  events?: Record<string, DungeonEventInstance>;
  encounters?: Record<string, DungeonEncounterInstance>;
  unbankedCurrency: number;
  /** V2 dungeon-earned WaifuBux only; absent on historical engine states. */
  unbankedWaifubux?: number;
  /** What the latest applied step did. Replaced, not appended, each step. */
  recent: DungeonRecentEntry[];
  end: DungeonRunEnd | null;
}

// ── inputs ──────────────────────────────────────────────────────────────────

export type DungeonInput = (
  | { type: 'select_item'; item: string }
  | { type: 'capture' }
  | { type: 'rescue' }
  | { type: 'leave_encounter' }
  | { type: 'advance' }
  | { type: 'decline' }
  | { type: 'choose'; choiceId: string }
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
  | 'encounter_not_offered'
  | 'capture_item_required'
  | 'capture_item_unavailable'
  | 'stale'
  | 'run_over'
  | 'no_action'
  | 'action_pending'
  | 'not_optional'
  | 'not_available'
  | 'locked'
  | 'not_extractable'
  /** `advance` on an event: it takes a choice. */
  | 'choice_required'
  | 'choice_unknown'
  /** The choice's requirements are not met as the run and the inventory stand. */
  | 'choice_unavailable';

// ── effects ─────────────────────────────────────────────────────────────────

/**
 * Something the world must do because of a step. The engine only describes
 * it; an adapter (`DungeonEffectsPort`) carries it out — for real, or not at
 * all. Every effect carries the key that makes carrying it out idempotent.
 */
export type DungeonEffect =
  | { type: 'capture_attempt'; key: string; grantKey: string; roomId: string; actionId: string; species: string; mode: 'wild' | 'rescue'; attempt: DungeonCaptureAttempt; guaranteed: boolean; consumesMicrodose: boolean; spRoll: number }
  | { type: 'rescue_grant'; grantKey: string; roomId: string; actionId: string; species: string; spRoll: number }
  | {
      type: 'grant_rewards';
      /** `run:<runKey>:<roomId>:<actionId>` — the Phase 2 claim key, already in its final shape. */
      claimKey: string;
      roomId: string;
      actionId: string;
      /** Secured rewards only. At-risk currencies are already on the run. */
      plan: DungeonResolvedRewardPlan;
    }
  | {
      type: 'settle_run';
      /** `dungeon_run:v1:<runKey>:settlement`. */
      requestKey: string;
      end: DungeonRunEnd;
      currencyKey: string | null;
    }
  | {
      type: 'consume_items';
      /** `run:<runKey>:<roomId>:<actionId>:consume`. */
      key: string;
      roomId: string;
      actionId: string;
      /** Spent because a choice was made, whatever its check then did. */
      items: { item: string; quantity: number }[];
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
  /** V2 provenance and actual rolled properties; absent on legacy receipts. */
  dropId?: string;
  rollSeed?: number;
  name?: string;
  affixKey?: string | null;
  alreadyGranted?: boolean;
}

export interface DungeonEssenceGrant {
  baseAmount: number;
  granted: number;
  bonusPercent: number;
  bonus: 'pinned' | 'not_pinned';
  balanceAfter: number;
}

export interface DungeonAffectionGrant {
  waifuId: number;
  name: string;
  speciesSlug: string;
  baseAmount: number;
  granted: number;
  bonusPercent: number;
  bonus: 'pinned' | 'not_pinned';
  affectionBefore: number;
  affectionAfter: number;
}

/** The owned copy a live encounter created. */
export interface DungeonAcquiredWaifu {
  waifuId: number;
  speciesSlug: string;
  name: string;
  rarity: string;
  baseSp: number;
  isDuplicate: boolean;
  isNewDex: boolean;
}

/** What one real capture attempt did, as the capture service reported it. */
export interface DungeonCaptureReceipt {
  type: 'capture_attempt';
  key: string;
  simulated: false;
  grantKey: string;
  roomId: string;
  actionId: string;
  species: string;
  mode: 'wild' | 'rescue';
  item: string;
  success: boolean;
  outcome: 'success' | 'failure' | 'escape';
  guaranteed: boolean;
  chance: number;
  roll: number;
  /** After the pinned Buddy's `player_xp_gain`, when she has one. */
  xpGranted: number;
  levelUps: { fromLevel: number; toLevel: number; rewardLabels: string[] }[];
  /** The Microdose charge this attempt spent, or null. */
  microdose: { sourceItemSlug: string | null; chargesRemaining: number } | null;
  acquired: DungeonAcquiredWaifu | null;
}

/** What one real direct rescue granted. */
export interface DungeonRescueReceipt {
  type: 'rescue_grant';
  grantKey: string;
  simulated: false;
  roomId: string;
  actionId: string;
  species: string;
  /** True when the key had already granted its copy: nothing was written again. */
  replayed: boolean;
  xpGranted: number;
  levelUps: { fromLevel: number; toLevel: number; rewardLabels: string[] }[];
  acquired: DungeonAcquiredWaifu;
}

export type DungeonEffectReceipt =
  | { type: 'capture_attempt'; key: string; simulated: true; success: boolean }
  | { type: 'rescue_grant'; grantKey: string; simulated: true }
  | DungeonCaptureReceipt
  | DungeonRescueReceipt
  | {
      type: 'grant_rewards';
      claimKey: string;
      waifubux: number;
      items: ExpeditionItemGrant[];
      equipment: DungeonEquipmentGrant[];
      /** V2 resolution provenance; absent on legacy receipts. */
      plan?: DungeonRewardPlanV2;
      essence?: DungeonEssenceGrant;
      affection?: DungeonAffectionGrant;
    }
  | {
      type: 'settle_run';
      banked: number;
      /** Why nothing could be banked, when the currency is missing or disabled. */
      bankingSkipped: 'no_currency' | 'currency_disabled' | null;
      balanceAfter: number | null;
      /** Actual V2 banking; separate from progression bankingSkipped. */
      waifubux?: { banked: number; balanceAfter: number | null };
    }
  | { type: 'consume_items'; key: string; items: { item: string; quantity: number }[] };

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
  'event_selected',
  'items_consumed',
  'encounter_selected',
  'capture_attempted',
  'waifu_acquired',
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
