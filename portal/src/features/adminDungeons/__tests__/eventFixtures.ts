/**
 * An event dungeon that uses every part of the event model, and a stand-in for
 * the server's reading of it.
 *
 * `fakeInsight` is a test double only. In the product every odd and every
 * availability comes from the engine (`engine/eventAuthoring.ts`, covered by
 * the backend's own tests and used for real in the Playwright specs); the
 * component tests need something that answers the same question shape.
 */
import type {
  DungeonCondition,
  DungeonDefinition,
  DungeonEventPoolOdds,
  DungeonEventScenario,
  DungeonValidation,
} from '@/api/adminDungeons';
import { fixture } from './dungeonFixtures';

/** Every part of the event model: requirements, a check, effects, rewards, artwork, a pool with rules. */
export function eventDungeon(): DungeonDefinition {
  return {
    ...fixture().draft,
    flags: [
      { key: 'vault_opened', scope: 'run', description: 'Vault opened' },
      { key: 'alarm_triggered', scope: 'run', description: 'Alarm triggered' },
    ],
    events: [
      {
        id: 'sealed_vault',
        title: 'The Sealed Vault',
        text: 'A blast door fills the corridor.',
        artwork: {
          kind: 'managed',
          category: 'dungeon_background',
          contentHash: 'a'.repeat(64),
          name: 'vault.webp',
        },
        choices: [
          {
            id: 'use_key',
            label: 'Use the Vault Key',
            description: 'It looks like it fits.',
            items: [{ item: 'vault_key', quantity: 1, consume: true }],
            unavailableText: 'You have no Vault Key.',
            outcome: {
              text: 'The door rolls aside.',
              tone: 'good',
              effects: [{ type: 'set_flag', flag: 'vault_opened', value: true }],
              rewards: {
                guaranteed: [
                  {
                    id: 'pay',
                    grant: { type: 'currency', currency: 'shards', amount: { min: 5, max: 5 } },
                  },
                ],
                chances: [],
                tables: [{ id: 'hoard', table: 'vault_hoard', draws: 2 }],
              },
            },
          },
          {
            id: 'pick_lock',
            label: 'Work the lock',
            check: { type: 'sp', baseChanceBasisPoints: 5500, maxSpModifierBasisPoints: 1500 },
            success: {
              text: 'It opens.',
              effects: [
                { type: 'set_flag', flag: 'vault_opened', value: true },
                { type: 'heal', basisPoints: 1000 },
              ],
            },
            failure: {
              text: 'It jams.',
              tone: 'bad',
              effects: [{ type: 'damage', basisPoints: 2500 }],
            },
          },
          {
            id: 'secret',
            label: 'Whisper the code',
            requires: { type: 'flag', flag: 'alarm_triggered', scope: 'run', equals: true },
            hideWhenUnavailable: true,
            outcome: { text: 'It hears you.', effects: [], then: { type: 'room_complete' } },
          },
          {
            id: 'leave',
            label: 'Leave it',
            outcome: { text: 'You step back.', effects: [], then: { type: 'retreat' } },
          },
        ],
      },
      {
        id: 'buried_crate',
        title: 'A Buried Crate',
        text: 'Something square under the rust.',
        choices: [{ id: 'dig', label: 'Dig it out', outcome: { text: 'Scrap.', effects: [] } }],
      },
      {
        id: 'shelved',
        title: 'A Shelved Idea',
        text: 'Used by nothing yet.',
        choices: [
          {
            id: 'go',
            label: 'Go',
            outcome: { text: '', effects: [], then: { type: 'end_run', outcome: 'completed' } },
          },
        ],
      },
    ],
    eventPools: [
      {
        id: 'scrapheap_finds',
        name: 'Scrapheap finds',
        entries: [
          { id: 'e_crate', weight: 30, eventId: 'buried_crate', oncePerRun: true },
          {
            id: 'e_vault',
            weight: 10,
            eventId: 'sealed_vault',
            oncePerRun: false,
            when: { type: 'flag', flag: 'alarm_triggered', scope: 'run', equals: false },
          },
          { id: 'e_nothing', weight: 60, nothing: true, text: 'Nothing but rust.' },
        ],
      },
    ],
    rooms: [
      {
        id: 'entrance',
        name: 'Entrance',
        extraction: true,
        actions: [
          {
            id: 'a_rest',
            type: 'rest',
            label: '',
            optional: false,
            outcomes: {},
            healBasisPoints: 3000,
          },
          {
            id: 'a_find',
            type: 'event',
            label: '',
            optional: false,
            outcomes: {},
            source: { kind: 'pool', poolId: 'scrapheap_finds' },
          },
          {
            id: 'a_door',
            type: 'event',
            label: 'The door',
            optional: false,
            when: { type: 'flag', flag: 'alarm_triggered', scope: 'run', equals: false },
            next: { type: 'room_complete' },
            outcomes: { nothing: { type: 'next' } },
            source: { kind: 'event', eventId: 'sealed_vault' },
          },
        ],
      },
    ],
  };
}

const holds = (
  condition: DungeonCondition | undefined,
  scenario: DungeonEventScenario,
): boolean => {
  if (!condition) return true;
  if (condition.type === 'flag')
    return scenario.flags.includes(condition.flag) === (condition.equals ?? true);
  if (condition.type === 'room_completed')
    return scenario.completedRooms.includes(condition.roomId);
  if (condition.type === 'not') return !holds(condition.condition, scenario);
  const parts = condition.conditions.map((c) => holds(c, scenario));
  return condition.type === 'all' ? parts.every(Boolean) : parts.some(Boolean);
};
const NO_RUN: DungeonEventScenario = {
  flags: [],
  completedRooms: [],
  seenEvents: [],
  inventory: {},
  currentSp: 200,
  canTurnBack: true,
};
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

export function fakeInsight(
  definition: DungeonDefinition,
  scenario: DungeonEventScenario = NO_RUN,
): Required<Pick<DungeonValidation, 'eventPools' | 'eventPreviews'>> {
  const odds = (
    pool: NonNullable<DungeonDefinition['eventPools']>[number],
    ruled: boolean,
  ): DungeonEventPoolOdds => {
    const judged = pool.entries.map((entry) => {
      const reason =
        ruled && !holds(entry.when, scenario)
          ? ('condition' as const)
          : ruled &&
              'eventId' in entry &&
              entry.oncePerRun !== false &&
              scenario.seenEvents.includes(entry.eventId)
            ? ('already_seen' as const)
            : null;
      return {
        id: entry.id,
        eventId: 'eventId' in entry ? entry.eventId : null,
        weight: entry.weight,
        eligible: reason === null,
        reason,
      };
    });
    const totalWeight = judged.reduce((sum, e) => sum + (e.eligible ? e.weight : 0), 0);
    const entries = judged.map((e) => ({
      ...e,
      probability: e.eligible ? e.weight / totalWeight : 0,
    }));
    return {
      totalWeight,
      entries,
      nothingProbability:
        totalWeight === 0
          ? 1
          : entries.reduce((sum, e) => sum + (e.eventId === null ? e.probability : 0), 0),
    };
  };
  const chance = (base: number, influence: number, sp: number) =>
    clamp(base + Math.trunc((influence * clamp(sp - 200, -150, 150)) / 150), 500, 9500);
  return {
    eventPools: (definition.eventPools ?? []).map((pool) => ({
      poolId: pool.id,
      base: odds(pool, false),
      scenario: odds(pool, true),
    })),
    eventPreviews: (definition.events ?? []).map((event) => ({
      eventId: event.id,
      choices: event.choices.map((choice) => {
        const items = (choice.items ?? []).map((item) => ({
          item: item.item,
          quantity: item.quantity ?? 1,
          consume: item.consume ?? false,
          owned: scenario.inventory[item.item] ?? 0,
        }));
        const walksAway = [choice.outcome, choice.success, choice.failure].some(
          (o) => o?.then?.type === 'retreat',
        );
        const unavailableReason = !holds(choice.requires, scenario)
          ? ('requires' as const)
          : items.some((i) => i.owned < i.quantity)
            ? ('items' as const)
            : walksAway && !scenario.canTurnBack
              ? ('no_way_back' as const)
              : null;
        const influence = choice.check?.maxSpModifierBasisPoints ?? 1500;
        const base = choice.check?.baseChanceBasisPoints ?? 0;
        return {
          id: choice.id,
          label: choice.label,
          description: choice.description ?? '',
          available: unavailableReason === null,
          unavailableReason,
          unavailableText: choice.unavailableText ?? '',
          check: choice.check
            ? {
                chanceBasisPoints: chance(base, influence, scenario.currentSp),
                sp: scenario.currentSp,
              }
            : null,
          items,
          consumesOnSelect: items.some((i) => i.consume),
          walksAway,
          hidden: unavailableReason !== null && choice.hideWhenUnavailable === true,
          chances: choice.check
            ? {
                weakest: chance(base, influence, 50),
                average: chance(base, influence, 200),
                strongest: chance(base, influence, 350),
              }
            : null,
        };
      }),
    })),
  };
}
