/** Fixed metadata and fixture byte digests independently generated from untouched HEAD 4799c61. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { singleRoomDungeon } from '../../helpers/dungeonFixtures';
import { eventDungeon, eventRewardSnapshot } from '../../helpers/dungeonEventFixtures';
import { resolveDungeonRewardDependencies } from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { buildDungeonPackage, serializeDungeonPackage } from '../../../src/modules/dungeons/package/dungeonPackage';
const definitions = [
  singleRoomDungeon([]),
  singleRoomDungeon([
    {
      id: 'reward',
      type: 'reward',
      rewards: {
        guaranteed: [
          {
            id: 'coins',
            grant: {
              type: 'currency',
              currency: 'waifubux',
              amount: { min: 7, max: 7 },
            },
          },
        ],
        chances: [],
        tables: [],
      },
    },
  ]),
  eventDungeon(),
];
const expected = [
  {
    bytes: 1808,
    sha256: 'e89c726dd27131cf2632c147816df4fe19f6c76872c38675aa13f135e620a037',
    contentHash: 'sha256:035a5301cb6f22751ef572b6c7d6a34f4b486e7bf6c4df2ed0f06f4444aebe2a',
  },
  {
    bytes: 2818,
    sha256: '43707b5b089c95a6db778e4df264d9de1a0f10dc3b350701c5509eded88ce90c',
    contentHash: 'sha256:e7fece9ee2b03052ce9d9239b3e2af4ad589b993c58eeee2ecd52a3fb4e81520',
  },
  {
    bytes: 14479,
    sha256: '1fd06eaf6f2eced7b17576689de79d744b86987e91359c586e002defe0551309',
    contentHash: 'sha256:ad1ee17747a62ec6afb7cd3d2bfc0c04ebb331f772f02526a024ae7017031ae6',
  },
];
describe('legacy package byte compatibility', () => {
  it.each([0, 1, 2])('retains fixture %i bytes and definition hash from pre-P4D1 HEAD', (index) => {
    const definition = definitions[index]!;
    const rewardSnapshot =
      index === 2
        ? eventRewardSnapshot(definition)
        : (resolveDungeonRewardDependencies(definition, {}).snapshot ?? undefined);
    const pkg = buildDungeonPackage({
      definition,
      rewardSnapshot,
      source: {
        environment: 'legacy',
        origin: 'draft',
        draftRevision: 1,
        publishedRevision: null,
      },
      packageId: '00000000-0000-4000-8000-000000000001',
      exportedAt: new Date('2026-10-14T00:00:00Z'),
    });
    const bytes = serializeDungeonPackage(pkg);
    expect(pkg.schemaVersion).toBe(index + 1);
    expect({
      bytes: Buffer.byteLength(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentHash: pkg.contentHash,
    }).toEqual(expected[index]);
    expect(pkg).not.toHaveProperty('dependenciesHash');
    expect(pkg).not.toHaveProperty('integrityHash');
  });
});
