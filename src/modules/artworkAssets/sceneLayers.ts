/**
 * Turning an artwork reference into a {@link SceneLayer}, by the one
 * precedence every surface shares:
 *
 *     managed asset (active)  →  shipped artwork path  →  nothing
 *
 * A managed asset that is unset, disabled, deleted or whose file is gone
 * falls through to the shipped path; a shipped path that is unsafe or missing
 * falls through to nothing. Never throws.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { locateArtworkFile } from '../assets/artworkFile';
import { speciesDungeonSpritePath } from '../assets/speciesArtworkFile';
import type { ArtworkAssetService } from './artworkAssetService';
import type { ComposedScene, SceneCompositionService, SceneLayer, SceneRequest } from './sceneComposition';
import { SCENE_HEIGHT, SCENE_WIDTH, type SpritePlacement } from './scenePlacement';

/** Either or both of a managed asset id and a shipped path. */
export interface ArtworkRef {
  assetId?: string | null | undefined;
  artworkPath?: string | null | undefined;
}

/**
 * A shipped file under `assets/` as a layer. Its hash is the path plus the
 * file's size and modification time — cheap, and it changes when a deploy
 * replaces the file.
 */
export function shippedArtworkLayer(assetsDir: string, relativePath: string | null | undefined): SceneLayer | null {
  if (!relativePath) return null;
  const located = locateArtworkFile(assetsDir, relativePath);
  if (located.status !== 'available') return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(located.absolutePath);
  } catch {
    return null;
  }
  const hash = createHash('sha256').update(`shipped:${relativePath}:${stat.size}:${stat.mtimeMs}`).digest('hex');
  return { hash, load: () => readFile(located.absolutePath).catch(() => null) };
}

/**
 * A species' dungeon sprite (`waifumon/<slug>/<slug>_sprite.webp`) as the
 * player-Buddy layer of a fight scene. Null when the file is not there — or
 * the slug is not one — so the scene is composed without her.
 */
export function playerBuddySpriteLayer(assetsDir: string, speciesSlug: string | null | undefined): SceneLayer | null {
  if (!speciesSlug || !/^[a-z0-9_]+$/.test(speciesSlug)) return null;
  return shippedArtworkLayer(assetsDir, speciesDungeonSpritePath(speciesSlug));
}

export async function resolveArtworkLayer(
  deps: { assets?: Pick<ArtworkAssetService, 'layer'> | undefined; assetsDir: string },
  ref: ArtworkRef,
  options: { includeDisabled?: boolean } = {},
): Promise<SceneLayer | null> {
  const managed = await deps.assets?.layer(ref.assetId, options);
  return managed ?? shippedArtworkLayer(deps.assetsDir, ref.artworkPath);
}

/**
 * A plain, dark stage for a fight whose dungeon has no usable background at
 * all: an enemy's sprite is still shown as a sprite, standing beside the
 * Buddy, rather than being dropped for its full artwork. Generated, never
 * authored — a soft top-to-bottom gradient with a darker floor.
 */
export function plainBackdropLayer(): SceneLayer {
  return {
    hash: 'backdrop:plain:v1',
    async load() {
      const top = [44, 40, 58];
      const bottom = [18, 16, 26];
      const floor = Math.round(SCENE_HEIGHT * 0.86);
      const pixels = Buffer.alloc(SCENE_WIDTH * SCENE_HEIGHT * 3);
      for (let y = 0; y < SCENE_HEIGHT; y++) {
        const t = y / (SCENE_HEIGHT - 1);
        const shade = y >= floor ? 0.72 : 1;
        const row = top.map((c, i) => Math.round((c + (bottom[i]! - c) * t) * shade));
        for (let x = 0; x < SCENE_WIDTH; x++) pixels.set(row, (y * SCENE_WIDTH + x) * 3);
      }
      return sharp(pixels, { raw: { width: SCENE_WIDTH, height: SCENE_HEIGHT, channels: 3 } }).png().toBuffer();
    },
  };
}

/** Which background a fight scene was drawn on: the index of the candidate that resolved, or the plain stage. */
export type FightSceneBackground = number | 'plain';

/**
 * The fight scene for an enemy that has a sprite: the first background that
 * resolves, else the plain stage, with the Buddy and the sprite over it. Null
 * only when the sprite itself is unavailable (the caller then falls back to
 * the enemy's full artwork) or nothing would render. Shared by the Discord
 * screens and the editor's preview, so a preview is what a player sees.
 */
export async function composeFightScene(
  deps: {
    assets?: Pick<ArtworkAssetService, 'layer'> | undefined;
    assetsDir: string;
    scenes: Pick<SceneCompositionService, 'compose'>;
  },
  input: {
    backgrounds: readonly (ArtworkRef | null | undefined)[];
    sprite: { ref: ArtworkRef; placement: SpritePlacement };
    playerBuddy?: SceneRequest['playerBuddy'];
  },
): Promise<{ scene: ComposedScene; background: FightSceneBackground } | null> {
  const spriteLayer = await resolveArtworkLayer(deps, input.sprite.ref);
  if (!spriteLayer) return null;
  const candidates: { layer: SceneLayer; background: FightSceneBackground }[] = [];
  for (const [index, ref] of input.backgrounds.entries()) {
    const layer = ref ? await resolveArtworkLayer(deps, ref) : null;
    if (layer) candidates.push({ layer, background: index });
  }
  candidates.push({ layer: plainBackdropLayer(), background: 'plain' });
  for (const candidate of candidates) {
    const scene = await deps.scenes.compose({
      background: candidate.layer,
      sprite: { layer: spriteLayer, placement: input.sprite.placement },
      playerBuddy: input.playerBuddy ?? null,
    });
    if (scene) return { scene, background: candidate.background };
  }
  return null;
}
