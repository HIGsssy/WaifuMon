/**
 * Dungeon definition validation: stable codes, severities and paths.
 */
import { describe, expect, it } from 'vitest';
import type { DungeonDefinitionInput } from '../../../src/modules/dungeons/content/dungeonDefinition';
import {
  DUNGEON_ISSUE_CODES,
  hasErrors,
  validateDungeonDefinition,
  type DungeonIssue,
  type DungeonValidationContext,
} from '../../../src/modules/dungeons/validation/dungeonValidation';
import { CURRENCY, TEST_ENEMIES, testDungeonInput } from '../../helpers/dungeonFixtures';

const ctx = (over: Partial<DungeonValidationContext> = {}): DungeonValidationContext => ({
  enemies: new Map(TEST_ENEMIES.map((e) => [e.key, { enabled: true }])),
  rewardTables: new Map([['loot', { enabled: true }], ['off', { enabled: false }]]),
  regions: new Map([['waifu-valley', { enabled: true }]]),
  currencies: new Map([[CURRENCY, { enabled: true }]]),
  ...over,
});

function validate(patch: (d: DungeonDefinitionInput) => void = () => {}, context: DungeonValidationContext = ctx()) {
  const input = testDungeonInput();
  patch(input);
  return validateDungeonDefinition(input, context);
}
const codes = (issues: DungeonIssue[], severity?: DungeonIssue['severity']) =>
  issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);
const room = (d: DungeonDefinitionInput, id: string) => d.rooms.find((r) => r.id === id)!;

describe('validateDungeonDefinition', () => {
  it('accepts the test dungeon with no issues at all', () => {
    const { definition, issues } = validate();
    expect(issues).toEqual([]);
    expect(definition?.rooms).toHaveLength(5);
  });

  it('accepts a cyclic map: a dungeon is a graph, not a tree', () => {
    const { issues } = validate((d) => {
      d.connections!.push({ id: 'c_loop', from: 'pump_room', to: 'gate' }, { id: 'c_loop2', from: 'bulkhead', to: 'locker_room' });
    });
    expect(issues).toEqual([]);
  });

  it('only uses codes from the published list', () => {
    const { issues } = validate((d) => {
      d.entranceRoomId = 'nowhere';
      d.rooms.push({ id: 'gate', actions: [] });
    });
    for (const issue of issues) expect(DUNGEON_ISSUE_CODES).toContain(issue.code);
  });

  it('reports shape problems as `schema` errors with a path, and returns no definition', () => {
    const { definition, issues } = validate((d) => {
      (room(d, 'gate').actions![1] as { reward: unknown }).reward = { currency: { min: 5, max: 1 } };
    });
    expect(definition).toBeNull();
    expect(issues).toContainEqual(expect.objectContaining({ code: 'schema', severity: 'error', path: 'rooms[0].actions[1].reward.currency' }));
  });

  it('names a reserved action type and its phase instead of a schema error', () => {
    const { definition, issues } = validate((d) => {
      room(d, 'gate').actions!.push({ id: 'talk', type: 'event', eventKey: 'x' } as never);
      room(d, 'gate').actions!.push({ id: 'huh', type: 'teleport' } as never);
    });
    expect(definition).toBeNull();
    expect(issues).toEqual([
      expect.objectContaining({ code: 'unsupported_action_type', path: 'rooms[0].actions[2].type', message: expect.stringContaining('Phase 3') }),
      expect.objectContaining({ code: 'unknown_action_type', path: 'rooms[0].actions[3].type' }),
    ]);
  });

  it('refuses duplicate room, connection, action and flag ids', () => {
    const { issues } = validate((d) => {
      d.rooms.push({ id: 'gate', name: 'Twin', actions: [] });
      d.connections!.push({ id: 'c_main', from: 'gate', to: 'den' });
      room(d, 'pump_room').actions!.push({ id: 'valve', type: 'rest' });
      d.flags!.push({ key: 'valve_opened' });
    });
    expect(codes(issues, 'error')).toEqual(expect.arrayContaining(['duplicate_room_id', 'duplicate_connection_id', 'duplicate_action_id', 'duplicate_flag']));
  });

  it('allows the same action id in two different rooms', () => {
    const { issues } = validate((d) => {
      room(d, 'locker_room').actions!.push({ id: 'guards', type: 'rest' });
    });
    expect(codes(issues)).not.toContain('duplicate_action_id');
  });

  it('refuses a missing entrance and connections to rooms that do not exist', () => {
    const { issues } = validate((d) => {
      d.entranceRoomId = 'lobby';
      d.connections!.push({ id: 'c_void', from: 'gate', to: 'void' }, { id: 'c_from', from: 'attic', to: 'gate' });
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'entrance_missing', severity: 'error', path: 'entranceRoomId' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'connection_unknown_room', path: 'connections[7].to' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'connection_unknown_room', path: 'connections[8].from' }));
  });

  it('refuses backward jumps, self jumps and jumps to unknown actions', () => {
    const { issues } = validate((d) => {
      const actions = room(d, 'pump_room').actions!;
      actions[2] = { ...actions[2]!, outcomes: { done: { type: 'action', actionId: 'bruiser' } } };
      actions[1] = { ...actions[1]!, next: { type: 'action', actionId: 'breather' } };
      actions[0] = { ...actions[0]!, outcomes: { victory: { type: 'action', actionId: 'nope' } } };
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'transition_backward', severity: 'error', path: 'rooms[1].actions[2].outcomes.done' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'transition_backward', path: 'rooms[1].actions[1].next', message: expect.stringContaining('to itself') }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'transition_unknown_action', path: 'rooms[1].actions[0].outcomes.victory' }));
  });

  it('refuses an outcome the action type cannot report', () => {
    const { issues } = validate((d) => {
      const actions = room(d, 'pump_room').actions!;
      actions[1] = { ...actions[1]!, outcomes: { victory: { type: 'room_complete' } } };
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'unknown_outcome', severity: 'error', path: 'rooms[1].actions[1].outcomes.victory' }));
  });

  it('refuses a `leave` through a connection that is not the room’s own', () => {
    const { issues } = validate((d) => {
      room(d, 'pump_room').actions!.push({ id: 'go', type: 'leave', connectionId: 'c_side' });
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'transition_invalid_connection', severity: 'error' }));
  });

  it('refuses a gate that would turn the player back out of the entrance', () => {
    const { issues } = validate((d) => {
      room(d, 'gate').actions!.unshift({ id: 'door', type: 'gate', requires: { type: 'flag', flag: 'valve_opened' } });
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'retreat_from_entrance', severity: 'error', path: 'rooms[0].actions[0]' }));
  });

  it('refuses flags that are undeclared, mis-scoped or player-scoped writes', () => {
    const { issues } = validate((d) => {
      d.flags!.push({ key: 'legend', scope: 'player' });
      room(d, 'pump_room').actions!.push(
        { id: 'ghost', type: 'set_flag', flag: 'ghost_flag' },
        { id: 'wrong', type: 'set_flag', flag: 'legend', scope: 'run' },
        { id: 'persist', type: 'set_flag', flag: 'legend', scope: 'player' },
        { id: 'reads', type: 'rest', when: { type: 'flag', flag: 'never_declared' } },
      );
    });
    expect(codes(issues, 'error')).toEqual(expect.arrayContaining(['flag_undeclared', 'flag_scope_mismatch', 'flag_scope_unsupported']));
    expect(issues.filter((i) => i.code === 'flag_undeclared').map((i) => i.path)).toEqual(['rooms[1].actions[3].flag', 'rooms[1].actions[6].when']);
  });

  it('warns — never refuses — about a flag nothing sets and one nothing uses', () => {
    const { issues } = validate((d) => {
      d.flags!.push({ key: 'orphan' }, { key: 'unset' });
      d.connections!.push({ id: 'c_secret', from: 'gate', to: 'den', kind: 'secret', requires: { type: 'flag', flag: 'unset' } });
    });
    expect(hasErrors(issues)).toBe(false);
    expect(codes(issues, 'warning')).toEqual(expect.arrayContaining(['flag_never_set', 'flag_unused']));
  });

  it('refuses a condition that names a room that does not exist', () => {
    const { issues } = validate((d) => {
      d.connections![0] = { ...d.connections![0]!, requires: { type: 'all', conditions: [{ type: 'not', condition: { type: 'room_completed', roomId: 'attic' } }] } };
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'condition_unknown_room', severity: 'error', path: 'connections[0].requires' }));
  });

  it('checks enemies against the catalogue: missing is an error, disabled a warning', () => {
    const { issues } = validate(
      (d) => {
        room(d, 'pump_room').actions![0] = { id: 'bruiser', type: 'combat', waves: [{ enemy: { key: 'dragon' } }, { enemy: { key: 'warden' } }] };
      },
      ctx({ enemies: new Map([...TEST_ENEMIES.map((e) => [e.key, { enabled: e.key !== 'warden' }] as const)]) }),
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'enemy_missing', severity: 'error', path: 'rooms[1].actions[0].waves[0].enemy' }));
    expect(issues.filter((i) => i.code === 'enemy_disabled')).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning' })]));
  });

  it('refuses a weighted pool that names an enemy twice, and the schema refuses a zero weight', () => {
    const twice = validate((d) => {
      room(d, 'gate').actions![0] = { id: 'guards', type: 'combat', waves: [{ enemy: { pool: [{ key: 'grunt', weight: 1 }, { key: 'grunt', weight: 2 }] } }] };
    });
    expect(twice.issues).toContainEqual(expect.objectContaining({ code: 'enemy_pool_duplicate', severity: 'error', path: 'rooms[0].actions[0].waves[0].enemy.pool' }));
    const zero = validate((d) => {
      room(d, 'gate').actions![0] = { id: 'guards', type: 'combat', waves: [{ enemy: { pool: [{ key: 'grunt', weight: 0 }] } }] };
    });
    expect(zero.definition).toBeNull();
    expect(codes(zero.issues)).toEqual(['schema']);
  });

  it('does not limit waves, but says when a fight is very long', () => {
    const { issues } = validate((d) => {
      room(d, 'gate').actions![0] = { id: 'guards', type: 'combat', waves: Array.from({ length: 25 }, () => ({ enemy: { key: 'grunt' } })) };
    });
    expect(hasErrors(issues)).toBe(false);
    expect(codes(issues)).toEqual(['many_waves']);
  });

  it('checks reward tables, regions and the currency against the server', () => {
    const { issues } = validate((d) => {
      d.availableRegions = ['waifu-valley', 'atlantis'];
      d.settings = { progressionCurrency: 'doubloons' };
      room(d, 'gate').actions![1] = { id: 'pay', type: 'reward', reward: { rewardTable: 'missing-table', equipmentRewardTable: 'off' } };
    });
    expect(codes(issues, 'error')).toEqual(expect.arrayContaining(['reward_table_missing', 'region_missing', 'currency_missing']));
    expect(codes(issues, 'warning')).toContain('reward_table_disabled');
  });

  it('skips reference checks entirely when given no context', () => {
    const { issues } = validateDungeonDefinition({ ...testDungeonInput(), availableRegions: ['atlantis'] });
    expect(issues).toEqual([]);
  });

  it('warns about a room nothing leads to, and refuses a room with no way to an ending', () => {
    const { issues } = validate((d) => {
      d.rooms.push({ id: 'attic', name: 'Attic', actions: [{ id: 'nap', type: 'rest' }] });
      d.rooms.push({ id: 'pit', name: 'Pit', actions: [{ id: 'fall', type: 'rest' }] });
      d.connections!.push({ id: 'c_pit', from: 'gate', to: 'pit' });
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'room_unreachable', severity: 'warning', path: 'rooms[5]' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'room_no_route_to_exit', severity: 'error', path: 'rooms[6]' }));
  });

  it('counts an extraction room as an ending, and refuses a dungeon with none', () => {
    const extractionOnly = validate((d) => {
      d.rooms = d.rooms.filter((r) => r.id !== 'den');
      d.connections = d.connections!.filter((c) => c.to !== 'den');
    });
    expect(hasErrors(extractionOnly.issues)).toBe(false);

    const none = validate((d) => {
      d.rooms = d.rooms.filter((r) => r.id !== 'den').map((r) => ({ ...r, extraction: false }));
      d.connections = d.connections!.filter((c) => c.to !== 'den');
    });
    expect(codes(none.issues, 'error')).toContain('no_ending');
  });

  it('refuses connections out of an exit room and warns about extraction on one', () => {
    const { issues } = validate((d) => {
      room(d, 'den').extraction = true;
      d.connections!.push({ id: 'c_after', from: 'den', to: 'gate' });
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'exit_has_connections', severity: 'error' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'exit_extraction_redundant', severity: 'warning' }));
  });

  it('warns about an action nothing can reach', () => {
    const { issues } = validate((d) => {
      room(d, 'pump_room').actions!.splice(1, 0, { id: 'out', type: 'leave' });
    });
    expect(issues.filter((i) => i.code === 'action_unreachable').map((i) => i.path)).toEqual(['rooms[1].actions[2]', 'rooms[1].actions[3]']);
  });

  it('does not require every optional room to be visited or branches to be balanced', () => {
    const { issues } = validate((d) => {
      d.rooms.push({ id: 'shrine', name: 'Shrine', actions: [{ id: 'pray', type: 'rest', optional: true }] });
      d.connections!.push({ id: 'c_shrine', from: 'gate', to: 'shrine', kind: 'secret' }, { id: 'c_shrine_back', from: 'shrine', to: 'gate' });
    });
    expect(issues).toEqual([]);
  });

  it('warns about missing artwork without refusing', () => {
    const { issues } = validate(
      (d) => {
        d.artwork = { kind: 'shipped', path: 'dungeons/zones/nope.webp' };
        d.background = { kind: 'managed', category: 'dungeon_background', contentHash: 'a'.repeat(64), name: 'bg.webp' };
      },
      ctx({ shippedArtworkExists: () => false, managedArtwork: new Set() }),
    );
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['artwork_missing', 'warning'], ['artwork_missing', 'warning']]);
  });
});
