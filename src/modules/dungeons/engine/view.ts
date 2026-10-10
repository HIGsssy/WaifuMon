/**
 * The presenter-neutral read model of a run: numbers, keys and labels, no
 * embeds and no prose beyond what the author wrote. Pure, and derived from
 * the same state and content the engine steps — so what a screen offers is
 * exactly what the next input will be accepted for.
 */
import type { CombatEnemyDefinition } from '../../combat/enemyDefinitions';
import { isCombatAction, roomOf, type DungeonActionType, type DungeonConnection } from '../content/dungeonDefinition';
import { selectWaveEnemy } from './combat';
import { dungeonRngSource } from './seeds';
import { canExtract, connectionStates, currentAction } from './step';
import type {
  DungeonEngineContext,
  DungeonRecentEntry,
  DungeonRngSource,
  DungeonRunEnd,
  DungeonRunState,
  DungeonRunStatus,
} from './types';

export interface DungeonActionView {
  id: string;
  type: DungeonActionType;
  /** The author's label; empty when they wrote none. */
  label: string;
  optional: boolean;
  /** For a fight: the wave about to be fought. */
  wave: { index: number; count: number; enemy: CombatEnemyDefinition } | null;
  /** For a rest: the share of max HP it restores. */
  healBasisPoints: number | null;
}

export interface DungeonConnectionView {
  id: string;
  label: string;
  kind: DungeonConnection['kind'];
  toRoomId: string;
  toRoomName: string;
  /** Whether the destination has been finished already (a way back, not a way on). */
  toRoomCompleted: boolean;
  open: boolean;
  lockedText: string;
}

export interface DungeonRunCoreView {
  status: DungeonRunStatus;
  step: number;
  hp: number;
  maxHp: number;
  room: { id: string; name: string; description: string; kind: 'room' | 'exit'; extraction: boolean; visits: number; completed: boolean };
  /**
   *   action       an action is waiting for the player
   *   connections  the room is done; the player chooses where to go
   *   ended        the run is over
   */
  phase: 'action' | 'connections' | 'ended';
  action: DungeonActionView | null;
  /** Shown connections: every open one, and every locked one that is not `secret`. */
  connections: DungeonConnectionView[];
  canExtract: boolean;
  /** No action, no open connection, no extraction: only abandoning is left. */
  stuck: boolean;
  flags: Record<string, boolean>;
  unbankedCurrency: number;
  roomsCompleted: number;
  roomCount: number;
  /** What the latest step did. */
  recent: DungeonRecentEntry[];
  end: DungeonRunEnd | null;
}

export function describeDungeonRun(
  state: DungeonRunState,
  ctx: DungeonEngineContext,
  rng: DungeonRngSource = dungeonRngSource(state.seed),
): DungeonRunCoreView {
  const room = roomOf(ctx.definition, state.cursor.roomId);
  if (!room) throw new RangeError(`the run is in room "${state.cursor.roomId}", which the dungeon lacks`);
  const rs = state.rooms[room.id];
  const active = state.status === 'active';
  const at = active ? currentAction(state, ctx.definition) : null;

  let action: DungeonActionView | null = null;
  if (at) {
    const { action: a } = at;
    const wave = isCombatAction(a) ? a.waves[state.cursor.waveIndex] : undefined;
    action = {
      id: a.id,
      type: a.type,
      label: a.label,
      // A fight already begun cannot be declined.
      optional: a.optional && rs?.actions[a.id]?.status !== 'in_progress',
      wave:
        isCombatAction(a) && wave
          ? {
              index: state.cursor.waveIndex,
              count: a.waves.length,
              enemy: selectWaveEnemy(
                wave,
                { roomId: room.id, actionId: a.id, waveIndex: state.cursor.waveIndex },
                ctx.dependencies,
                rng,
              ),
            }
          : null,
      healBasisPoints: a.type === 'rest' ? a.healBasisPoints : null,
    };
  }

  const connections: DungeonConnectionView[] =
    active && !at
      ? connectionStates(state, ctx)
          .filter(({ connection, open }) => open || connection.kind !== 'secret')
          .map(({ connection, open }) => ({
            id: connection.id,
            label: connection.label,
            kind: connection.kind,
            toRoomId: connection.to,
            toRoomName: roomOf(ctx.definition, connection.to)?.name || connection.to,
            toRoomCompleted: state.rooms[connection.to]?.completed === true,
            open,
            lockedText: connection.lockedText,
          }))
      : [];
  const extractable = canExtract(state, ctx.definition);

  return {
    status: state.status,
    step: state.step,
    hp: state.hp,
    maxHp: ctx.fighter.maxHp,
    room: {
      id: room.id,
      name: room.name,
      description: room.description,
      kind: room.kind,
      extraction: room.extraction,
      visits: rs?.visits ?? 0,
      completed: rs?.completed === true,
    },
    phase: !active ? 'ended' : at ? 'action' : 'connections',
    action,
    connections,
    canExtract: extractable,
    stuck: active && !at && !extractable && !connections.some((c) => c.open),
    flags: { ...state.flags },
    unbankedCurrency: state.unbankedCurrency,
    roomsCompleted: Object.values(state.rooms).filter((r) => r.completed).length,
    roomCount: ctx.definition.rooms.length,
    recent: state.recent,
    end: state.end,
  };
}
