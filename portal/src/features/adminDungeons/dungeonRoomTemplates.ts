/**
 * Room templates: starting recipes written in the existing schema. A template
 * is not stored anywhere — what a room "is" is read back from its content
 * (`roomPresentation`), so imported and hand-edited dungeons get the same
 * badges and nothing stops an author mixing activities afterwards.
 */
import {
  BedDouble,
  Crown,
  DoorOpen,
  Gift,
  ScrollText,
  Shapes,
  SquareDashed,
  Swords,
  type LucideIcon,
} from 'lucide-react';
import type { DungeonDefinition, DungeonLayout, DungeonRoom } from '@/api/adminDungeons';
import { createAction } from './dungeonActionModel';
import { createEvent, createEventAction } from './dungeonEventModel';
import { connectMapRooms, newMapId, positionOf } from './dungeonMapModel';

export type RoomTemplateId = 'combat' | 'boss' | 'treasure' | 'rest' | 'event' | 'exit' | 'empty';
export const ROOM_TEMPLATES: ReadonlyArray<{
  id: RoomTemplateId;
  label: string;
  hint: string;
  icon: LucideIcon;
  roomName: string;
}> = [
  {
    id: 'combat',
    label: 'Combat',
    hint: 'Fight one or more enemies, one wave at a time.',
    icon: Swords,
    roomName: 'Combat',
  },
  { id: 'boss', label: 'Boss', hint: 'A boss fight.', icon: Crown, roomName: 'Boss' },
  {
    id: 'treasure',
    label: 'Treasure',
    hint: 'Hand out a reward.',
    icon: Gift,
    roomName: 'Treasure',
  },
  {
    id: 'rest',
    label: 'Rest',
    hint: "Restore some of the Buddy's HP.",
    icon: BedDouble,
    roomName: 'Rest',
  },
  {
    id: 'event',
    label: 'Event',
    hint: 'A story moment with choices.',
    icon: ScrollText,
    roomName: 'Event',
  },
  {
    id: 'exit',
    label: 'Exit',
    hint: 'Reaching it completes the dungeon.',
    icon: DoorOpen,
    roomName: 'Exit',
  },
  {
    id: 'empty',
    label: 'Empty',
    hint: 'A blank room to fill in yourself.',
    icon: SquareDashed,
    roomName: 'New room',
  },
];

const ROOM_STEP_X = 320;
const ROOM_STEP_Y = 170;

function uniqueRoomName(definition: DungeonDefinition, base: string) {
  const taken = new Set(definition.rooms.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** To the right of the room it follows, moved down past anything already there. */
function placeNear(
  definition: DungeonDefinition,
  layout: DungeonLayout,
  fromRoomId: string | null,
) {
  const taken = definition.rooms.map((r, index) => positionOf(layout, r.id, index));
  const from = definition.rooms.findIndex((r) => r.id === fromRoomId);
  const spot =
    from >= 0
      ? { x: taken[from]!.x + ROOM_STEP_X, y: taken[from]!.y }
      : {
          x: Math.min(0, ...taken.map((p) => p.x)),
          y: taken.length ? Math.max(...taken.map((p) => p.y)) + ROOM_STEP_Y : 0,
        };
  while (taken.some((p) => Math.abs(p.x - spot.x) < 250 && Math.abs(p.y - spot.y) < 140))
    spot.y += ROOM_STEP_Y;
  return spot;
}

/** Why a new path from one room to another should not be created, or null. */
export function connectionProblem(
  definition: DungeonDefinition,
  from: string,
  to: string,
): string | null {
  const source = definition.rooms.find((r) => r.id === from);
  const target = definition.rooms.find((r) => r.id === to);
  if (!source || !target) return 'That room no longer exists.';
  const name = (room: DungeonRoom) => room.name || 'This room';
  if (source.kind === 'exit')
    return `${name(source)} is an exit: the run ends there, so no path can lead out of it.`;
  if (from === to) return `${name(source)} cannot lead back into itself.`;
  if (definition.connections.some((c) => c.from === from && c.to === to))
    return `${name(source)} already leads to ${target.name || 'that room'}.`;
  return null;
}

/**
 * Create a room from a template. With `fromRoomId` it is placed beside that
 * room and connected from it; the designated start room never changes.
 */
export function addTemplateRoom(
  definition: DungeonDefinition,
  layout: DungeonLayout,
  templateId: RoomTemplateId,
  fromRoomId: string | null = null,
) {
  const template = ROOM_TEMPLATES.find((t) => t.id === templateId)!;
  const id = newMapId(
    'r',
    definition.rooms.map((r) => r.id),
  );
  const actionType = (
    { combat: 'combat', boss: 'boss', treasure: 'reward', rest: 'rest' } as const
  )[templateId as 'combat' | 'boss' | 'treasure' | 'rest'];
  // An Event room arrives with a new event of its own: one choice, valid as it stands, ready to rewrite.
  const event = templateId === 'event' ? createEvent(definition) : null;
  const room: DungeonRoom = {
    id,
    name: uniqueRoomName(definition, template.roomName),
    description: '',
    kind: templateId === 'exit' ? 'exit' : 'room',
    extraction: false,
    background: null,
    actions: event
      ? [createEventAction([], { kind: 'event', eventId: event.id })]
      : actionType
        ? [createAction(actionType, [], definition)]
        : [],
  };
  const base = event?.definition ?? definition;
  const withRoom = { ...base, rooms: [...base.rooms, room] };
  const connect = fromRoomId !== null && connectionProblem(withRoom, fromRoomId, id) === null;
  return {
    id,
    definition: connect ? connectMapRooms(withRoom, fromRoomId, id) : withRoom,
    layout: {
      ...layout,
      rooms: { ...layout.rooms, [id]: placeNear(definition, layout, fromRoomId) },
    },
  };
}

export interface RoomPresentation {
  label: string;
  icon: LucideIcon;
}
/** What a room is to a player, judged by what it holds. */
export function roomPresentation(room: DungeonRoom): RoomPresentation {
  const types = new Set(room.actions.map((a) => a.type));
  if (room.kind === 'exit') return { label: 'Exit', icon: DoorOpen };
  if (types.has('boss')) return { label: 'Boss', icon: Crown };
  if (types.has('combat')) return { label: 'Combat', icon: Swords };
  if (types.size === 0) return { label: 'Empty', icon: SquareDashed };
  if (types.size === 1 && types.has('reward')) return { label: 'Treasure', icon: Gift };
  if (types.size === 1 && types.has('rest')) return { label: 'Rest', icon: BedDouble };
  if (types.size === 1 && types.has('event')) return { label: 'Event', icon: ScrollText };
  return { label: 'Custom', icon: Shapes };
}
