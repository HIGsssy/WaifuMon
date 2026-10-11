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
  ShieldAlert,
  Swords,
  type LucideIcon,
} from 'lucide-react';
import type {
  CombatWave,
  DungeonAction,
  DungeonCondition,
  DungeonDefinition,
  DungeonIssue,
  DungeonReferenceData,
  DungeonRoom,
} from '@/api/adminDungeons';
import type { ActionType } from './dungeonActionModel';
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
export const activityOf = (action: DungeonAction) =>
  ACTIVITIES[action.type as ActionType] ?? { title: action.type, hint: '', icon: Bookmark };

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

/** One sentence for a collapsed activity card. */
export function activitySummary(
  action: DungeonAction,
  definition: DungeonDefinition,
  reference: DungeonReferenceData | undefined,
): string {
  switch (action.type) {
    case 'combat':
    case 'boss':
      return (action.waves ?? []).map((w) => waveText(w, reference)).join(', then ');
    case 'rest':
      return `Restore ${(action.healBasisPoints ?? 3000) / 100}% HP`;
    case 'reward': {
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

/** Fights whose enemy has not been chosen. The server refuses to store them. */
export function incompleteIssues(definition: DungeonDefinition): DungeonIssue[] {
  const issues: DungeonIssue[] = [];
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
  target: MapSelection;
  /** The activity inside the target room, when the issue belongs to one. */
  actionId: string | null;
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
  const text = message.replace(/"([^"]*)"/g, (whole, id: string) => names.get(id) ?? whole);
  return sentence(
    text.replace(/\baction (?=fight|boss fight|treasure|rest|checkpoint|remember|leave)/g, ''),
  );
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
  const unchosenEnemy =
    issue.code === INCOMPLETE_CODE || (issue.code === 'schema' && wave !== null && !!action);

  let title: string;
  let help = '';
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
    case 'reward_empty':
      title = `The treasure in ${R} gives nothing.`;
      help = 'Choose a reward table or set a currency amount.';
      break;
    case 'reward_currency_unset':
      title = `The treasure in ${R} pays currency, but this dungeon has none set.`;
      help = 'Set the amount to 0, or give the dungeon a progression currency.';
      break;
    case 'reward_table_missing':
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
    case 'flag_never_set':
      title = `A rule checks “${flagNameOf(definition, quoted(issue.message))}”, but nothing ever remembers it.`;
      help = 'Add a “Remember something” activity where it should happen.';
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
  if (at) {
    const room = definition.rooms[Number(at[1])];
    const action = room?.actions[Number(at[2])];
    return `${roomLabel(room)}: ${action ? activityOf(action).title : 'activity'} (activity ${Number(at[2]) + 1})`;
  }
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
