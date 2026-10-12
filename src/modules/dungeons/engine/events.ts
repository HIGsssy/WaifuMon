/**
 * Dungeon events, the pure part: which event an `event` action presents,
 * which choices a player may make, and what an outcome does to the run's own
 * state. `step.ts` strings these into a step; nothing here routes, pays or
 * touches the world.
 *
 * ## Selection is made once
 *
 * A pool is rolled when the sequence first reaches the action, from a stream
 * keyed by room and action, and the result is kept on the run
 * (`state.events`). The roll is therefore the same whenever it is made, and
 * it is never made twice: leaving, returning, refreshing and retrying all
 * read the stored instance.
 *
 * ## Inventory is a fact, not a lookup
 *
 * Item requirements are judged against `ctx.inventory`, which the caller
 * supplies. Spending an item is described as an effect by `step.ts`.
 */
import {
  choiceOutcomes,
  eventActionCandidateIds,
  eventOf,
  eventPoolOf,
  isWalkAway,
  type ActionDestination,
  type DungeonDefinition,
  type DungeonEvent,
  type DungeonEventChoice,
  type DungeonEventEffect,
  type DungeonEventPool,
  type EventAction,
} from '../content/dungeonDefinition';
import { DungeonEngineContentError } from './combat';
import { evaluateCondition, type ConditionFacts } from './conditions';
import { eventCheckChance } from './eventChecks';
import { hpAfterRest, shareOf } from './rewards';
import { destinationFor } from './routing';
import type { DungeonEngineContext, DungeonEventInstance, DungeonRngSource, DungeonRunState } from './types';

/** Ids never contain a colon, so this is unambiguous. */
export function eventInstanceKey(roomId: string, actionId: string): string {
  return `${roomId}:${actionId}`;
}

/** The claim of an event's consumed items — the idempotency key of spending them. */
export function eventConsumeKey(runKey: string, roomId: string, actionId: string): string {
  return `run:${runKey}:${roomId}:${actionId}:consume`;
}

/** Every event already selected in this run, by a pool or directly. */
export function seenEventIds(state: Pick<DungeonRunState, 'events'>): Set<string> {
  const seen = new Set<string>();
  for (const instance of Object.values(state.events ?? {})) if (instance.eventId != null) seen.add(instance.eventId);
  return seen;
}

// ── pools ───────────────────────────────────────────────────────────────────

export interface EventPoolEntryAnalysis {
  id: string;
  /** Null for a Nothing entry. */
  eventId: string | null;
  weight: number;
  eligible: boolean;
  /** Why it is out of the draw. */
  reason: 'condition' | 'already_seen' | null;
  /** Unrounded, in [0, 1]. Zero when ineligible. */
  probability: number;
}
export interface EventPoolAnalysis {
  totalWeight: number;
  entries: EventPoolEntryAnalysis[];
  /** The chance that no event is presented: Nothing entries, or all of it when nothing is eligible. */
  nothingProbability: number;
}

/**
 * A pool's odds as the run stands. The engine's draw and the author's
 * probability preview both come from this, so they cannot disagree.
 */
export function analyseEventPool(pool: DungeonEventPool, facts: ConditionFacts, seen: ReadonlySet<string> = new Set()): EventPoolAnalysis {
  const judged = pool.entries.map((entry) => {
    const eventId = 'eventId' in entry ? entry.eventId : null;
    const reason = !evaluateCondition(entry.when, facts)
      ? ('condition' as const)
      : 'eventId' in entry && entry.oncePerRun && seen.has(entry.eventId)
        ? ('already_seen' as const)
        : null;
    return { id: entry.id, eventId, weight: entry.weight, eligible: reason === null, reason };
  });
  const totalWeight = judged.reduce((sum, entry) => sum + (entry.eligible ? entry.weight : 0), 0);
  const entries = judged.map((entry) => ({ ...entry, probability: entry.eligible ? entry.weight / totalWeight : 0 }));
  return {
    totalWeight,
    entries,
    nothingProbability: totalWeight === 0 ? 1 : entries.reduce((sum, entry) => sum + (entry.eventId === null ? entry.probability : 0), 0),
  };
}

/**
 * What an `event` action presents in this run. Called once per action per run;
 * the caller stores the result and never asks again.
 */
export function selectDungeonEvent(
  definition: DungeonDefinition,
  action: EventAction,
  place: { roomId: string; actionId: string },
  state: DungeonRunState,
  facts: ConditionFacts,
  rng: DungeonRngSource,
): DungeonEventInstance {
  const missing = (what: string) =>
    new DungeonEngineContentError(`room "${place.roomId}" action "${place.actionId}" presents ${what}, which the dungeon lacks`);
  if (action.source.kind === 'event') {
    if (!eventOf(definition, action.source.eventId)) throw missing(`event "${action.source.eventId}"`);
    return { eventId: action.source.eventId, status: 'offered', selectedStep: state.step };
  }
  const pool = eventPoolOf(definition, action.source.poolId);
  if (!pool) throw missing(`event pool "${action.source.poolId}"`);
  const analysis = analyseEventPool(pool, facts, seenEventIds(state));
  const eligible = analysis.entries.filter((entry) => entry.eligible);
  const drawn = { poolId: pool.id, eligible: eligible.map((entry) => entry.id), totalWeight: analysis.totalWeight };
  if (eligible.length === 0) {
    return { eventId: null, status: 'nothing', selectedStep: state.step, pool: { ...drawn, entryId: null, roll: null } };
  }
  const roll = rng.stream('event', place.roomId, place.actionId, 'pool').intInclusive(0, analysis.totalWeight - 1);
  let remaining = roll;
  // The roll is below the total weight, so the walk always lands on an entry.
  const entry = eligible.find((candidate) => (remaining -= candidate.weight) < 0)!;
  if (entry.eventId !== null && !eventOf(definition, entry.eventId)) throw missing(`event "${entry.eventId}"`);
  return {
    eventId: entry.eventId,
    status: entry.eventId === null ? 'nothing' : 'offered',
    selectedStep: state.step,
    pool: { ...drawn, entryId: entry.id, roll },
  };
}

/** The line a Nothing entry shows, if its author wrote one. */
export function eventNothingText(definition: DungeonDefinition, instance: DungeonEventInstance): string {
  const entry = eventPoolOf(definition, instance.pool?.poolId)?.entries.find((e) => e.id === instance.pool?.entryId);
  return entry && 'nothing' in entry ? (entry.text ?? '') : '';
}

// ── choices ─────────────────────────────────────────────────────────────────

export interface DungeonEventItemView {
  item: string;
  quantity: number;
  /** Spent when the choice is selected. */
  consume: boolean;
  owned: number;
}

export interface DungeonEventChoiceView {
  id: string;
  label: string;
  description: string;
  available: boolean;
  /**
   *   requires     a rule about the run does not hold
   *   items        the player does not hold what it needs
   *   no_way_back  it turns back, and there is nowhere to go back to
   */
  unavailableReason: 'requires' | 'items' | 'no_way_back' | null;
  /** The author's line for an unavailable choice; empty when none was written. */
  unavailableText: string;
  /** The success chance and the pinned SP behind it; null when the outcome is certain. */
  check: { chanceBasisPoints: number; sp: number | null } | null;
  items: DungeonEventItemView[];
  /**
   * Selecting this spends the `consume` items at once — before any check is
   * rolled, and whether or not it then succeeds. A screen must say so.
   */
  consumesOnSelect: boolean;
  /** Steps back and leaves the event open; nothing is spent or decided. */
  walksAway: boolean;
}

export interface DungeonEventView {
  eventId: string;
  title: string;
  text: string;
  artwork: DungeonEvent['artwork'] | null;
  /** In authored order. Unavailable choices marked `hideWhenUnavailable` are left out. */
  choices: DungeonEventChoiceView[];
}

export interface EventChoiceFacts {
  facts: ConditionFacts;
  inventory: Readonly<Record<string, number>>;
  /** The room the player arrived from; null at the entrance on a first arrival. */
  cameFrom: string | null;
  currentSp: number | null | undefined;
}

export function describeEventChoice(choice: DungeonEventChoice, at: EventChoiceFacts): DungeonEventChoiceView {
  const items = (choice.items ?? []).map((requirement) => ({
    item: requirement.item,
    quantity: requirement.quantity,
    consume: requirement.consume,
    owned: Object.hasOwn(at.inventory, requirement.item) ? Math.max(0, at.inventory[requirement.item]!) : 0,
  }));
  const walksAway = choiceOutcomes(choice).some(({ outcome }) => isWalkAway(outcome));
  const unavailableReason = !evaluateCondition(choice.requires, at.facts)
    ? ('requires' as const)
    : items.some((item) => item.owned < item.quantity)
      ? ('items' as const)
      : walksAway && at.cameFrom == null
        ? ('no_way_back' as const)
        : null;
  return {
    id: choice.id,
    label: choice.label,
    description: choice.description ?? '',
    available: unavailableReason === null,
    unavailableReason,
    unavailableText: choice.unavailableText ?? '',
    check: choice.check ? { chanceBasisPoints: eventCheckChance(choice.check, at.currentSp), sp: at.currentSp ?? null } : null,
    items,
    consumesOnSelect: items.some((item) => item.consume),
    walksAway,
  };
}

export function choiceFacts(state: DungeonRunState, ctx: Pick<DungeonEngineContext, 'playerFlags' | 'inventory' | 'fighter'>): EventChoiceFacts {
  return {
    facts: { flags: state.flags, playerFlags: ctx.playerFlags ?? {}, rooms: state.rooms },
    inventory: ctx.inventory ?? {},
    cameFrom: state.cursor.cameFrom,
    currentSp: ctx.fighter.currentSp,
  };
}

/** The event the cursor's action is offering, as a screen needs it; null when it offers none. */
export function describeOfferedEvent(
  state: DungeonRunState,
  ctx: Pick<DungeonEngineContext, 'definition' | 'playerFlags' | 'inventory' | 'fighter'>,
): DungeonEventView | null {
  if (state.cursor.actionId == null) return null;
  const instance = state.events?.[eventInstanceKey(state.cursor.roomId, state.cursor.actionId)];
  if (instance?.status !== 'offered') return null;
  const event = eventOf(ctx.definition, instance.eventId);
  if (!event) return null;
  const at = choiceFacts(state, ctx);
  return {
    eventId: event.id,
    title: event.title,
    text: event.text,
    artwork: event.artwork ?? null,
    choices: event.choices
      .map((choice) => ({ choice, view: describeEventChoice(choice, at) }))
      .filter(({ choice, view }) => view.available || !choice.hideWhenUnavailable)
      .map(({ view }) => view),
  };
}

/** One event choice a step made (or walked away from), in the words its author wrote. */
export interface DungeonEventResultView {
  roomId: string;
  actionId: string;
  eventTitle: string;
  choiceLabel: string;
  /** The outcome's own text; empty when its author wrote none. */
  text: string;
  tone: 'good' | 'neutral' | 'bad';
}

/** The event entries of a step's `recent`, read against the definition the run plays. */
export function describeEventResults(definition: DungeonDefinition, recent: DungeonRunState['recent']): DungeonEventResultView[] {
  return recent.flatMap((entry): DungeonEventResultView[] => {
    if (entry.kind !== 'event') return [];
    const event = eventOf(definition, entry.eventId);
    const choice = event?.choices.find((c) => c.id === entry.choiceId);
    if (!event || !choice) return [];
    const outcome = choice[entry.branch];
    return [{ roomId: entry.roomId, actionId: entry.actionId, eventTitle: event.title, choiceLabel: choice.label, text: outcome?.text ?? '', tone: outcome?.tone ?? 'neutral' }];
  });
}

// ── outcomes ────────────────────────────────────────────────────────────────

/**
 * Apply an outcome's effects to the run's own state: flags and HP. Rewards
 * and item consumption are not state changes and are not handled here.
 * Damage never takes the Buddy below 1 HP.
 */
export function applyEventEffects(
  state: DungeonRunState,
  maxHp: number,
  effects: readonly DungeonEventEffect[],
): { flags: { flag: string; value: boolean }[]; hpBefore: number; hpAfter: number } {
  const hpBefore = state.hp;
  const flags: { flag: string; value: boolean }[] = [];
  for (const effect of effects) {
    switch (effect.type) {
      case 'set_flag':
        state.flags[effect.flag] = effect.value;
        flags.push({ flag: effect.flag, value: effect.value });
        break;
      case 'heal':
        state.hp = hpAfterRest(maxHp, state.hp, effect.basisPoints);
        break;
      case 'damage':
        state.hp = Math.min(state.hp, Math.max(1, state.hp - Math.max(0, shareOf(maxHp, effect.basisPoints))));
        break;
    }
  }
  return { flags, hpBefore, hpAfter: state.hp };
}

// ── routing, for validation ─────────────────────────────────────────────────

/** The events an `event` action can present that exist, in authored order. */
export function eventActionCandidates(definition: DungeonDefinition, action: EventAction): DungeonEvent[] {
  return eventActionCandidateIds(definition, action).flatMap((eventId) => {
    const event = eventOf(definition, eventId);
    return event ? [event] : [];
  });
}

/** Whether an `event` action can end up presenting nothing. */
export function eventActionMayPresentNothing(definition: DungeonDefinition, action: EventAction): boolean {
  if (action.source.kind === 'event') return false;
  const pool = eventPoolOf(definition, action.source.poolId);
  // An entry that is always in the draw and is an event that can repeat makes Nothing impossible only
  // when every entry is such an event; anything else leaves a way to draw none.
  return !pool || !pool.entries.every((entry) => 'eventId' in entry && !entry.when && !entry.oncePerRun);
}

/**
 * Every place an `event` action can send the sequence, whichever event and
 * choice it turns out to be. The action's own routing for `resolved` counts
 * only if some outcome leaves the destination to it, and `nothing` only if a
 * draw can come up empty. An action whose event or pool is missing is given
 * both, so one broken reference is not also reported as dead routing.
 */
export function eventActionDestinations(definition: DungeonDefinition, action: EventAction): ActionDestination[] {
  const destinations: ActionDestination[] = [];
  const candidates = eventActionCandidates(definition, action);
  let usesActionRouting = candidates.length === 0;
  for (const event of candidates) {
    for (const choice of event.choices) {
      for (const { outcome } of choiceOutcomes(choice)) {
        if (outcome.then) destinations.push(outcome.then);
        else usesActionRouting = true;
      }
    }
  }
  if (usesActionRouting) destinations.push(destinationFor(action, 'resolved'));
  if (eventActionMayPresentNothing(definition, action)) destinations.push(destinationFor(action, 'nothing'));
  return destinations;
}
