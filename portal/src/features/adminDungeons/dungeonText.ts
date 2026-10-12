/**
 * The editor's plain-language reading of a dungeon definition: what an
 * activity does, what a condition tests, and what a validation issue asks the
 * author to do. Presentation only — nothing here changes stored content, and
 * the server's issues keep their severity and stay authoritative.
 */
import {
  BedDouble,
  Bookmark,
  Crown,
  Gift,
  LogOut,
  ScrollText,
  ShieldAlert,
  Swords,
  type LucideIcon,
} from 'lucide-react';
import type {
  CombatWave,
  DungeonAction,
  DungeonCondition,
  DungeonDefinition,
  DungeonEvent,
  DungeonEventPool,
  DungeonIssue,
  DungeonReferenceData,
  DungeonRoom,
} from '@/api/adminDungeons';
import { bundleIssueText, rewardsSummary } from '@/features/adminDungeonLoot/bundleModel';
import { rewardNames } from '@/features/adminDungeonLoot/lootModel';
import type { ActionType } from './dungeonActionModel';
import { incompleteEventIssues, type EventBranch } from './dungeonEventModel';
import type { MapSelection } from './dungeonMapModel';

export const ACTIVITIES: Record<ActionType, { title: string; hint: string; icon: LucideIcon }> = {
  combat: { title: 'Fight', hint: 'Battle enemies in waves', icon: Swords },
  boss: { title: 'Boss fight', hint: 'A fight presented as a boss', icon: Crown },
  reward: { title: 'Treasure', hint: 'Give the player a reward', icon: Gift },
  rest: { title: 'Rest', hint: 'Restore HP', icon: BedDouble },
  gate: { title: 'Checkpoint', hint: 'Only let players past if…', icon: ShieldAlert },
  set_flag: {
    title: 'Remember something',
    hint: 'Note that something happened, to use in a rule later',
    icon: Bookmark,
  },
  leave: { title: 'Leave through a path', hint: 'Send the player onward', icon: LogOut },
};
/** Not in `ACTIVITIES`: an event is attached through the room's Event control, which also picks what it presents. */
export const EVENT_ACTIVITY = {
  title: 'Event',
  hint: 'A story moment with choices',
  icon: ScrollText,
};
export const isEventActivity = (action: DungeonAction) => action.type === 'event';
export const activityOf = (action: DungeonAction) =>
  isEventActivity(action)
    ? EVENT_ACTIVITY
    : (ACTIVITIES[action.type as ActionType] ?? { title: action.type, hint: '', icon: Bookmark });

export type EventSourceView =
  | { kind: 'event'; event: DungeonEvent }
  | {
      kind: 'pool';
      pool: DungeonEventPool;
      /** The events the pool can present that exist, in entry order. */
      events: DungeonEvent[];
      entries: Array<{
        id: string;
        label: string;
        /** Its share of the total weight, with every entry in the draw. */
        shareBasisPoints: number;
        conditional: boolean;
        oncePerRun: boolean;
      }>;
    }
  | { kind: 'missing'; what: string };

/** What an event activity presents, looked up in the dungeon's own events and pools. Reads only. */
export function eventSourceOf(
  action: DungeonAction,
  definition: DungeonDefinition,
): EventSourceView {
  const source = action.source;
  if (!source) return { kind: 'missing', what: 'an event' };
  const events = definition.events ?? [];
  if (source.kind === 'event') {
    const event = events.find((e) => e.id === source.eventId);
    return event ? { kind: 'event', event } : { kind: 'missing', what: 'an event' };
  }
  const pool = (definition.eventPools ?? []).find((p) => p.id === source.poolId);
  if (!pool) return { kind: 'missing', what: 'a random pool' };
  const total = pool.entries.reduce((sum, entry) => sum + entry.weight, 0);
  const eventOf = (id: string) => events.find((e) => e.id === id);
  return {
    kind: 'pool',
    pool,
    events: pool.entries.flatMap((entry) => {
      const event = 'eventId' in entry ? eventOf(entry.eventId) : undefined;
      return event ? [event] : [];
    }),
    entries: pool.entries.map((entry) => ({
      id: entry.id,
      label:
        'eventId' in entry
          ? (eventOf(entry.eventId)?.title ?? 'A missing event')
          : 'Nothing happens',
      shareBasisPoints: total > 0 ? Math.round((entry.weight * 10_000) / total) : 0,
      conditional: Boolean(entry.when),
      oncePerRun: 'eventId' in entry && entry.oncePerRun !== false,
    })),
  };
}

export const roomLabel = (room: DungeonRoom | undefined) => room?.name || 'Unnamed room';
export function roomNameOf(definition: DungeonDefinition, id: string) {
  const room = definition.rooms.find((r) => r.id === id);
  return room ? roomLabel(room) : 'a missing room';
}
export function flagNameOf(definition: DungeonDefinition, key: string) {
  if (!key) return 'nothing chosen';
  return definition.flags.find((f) => f.key === key)?.description || 'an unnamed note';
}
export function enemyNameOf(reference: DungeonReferenceData | undefined, key: string) {
  if (!key) return 'no enemy chosen';
  return reference?.enemies.find((e) => e.key === key)?.name ?? `unknown enemy (${key})`;
}
export function waveText(wave: CombatWave, reference: DungeonReferenceData | undefined) {
  if ('key' in wave.enemy) return enemyNameOf(reference, wave.enemy.key);
  return `one of ${wave.enemy.pool.map((e) => enemyNameOf(reference, e.key)).join(' / ')}`;
}

export function conditionText(
  condition: DungeonCondition | undefined,
  definition: DungeonDefinition,
): string {
  if (!condition) return 'always';
  switch (condition.type) {
    case 'flag':
      return `“${flagNameOf(definition, condition.flag)}” ${condition.equals === false ? 'has not happened' : 'has happened'}`;
    case 'room_completed':
      return `${roomNameOf(definition, condition.roomId)} is completed`;
    case 'all':
    case 'any':
      return condition.conditions
        .map((c) => conditionText(c, definition))
        .join(condition.type === 'all' ? ' and ' : ' or ');
    case 'not':
      return `not (${conditionText(condition.condition, definition)})`;
  }
}

const bundleSummary = (action: DungeonAction, reference: DungeonReferenceData | undefined) =>
  rewardsSummary(action.rewards!, rewardNames(reference?.items), reference?.lootTables);

/** One sentence for a collapsed activity card. */
export function activitySummary(
  action: DungeonAction,
  definition: DungeonDefinition,
  reference: DungeonReferenceData | undefined,
): string {
  switch (action.type) {
    case 'combat':
    case 'boss': {
      const fight = (action.waves ?? []).map((w) => waveText(w, reference)).join(', then ');
      return action.rewards ? `${fight}. Rewards: ${bundleSummary(action, reference)}` : fight;
    }
    case 'rest':
      return `Restore ${(action.healBasisPoints ?? 3000) / 100}% HP`;
    case 'reward': {
      if (action.rewards) return bundleSummary(action, reference);
      const reward = action.reward;
      const parts = [reward?.rewardTable, reward?.equipmentRewardTable].filter(Boolean);
      if (reward && reward.currency.max > 0)
        parts.push(
          `${reward.currency.min}–${reward.currency.max} ${definition.settings.progressionCurrency ?? 'currency'}`,
        );
      return parts.length ? parts.join(' + ') : 'No reward chosen yet';
    }
    case 'gate':
      return `Continue only if ${conditionText(action.requires, definition)}`;
    case 'set_flag':
      return `${action.value === false ? 'Forget' : 'Remember'} “${flagNameOf(definition, action.flag ?? '')}”`;
    case 'leave': {
      const connection = definition.connections.find((c) => c.id === action.connectionId);
      return connection ? `Go to ${roomNameOf(definition, connection.to)}` : 'Finish this room';
    }
    case 'event': {
      const source = eventSourceOf(action, definition);
      if (source.kind === 'event') {
        const n = source.event.choices.length;
        return `“${source.event.title}” — ${n} ${n === 1 ? 'choice' : 'choices'}`;
      }
      if (source.kind === 'pool') {
        const n = source.events.length;
        return `Random: “${source.pool.name}” — one of ${n} ${n === 1 ? 'event' : 'events'}, or nothing`;
      }
      return `Missing: ${source.what} that is not in this dungeon`;
    }
    default:
      return '';
  }
}

/** Settings beyond the ordinary, so nothing customised hides behind a collapsed card. */
export function activityChips(action: DungeonAction): string[] {
  const chips: string[] = [];
  if (action.optional) chips.push('Can be skipped');
  if (action.when) chips.push('Conditional');
  if (action.next || Object.keys(action.outcomes ?? {}).length) chips.push('Custom flow');
  if (action.label) chips.push('Custom button text');
  if (action.advance === 'auto') chips.push('Automatic waves');
  if (action.waves?.some((w) => 'pool' in w.enemy)) chips.push('Random enemies');
  return chips;
}

/** A short description of everything a room holds, for its card on the map. */
export function roomSummary(
  room: DungeonRoom,
  definition: DungeonDefinition,
  reference: DungeonReferenceData | undefined,
): string {
  if (room.actions.length === 0)
    return room.kind === 'exit' ? 'The dungeon is completed here' : 'Nothing happens here yet';
  return room.actions
    .map((a) => {
      const summary = activitySummary(a, definition, reference);
      return a.type === 'combat' || a.type === 'boss' ? summary : summary || activityOf(a).title;
    })
    .join(' · ');
}

// ── validation ──────────────────────────────────────────────────────────────

/** An issue the editor raises itself: the draft cannot be saved in this state. */
export const INCOMPLETE_CODE = 'editor_incomplete';

/**
 * Fights whose enemy has not been chosen, and event fields left blank. The
 * server refuses to store them.
 */
export function incompleteIssues(definition: DungeonDefinition): DungeonIssue[] {
  const issues: DungeonIssue[] = incompleteEventIssues(definition, INCOMPLETE_CODE);
  definition.rooms.forEach((room, r) =>
    room.actions.forEach((action, a) =>
      (action.waves ?? []).forEach((wave, w) => {
        const missing = 'key' in wave.enemy ? !wave.enemy.key : wave.enemy.pool.some((e) => !e.key);
        if (missing)
          issues.push({
            code: INCOMPLETE_CODE,
            severity: 'error',
            path: `rooms[${r}].actions[${a}].waves[${w}].enemy`,
            message: 'no enemy chosen',
          });
      }),
    ),
  );
  return issues;
}

export interface FriendlyIssue {
  issue: DungeonIssue;
  /** `finish`: blocks saving. `fix`: blocks publishing. `review`: never blocks. */
  level: 'finish' | 'fix' | 'review';
  title: string;
  help: string;
  /** Map context for inline issues; settingsField overrides the repair navigation. */
  target: MapSelection;
  /** The activity inside the target room, when the issue belongs to one. */
  actionId: string | null;
  /** A dungeon-level repair rather than a room or path repair. */
  settingsField?: 'progressionCurrency';
  /** The event or pool editor, and the field in it, that repairs this. */
  eventTarget?: EventIssueTarget;
}
/** Where in the event or pool editor an issue belongs. */
export interface EventIssueTarget {
  kind: 'event' | 'pool';
  id: string;
  choiceId?: string;
  entryId?: string;
  /** The `data-event-field` to bring into view and focus. */
  field?: string;
}

const quoted = (message: string) => /"([^"]*)"/.exec(message)?.[1] ?? '';
const sentence = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/** The server's wording with ids swapped for the names an author gave things. */
function humanise(message: string, definition: DungeonDefinition) {
  const names = new Map<string, string>();
  for (const room of definition.rooms) {
    names.set(room.id, roomLabel(room));
    room.actions.forEach((a, i) =>
      names.set(a.id, `${activityOf(a).title.toLowerCase()} (activity ${i + 1})`),
    );
  }
  for (const c of definition.connections)
    names.set(c.id, `the path ${roomNameOf(definition, c.from)} → ${roomNameOf(definition, c.to)}`);
  for (const flag of definition.flags) names.set(flag.key, flag.description || 'an unnamed note');
  for (const event of definition.events ?? []) names.set(event.id, `“${event.title}”`);
  for (const pool of definition.eventPools ?? []) names.set(pool.id, `“${pool.name}”`);
  const text = message.replace(/"([^"]*)"/g, (whole, id: string) => names.get(id) ?? whole);
  return sentence(
    text.replace(
      /\baction (?=fight|boss fight|treasure|rest|checkpoint|remember|leave|event)/g,
      '',
    ),
  );
}

const EVENT_HELP: Record<string, { title: (where: string) => string; help: string }> = {
  event_no_open_choice: {
    title: (where) => `${where} needs a choice everyone can pick.`,
    help: 'Players need one choice they can always pick, or they could be stuck. Remove the rule and the item from one choice, or add a plain “Continue”.',
  },
  event_unused: {
    title: (where) => `${where} isn’t used anywhere yet.`,
    help: 'Attach it to a room or add it to a random pool. Ignore this if it is for later.',
  },
  event_pool_unused: {
    title: (where) => `${where} isn’t used by any room yet.`,
    help: 'Attach it to a room as a random event. Ignore this if it is for later.',
  },
  event_item_missing: {
    title: (where) => `${where} needs an item that no longer exists.`,
    help: 'Pick another item, or remove the requirement.',
  },
  event_item_disabled: {
    title: (where) => `${where} needs an item that is switched off.`,
    help: 'Players may never hold it, so they may never be able to pick this. Choose another item or enable this one.',
  },
  event_item_duplicate: {
    title: (where) => `${where} lists the same item twice.`,
    help: 'Keep one entry and set its quantity to the total.',
  },
  event_check_retreat: {
    title: (where) => `${where} turns the player back after a skill check.`,
    help: 'Turning back leaves the event open, so the check would be asked again. Pick another “Then”, or make this choice always give the same result.',
  },
  event_retreat_with_effects: {
    title: (where) => `${where} turns the player back, so it can’t change anything.`,
    help: 'Turning back leaves the event open. Remove its effects, rewards and used-up items, or pick another “Then”.',
  },
  event_check_flat: {
    title: (where) => `${where} has a skill check every Buddy passes or fails alike.`,
    help: 'Buddy strength is set to make no difference and the chance is beyond 5–95%. Use a certain result instead, or let strength matter.',
  },
  event_choice_contradiction: {
    title: (where) => `${where} can never be picked.`,
    help: 'Its rule needs the same thing to have happened and not happened. Open the rule and remove one side.',
  },
  event_pool_duplicate_event: {
    title: (where) => `${where} lists the same event twice.`,
    help: 'Keep one entry and give it the combined share.',
  },
  event_pool_all_nothing: {
    title: (where) => `${where} holds only Nothing.`,
    help: 'Add at least one event, or remove the pool from its rooms.',
  },
  event_pool_may_be_empty: {
    title: (where) => `${where} can run out of entries.`,
    help: 'Every entry has a rule or happens once per run, so a draw can find nothing left. It then results in Nothing, silently. Add a Nothing entry to do that on purpose.',
  },
  event_missing: {
    title: (where) => `${where} lists an event that is no longer in this dungeon.`,
    help: 'Choose another event for that entry, or remove it.',
  },
};
const INCOMPLETE_EVENT: Record<string, { title: (where: string) => string; help: string }> = {
  title: { title: (w) => `${w} needs a title.`, help: 'Give the event a title.' },
  text: { title: (w) => `${w} needs its story.`, help: 'Write what the player reads.' },
  label: { title: (w) => `${w} needs button text.`, help: 'Write what the button says.' },
  item: {
    title: (w) => `${w} needs an item chosen.`,
    help: 'Pick the item, or remove the requirement.',
  },
  name: { title: (w) => `${w} needs a name.`, help: 'Name the pool so you can find it again.' },
  eventId: {
    title: (w) => `${w} has an entry with no event chosen.`,
    help: 'Pick the event, or remove the entry.',
  },
};

/** Which field of the event or pool editor a path belongs to. */
function eventFieldOf(path: string): string | undefined {
  const rest = path
    .replace(/^(events|eventPools)\[\d+\]/, '')
    .replace(/^\.(choices|entries)\[\d+\]/, '');
  const branch = /^\.(outcome|success|failure)(?:\.(then|effects|rewards|text))?/.exec(rest);
  if (branch) return branch[2] ? `${branch[1]}.${branch[2]}` : branch[1];
  const member =
    /^\.(title|text|artwork|choices|label|description|requires|when|items|check|name|entries|eventId|weight)/.exec(
      rest,
    );
  if (!member) return undefined;
  return member[1] === 'when' ? 'requires' : member[1];
}

/**
 * The server labels an event's reward issue by event and choice; the shared
 * reward wording expects a room and activity label. Same issue, relabelled.
 */
export function asActivityRewardIssue(issue: DungeonIssue): DungeonIssue {
  return {
    ...issue,
    message: issue.message.replace(
      /^Event "[^"]*", choice "[^"]*"(?: \((?:success|failure)\))?/,
      'Room "", activity ""',
    ),
  };
}

/** An issue inside the dungeon's events or pools: named in the author's words, and aimed at its editor. */
function friendlyEventIssue(
  issue: DungeonIssue,
  definition: DungeonDefinition,
  reference: DungeonReferenceData | undefined,
): FriendlyIssue | null {
  const inEvent = /^events\[(\d+)\](?:\.choices\[(\d+)\])?/.exec(issue.path);
  const inPool = /^eventPools\[(\d+)\](?:\.entries\[(\d+)\])?/.exec(issue.path);
  if (!inEvent && !inPool) return null;
  const event = inEvent ? definition.events?.[Number(inEvent[1])] : undefined;
  const choice = inEvent?.[2] !== undefined ? event?.choices[Number(inEvent[2])] : undefined;
  const pool = inPool ? definition.eventPools?.[Number(inPool[1])] : undefined;
  const entry = inPool?.[2] !== undefined ? pool?.entries[Number(inPool[2])] : undefined;
  const where = inEvent
    ? `Event “${event?.title || 'Untitled'}”${choice ? `, choice “${choice.label || 'Untitled'}”` : ''}`
    : `Random pool “${pool?.name || 'Unnamed'}”`;
  const field = eventFieldOf(issue.path);
  const eventTarget: EventIssueTarget | undefined = event
    ? {
        kind: 'event',
        id: event.id,
        ...(choice ? { choiceId: choice.id } : {}),
        ...(field ? { field } : {}),
      }
    : pool
      ? {
          kind: 'pool',
          id: pool.id,
          ...(entry ? { entryId: entry.id } : {}),
          ...(field ? { field } : {}),
        }
      : undefined;
  const base = {
    issue,
    target: null,
    actionId: null,
    ...(eventTarget ? { eventTarget } : {}),
  } satisfies Partial<FriendlyIssue>;
  if (issue.code === INCOMPLETE_CODE) {
    const text = INCOMPLETE_EVENT[issue.path.split('.').pop() ?? ''];
    return {
      ...base,
      level: 'finish',
      title: text ? text.title(where) : `${where} is not finished.`,
      help: `${text?.help ?? ''} The draft can be saved once this is filled in.`.trim(),
    };
  }
  const level = issue.severity === 'error' ? 'fix' : 'review';
  if (issue.code === 'reward_shards_unset')
    return {
      ...base,
      level,
      title: 'Dungeon progression currency needs attention.',
      help: 'Choose an available progression currency in Dungeon Settings so this dungeon can pay Baddie Shards.',
      settingsField: 'progressionCurrency',
    };
  const branch = /\.(outcome|success|failure)\.rewards/.exec(issue.path)?.[1] as
    EventBranch | undefined;
  const bundle = branch ? choice?.[branch]?.rewards : undefined;
  if (bundle && issue.code !== 'reward_empty') {
    const found = bundleIssueText(
      asActivityRewardIssue(issue),
      bundle,
      rewardNames(reference?.items),
      reference?.items ?? [],
      reference?.lootTables,
    );
    return {
      ...base,
      level,
      title: found.subject
        ? `${where}: ${found.subject} needs attention.`
        : `${where}: its rewards need attention.`,
      help: found.text,
    };
  }
  const known = EVENT_HELP[issue.code];
  if (known) return { ...base, level, title: known.title(where), help: known.help };
  return {
    ...base,
    level,
    title: `${humanise(issue.message, definition)}${/[.!?]$/.test(issue.message) ? '' : '.'}`,
    help: '',
  };
}

export function friendlyIssue(
  issue: DungeonIssue,
  definition: DungeonDefinition,
  reference?: DungeonReferenceData,
): FriendlyIssue {
  const at = /^rooms\[(\d+)\](?:\.actions\[(\d+)\](?:\.waves\[(\d+)\])?)?/.exec(issue.path);
  const via = /^connections\[(\d+)\]/.exec(issue.path);
  const room = at ? definition.rooms[Number(at[1])] : undefined;
  const action = at?.[2] !== undefined ? room?.actions[Number(at[2])] : undefined;
  const connection = via ? definition.connections[Number(via[1])] : undefined;
  const R = roomLabel(room);
  const activity = action ? activityOf(action).title.toLowerCase() : 'activity';
  const wave = at?.[3] !== undefined ? Number(at[3]) + 1 : null;
  const unchosenEvent = issue.code === INCOMPLETE_CODE && /\.source$/.test(issue.path);
  const unchosenEnemy =
    !unchosenEvent &&
    (issue.code === INCOMPLETE_CODE || (issue.code === 'schema' && wave !== null && !!action));
  const eventIssue = friendlyEventIssue(issue, definition, reference);
  if (eventIssue) return eventIssue;

  let title: string;
  let help = '';
  if (unchosenEvent)
    return {
      issue,
      level: 'finish',
      title: `${R}: the event activity has no event chosen.`,
      help: 'Open the activity and choose an event or a random pool. The draft can be saved once it has one.',
      target: room ? { kind: 'room', id: room.id } : null,
      actionId: action?.id ?? null,
    };
  if (issue.code === 'reward_shards_unset')
    return {
      issue,
      level: issue.severity === 'error' ? 'fix' : 'review',
      title: 'Dungeon progression currency needs attention.',
      help: 'Choose an available progression currency in Dungeon Settings so this dungeon can pay Baddie Shards.',
      target: room ? { kind: 'room', id: room.id } : null,
      actionId: action?.id ?? null,
      settingsField: 'progressionCurrency',
    };
  // A problem with one of an activity's new-format rewards: say which reward, in words.
  const bundle = issue.path.includes('.rewards') ? action?.rewards : undefined;
  if (bundle && issue.code !== 'reward_empty') {
    const found = bundleIssueText(
      issue,
      bundle,
      rewardNames(reference?.items),
      reference?.items ?? [],
      reference?.lootTables,
    );
    return {
      issue,
      level: issue.severity === 'error' ? 'fix' : 'review',
      title: found.subject
        ? `${R}: ${found.subject} in the ${activity} needs attention.`
        : `${R}: the ${activity}’s rewards need attention.`,
      help: found.text,
      target: room ? { kind: 'room', id: room.id } : null,
      actionId: action?.id ?? null,
    };
  }
  switch (unchosenEnemy ? INCOMPLETE_CODE : issue.code) {
    case INCOMPLETE_CODE:
      title = `${R} needs an enemy for wave ${wave}.`;
      help = 'Choose who the player fights. The draft can be saved once every wave has an enemy.';
      break;
    case 'room_no_route_to_exit':
      title = `${R} has no way out.`;
      help = 'Connect this room to another room or to an exit.';
      break;
    case 'room_unreachable':
      title = `${R} can’t be reached.`;
      help = 'Connect another room to it, or delete it if it is not needed.';
      break;
    case 'room_empty':
      title = `${R} has no activities.`;
      help =
        'Add combat, treasure, recovery or another activity. Leave it empty if players should simply pass through.';
      break;
    case 'no_ending':
      title = 'The dungeon has no ending.';
      help = 'Add an Exit room so a run can be completed.';
      break;
    case 'entrance_missing':
      title = 'The dungeon has no start room.';
      help = 'Select a room, open its Advanced rules and make it the start room.';
      break;
    case 'exit_has_connections':
      title = `A path leads out of ${roomNameOf(definition, connection?.from ?? '')}, which is an exit.`;
      help = 'The run ends at an exit. Remove the path, or stop the room being an exit.';
      break;
    case 'exit_extraction_redundant':
      title = `${R} is an exit and also lets players leave early.`;
      help = 'The run already ends here, so the early-leave option does nothing.';
      break;
    case 'connection_self_loop':
      title = `A path leads from ${roomNameOf(definition, connection?.from ?? '')} back into itself.`;
      help = 'Point the path at another room, or remove it.';
      break;
    case 'connection_unknown_room':
      title = 'A path points at a room that no longer exists.';
      help = 'Open the path and choose its rooms again, or remove it.';
      break;
    case 'enemy_missing':
      title = `${R}: wave ${wave ?? '?'} uses an enemy that no longer exists.`;
      help = 'Choose another enemy for this wave.';
      break;
    case 'enemy_disabled':
      title = `${R}: ${enemyNameOf(reference, quoted(issue.message))} is switched off.`;
      help = 'Choose another enemy, or enable this one in the Enemy Catalogue.';
      break;
    case 'enemy_pool_duplicate':
      title = `${R}: an enemy is in the same random group twice.`;
      help = 'Keep one entry and raise its chance instead.';
      break;
    case 'reward_item_missing':
    case 'reward_item_capped':
    case 'reward_item_disabled':
    case 'reward_equipment_empty':
    case 'reward_table_archived':
    case 'reward_table_invalid':
    case 'reward_shards_unset':
    case 'reward_too_much_gear':
    case 'reward_too_many_draws':
    case 'reward_affection_too_large':
    case 'reward_currency_too_large':
    case 'reward_pool_all_nothing':
    case 'reward_legacy_mixed':
    case 'reward_abandon_more_than_defeat':
      title = humanise(issue.message, definition);
      break;
    case 'reward_empty':
      if (issue.path.includes('.rewards')) {
        title = `${R}: the ${activity} Rewards section gives nothing yet.`;
        help = 'Add a reward when this activity should give something.';
        break;
      }
      title = `The treasure in ${R} gives nothing.`;
      help = 'Choose a reward table or set a currency amount.';
      break;
    case 'reward_currency_unset':
      title = `The treasure in ${R} pays currency, but this dungeon has none set.`;
      help = 'Set the amount to 0, or give the dungeon a progression currency.';
      break;
    case 'reward_table_missing':
      if (issue.path.includes('.rewards')) {
        title = humanise(issue.message, definition);
        break;
      }
      title = `The treasure in ${R} uses a reward table that no longer exists.`;
      help = 'Choose another reward table.';
      break;
    case 'reward_table_disabled':
      title = `The treasure in ${R} uses a reward table that is switched off.`;
      help = 'It pays nothing until the table is enabled. Choose another, or enable it.';
      break;
    case 'no_regions':
      title = 'The dungeon is not available in any region.';
      help = 'Tick at least one region in Dungeon settings so players can start it.';
      break;
    case 'artwork_missing':
      title = 'A picture this dungeon uses can’t be found on this server.';
      help =
        'Players won’t see it. Check the pictures in Dungeon settings and each room’s background: the missing one is marked. Choose it again or clear it.';
      break;
    case 'retreat_from_entrance':
      title = `${R}: the ${activity} can send players back, but this is the start room.`;
      help = 'There is nowhere to go back to. Choose what happens instead under Advanced options.';
      break;
    case 'event_missing':
    case 'event_pool_missing':
      title = `${R}: the event activity points at ${issue.code === 'event_missing' ? 'an event' : 'a random pool'} that is no longer in this dungeon.`;
      help = 'Open the activity and choose another, or remove it.';
      break;
    case 'event_entrance_no_exit':
      title = `${R}: the event “${quoted(issue.message)}” can appear here, where players can’t turn back.`;
      help =
        'This is the start room, so there is nowhere to go back to. Give that event a choice with no rule and no item that carries on, finishes the room or ends the run.';
      break;
    case 'event_route_retreat':
      title = `${R}: the event’s “what happens afterward” sends players back.`;
      help =
        'An event is settled once, so the room could never be passed. Choose something else under Advanced options; to let players step away, give the event a choice that turns back.';
      break;
    case 'flag_never_set':
      title = `A rule checks “${flagNameOf(definition, quoted(issue.message))}”, but nothing ever remembers it.`;
      help =
        'Add a “Remember something” activity, or an event result that remembers it, where it should happen.';
      break;
    case 'flag_unused':
      title = `“${flagNameOf(definition, quoted(issue.message))}” is remembered but never used.`;
      help = 'Use it in a rule, or ignore this if it is for later.';
      break;
    default:
      title = `${room ? `${R}: ` : ''}${humanise(issue.message, definition)}${/[.!?]$/.test(issue.message) ? '' : '.'}`;
  }
  return {
    issue,
    level: unchosenEnemy ? 'finish' : issue.severity === 'error' ? 'fix' : 'review',
    title,
    help,
    target: room
      ? { kind: 'room', id: room.id }
      : connection
        ? { kind: 'connection', id: connection.id }
        : issue.path === 'entranceRoomId' &&
            definition.rooms.some((r) => r.id === definition.entranceRoomId)
          ? { kind: 'room', id: definition.entranceRoomId }
          : null,
    actionId: action?.id ?? null,
  };
}

/** Where a stored reference lives, for explaining why something cannot be deleted. */
export function describePath(path: string, definition: DungeonDefinition) {
  const at = /^rooms\[(\d+)\]\.actions(?:\.|\[)(\d+)/.exec(path);
  const via = /^connections\[(\d+)\]/.exec(path);
  const inEvent = /^events\[(\d+)\]/.exec(path);
  const inPool = /^eventPools\[(\d+)\]/.exec(path);
  if (at) {
    const room = definition.rooms[Number(at[1])];
    const action = room?.actions[Number(at[2])];
    return `${roomLabel(room)}: ${action ? activityOf(action).title : 'activity'} (activity ${Number(at[2]) + 1})`;
  }
  if (inEvent) return `Event “${definition.events?.[Number(inEvent[1])]?.title ?? 'Untitled'}”`;
  if (inPool)
    return `Random pool “${definition.eventPools?.[Number(inPool[1])]?.name ?? 'Unnamed'}”`;
  if (via) {
    const c = definition.connections[Number(via[1])];
    return c
      ? `The path ${roomNameOf(definition, c.from)} → ${roomNameOf(definition, c.to)}`
      : 'A path';
  }
  return 'Another part of the dungeon';
}

// ── paths and notes ─────────────────────────────────────────────────────────

/** How a path reads to an author; derived from the stored `requires` and `kind`. */
export function pathState(connection: { kind?: string; requires?: unknown }) {
  if (!connection.requires) return 'open' as const;
  return connection.kind === 'secret' ? ('hidden' as const) : ('locked' as const);
}
export const PATH_STATE_LABEL = {
  open: 'Open path',
  locked: 'Locked path',
  hidden: 'Hidden path',
} as const;

export function newFlagKey(definition: DungeonDefinition) {
  for (;;) {
    const key = `f_${crypto.randomUUID().replaceAll('-', '')}`;
    if (!definition.flags.some((f) => f.key === key)) return key;
  }
}
