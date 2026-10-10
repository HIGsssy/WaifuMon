/**
 * The dungeon engine: one pure function that moves a run one step.
 *
 *   stepDungeon(state, input, context, rng) → { state, effects, log, combat }
 *
 * It decides everything about a run — what an action does, where the sequence
 * goes next, what is paid, when the run ends — and touches nothing. It reads
 * no database, no clock and no global state; the same arguments always give
 * the same result. What must happen in the world because of a step comes back
 * as `effects`, for an adapter to carry out (`DungeonEffectsPort`): for real
 * inside `dungeonRunService`'s transaction, or not at all in the sandbox. So a
 * simulated run and a live one cannot disagree about a rule — there is only
 * one copy of it.
 *
 * ## One input, one step
 *
 * An input resolves the thing the player is looking at (a wave, a rest, a
 * reward, a choice of path) and the engine then carries the sequence forward
 * through everything that needs no decision — conditions that skip an action,
 * gates, flags, a `leave`, a room completing, the next room's opening actions
 * — until it reaches something that does. That whole stretch is one step:
 * `state.step` goes up by exactly one, and the run is never stored half-way.
 *
 * ## Staleness
 *
 * An input names the step it was issued for (`expectedStep`). If the run has
 * moved on, the input is refused as `stale` and nothing changes. Together
 * with the row lock the live service takes, that is the whole defence against
 * a double click, a Discord retry or two racing interactions.
 *
 * ## Forward-only sequences
 *
 * Within a room the cursor only moves down the action list (`routing.ts`), so
 * `runSequence` always terminates. Rooms may be revisited — the map can cycle
 * — but a completed room's sequence does not run again.
 */
import {
  BASIS_POINTS,
  DECLINED_OUTCOME,
  connectionOf,
  connectionsFrom,
  isCombatAction,
  roomOf,
  type CombatAction,
  type DungeonAction,
  type DungeonConnection,
  type DungeonRoom,
} from '../content/dungeonDefinition';
import { DungeonEngineContentError, fightWave, selectWaveEnemy } from './combat';
import { conditionFacts, evaluateCondition } from './conditions';
import { hpAfterRest, planHasSecuredRewards, rewardClaimKey, rollRewardPlan, settleCurrency, settlementRequestKey } from './rewards';
import { FAILURE_OUTCOMES, destinationFor, forwardIndex } from './routing';
import { dungeonRngSource } from './seeds';
import type {
  DungeonActionRecord,
  DungeonEngineContext,
  DungeonInput,
  DungeonRefusal,
  DungeonRngSource,
  DungeonRoomState,
  DungeonRunEnd,
  DungeonRunOutcome,
  DungeonRunState,
  DungeonStepResult,
} from './types';

interface Work {
  state: DungeonRunState;
  ctx: DungeonEngineContext;
  rng: DungeonRngSource;
  effects: DungeonStepResult['effects'];
  log: DungeonStepResult['log'];
  combat: DungeonStepResult['combat'];
}

/** What a handler tells the sequence to do next. */
type Flow = { kind: 'continue'; index: number } | { kind: 'stop' };
const STOP: Flow = { kind: 'stop' };

const END_EVENT = { extracted: 'extraction', completed: 'completion', defeated: 'defeat', abandoned: 'abandon' } as const;

function refused(state: DungeonRunState, refusal: DungeonRefusal): DungeonStepResult {
  return { status: 'refused', refusal, state, effects: [], log: [], combat: [] };
}

function requireRoom(w: Work, roomId: string): DungeonRoom {
  const room = roomOf(w.ctx.definition, roomId);
  if (!room) throw new DungeonEngineContentError(`the run is in room "${roomId}", which the dungeon lacks`);
  return room;
}

function roomState(w: Work, roomId: string): DungeonRoomState {
  return (w.state.rooms[roomId] ??= { visits: 0, completed: false, resumeAt: null, actions: {} });
}

function holds(w: Work, condition: Parameters<typeof evaluateCondition>[0]): boolean {
  return evaluateCondition(condition, conditionFacts(w.state, w.ctx.playerFlags));
}

/** Whether the sequence stops on this action and waits for the player. */
export function actionAwaitsInput(action: DungeonAction): boolean {
  return action.optional || isCombatAction(action) || action.type === 'rest' || action.type === 'reward';
}

function record(w: Work, room: DungeonRoom, action: DungeonAction, rec: Omit<DungeonActionRecord, 'type' | 'step'>): void {
  roomState(w, room.id).actions[action.id] = { ...rec, type: action.type, step: w.state.step };
}

// ── ending and moving ───────────────────────────────────────────────────────

function endRun(w: Work, outcome: DungeonRunOutcome, cause: DungeonRunEnd['cause']): void {
  const { state } = w;
  const kept = outcome === 'extracted' || outcome === 'completed';
  const retentionBasisPoints = kept ? BASIS_POINTS : w.ctx.definition.settings.defeatCurrencyRetentionBasisPoints;
  const earned = state.unbankedCurrency;
  const end: DungeonRunEnd = {
    outcome,
    cause,
    roomId: state.cursor.roomId,
    finalHp: state.hp,
    earned,
    retentionBasisPoints,
    ...settleCurrency(earned, retentionBasisPoints),
  };
  state.status = outcome;
  state.end = end;
  // Nothing is unbanked once the run is settled; `end.earned` keeps the figure.
  state.unbankedCurrency = 0;
  state.cursor = { ...state.cursor, actionId: null, waveIndex: 0 };
  w.effects.push({
    type: 'settle_run',
    requestKey: settlementRequestKey(w.ctx.runKey),
    end,
    currencyKey: w.ctx.definition.settings.progressionCurrency,
  });
  w.log.push({ type: END_EVENT[outcome], roomId: end.roomId, actionId: null, payload: { ...end } });
}

function completeRoom(w: Work, room: DungeonRoom): void {
  roomState(w, room.id).completed = true;
  w.state.cursor = { ...w.state.cursor, actionId: null, waveIndex: 0 };
  w.state.recent.push({ kind: 'room_completed', roomId: room.id });
  w.log.push({ type: 'room_completed', roomId: room.id, actionId: null, payload: { kind: room.kind, hp: w.state.hp } });
  if (room.kind === 'exit') endRun(w, 'completed', 'exit_reached');
}

function enterRoom(w: Work, roomId: string, from: string | null): void {
  const room = requireRoom(w, roomId);
  const rs = roomState(w, roomId);
  rs.visits += 1;
  w.state.cursor = { roomId, actionId: null, waveIndex: 0, cameFrom: from };
  w.log.push({
    type: 'room_entered',
    roomId,
    actionId: null,
    payload: { from, visit: rs.visits, hp: w.state.hp, completed: rs.completed },
  });
  // A finished room's sequence does not run again: the player is back at its exits.
  if (rs.completed) return;
  const resumeIndex = rs.resumeAt == null ? -1 : room.actions.findIndex((a) => a.id === rs.resumeAt);
  rs.resumeAt = null;
  runSequence(w, room, Math.max(0, resumeIndex));
}

function takeConnection(w: Work, connection: DungeonConnection): void {
  w.state.recent.push({ kind: 'moved', connectionId: connection.id, fromRoomId: connection.from, toRoomId: connection.to });
  w.log.push({
    type: 'connection_taken',
    roomId: connection.from,
    actionId: null,
    payload: { connectionId: connection.id, to: connection.to, kind: connection.kind },
  });
  enterRoom(w, connection.to, connection.from);
}

// ── the sequence ────────────────────────────────────────────────────────────

/** Send the sequence wherever `outcome` routes. */
function follow(
  w: Work,
  room: DungeonRoom,
  index: number,
  action: DungeonAction,
  outcome: string,
  defeatCause: DungeonRunEnd['cause'] = 'scripted',
): Flow {
  const destination = destinationFor(action, outcome);
  switch (destination.type) {
    case 'next':
      return { kind: 'continue', index: index + 1 };
    case 'action':
      return { kind: 'continue', index: forwardIndex(room, index, destination.actionId) };
    case 'room_complete':
      completeRoom(w, room);
      return STOP;
    case 'leave': {
      const connection = connectionOf(w.ctx.definition, destination.connectionId);
      if (!connection || connection.from !== room.id) {
        throw new DungeonEngineContentError(
          `room "${room.id}" action "${action.id}" leaves through "${destination.connectionId}", which is not one of the room's connections`,
        );
      }
      completeRoom(w, room);
      // An explicit transition is the author's decision: the connection's own lock is not consulted.
      if (w.state.status === 'active') takeConnection(w, connection);
      return STOP;
    }
    case 'retreat': {
      const back = w.state.cursor.cameFrom;
      // Nowhere to go back to (the entrance): the room completes instead of trapping the player.
      if (back == null) {
        completeRoom(w, room);
        return STOP;
      }
      const rs = roomState(w, room.id);
      // The action is unfinished business: it is asked again on return.
      if (action.type !== 'reward' || rs.actions[action.id]?.outcome !== 'claimed') delete rs.actions[action.id];
      rs.resumeAt = action.id;
      w.state.recent.push({ kind: 'retreated', fromRoomId: room.id, toRoomId: back });
      w.log.push({ type: 'room_retreated', roomId: room.id, actionId: action.id, payload: { to: back } });
      enterRoom(w, back, room.id);
      return STOP;
    }
    case 'end_run':
      endRun(w, destination.outcome, destination.outcome === 'defeated' ? defeatCause : 'scripted');
      return STOP;
  }
}

/** Gate, flag and leave: actions that need no decision. */
function resolveInstant(w: Work, room: DungeonRoom, index: number, action: DungeonAction): Flow {
  switch (action.type) {
    case 'gate': {
      const passed = holds(w, action.requires);
      const outcome = passed ? 'passed' : 'blocked';
      record(w, room, action, { status: passed ? 'completed' : 'failed', outcome, detail: { kind: 'gate', passed } });
      w.state.recent.push({ kind: 'gate', roomId: room.id, actionId: action.id, passed, blockedText: action.blockedText });
      w.log.push({ type: passed ? 'action_completed' : 'action_failed', roomId: room.id, actionId: action.id, payload: { actionType: 'gate', outcome } });
      return follow(w, room, index, action, outcome);
    }
    case 'set_flag': {
      // Only run-scoped flags can be written; the validator refuses the rest until their store exists.
      if (action.scope === 'run') w.state.flags[action.flag] = action.value;
      record(w, room, action, {
        status: 'completed',
        outcome: 'done',
        detail: { kind: 'set_flag', flag: action.flag, scope: action.scope, value: action.value },
      });
      w.state.recent.push({ kind: 'flag', roomId: room.id, actionId: action.id, flag: action.flag, value: action.value });
      w.log.push({
        type: 'action_completed',
        roomId: room.id,
        actionId: action.id,
        payload: { actionType: 'set_flag', outcome: 'done', flag: action.flag, scope: action.scope, value: action.value },
      });
      return follow(w, room, index, action, 'done');
    }
    case 'leave': {
      record(w, room, action, { status: 'completed', outcome: 'done', detail: { kind: 'leave', connectionId: action.connectionId ?? null } });
      w.log.push({
        type: 'action_completed',
        roomId: room.id,
        actionId: action.id,
        payload: { actionType: 'leave', outcome: 'done', connectionId: action.connectionId ?? null },
      });
      return follow(w, room, index, action, 'done');
    }
    default:
      throw new DungeonEngineContentError(`action "${action.id}" of type "${action.type}" cannot resolve without input`);
  }
}

function runSequence(w: Work, room: DungeonRoom, startIndex: number): void {
  let index = startIndex;
  // Forward-only routing bounds this by the length of the list.
  for (;;) {
    if (w.state.status !== 'active' || w.state.cursor.roomId !== room.id) return;
    const action = room.actions[index];
    if (!action) {
      completeRoom(w, room);
      return;
    }
    if (!holds(w, action.when)) {
      record(w, room, action, { status: 'condition_skipped', outcome: null, detail: null });
      w.log.push({ type: 'action_skipped', roomId: room.id, actionId: action.id, payload: { actionType: action.type } });
      index += 1;
      continue;
    }
    if (actionAwaitsInput(action)) {
      w.state.cursor = { ...w.state.cursor, actionId: action.id, waveIndex: 0 };
      return;
    }
    const flow = resolveInstant(w, room, index, action);
    if (flow.kind === 'stop') return;
    index = flow.index;
  }
}

// ── actions that take input ─────────────────────────────────────────────────

function fightWaves(w: Work, room: DungeonRoom, index: number, action: CombatAction): Flow | 'await' {
  const rs = roomState(w, room.id);
  const existing = rs.actions[action.id];
  const waves = existing?.detail?.kind === 'combat' ? [...existing.detail.waves] : [];
  const place = { roomId: room.id, actionId: action.id };

  for (;;) {
    const waveIndex = w.state.cursor.waveIndex;
    const wave = action.waves[waveIndex];
    if (!wave) throw new DungeonEngineContentError(`room "${room.id}" action "${action.id}" has no wave ${waveIndex + 1}`);
    const enemy = selectWaveEnemy(wave, { ...place, waveIndex }, w.ctx.dependencies, w.rng);
    const combatSeed = w.rng.seedOf('combat', room.id, action.id, waveIndex);
    const fight = fightWave({
      fighter: w.ctx.fighter,
      currentHp: w.state.hp,
      enemy,
      waveIndex,
      combatSeed,
      rng: w.rng,
      place,
      rules: w.ctx.combatRules,
    });
    waves.push(fight.result);
    w.state.hp = fight.result.hpAfter;
    w.combat.push({ ...place, waveIndex, events: fight.events });
    w.state.recent.push({ kind: 'wave', ...place, wave: fight.result, waveCount: action.waves.length });
    w.log.push({
      type: 'combat_wave_resolved',
      roomId: room.id,
      actionId: action.id,
      payload: { actionType: action.type, waveCount: action.waves.length, ...fight.result, events: fight.events },
    });
    const detail = { kind: 'combat' as const, waves, waveCount: action.waves.length };

    if (fight.result.result !== 'player_victory') {
      // A stalemate — the round limit with both standing — is a loss, as it always was.
      const cause = fight.result.reason === 'round_limit' ? 'stalemate' : 'hp_zero';
      const destination = destinationFor(action, 'defeat');
      // A loss the author routed onward is survived: the Buddy carries on at 1 HP.
      if (destination.type !== 'end_run') w.state.hp = Math.max(1, w.state.hp);
      record(w, room, action, { status: 'failed', outcome: 'defeat', detail });
      w.log.push({
        type: 'action_failed',
        roomId: room.id,
        actionId: action.id,
        payload: { actionType: action.type, outcome: 'defeat', cause, wavesFought: waves.length },
      });
      return follow(w, room, index, action, 'defeat', cause);
    }

    if (waveIndex + 1 >= action.waves.length) {
      record(w, room, action, { status: 'completed', outcome: 'victory', detail });
      w.log.push({
        type: 'action_completed',
        roomId: room.id,
        actionId: action.id,
        payload: { actionType: action.type, outcome: 'victory', wavesFought: waves.length },
      });
      return follow(w, room, index, action, 'victory');
    }

    // The wave is won and stored; the next one is the cursor's.
    w.state.cursor = { ...w.state.cursor, waveIndex: waveIndex + 1 };
    record(w, room, action, { status: 'in_progress', outcome: null, detail });
    if (action.advance !== 'auto') return 'await';
  }
}

function resolveWithInput(w: Work, room: DungeonRoom, index: number, action: DungeonAction): Flow | 'await' {
  if (isCombatAction(action)) return fightWaves(w, room, index, action);
  switch (action.type) {
    case 'rest': {
      const hpBefore = w.state.hp;
      const hpAfter = hpAfterRest(w.ctx.fighter.maxHp, hpBefore, action.healBasisPoints);
      w.state.hp = hpAfter;
      record(w, room, action, {
        status: 'completed',
        outcome: 'done',
        detail: { kind: 'rest', healBasisPoints: action.healBasisPoints, hpBefore, hpAfter },
      });
      w.state.recent.push({ kind: 'rest', roomId: room.id, actionId: action.id, hpBefore, hpAfter, healBasisPoints: action.healBasisPoints });
      w.log.push({
        type: 'action_completed',
        roomId: room.id,
        actionId: action.id,
        payload: { actionType: 'rest', outcome: 'done', healBasisPoints: action.healBasisPoints, hpBefore, hpAfter },
      });
      return follow(w, room, index, action, 'done');
    }
    case 'reward': {
      const place = { roomId: room.id, actionId: action.id };
      const claimKey = rewardClaimKey(w.ctx.runKey, room.id, action.id);
      const alreadyClaimed = Object.hasOwn(w.state.rewardClaims, claimKey);
      const plan = alreadyClaimed ? w.state.rewardClaims[claimKey]! : rollRewardPlan(action.reward, place, w.ctx.dependencies, w.rng);
      if (!alreadyClaimed) {
        w.state.rewardClaims[claimKey] = plan;
        w.state.unbankedCurrency += plan.currency;
        if (planHasSecuredRewards(plan)) w.effects.push({ type: 'grant_rewards', claimKey, ...place, plan });
        w.state.recent.push({ kind: 'reward', ...place, claimKey, plan });
      }
      record(w, room, action, { status: 'completed', outcome: 'claimed', detail: { kind: 'reward', claimKey, plan } });
      w.log.push({
        type: 'action_completed',
        roomId: room.id,
        actionId: action.id,
        payload: { actionType: 'reward', outcome: 'claimed', claimKey, plan, alreadyClaimed },
      });
      return follow(w, room, index, action, 'claimed');
    }
    default:
      return resolveInstant(w, room, index, action);
  }
}

// ── entry points ────────────────────────────────────────────────────────────

/** The action the cursor is on, with its place in the room; null between actions. */
export function currentAction(
  state: Pick<DungeonRunState, 'cursor'>,
  definition: DungeonEngineContext['definition'],
): { room: DungeonRoom; action: DungeonAction; index: number } | null {
  const room = roomOf(definition, state.cursor.roomId);
  if (!room || state.cursor.actionId == null) return null;
  const index = room.actions.findIndex((a) => a.id === state.cursor.actionId);
  const action = room.actions[index];
  return action ? { room, action, index } : null;
}

/** The connections out of the room the run is in, each with whether it is open now. */
export function connectionStates(
  state: DungeonRunState,
  ctx: Pick<DungeonEngineContext, 'definition' | 'playerFlags'>,
): { connection: DungeonConnection; open: boolean }[] {
  const facts = conditionFacts(state, ctx.playerFlags);
  return connectionsFrom(ctx.definition, state.cursor.roomId).map((connection) => ({
    connection,
    open: evaluateCondition(connection.requires, facts),
  }));
}

/** Whether the player may leave the dungeon from where the run stands. */
export function canExtract(state: DungeonRunState, definition: DungeonEngineContext['definition']): boolean {
  if (state.status !== 'active' || state.cursor.actionId != null) return false;
  const room = roomOf(definition, state.cursor.roomId);
  return room?.extraction === true && state.rooms[room.id]?.completed === true;
}

/**
 * A new run, already standing in the entrance room with its opening actions
 * carried forward. `state.step` is 0; the first input is step 0's.
 */
export function startDungeonRun(
  ctx: DungeonEngineContext,
  seed: number,
  rng: DungeonRngSource = dungeonRngSource(seed),
): DungeonStepResult {
  const state: DungeonRunState = {
    status: 'active',
    step: 0,
    seed,
    cursor: { roomId: ctx.definition.entranceRoomId, actionId: null, waveIndex: 0, cameFrom: null },
    hp: ctx.fighter.maxHp,
    flags: {},
    rooms: {},
    rewardClaims: {},
    unbankedCurrency: 0,
    recent: [],
    end: null,
  };
  const w: Work = { state, ctx, rng, effects: [], log: [], combat: [] };
  enterRoom(w, ctx.definition.entranceRoomId, null);
  return { status: 'applied', refusal: null, state, effects: w.effects, log: w.log, combat: w.combat };
}

export function stepDungeon(
  state: DungeonRunState,
  input: DungeonInput,
  ctx: DungeonEngineContext,
  rng: DungeonRngSource = dungeonRngSource(state.seed),
): DungeonStepResult {
  if (input.expectedStep !== undefined && input.expectedStep !== state.step) return refused(state, 'stale');
  if (state.status !== 'active') return refused(state, 'run_over');

  const w: Work = { state: structuredClone(state), ctx, rng, effects: [], log: [], combat: [] };
  w.state.recent = [];
  const room = requireRoom(w, w.state.cursor.roomId);

  switch (input.type) {
    case 'abandon':
      endRun(w, 'abandoned', 'abandoned');
      break;

    case 'extract':
      if (!canExtract(state, ctx.definition)) return refused(state, 'not_extractable');
      endRun(w, 'extracted', 'extraction');
      break;

    case 'move': {
      if (w.state.cursor.actionId != null) return refused(state, 'action_pending');
      const found = connectionStates(state, ctx).find((c) => c.connection.id === input.connectionId);
      if (!found) return refused(state, 'not_available');
      if (!found.open) return refused(state, 'locked');
      takeConnection(w, found.connection);
      break;
    }

    case 'advance':
    case 'decline': {
      const at = currentAction(w.state, ctx.definition);
      if (!at) return refused(state, 'no_action');
      let flow: Flow | 'await';
      if (input.type === 'decline') {
        if (!at.action.optional) return refused(state, 'not_optional');
        // A fight already begun cannot be walked away from.
        if (w.state.rooms[room.id]?.actions[at.action.id]?.status === 'in_progress') return refused(state, 'not_optional');
        record(w, room, at.action, { status: 'declined', outcome: DECLINED_OUTCOME, detail: null });
        w.state.recent.push({ kind: 'declined', roomId: room.id, actionId: at.action.id });
        w.log.push({ type: 'action_declined', roomId: room.id, actionId: at.action.id, payload: { actionType: at.action.type } });
        flow = follow(w, room, at.index, at.action, DECLINED_OUTCOME);
      } else {
        flow = resolveWithInput(w, room, at.index, at.action);
      }
      if (flow !== 'await' && flow.kind === 'continue') runSequence(w, room, flow.index);
      break;
    }
  }

  w.state.step = state.step + 1;
  return { status: 'applied', refusal: null, state: w.state, effects: w.effects, log: w.log, combat: w.combat };
}

/** Outcomes an action records as `failed`. Re-exported for the view and tests. */
export function isFailureOutcome(action: DungeonAction, outcome: string): boolean {
  return FAILURE_OUTCOMES[action.type].includes(outcome);
}
