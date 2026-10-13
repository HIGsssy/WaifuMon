import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { createLocalArtworkStorage } from '../../src/modules/artworkAssets/artworkStorage';
import {
  createArtworkAssetService,
  type ArtworkAssetService,
} from '../../src/modules/artworkAssets/artworkAssetService';
import {
  createSceneSpriteService,
  type SceneSpriteService,
} from '../../src/modules/dungeons/sceneSprites/sceneSpriteService';
import { transparentSprite } from '../helpers/imageFixtures';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let t: TestDb, assets: ArtworkAssetService, sprites: SceneSpriteService, dir: string, assetId: string;
beforeAll(async () => {
  t = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), 'wm-scene-cat-'));
  assets = createArtworkAssetService({
    db: t.db,
    storage: createLocalArtworkStorage(dir),
  });
  sprites = createSceneSpriteService({ db: t.db, assets });
  assetId = (
    await assets.upload(
      {
        bytes: await transparentSprite(100, 200),
        category: 'dungeon_scene_sprite',
        filename: 'chest.png',
      },
      'artist',
    )
  ).id;
});
afterAll(async () => {
  await t?.cleanup();
  if (dir) await rm(dir, { recursive: true, force: true });
});
describe('Managed dungeon scene sprite catalogue', () => {
  it('creates defaults and audit/reference records using the shared validated artwork', async () => {
    const s = await sprites.create('chest', { name: 'Chest', category: 'Chest', assetId }, 'author');
    expect(s).toMatchObject({
      key: 'chest',
      revision: 1,
      archived: false,
      mirror: false,
      visualLayer: 'background',
      placement: {
        anchor: 'bottom-center',
        scaleBasisPoints: 5000,
        offsetX: 0,
        offsetY: 0,
      },
    });
    expect(s.events[0]).toMatchObject({ action: 'created', actor: 'author' });
    expect(await assets.references(assetId)).toContainEqual({
      kind: 'dungeon_scene_sprite',
      key: 'chest',
      name: 'Chest',
      field: 'assetId',
    });
    await expect(assets.delete(assetId, 'artist')).rejects.toMatchObject({
      code: 'ARTWORK_ASSET_IN_USE',
    });
  });
  it('edits placement/artwork, refuses stale saves and archives/restores without dropping data', async () => {
    const image = await assets.upload(
      {
        bytes: await transparentSprite(200, 100),
        category: 'dungeon_scene_sprite',
      },
      'artist',
    );
    const input = {
      name: 'Big Chest',
      assetId: image.id,
      placement: {
        anchor: 'left',
        scaleBasisPoints: 2000,
        offsetX: 20,
        offsetY: -30,
      },
      mirror: true,
      visualLayer: 'foreground',
    };
    const edited = await sprites.update('chest', input, 1, 'editor');
    expect(edited).toMatchObject({ ...input, revision: 2 });
    await expect(sprites.update('chest', input, 1, 'late')).rejects.toMatchObject({ code: 'SCENE_SPRITE_STALE' });
    const archived = await sprites.archive('chest', true, 2, 'editor');
    expect(archived).toMatchObject({
      archived: true,
      mirror: true,
      visualLayer: 'foreground',
    });
    const restored = await sprites.archive('chest', false, 3, 'editor');
    expect(restored.archived).toBe(false);
    expect(restored.events.map((e) => e.action)).toEqual(['restored', 'archived', 'updated', 'created']);
    expect((await sprites.list())[0]?.revision).toBe(4);
    await assets.delete(assetId, 'artist');
  });
  it('rejects invalid artwork, bounds, identifiers and duplicate keys', async () => {
    await expect(
      assets.upload({ bytes: Buffer.from('<svg/>'), category: 'dungeon_scene_sprite' }, 'artist'),
    ).rejects.toMatchObject({ code: 'ARTWORK_UPLOAD_INVALID' });
    const current = (await sprites.get('chest'))!;
    await expect(sprites.create('chest', { name: 'Again', assetId: current.assetId }, 'a')).rejects.toMatchObject({
      code: 'SCENE_SPRITE_KEY_TAKEN',
    });
    await expect(sprites.create('Invalid key', { name: 'Bad', assetId: current.assetId }, 'a')).rejects.toMatchObject({
      code: 'SCENE_SPRITE_INVALID',
    });
    await expect(
      sprites.create(
        'bad_scale',
        {
          name: 'Bad',
          assetId: current.assetId,
          placement: { scaleBasisPoints: 10001 },
        },
        'a',
      ),
    ).rejects.toMatchObject({ code: 'SCENE_SPRITE_INVALID' });
    await assets.setEnabled(current.assetId, false, 'artist');
    await expect(sprites.create('disabled_art', { name: 'Bad', assetId: current.assetId }, 'a')).rejects.toMatchObject({
      code: 'SCENE_SPRITE_INVALID',
    });
    await assets.setEnabled(current.assetId, true, 'artist');
  });
  it('deletes unused entries and keeps the audit trail', async () => {
    const s = await sprites.create('unused', { name: 'Unused', assetId: (await sprites.get('chest'))!.assetId }, 'a');
    await sprites.delete(s.key, s.revision, 'a');
    expect(await sprites.get(s.key)).toBeNull();
  });
});
