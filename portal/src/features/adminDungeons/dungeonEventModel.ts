/**
 * Edits to a dungeon's events and random pools, as pure functions over the
 * draft. Every edit changes the one member it is about and spreads the rest,
 * so ids, references and anything this editor does not show survive untouched.
 *
 * New things start valid: an event is created with one choice every player can
 * pick, a pool with an event and a Nothing entry. A dungeon whose last event
 * (or pool) is deleted loses the list itself, so it reads exactly like a
 * dungeon that never had one.
 */
import type {
  DungeonAction,
  DungeonCondition,
  DungeonDefinition,
  DungeonEvent,
  DungeonEventChoice,
  DungeonEventOutcome,
  DungeonEventPool,
  DungeonEventPoolEntry,
  DungeonEventSource,
  DungeonIssue,
  DungeonRoom,
} from '@/api/adminDungeons';

/** Mirrors the server's `DUNGEON_EVENT_LIMITS` and text bounds; the server stays authoritative. */
export const EVENT_LIMITS = {
  events: 100,
  pools: 50,
  poolEntries: 20,
  choices: 5,
  effects: 6,
  itemRequirements: 2,
  itemQuantity: 99,
  weight: 1_000_000,
  title: 80,
  text: 1500,
  label: 60,
  description: 200,
  unavailableText: 120,
  outcomeText: 800,
  poolName: 80,
  nothingText: 200,
} as const;
/** What a skill check's Buddy-strength influence is when none is stored: ±15 points. */
export const DEFAULT_SP_INFLUENCE_BASIS_POINTS = 1500;
export const MAX_SP_INFLUENCE_BASIS_POINTS = 5000;

export type EventBranch = 'outcome' | 'success' | 'failure';
export const BRANCH_LABEL: Record<EventBranch, string> = {
  outcome: 'What happens',
  success: 'On success',
  failure: 'On failure',
};

export const eventsOf = (definition: DungeonDefinition) => definition.events ?? [];
export const poolsOf = (definition: DungeonDefinition) => definition.eventPools ?? [];
export const eventById = (definition: DungeonDefinition, id: string) =>
  eventsOf(definition).find((e) => e.id === id);
export const poolById = (definition: DungeonDefinition, id: string) =>
  poolsOf(definition).find((p) => p.id === id);

type IdPrefix = 'ev' | 'ep' | 'ch' | 'pe' | 'a';
/** A fresh id: lower-case, no colon, short enough for a Discord button. */
export function newEventModelId(
  prefix: IdPrefix,
  taken: Iterable<string>,
  uuid = () => crypto.randomUUID(),
): string {
  const used = new Set(taken);
  for (;;) {
    const id = `${prefix}_${uuid().replaceAll('-', '')}`;
    if (!used.has(id)) return id;
  }
}

function withEvents(definition: DungeonDefinition, events: DungeonEvent[]): DungeonDefinition {
  if (events.length > 0) return { ...definition, events };
  const { events: _none, ...rest } = definition;
  return rest;
}
function withPools(definition: DungeonDefinition, pools: DungeonEventPool[]): DungeonDefinition {
  if (pools.length > 0) return { ...definition, eventPools: pools };
  const { eventPools: _none, ...rest } = definition;
  return rest;
}

// ── starting points ─────────────────────────────────────────────────────────

export type EventPresetId = 'blank' | 'locked_door' | 'risky_shortcut' | 'shrine';
type Draft = Omit<DungeonEventChoice, 'id'>;
const CHECK = (percent: number) => ({
  type: 'sp' as const,
  baseChanceBasisPoints: percent * 100,
  maxSpModifierBasisPoints: DEFAULT_SP_INFLUENCE_BASIS_POINTS,
});
/** Each one is valid as written: no items, no remembered things, one choice anyone can pick. */
export const EVENT_PRESETS: ReadonlyArray<{
  id: EventPresetId;
  label: string;
  hint: string;
  title: string;
  text: string;
  choices: Draft[];
}> = [
  {
    id: 'blank',
    label: 'Blank',
    hint: 'A story and one “Continue” button.',
    title: 'New event',
    text: 'Describe what the player finds here.',
    choices: [{ label: 'Continue', outcome: { text: '', effects: [] } }],
  },
  {
    id: 'locked_door',
    label: 'Locked door',
    hint: 'Force it with a skill check, or leave it for later.',
    title: 'A Locked Door',
    text: 'A heavy door blocks the way. The lock is old, but it holds.',
    choices: [
      {
        label: 'Force it',
        check: CHECK(50),
        success: { text: 'The lock gives way.', tone: 'good', effects: [] },
        failure: {
          text: 'The door holds, and your shoulder pays for it.',
          tone: 'bad',
          effects: [{ type: 'damage', basisPoints: 1500 }],
        },
      },
      {
        label: 'Leave it for now',
        outcome: { text: 'You step back from the door.', effects: [], then: { type: 'retreat' } },
      },
    ],
  },
  {
    id: 'risky_shortcut',
    label: 'Risky shortcut',
    hint: 'A gamble that can hurt, or a safe way round.',
    title: 'A Risky Shortcut',
    text: 'A narrow gap cuts straight through. It does not look stable.',
    choices: [
      {
        label: 'Squeeze through',
        check: CHECK(60),
        success: { text: 'You slip through without a scratch.', tone: 'good', effects: [] },
        failure: {
          text: 'The gap shifts and catches you on the way through.',
          tone: 'bad',
          effects: [{ type: 'damage', basisPoints: 2000 }],
        },
      },
      { label: 'Take the long way', outcome: { text: 'Slow, but safe.', effects: [] } },
    ],
  },
  {
    id: 'shrine',
    label: 'Shrine',
    hint: 'A place to recover some health.',
    title: 'A Quiet Shrine',
    text: 'A small shrine glows faintly in the dark.',
    choices: [
      {
        label: 'Rest at the shrine',
        outcome: {
          text: 'Warmth spreads through you.',
          tone: 'good',
          effects: [{ type: 'heal', basisPoints: 2500 }],
        },
      },
      { label: 'Move on', outcome: { text: 'You leave the shrine behind.', effects: [] } },
    ],
  },
];

function uniqueName(base: string, taken: readonly string[], max: number): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = `${base.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.includes(name)) return name;
  }
}

function eventFromPreset(definition: DungeonDefinition, presetId: EventPresetId): DungeonEvent {
  const preset = EVENT_PRESETS.find((p) => p.id === presetId)!;
  const ids: string[] = [];
  return {
    id: newEventModelId(
      'ev',
      eventsOf(definition).map((e) => e.id),
    ),
    title: uniqueName(
      preset.title,
      eventsOf(definition).map((e) => e.title),
      EVENT_LIMITS.title,
    ),
    text: preset.text,
    choices: preset.choices.map((choice) => {
      const id = newEventModelId('ch', ids);
      ids.push(id);
      return { id, ...structuredClone(choice) };
    }),
  };
}

export function createEvent(definition: DungeonDefinition, preset: EventPresetId = 'blank') {
  const event = eventFromPreset(definition, preset);
  return { id: event.id, definition: withEvents(definition, [...eventsOf(definition), event]) };
}

/** A new pool holds one event and a Nothing entry. With no event to hold, one is created for it. */
export function createPool(definition: DungeonDefinition) {
  let next = definition;
  let eventId = eventsOf(definition)[0]?.id;
  if (!eventId) {
    const made = createEvent(definition);
    next = made.definition;
    eventId = made.id;
  }
  const first = newEventModelId('pe', []);
  const pool: DungeonEventPool = {
    id: newEventModelId(
      'ep',
      poolsOf(next).map((p) => p.id),
    ),
    name: uniqueName(
      'Random events',
      poolsOf(next).map((p) => p.name),
      EVENT_LIMITS.poolName,
    ),
    entries: [
      { id: first, weight: 1, eventId, oncePerRun: true },
      { id: newEventModelId('pe', [first]), weight: 1, nothing: true },
    ],
  };
  return { id: pool.id, definition: withPools(next, [...poolsOf(next), pool]) };
}

/** A copy under a new id, placed after the original. Choice and reward ids are local to it and kept. */
export function duplicateEvent(definition: DungeonDefinition, id: string) {
  const events = eventsOf(definition);
  const index = events.findIndex((e) => e.id === id);
  if (index < 0) return { id: null, definition };
  const copy: DungeonEvent = {
    ...structuredClone(events[index]!),
    id: newEventModelId(
      'ev',
      events.map((e) => e.id),
    ),
    title: uniqueName(
      `${events[index]!.title.slice(0, EVENT_LIMITS.title - 7)} (copy)`,
      events.map((e) => e.title),
      EVENT_LIMITS.title,
    ),
  };
  return {
    id: copy.id,
    definition: withEvents(definition, [
      ...events.slice(0, index + 1),
      copy,
      ...events.slice(index + 1),
    ]),
  };
}
export function duplicatePool(definition: DungeonDefinition, id: string) {
  const pools = poolsOf(definition);
  const index = pools.findIndex((p) => p.id === id);
  if (index < 0) return { id: null, definition };
  const copy: DungeonEventPool = {
    ...structuredClone(pools[index]!),
    id: newEventModelId(
      'ep',
      pools.map((p) => p.id),
    ),
    name: uniqueName(
      `${pools[index]!.name.slice(0, EVENT_LIMITS.poolName - 7)} (copy)`,
      pools.map((p) => p.name),
      EVENT_LIMITS.poolName,
    ),
  };
  return {
    id: copy.id,
    definition: withPools(definition, [
      ...pools.slice(0, index + 1),
      copy,
      ...pools.slice(index + 1),
    ]),
  };
}

export function updateEvent(
  definition: DungeonDefinition,
  id: string,
  change: (event: DungeonEvent) => DungeonEvent,
): DungeonDefinition {
  return withEvents(
    definition,
    eventsOf(definition).map((e) => (e.id === id ? change(e) : e)),
  );
}
export function updatePool(
  definition: DungeonDefinition,
  id: string,
  change: (pool: DungeonEventPool) => DungeonEventPool,
): DungeonDefinition {
  return withPools(
    definition,
    poolsOf(definition).map((p) => (p.id === id ? change(p) : p)),
  );
}

// ── where used ──────────────────────────────────────────────────────────────

export interface EventUse {
  kind: 'room' | 'pool';
  /** A room id or a pool id. */
  id: string;
  name: string;
  /** For a room: the activity that presents it. */
  actionId?: string;
}
const roomName = (room: DungeonRoom) => room.name || 'Unnamed room';
const isEventAction = (action: DungeonAction) => action.type === 'event';
export const eventActionsOf = (room: DungeonRoom) => room.actions.filter(isEventAction);

function roomUses(
  definition: DungeonDefinition,
  matches: (source: DungeonEventSource) => boolean,
): EventUse[] {
  return definition.rooms.flatMap((room) =>
    eventActionsOf(room)
      .filter((action) => action.source && matches(action.source))
      .map((action) => ({
        kind: 'room' as const,
        id: room.id,
        name: roomName(room),
        actionId: action.id,
      })),
  );
}
/** Every room that presents this event directly and every pool that lists it. */
export function eventUsage(definition: DungeonDefinition, eventId: string): EventUse[] {
  return [
    ...roomUses(definition, (s) => s.kind === 'event' && s.eventId === eventId),
    ...poolsOf(definition)
      .filter((pool) => pool.entries.some((e) => 'eventId' in e && e.eventId === eventId))
      .map((pool) => ({ kind: 'pool' as const, id: pool.id, name: pool.name })),
  ];
}
export function poolUsage(definition: DungeonDefinition, poolId: string): EventUse[] {
  return roomUses(definition, (s) => s.kind === 'pool' && s.poolId === poolId);
}
export function usageText(uses: EventUse[]): string {
  if (uses.length === 0) return 'Not used yet';
  const names = uses.map((use) => (use.kind === 'pool' ? `${use.name} (random pool)` : use.name));
  return `Used in ${[...new Set(names)].join(', ')}`;
}

/** Removes an event nothing refers to. One that is still used is left exactly as it is. */
export function deleteEvent(definition: DungeonDefinition, id: string): DungeonDefinition {
  if (eventUsage(definition, id).length > 0) return definition;
  return withEvents(
    definition,
    eventsOf(definition).filter((e) => e.id !== id),
  );
}
export function deletePool(definition: DungeonDefinition, id: string): DungeonDefinition {
  if (poolUsage(definition, id).length > 0) return definition;
  return withPools(
    definition,
    poolsOf(definition).filter((p) => p.id !== id),
  );
}

// ── a room's event ──────────────────────────────────────────────────────────

export function createEventAction(
  actions: DungeonAction[],
  source: DungeonEventSource,
): DungeonAction {
  return {
    id: newEventModelId(
      'a',
      actions.map((a) => a.id),
    ),
    type: 'event',
    label: '',
    optional: false,
    outcomes: {},
    source,
  };
}

const sameSource = (a: DungeonEventSource | undefined, b: DungeonEventSource) =>
  a?.kind === b.kind &&
  (a.kind === 'event'
    ? a.eventId === (b as { eventId: string }).eventId
    : a.poolId === (b as { poolId: string }).poolId);

/**
 * Gives a room its one event. A room with no event activity gains one, before
 * a trailing "leave" so the event still happens first; a room that has one
 * keeps the activity — its id, rule and flow — and only what it presents
 * changes. `null` removes it. A room with several is left to its activity list.
 */
export function setRoomEvent(
  definition: DungeonDefinition,
  roomId: string,
  source: DungeonEventSource | null,
): { definition: DungeonDefinition; actionId: string | null } {
  const room = definition.rooms.find((r) => r.id === roomId);
  if (!room) return { definition, actionId: null };
  const existing = eventActionsOf(room);
  if (existing.length > 1) return { definition, actionId: null };
  const current = existing[0];
  let actions: DungeonAction[];
  let actionId: string | null = current?.id ?? null;
  if (source === null) {
    if (!current) return { definition, actionId: null };
    actions = room.actions.filter((a) => a.id !== current.id);
    actionId = null;
  } else if (current) {
    if (sameSource(current.source, source)) return { definition, actionId };
    actions = room.actions.map((a) => (a.id === current.id ? { ...a, source } : a));
  } else {
    const action = createEventAction(room.actions, source);
    actionId = action.id;
    const last = room.actions[room.actions.length - 1];
    actions =
      last?.type === 'leave'
        ? [...room.actions.slice(0, -1), action, last]
        : [...room.actions, action];
  }
  return {
    definition: {
      ...definition,
      rooms: definition.rooms.map((r) => (r.id === roomId ? { ...r, actions } : r)),
    },
    actionId,
  };
}

// ── choices and outcomes ────────────────────────────────────────────────────

export const choiceBranches = (choice: DungeonEventChoice): EventBranch[] =>
  choice.check ? ['success', 'failure'] : ['outcome'];
export const isAlwaysAvailable = (choice: DungeonEventChoice) =>
  !choice.requires && !choice.items?.length;
export const consumesItems = (choice: DungeonEventChoice) =>
  (choice.items ?? []).some((item) => item.consume);
export const turnsBack = (outcome: DungeonEventOutcome | undefined) =>
  outcome?.then?.type === 'retreat';

export function newChoice(event: DungeonEvent): DungeonEventChoice {
  return {
    id: newEventModelId(
      'ch',
      event.choices.map((c) => c.id),
    ),
    label: 'New choice',
    outcome: { text: '', effects: [] },
  };
}

/**
 * Switches a choice between one certain result and a skill check. The result
 * already written is kept: it becomes the success, and a success becomes the
 * one result. Only a failure has nowhere to go when the check is removed.
 */
export function setChoiceCheck(choice: DungeonEventChoice, checked: boolean): DungeonEventChoice {
  if (checked === Boolean(choice.check)) return choice;
  if (checked) {
    const { outcome, ...rest } = choice;
    return {
      ...rest,
      check: CHECK(50),
      success: outcome ?? { text: '', effects: [] },
      failure: { text: '', effects: [] },
    };
  }
  const { check: _check, success, failure: _failure, ...rest } = choice;
  return { ...rest, outcome: success ?? { text: '', effects: [] } };
}
/** Whether removing a choice's check would throw away something its author wrote. */
export function failureHasContent(choice: DungeonEventChoice): boolean {
  const failure = choice.failure;
  return Boolean(
    failure &&
    (failure.text || failure.effects?.length || failure.rewards || failure.then || failure.tone),
  );
}

export function patchOutcome(
  choice: DungeonEventChoice,
  branch: EventBranch,
  change: (outcome: DungeonEventOutcome) => DungeonEventOutcome,
): DungeonEventChoice {
  return { ...choice, [branch]: change(choice[branch] ?? { text: '', effects: [] }) };
}

/** Sets a member, or removes it when the value is `undefined`, leaving every other member alone. */
export function withMember<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): T {
  if (value !== undefined) return { ...target, [key]: value };
  const next = { ...target };
  delete next[key];
  return next;
}

// ── pool entries ────────────────────────────────────────────────────────────

export function newPoolEntry(
  pool: DungeonEventPool,
  eventId: string | null,
): DungeonEventPoolEntry {
  const id = newEventModelId(
    'pe',
    pool.entries.map((e) => e.id),
  );
  return eventId === null
    ? { id, weight: 1, nothing: true }
    : { id, weight: 1, eventId, oncePerRun: true };
}
/** The same entry — id, share and rule — presenting something else. */
export function retargetPoolEntry(
  entry: DungeonEventPoolEntry,
  eventId: string | null,
): DungeonEventPoolEntry {
  const kept: { id: string; weight: number; when?: DungeonCondition } = {
    id: entry.id,
    weight: entry.weight,
    ...(entry.when ? { when: entry.when } : {}),
  };
  if (eventId === null) return 'nothing' in entry ? entry : { ...kept, nothing: true };
  return 'eventId' in entry ? { ...entry, eventId } : { ...kept, eventId, oncePerRun: true };
}

// ── rules ───────────────────────────────────────────────────────────────────

/** Every run flag and room a rule reads, for offering only those in a situation. */
export function conditionReads(
  condition: DungeonCondition | undefined,
  into: { flags: Set<string>; rooms: Set<string> },
) {
  if (!condition) return;
  if (condition.type === 'flag') into.flags.add(condition.flag);
  else if (condition.type === 'room_completed') into.rooms.add(condition.roomId);
  else if (condition.type === 'not') conditionReads(condition.condition, into);
  else condition.conditions.forEach((c) => conditionReads(c, into));
}

// ── numbers for people ──────────────────────────────────────────────────────

export const percentOfBasisPoints = (basisPoints: number) =>
  `${Number((basisPoints / 100).toFixed(2))}%`;
/** `about 1 in 4`; nothing for a certainty or an impossibility. */
export function oneIn(probability: number): string {
  if (!(probability > 0) || probability >= 1) return '';
  const n = 1 / probability;
  return `about 1 in ${n < 10 ? Number(n.toFixed(1)) : Math.round(n)}`;
}
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

// ── not finished yet ────────────────────────────────────────────────────────

/**
 * Event and pool fields the server cannot store while they are blank. The
 * editor raises these itself, under "Finish before saving", so an author is
 * told which box to fill instead of meeting a refused save.
 */
export function incompleteEventIssues(definition: DungeonDefinition, code: string): DungeonIssue[] {
  const issues: DungeonIssue[] = [];
  const add = (path: string, message: string) =>
    issues.push({ code, severity: 'error', path, message });
  eventsOf(definition).forEach((event, e) => {
    if (!event.title.trim()) add(`events[${e}].title`, 'event has no title');
    if (!event.text.trim()) add(`events[${e}].text`, 'event has no story text');
    event.choices.forEach((choice, c) => {
      if (!choice.label.trim())
        add(`events[${e}].choices[${c}].label`, 'choice has no button text');
      (choice.items ?? []).forEach((item, i) => {
        if (!item.item) add(`events[${e}].choices[${c}].items[${i}].item`, 'no item chosen');
      });
    });
  });
  poolsOf(definition).forEach((pool, p) => {
    if (!pool.name.trim()) add(`eventPools[${p}].name`, 'pool has no name');
    pool.entries.forEach((entry, i) => {
      if ('eventId' in entry && !entry.eventId)
        add(`eventPools[${p}].entries[${i}].eventId`, 'no event chosen');
    });
  });
  definition.rooms.forEach((room, r) =>
    room.actions.forEach((action, a) => {
      if (!isEventAction(action)) return;
      const source = action.source;
      if (!source || (source.kind === 'event' ? !source.eventId : !source.poolId))
        add(`rooms[${r}].actions[${a}].source`, 'no event chosen');
    }),
  );
  return issues;
}
