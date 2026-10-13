import { describe, expect, it } from 'vitest';
import { singleRoomDungeon } from '../../helpers/dungeonFixtures';
import { validateDungeonDefinition } from '../../../src/modules/dungeons/validation/dungeonValidation';
import { dungeonDependencies, DungeonDefinitionSchema } from '../../../src/modules/dungeons/content/dungeonDefinition';
import {
  buildDungeonPackage,
  dungeonContentHash,
  readDungeonPackage,
} from '../../../src/modules/dungeons/package/dungeonPackage';
import {
  SceneSpriteInputSchema,
  resolveSceneSpriteInstance,
} from '../../../src/modules/dungeons/sceneSprites/sceneSpriteDefinition';
import {
  freezeSceneSprites,
  sceneSpritesForRoom,
  type SceneSpriteCatalogue,
} from '../../../src/modules/dungeons/sceneSprites/sceneSpriteSnapshot';

const sprite = {
  ...SceneSpriteInputSchema.parse({
    name: 'Chest',
    assetId: '12345678-1234-1234-1234-123456789abc',
  }),
  contentHash: 'a'.repeat(64),
  artworkCategory: 'dungeon_scene_sprite',
  archived: false,
  usable: true,
};
const catalogue: SceneSpriteCatalogue = new Map([['chest', sprite]]);
const base = () => singleRoomDungeon([{ id: 'rest', type: 'rest' }]);
describe('Dungeon scene placements and compatibility', () => {
  it('keeps optional fields absent, legacy hashes and package envelopes unchanged', () => {
    const d = base();
    expect(DungeonDefinitionSchema.parse(d).rooms[0]).not.toHaveProperty('sceneSprites');
    expect(DungeonDefinitionSchema.parse(d).rooms[0]?.actions[0]).not.toHaveProperty('sceneSprites');
    const withUndefined = {
      ...d,
      rooms: d.rooms.map((r) => ({
        ...r,
        sceneSprites: undefined,
        actions: r.actions.map((a) => ({ ...a, sceneSprites: undefined })),
      })),
    };
    expect(dungeonContentHash(d)).toBe(dungeonContentHash(withUndefined));
    const options = {
      source: {
        environment: 'test',
        origin: 'draft' as const,
        draftRevision: 1,
        publishedRevision: null,
      },
      packageId: '12345678-1234-1234-1234-123456789abc',
      exportedAt: new Date('2026-01-01'),
    };
    expect(buildDungeonPackage({ ...options, definition: withUndefined })).toEqual(
      buildDungeonPackage({ ...options, definition: d }),
    );
  });
  it('combines room and activity instances, allows repeated sprites, and applies independent partial overrides', () => {
    const d = base();
    d.rooms[0]!.sceneSprites = [
      { id: 'one', spriteKey: 'chest' },
      {
        id: 'two',
        spriteKey: 'chest',
        placement: { offsetX: 70 },
        mirror: true,
      },
    ];
    d.rooms[0]!.actions[0]!.sceneSprites = [
      {
        id: 'three',
        spriteKey: 'chest',
        visualLayer: 'foreground',
        placement: { scaleBasisPoints: 2000 },
      },
    ];
    const snapshot = freezeSceneSprites(d, catalogue);
    const scene = sceneSpritesForRoom(d, d.rooms[0]!.id, 'rest', snapshot);
    expect(scene).toHaveLength(3);
    expect(scene[0]?.placement.offsetX).toBe(0);
    expect(scene[1]?.placement.offsetX).toBe(70);
    expect(scene[1]?.mirror).toBe(true);
    expect(scene[2]).toMatchObject({
      visualLayer: 'foreground',
      placement: { scaleBasisPoints: 2000, anchor: 'bottom-center' },
    });
    expect(sprite.placement.offsetX).toBe(0);
    expect(sceneSpritesForRoom(d, d.rooms[0]!.id, undefined, snapshot)).toHaveLength(2);
    expect(dungeonDependencies(d, catalogue)).toMatchObject({
      sceneSprites: ['chest'],
      artwork: [
        {
          kind: 'managed',
          contentHash: sprite.contentHash,
          category: 'dungeon_scene_sprite',
          name: 'Chest',
        },
      ],
    });
    expect(
      resolveSceneSpriteInstance(sprite, {
        id: 'other',
        spriteKey: 'chest',
        mirror: false,
      }).mirror,
    ).toBe(false);
  });
  it.each(['combat', 'boss', 'reward', 'event', 'rest', 'gate', 'leave', 'set_flag'])(
    'stores visual placement on %s without new action mechanics',
    (type) => {
      const fields =
        type === 'combat' || type === 'boss'
          ? { waves: [{ enemy: { key: 'rat' } }] }
          : type === 'reward'
            ? { reward: {} }
            : type === 'event'
              ? { source: { kind: 'event', eventId: 'story' } }
              : type === 'gate'
                ? { requires: { type: 'flag', flag: 'lever' } }
                : type === 'set_flag'
                  ? { flag: 'flag' }
                  : {};
      const d = DungeonDefinitionSchema.parse({
        ...base(),
        rooms: [
          {
            id: 'hall',
            kind: 'exit',
            actions: [
              {
                id: 'action',
                type,
                ...fields,
                sceneSprites: [{ id: 'one', spriteKey: 'chest' }],
              },
            ],
          },
        ],
      });
      expect(d.rooms[0]?.actions[0]?.sceneSprites).toHaveLength(1);
    },
  );
  it('reports missing, archived and unavailable artwork at navigable instance paths', () => {
    for (const [cat, code] of [
      [new Map(), 'scene_sprite_missing'],
      [new Map([['chest', { ...sprite, archived: true }]]), 'scene_sprite_archived'],
      [new Map([['chest', { ...sprite, usable: false }]]), 'scene_sprite_artwork_missing'],
    ] as const) {
      const d = base();
      d.rooms[0]!.actions[0]!.sceneSprites = [{ id: 'one', spriteKey: 'chest' }];
      expect(validateDungeonDefinition(d, { sceneSprites: cat }).issues).toContainEqual(
        expect.objectContaining({
          code,
          severity: 'error',
          path: expect.stringContaining('rooms[0].actions[0].sceneSprites[0]'),
        }),
      );
    }
  });
  it.each([
    { placement: { offsetX: 601 } },
    { placement: { offsetY: -338 } },
    { placement: { scaleBasisPoints: 999 } },
    { visualLayer: 'invalid' },
  ])('rejects invalid placement %j', (override) => {
    const d = base();
    const raw = {
      ...d,
      rooms: [
        {
          ...d.rooms[0],
          sceneSprites: [{ id: 'one', spriteKey: 'chest', ...override }],
        },
      ],
    };
    expect(
      validateDungeonDefinition(raw).issues.some((i) => i.severity === 'error' && i.path.includes('sceneSprites')),
    ).toBe(true);
  });
  it('bounds each scope to five and refuses duplicate instance IDs within a scope', () => {
    const d = base();
    d.rooms[0]!.sceneSprites = Array.from({ length: 6 }, (_, i) => ({
      id: `one_${i}`,
      spriteKey: 'chest',
    }));
    expect(validateDungeonDefinition(d).definition).toBeNull();
    d.rooms[0]!.sceneSprites = [
      { id: 'one', spriteKey: 'chest' },
      { id: 'one', spriteKey: 'chest' },
    ];
    expect(validateDungeonDefinition(d).issues.some((i) => i.code === 'scene_sprite_duplicate_instance')).toBe(true);
  });
  it('refuses export and import instead of silently omitting sprite dependencies', () => {
    const d = base();
    const pkg = buildDungeonPackage({
      definition: d,
      source: {
        environment: 'test',
        origin: 'draft',
        draftRevision: 1,
        publishedRevision: null,
      },
    });
    d.rooms[0]!.sceneSprites = [{ id: 'one', spriteKey: 'chest' }];
    expect(() => buildDungeonPackage({ definition: d, source: pkg.source })).toThrow(/Scene Sprites/);
    expect(
      readDungeonPackage({
        ...pkg,
        dungeon: d,
        contentHash: dungeonContentHash(d),
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'package_scene_sprites_unsupported' })]),
    });
  });
  it('omits unavailable snapshots without crashing the render read model', () => {
    const d = base();
    d.rooms[0]!.sceneSprites = [{ id: 'one', spriteKey: 'chest' }];
    expect(sceneSpritesForRoom(d, 'Hall', 'rest', { version: 99 })).toEqual([]);
  });
});
