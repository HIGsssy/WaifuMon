/**
 * A small event dungeon for the Phase 3 engine and validation tests: a sealed
 * vault (a handcrafted event), a Scrapheap pool rolled in two rooms, and a
 * path a choice unlocks. Pure — no database.
 *
 *   hall ──c_vault──▶ vault ──c_heap──▶ heap ──c_lift (needs vault_opened)──▶ lower (exit)
 *     ▲                 │                 │
 *     └─────c_back──────┘                 └──c_out──▶ out (exit)
 *
 *   hall   entrance; a draw from the Scrapheap pool
 *   vault  the Sealed Vault, then a breather that only exists once it is open
 *   heap   a second draw from the same pool
 */
import { DungeonDefinitionSchema, type DungeonDefinition, type DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonLootTableBodySchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { resolveDungeonRewardDependencies, type DungeonRewardSnapshot } from '../../src/modules/dungeons/content/dungeonRewardSnapshot';
import type { DungeonValidationContext } from '../../src/modules/dungeons/validation/dungeonValidation';
import type { DungeonSandboxOptions } from '../../src/modules/dungeons/engine/sandbox';
import type { DungeonEngineContext, EngineFighter } from '../../src/modules/dungeons/engine/types';
import { CURRENCY, FIXED_RULES, TEST_FIGHTER, testDependencies } from './dungeonFixtures';

export const EVENT_FIGHTER: EngineFighter = { ...TEST_FIGHTER, currentSp: 200 };

export const VAULT_HOARD = DungeonLootTableBodySchema.parse({
  guaranteed: [{ id: 'bolts', grant: { type: 'item', item: 'scrap_parts', quantity: { min: 2, max: 2 } } }],
  chances: [],
  pools: [],
});

const shards = (id: string, amount: number) => ({ id, grant: { type: 'currency' as const, currency: 'shards' as const, amount: { min: amount, max: amount } } });
const carryOn = (text: string) => ({ id: 'carry_on', label: 'Carry on', outcome: { text } });

export function eventDungeonInput(key = 'event_halls'): DungeonDefinitionInput {
  return {
    key,
    name: 'Event Halls',
    availableRegions: ['waifu-valley'],
    entranceRoomId: 'hall',
    settings: { progressionCurrency: CURRENCY, defeatCurrencyRetentionBasisPoints: 5000 },
    flags: [
      { key: 'vault_opened', scope: 'run' },
      { key: 'alarm_triggered', scope: 'run' },
    ],
    events: [
      {
        id: 'sealed_vault',
        title: 'The Sealed Vault',
        text: 'A blast door fills the corridor.',
        choices: [
          {
            id: 'use_key',
            label: 'Use the Vault Key',
            items: [{ item: 'vault_key', quantity: 1, consume: true }],
            unavailableText: 'You have no Vault Key.',
            outcome: {
              text: 'The door rolls aside.',
              tone: 'good',
              effects: [{ type: 'set_flag', flag: 'vault_opened', value: true }],
              rewards: { guaranteed: [shards('pay', 5)], chances: [], tables: [{ id: 'hoard', table: 'vault_hoard', draws: 1 }] },
            },
          },
          {
            id: 'pick_lock',
            label: 'Work the lock',
            check: { type: 'sp', baseChanceBasisPoints: 5500 },
            success: {
              text: 'It opens.',
              effects: [{ type: 'set_flag', flag: 'vault_opened', value: true }, { type: 'heal', basisPoints: 1000 }],
              rewards: { guaranteed: [shards('pay', 3)], chances: [], tables: [] },
            },
            failure: { text: 'The mechanism jams.', tone: 'bad', effects: [{ type: 'set_flag', flag: 'alarm_triggered', value: true }] },
          },
          {
            id: 'force',
            label: 'Force it',
            outcome: { text: 'It gives.', effects: [{ type: 'damage', basisPoints: 2500 }, { type: 'set_flag', flag: 'vault_opened', value: true }] },
          },
          {
            id: 'secret',
            label: 'Whisper the code',
            requires: { type: 'flag', flag: 'alarm_triggered' },
            hideWhenUnavailable: true,
            outcome: { text: 'It hears you.', effects: [{ type: 'set_flag', flag: 'vault_opened', value: true }] },
          },
          { id: 'leave', label: 'Leave it', outcome: { text: 'You step back.', then: { type: 'retreat' } } },
        ],
      },
      {
        id: 'buried_crate',
        title: 'A Buried Crate',
        text: 'Something square under the rust.',
        choices: [
          { id: 'dig', label: 'Dig it out', outcome: { text: 'Scrap, mostly.', rewards: { guaranteed: [shards('pay', 2)], chances: [], tables: [] } } },
          { id: 'leave', label: 'Come back later', outcome: { then: { type: 'retreat' } } },
        ],
      },
      {
        id: 'sparking_drone',
        title: 'A Sparking Drone',
        text: 'It twitches.',
        choices: [
          { id: 'salvage', label: 'Salvage it', outcome: { text: 'It bites.', effects: [{ type: 'damage', basisPoints: 9900 }] } },
          { id: 'shut_down', label: 'Shut it down and go home', outcome: { text: 'Enough for today.', then: { type: 'end_run', outcome: 'completed' } } },
        ],
      },
      {
        id: 'scavenger_trader',
        title: 'A Scavenger',
        text: 'She has things.',
        choices: [carryOn('She nods.')],
      },
      // In the library, used by nothing: its rewards must not be a dependency of the dungeon.
      {
        id: 'shelved_idea',
        title: 'A Shelved Idea',
        text: 'Not used yet.',
        choices: [{ id: 'take', label: 'Take it', outcome: { rewards: { guaranteed: [], chances: [], tables: [{ id: 'gone', table: 'unfinished_table', draws: 1 }] } } }],
      },
    ],
    eventPools: [
      {
        id: 'scrapheap_finds',
        name: 'Scrapheap finds',
        entries: [
          { id: 'e_crate', weight: 30, eventId: 'buried_crate' },
          { id: 'e_drone', weight: 20, eventId: 'sparking_drone' },
          { id: 'e_trader', weight: 10, eventId: 'scavenger_trader', when: { type: 'flag', flag: 'alarm_triggered', equals: false } },
          { id: 'e_nothing', weight: 40, nothing: true, text: 'Nothing but rust.' },
        ],
      },
    ],
    rooms: [
      { id: 'hall', name: 'Hall', actions: [{ id: 'find', type: 'event', source: { kind: 'pool', poolId: 'scrapheap_finds' } }] },
      {
        id: 'vault',
        name: 'Vault Door',
        actions: [
          { id: 'door', type: 'event', source: { kind: 'event', eventId: 'sealed_vault' } },
          { id: 'breather', type: 'rest', healBasisPoints: 1000, when: { type: 'flag', flag: 'vault_opened' } },
        ],
      },
      { id: 'heap', name: 'Heap', actions: [{ id: 'find', type: 'event', source: { kind: 'pool', poolId: 'scrapheap_finds' } }] },
      { id: 'lower', name: 'Lower Vault', kind: 'exit' },
      { id: 'out', name: 'Out', kind: 'exit' },
    ],
    connections: [
      { id: 'c_vault', from: 'hall', to: 'vault' },
      { id: 'c_back', from: 'vault', to: 'hall' },
      { id: 'c_heap', from: 'vault', to: 'heap' },
      { id: 'c_lift', from: 'heap', to: 'lower', requires: { type: 'flag', flag: 'vault_opened' }, lockedText: 'The lift has no power.' },
      { id: 'c_out', from: 'heap', to: 'out' },
    ],
  };
}

export function eventDungeon(patch: (input: DungeonDefinitionInput) => void = () => {}, key?: string): DungeonDefinition {
  const input = eventDungeonInput(key);
  patch(input);
  return DungeonDefinitionSchema.parse(input);
}

/** The catalogues the event dungeon needs. `unfinished_table` is deliberately absent. */
export function eventValidationContext(): DungeonValidationContext {
  return {
    lootTables: new Map([['vault_hoard', { name: 'Vault hoard', body: VAULT_HOARD, archivedAt: null, revision: 1 }]]),
    items: new Map([
      ['scrap_parts', { name: 'Scrap Parts', category: 'material', enabled: true, maxOwned: null }],
      ['vault_key', { name: 'Vault Key', category: 'key', enabled: true, maxOwned: null }],
    ]),
    currencies: new Map([[CURRENCY, { enabled: true }]]),
  };
}

export function eventRewardSnapshot(definition: DungeonDefinition): DungeonRewardSnapshot {
  const snapshot = resolveDungeonRewardDependencies(definition, eventValidationContext()).snapshot;
  if (!snapshot) throw new Error('the event dungeon fixture has an unresolved reward dependency');
  return snapshot;
}

export function eventContext(definition: DungeonDefinition, over: Partial<DungeonEngineContext> = {}): DungeonEngineContext {
  return {
    definition,
    dependencies: testDependencies(),
    // A dungeon with no reward bundle has no snapshot to pin.
    rewards: 'rewards' in over ? over.rewards : eventRewardSnapshot(definition),
    fighter: EVENT_FIGHTER,
    runKey: 'test',
    combatRules: FIXED_RULES,
    ...over,
  };
}

export function eventSandboxOptions(definition: DungeonDefinition, over: Partial<DungeonSandboxOptions> = {}): DungeonSandboxOptions {
  return {
    definition,
    dependencies: testDependencies(),
    rewards: eventRewardSnapshot(definition),
    fighter: EVENT_FIGHTER,
    seed: 1,
    combatRules: FIXED_RULES,
    ...over,
  };
}
