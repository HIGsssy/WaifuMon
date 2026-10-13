import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import {
  createSceneSpriteService,
  type SceneSpriteService,
} from '../../src/modules/dungeons/sceneSprites/sceneSpriteService';
import { dungeonRevisions, artworkAssets } from '../../src/db/schema';
import { readSceneSpriteSnapshot } from '../../src/modules/dungeons/sceneSprites/sceneSpriteSnapshot';
import { solidImage, transparentSprite, RED, GREEN, BLUE, isNear, pixelAt } from '../helpers/imageFixtures';
import { dungeonRunSceneArtwork } from '../../src/discord/dungeonArtwork';
import type { AppContext } from '../../src/discord/types';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

let w: DungeonWorld, sprites: SceneSpriteService, firstAsset: string;
const author = 'scene-author';
beforeAll(async () => {
  w = await createDungeonWorld();
  sprites = createSceneSpriteService({ db: w.t.db, assets: w.assets });
  firstAsset = (
    await w.assets.upload(
      {
        bytes: await transparentSprite(100, 100, RED),
        category: 'dungeon_scene_sprite',
      },
      author,
    )
  ).id;
  await sprites.create(
    'chest',
    {
      name: 'Chest',
      assetId: firstAsset,
      placement: { anchor: 'center', scaleBasisPoints: 5000 },
    },
    author,
  );
});
afterAll(async () => {
  await w?.cleanup();
});
describe('Published dungeon scene sprites', () => {
  it('saves/reloads independent room/activity instances and pins room plus activity together in a live run', async () => {
    const d = singleRoomDungeon(
      [
        {
          id: 'rest',
          type: 'rest',
          sceneSprites: [
            {
              id: 'activity_one',
              spriteKey: 'chest',
              mirror: true,
              visualLayer: 'foreground',
              placement: { offsetX: 100 },
            },
          ],
        },
      ],
      (d) => {
        d.key = 'scene_room';
      },
    );
    d.rooms[0]!.sceneSprites = [
      { id: 'room_one', spriteKey: 'chest' },
      { id: 'room_two', spriteKey: 'chest', placement: { offsetX: -100 } },
    ];
    const published = await w.publish(d);
    expect((await w.content.get(d.key))?.draft.rooms[0]?.sceneSprites).toEqual(d.rooms[0]!.sceneSprites);
    const { playerId } = await w.player();
    const started = await w.runs.start(playerId, d.key);
    expect(started.sceneSprites).toHaveLength(3);
    expect(started.sceneSprites?.map((s) => s.placement.offsetX)).toEqual([0, -100, 100]);
    expect(started.sceneSprites?.[2]).toMatchObject({
      mirror: true,
      visualLayer: 'foreground',
    });
    const revision = (
      await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.id, published.revision.revisionId))
    )[0]!;
    expect(readSceneSpriteSnapshot(revision.sceneSpriteSnapshot)?.sprites.chest?.assetId).toBe(firstAsset);
    await expect(sprites.delete('chest', 1, author)).rejects.toMatchObject({
      code: 'SCENE_SPRITE_IN_USE',
    });
    const changedAsset = (
      await w.assets.upload(
        {
          bytes: await transparentSprite(100, 100, GREEN),
          category: 'dungeon_scene_sprite',
        },
        author,
      )
    ).id;
    await sprites.update(
      'chest',
      {
        name: 'Edited Chest',
        assetId: changedAsset,
        placement: { anchor: 'left', scaleBasisPoints: 2000 },
        mirror: false,
        visualLayer: 'foreground',
      },
      1,
      author,
    );
    const freshPlayer = await w.player();
    const newRunSameRevision = await w.runs.start(freshPlayer.playerId, d.key);
    expect(newRunSameRevision.sceneSprites).toEqual(started.sceneSprites);
    const sameDraft = (await w.content.get(d.key))!;
    expect(sameDraft.sceneSpritesDiffer).toBe(true);
    expect((await w.content.list()).find((s) => s.key === d.key)?.sceneSpritesDiffer).toBe(true);
    const republished = await w.content.publish(d.key, { expectedRevision: sameDraft.draftRevision }, author);
    expect(republished.unchanged).toBe(false);
    expect(republished.revision.contentHash).toBe(published.revision.contentHash);
    const latestPlayer = await w.player();
    const latest = await w.runs.start(latestPlayer.playerId, d.key);
    expect(latest.sceneSprites?.[0]).toMatchObject({
      assetId: changedAsset,
      placement: { anchor: 'left', scaleBasisPoints: 2000 },
    });
    const resumed = await w.restartedRuns().activeRun(playerId);
    expect(resumed?.sceneSprites).toEqual(started.sceneSprites);
    const archived = await sprites.archive('chest', true, 2, author);
    const archivedPlayer = await w.player();
    const fromArchivedCatalogue = await w.runs.start(archivedPlayer.playerId, d.key);
    expect(fromArchivedCatalogue.sceneSprites).toEqual(latest.sceneSprites);
    await expect(w.content.publish(d.key, { expectedRevision: sameDraft.draftRevision }, author)).rejects.toMatchObject(
      {
        code: 'DUNGEON_INVALID',
        issues: expect.arrayContaining([expect.objectContaining({ code: 'scene_sprite_archived' })]),
      },
    );
    await w.content.rollback(d.key, { revision: published.revision.number }, author);
    const rolledPlayer = await w.player();
    const rolled = await w.runs.start(rolledPlayer.playerId, d.key);
    expect(rolled.sceneSprites).toEqual(started.sceneSprites);
    await sprites.archive('chest', false, archived.revision, author);
  });
  it('protects frozen artwork against replace, disable, delete and category changes, preserving older rollback revisions', async () => {
    await expect(
      w.assets.replace(firstAsset, { bytes: await transparentSprite(100, 100, BLUE) }, author),
    ).rejects.toMatchObject({ code: 'ARTWORK_ASSET_IN_USE' });
    await expect(w.assets.setEnabled(firstAsset, false, author)).rejects.toMatchObject({
      code: 'ARTWORK_ASSET_IN_USE',
    });
    await expect(w.assets.delete(firstAsset, author)).rejects.toMatchObject({
      code: 'ARTWORK_ASSET_IN_USE',
    });
    await expect(w.assets.update(firstAsset, { category: 'enemy_sprite' }, author)).rejects.toMatchObject({
      code: 'ARTWORK_ASSET_IN_USE',
    });
    expect((await w.assets.references(firstAsset)).some((r) => r.field.includes('sceneSpriteSnapshot'))).toBe(true);
    expect((await w.assets.readUsable(firstAsset))?.asset.contentHash).toBe(
      readSceneSpriteSnapshot((await w.t.db.select().from(dungeonRevisions))[0]?.sceneSpriteSnapshot)?.sprites.chest
        ?.contentHash,
    );
  });
  it('renders event artwork through the existing compositor with environmental layers and no Buddy', async () => {
    const image = await w.assets.upload({ bytes: await solidImage(1200, 675, BLUE), category: 'event_art' }, author);
    const d = singleRoomDungeon(
      [
        {
          id: 'story',
          type: 'event',
          source: { kind: 'event', eventId: 'story' },
          sceneSprites: [
            {
              id: 'chest',
              spriteKey: 'chest',
              visualLayer: 'foreground',
              placement: {
                anchor: 'center',
                scaleBasisPoints: 5000,
                offsetX: 0,
              },
            },
          ],
        },
      ],
      (d) => {
        d.key = 'scene_event';
        d.events = [
          {
            id: 'story',
            title: 'A chest',
            text: 'Here it is.',
            artwork: {
              kind: 'managed',
              category: 'event_art',
              contentHash: image.contentHash,
            },
            choices: [
              {
                id: 'continue',
                label: 'Continue',
                outcome: { text: 'Carry on.' },
              },
            ],
          },
        ];
      },
    );
    await w.publish(d);
    const { playerId } = await w.player();
    const run = await w.runs.start(playerId, d.key);
    const ctx = {
      config: { assetsDir: w.artworkDir },
      services: { artworkAssets: w.assets, sceneComposition: w.scenes },
      logger: { warn: () => {} },
    } as unknown as AppContext;
    const rendered = await dungeonRunSceneArtwork(ctx, run);
    expect(rendered?.url).toMatch(/dungeon-scene/);
    const visual = run.sceneSprites![0]!;
    const bytes = await readFile(String(rendered!.file.attachment));
    expect(isNear(await pixelAt(bytes, 600, 337), GREEN)).toBe(true);
    expect(visual.assetId).not.toBe(firstAsset);
  });
  it('rejects publication when a managed sprite file disappears, and keeps the draft repairable', async () => {
    const image = await w.assets.upload(
      {
        bytes: await transparentSprite(100, 100, RED),
        category: 'dungeon_scene_sprite',
      },
      author,
    );
    await sprites.create('missing_file', { name: 'Missing file', assetId: image.id }, author);
    const d = singleRoomDungeon(
      [
        {
          id: 'rest',
          type: 'rest',
          sceneSprites: [{ id: 'missing', spriteKey: 'missing_file' }],
        },
      ],
      (d) => {
        d.key = 'missing_file';
      },
    );
    const draft = await w.content.create({ definition: d }, author);
    const [row] = await w.t.db.select().from(artworkAssets).where(eq(artworkAssets.id, image.id));
    await unlink(join(w.artworkDir, 'managed', row!.storageKey));
    await expect(w.content.publish(d.key, { expectedRevision: draft.draftRevision }, author)).rejects.toMatchObject({
      code: 'DUNGEON_INVALID',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'scene_sprite_artwork_missing' })]),
    });
    await expect(sprites.create('missing_copy', { name: 'Copy', assetId: image.id }, author)).rejects.toMatchObject({
      code: 'SCENE_SPRITE_INVALID',
    });
    expect((await w.content.get(d.key))?.draft.rooms[0]?.actions[0]?.sceneSprites).toHaveLength(1);
  });
  it('blocks sprite packages explicitly and validates missing artwork before publication', async () => {
    await expect(w.content.exportPackage('scene_room', 'draft', author)).rejects.toMatchObject({
      code: 'DUNGEON_INVALID',
      issues: [
        expect.objectContaining({
          message: expect.stringContaining('temporarily unavailable'),
        }),
      ],
    });
    await expect(w.content.exportPackage('scene_room', 'published', author)).rejects.toMatchObject({
      code: 'DUNGEON_INVALID',
    });
    const d = singleRoomDungeon(
      [
        {
          id: 'rest',
          type: 'rest',
          sceneSprites: [{ id: 'missing', spriteKey: 'missing' }],
        },
      ],
      (d) => {
        d.key = 'missing_scene_sprite';
      },
    );
    const draft = await w.content.create({ definition: d }, author);
    expect(draft.issues).toContainEqual(
      expect.objectContaining({
        code: 'scene_sprite_missing',
        path: 'rooms[0].actions[0].sceneSprites[0].spriteKey',
      }),
    );
    await expect(w.content.publish(d.key, { expectedRevision: draft.draftRevision }, author)).rejects.toMatchObject({
      code: 'DUNGEON_INVALID',
    });
  });
});
