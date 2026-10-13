import { getData, postData, putData, deleteData } from './client';
import type { SpritePlacement } from './adminArtworkAssets';

export const SCENE_SPRITE_CATEGORIES = [
  'Chest',
  'Console',
  'Machinery',
  'Decoration',
  'Other',
] as const;
export interface SceneSpriteVisual {
  assetId: string;
  placement: SpritePlacement;
  mirror: boolean;
  visualLayer: 'background' | 'foreground';
}
export interface SceneSpriteInput extends SceneSpriteVisual {
  name: string;
  category: (typeof SCENE_SPRITE_CATEGORIES)[number] | null;
}
export interface SceneSpriteSummary extends SceneSpriteInput {
  key: string;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}
export interface SceneSpriteDetail extends SceneSpriteSummary {
  references: Array<{
    dungeonKey: string;
    name: string;
    source: string;
    roomId: string;
    actionId?: string;
    instanceId: string;
  }>;
  events: Array<{
    action: string;
    actor: string | null;
    createdAt: string;
    details: Record<string, unknown>;
  }>;
}
export interface SceneSpriteInstance {
  id: string;
  spriteKey: string;
  placement?: Partial<SpritePlacement>;
  mirror?: boolean;
  visualLayer?: 'background' | 'foreground';
}
export const SCENE_SPRITES_QUERY_KEY = ['admin', 'dungeon-scene-sprites'] as const;
const root = '/v1/admin/dungeons/scene-sprites';
const path = (key: string) => `${root}/${encodeURIComponent(key)}`;
export const listSceneSprites = () => getData<{ sprites: SceneSpriteSummary[] }>(root);
export const getSceneSprite = (key: string) => getData<SceneSpriteDetail>(path(key));
export const createSceneSprite = (key: string, sprite: SceneSpriteInput) =>
  postData<SceneSpriteDetail>(root, { key, sprite });
export const updateSceneSprite = (
  key: string,
  sprite: SceneSpriteInput,
  expectedRevision: number,
) => putData<SceneSpriteDetail>(path(key), { sprite, expectedRevision });
export const archiveSceneSprite = (key: string, archived: boolean, expectedRevision: number) =>
  putData<SceneSpriteDetail>(`${path(key)}/archived`, { archived, expectedRevision });
export const deleteSceneSprite = (key: string, expectedRevision: number) =>
  deleteData<{ deleted: boolean }>(`${path(key)}?expectedRevision=${expectedRevision}`);
