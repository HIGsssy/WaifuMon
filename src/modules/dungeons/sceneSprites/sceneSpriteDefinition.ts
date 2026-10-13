/** Environmental artwork uses the same scene coordinates as enemy sprites. */
import { z } from 'zod';
import { SpritePlacementSchema } from '../../artworkAssets/scenePlacement';

export const SCENE_SPRITE_CATEGORIES = ['Chest', 'Console', 'Machinery', 'Decoration', 'Other'] as const;
export const SCENE_SPRITE_LAYERS = ['background', 'foreground'] as const;
export const SCENE_SPRITE_MAX_PLACEMENTS = 5;
export const SceneSpriteKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, 'Use lower-case letters, numbers and single underscores.');
export const SceneSpriteVisualSchema = z
  .object({
    assetId: z.string().uuid(),
    placement: SpritePlacementSchema,
    mirror: z.boolean(),
    visualLayer: z.enum(SCENE_SPRITE_LAYERS),
  })
  .strict();
export const SceneSpriteInputSchema = SceneSpriteVisualSchema.extend({
  name: z.string().trim().min(1).max(100),
  category: z.enum(SCENE_SPRITE_CATEGORIES).nullable().default(null),
  placement: SpritePlacementSchema.default({
    anchor: 'bottom-center',
    scaleBasisPoints: 5000,
  }),
  mirror: z.boolean().default(false),
  visualLayer: z.enum(SCENE_SPRITE_LAYERS).default('background'),
}).strict();
export type SceneSpriteInput = z.infer<typeof SceneSpriteInputSchema>;

/** An instance has its own identity, so the same catalogue sprite can appear twice. */
export const SceneSpriteInstanceSchema = z
  .object({
    id: SceneSpriteKeySchema,
    spriteKey: SceneSpriteKeySchema,
    placement: SpritePlacementSchema.partial().optional(),
    mirror: z.boolean().optional(),
    visualLayer: z.enum(SCENE_SPRITE_LAYERS).optional(),
  })
  .strict();
export type SceneSpriteInstance = z.infer<typeof SceneSpriteInstanceSchema>;
export type SceneSpriteVisual = z.infer<typeof SceneSpriteVisualSchema>;

export function resolveSceneSpriteInstance(
  sprite: SceneSpriteVisual,
  instance: SceneSpriteInstance,
): SceneSpriteVisual {
  return {
    assetId: sprite.assetId,
    placement: SpritePlacementSchema.parse({
      ...sprite.placement,
      ...Object.fromEntries(Object.entries(instance.placement ?? {}).filter(([, v]) => v !== undefined)),
    }),
    mirror: instance.mirror ?? sprite.mirror,
    visualLayer: instance.visualLayer ?? sprite.visualLayer,
  };
}

export type SpriteDocument = {
  rooms: readonly {
    id: string;
    sceneSprites?: readonly SceneSpriteInstance[] | undefined;
    actions: readonly {
      id: string;
      sceneSprites?: readonly SceneSpriteInstance[] | undefined;
    }[];
  }[];
};

export function sceneSpriteSites(definition: SpriteDocument): Array<{
  path: string;
  roomId: string;
  actionId?: string;
  instances: readonly SceneSpriteInstance[];
}> {
  return definition.rooms.flatMap((room, r) => [
    {
      path: `rooms[${r}].sceneSprites`,
      roomId: room.id,
      instances: room.sceneSprites ?? [],
    },
    ...room.actions.map((action, a) => ({
      path: `rooms[${r}].actions[${a}].sceneSprites`,
      roomId: room.id,
      actionId: action.id,
      instances: action.sceneSprites ?? [],
    })),
  ]);
}
export const sceneSpriteKeys = (definition: SpriteDocument) =>
  [...new Set(sceneSpriteSites(definition).flatMap((s) => s.instances.map((i) => i.spriteKey)))].sort();
export const hasSceneSprites = (definition: SpriteDocument) => sceneSpriteKeys(definition).length > 0;
