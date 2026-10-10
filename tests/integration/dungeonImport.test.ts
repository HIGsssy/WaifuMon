import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  combatEnemies,
  dungeonDefinitions,
  dungeonImportHistory,
  dungeonContentEvents,
  dungeonRevisions,
  dungeonRuns,
  rewardTables,
  artworkAssets,
} from '../../src/db/schema';
import { DungeonDefinitionSchema } from '../../src/modules/dungeons/content/dungeonDefinition';
import {
  buildDungeonPackage,
  dungeonContentHash,
  packagedEnemyHash,
  type DungeonPackage,
} from '../../src/modules/dungeons/package/dungeonPackage';
import type {
  DungeonImportApplyInput,
  DungeonImportDecisions,
} from '../../src/modules/dungeons/package/dungeonImportService';
import { CombatEnemyDefinitionSchema } from '../../src/modules/combat/enemyDefinitions';
import { DungeonImportError, DungeonInvalidError } from '../../src/shared/errors';
import { rewardTableHash } from '../../src/modules/rewardTables/rewardTableCore';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { testDungeonInput, TEST_ENEMIES } from '../helpers/dungeonFixtures';
let w: DungeonWorld;
let serial = 0;
const fresh = () => `import_${++serial}`;
function makePackage(key = fresh(), enemyKey?: string) {
  const definition = DungeonDefinitionSchema.parse(testDungeonInput(key));
  if (enemyKey)
    definition.rooms[0]!.actions = [
      {
        id: 'fight',
        label: '',
        type: 'combat',
        optional: false,
        outcomes: {},
        advance: 'confirm',
        waves: [{ enemy: { key: enemyKey } }],
      },
    ];
  const enemies = new Map(TEST_ENEMIES.map((e) => [e.key, e]));
  if (enemyKey) enemies.set(enemyKey, CombatEnemyDefinitionSchema.parse({ ...TEST_ENEMIES[0], key: enemyKey }));
  return buildDungeonPackage({
    definition,
    layout: {
      rooms: { gate: { x: 90, y: 80 } },
      viewport: { x: 10, y: 20, zoom: 1.5 },
      notes: [{ id: 'note', x: 0, y: 0, text: 'Preserved' }],
    },
    enemies,
    source: {
      environment: 'staging',
      origin: 'draft',
      draftRevision: 9,
      publishedRevision: 4,
    },
  });
}
async function reviewed(
  pkg: DungeonPackage,
  decisions?: Partial<DungeonImportDecisions>,
): Promise<DungeonImportApplyInput> {
  const plan = await w.content.planImport(pkg);
  return {
    package: pkg,
    requestId: randomUUID(),
    expectedPlanHash: plan.planHash!,
    expectedRevision: plan.target!.expectedRevision,
    decisions: {
      dungeon: plan.target!.status === 'new' ? 'create' : plan.target!.status === 'identical' ? 'unchanged' : 'replace',
      enemies: {},
      allowMissingDependencies: false,
      ...decisions,
    },
  };
}
beforeAll(async () => {
  w = await createDungeonWorld();
});
afterAll(async () => w?.cleanup());
describe('transactional dungeon imports', () => {
  it('plans without writes, creates a disabled unpublished draft with stable IDs/layout and audits once', async () => {
    const pkg = makePackage();
    const before = await w.t.db.select().from(dungeonContentEvents);
    const request = await reviewed(pkg);
    expect(await w.content.get(pkg.dungeon.key)).toBeNull();
    expect(await w.t.db.select().from(dungeonContentEvents)).toEqual(before);
    const result = await w.content.applyImport(request, 'admin');
    expect(result).toMatchObject({
      result: 'created',
      draftRevision: 1,
      replayed: false,
    });
    const detail = await w.content.get(pkg.dungeon.key);
    expect(detail).toMatchObject({
      enabled: false,
      published: null,
      draft: pkg.dungeon,
      layout: pkg.editor.layout,
    });
    const history = await w.content.importHistory(pkg.dungeon.key);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      packageId: pkg.packageId,
      sourceEnvironment: 'staging',
      actor: 'admin',
      decisions: request.decisions,
    });
    expect(history[0]!.result).not.toHaveProperty('package');
    expect((await w.content.history(pkg.dungeon.key))[0]).toMatchObject({
      action: 'imported',
      actor: 'admin',
    });
  });
  it('rejects malformed and hash-invalid packages with no writes', async () => {
    const pkg = makePackage();
    const request = await reviewed(pkg);
    request.package = { ...pkg, contentHash: `sha256:${'f'.repeat(64)}` };
    await expect(w.content.applyImport(request, 'admin')).rejects.toBeInstanceOf(DungeonImportError);
    expect(await w.content.get(pkg.dungeon.key)).toBeNull();
    expect((await w.content.planImport({ format: 'bad' })).validPackage).toBe(false);
  });
  it('requires an explicit replacement and refuses stale expected revisions and layout-only changes', async () => {
    const pkg = makePackage();
    await w.content.create(
      {
        definition: { ...pkg.dungeon, name: 'Target author' },
        layout: pkg.editor.layout,
      },
      'author',
    );
    const request = await reviewed(pkg);
    const plan = await w.content.planImport(pkg);
    expect(plan.target?.changedFields).toContain('name');
    await expect(
      w.content.applyImport({ ...request, decisions: { ...request.decisions, dungeon: 'create' } }, 'admin'),
    ).rejects.toBeInstanceOf(DungeonImportError);
    await expect(w.content.applyImport({ ...request, expectedRevision: 99 }, 'admin')).rejects.toMatchObject({
      code: 'DUNGEON_IMPORT_STALE',
    });
    await w.content.saveDraft(
      pkg.dungeon.key,
      { layout: { rooms: { gate: { x: 500, y: 800 } } }, expectedRevision: 1 },
      'other',
    );
    await expect(w.content.applyImport(request, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
    expect(await w.content.importHistory(pkg.dungeon.key)).toEqual([]);
    expect((await w.content.applyImport(await reviewed(pkg), 'admin')).result).toBe('replaced');
  });
  it('returns an exact retry receipt even after newer edits, rejects key reuse, and leaves identical re-imports unchanged', async () => {
    const pkg = makePackage();
    const request = await reviewed(pkg);
    const first = await w.content.applyImport(request, 'admin');
    const identical = await w.content.applyImport(await reviewed(pkg), 'admin');
    expect(identical).toMatchObject({ result: 'unchanged', draftRevision: 1 });
    await w.content.saveDraft(
      pkg.dungeon.key,
      {
        definition: { ...pkg.dungeon, name: 'New local work' },
        expectedRevision: 1,
      },
      'author',
    );
    expect(await w.content.applyImport(request, 'admin')).toEqual({
      ...first,
      replayed: true,
    });
    expect((await w.content.get(pkg.dungeon.key))!.draft.name).toBe('New local work');
    await expect(
      w.content.applyImport(
        {
          ...request,
          decisions: { ...request.decisions, allowMissingDependencies: true },
        },
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_REQUEST_CONFLICT' });
    await expect(w.content.applyImport(request, 'different_admin')).rejects.toMatchObject({
      code: 'DUNGEON_IMPORT_REQUEST_CONFLICT',
    });
    expect(await w.content.importHistory(pkg.dungeon.key)).toHaveLength(2);
  });
  it('creates bundled enemies only when approved and never overwrites differing target enemies', async () => {
    const key = fresh();
    const enemyKey = `bundled_${key}`;
    const pkg = makePackage(key, enemyKey);
    const plan = await w.content.planImport(pkg);
    expect(plan.enemies.find((e) => e.key === enemyKey)?.status).toBe('missing_bundled');
    const request = await reviewed(pkg);
    await expect(w.content.applyImport(request, 'admin')).rejects.toBeInstanceOf(DungeonImportError);
    const approved = await w.content.applyImport(
      {
        ...request,
        decisions: { ...request.decisions, enemies: { [enemyKey]: 'create' } },
      },
      'admin',
    );
    expect(approved.createdEnemies).toEqual([enemyKey]);
    const [row] = await w.t.db.select().from(combatEnemies).where(eq(combatEnemies.enemyKey, enemyKey));
    expect(row).toMatchObject({
      revision: 1,
      updatedBy: 'admin',
      seedHash: null,
    });
    const changed = makePackage(fresh(), enemyKey);
    changed.bundled.enemies[0]!.attack++;
    changed.dependencies.enemies.find((e) => e.key === enemyKey)!.contentHash = packagedEnemyHash(
      changed.bundled.enemies[0]!,
    );
    expect((await w.content.planImport(changed)).enemies.find((e) => e.key === enemyKey)?.status).toBe('different');
    await expect(w.content.applyImport(await reviewed(changed), 'admin')).rejects.toBeInstanceOf(DungeonImportError);
    await w.content.applyImport(await reviewed(changed, { enemies: { [enemyKey]: 'use_existing' } }), 'admin');
    expect((await w.t.db.select().from(combatEnemies).where(eq(combatEnemies.enemyKey, enemyKey)))[0]).toEqual(row);
  });
  it('refuses a plan whose shared enemy definition changed', async () => {
    const key = fresh(),
      enemyKey = `enemy_${key}`;
    const pkg = makePackage(key, enemyKey);
    await w.content.applyImport(await reviewed(pkg, { enemies: { [enemyKey]: 'create' } }), 'admin');
    const next = makePackage(fresh(), enemyKey);
    const request = await reviewed(next);
    await w.t.db.update(combatEnemies).set({ attack: 99, revision: 2 }).where(eq(combatEnemies.enemyKey, enemyKey));
    await expect(w.content.applyImport(request, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
  });
  it('reports missing global dependencies and imports an incomplete draft only on explicit acceptance', async () => {
    const input = DungeonDefinitionSchema.parse(testDungeonInput(fresh()));
    input.availableRegions = ['missing_region'];
    input.settings.progressionCurrency = 'missing_currency';
    input.rooms[0]!.actions = [
      {
        id: 'reward',
        type: 'reward',
        label: '',
        optional: false,
        outcomes: {},
        reward: {
          rewardTable: 'missing_table',
          equipmentRewardTable: null,
          currency: { min: 1, max: 1 },
        },
      },
    ];
    const pkg = buildDungeonPackage({
      definition: input,
      enemies: new Map(TEST_ENEMIES.map((e) => [e.key, e])),
      source: {
        environment: 'staging',
        origin: 'draft',
        draftRevision: 1,
        publishedRevision: null,
      },
    });
    const plan = await w.content.planImport(pkg);
    expect(plan.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['region_missing', 'currency_missing', 'reward_table_missing']),
    );
    await expect(w.content.applyImport(await reviewed(pkg), 'admin')).rejects.toBeInstanceOf(DungeonImportError);
    const result = await w.content.applyImport(await reviewed(pkg, { allowMissingDependencies: true }), 'admin');
    expect(result.publishable).toBe(false);
    await expect(w.content.publish(pkg.dungeon.key, { expectedRevision: 1 }, 'admin')).rejects.toBeInstanceOf(
      DungeonInvalidError,
    );
  });
  it('checks item/equipment dependencies within referenced target reward tables', async () => {
    const id = `table_${fresh()}`;
    const table = {
      id,
      enabled: true,
      groups: [
        {
          id: 'loot',
          enabled: true,
          rolls: 1,
          chanceBasisPoints: 10000,
          entries: [{ itemId: 'missing_item', quantity: 1, weight: 1, enabled: true }],
          equipment: [{ definitionKeys: ['missing_gear'], weight: 1, enabled: true }],
        },
      ],
    };
    await w.t.db.insert(rewardTables).values({
      kind: 'expedition',
      tableId: id,
      enabled: true,
      definition: table,
      contentHash: rewardTableHash('expedition', table),
    });
    const definition = DungeonDefinitionSchema.parse(testDungeonInput(fresh()));
    definition.rooms[0]!.actions = [
      {
        id: 'reward',
        type: 'reward',
        optional: false,
        label: '',
        outcomes: {},
        reward: {
          rewardTable: id,
          equipmentRewardTable: null,
          currency: { min: 0, max: 0 },
        },
      },
    ];
    const pkg = buildDungeonPackage({
      definition,
      enemies: new Map(TEST_ENEMIES.map((e) => [e.key, e])),
      source: {
        environment: 'staging',
        origin: 'draft',
        draftRevision: 1,
        publishedRevision: null,
      },
    });
    expect((await w.content.planImport(pkg)).issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['item_missing', 'reward_dependency_invalid']),
    );
    await expect(
      w.content.applyImport(await reviewed(pkg, { allowMissingDependencies: true }), 'admin'),
    ).rejects.toBeInstanceOf(DungeonImportError);
  });
  it('reports malformed target reward tables as actionable dependency errors', async () => {
    const id = `malformed_${fresh()}`;
    await w.t.db.insert(rewardTables).values({ kind: 'expedition', tableId: id, enabled: true, definition: {}, contentHash: '0'.repeat(64) });
    const input = makePackage();
    input.dungeon.rooms[0]!.actions = [{ id: 'reward', type: 'reward', label: '', optional: false, outcomes: {}, reward: { rewardTable: id, equipmentRewardTable: null, currency: { min: 0, max: 0 } } }];
    const pkg = buildDungeonPackage({ definition: input.dungeon, layout: input.editor.layout, enemies: new Map(TEST_ENEMIES.map(e => [e.key, e])), source: input.source });
    const plan = await w.content.planImport(pkg);
    expect(plan.issues.some(i => i.code === 'reward_dependency_invalid' && i.severity === 'error')).toBe(true);
    await expect(w.content.applyImport(await reviewed(pkg), 'admin')).rejects.toBeInstanceOf(DungeonImportError);
    expect(await w.content.get(pkg.dungeon.key)).toBeNull();
  });
  it('rolls back enemy, draft, receipt and audit writes when the import log fails', async () => {
    const key = 'rollback_case',
      enemyKey = 'rollback_enemy';
    const pkg = makePackage(key, enemyKey);
    const request = await reviewed(pkg, { enemies: { [enemyKey]: 'create' } });
    await w.t.db.execute(
      sql`ALTER TABLE dungeon_import_history ADD CONSTRAINT fail_import_test CHECK (dungeon_key <> 'rollback_case')`,
    );
    try {
      await expect(w.content.applyImport(request, 'admin')).rejects.toBeDefined();
    } finally {
      await w.t.db.execute(sql`ALTER TABLE dungeon_import_history DROP CONSTRAINT fail_import_test`);
    }
    expect(await w.content.get(key)).toBeNull();
    expect(await w.t.db.select().from(combatEnemies).where(eq(combatEnemies.enemyKey, enemyKey))).toEqual([]);
    expect(await w.content.importHistory(key)).toEqual([]);
    expect(await w.content.history(key)).toEqual([]);
    expect((await w.content.applyImport(request, 'admin')).result).toBe('created');
  });
  it('preserves immutable published revisions and active runs during draft replacement', async () => {
    const key = fresh();
    await w.publish(testDungeonInput(key));
    const player = await w.player();
    await w.runs.start(player.playerId, key);
    const revisions = await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, key));
    const runs = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.dungeonKey, key));
    const before = await w.content.get(key);
    const pkg = makePackage(key);
    pkg.dungeon.name = 'Imported edit';
    pkg.contentHash = dungeonContentHash(pkg.dungeon);
    await w.content.applyImport(await reviewed(pkg), 'admin');
    expect(await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, key))).toEqual(revisions);
    expect(await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.dungeonKey, key))).toEqual(runs);
    expect((await w.content.get(key))!.published).toEqual(before!.published);
    expect((await w.content.get(key))!.enabled).toBe(true);
  });
  it('serializes concurrent exact retries and rejects competing stale plans', async () => {
    const pkg = makePackage();
    const request = await reviewed(pkg);
    const results = await Promise.all([
      w.content.applyImport(request, 'admin'),
      w.content.applyImport(request, 'admin'),
      w.content.applyImport(request, 'admin'),
    ]);
    expect(new Set(results.map((r) => r.importId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await w.content.importHistory(pkg.dungeon.key)).toHaveLength(1);
    const competing = makePackage();
    const a = await reviewed(competing),
      b = { ...a, requestId: randomUUID() };
    const attempts = await Promise.allSettled([w.content.applyImport(a, 'admin'), w.content.applyImport(b, 'admin')]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((attempts.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      code: 'DUNGEON_IMPORT_STALE',
    });
  });
  it('reads only own decisions for schema-valid enemy keys that also name object properties', async () => {
    const pkg = makePackage(fresh(), 'constructor');
    await w.content.applyImport(await reviewed(pkg, { enemies: { constructor: 'create' as const } }), 'admin');
    const next = makePackage(fresh(), 'constructor');
    expect((await w.content.applyImport(await reviewed(next), 'admin')).createdEnemies).toEqual([]);
  });
  it('rejects competing imports creating the same enemy for different dungeons', async () => {
    const enemy = `shared_${fresh()}`;
    const a = makePackage(fresh(), enemy),
      b = makePackage(fresh(), enemy);
    const requests = await Promise.all([
      reviewed(a, { enemies: { [enemy]: 'create' } }),
      reviewed(b, { enemies: { [enemy]: 'create' } }),
    ]);
    const attempts = await Promise.allSettled(requests.map((request) => w.content.applyImport(request, 'admin')));
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((attempts.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      code: 'DUNGEON_IMPORT_STALE',
    });
    expect(await w.t.db.select().from(combatEnemies).where(eq(combatEnemies.enemyKey, enemy))).toHaveLength(1);
    const drafts = await Promise.all([w.content.get(a.dungeon.key), w.content.get(b.dungeon.key)]);
    expect(drafts.filter(Boolean)).toHaveLength(1);
  });
  it('never invents unbundled enemies and requires explicit acceptance of the missing reference', async () => {
    const enemy = `unbundled_${fresh()}`;
    const pkg = makePackage(fresh(), enemy);
    pkg.bundled.enemies = [];
    expect((await w.content.planImport(pkg)).enemies.find(e => e.key === enemy)!.status).toBe('missing');
    await expect(
      w.content.applyImport(await reviewed(pkg, { enemies: { [enemy]: 'create' } }), 'admin'),
    ).rejects.toBeInstanceOf(DungeonImportError);
    const result = await w.content.applyImport(
      await reviewed(pkg, { enemies: { [enemy]: 'leave_missing' }, allowMissingDependencies: true }),
      'admin',
    );
    expect(result.publishable).toBe(false);
    expect(await w.t.db.select().from(combatEnemies).where(eq(combatEnemies.enemyKey, enemy))).toEqual([]);
    await expect(w.content.publish(pkg.dungeon.key, { expectedRevision: 1 }, 'admin')).rejects.toBeInstanceOf(
      DungeonInvalidError,
    );
  });
  it('allows missing artwork in drafts and verifies shipped containment and managed bytes by hash', async () => {
    const pkg = makePackage();
    pkg.dungeon.artwork = { kind: 'shipped', path: 'dungeons/missing.webp' };
    pkg.assets = [pkg.dungeon.artwork];
    pkg.contentHash = dungeonContentHash(pkg.dungeon);
    expect((await w.content.planImport(pkg)).issues.some((i) => i.code === 'artwork_missing')).toBe(true);
    expect((await w.content.applyImport(await reviewed(pkg), 'admin')).result).toBe('created');
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ff0000' } })
      .png()
      .toBuffer();
    fs.mkdirSync(path.join(w.artworkDir, 'dungeons'), { recursive: true });
    fs.writeFileSync(path.join(w.artworkDir, 'dungeons', 'present.png'), bytes);
    pkg.dungeon.artwork = { kind: 'shipped', path: 'dungeons/present.png' };
    pkg.assets = [pkg.dungeon.artwork];
    pkg.contentHash = dungeonContentHash(pkg.dungeon);
    expect(
      (await w.content.planImport(pkg)).issues.some(
        (i) => i.code === 'artwork_missing' && i.path === 'dungeon.artwork',
      ),
    ).toBe(false);
    const outside = `${w.artworkDir}-outside.png`;
    fs.writeFileSync(outside, bytes);
    try {
      fs.symlinkSync(outside, path.join(w.artworkDir, 'dungeons', 'escape.png'));
      pkg.dungeon.artwork.path = 'dungeons/escape.png';
      pkg.contentHash = dungeonContentHash(pkg.dungeon);
      expect(
        (await w.content.planImport(pkg)).issues.some(
          (i) => i.code === 'artwork_missing' && i.path === 'dungeon.artwork',
        ),
      ).toBe(true);
    } finally {
      fs.unlinkSync(outside);
    }
    const asset = await w.assets.upload({ category: 'dungeon_zone', bytes, filename: 'test.png' }, 'admin');
    const managed = makePackage();
    managed.dungeon.artwork = {
      kind: 'managed',
      category: 'dungeon_zone',
      contentHash: asset.contentHash,
    };
    managed.assets = [managed.dungeon.artwork];
    managed.contentHash = dungeonContentHash(managed.dungeon);
    expect(
      (await w.content.planImport(managed)).issues.some(
        (i) => i.code === 'artwork_missing' && i.path === 'dungeon.artwork',
      ),
    ).toBe(false);
    const request = await reviewed(managed);
    const [row] = await w.t.db.select().from(artworkAssets).where(eq(artworkAssets.id, asset.id));
    fs.unlinkSync(path.join(w.artworkDir, 'managed', row!.storageKey));
    await expect(w.content.applyImport(request, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
    expect((await w.content.planImport(managed)).issues.some((i) => i.code === 'artwork_missing')).toBe(true);
  });
});
