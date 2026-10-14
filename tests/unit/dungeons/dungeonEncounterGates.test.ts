/** Exercise the real service boundaries without connecting to a DB or applying migrations. */
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/db/client';
import { DungeonDefinitionSchema } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { createDungeonContentService } from '../../../src/modules/dungeons/dungeonContentService';

const definition = DungeonDefinitionSchema.parse({
  key: 'gated',
  name: 'Gated',
  entranceRoomId: 'exit',
  rooms: [
    {
      id: 'exit',
      kind: 'exit',
      actions: [
        {
          id: 'meet',
          type: 'wild_encounter',
          source: { kind: 'species', species: 'android' },
          intro: 'Hello.',
          capture: {},
        },
      ],
    },
  ],
});
/** Read responses only; fail immediately if a gate lets a gameplay write through. */
function readOnlyDb(responses: unknown[][]) {
  const insert = vi.fn(() => {
    throw new Error('Unexpected insert past encounter gate');
  });
  const update = vi.fn(() => {
    throw new Error('Unexpected update past encounter gate');
  });
  const execute = vi.fn(async () => []);
  const db = {
    insert,
    update,
    execute,
    select: vi.fn(() => {
      if (!responses.length)
        throw new Error('Unexpected catalogue query past encounter gate');
      const rows = responses.shift()!;
      const chain: unknown = new Proxy(
        {},
        {
          get: (_target, property) =>
            property === 'then'
              ? Promise.resolve(rows).then.bind(Promise.resolve(rows))
              : () => chain,
        },
      );
      return chain;
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { db: db as unknown as Db, insert, update };
}
const row = {
  dungeonKey: 'gated',
  draftRevision: 1,
  publishedRevisionId: null,
  draft: definition,
  layout: {},
};

describe('encounter package gate', () => {
  // Publication, rollback and live play opened in P4B2B (see
  // tests/integration/dungeonEncountersLive.test.ts). Export stays closed
  // until package v4 can carry species and charm dependencies.
  it('blocks export before any revision, inventory or ownership write', async () => {
    const { db, insert, update } = readOnlyDb([[row]]);
    const enemies = { definitions: vi.fn(async () => []) };
    const service = createDungeonContentService({ db, enemies, getRegions: () => [] });
    await expect(service.exportPackage('gated', 'draft', 'tester')).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringMatching(/package v4/) })],
    });
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(enemies.definitions).not.toHaveBeenCalled();
  });
});
