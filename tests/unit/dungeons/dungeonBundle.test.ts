/**
 * The pure parts of a Complete Dungeon Bundle (CP-4B): which managed category
 * a shipped dungeon image becomes, and the two definition rewrites an import
 * may apply — a shipped image rebound to its managed copy, and a Scene Sprite
 * copied under a new key. Nothing else in the definition may change.
 */
import { describe, expect, it } from 'vitest';
import { DungeonDefinitionSchema, type DungeonDefinition } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { rebindShippedArtwork, rekeySceneSprites, shippedDungeonArtworkCategory } from '../../../src/modules/dungeons/bundle/dungeonBundle';
import { singleRoomDungeon } from '../../helpers/dungeonFixtures';

const COVER = 'dungeons/zones/vault.webp';
const BACK = 'dungeons/backgrounds/vault.webp';
const managed = { kind: 'managed' as const, category: 'dungeon_background', contentHash: 'e'.repeat(64), name: 'vault.webp' };

function fixture(): DungeonDefinition {
  const d = singleRoomDungeon([{ id: 'rest', type: 'rest', sceneSprites: [{ id: 'a', spriteKey: 'chest' }, { id: 'b', spriteKey: 'lamp' }] }], (input) => {
    input.key = 'vault';
    input.artwork = { kind: 'shipped', path: COVER };
    input.rooms[0]!.background = { kind: 'shipped', path: BACK };
    input.rooms[0]!.sceneSprites = [{ id: 'room_chest', spriteKey: 'chest', placement: { offsetX: 4 } }];
  });
  return DungeonDefinitionSchema.parse(d);
}

describe('shippedDungeonArtworkCategory', () => {
  it('is dungeon_zone only for an image used solely as the cover', () => {
    const d = fixture();
    expect(shippedDungeonArtworkCategory(d, COVER)).toBe('dungeon_zone');
    expect(shippedDungeonArtworkCategory(d, BACK)).toBe('dungeon_background');
    expect(shippedDungeonArtworkCategory({ ...d, background: { kind: 'shipped', path: COVER } }, COVER)).toBe('dungeon_background');
  });
});

describe('rebindShippedArtwork', () => {
  it('swaps exactly the listed shipped paths, wherever they are used, and nothing else', () => {
    const d = fixture();
    const out = rebindShippedArtwork(d, new Map([[BACK, managed]]));
    expect(out.rooms[0]!.background).toEqual(managed);
    expect(out.artwork).toEqual({ kind: 'shipped', path: COVER });
    expect({ ...out, rooms: d.rooms }).toEqual(d);
    expect(rebindShippedArtwork(d, new Map())).toBe(d);
  });
});

describe('rekeySceneSprites', () => {
  it('points every instance of a copied sprite at its new key, room and activity alike, keeping overrides', () => {
    const out = rekeySceneSprites(fixture(), new Map([['chest', 'chest_imported']]));
    expect(out.rooms[0]!.sceneSprites).toEqual([{ id: 'room_chest', spriteKey: 'chest_imported', placement: { offsetX: 4 } }]);
    expect((out.rooms[0]!.actions[0] as { sceneSprites: unknown }).sceneSprites).toEqual([
      { id: 'a', spriteKey: 'chest_imported' },
      { id: 'b', spriteKey: 'lamp' },
    ]);
    expect(DungeonDefinitionSchema.safeParse(out).success).toBe(true);
  });
});
