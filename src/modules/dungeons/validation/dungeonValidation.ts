/**
 * Dungeon definition validation.
 *
 * Pure: the caller loads whatever lives outside the definition (enemies,
 * reward tables, regions, currencies, artwork) into a `DungeonValidationContext`
 * and this module never reads anything itself. With no context only the
 * definition's own structure is checked, which is what a package needs before
 * it knows where it is going.
 *
 * Every problem is a `DungeonIssue` with a **stable code**, a severity, a
 * path into the definition and a sentence. Codes are an interface: the editor
 * routes on them and tests assert them, so a code is never renamed.
 *
 *   error    the dungeon cannot be published (and a published one could
 *            misbehave): broken references, routing that goes backward or
 *            nowhere, a room the player could never leave;
 *   warning  an unusual design choice worth a second look, never a refusal:
 *            a room nothing leads to, a flag nothing sets, a very long fight.
 *
 * Nothing here asks for branches to be equally likely or for every optional
 * room to be visited. "Reachable" and "has a route out" are judged on the map
 * as drawn, with every lock assumed openable — a *potential* route.
 *
 * ## Stages
 *
 *   1. shape     reserved and unknown action types get their own codes, then
 *                the Zod schema;
 *   2. identity  duplicate ids;
 *   3. map       entrance, connection endpoints, exits and extraction;
 *   4. sequences routing targets, outcomes, flags, conditions, enemy pools;
 *   5. references against the context, when one is given;
 *   6. graph     reachability and routes to an ending.
 */
import type { ZodIssue } from 'zod';
import {
  ACTION_OUTCOMES,
  DECLINED_OUTCOME,
  DUNGEON_ACTION_TYPES,
  DUNGEON_MAX_CONDITION_DEPTH,
  DungeonDefinitionSchema,
  RESERVED_ACTION_TYPES,
  connectionsFrom,
  dungeonDependencies,
  isCombatAction,
  type ActionDestination,
  type DungeonAction,
  type DungeonCondition,
  type DungeonDefinition,
  type DungeonRoom,
} from '../content/dungeonDefinition';
import { conditionDepth, conditionReferences } from '../engine/conditions';
import { defaultDestination, destinationFor, destinationsOf, SUCCESS_OUTCOME } from '../engine/routing';

export const DUNGEON_ISSUE_CODES = [
  'schema',
  'unsupported_action_type',
  'unknown_action_type',
  'duplicate_room_id',
  'duplicate_connection_id',
  'duplicate_action_id',
  'duplicate_flag',
  'entrance_missing',
  'connection_unknown_room',
  'connection_self_loop',
  'exit_has_connections',
  'exit_leave_connection',
  'no_ending',
  'exit_extraction_redundant',
  'unknown_outcome',
  'outcome_unreachable',
  'transition_unknown_action',
  'transition_backward',
  'transition_invalid_connection',
  'transition_locked_connection',
  'retreat_from_entrance',
  'action_unreachable',
  'enemy_missing',
  'enemy_disabled',
  'enemy_pool_duplicate',
  'many_waves',
  'reward_table_missing',
  'reward_table_disabled',
  'reward_empty',
  'reward_currency_unset',
  'flag_undeclared',
  'flag_scope_mismatch',
  'flag_scope_unsupported',
  'flag_player_scope_inert',
  'flag_never_set',
  'flag_unused',
  'condition_unknown_room',
  'condition_too_deep',
  'region_missing',
  'region_disabled',
  'no_regions',
  'currency_missing',
  'currency_disabled',
  'artwork_missing',
  'room_unreachable',
  'room_no_route_to_exit',
  'room_empty',
  'many_connections',
] as const;
export type DungeonIssueCode = (typeof DUNGEON_ISSUE_CODES)[number];

export interface DungeonIssue {
  code: DungeonIssueCode;
  severity: 'error' | 'warning';
  /** Dotted path into the definition, e.g. `rooms[2].actions[0].waves[1].enemy`. */
  path: string;
  message: string;
}

/** A name that exists outside the definition, and whether it is switched on. */
export type DungeonReferenceIndex = ReadonlyMap<string, { enabled: boolean }>;

export interface DungeonValidationContext {
  enemies?: DungeonReferenceIndex | undefined;
  /** `expedition`-kind reward tables. */
  rewardTables?: DungeonReferenceIndex | undefined;
  regions?: DungeonReferenceIndex | undefined;
  currencies?: DungeonReferenceIndex | undefined;
  /** Whether a shipped file exists under `assets/`. Omitted: not checked. */
  shippedArtworkExists?: ((path: string) => boolean) | undefined;
  /** sha256 hashes of the usable managed assets, as `<category>:<hash>`. Omitted: not checked. */
  managedArtwork?: ReadonlySet<string> | undefined;
}

export interface DungeonValidationResult {
  /** The parsed definition, defaults applied; null when the shape itself is wrong. */
  definition: DungeonDefinition | null;
  issues: DungeonIssue[];
}

/** Above these the definition still works; a screen just gets crowded. */
export const WAVES_WARNING_THRESHOLD = 20;
export const CONNECTIONS_WARNING_THRESHOLD = 10;

export function hasErrors(issues: readonly DungeonIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

function zodPath(path: ZodIssue['path']): string {
  return path.reduce<string>((out, part) => (typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${part}` : String(part)), '');
}

/** Reserved and unknown action types, found on the raw document before the schema sees it. */
function actionTypeIssues(raw: unknown): { issues: DungeonIssue[]; paths: Set<string> } {
  const issues: DungeonIssue[] = [];
  const paths = new Set<string>();
  const rooms = (raw as { rooms?: unknown } | null)?.rooms;
  if (!Array.isArray(rooms)) return { issues, paths };
  rooms.forEach((room, r) => {
    const actions = (room as { actions?: unknown } | null)?.actions;
    if (!Array.isArray(actions)) return;
    actions.forEach((action, a) => {
      const type = (action as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || (DUNGEON_ACTION_TYPES as readonly string[]).includes(type)) return;
      const path = `rooms[${r}].actions[${a}]`;
      paths.add(path);
      const phase = (RESERVED_ACTION_TYPES as Record<string, string>)[type];
      issues.push(
        phase
          ? {
              code: 'unsupported_action_type',
              severity: 'error',
              path: `${path}.type`,
              message: `"${type}" actions are not supported yet — they arrive in ${phase}`,
            }
          : {
              code: 'unknown_action_type',
              severity: 'error',
              path: `${path}.type`,
              message: `"${type}" is not an action type (expected one of ${DUNGEON_ACTION_TYPES.join(', ')})`,
            },
      );
    });
  });
  return { issues, paths };
}

export function validateDungeonDefinition(raw: unknown, ctx: DungeonValidationContext = {}): DungeonValidationResult {
  const typed = actionTypeIssues(raw);
  const parsed = DungeonDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = [...typed.issues];
    for (const issue of parsed.error.issues) {
      const path = zodPath(issue.path);
      // The dedicated code already says what is wrong with that action.
      if ([...typed.paths].some((p) => path === p || path.startsWith(`${p}.`))) continue;
      issues.push({ code: 'schema', severity: 'error', path, message: issue.message });
    }
    return { definition: null, issues };
  }
  const definition = parsed.data;
  const issues: DungeonIssue[] = [];
  const add = (code: DungeonIssueCode, severity: DungeonIssue['severity'], path: string, message: string) =>
    issues.push({ code, severity, path, message });

  // ── identity ──────────────────────────────────────────────────────────────
  const duplicates = <T>(list: readonly T[], keyOf: (item: T) => string, report: (index: number, key: string, first: number) => void) => {
    const seen = new Map<string, number>();
    list.forEach((item, i) => {
      const key = keyOf(item);
      const first = seen.get(key);
      if (first !== undefined) report(i, key, first);
      else seen.set(key, i);
    });
  };
  duplicates(definition.rooms, (r) => r.id, (i, key, first) =>
    add('duplicate_room_id', 'error', `rooms[${i}].id`, `room id "${key}" is already used by rooms[${first}]`),
  );
  duplicates(definition.connections, (c) => c.id, (i, key, first) =>
    add('duplicate_connection_id', 'error', `connections[${i}].id`, `connection id "${key}" is already used by connections[${first}]`),
  );
  duplicates(definition.flags, (f) => f.key, (i, key, first) =>
    add('duplicate_flag', 'error', `flags[${i}].key`, `flag "${key}" is already declared by flags[${first}]`),
  );
  definition.rooms.forEach((room, r) =>
    duplicates(room.actions, (a) => a.id, (i, key, first) =>
      add('duplicate_action_id', 'error', `rooms[${r}].actions[${i}].id`, `action id "${key}" is already used by actions[${first}] of this room`),
    ),
  );

  const roomById = new Map(definition.rooms.map((r) => [r.id, r]));
  const connectionById = new Map(definition.connections.map((c) => [c.id, c]));
  const flagByKey = new Map(definition.flags.map((f) => [f.key, f]));

  // ── map ───────────────────────────────────────────────────────────────────
  if (!roomById.has(definition.entranceRoomId)) {
    add('entrance_missing', 'error', 'entranceRoomId', `entrance room "${definition.entranceRoomId}" is not one of the dungeon's rooms`);
  }
  definition.connections.forEach((c, i) => {
    for (const end of ['from', 'to'] as const) {
      if (!roomById.has(c[end])) {
        add('connection_unknown_room', 'error', `connections[${i}].${end}`, `connection "${c.id}" ${end === 'from' ? 'starts at' : 'leads to'} "${c[end]}", which is not a room`);
      }
    }
    if (c.from === c.to) add('connection_self_loop', 'warning', `connections[${i}]`, `connection "${c.id}" leads back into the room it leaves`);
    if (roomById.get(c.from)?.kind === 'exit') {
      add('exit_has_connections', 'error', `connections[${i}].from`, `connection "${c.id}" leaves exit room "${c.from}", where the run has already ended`);
    }
  });
  definition.rooms.forEach((room, r) => {
    if (room.kind === 'exit' && room.extraction) {
      add('exit_extraction_redundant', 'warning', `rooms[${r}].extraction`, `room "${room.id}" is an exit: the run ends there, so extraction is never offered`);
    }
    if (room.kind !== 'exit') {
      const shown = connectionsFrom(definition, room.id).length;
      if (shown > CONNECTIONS_WARNING_THRESHOLD) {
        add('many_connections', 'warning', `rooms[${r}]`, `room "${room.id}" has ${shown} ways out; more than ${CONNECTIONS_WARNING_THRESHOLD} crowds the screen`);
      }
    }
    if (room.actions.length === 0 && room.kind !== 'exit' && room.id !== definition.entranceRoomId && !room.extraction) {
      add('room_empty', 'warning', `rooms[${r}].actions`, `room "${room.id}" has no actions: the player walks straight through it`);
    }
  });

  // ── flags written ─────────────────────────────────────────────────────────
  const flagsSet = new Set<string>();
  const flagsRead = new Set<string>();
  for (const room of definition.rooms) for (const action of room.actions) if (action.type === 'set_flag') flagsSet.add(action.flag);

  const checkCondition = (condition: DungeonCondition | undefined, path: string) => {
    if (!condition) return;
    if (conditionDepth(condition) > DUNGEON_MAX_CONDITION_DEPTH) {
      add('condition_too_deep', 'error', path, `condition nests more than ${DUNGEON_MAX_CONDITION_DEPTH} levels deep`);
    }
    const refs = conditionReferences(condition);
    for (const ref of refs.flags) {
      flagsRead.add(ref.flag);
      const declared = flagByKey.get(ref.flag);
      if (!declared) {
        add('flag_undeclared', 'error', path, `condition reads flag "${ref.flag}", which the dungeon does not declare`);
      } else if (declared.scope !== ref.scope) {
        add('flag_scope_mismatch', 'error', path, `condition reads flag "${ref.flag}" as ${ref.scope}-scoped, but it is declared ${declared.scope}-scoped`);
      } else if (ref.scope === 'player') {
        add('flag_player_scope_inert', 'warning', path, `condition reads player-scoped flag "${ref.flag}"; nothing can set one yet, so it is always false`);
      } else if (!flagsSet.has(ref.flag)) {
        add('flag_never_set', 'warning', path, `condition reads flag "${ref.flag}", which no action ever sets`);
      }
    }
    for (const roomId of refs.rooms) {
      if (!roomById.has(roomId)) add('condition_unknown_room', 'error', path, `condition names room "${roomId}", which is not a room`);
    }
  };

  definition.connections.forEach((c, i) => checkCondition(c.requires, `connections[${i}].requires`));

  // ── sequences ─────────────────────────────────────────────────────────────
  const checkDestination = (
    room: DungeonRoom,
    index: number,
    action: DungeonAction,
    destination: ActionDestination,
    path: string,
  ) => {
    switch (destination.type) {
      case 'action': {
        const target = room.actions.findIndex((a) => a.id === destination.actionId);
        if (target < 0) {
          add('transition_unknown_action', 'error', path, `action "${action.id}" routes to "${destination.actionId}", which is not an action of room "${room.id}"`);
        } else if (target <= index) {
          add('transition_backward', 'error', path, `action "${action.id}" routes ${target === index ? 'to itself' : `backward to "${destination.actionId}"`}; routing inside a room only goes forward`);
        }
        break;
      }
      case 'leave': {
        const connection = connectionById.get(destination.connectionId);
        if (!connection || connection.from !== room.id) {
          add('transition_invalid_connection', 'error', path, `action "${action.id}" leaves through "${destination.connectionId}", which is not a connection out of room "${room.id}"`);
        } else if (room.kind === 'exit') {
          add('exit_leave_connection', 'error', path, `action "${action.id}" leaves exit room "${room.id}" through a connection; the run ends when an exit room completes`);
        } else if (connection.requires) {
          add('transition_locked_connection', 'warning', path, `action "${action.id}" walks the player through locked connection "${connection.id}" without checking its requirement`);
        }
        break;
      }
      case 'retreat':
        if (room.id === definition.entranceRoomId) {
          add('retreat_from_entrance', 'error', path, `action "${action.id}" can turn the player back, but room "${room.id}" is the entrance: there is nowhere to go back to. Route this outcome explicitly`);
        }
        break;
      default:
        break;
    }
  };

  definition.rooms.forEach((room, r) => {
    room.actions.forEach((action, a) => {
      const path = `rooms[${r}].actions[${a}]`;
      checkCondition(action.when, `${path}.when`);

      const known = new Set<string>(ACTION_OUTCOMES[action.type]);
      for (const outcome of Object.keys(action.outcomes)) {
        if (outcome === DECLINED_OUTCOME) {
          if (!action.optional) {
            add('outcome_unreachable', 'warning', `${path}.outcomes.${outcome}`, `action "${action.id}" routes "declined" but is not optional, so it can never be declined`);
          }
        } else if (!known.has(outcome)) {
          add('unknown_outcome', 'error', `${path}.outcomes.${outcome}`, `a ${action.type} action has no "${outcome}" outcome (it reports: ${[...known].join(', ') || 'none'})`);
        }
      }
      if (action.next && SUCCESS_OUTCOME[action.type] == null) {
        add('outcome_unreachable', 'warning', `${path}.next`, `a ${action.type} action is itself a destination; its "next" is never followed`);
      }
      for (const { via, outcome, destination } of destinationsOf(action)) {
        checkDestination(room, a, action, destination, via === 'outcomes' ? `${path}.outcomes.${outcome}` : via === 'next' ? `${path}.next` : path);
      }
      // A gate that is not routed for `blocked` turns the player back by default.
      if (action.type === 'gate' && !action.outcomes.blocked) {
        checkDestination(room, a, action, defaultDestination(action, 'blocked'), path);
      }

      if (isCombatAction(action)) {
        if (action.waves.length > WAVES_WARNING_THRESHOLD) {
          add('many_waves', 'warning', `${path}.waves`, `action "${action.id}" has ${action.waves.length} waves; that is a very long fight`);
        }
        action.waves.forEach((wave, w) => {
          const wavePath = `${path}.waves[${w}].enemy`;
          const keys = 'key' in wave.enemy ? [wave.enemy.key] : wave.enemy.pool.map((e) => e.key);
          if ('pool' in wave.enemy) {
            const seen = new Set<string>();
            for (const key of keys) {
              if (seen.has(key)) add('enemy_pool_duplicate', 'error', `${wavePath}.pool`, `enemy "${key}" is in this pool more than once; give it one entry with the combined weight`);
              seen.add(key);
            }
          }
          if (ctx.enemies) {
            for (const key of new Set(keys)) {
              const enemy = ctx.enemies.get(key);
              if (!enemy) add('enemy_missing', 'error', wavePath, `enemy "${key}" is not in the Enemy Catalogue`);
              else if (!enemy.enabled) add('enemy_disabled', 'warning', wavePath, `enemy "${key}" is disabled in the Enemy Catalogue`);
            }
          }
        });
      }

      if (action.type === 'gate') checkCondition(action.requires, `${path}.requires`);

      if (action.type === 'set_flag') {
        const declared = flagByKey.get(action.flag);
        if (!declared) {
          add('flag_undeclared', 'error', `${path}.flag`, `action "${action.id}" sets flag "${action.flag}", which the dungeon does not declare`);
        } else if (declared.scope !== action.scope) {
          add('flag_scope_mismatch', 'error', `${path}.scope`, `action "${action.id}" sets flag "${action.flag}" as ${action.scope}-scoped, but it is declared ${declared.scope}-scoped`);
        } else if (action.scope === 'player') {
          add('flag_scope_unsupported', 'error', `${path}.scope`, `action "${action.id}" sets a player-scoped flag; persistent flags cannot be written yet`);
        }
      }

      if (action.type === 'reward') {
        const { rewardTable, equipmentRewardTable, currency } = action.reward;
        if (!rewardTable && !equipmentRewardTable && currency.max <= 0) {
          add('reward_empty', 'warning', `${path}.reward`, `action "${action.id}" pays nothing: it names no reward table and no currency`);
        }
        if (currency.max > 0 && !definition.settings.progressionCurrency) {
          add('reward_currency_unset', 'warning', `${path}.reward.currency`, `action "${action.id}" pays currency, but the dungeon names no progression currency to bank it as`);
        }
        if (ctx.rewardTables) {
          for (const [field, id] of [['rewardTable', rewardTable], ['equipmentRewardTable', equipmentRewardTable]] as const) {
            if (!id) continue;
            const table = ctx.rewardTables.get(id);
            if (!table) add('reward_table_missing', 'error', `${path}.reward.${field}`, `"${id}" is not an expedition reward table`);
            else if (!table.enabled) add('reward_table_disabled', 'warning', `${path}.reward.${field}`, `reward table "${id}" is disabled, so it pays nothing`);
          }
        }
      }
    });

    // Which actions of this room can the sequence ever stand on?
    const reached = new Set<number>();
    const queue = room.actions.length ? [0] : [];
    while (queue.length) {
      const index = queue.pop()!;
      if (reached.has(index) || index >= room.actions.length) continue;
      reached.add(index);
      const action = room.actions[index]!;
      const onward = (destination: ActionDestination) => {
        if (destination.type === 'next') queue.push(index + 1);
        else if (destination.type === 'action') {
          const target = room.actions.findIndex((x) => x.id === destination.actionId);
          if (target > index) queue.push(target);
        }
      };
      if (action.when) queue.push(index + 1);
      if (action.optional) onward(destinationFor(action, DECLINED_OUTCOME));
      for (const outcome of ACTION_OUTCOMES[action.type]) onward(destinationFor(action, outcome));
      if (action.type === 'leave') onward(destinationFor(action, 'done'));
    }
    room.actions.forEach((action, a) => {
      if (!reached.has(a)) {
        add('action_unreachable', 'warning', `rooms[${r}].actions[${a}]`, `action "${action.id}" can never run: nothing before it leads to it`);
      }
    });
  });

  definition.flags.forEach((flag, i) => {
    if (!flagsSet.has(flag.key) && !flagsRead.has(flag.key)) {
      add('flag_unused', 'warning', `flags[${i}]`, `flag "${flag.key}" is declared but never set or read`);
    }
  });

  // ── references ────────────────────────────────────────────────────────────
  if (definition.availableRegions.length === 0) {
    add('no_regions', 'warning', 'availableRegions', 'the dungeon is available in no region, so no run can be started');
  }
  if (ctx.regions) {
    definition.availableRegions.forEach((regionId, i) => {
      const region = ctx.regions!.get(regionId);
      if (!region) add('region_missing', 'error', `availableRegions[${i}]`, `"${regionId}" is not a region`);
      else if (!region.enabled) add('region_disabled', 'warning', `availableRegions[${i}]`, `region "${regionId}" is disabled`);
    });
  }
  const currencyKey = definition.settings.progressionCurrency;
  if (currencyKey && ctx.currencies) {
    const currency = ctx.currencies.get(currencyKey);
    if (!currency) add('currency_missing', 'error', 'settings.progressionCurrency', `"${currencyKey}" is not a progression currency`);
    else if (!currency.enabled) add('currency_disabled', 'warning', 'settings.progressionCurrency', `progression currency "${currencyKey}" is disabled; nothing can be banked`);
  }
  for (const ref of dungeonDependencies(definition).artwork) {
    if (ref.kind === 'shipped' && ctx.shippedArtworkExists && !ctx.shippedArtworkExists(ref.path)) {
      add('artwork_missing', 'warning', 'artwork', `shipped artwork "${ref.path}" was not found under assets/`);
    }
    if (ref.kind === 'managed' && ctx.managedArtwork && !ctx.managedArtwork.has(`${ref.category}:${ref.contentHash}`)) {
      add('artwork_missing', 'warning', 'artwork', `managed ${ref.category} artwork ${ref.contentHash.slice(0, 12)}… (${ref.name ?? 'unnamed'}) is not in this environment`);
    }
  }

  // ── graph ─────────────────────────────────────────────────────────────────
  // Every way the player can get from one room to another, locks ignored.
  const forward = new Map<string, Set<string>>(definition.rooms.map((r) => [r.id, new Set<string>()]));
  for (const c of definition.connections) {
    if (roomById.has(c.from) && roomById.has(c.to) && roomById.get(c.from)!.kind !== 'exit') forward.get(c.from)!.add(c.to);
  }
  // A retreat walks a connection backward.
  const retreats = (room: DungeonRoom) =>
    room.actions.some((action) =>
      [...ACTION_OUTCOMES[action.type], DECLINED_OUTCOME].some((outcome) => destinationFor(action, outcome).type === 'retreat'),
    );
  for (const room of definition.rooms) {
    if (!retreats(room)) continue;
    for (const c of definition.connections) if (c.to === room.id && roomById.has(c.from)) forward.get(room.id)!.add(c.from);
  }
  const walk = (starts: Iterable<string>, edges: Map<string, Set<string>>): Set<string> => {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length) {
      const idNow = stack.pop()!;
      if (seen.has(idNow) || !roomById.has(idNow)) continue;
      seen.add(idNow);
      for (const next of edges.get(idNow) ?? []) stack.push(next);
    }
    return seen;
  };
  const reachable = walk([definition.entranceRoomId], forward);

  // A room is an ending when a run can finish there on purpose: an exit, an
  // extraction point, or an action that ends the run as completed.
  const endsRun = (room: DungeonRoom) =>
    room.kind === 'exit' ||
    room.extraction ||
    room.actions.some((action) =>
      [...ACTION_OUTCOMES[action.type], DECLINED_OUTCOME].some((outcome) => {
        const d = destinationFor(action, outcome);
        return d.type === 'end_run' && d.outcome === 'completed';
      }),
    );
  const endings = definition.rooms.filter(endsRun).map((r) => r.id);
  if (endings.length === 0) {
    add('no_ending', 'error', 'rooms', 'the dungeon has no exit room and no extraction point, so a run could never be finished');
  }
  const backward = new Map<string, Set<string>>(definition.rooms.map((r) => [r.id, new Set<string>()]));
  for (const [from, tos] of forward) for (const to of tos) backward.get(to)?.add(from);
  const canFinish = walk(endings, backward);

  definition.rooms.forEach((room, r) => {
    if (!reachable.has(room.id)) {
      add('room_unreachable', 'warning', `rooms[${r}]`, `room "${room.id}" cannot be reached from the entrance`);
    } else if (endings.length > 0 && !canFinish.has(room.id)) {
      add('room_no_route_to_exit', 'error', `rooms[${r}]`, `room "${room.id}" has no route to an exit or extraction point: a player who enters it can only abandon the run`);
    }
  });

  return { definition, issues };
}
