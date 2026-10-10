/**
 * The Enemy Catalogue against a real database: how shipped enemies are seeded
 * and kept apart from admin edits, the one-time merge of the old artwork
 * overlay, and what dungeons and Combat Trials see when an enemy is created,
 * edited or switched off.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { combatEnemies, combatEnemyArtwork, combatTrialAttempts, dungeonRuns } from '../../src/db/schema';
import { CombatEnemyDefinitionSchema, type CombatEnemyDefinition } from '../../src/modules/combat/enemyDefinitions';
import { CombatTrialDefinitionSchema } from '../../src/modules/combat/trialDefinitions';
import {
  combatTrialCatalogueFromEnemies,
  createCombatTrialService,
  type CombatTrialService,
} from '../../src/modules/combatTrials/combatTrialService';
import { combatTrialEnemyReferences, dungeonEnemyReferences } from '../../src/modules/enemies/enemyReferences';
import type { DungeonDependencySnapshot } from '../../src/modules/dungeons/dungeonRunService';
import { createEnemyCatalogueService } from '../../src/modules/enemies/enemyService';
import {
  combatEnemyHash,
  mergeLegacyEnemyArtwork,
  reportCombatEnemySeed,
  seedCombatEnemies,
  shippedCombatEnemies,
} from '../../src/modules/enemies/enemyStore';
import {
  CombatTrialUnavailableError,
  EnemyInUseError,
  EnemyInvalidError,
  EnemyKeyTakenError,
  EnemyStaleError,
} from '../../src/shared/errors';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { loadShippedContent } from '../helpers/fixtures';
import { solidImage, transparentSprite } from '../helpers/imageFixtures';

let w: DungeonWorld;

const def = (over: Partial<CombatEnemyDefinition> & { key: string }): CombatEnemyDefinition =>
  CombatEnemyDefinitionSchema.parse({ name: over.key, attack: 10, defense: 5, hp: 100, enabled: true, ...over });
const seed = (...enemies: CombatEnemyDefinition[]) => seedCombatEnemies(w.t.db, shippedCombatEnemies(enemies));
const row = async (key: string) => (await w.t.db.select().from(combatEnemies).where(eq(combatEnemies.enemyKey, key)))[0]!;
const input = (over: Record<string, unknown> = {}) => ({
  name: 'Made Here',
  enabled: true,
  attack: 20,
  defense: 10,
  hp: 200,
  tags: ['custom'],
  ...over,
});
/** Save a change to an enemy through the service, at its current revision. */
async function edit(key: string, change: Record<string, unknown>) {
  const current = (await w.enemies.get(key))!;
  return w.enemies.update(
    key,
    {
      enemy: {
        name: current.name,
        description: current.description,
        enabled: current.enabled,
        attack: current.attack,
        defense: current.defense,
        hp: current.hp,
        tags: current.tags,
        ...change,
      },
      expectedRevision: current.revision,
    },
    'admin-1',
  );
}
const upload = async (kind: 'sprite' | 'art', filename: string) =>
  (
    await w.assets.upload(
      kind === 'sprite'
        ? { bytes: await transparentSprite(120, 160), category: 'enemy_sprite', filename }
        : { bytes: await solidImage(200, 200), category: 'enemy_art', filename },
      'admin-1',
    )
  ).id;


type Waves = ({ enemy: { key: string } } | { enemy: { pool: { key: string; weight: number }[] } })[];
/** A one-room dungeon — room "Hall" — whose fight `guards` fields `waves`, with an optional boss `chief` after it. */
const fightDungeon = (key: string, name: string, waves: Waves, boss?: Waves) =>
  singleRoomDungeon(
    [
      { id: 'guards', type: 'combat', waves },
      ...(boss ? [{ id: 'chief', type: 'boss' as const, waves: boss }] : []),
    ],
    (d) => {
      d.key = key;
      d.name = name;
    },
  );
const errorsOf = (issues: readonly { severity: string }[]) => issues.filter((i) => i.severity === 'error');
const wavesOf = (definition: { rooms: { actions: unknown[] }[] }) =>
  (definition.rooms[0]!.actions[0] as { waves: { enemy: { key: string } }[] }).waves.map((wave) => wave.enemy.key);
async function setEnemyEnabled(key: string, enabled: boolean) {
  const current = (await w.enemies.get(key))!;
  await w.enemies.setEnabled(key, { enabled, expectedRevision: current.revision }, 'admin-1');
}
const runRow = async (runId: number) => (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!;
/** What a run froze when it started. */
const snapshotOf = async (runId: number) => (await runRow(runId)).dependencySnapshot as unknown as DungeonDependencySnapshot;

beforeAll(async () => {
  w = await createDungeonWorld();
});
afterAll(async () => {
  await w?.cleanup();
});

describe('seeding shipped enemies', () => {
  it('inserts a missing enemy, and is idempotent', async () => {
    const first = await seed(def({ key: 'seed_new', name: 'Seed New', tags: ['tier_1'] }));
    expect(first).toMatchObject({ created: ['seed_new'], updated: [], adopted: [], diverged: [], unchanged: 0 });
    const stored = await row('seed_new');
    expect(stored).toMatchObject({ name: 'Seed New', attack: 10, defense: 5, hp: 100, enabled: true, tags: ['tier_1'], revision: 1, updatedBy: 'seed' });
    expect(stored.contentHash).toBe(stored.seedHash);
    expect((await w.enemies.get('seed_new'))!.origin).toBe('shipped');

    const again = await seed(def({ key: 'seed_new', name: 'Seed New', tags: ['tier_1'] }));
    expect(again).toMatchObject({ created: [], updated: [], unchanged: 1 });
    expect((await row('seed_new')).revision).toBe(1);
  });

  it('an untouched shipped enemy follows a change in Git — and keeps its managed artwork', async () => {
    await seed(def({ key: 'seed_follow', attack: 10 }));
    // Attaching artwork is not an edit: managed ids are environment-local.
    const sprite = await upload('sprite', 'follow.png');
    await edit('seed_follow', { spriteAssetId: sprite });
    expect((await w.enemies.get('seed_follow'))!.origin).toBe('shipped');

    const result = await seed(def({ key: 'seed_follow', attack: 25, name: 'Follower' }));
    expect(result.updated).toEqual(['seed_follow']);
    const after = await row('seed_follow');
    expect(after).toMatchObject({ attack: 25, name: 'Follower', spriteAssetId: sprite, updatedBy: 'seed' });
    expect(after.contentHash).toBe(after.seedHash);
  });

  it('an enemy edited in the Portal is not overwritten, and the divergence is reported', async () => {
    await seed(def({ key: 'seed_edited', attack: 10 }));
    await edit('seed_edited', { attack: 99 });
    expect((await w.enemies.get('seed_edited'))!.origin).toBe('edited');

    // Git has not moved: the edit is simply kept.
    const same = await seed(def({ key: 'seed_edited', attack: 10 }));
    expect(same.diverged).toEqual([expect.objectContaining({ key: 'seed_edited', shippedChanged: false, updatedBy: 'admin-1' })]);
    // Git moved too: still kept, and flagged.
    const moved = await seed(def({ key: 'seed_edited', attack: 30 }));
    expect(moved.diverged).toEqual([expect.objectContaining({ key: 'seed_edited', shippedChanged: true })]);
    expect((await row('seed_edited')).attack).toBe(99);

    const lines: string[] = [];
    reportCombatEnemySeed(
      { info: (_f, m) => lines.push(`info ${m}`), warn: (_f, m) => lines.push(`warn ${m}`) },
      moved,
    );
    expect(lines).toEqual([expect.stringMatching(/^warn enemy seed_edited was edited in Portal Admin and Git has also changed it/)]);
  });

  it('a row that matches the shipped enemy again is adopted as shipped', async () => {
    await seed(def({ key: 'seed_adopt', attack: 10 }));
    await edit('seed_adopt', { attack: 44 });
    const before = await row('seed_adopt');
    // The edit was exported and committed.
    const result = await seed(def({ key: 'seed_adopt', attack: 44 }));
    expect(result.adopted).toEqual(['seed_adopt']);
    const after = await row('seed_adopt');
    expect(after.seedHash).toBe(after.contentHash);
    expect(after.revision).toBe(before.revision);
    expect((await w.enemies.get('seed_adopt'))!.origin).toBe('shipped');
    // …and from here it follows Git again.
    expect((await seed(def({ key: 'seed_adopt', attack: 45 }))).updated).toEqual(['seed_adopt']);
  });

  it('a shipped-disabled enemy seeds disabled; one an admin disabled stays disabled', async () => {
    await seed(def({ key: 'seed_off', enabled: false }), def({ key: 'seed_on' }));
    expect((await row('seed_off')).enabled).toBe(false);

    const current = (await w.enemies.get('seed_on'))!;
    await w.enemies.setEnabled('seed_on', { enabled: false, expectedRevision: current.revision }, 'admin-1');
    const result = await seed(def({ key: 'seed_off', enabled: false }), def({ key: 'seed_on' }));
    expect(result.diverged.map((d) => d.key)).toEqual(['seed_on']);
    expect((await row('seed_on')).enabled).toBe(false);
  });

  it('reports only what changed', async () => {
    const lines: string[] = [];
    const logger = { info: (_f: unknown, m: string) => lines.push(m), warn: (_f: unknown, m: string) => lines.push(m) };
    reportCombatEnemySeed(logger, { created: [], updated: [], adopted: [], diverged: [], unchanged: 12 });
    expect(lines).toEqual([]);
    reportCombatEnemySeed(logger, { created: ['a', 'b'], updated: ['c'], adopted: [], diverged: [], unchanged: 3 });
    expect(lines).toEqual(['seeded combat enemies from shipped content: 2 inserted, 1 updated from Git, 0 adopted as shipped again']);
  });

  it('REGRESSION: an enemy newly added to the shipped file is in the catalogue and the Dungeon editor at once', async () => {
    const before = (await w.content.reference()).enemies.map((e) => e.key);
    expect(before).not.toContain('fresh_from_json');
    // What a deploy does: the file gained an enemy, startup seeds it.
    await seed(def({ key: 'fresh_from_json', name: 'Fresh From JSON', attack: 77, defense: 33, hp: 444, tags: ['tier_2'] }));

    const ref = (await w.content.reference()).enemies.find((e) => e.key === 'fresh_from_json');
    expect(ref).toMatchObject({ name: 'Fresh From JSON', enabled: true, attack: 77, defense: 33, hp: 444 });
    const listed = (await w.enemies.list()).find((e) => e.key === 'fresh_from_json');
    expect(listed).toMatchObject({ name: 'Fresh From JSON', tags: ['tier_2'] });
    // …and a dungeon may use it straight away, with no restart in between.
    const created = await w.content.create(
      { definition: fightDungeon('fresh_dungeon', 'Fresh Dungeon', [{ enemy: { key: 'fresh_from_json' } }]) },
      'test',
    );
    expect(errorsOf(created.issues)).toEqual([]);
    expect(errorsOf((await w.content.get('fresh_dungeon'))!.issues)).toEqual([]);
  });

  it('every enemy in the shipped content file validates and seeds', async () => {
    const shipped = loadShippedContent().combatEnemies ?? [];
    expect(shipped.length).toBeGreaterThan(4);
    const result = await seed(...shipped);
    expect(result.created).toEqual(shipped.map((e) => e.key));
    const listed = new Map((await w.enemies.list()).map((e) => [e.key, e]));
    const picker = new Map((await w.content.reference()).enemies.map((e) => [e.key, e]));
    for (const enemy of shipped) {
      expect(listed.get(enemy.key), enemy.key).toMatchObject({
        name: enemy.name,
        attack: enemy.attack,
        defense: enemy.defense,
        hp: enemy.hp,
        tags: enemy.tags,
        enabled: enemy.enabled,
        origin: 'shipped',
      });
      expect(picker.get(enemy.key), enemy.key).toMatchObject({ name: enemy.name, enabled: enemy.enabled });
    }
    // The originals keep their keys, stats and shipped art.
    expect(listed.get('scrapyard_drone')).toMatchObject({ attack: 55, defense: 30, hp: 300, artworkPath: 'combat/enemies/scrapyard_drone.webp' });
    expect(listed.get('scrapheap_colossus')).toMatchObject({ attack: 170, defense: 110, hp: 1200, tags: ['boss', 'temporary', 'initial_tuning'] });
  });
});

describe('the legacy artwork overlay', () => {
  it('moves onto the enemy row once, keeps the old row, and leaves orphans alone', async () => {
    await seed(def({ key: 'legacy_art' }), def({ key: 'legacy_ids_only' }));
    const [sprite, full] = [await upload('sprite', 'legacy-sprite.png'), await upload('art', 'legacy-full.png')];
    const placement = { anchor: 'bottom-center', scaleBasisPoints: 7000, offsetX: -40, offsetY: 10 };
    const savedAt = new Date('2026-09-01T10:00:00Z');
    await w.t.db.insert(combatEnemyArtwork).values([
      { enemyKey: 'legacy_art', artworkAssetId: full, spriteAssetId: sprite, spritePlacement: placement, revision: 3, updatedBy: 'admin-9', updatedAt: savedAt },
      { enemyKey: 'legacy_ids_only', spriteAssetId: sprite, updatedBy: 'admin-9' },
      { enemyKey: 'legacy_gone', spriteAssetId: sprite },
    ]);

    const result = await mergeLegacyEnemyArtwork(w.t.db);
    expect(result.merged).toEqual([
      { key: 'legacy_art', artwork: true, sprite: true, placement: true },
      { key: 'legacy_ids_only', artwork: false, sprite: true, placement: false },
    ]);
    expect(result.orphaned).toEqual(['legacy_gone']);

    const merged = (await w.enemies.get('legacy_art'))!;
    expect(merged).toMatchObject({
      artworkAssetId: full,
      spriteAssetId: sprite,
      spritePlacement: placement,
      visual: { artworkAssetId: full, spriteAssetId: sprite, spritePlacement: placement },
      // The placement differs from Git, so the enemy now reads as edited — by whoever saved the overlay.
      origin: 'edited',
      updatedBy: 'admin-9',
    });
    // Ids alone are not an edit.
    expect((await w.enemies.get('legacy_ids_only'))!).toMatchObject({ spriteAssetId: sprite, origin: 'shipped' });
    // The sprite knows who uses it, by name.
    expect(await w.assets.references(sprite)).toEqual(
      expect.arrayContaining([{ kind: 'combat_enemy', key: 'legacy_art', name: 'legacy_art', field: 'spriteAssetId' }]),
    );

    // Nothing was deleted, and a second pass does nothing.
    const kept = await w.t.db.select().from(combatEnemyArtwork);
    expect(kept.map((r) => [r.enemyKey, r.mergedAt !== null]).sort()).toEqual([
      ['legacy_art', true],
      ['legacy_gone', false],
      ['legacy_ids_only', true],
    ]);
    const revision = (await row('legacy_art')).revision;
    expect(await mergeLegacyEnemyArtwork(w.t.db)).toEqual({ merged: [], orphaned: ['legacy_gone'] });
    expect((await row('legacy_art')).revision).toBe(revision);
    await w.t.db.delete(combatEnemyArtwork);
  });
});

describe('authoring', () => {
  it('creates an enemy from nothing, validates stats, and refuses a taken or reserved key', async () => {
    const created = await w.enemies.create('made_here', input({ description: 'Built in the Portal.' }), 'admin-1');
    expect(created).toMatchObject({
      key: 'made_here',
      name: 'Made Here',
      description: 'Built in the Portal.',
      attack: 20,
      defense: 10,
      hp: 200,
      tags: ['custom'],
      enabled: true,
      origin: 'custom',
      matchesShipped: null,
      revision: 1,
      usageCount: 0,
      references: [],
      updatedBy: 'admin-1',
    });
    expect((await row('made_here')).seedHash).toBeNull();
    expect((await row('made_here')).contentHash).toBe(combatEnemyHash(await w.enemies.definition('made_here')));

    await expect(w.enemies.create('made_here', input(), 'admin-1')).rejects.toBeInstanceOf(EnemyKeyTakenError);
    for (const key of ['new', 'export', 'Bad-Key', '']) {
      await expect(w.enemies.create(key, input(), 'admin-1'), key).rejects.toBeInstanceOf(EnemyInvalidError);
    }
    const bad = await w.enemies.create('bad_stats', input({ attack: 0, defense: -1, hp: 0 }), 'admin-1').catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(EnemyInvalidError);
    expect((bad as EnemyInvalidError).issues.map((i) => i.path).sort()).toEqual(['attack', 'defense', 'hp']);
    // A typo guard, not a balance rule: a strong boss is fine.
    await expect(w.enemies.create('typo', input({ hp: 100_000_000 }), 'admin-1')).rejects.toBeInstanceOf(EnemyInvalidError);
    expect((await w.enemies.create('raid_boss', input({ attack: 5000, defense: 3000, hp: 250_000 }), 'admin-1')).hp).toBe(250_000);
    expect(await w.enemies.validate({ key: 'made_here', enemy: input(), creating: true })).toEqual([
      { path: 'key', message: 'another enemy already uses that key', severity: 'error' },
    ]);
    expect(await w.enemies.validate({ key: 'brand_new', enemy: input(), creating: true })).toEqual([]);
  });

  it('saves optimistically: a stale revision is refused and nothing is written', async () => {
    const current = (await w.enemies.get('made_here'))!;
    const saved = (await edit('made_here', { attack: 21 }))!;
    expect(saved).toMatchObject({ attack: 21, revision: current.revision + 1 });
    const stale = await w.enemies
      .update('made_here', { enemy: input({ attack: 500 }), expectedRevision: current.revision }, 'admin-2')
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(EnemyStaleError);
    expect(stale).toMatchObject({ expectedRevision: current.revision, currentRevision: saved.revision, updatedBy: 'admin-1' });
    expect((await row('made_here')).attack).toBe(21);
    expect(await w.enemies.update('nobody', { enemy: input(), expectedRevision: 1 }, 'admin-1')).toBeNull();
  });

  it('duplicates under a new key: disabled, custom, with or without the artwork', async () => {
    const sprite = await upload('sprite', 'dup.png');
    const placement = { anchor: 'center', scaleBasisPoints: 6000, offsetX: 5, offsetY: -5 } as const;
    await edit('grunt', { spriteAssetId: sprite, spritePlacement: placement });

    const copy = (await w.enemies.duplicate('grunt', { key: 'grunt_two' }, 'admin-1'))!;
    expect(copy).toMatchObject({
      key: 'grunt_two',
      name: 'Grunt (copy)',
      enabled: false,
      attack: 60,
      hp: 150,
      origin: 'custom',
      spriteAssetId: sprite,
      spritePlacement: placement,
      artworkPath: 'combat/enemies/grunt.webp',
    });
    // Both enemies now hold the sprite.
    expect((await w.assets.references(sprite)).map((r) => r.key).sort()).toEqual(['grunt', 'grunt_two']);

    const bare = (await w.enemies.duplicate('grunt', { key: 'grunt_bare', name: 'Bare Grunt', copyArtwork: false }, 'admin-1'))!;
    expect(bare).toMatchObject({ name: 'Bare Grunt', spriteAssetId: null, artworkPath: null, spritePlacement: null, enabled: false });
    await expect(w.enemies.duplicate('grunt', { key: 'grunt_two' }, 'admin-1')).rejects.toBeInstanceOf(EnemyKeyTakenError);
    expect(await w.enemies.duplicate('nobody', { key: 'x' }, 'admin-1')).toBeNull();
    await edit('grunt', { spriteAssetId: null, spritePlacement: null });
  });

  it('managed artwork round-trips, falls back to shipped when cleared, and survives a disabled asset', async () => {
    const [sprite, full] = [await upload('sprite', 'rt-sprite.png'), await upload('art', 'rt-full.png')];
    const placement = { anchor: 'bottom-left', scaleBasisPoints: 9000, offsetX: 12, offsetY: 0 } as const;
    const withArt = (await edit('grunt', { artworkAssetId: full, spriteAssetId: sprite, spritePlacement: placement }))!;
    expect(withArt.visual).toEqual({
      artworkAssetId: full,
      artworkPath: 'combat/enemies/grunt.webp',
      spriteAssetId: sprite,
      spriteArtworkPath: null,
      spritePlacement: placement,
    });
    // A stats-only save leaves the artwork alone.
    expect((await edit('grunt', { attack: 60 }))!).toMatchObject({ artworkAssetId: full, spriteAssetId: sprite, spritePlacement: placement });

    // A disabled asset is a warning (the shipped art shows instead); a deleted one cannot be chosen.
    await w.assets.setEnabled(sprite, false, 'admin-1');
    expect((await w.enemies.get('grunt'))!.issues).toEqual([
      expect.objectContaining({ path: 'spriteAssetId', severity: 'warning' }),
    ]);
    await w.assets.setEnabled(sprite, true, 'admin-1');
    const missing = await edit('grunt', { spriteAssetId: '00000000-0000-4000-8000-0000000000cc' }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(EnemyInvalidError);
    await expect(edit('grunt', { spritePlacement: { ...placement, scaleBasisPoints: 20_000 } })).rejects.toBeInstanceOf(EnemyInvalidError);

    // Cleared: the shipped path and the default placement are what is left.
    const cleared = (await edit('grunt', { artworkAssetId: null, spriteAssetId: null, spritePlacement: null }))!;
    expect(cleared.visual).toEqual({
      artworkAssetId: null,
      artworkPath: 'combat/enemies/grunt.webp',
      spriteAssetId: null,
      spriteArtworkPath: null,
      spritePlacement: { anchor: 'bottom-right', scaleBasisPoints: 8500, offsetX: 0, offsetY: 0 },
    });
    expect(await w.assets.references(sprite)).toEqual([]);
  });

  it('lists where an enemy is used, and refuses to delete it while it is — or while Git ships it', async () => {
    await w.enemies.create('ref_target', input({ name: 'Ref Target' }), 'admin-1');
    // A draft that names it three ways: a fixed wave, a pooled wave and a boss…
    await w.content.create(
      {
        definition: fightDungeon(
          'ref_draft',
          'Reference Draft',
          [{ enemy: { key: 'ref_target' } }, { enemy: { pool: [{ key: 'ref_target', weight: 3 }, { key: 'grunt', weight: 1 }] } }],
          [{ enemy: { key: 'ref_target' } }],
        ),
      },
      'test',
    );
    // …and a published dungeon, which holds it in its draft and in the revision players get.
    await w.publish(fightDungeon('ref_live', 'Reference Live', [{ enemy: { key: 'ref_target' } }]));
    const references = (await w.enemies.references('ref_target'))!;
    expect(references).toEqual([
      { kind: 'dungeon_zone', key: 'ref_draft', name: 'Reference Draft', usage: 'draft: room "Hall" combat "guards", wave 1' },
      { kind: 'dungeon_zone', key: 'ref_draft', name: 'Reference Draft', usage: 'draft: room "Hall" combat "guards", wave 2 (pool)' },
      { kind: 'dungeon_zone', key: 'ref_draft', name: 'Reference Draft', usage: 'draft: room "Hall" boss "chief"' },
      { kind: 'dungeon_zone', key: 'ref_live', name: 'Reference Live', usage: 'draft: room "Hall" combat "guards"' },
      { kind: 'dungeon_zone', key: 'ref_live', name: 'Reference Live', usage: 'published: room "Hall" combat "guards"' },
    ]);
    expect((await w.enemies.list()).find((e) => e.key === 'ref_target')!.usageCount).toBe(5);
    expect(await w.enemies.references('nobody')).toBeNull();

    const current = (await w.enemies.get('ref_target'))!;
    const refused = await w.enemies.delete('ref_target', { expectedRevision: current.revision }, 'admin-1').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(EnemyInUseError);
    expect((refused as EnemyInUseError).references).toEqual(references);
    expect(await row('ref_target')).toBeDefined();

    // A shipped enemy would be re-seeded at the next start: disable it instead.
    const shippedRefusal = await w.enemies.delete('wall', { expectedRevision: (await row('wall')).revision }, 'admin-1').catch((e: unknown) => e);
    expect(shippedRefusal).toMatchObject({ code: 'ENEMY_IN_USE', shipped: true, references: [] });

    // Unused and Portal-made: gone. A stale revision is refused first.
    const spare = await w.enemies.create('spare', input(), 'admin-1');
    await expect(w.enemies.delete('spare', { expectedRevision: spare.revision + 1 }, 'admin-1')).rejects.toBeInstanceOf(EnemyStaleError);
    expect(await w.enemies.delete('spare', { expectedRevision: spare.revision }, 'admin-1')).toBe(true);
    expect(await w.enemies.get('spare')).toBeNull();
    expect(await w.enemies.delete('spare', { expectedRevision: 1 }, 'admin-1')).toBe(false);
  });

  it('a second reference source (Combat Trials) shows up beside dungeons', async () => {
    const service = createEnemyCatalogueService({
      db: w.t.db,
      getShipped: () => [],
      referenceSources: [
        dungeonEnemyReferences,
        combatTrialEnemyReferences(() => [{ key: 'trial_2', name: 'Combat Trial 2', enemyKey: 'ref_target' }]),
      ],
    });
    expect((await service.references('ref_target'))!.at(-1)).toEqual({
      kind: 'combat_trial',
      key: 'trial_2',
      name: 'Combat Trial 2',
      usage: 'primary enemy',
    });
    // Unreferenced by a dungeon, but a Trial names it: still protected.
    await service.create('trial_only', input(), 'admin-1');
    const guarded = createEnemyCatalogueService({
      db: w.t.db,
      getShipped: () => [],
      referenceSources: [combatTrialEnemyReferences(() => [{ key: 'trial_9', name: 'Trial 9', enemyKey: 'trial_only' }])],
    });
    await expect(guarded.delete('trial_only', { expectedRevision: 1 }, 'admin-1')).rejects.toBeInstanceOf(EnemyInUseError);
  });

  it('exports a document Git can ship, with managed artwork listed beside it — not in it', async () => {
    const sprite = await upload('sprite', 'export.png');
    await edit('made_here', { spriteAssetId: sprite });
    const exported = await w.enemies.export();
    expect(exported.file).toBe('combat/enemies.json');
    expect(exported.document).toMatchObject({ format: 'waifumon-combat-enemies', version: 1 });
    const made = exported.document.enemies.find((e) => e.key === 'made_here')!;
    expect(made).toEqual(await w.enemies.definition('made_here'));
    expect(JSON.stringify(exported.document)).not.toContain(sprite);
    expect(exported.environmentLocal.managedArtwork).toContainEqual({ key: 'made_here', artworkAssetId: null, spriteAssetId: sprite });

    // Committing the export and deploying adopts the Portal enemy as shipped.
    const result = await seedCombatEnemies(w.t.db, shippedCombatEnemies(exported.document.enemies));
    expect(result.adopted).toContain('made_here');
    expect(result.diverged).toEqual([]);
    expect((await row('made_here')).spriteAssetId).toBe(sprite);
  });

  it('runtime definitions carry no administrative fields', async () => {
    const definition = (await w.enemies.definition('made_here'))!;
    expect(Object.keys(definition).sort()).toEqual(
      ['artworkPath', 'attack', 'defense', 'description', 'enabled', 'hp', 'key', 'name', 'spriteArtworkPath', 'spritePlacement', 'tags'].sort(),
    );
    const snapshot = await w.enemies.snapshot();
    expect(JSON.stringify(snapshot)).not.toMatch(/contentHash|seedHash|revision|updatedBy/);
  });
});

describe('dungeons read the catalogue', () => {
  it('a Portal-made enemy is selectable in a fixed wave and a pooled one, and a run fights it', async () => {
    await w.enemies.create('picked', input({ name: 'Picked', attack: 60, defense: 0, hp: 150 }), 'admin-1');
    expect((await w.content.reference()).enemies.find((e) => e.key === 'picked')).toMatchObject({ name: 'Picked', enabled: true, attack: 60, hp: 150 });

    await w.content.create(
      {
        definition: fightDungeon('picked_pool', 'Picked Pool', [
          { enemy: { pool: [{ key: 'picked', weight: 10 }, { key: 'grunt', weight: 1 }] } },
        ]),
      },
      'test',
    );
    await w.publish(fightDungeon('picked_rooms', 'Picked Rooms', [{ enemy: { key: 'picked' } }]));
    for (const key of ['picked_pool', 'picked_rooms']) {
      expect(errorsOf((await w.content.get(key))!.issues), key).toEqual([]);
    }
    const { playerId } = await w.player();
    const started = await w.runs.start(playerId, 'picked_rooms');
    expect((await snapshotOf(started.id)).enemies.picked).toMatchObject({ key: 'picked', name: 'Picked', attack: 60 });
    expect(started.enemy).toMatchObject({ key: 'picked', name: 'Picked', attack: 60, hp: 150 });
  });

  it('a dungeon that names a disabled enemy keeps it — with a warning — and a run still fights it as snapshotted', async () => {
    await w.enemies.create('retired', input({ name: 'Retired', attack: 60, defense: 0, hp: 150 }), 'admin-1');
    await w.publish(fightDungeon('retired_rooms', 'Retired Rooms', [{ enemy: { key: 'grunt' } }, { enemy: { key: 'retired' } }]));
    expect((await w.content.get('retired_rooms'))!.issues.filter((i) => i.code === 'enemy_disabled')).toEqual([]);
    await setEnemyEnabled('retired', false);

    // Existing references: still there, still saveable, and flagged.
    const detail = (await w.content.get('retired_rooms'))!;
    expect(wavesOf(detail.draft)).toEqual(['grunt', 'retired']);
    expect(detail.issues).toContainEqual(
      expect.objectContaining({
        code: 'enemy_disabled',
        path: 'rooms[0].actions[0].waves[1].enemy',
        severity: 'warning',
        message: expect.stringContaining('"retired" is disabled'),
      }),
    );
    const resaved = await w.content.saveDraft(
      'retired_rooms',
      { definition: { ...detail.draft, description: 'Edited.' }, expectedRevision: detail.draftRevision },
      'admin',
    );
    expect(wavesOf(resaved.draft)).toEqual(['grunt', 'retired']);
    expect(resaved.draft.description).toBe('Edited.');
    // The enemy's own page says the same from the other side.
    expect((await w.enemies.get('retired'))!.issues).toContainEqual(expect.objectContaining({ path: 'enabled', severity: 'warning' }));

    // A dry run of a new dungeon that names it reports the same stable code.
    const report = await w.content.validate(fightDungeon('retired_new', 'Retired New', [{ enemy: { key: 'retired' } }]));
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'enemy_disabled', path: 'rooms[0].actions[0].waves[0].enemy', severity: 'warning' }),
    );

    // In play: the published revision still fields it, frozen as the catalogue has it now.
    const { playerId } = await w.player();
    const started = await w.runs.start(playerId, 'retired_rooms');
    expect((await snapshotOf(started.id)).enemies.retired).toMatchObject({ key: 'retired', enabled: false });

    // Re-enabling restores it everywhere, with nothing to repair.
    await setEnemyEnabled('retired', true);
    expect((await w.content.get('retired_rooms'))!.issues.filter((i) => i.code === 'enemy_disabled')).toEqual([]);
    expect((await w.enemies.get('retired'))!.issues).toEqual([]);
  });

  it('a run freezes the enemy it started with; a later edit reaches only new runs', async () => {
    await w.enemies.create('bruiser', input({ name: 'Bruiser', attack: 100, defense: 0, hp: 150 }), 'admin-1');
    const sprite = await upload('sprite', 'bruiser.png');
    const placement = { anchor: 'center', scaleBasisPoints: 5000, offsetX: 0, offsetY: 0 } as const;
    await edit('bruiser', { spriteAssetId: sprite, spritePlacement: placement });
    await w.publish(fightDungeon('bruiser_rooms', 'Bruiser Rooms', [{ enemy: { key: 'bruiser' } }]));

    const first = await w.player();
    const started = await w.runs.start(first.playerId, 'bruiser_rooms');
    const before = await runRow(started.id);
    const frozen = before.dependencySnapshot as unknown as DungeonDependencySnapshot;
    expect(frozen.enemies.bruiser).toMatchObject({ attack: 100, name: 'Bruiser', spritePlacement: placement });
    expect(frozen.enemyArtwork.bruiser).toMatchObject({ spriteAssetId: sprite });
    expect(started.enemy).toMatchObject({ attack: 100, visual: { spriteAssetId: sprite, spritePlacement: placement } });

    const other = await upload('sprite', 'bruiser-2.png');
    await edit('bruiser', { attack: 120, name: 'Bruiser Prime', spriteAssetId: other, spritePlacement: null });

    // The run in progress is untouched — stored and as the player sees it.
    expect(await runRow(started.id)).toEqual(before);
    expect((await w.runs.activeRun(first.playerId))!.enemy).toMatchObject({
      attack: 100,
      name: 'Bruiser',
      visual: { spriteAssetId: sprite, spritePlacement: placement },
    });

    // A new run gets the enemy as it is now.
    const second = await w.player();
    const fresh = await w.runs.start(second.playerId, 'bruiser_rooms');
    expect(fresh.enemy).toMatchObject({ attack: 120, name: 'Bruiser Prime', visual: { spriteAssetId: other } });
  });
});

describe('Combat Trials read the catalogue', () => {
  const TRIALS = [
    CombatTrialDefinitionSchema.parse({ key: 't_weak', name: 'Trial Weak', description: 'A test.', enabled: true, enemyKey: 'trial_weak', order: 1 }),
    CombatTrialDefinitionSchema.parse({ key: 't_ghost', name: 'Trial Ghost', description: 'A test.', enabled: true, enemyKey: 'no_such_enemy', order: 2 }),
  ];
  let trials: CombatTrialService;
  const attempts = (playerId: number) =>
    w.t.db.select().from(combatTrialAttempts).where(eq(combatTrialAttempts.playerId, playerId)).orderBy(combatTrialAttempts.id);

  beforeAll(async () => {
    await w.enemies.create('trial_weak', input({ name: 'Trial Weakling', attack: 1, defense: 0, hp: 10 }), 'admin-1');
    trials = createCombatTrialService({
      db: w.t.db,
      featureUnlocks: w.svc.featureUnlocks,
      combatStats: w.stats,
      currency: w.app.currency,
      inventory: w.app.inventory,
      getCatalogue: () => combatTrialCatalogueFromEnemies(TRIALS, w.enemies),
    });
  });

  it('fights the enemy as the catalogue has it, and a later edit changes only later fights', async () => {
    const { playerId } = await w.player();
    expect((await trials.list(playerId)).trials.map((s) => [s.trial.key, s.enemy.name])).toEqual([['t_weak', 'Trial Weakling']]);
    expect((await trials.detail(playerId, 't_weak')).enemy).toMatchObject({ key: 'trial_weak', attack: 1, defense: 0, hp: 10 });

    const first = await trials.fight(playerId, 't_weak', 'k-1');
    expect(first.attempt).toMatchObject({ enemyKey: 'trial_weak', result: 'player_victory', enemy: { name: 'Trial Weakling', attack: 1, defense: 0, maxHp: 10 } });

    await edit('trial_weak', { name: 'Trial Titan', attack: 100_000, hp: 1_000_000 });
    const second = await trials.fight(playerId, 't_weak', 'k-2');
    expect(second.attempt).toMatchObject({ result: 'enemy_victory', enemy: { name: 'Trial Titan', attack: 100_000, maxHp: 1_000_000 } });

    // The first result is a stored snapshot: replaying it, or reading it back, shows the old enemy.
    const replay = await trials.fight(playerId, 't_weak', 'k-1');
    expect(replay).toMatchObject({ replayed: true, attempt: first.attempt });
    const stored = await attempts(playerId);
    expect(stored.map((a) => [a.enemyName, a.enemyAttack, a.enemyMaxHp, a.result])).toEqual([
      ['Trial Weakling', 1, 10, 'player_victory'],
      ['Trial Titan', 100_000, 1_000_000, 'enemy_victory'],
    ]);
    await edit('trial_weak', { name: 'Trial Weakling', attack: 1, hp: 10 });
  });

  it('a Trial whose enemy is missing or disabled is unavailable, clearly, and records nothing', async () => {
    const { playerId } = await w.player();
    const ghost = await trials.fight(playerId, 't_ghost', 'k-ghost').catch((e: unknown) => e);
    expect(ghost).toBeInstanceOf(CombatTrialUnavailableError);
    expect(ghost).toMatchObject({ reason: 'enemy_missing', trialKey: 't_ghost' });

    await setEnemyEnabled('trial_weak', false);
    expect((await trials.list(playerId)).trials).toEqual([]);
    const off = await trials.fight(playerId, 't_weak', 'k-off').catch((e: unknown) => e);
    expect(off).toMatchObject({ code: 'COMBAT_TRIAL_UNAVAILABLE', reason: 'enemy_disabled' });
    expect(await attempts(playerId)).toEqual([]);

    await setEnemyEnabled('trial_weak', true);
    expect((await trials.fight(playerId, 't_weak', 'k-on')).attempt.result).toBe('player_victory');
  });
});
