import { describe, expect, it, vi } from 'vitest';
import { DungeonDefinitionSchema } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { buildDungeonPackage, dungeonContentHash } from '../../../src/modules/dungeons/package/dungeonPackage';
import {
  DungeonImportApplySchema,
  importHash,
  readImportPackage,
  createDungeonImportService,
  type DungeonImportDeps,
} from '../../../src/modules/dungeons/package/dungeonImportService';
import { testDungeonInput, TEST_ENEMIES } from '../../helpers/dungeonFixtures';
const pkg = () =>
  buildDungeonPackage({
    definition: DungeonDefinitionSchema.parse(testDungeonInput('unit_import')),
    source: {
      environment: 'staging',
      origin: 'draft',
      draftRevision: 1,
      publishedRevision: null,
    },
    enemies: new Map(TEST_ENEMIES.map((e) => [e.key, e])),
  });
describe('dungeon import boundary', () => {
  it('rejects colliding manifests before planning enemy decisions or entering the write transaction', async () => {
    const definition = DungeonDefinitionSchema.parse(testDungeonInput('collision_import'));
    for (const room of definition.rooms) room.actions = [];
    definition.rooms[0]!.actions = [{
      id: 'fight', type: 'combat', waves: [{ enemy: { key: 'a\nb' } }, { enemy: { key: 'c' } }],
    } as never];
    const malformed = buildDungeonPackage({
      definition,
      source: { environment: 'staging', origin: 'draft', draftRevision: 1, publishedRevision: null },
    });
    malformed.dependencies.enemies = ['a', 'b\nc'].map((key) => ({ key, contentHash: null }));
    malformed.bundled.enemies = [{ ...TEST_ENEMIES[0]!, key: 'a' }];
    const transaction = vi.fn(async (work: (tx: object) => Promise<unknown>) => work({}));
    const importer = createDungeonImportService({
      db: { transaction } as unknown as DungeonImportDeps['db'],
      reservedKeys: new Set(),
      getRegions: () => [],
      resolveManagedArtwork: async () => ({}),
    });
    // A valid plan would try to query this deliberately empty transaction.
    const plan = await importer.planImport(malformed);
    expect(plan).toMatchObject({ validPackage: false, target: null, planHash: null, enemies: [], publishable: false });
    expect(plan.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['package_dependencies_mismatch', 'package_bundle_unreferenced']),
    );
    transaction.mockClear();
    await expect(importer.applyImport({
      package: malformed,
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      expectedPlanHash: `sha256:${'a'.repeat(64)}`,
      expectedRevision: null,
      decisions: {
        dungeon: 'create', enemies: { a: 'create', 'b\nc': 'leave_missing' }, allowMissingDependencies: true,
      },
    }, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('verifies schemas, content hashes and recomputed manifests', () => {
    const valid = pkg();
    expect(readImportPackage(JSON.stringify(valid)).ok).toBe(true);
    expect(
      readImportPackage({
        ...valid,
        contentHash: `sha256:${'0'.repeat(64)}`,
      }).issues.some((i) => i.code === 'package_hash_mismatch'),
    ).toBe(true);
    expect(readImportPackage({ ...valid, schemaVersion: 100 }).ok).toBe(false);
    expect(
      readImportPackage({
        ...valid,
        dependencies: { ...valid.dependencies, enemies: [] },
      }).issues.some((i) => i.code === 'package_dependencies_mismatch'),
    ).toBe(true);
    expect(readImportPackage('{')).toMatchObject({ ok: false, package: null });
  });
  it('hashes layout and bundle separately from gameplay and canonicalizes formatting', () => {
    const a = pkg(),
      b = structuredClone(a);
    b.editor.layout.rooms.gate = { x: 123, y: 456 };
    expect(importHash(a)).not.toBe(importHash(b));
    expect(dungeonContentHash(a.dungeon)).toBe(dungeonContentHash(b.dungeon));
    expect(importHash({ a: 1, b: 2 })).toBe(importHash({ b: 2, a: 1 }));
    b.bundled.enemies[0]!.attack++;
    expect(importHash(a)).not.toBe(importHash(b));
  });
  it('requires explicit decisions, revision, reviewed plan and a UUID retry key', () => {
    const input = {
      package: pkg(),
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      expectedPlanHash: `sha256:${'a'.repeat(64)}`,
      expectedRevision: null,
      decisions: {
        dungeon: 'create',
        enemies: {},
        allowMissingDependencies: false,
      },
    };
    expect(DungeonImportApplySchema.safeParse(input).success).toBe(true);
    expect(DungeonImportApplySchema.safeParse({ ...input, decisions: undefined }).success).toBe(false);
    expect(
      DungeonImportApplySchema.safeParse({
        ...input,
        decisions: { ...input.decisions, enemies: { grunt: 'overwrite' } },
      }).success,
    ).toBe(false);
    expect(DungeonImportApplySchema.safeParse({ ...input, actor: 'forged' }).success).toBe(false);
  });
  it('bounds deeply nested and cyclic input before recursive validation', () => {
    let value: unknown = {};
    for (let i = 0; i < 1000; i++) value = { value };
    expect(readImportPackage(value)).toMatchObject({
      ok: false,
      package: null,
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(readImportPackage(cycle).ok).toBe(false);
  });
});
