/**
 * Pure dungeon fixtures: a small dungeon that exercises every Phase 1A
 * feature, the enemies it names and a fighter that can finish it. No database.
 */
import { NO_DAMAGE_VARIANCE } from '../../src/modules/combat/combatMath';
import type { CombatRules } from '../../src/modules/combat/combatTypes';
import { CombatEnemyDefinitionSchema, type CombatEnemyDefinition } from '../../src/modules/combat/enemyDefinitions';
import {
  DungeonDefinitionSchema,
  type DungeonDefinition,
  type DungeonDefinitionInput,
} from '../../src/modules/dungeons/content/dungeonDefinition';
import { createDungeonSandbox, type DungeonSandbox, type DungeonSandboxOptions } from '../../src/modules/dungeons/engine/sandbox';
import type { EngineDependencies, EngineFighter } from '../../src/modules/dungeons/engine/types';

export const CURRENCY = 'ascension_currency';
/** What the starter build fights with. */
export const STARTER = { attack: 83, defense: 65, maxHp: 370 } as const;
export const TEST_FIGHTER: EngineFighter = { waifuId: 1, name: 'Nebula Nurse', ...STARTER };
/** Exact HP in assertions: no damage variance. */
export const FIXED_RULES: Partial<CombatRules> = { damageVariance: NO_DAMAGE_VARIANCE };

const enemy = (over: Partial<CombatEnemyDefinition> & { key: string }): CombatEnemyDefinition =>
  CombatEnemyDefinitionSchema.parse({ name: over.key, attack: 1, defense: 0, hp: 10, enabled: true, ...over });

export const TEST_ENEMIES = [
  // The starter build wins in two hits and takes one: 36 damage.
  enemy({ key: 'grunt', name: 'Grunt', attack: 60, defense: 0, hp: 150, artworkPath: 'combat/enemies/grunt.webp' }),
  // Two hits, one taken: 36.
  enemy({ key: 'sentinel', name: 'Sentinel', attack: 60, defense: 0, hp: 160 }),
  // Three hits, two taken: 72.
  enemy({ key: 'warden', name: 'Warden', attack: 60, defense: 0, hp: 170 }),
  // Four hits, three taken: 108.
  enemy({ key: 'overlord', name: 'Overlord', attack: 60, defense: 0, hp: 300 }),
  // Cannot be beaten.
  enemy({ key: 'brute', name: 'Brute', attack: 100_000, defense: 0, hp: 1_000_000 }),
  // Neither side can finish the other inside the round cap.
  enemy({ key: 'wall', name: 'Wall', attack: 1, defense: 1_000_000, hp: 1_000_000 }),
];

export function testDependencies(): EngineDependencies {
  return { enemies: Object.fromEntries(TEST_ENEMIES.map((e) => [e.key, e])), rewardTables: {} };
}

/**
 * The test dungeon.
 *
 *   gate ──c_main──▶ pump_room ──c_pump_bulk──▶ bulkhead ──c_boss (needs valve_opened)──▶ den (exit)
 *     │  ▲                ▲                        │  ▲
 *   c_side c_back         └──────c_bulk_pump───────┘  │
 *     ▼  │                                            │
 *   locker_room ───────────────c_locker_bulk──────────┘
 *
 *   gate         fight (2 waves: grunt, then a pooled draw) → 2 currency
 *   pump_room    fight (sentinel) → optional rest → sets valve_opened
 *   locker_room  optional 5-currency cache → sets found_keycard
 *   bulkhead     gate on found_keycard (blocked: skip the vault) → 7-currency
 *                vault → fight (warden). Extraction point.
 *   den          boss (overlord) → 10 currency. Exit.
 *
 * The boss door needs the valve, which only the pump room opens — so the
 * locker route has to double back through `c_bulk_pump`.
 */
export function testDungeonInput(key = 'test_tunnels'): DungeonDefinitionInput {
  return {
    key,
    name: 'Test Tunnels',
    description: 'For tests.',
    // Where every test player starts (`DEFAULT_REGION`).
    availableRegions: ['waifu-valley'],
    entranceRoomId: 'gate',
    settings: { progressionCurrency: CURRENCY, defeatCurrencyRetentionBasisPoints: 2500 },
    flags: [
      { key: 'valve_opened', scope: 'run' },
      { key: 'found_keycard', scope: 'run' },
    ],
    rooms: [
      {
        id: 'gate',
        name: 'Gate',
        actions: [
          {
            id: 'guards',
            type: 'combat',
            waves: [
              { enemy: { key: 'grunt' } },
              { enemy: { pool: [{ key: 'grunt', weight: 3 }, { key: 'sentinel', weight: 1 }] } },
            ],
          },
          { id: 'pay', type: 'reward', reward: { currency: { min: 2, max: 2 } } },
        ],
      },
      {
        id: 'pump_room',
        name: 'Pump Room',
        actions: [
          { id: 'bruiser', type: 'combat', waves: [{ enemy: { key: 'sentinel' } }] },
          { id: 'breather', type: 'rest', optional: true, healBasisPoints: 2500 },
          { id: 'valve', type: 'set_flag', flag: 'valve_opened' },
        ],
      },
      {
        id: 'locker_room',
        name: 'Locker Room',
        actions: [
          { id: 'locker', type: 'reward', optional: true, reward: { currency: { min: 5, max: 5 } } },
          { id: 'keycard', type: 'set_flag', flag: 'found_keycard' },
        ],
      },
      {
        id: 'bulkhead',
        name: 'Bulkhead',
        extraction: true,
        actions: [
          {
            id: 'vault_door',
            type: 'gate',
            requires: { type: 'flag', flag: 'found_keycard' },
            blockedText: 'The vault wants a keycard.',
            outcomes: { blocked: { type: 'action', actionId: 'sentry' } },
          },
          { id: 'vault', type: 'reward', reward: { currency: { min: 7, max: 7 } } },
          { id: 'sentry', type: 'combat', waves: [{ enemy: { key: 'warden' } }] },
        ],
      },
      {
        id: 'den',
        name: 'The Den',
        kind: 'exit',
        actions: [
          { id: 'overlord', type: 'boss', waves: [{ enemy: { key: 'overlord' } }] },
          { id: 'hoard', type: 'reward', reward: { currency: { min: 10, max: 10 } } },
        ],
      },
    ],
    connections: [
      { id: 'c_main', from: 'gate', to: 'pump_room' },
      { id: 'c_side', from: 'gate', to: 'locker_room', label: 'Side door' },
      { id: 'c_back', from: 'locker_room', to: 'gate', kind: 'shortcut' },
      { id: 'c_locker_bulk', from: 'locker_room', to: 'bulkhead' },
      { id: 'c_pump_bulk', from: 'pump_room', to: 'bulkhead' },
      { id: 'c_bulk_pump', from: 'bulkhead', to: 'pump_room', label: 'Back to the pumps' },
      {
        id: 'c_boss',
        from: 'bulkhead',
        to: 'den',
        requires: { type: 'flag', flag: 'valve_opened' },
        lockedText: 'The bulkhead is sealed.',
      },
    ],
  };
}

export function testDungeon(key?: string, patch: (input: DungeonDefinitionInput) => void = () => {}): DungeonDefinition {
  const input = testDungeonInput(key);
  patch(input);
  return DungeonDefinitionSchema.parse(input);
}

/** A one-room dungeon around the given actions, for rule-by-rule tests. */
export function singleRoomDungeon(
  actions: NonNullable<DungeonDefinitionInput['rooms'][number]['actions']>,
  patch: (input: DungeonDefinitionInput) => void = () => {},
): DungeonDefinition {
  const input: DungeonDefinitionInput = {
    key: 'one_room',
    name: 'One Room',
    availableRegions: ['waifu-valley'],
    entranceRoomId: 'hall',
    settings: { progressionCurrency: CURRENCY, defeatCurrencyRetentionBasisPoints: 2500 },
    flags: [{ key: 'lever', scope: 'run' }],
    rooms: [
      { id: 'hall', name: 'Hall', actions },
      { id: 'out', name: 'Out', kind: 'exit' },
    ],
    connections: [{ id: 'c_out', from: 'hall', to: 'out' }],
  };
  patch(input);
  return DungeonDefinitionSchema.parse(input);
}

export function testSandbox(definition: DungeonDefinition, options: Partial<DungeonSandboxOptions> = {}): DungeonSandbox {
  return createDungeonSandbox({
    definition,
    dependencies: testDependencies(),
    fighter: TEST_FIGHTER,
    seed: 1,
    combatRules: FIXED_RULES,
    ...options,
  });
}
