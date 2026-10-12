import { describe, expect, it } from 'vitest';
import type { DungeonDefinition, DungeonIssue } from '@/api/adminDungeons';
import {
  EVENT_PRESETS,
  createEvent,
  createPool,
  deleteEvent,
  deletePool,
  duplicateEvent,
  duplicatePool,
  eventUsage,
  failureHasContent,
  incompleteEventIssues,
  isAlwaysAvailable,
  newPoolEntry,
  oneIn,
  poolUsage,
  retargetPoolEntry,
  setChoiceCheck,
  setRoomEvent,
  updateEvent,
  usageText,
  withMember,
} from '../dungeonEventModel';
import { deletionBlockers } from '../dungeonMapModel';
import { starterDungeon } from '../dungeonModel';
import { addTemplateRoom, roomPresentation } from '../dungeonRoomTemplates';
import { describePath, friendlyIssue, incompleteIssues } from '../dungeonText';
import { reference } from './dungeonFixtures';
import { eventDungeon } from './eventFixtures';

const ID = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const base = () => starterDungeon('tunnels', 'Tunnels', []);
const issue = (
  code: string,
  path: string,
  message = 'm',
  severity: 'error' | 'warning' = 'error',
) => ({ code, path, message, severity }) satisfies DungeonIssue;

describe('creating events and pools', () => {
  it('creates an event that is valid as it stands: one choice anyone can pick, and nothing else', () => {
    const made = createEvent(base());
    const [event] = made.definition.events!;
    expect(event).toEqual({
      id: made.id,
      title: 'New event',
      text: 'Describe what the player finds here.',
      choices: [
        { id: event!.choices[0]!.id, label: 'Continue', outcome: { text: '', effects: [] } },
      ],
    });
    expect(made.id).toMatch(ID);
    expect(made.id.length).toBeLessThanOrEqual(40);
    expect(event!.choices[0]!.id).toMatch(ID);
    expect(incompleteEventIssues(made.definition, 'x')).toEqual([]);
    // A second one gets its own name, so the two can be told apart in a list.
    expect(createEvent(made.definition).definition.events!.map((e) => e.title)).toEqual([
      'New event',
      'New event 2',
    ]);
  });
  it('offers starting points that each keep a choice every player can pick', () => {
    for (const preset of EVENT_PRESETS) {
      const event = createEvent(base(), preset.id).definition.events![0]!;
      expect(event.choices.some(isAlwaysAvailable), preset.id).toBe(true);
      expect(new Set(event.choices.map((c) => c.id)).size).toBe(event.choices.length);
      for (const choice of event.choices)
        expect(Boolean(choice.check), `${preset.id}: ${choice.label}`).toBe(
          Boolean(choice.success && choice.failure && !choice.outcome),
        );
    }
  });
  it('creates a pool with an event and a Nothing entry, making an event when there is none', () => {
    const made = createPool(base());
    const pool = made.definition.eventPools![0]!;
    expect(made.definition.events).toHaveLength(1);
    expect(pool.entries).toEqual([
      {
        id: pool.entries[0]!.id,
        weight: 1,
        eventId: made.definition.events![0]!.id,
        oncePerRun: true,
      },
      { id: pool.entries[1]!.id, weight: 1, nothing: true },
    ]);
    // With events to hand, none is invented.
    expect(createPool(eventDungeon()).definition.events).toHaveLength(3);
  });
  it('builds an Event room around a new event', () => {
    const added = addTemplateRoom(base(), {}, 'event', 'entrance');
    const room = added.definition.rooms.at(-1)!;
    expect(room.actions).toEqual([
      {
        id: room.actions[0]!.id,
        type: 'event',
        label: '',
        optional: false,
        outcomes: {},
        source: { kind: 'event', eventId: added.definition.events![0]!.id },
      },
    ]);
    expect(roomPresentation(room).label).toBe('Event');
    expect(added.definition.connections).toHaveLength(1);
  });
});

describe('duplicating and deleting', () => {
  it('copies an event under a new id beside the original and leaves the original alone', () => {
    const definition = eventDungeon();
    const before = JSON.stringify(definition);
    const made = duplicateEvent(definition, 'sealed_vault');
    expect(JSON.stringify(definition)).toBe(before);
    const [original, copy] = made.definition.events!;
    expect(copy!.id).toBe(made.id);
    expect(copy!.id).not.toBe('sealed_vault');
    expect(copy!.title).toBe('The Sealed Vault (copy)');
    // Everything inside it, choice and reward ids included, is the same content.
    expect({ ...copy, id: original!.id, title: original!.title }).toEqual(original);
    expect(eventUsage(made.definition, copy!.id)).toEqual([]);
    const pool = duplicatePool(definition, 'scrapheap_finds');
    expect(pool.definition.eventPools!.map((p) => p.name)).toEqual([
      'Scrapheap finds',
      'Scrapheap finds (copy)',
    ]);
    expect(pool.definition.eventPools![1]!.entries).toEqual(definition.eventPools![0]!.entries);
  });
  it('says where an event and a pool are used', () => {
    const definition = eventDungeon();
    expect(eventUsage(definition, 'sealed_vault')).toEqual([
      { kind: 'room', id: 'entrance', name: 'Entrance', actionId: 'a_door' },
      { kind: 'pool', id: 'scrapheap_finds', name: 'Scrapheap finds' },
    ]);
    expect(usageText(eventUsage(definition, 'sealed_vault'))).toBe(
      'Used in Entrance, Scrapheap finds (random pool)',
    );
    expect(usageText(eventUsage(definition, 'shelved'))).toBe('Not used yet');
    expect(poolUsage(definition, 'scrapheap_finds').map((u) => u.actionId)).toEqual(['a_find']);
  });
  it('refuses to delete what is still used, and deletes what is not', () => {
    const definition = eventDungeon();
    expect(deleteEvent(definition, 'sealed_vault')).toBe(definition);
    expect(deleteEvent(definition, 'buried_crate')).toBe(definition);
    expect(deletePool(definition, 'scrapheap_finds')).toBe(definition);
    expect(deleteEvent(definition, 'shelved').events!.map((e) => e.id)).toEqual([
      'sealed_vault',
      'buried_crate',
    ]);
  });
  it('leaves no trace when the last event and pool go: the dungeon reads as it did before events', () => {
    const before = base();
    const withEvent = createPool(before);
    const pool = withEvent.definition.eventPools![0]!.id;
    const event = withEvent.definition.events![0]!.id;
    const cleared = deleteEvent(deletePool(withEvent.definition, pool), event);
    expect(cleared).not.toHaveProperty('events');
    expect(cleared).not.toHaveProperty('eventPools');
    expect(cleared).toEqual(before);
  });
  it('blocks deleting a room an event choice or pool entry waits on', () => {
    const definition = updateEvent(eventDungeon(), 'shelved', (e) => ({
      ...e,
      choices: [{ ...e.choices[0]!, requires: { type: 'room_completed', roomId: 'entrance' } }],
    }));
    const blockers = deletionBlockers(definition, { kind: 'room', id: 'entrance' });
    expect(blockers).toEqual(['events[2].choices.0.requires']);
    expect(describePath(blockers[0]!, definition)).toBe('Event “A Shelved Idea”');
  });
});

describe('a room’s event', () => {
  const plain = (): DungeonDefinition => ({
    ...eventDungeon(),
    rooms: [
      {
        id: 'hall',
        name: 'Hall',
        actions: [
          { id: 'a_rest', type: 'rest', healBasisPoints: 3000 },
          { id: 'a_out', type: 'leave' },
        ],
      },
    ],
  });
  it('adds the event before a trailing leave, so it still happens', () => {
    const set = setRoomEvent(plain(), 'hall', { kind: 'event', eventId: 'shelved' });
    const actions = set.definition.rooms[0]!.actions;
    expect(actions.map((a) => a.type)).toEqual(['rest', 'event', 'leave']);
    expect(actions[1]).toEqual({
      id: set.actionId,
      type: 'event',
      label: '',
      optional: false,
      outcomes: {},
      source: { kind: 'event', eventId: 'shelved' },
    });
  });
  it('changes what an existing event activity presents and keeps its id, rule and flow', () => {
    const first = setRoomEvent(plain(), 'hall', { kind: 'event', eventId: 'shelved' });
    const ruled: DungeonDefinition = {
      ...first.definition,
      rooms: first.definition.rooms.map((r) => ({
        ...r,
        actions: r.actions.map((a) =>
          a.id === first.actionId
            ? {
                ...a,
                when: { type: 'flag' as const, flag: 'vault_opened' },
                outcomes: { nothing: { type: 'room_complete' as const } },
              }
            : a,
        ),
      })),
    };
    const next = setRoomEvent(ruled, 'hall', { kind: 'pool', poolId: 'scrapheap_finds' });
    expect(next.actionId).toBe(first.actionId);
    expect(next.definition.rooms[0]!.actions[1]).toEqual({
      ...ruled.rooms[0]!.actions[1],
      source: { kind: 'pool', poolId: 'scrapheap_finds' },
    });
    // The same source again is no edit at all.
    expect(
      setRoomEvent(next.definition, 'hall', { kind: 'pool', poolId: 'scrapheap_finds' }).definition,
    ).toBe(next.definition);
    expect(setRoomEvent(next.definition, 'hall', null).definition.rooms[0]!.actions).toEqual(
      plain().rooms[0]!.actions,
    );
  });
  it('leaves a room with several event activities to its activity list', () => {
    const definition = eventDungeon();
    expect(setRoomEvent(definition, 'entrance', null).definition).toBe(definition);
  });
});

describe('choices and entries', () => {
  it('turns a result into a skill check and back, keeping what was written', () => {
    const choice = eventDungeon().events![0]!.choices[0]!;
    const checked = setChoiceCheck(choice, true);
    expect(checked).not.toHaveProperty('outcome');
    expect(checked.success).toBe(choice.outcome);
    expect(checked.failure).toEqual({ text: '', effects: [] });
    expect(checked.check).toEqual({
      type: 'sp',
      baseChanceBasisPoints: 5000,
      maxSpModifierBasisPoints: 1500,
    });
    expect(checked.items).toBe(choice.items);
    expect(failureHasContent(checked)).toBe(false);
    expect(setChoiceCheck(checked, false)).toEqual(choice);
    expect(failureHasContent(eventDungeon().events![0]!.choices[1]!)).toBe(true);
  });
  it('re-aims a pool entry and keeps its id, share and rule', () => {
    const [crate, vault, nothing] = eventDungeon().eventPools![0]!.entries;
    expect(retargetPoolEntry(vault!, null)).toEqual({
      id: 'e_vault',
      weight: 10,
      when: (vault as { when: unknown }).when,
      nothing: true,
    });
    expect(retargetPoolEntry(nothing!, 'shelved')).toEqual({
      id: 'e_nothing',
      weight: 60,
      eventId: 'shelved',
      oncePerRun: true,
    });
    expect(retargetPoolEntry(crate!, 'shelved')).toEqual({ ...crate, eventId: 'shelved' });
    expect(retargetPoolEntry(nothing!, null)).toBe(nothing);
    expect(newPoolEntry(eventDungeon().eventPools![0]!, null)).toMatchObject({
      weight: 1,
      nothing: true,
    });
  });
  it('removes a member rather than storing an empty one', () => {
    expect(withMember({ a: 1, b: 2 }, 'b', undefined)).toEqual({ a: 1 });
    expect(withMember({ a: 1 } as { a: number; b?: number }, 'b', 3)).toEqual({ a: 1, b: 3 });
  });
  it('writes odds as about one in N', () => {
    expect(oneIn(0.25)).toBe('about 1 in 4');
    expect(oneIn(0.4)).toBe('about 1 in 2.5');
    expect(oneIn(0.011)).toBe('about 1 in 91');
    expect(oneIn(1)).toBe('');
    expect(oneIn(0)).toBe('');
  });
});

describe('issues about events', () => {
  it('raises blank event fields itself, as things to finish before saving', () => {
    const definition = updateEvent(eventDungeon(), 'sealed_vault', (e) => ({
      ...e,
      title: ' ',
      choices: e.choices.map((c, i) =>
        i === 0 ? { ...c, label: '', items: [{ item: '', quantity: 1, consume: true }] } : c,
      ),
    }));
    const found = incompleteIssues(definition);
    expect(found.map((i) => i.path)).toEqual([
      'events[0].title',
      'events[0].choices[0].label',
      'events[0].choices[0].items[0].item',
    ]);
    const friendly = found.map((i) => friendlyIssue(i, definition, reference));
    expect(friendly.every((f) => f.level === 'finish')).toBe(true);
    expect(friendly[0]!.eventTarget).toEqual({ kind: 'event', id: 'sealed_vault', field: 'title' });
    expect(friendly[2]).toMatchObject({
      title: 'Event “ ”, choice “Untitled” needs an item chosen.',
      eventTarget: { kind: 'event', id: 'sealed_vault', choiceId: 'use_key', field: 'items' },
    });
  });
  it('names the event, the choice and the field a server issue belongs to', () => {
    const definition = eventDungeon();
    const cases: Array<[DungeonIssue, object]> = [
      [
        issue('event_no_open_choice', 'events[0].choices'),
        {
          title: 'Event “The Sealed Vault” needs a choice everyone can pick.',
          level: 'fix',
          eventTarget: { kind: 'event', id: 'sealed_vault', field: 'choices' },
        },
      ],
      [
        issue('event_item_missing', 'events[0].choices[0].items[0].item'),
        {
          title:
            'Event “The Sealed Vault”, choice “Use the Vault Key” needs an item that no longer exists.',
          eventTarget: { kind: 'event', id: 'sealed_vault', choiceId: 'use_key', field: 'items' },
        },
      ],
      [
        issue('event_check_retreat', 'events[0].choices[1].failure.then'),
        {
          eventTarget: {
            kind: 'event',
            id: 'sealed_vault',
            choiceId: 'pick_lock',
            field: 'failure.then',
          },
        },
      ],
      [
        issue(
          'flag_undeclared',
          'events[0].choices[1].success.effects[0].flag',
          'sets flag "gone"',
        ),
        {
          eventTarget: {
            kind: 'event',
            id: 'sealed_vault',
            choiceId: 'pick_lock',
            field: 'success.effects',
          },
        },
      ],
      [
        issue('event_unused', 'events[2]', 'unused', 'warning'),
        {
          title: 'Event “A Shelved Idea” isn’t used anywhere yet.',
          level: 'review',
          eventTarget: { kind: 'event', id: 'shelved' },
        },
      ],
      [
        issue('event_pool_may_be_empty', 'eventPools[0].entries', 'm', 'warning'),
        {
          title: 'Random pool “Scrapheap finds” can run out of entries.',
          eventTarget: { kind: 'pool', id: 'scrapheap_finds', field: 'entries' },
        },
      ],
      [
        issue('event_missing', 'eventPools[0].entries[1].eventId'),
        {
          eventTarget: {
            kind: 'pool',
            id: 'scrapheap_finds',
            entryId: 'e_vault',
            field: 'eventId',
          },
        },
      ],
      [
        issue('condition_too_deep', 'eventPools[0].entries[1].when'),
        {
          eventTarget: {
            kind: 'pool',
            id: 'scrapheap_finds',
            entryId: 'e_vault',
            field: 'requires',
          },
        },
      ],
    ];
    for (const [raw, expected] of cases) {
      const friendly = friendlyIssue(raw, definition, reference);
      expect(friendly, raw.path).toMatchObject({ target: null, actionId: null, ...expected });
    }
  });
  it('words an event reward problem by its reward, and sends currency problems to settings', () => {
    const definition = eventDungeon();
    const table = friendlyIssue(
      issue(
        'reward_table_missing',
        'events[0].choices[0].outcome.rewards.tables[0].table',
        'Event "The Sealed Vault", choice "Use the Vault Key": loot table "vault_hoard" does not exist',
      ),
      definition,
      reference,
    );
    expect(table.title).toBe(
      'Event “The Sealed Vault”, choice “Use the Vault Key”: a loot table needs attention.',
    );
    expect(table.help).toBe('This loot table was deleted. Remove it or pick another.');
    expect(table.eventTarget).toMatchObject({ choiceId: 'use_key', field: 'outcome.rewards' });
    const shards = friendlyIssue(
      issue('reward_shards_unset', 'events[0].choices[0].outcome.rewards.guaranteed[0]'),
      definition,
      reference,
    );
    expect(shards.settingsField).toBe('progressionCurrency');
  });
  it('sends an event activity’s own problems to its room', () => {
    const definition = eventDungeon();
    const friendly = friendlyIssue(
      issue('event_missing', 'rooms[0].actions[2].source.eventId'),
      definition,
      reference,
    );
    expect(friendly).toMatchObject({
      target: { kind: 'room', id: 'entrance' },
      actionId: 'a_door',
      title: 'Entrance: the event activity points at an event that is no longer in this dungeon.',
    });
    expect(friendly.eventTarget).toBeUndefined();
  });
});
