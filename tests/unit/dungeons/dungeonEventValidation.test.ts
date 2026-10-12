/**
 * Validation of dungeon events and pools: one case per rule, with the stable
 * code and the path an editor will route on.
 */
import { describe, expect, it } from 'vitest';
import type { DungeonDefinitionInput } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { DUNGEON_ISSUE_CODES, hasErrors, validateDungeonDefinition, type DungeonIssue } from '../../../src/modules/dungeons/validation/dungeonValidation';
import { testDungeon } from '../../helpers/dungeonFixtures';
import { eventDungeonInput, eventValidationContext } from '../../helpers/dungeonEventFixtures';

type Input = DungeonDefinitionInput;
function validate(patch: (d: Input) => void = () => {}, ctx = eventValidationContext()) {
  const input = eventDungeonInput();
  patch(input);
  return validateDungeonDefinition(input, ctx);
}
const find = (issues: DungeonIssue[], code: string) => issues.filter((i) => i.code === code).map((i) => `${i.severity} ${i.path}`);
const vault = (d: Input) => d.events![0]!;
const pool = (d: Input) => d.eventPools![0]!;
const outcomeOnly = (id: string, label = id) => ({ id, label, outcome: {} });

describe('event validation', () => {
  it('accepts the fixture, warning only about the event nothing uses', () => {
    const { definition, issues } = validate();
    expect(definition).not.toBeNull();
    expect(issues.map((i) => `${i.severity} ${i.code} ${i.path}`)).toEqual(['warning event_unused events[4]']);
    for (const issue of issues) expect(DUNGEON_ISSUE_CODES).toContain(issue.code);
  });

  it('reports missing events and pools where they are named', () => {
    const { issues } = validate((d) => {
      d.rooms[1]!.actions![0] = { id: 'door', type: 'event', source: { kind: 'event', eventId: 'ghost' } };
      d.rooms[2]!.actions![0] = { id: 'find', type: 'event', source: { kind: 'pool', poolId: 'no_pool' } };
      pool(d).entries.push({ id: 'e_ghost', weight: 1, eventId: 'phantom' });
    });
    expect(find(issues, 'event_missing')).toEqual(['error eventPools[0].entries[4].eventId', 'error rooms[1].actions[0].source.eventId']);
    expect(find(issues, 'event_pool_missing')).toEqual(['error rooms[2].actions[0].source.poolId']);
    expect(hasErrors(issues)).toBe(true);
  });

  it('refuses duplicate event, pool, choice and pool-entry ids', () => {
    const { issues } = validate((d) => {
      d.events!.push({ ...structuredClone(d.events![3]!) });
      d.eventPools!.push(structuredClone(pool(d)));
      vault(d).choices[2]!.id = 'use_key';
      pool(d).entries[1]!.id = 'e_crate';
    });
    expect(find(issues, 'duplicate_event_id')).toEqual(['error events[5].id']);
    expect(find(issues, 'duplicate_event_pool_id')).toEqual(['error eventPools[1].id']);
    expect(find(issues, 'duplicate_choice_id')).toEqual(['error events[0].choices[2].id']);
    expect(find(issues, 'duplicate_pool_entry_id')).toEqual(['error eventPools[0].entries[1].id']);
  });

  it('warns about events and pools nothing uses, without failing the dungeon', () => {
    const { issues } = validate((d) => {
      d.rooms[0]!.actions = [];
      d.rooms[2]!.actions = [];
    });
    // The pool is unused, so the events only it lists are unused too.
    expect(find(issues, 'event_pool_unused')).toEqual(['warning eventPools[0]']);
    expect(find(issues, 'event_unused')).toEqual(['warning events[1]', 'warning events[2]', 'warning events[3]', 'warning events[4]']);
    expect(hasErrors(issues)).toBe(false);
  });

  it('does not let an unused event’s catalogue references hold up the dungeon, but still checks its structure', () => {
    const { issues } = validate((d) => {
      const shelved = d.events![4]!;
      shelved.choices[0]!.items = [{ item: 'item_that_is_gone', quantity: 1, consume: true }];
      shelved.artwork = { kind: 'managed', category: 'dungeon_bg', contentHash: 'a'.repeat(64) };
    }, { ...eventValidationContext(), managedArtwork: new Set() });
    expect(issues.map((i) => i.code)).toEqual(['event_unused', 'event_no_open_choice']);

    // The same content in an event a room can present is a real problem.
    const used = validate((d) => {
      vault(d).choices[0]!.items = [{ item: 'item_that_is_gone', quantity: 1, consume: true }];
      vault(d).choices[0]!.outcome!.rewards!.tables = [{ id: 'gone', table: 'unfinished_table', draws: 1 }];
      vault(d).artwork = { kind: 'managed', category: 'dungeon_bg', contentHash: 'a'.repeat(64) };
    }, { ...eventValidationContext(), managedArtwork: new Set() }).issues;
    expect(find(used, 'event_item_missing')).toEqual(['error events[0].choices[0].items[0].item']);
    expect(find(used, 'reward_table_missing')).toEqual(['error events[0].choices[0].outcome.rewards.tables[0]']);
    expect(find(used, 'artwork_missing')).toEqual(['warning artwork']);

    // An unused event that is malformed is still refused.
    const malformed = validate((d) => { (d.events![4]!.choices[0] as Record<string, unknown>).check = { type: 'sp', baseChanceBasisPoints: 5 }; });
    expect(malformed.definition).toBeNull();
    expect(malformed.issues).toContainEqual(expect.objectContaining({ code: 'schema', path: 'events[4].choices[0].outcome' }));
  });

  it('names reward problems by event and choice, at the bundle’s own path', () => {
    const { issues } = validate((d) => {
      vault(d).choices[1]!.success!.rewards = { guaranteed: [{ id: 'gift', grant: { type: 'item', item: 'missing_item', quantity: { min: 1, max: 1 } } }], chances: [], tables: [] };
      d.settings = { ...d.settings, progressionCurrency: null };
    });
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'reward_item_missing', path: 'events[0].choices[1].success.rewards.guaranteed[0].grant',
      message: expect.stringContaining('Event "The Sealed Vault", choice "Work the lock" (success)'),
    }));
    expect(find(issues, 'reward_shards_unset')).toEqual([
      'error events[0].choices[0].outcome.rewards.guaranteed[0].grant',
      'error events[1].choices[0].outcome.rewards.guaranteed[0].grant',
    ]);
  });

  it('requires a choice every player can always pick', () => {
    const { issues } = validate((d) => {
      d.events![3]!.choices = [
        { ...outcomeOnly('pay'), items: [{ item: 'vault_key', quantity: 1, consume: false }] },
        { ...outcomeOnly('known'), requires: { type: 'flag', flag: 'alarm_triggered' } },
      ];
    });
    expect(find(issues, 'event_no_open_choice')).toEqual(['error events[3].choices']);
  });

  it('requires an entrance event to have an always-available choice that goes on', () => {
    // The crate can walk away — fine anywhere else, not enough at the entrance on its own.
    const retreatOnly = validate((d) => {
      d.events![1]!.choices[0]!.requires = { type: 'flag', flag: 'alarm_triggered' };
    }).issues;
    expect(retreatOnly.filter((i) => i.code === 'event_entrance_no_exit')).toEqual([
      expect.objectContaining({ severity: 'error', path: 'rooms[0].actions[0].source', message: expect.stringContaining('A Buried Crate') }),
    ]);
    // `leave` is always available, so the event itself is not stuck; only the entrance is the problem.
    expect(find(retreatOnly, 'event_no_open_choice')).toEqual([]);

    // A direct event at the entrance is held to the same rule; the vault's `force` satisfies it.
    const direct = (patch: (d: Input) => void) => validate((d) => {
      d.rooms[0]!.actions = [{ id: 'door', type: 'event', source: { kind: 'event', eventId: 'sealed_vault' } }];
      patch(d);
    }).issues;
    expect(find(direct(() => {}), 'event_entrance_no_exit')).toEqual([]);
    expect(find(direct((d) => { vault(d).choices = [vault(d).choices[0]!, vault(d).choices[4]!]; }), 'event_entrance_no_exit')).toEqual(['error rooms[0].actions[0].source']);
    // Ending the run counts as a way on.
    expect(find(direct((d) => {
      vault(d).choices = [{ id: 'quit', label: 'Go home', outcome: { then: { type: 'end_run', outcome: 'completed' } } }, vault(d).choices[4]!];
    }), 'event_entrance_no_exit')).toEqual([]);
    // The same event deeper in the dungeon is not held to it.
    expect(find(validate((d) => { vault(d).choices = [vault(d).choices[0]!, vault(d).choices[4]!]; }).issues, 'event_entrance_no_exit')).toEqual([]);
  });

  it('keeps walking away free of cost and consequence', () => {
    const { issues } = validate((d) => {
      const leave = vault(d).choices[4]!;
      leave.outcome!.effects = [{ type: 'set_flag', flag: 'alarm_triggered', value: true }];
      vault(d).choices[1]!.failure!.then = { type: 'retreat' };
      vault(d).choices[1]!.failure!.effects = [];
      d.events![1]!.choices[1]!.items = [{ item: 'vault_key', quantity: 1, consume: true }];
    });
    expect(find(issues, 'event_retreat_with_effects')).toEqual(['error events[0].choices[4].outcome.then', 'error events[1].choices[1].outcome.then']);
    expect(find(issues, 'event_check_retreat')).toEqual(['error events[0].choices[1].failure.then']);
  });

  it('refuses an optional event and event routing that turns back', () => {
    const { issues } = validate((d) => {
      d.rooms[1]!.actions![0] = { id: 'door', type: 'event', source: { kind: 'event', eventId: 'sealed_vault' }, optional: true, next: { type: 'retreat' } };
      d.rooms[2]!.actions![0] = { id: 'find', type: 'event', source: { kind: 'pool', poolId: 'scrapheap_finds' }, outcomes: { nothing: { type: 'retreat' } } };
    });
    expect(find(issues, 'event_optional_unsupported')).toEqual(['error rooms[1].actions[0].optional']);
    expect(find(issues, 'event_route_retreat')).toEqual(['error rooms[1].actions[0].next', 'error rooms[2].actions[0].outcomes.nothing']);
  });

  it('checks item requirements against the catalogue', () => {
    const { issues } = validate((d) => {
      vault(d).choices[0]!.items = [{ item: 'vault_key', quantity: 1, consume: true }, { item: 'vault_key', quantity: 2, consume: false }];
      vault(d).choices[2]!.items = [{ item: 'crowbar', quantity: 1, consume: false }];
      vault(d).choices[3]!.items = [{ item: 'old_pass', quantity: 1, consume: false }];
    }, { ...eventValidationContext(), items: new Map([...eventValidationContext().items!, ['old_pass', { name: 'Old Pass', category: 'key', enabled: false, maxOwned: 1 }]]) });
    expect(find(issues, 'event_item_duplicate')).toEqual(['error events[0].choices[0].items[1].item']);
    expect(find(issues, 'event_item_missing')).toEqual(['error events[0].choices[2].items[0].item']);
    // A capped item is fine to require: it is held or spent, never paid.
    expect(find(issues, 'event_item_disabled')).toEqual(['warning events[0].choices[3].items[0].item']);
    // Without an item catalogue (a portable package) existence is not judged.
    expect(find(validate((d) => { vault(d).choices[2]!.items = [{ item: 'crowbar', quantity: 1, consume: false }]; }, {}).issues, 'event_item_missing')).toEqual([]);
  });

  it('names an effect that is planned but not supported, instead of a union error', () => {
    const { definition, issues } = validate((d) => {
      (vault(d).choices[2]!.outcome as Record<string, unknown>).effects = [{ type: 'start_combat', enemy: 'grunt' }, { type: 'teleport' }];
    });
    expect(definition).toBeNull();
    expect(issues).toEqual([
      expect.objectContaining({ code: 'unsupported_event_effect', path: 'events[0].choices[2].outcome.effects[0].type', message: expect.stringContaining('later phase') }),
      expect.objectContaining({ code: 'unsupported_event_effect', path: 'events[0].choices[2].outcome.effects[1].type', message: expect.stringContaining('set_flag, heal, damage') }),
    ]);
  });

  it('holds flags in effects, choice rules and pool rules to the dungeon’s declarations', () => {
    const { issues } = validate((d) => {
      d.flags!.push({ key: 'seen_forever', scope: 'player' });
      vault(d).choices[2]!.outcome!.effects = [{ type: 'set_flag', flag: 'undeclared', value: true }, { type: 'set_flag', flag: 'seen_forever', value: true }];
      vault(d).choices[3]!.requires = { type: 'flag', flag: 'nobody_declared_this' };
      pool(d).entries[2]!.when = { type: 'flag', flag: 'also_undeclared' };
    });
    expect(find(issues, 'flag_undeclared')).toEqual([
      'error events[0].choices[2].outcome.effects[0].flag',
      'error events[0].choices[3].requires',
      'error eventPools[0].entries[2].when',
    ]);
    expect(find(issues, 'flag_scope_unsupported')).toEqual(['error events[0].choices[2].outcome.effects[1].flag']);
  });

  it('counts a flag an event sets as set, and one only an unused event sets as never set', () => {
    // `vault_opened` and `alarm_triggered` are set only by events, and read by a path, an activity, a choice and a pool entry.
    expect(find(validate().issues, 'flag_never_set')).toEqual([]);
    expect(find(validate().issues, 'flag_unused')).toEqual([]);
    const { issues } = validate((d) => {
      d.flags!.push({ key: 'shelf_flag', scope: 'run' });
      d.events![4]!.choices[0]!.outcome!.effects = [{ type: 'set_flag', flag: 'shelf_flag', value: true }];
      d.connections![4]!.requires = { type: 'flag', flag: 'shelf_flag' };
    });
    expect(find(issues, 'flag_never_set')).toEqual(['warning connections[4].requires']);
  });

  it('warns about a choice that can never be picked and a check that cannot vary', () => {
    const { issues } = validate((d) => {
      vault(d).choices[3]!.requires = { type: 'all', conditions: [{ type: 'flag', flag: 'alarm_triggered' }, { type: 'not', condition: { type: 'flag', flag: 'alarm_triggered' } }] };
      vault(d).choices[1]!.check = { type: 'sp', baseChanceBasisPoints: 9900, maxSpModifierBasisPoints: 0 };
    });
    expect(find(issues, 'event_choice_contradiction')).toEqual(['warning events[0].choices[3].requires']);
    expect(find(issues, 'event_check_flat')).toEqual(['warning events[0].choices[1].check']);
    expect(hasErrors(issues)).toBe(false);
  });

  it('checks pool composition: duplicates, Nothing-only, and draws that can run dry', () => {
    const { issues } = validate((d) => {
      pool(d).entries = [
        { id: 'a', weight: 5, eventId: 'buried_crate' },
        { id: 'b', weight: 5, eventId: 'buried_crate' },
        { id: 'c', weight: 5, eventId: 'sparking_drone', when: { type: 'flag', flag: 'alarm_triggered' } },
      ];
      d.eventPools!.push({ id: 'void', name: 'Void', entries: [{ id: 'n1', weight: 1, nothing: true }, { id: 'n2', weight: 3, nothing: true }] });
      d.rooms[2]!.actions![0] = { id: 'find', type: 'event', source: { kind: 'pool', poolId: 'void' } };
    });
    expect(find(issues, 'event_pool_duplicate_event')).toEqual(['error eventPools[0].entries[1].eventId']);
    expect(find(issues, 'event_pool_all_nothing')).toEqual(['error eventPools[1].entries']);
    expect(find(issues, 'event_pool_may_be_empty')).toEqual(['warning eventPools[0].entries']);
    // A repeatable entry with no rule keeps the draw from ever running dry.
    const steady = validate((d) => { pool(d).entries = [{ id: 'a', weight: 1, eventId: 'scavenger_trader', oncePerRun: false }]; }).issues;
    expect(find(steady, 'event_pool_may_be_empty')).toEqual([]);
  });

  it('follows event routing in the sequence and graph checks', () => {
    // Every vault outcome completes the room or ends the run: the breather can never run.
    const dead = validate((d) => {
      for (const choice of vault(d).choices.slice(0, 4)) {
        for (const branch of ['outcome', 'success', 'failure'] as const) if (choice[branch]) choice[branch]!.then = { type: 'room_complete' };
      }
    }).issues;
    expect(find(dead, 'action_unreachable')).toEqual(['warning rooms[1].actions[1]']);
    expect(find(validate().issues, 'action_unreachable')).toEqual([]);

    // An outcome that ends the run as completed is an ending; a walk-away is a way back.
    const onlyEvents = validate((d) => {
      d.rooms = d.rooms.filter((r) => r.kind !== 'exit');
      d.connections = d.connections!.filter((c) => c.to !== 'lower' && c.to !== 'out');
    }).issues;
    expect(find(onlyEvents, 'no_ending')).toEqual([]);
    expect(find(onlyEvents, 'room_no_route_to_exit')).toEqual([]);
    const noEnding = validate((d) => {
      d.rooms = d.rooms.filter((r) => r.kind !== 'exit');
      d.connections = d.connections!.filter((c) => c.to !== 'lower' && c.to !== 'out');
      d.events![2]!.choices.pop();
    }).issues;
    expect(find(noEnding, 'no_ending')).toEqual(['error rooms']);

    expect(find(validate((d) => {
      d.rooms[1]!.actions![0] = { id: 'door', type: 'event', source: { kind: 'event', eventId: 'sealed_vault' }, outcomes: { victory: { type: 'next' } } };
    }).issues, 'unknown_outcome')).toEqual(['error rooms[1].actions[0].outcomes.victory']);
  });

  it('applies the reward work limits to an event action’s worst outcome', () => {
    const gear = (id: string) => ({ id, grant: { type: 'equipment' as const, selector: { slot: 'attack' as const, rarity: 'R' as const } } });
    const heavy = { guaranteed: [], chances: [], pools: [{ id: 'p', name: 'Gear', draws: 6, entries: [{ id: 'g', weight: 1, grant: gear('g').grant }] }] };
    const { issues } = validate((d) => {
      vault(d).choices[2]!.outcome!.rewards = { guaranteed: [], chances: [], tables: [{ id: 'a', table: 'heavy', draws: 2 }] };
    }, { ...eventValidationContext(), lootTables: new Map([...eventValidationContext().lootTables!, ['heavy', { name: 'Heavy', body: heavy, archivedAt: null }]]) });
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'reward_too_much_gear', path: 'events[0].choices[2].outcome.rewards', message: expect.stringContaining('Event "The Sealed Vault", choice "Force it"'),
    }));
  });

  it('leaves event-free dungeons exactly as they were', () => {
    const { issues } = validateDungeonDefinition(testDungeon());
    expect(issues.filter((i) => i.code.startsWith('event') || i.code === 'unsupported_event_effect')).toEqual([]);
  });
});
