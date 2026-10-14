/**
 * Where a dungeon definition holds reward bundles — the one traversal.
 *
 * A bundle sits on a fight, a boss or a treasure, or on the outcome of an
 * event choice. Everything that needs "every reward this dungeon can pay"
 * (dependencies, the publication snapshot, validation, work bounds, package
 * manifests, the importer's table-key rewrite) reads it from here, so a bundle
 * cannot be visible to one of them and missed by another.
 *
 * ## Reachable, not merely written
 *
 * An event is part of the dungeon's library whether or not a room uses it.
 * Only events an `event` action can present — named directly, or through a
 * pool the action draws from — can ever pay. `dungeonRewardSites` reports
 * those by default; an unused event's rewards are not a publication
 * dependency. `scope: 'all'` adds the rest, for rewriting and tooling.
 *
 * Structural input, no schema import: `dungeonDefinition.ts` and
 * `dungeonRewards.ts` both use this, and it must not import either at run time.
 */
import type { DungeonRewardBundle } from './dungeonRewards';

interface OutcomeShape {
  rewards?: DungeonRewardBundle | undefined;
}
interface ChoiceShape {
  id: string;
  outcome?: OutcomeShape | undefined;
  success?: OutcomeShape | undefined;
  failure?: OutcomeShape | undefined;
  items?: readonly { item: string }[] | undefined;
}
interface EventShape {
  id: string;
  choices: readonly ChoiceShape[];
}
interface PoolShape {
  id: string;
  entries: readonly { id: string; eventId?: string | undefined }[];
}
interface ActionShape {
  id: string;
  type: string;
  rewards?: DungeonRewardBundle | undefined;
  source?: { kind: 'species'; species: string } | { kind: 'event'; eventId: string } | { kind: 'pool'; poolId: string } | undefined;
}
/** The parts of a dungeon definition the traversal reads. A `DungeonDefinition` is one. */
export interface DungeonRewardSiteDefinition {
  rooms: readonly { id: string; actions: readonly ActionShape[] }[];
  events?: readonly EventShape[] | undefined;
  eventPools?: readonly PoolShape[] | undefined;
}

const BRANCHES = ['outcome', 'success', 'failure'] as const;

export type DungeonRewardSiteOwner =
  | { kind: 'action'; roomIndex: number; actionIndex: number; roomId: string; actionId: string }
  | { kind: 'event'; eventIndex: number; choiceIndex: number; eventId: string; choiceId: string; branch: (typeof BRANCHES)[number] };

export interface DungeonRewardSite {
  /** Dotted path of the bundle in the definition, e.g. `rooms[1].actions[0].rewards`. */
  path: string;
  bundle: DungeonRewardBundle;
  owner: DungeonRewardSiteOwner;
}

/** Whether a definition has any event content: an `event` action, or an event or pool library. */
export function dungeonUsesEvents(definition: DungeonRewardSiteDefinition): boolean {
  return (
    definition.events !== undefined ||
    definition.eventPools !== undefined ||
    definition.rooms.some((room) => room.actions.some((action) => action.type === 'event'))
  );
}

/** The ids of the events an `event` action can present, in authored order. They may not exist. */
export function eventActionCandidateIds(definition: DungeonRewardSiteDefinition, action: ActionShape): string[] {
  if (action.type !== 'event' || !action.source) return [];
  if (action.source.kind === 'event') return [action.source.eventId];
  if (action.source.kind !== 'pool') return [];
  const poolId = action.source.poolId;
  const pool = definition.eventPools?.find((p) => p.id === poolId);
  return [...new Set((pool?.entries ?? []).flatMap((entry) => (entry.eventId === undefined ? [] : [entry.eventId])))];
}

/** Every event id some `event` action can present. */
export function reachableDungeonEvents(definition: DungeonRewardSiteDefinition): Set<string> {
  const ids = new Set<string>();
  for (const room of definition.rooms) {
    for (const action of room.actions) for (const eventId of eventActionCandidateIds(definition, action)) ids.add(eventId);
  }
  return ids;
}

/** Every pool id some `event` action draws from. */
export function usedDungeonEventPools(definition: DungeonRewardSiteDefinition): Set<string> {
  const ids = new Set<string>();
  for (const room of definition.rooms) {
    for (const action of room.actions) if (action.type === 'event' && action.source?.kind === 'pool') ids.add(action.source.poolId);
  }
  return ids;
}

function eventSites(event: EventShape, eventIndex: number): DungeonRewardSite[] {
  return event.choices.flatMap((choice, choiceIndex) =>
    BRANCHES.flatMap((branch) => {
      const bundle = choice[branch]?.rewards;
      return bundle
        ? [{
            path: `events[${eventIndex}].choices[${choiceIndex}].${branch}.rewards`,
            bundle,
            owner: { kind: 'event' as const, eventIndex, choiceIndex, eventId: event.id, choiceId: choice.id, branch },
          }]
        : [];
    }),
  );
}

/**
 * Every reward bundle the dungeon can pay: activities first, room by room in
 * authored order — exactly the walk that existed before events — then the
 * reachable events in library order, each choice's outcome, success, failure.
 */
export function dungeonRewardSites(
  definition: DungeonRewardSiteDefinition,
  options: { scope?: 'reachable' | 'all' } = {},
): DungeonRewardSite[] {
  const sites: DungeonRewardSite[] = [];
  definition.rooms.forEach((room, roomIndex) =>
    room.actions.forEach((action, actionIndex) => {
      if (!action.rewards) return;
      sites.push({
        path: `rooms[${roomIndex}].actions[${actionIndex}].rewards`,
        bundle: action.rewards,
        owner: { kind: 'action', roomIndex, actionIndex, roomId: room.id, actionId: action.id },
      });
    }),
  );
  if (!definition.events?.length) return sites;
  const reachable = options.scope === 'all' ? null : reachableDungeonEvents(definition);
  definition.events.forEach((event, eventIndex) => {
    if (!reachable || reachable.has(event.id)) sites.push(...eventSites(event, eventIndex));
  });
  return sites;
}

/** One room action and the bundles it could claim: its own, or any outcome of an event it can present. */
export interface DungeonRewardActivity {
  path: string;
  roomIndex: number;
  actionIndex: number;
  /** Alternatives: one activity claims at most one of them in a run. */
  sites: DungeonRewardSite[];
}

export function dungeonRewardActivities(definition: DungeonRewardSiteDefinition): DungeonRewardActivity[] {
  const activities: DungeonRewardActivity[] = [];
  definition.rooms.forEach((room, roomIndex) =>
    room.actions.forEach((action, actionIndex) => {
      const path = `rooms[${roomIndex}].actions[${actionIndex}]`;
      if (action.rewards) {
        activities.push({
          path, roomIndex, actionIndex,
          sites: [{ path: `${path}.rewards`, bundle: action.rewards, owner: { kind: 'action', roomIndex, actionIndex, roomId: room.id, actionId: action.id } }],
        });
        return;
      }
      const candidates = eventActionCandidateIds(definition, action);
      const sites = (definition.events ?? []).flatMap((event, eventIndex) => (candidates.includes(event.id) ? eventSites(event, eventIndex) : []));
      if (sites.length) activities.push({ path, roomIndex, actionIndex, sites });
    }),
  );
  return activities;
}

/**
 * The definition with every bundle passed through `fn` — library events
 * included, used or not, so a rewrite never leaves a stale reference behind.
 * Nothing else is touched and the input is not mutated.
 */
export function mapDungeonRewardBundles<T extends DungeonRewardSiteDefinition>(
  definition: T,
  fn: (bundle: DungeonRewardBundle) => DungeonRewardBundle,
): T {
  const mapped = {
    ...definition,
    rooms: definition.rooms.map((room) => ({
      ...room,
      actions: room.actions.map((action) => (action.rewards ? { ...action, rewards: fn(action.rewards) } : action)),
    })),
    ...(definition.events
      ? {
          events: definition.events.map((event) => ({
            ...event,
            choices: event.choices.map((choice) => {
              let next = choice;
              for (const branch of BRANCHES) {
                const outcome = choice[branch];
                if (outcome?.rewards) next = { ...next, [branch]: { ...outcome, rewards: fn(outcome.rewards) } };
              }
              return next;
            }),
          })),
        }
      : {}),
  };
  return mapped as unknown as T;
}

/** Item slugs the reachable events' choices require, sorted. Not reward items: they are spent or held, never paid. */
export function dungeonRequiredItems(definition: DungeonRewardSiteDefinition): string[] {
  const reachable = reachableDungeonEvents(definition);
  const slugs = new Set<string>();
  for (const event of definition.events ?? []) {
    if (!reachable.has(event.id)) continue;
    for (const choice of event.choices) for (const requirement of choice.items ?? []) slugs.add(requirement.item);
  }
  return [...slugs].sort();
}
