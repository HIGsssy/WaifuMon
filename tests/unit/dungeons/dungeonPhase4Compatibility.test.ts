import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DungeonDefinitionSchema } from '../../../src/modules/dungeons/content/dungeonDefinition';
import {
  buildDungeonPackage,
  serializeDungeonPackage,
  dungeonContentHash,
} from '../../../src/modules/dungeons/package/dungeonPackage';
import { resolveDungeonRewardDependencies } from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import {
  testDungeon,
  TEST_FIGHTER,
  testDependencies,
} from '../../helpers/dungeonFixtures';
import {
  eventDungeon,
  eventRewardSnapshot,
} from '../../helpers/dungeonEventFixtures';
import {
  createDungeonSandbox,
  autoPlayDungeonSandbox,
} from '../../../src/modules/dungeons/engine/sandbox';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
describe('P4B1 legacy goldens recorded on untouched e7f8f0b', () => {
  it('preserves exact v1/v2/v3 bytes and hashes', () => {
    const v1 = testDungeon();
    const v2 = DungeonDefinitionSchema.parse({
      key: 'legacy',
      name: 'Legacy',
      entranceRoomId: 'exit',
      rooms: [
        {
          id: 'exit',
          kind: 'exit',
          actions: [
            {
              id: 'gift',
              type: 'reward',
              rewards: {
                chances: [],
                tables: [],
                guaranteed: [
                  {
                    id: 'bux',
                    grant: {
                      type: 'currency',
                      currency: 'waifubux',
                      amount: { min: 2, max: 3 },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const v3 = eventDungeon();
    const v2Snapshot = resolveDungeonRewardDependencies(v2, {
      lootTables: new Map(),
      items: new Map(),
      resolveEquipmentSelector: () => [],
    }).snapshot!;
    for (const [d, rewardSnapshot] of [
      [v1, undefined],
      [v2, v2Snapshot],
      [v3, eventRewardSnapshot(v3)],
    ] as const) {
      const pkg = buildDungeonPackage({
        definition: d,
        rewardSnapshot,
        packageId: '00000000-0000-4000-8000-000000000004',
        exportedAt: new Date('2026-10-12T00:00:00Z'),
        source: {
          environment: 'test',
          origin: 'draft',
          draftRevision: 1,
          publishedRevision: null,
        },
      });
      const expected = [
        [
          'sha256:df17d7e4b16b928a446973b1876d50e90a3af02501f0184f7c07968521855d5f',
          '173f30fe6e6fd83bbaa72775a6c8da965c00aa24b466492743908c3c90270a46',
        ],
        [
          'sha256:aab894aa1a46c54b3b81c2b8aae5b1c59d1a30fa2861eefcc95a990f72efaf54',
          'c58d7d15611e34cd33103cd13d4f00da028c7df1ace6c710d7e1cc5a3919c38c',
        ],
        [
          'sha256:ad1ee17747a62ec6afb7cd3d2bfc0c04ebb331f772f02526a024ae7017031ae6',
          '5859333e99ce76c96fc02184bf4048b9ca3a76f6aee1e2532ad296445473f511',
        ],
      ][pkg.schemaVersion - 1]!;
      expect([
        dungeonContentHash(d),
        sha(serializeDungeonPackage(pkg)),
      ]).toEqual(expected);
      expect(d).not.toHaveProperty('speciesPools');
    }
  });
  it('preserves the full legacy engine state, effects and log', async () => {
    const v1 = testDungeon();
    const sandbox = createDungeonSandbox({
      definition: v1,
      dependencies: testDependencies(),
      fighter: TEST_FIGHTER,
      seed: 456,
    });
    await autoPlayDungeonSandbox(sandbox);
    expect(sandbox.state).not.toHaveProperty('encounters');
    expect(
      sha(
        JSON.stringify({
          state: sandbox.state,
          effects: sandbox.effects,
          log: sandbox.log,
        }),
      ),
    ).toBe('baae74c6fc57c5e8110844fec90ea72ca196a156fd6ab169dbdc1732eac4c1b0');
  });
});
