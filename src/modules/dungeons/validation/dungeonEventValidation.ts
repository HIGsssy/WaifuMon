/**
 * Validation of a dungeon's events and event pools. Pure, like the rest of
 * `validation/`: the caller supplies whatever lives outside the definition.
 *
 * ## Structure for everything, catalogues for what can run
 *
 * An event may sit in the library without any room using it. Its *structure*
 * is checked regardless — ids, flags, the always-available choice, the
 * walk-away rules — because a malformed definition is malformed whether or not
 * it is used. Its *catalogue references* (required items here; reward
 * dependencies and artwork through the shared traversal) are checked only for
 * events an `event` action can present: an event that cannot run cannot need
 * anything, and must not hold up the publication of the rest of the dungeon.
 */
import {
  RESERVED_EVENT_EFFECT_TYPES,
  DUNGEON_EVENT_EFFECT_TYPES,
  choiceOutcomes,
  eventOf,
  eventPoolOf,
  isAlwaysAvailable,
  isWalkAway,
  reachableDungeonEvents,
  usedDungeonEventPools,
  type DungeonCondition,
  type DungeonDefinition,
  type DungeonEvent,
  type DungeonEventChoice,
  type DungeonFlagDeclaration,
  type EventAction,
} from '../content/dungeonDefinition';
import { EVENT_CHECK_MAX_CHANCE_BASIS_POINTS, EVENT_CHECK_MIN_CHANCE_BASIS_POINTS } from '../engine/eventChecks';
import { eventActionCandidates } from '../engine/events';
import { destinationFor } from '../engine/routing';
import type { DungeonIssue, DungeonIssueCode, DungeonValidationContext } from './dungeonValidation';

/** What the definition validator lends this module. */
export interface EventValidationTools {
  add(code: DungeonIssueCode, severity: DungeonIssue['severity'], path: string, message: string): void;
  /** Depth, declared flags, scopes, rooms — and records the flags it reads. */
  checkCondition(condition: DungeonCondition | undefined, path: string): void;
  flagByKey: ReadonlyMap<string, DungeonFlagDeclaration>;
}

/**
 * Reserved and unknown effect types, found on the raw document before the
 * schema sees it, so the author is told the effect is later work rather than
 * shown a union error.
 */
export function eventEffectTypeIssues(raw: unknown): { issues: DungeonIssue[]; paths: Set<string> } {
  const issues: DungeonIssue[] = [];
  const paths = new Set<string>();
  const events = (raw as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return { issues, paths };
  events.forEach((event, e) => {
    const choices = (event as { choices?: unknown } | null)?.choices;
    if (!Array.isArray(choices)) return;
    choices.forEach((choice, c) => {
      for (const branch of ['outcome', 'success', 'failure'] as const) {
        const effects = (choice as Record<string, { effects?: unknown } | null> | null)?.[branch]?.effects;
        if (!Array.isArray(effects)) continue;
        effects.forEach((effect, x) => {
          const type = (effect as { type?: unknown } | null)?.type;
          if (typeof type !== 'string' || (DUNGEON_EVENT_EFFECT_TYPES as readonly string[]).includes(type)) return;
          const path = `events[${e}].choices[${c}].${branch}.effects[${x}]`;
          paths.add(path);
          issues.push({
            code: 'unsupported_event_effect',
            severity: 'error',
            path: `${path}.type`,
            message: (RESERVED_EVENT_EFFECT_TYPES as readonly string[]).includes(type)
              ? `"${type}" effects are not supported yet — they are planned for a later phase`
              : `"${type}" is not an event effect (expected one of ${DUNGEON_EVENT_EFFECT_TYPES.join(', ')})`,
          });
        });
      }
    });
  });
  return { issues, paths };
}

/** Run flags the outcomes of reachable events set, so a lock that waits on one is not reported as never set. */
export function eventFlagsSet(definition: DungeonDefinition): Set<string> {
  const reachable = reachableDungeonEvents(definition);
  const flags = new Set<string>();
  for (const event of definition.events ?? []) {
    if (!reachable.has(event.id)) continue;
    for (const choice of event.choices) {
      for (const { outcome } of choiceOutcomes(choice)) {
        for (const effect of outcome.effects) if (effect.type === 'set_flag') flags.add(effect.flag);
      }
    }
  }
  return flags;
}

/** A choice every player can pick that takes the run somewhere other than back. */
function isOpenWayOn(choice: DungeonEventChoice): boolean {
  return isAlwaysAvailable(choice) && choiceOutcomes(choice).every(({ outcome }) => !isWalkAway(outcome));
}

/** `x and not x` at the top of a rule: the choice can never be picked. */
function contradictoryFlag(condition: DungeonCondition | undefined): string | null {
  if (condition?.type !== 'all') return null;
  const wanted = new Map<string, boolean>();
  for (const part of condition.conditions) {
    const flag = part.type === 'flag' ? part : part.type === 'not' && part.condition.type === 'flag' ? { ...part.condition, equals: !part.condition.equals } : null;
    if (!flag) continue;
    const key = `${flag.scope}:${flag.flag}`;
    if (wanted.has(key) && wanted.get(key) !== flag.equals) return flag.flag;
    wanted.set(key, flag.equals);
  }
  return null;
}

function duplicates<T>(list: readonly T[], keyOf: (item: T) => string, report: (index: number, key: string, first: number) => void): void {
  const seen = new Map<string, number>();
  list.forEach((item, i) => {
    const key = keyOf(item);
    const first = seen.get(key);
    if (first !== undefined) report(i, key, first);
    else seen.set(key, i);
  });
}

function validateEvent(event: DungeonEvent, e: number, reachable: boolean, ctx: DungeonValidationContext, tools: EventValidationTools): void {
  const { add } = tools;
  const path = `events[${e}]`;
  const label = `event "${event.title}"`;
  duplicates(event.choices, (c) => c.id, (i, key, first) =>
    add('duplicate_choice_id', 'error', `${path}.choices[${i}].id`, `choice id "${key}" is already used by choices[${first}] of ${label}`),
  );
  if (!event.choices.some(isAlwaysAvailable)) {
    add('event_no_open_choice', 'error', `${path}.choices`, `${label} has no choice every player can pick: give it one with no rule and no required item, or a player could be stuck in it`);
  }
  event.choices.forEach((choice, c) => {
    const choicePath = `${path}.choices[${c}]`;
    const choiceLabel = `${label}, choice "${choice.label}"`;
    tools.checkCondition(choice.requires, `${choicePath}.requires`);
    const contradiction = contradictoryFlag(choice.requires);
    if (contradiction) {
      add('event_choice_contradiction', 'warning', `${choicePath}.requires`, `${choiceLabel} needs "${contradiction}" to be both true and false, so it can never be picked`);
    }

    duplicates(choice.items ?? [], (i) => i.item, (i, key) =>
      add('event_item_duplicate', 'error', `${choicePath}.items[${i}].item`, `${choiceLabel} lists item "${key}" twice; give it one entry with the total quantity`),
    );
    // Whether an item exists is a question about this server, asked only of events that can run.
    if (reachable && ctx.items) {
      (choice.items ?? []).forEach((requirement, i) => {
        const item = ctx.items!.get(requirement.item);
        if (!item) add('event_item_missing', 'error', `${choicePath}.items[${i}].item`, `${choiceLabel} needs item "${requirement.item}", which does not exist. Pick another item.`);
        else if (!item.enabled) add('event_item_disabled', 'warning', `${choicePath}.items[${i}].item`, `${choiceLabel} needs "${item.name}", which is disabled, so players may never hold it`);
      });
    }

    if (choice.check && choice.check.maxSpModifierBasisPoints === 0 &&
      (choice.check.baseChanceBasisPoints < EVENT_CHECK_MIN_CHANCE_BASIS_POINTS || choice.check.baseChanceBasisPoints > EVENT_CHECK_MAX_CHANCE_BASIS_POINTS)) {
      add('event_check_flat', 'warning', `${choicePath}.check`, `${choiceLabel} has a check Buddy strength cannot move, set outside 5–95%: every player gets the same ${choice.check.baseChanceBasisPoints < EVENT_CHECK_MIN_CHANCE_BASIS_POINTS ? '5%' : '95%'}`);
    }

    for (const { branch, outcome } of choiceOutcomes(choice)) {
      const outcomePath = `${choicePath}.${branch}`;
      outcome.effects.forEach((effect, x) => {
        if (effect.type !== 'set_flag') return;
        const declared = tools.flagByKey.get(effect.flag);
        if (!declared) {
          add('flag_undeclared', 'error', `${outcomePath}.effects[${x}].flag`, `${choiceLabel} sets flag "${effect.flag}", which the dungeon does not declare`);
        } else if (declared.scope !== 'run') {
          add('flag_scope_unsupported', 'error', `${outcomePath}.effects[${x}].flag`, `${choiceLabel} sets "${effect.flag}", a player-scoped flag; persistent flags cannot be written yet`);
        }
      });
      if (!isWalkAway(outcome)) continue;
      // Walking away decides nothing, so it can cost and change nothing.
      if (choice.check) {
        add('event_check_retreat', 'error', `${outcomePath}.then`, `${choiceLabel} turns the player back after a check; a choice that turns back cannot have a check, because the event stays open and the check would be asked again`);
      }
      if (outcome.effects.length > 0 || outcome.rewards || (choice.items ?? []).some((i) => i.consume)) {
        add('event_retreat_with_effects', 'error', `${outcomePath}.then`, `${choiceLabel} turns the player back, which leaves the event open: it cannot also have effects, rewards or use up an item`);
      }
    }
  });
}

/** The library: every event and pool, used or not. */
export function validateDungeonEvents(definition: DungeonDefinition, ctx: DungeonValidationContext, tools: EventValidationTools): void {
  const { add } = tools;
  const events = definition.events ?? [];
  const pools = definition.eventPools ?? [];
  const reachable = reachableDungeonEvents(definition);
  const usedPools = usedDungeonEventPools(definition);
  const eventIds = new Set(events.map((e) => e.id));

  duplicates(events, (e) => e.id, (i, key, first) =>
    add('duplicate_event_id', 'error', `events[${i}].id`, `event id "${key}" is already used by events[${first}]`),
  );
  duplicates(pools, (p) => p.id, (i, key, first) =>
    add('duplicate_event_pool_id', 'error', `eventPools[${i}].id`, `event pool id "${key}" is already used by eventPools[${first}]`),
  );

  events.forEach((event, e) => {
    if (!reachable.has(event.id)) {
      add('event_unused', 'warning', `events[${e}]`, `event "${event.title}" is not used by any room or pool that a room uses, so players never see it`);
    }
    validateEvent(event, e, reachable.has(event.id), ctx, tools);
  });

  pools.forEach((pool, p) => {
    const path = `eventPools[${p}]`;
    const label = `event pool "${pool.name}"`;
    if (!usedPools.has(pool.id)) add('event_pool_unused', 'warning', path, `${label} is not used by any room`);
    duplicates(pool.entries, (entry) => entry.id, (i, key, first) =>
      add('duplicate_pool_entry_id', 'error', `${path}.entries[${i}].id`, `entry id "${key}" is already used by entries[${first}] of ${label}`),
    );
    const eventEntries = pool.entries.flatMap((entry, i) => ('eventId' in entry ? [{ entry, i }] : []));
    duplicates(eventEntries, ({ entry }) => entry.eventId, (index, key) =>
      add('event_pool_duplicate_event', 'error', `${path}.entries[${eventEntries[index]!.i}].eventId`, `${label} lists event "${key}" more than once; give it one entry with the combined weight`),
    );
    if (eventEntries.length === 0) {
      add('event_pool_all_nothing', 'error', `${path}.entries`, `${label} holds only Nothing: it can never present an event`);
    }
    pool.entries.forEach((entry, i) => {
      tools.checkCondition(entry.when, `${path}.entries[${i}].when`);
      if ('eventId' in entry && !eventIds.has(entry.eventId)) {
        add('event_missing', 'error', `${path}.entries[${i}].eventId`, `${label} lists event "${entry.eventId}", which is not one of the dungeon's events`);
      }
    });
    // An entry with no rule that is Nothing, or an event that may repeat, is always in the draw.
    if (!pool.entries.some((entry) => !entry.when && ('nothing' in entry || !entry.oncePerRun))) {
      add('event_pool_may_be_empty', 'warning', `${path}.entries`, `every entry of ${label} has a rule or is once per run, so a draw can find nothing left; it then presents nothing, silently. Add a Nothing entry to say so on purpose`);
    }
  });
}

/** One `event` action, where it sits. */
export function validateEventAction(
  definition: DungeonDefinition,
  action: EventAction,
  path: string,
  isEntrance: boolean,
  tools: EventValidationTools,
): void {
  const { add } = tools;
  if (action.optional) {
    add('event_optional_unsupported', 'error', `${path}.optional`, `event "${action.id}" is marked optional; an event is answered with one of its choices, so give it a choice that walks away instead`);
  }
  const { source } = action;
  if (source.kind === 'event') {
    if (!eventOf(definition, source.eventId)) {
      add('event_missing', 'error', `${path}.source.eventId`, `action "${action.id}" presents event "${source.eventId}", which is not one of the dungeon's events`);
    }
  } else if (!eventPoolOf(definition, source.poolId)) {
    add('event_pool_missing', 'error', `${path}.source.poolId`, `action "${action.id}" draws from event pool "${source.poolId}", which is not one of the dungeon's event pools`);
  }
  // A resolved (or empty) event never runs again, so routing that turns back would turn the player back for good.
  for (const outcome of ['resolved', 'nothing'] as const) {
    if (destinationFor(action, outcome).type === 'retreat') {
      add('event_route_retreat', 'error', action.outcomes[outcome] ? `${path}.outcomes.${outcome}` : `${path}.next`, `event "${action.id}" routes "${outcome}" back the way the player came; an event is settled once, so the room could never be passed. Use a choice that walks away instead`);
    }
  }
  if (!isEntrance) return;
  // On a first arrival there is nowhere to walk back to, so walking away is not on offer at the entrance.
  for (const event of eventActionCandidates(definition, action)) {
    if (!event.choices.some(isOpenWayOn)) {
      add('event_entrance_no_exit', 'error', `${path}.source`, `event "${event.title}" can appear in the entrance room, where a player cannot turn back: it needs a choice with no rule and no required item that carries on, finishes the room or ends the run`);
    }
  }
}
