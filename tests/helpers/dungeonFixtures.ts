/**
 * A small, self-contained dungeon zone and content catalogue for tests that
 * must not depend on shipped tuning.
 */
import type { DungeonContentCatalogue } from '../../src/modules/dungeons/dungeonGenerator';
import {
  DungeonZoneDefinitionSchema,
  type DungeonZoneDefinition,
  type DungeonZoneDefinitionInput,
} from '../../src/modules/dungeons/zoneDefinition';

const ref = (key: string, enabled = true) => [key, { key, name: key.replace(/_/g, ' '), enabled }] as const;

export function testCatalogue(overrides: { disabledEnemies?: string[]; disabledEvents?: string[] } = {}): DungeonContentCatalogue {
  const off = (key: string, list?: string[]) => !(list ?? []).includes(key);
  return {
    enemies: new Map(
      ['grunt', 'brute', 'sentinel', 'warden', 'overlord'].map((k) => ref(k, off(k, overrides.disabledEnemies))),
    ),
    events: new Map(['shrine', 'trap'].map((k) => ref(k, off(k, overrides.disabledEvents)))),
  };
}

/** The raw document — spread and override it to build a variant. */
export function testZoneInput(): DungeonZoneDefinitionInput {
  return {
    key: 'test_zone',
    name: 'Test Zone',
    description: 'For tests.',
    enabled: true,
    order: 0,
    tags: ['test'],
    generation: {
      minNodes: 6,
      maxNodes: 10,
      branching: { minBranches: 0, maxBranches: 1, chanceBasisPoints: 5000, maxLength: 2 },
      extraction: { minDepth: 3, nodeTypes: ['rest', 'exit'], minPoints: 1 },
      nodeWeights: { combat: 50, elite: 15, event: 10, reward: 10, rest: 10, miniboss: 5, exit: 0 },
      boss: { required: true },
      depthRanges: { elite: { minDepth: 2 }, miniboss: { minDepth: 3 } },
      required: [{ types: ['rest'], min: 1 }, { types: ['reward'], min: 1 }],
      limits: [{ types: ['elite'], max: 2 }, { types: ['miniboss'], max: 1 }],
      noConsecutive: ['rest', 'reward'],
      maxConsecutiveSameEnemy: 2,
    },
    pools: {
      combat: [
        { id: 'grunt', enemyKey: 'grunt', weight: 60, minDepth: 1, maxDepth: 4 },
        { id: 'brute', enemyKey: 'brute', weight: 30, minDepth: 3 },
      ],
      elite: [{ id: 'sentinel', enemyKey: 'sentinel', weight: 10 }],
      miniboss: [{ id: 'warden', enemyKey: 'warden', weight: 10 }],
      boss: [{ id: 'overlord', enemyKey: 'overlord', weight: 10 }],
      event: [
        { id: 'shrine', eventKey: 'shrine', weight: 10 },
        { id: 'trap', eventKey: 'trap', weight: 5, minDepth: 2 },
      ],
    },
    rewards: {
      defeatCurrencyRetentionBasisPoints: 2500,
      bands: [
        { id: 'early', minDepth: 1, maxDepth: 4, currency: { min: 1, max: 2 } },
        { id: 'deep', minDepth: 5, currency: { min: 3, max: 5 } },
        { id: 'boss', nodeTypes: ['boss'], currency: { min: 10, max: 10 } },
      ],
    },
  };
}

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function merge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(out[k], v);
  return out;
}

/** The test zone as a raw document with `patch` deep-merged in (arrays replace). */
export function testZoneDoc(patch?: DeepPartial<DungeonZoneDefinitionInput>): DungeonZoneDefinitionInput {
  return merge(testZoneInput(), patch) as DungeonZoneDefinitionInput;
}

/** The parsed test zone, with `patch` deep-merged in. */
export function testZone(patch?: DeepPartial<DungeonZoneDefinitionInput>): DungeonZoneDefinition {
  return DungeonZoneDefinitionSchema.parse(testZoneDoc(patch));
}

export function testValidationContext(catalogue = testCatalogue()) {
  return {
    catalogue,
    rewardTables: new Map([['loot', { enabled: true }], ['closed', { enabled: false }]]),
    currencies: new Map([['ascension_currency', { enabled: true }]]),
  };
}
