/**
 * The large picture on a Delve screen.
 *
 * Every image reference resolves by the same rule — a managed asset while it
 * is active, else the shipped path under `assets/`, else nothing — and every
 * failure (a disabled or deleted asset, a missing file, an image that will
 * not decode) is skipped, so a screen falls through to the next candidate and
 * finally to text. Artwork is decoration; it never costs a player a screen.
 *
 * ## Precedence — a fight (combat, elite, miniboss, boss)
 *
 *   1. the **composed scene**: the node's snapshotted background (else the
 *      zone background) with the run's Buddy on the reserved left side and
 *      the enemy's sprite layered over it;
 *   2. the enemy's full artwork;
 *   3. the node's snapshotted background on its own;
 *   4. the zone artwork;
 *   5. the zone background;
 *   6. text only.
 *
 * ## Precedence — event, rest, reward, exit
 *
 *   1. the event's own artwork;
 *   2. the node's snapshotted background on its own;
 *   3. the zone artwork;
 *   4. the zone background;
 *   5. text only.
 *
 * An enemy is never composed onto a node that is not a fight — and neither is
 * the Buddy: she is in the picture only where the composed fight scene is.
 * Her card art stays the thumbnail throughout; that is the caller's.
 *
 * ## The player's Buddy
 *
 * A reserved runtime actor, never authored into a zone, room or enemy. Who she
 * is comes from the run's fighter snapshot (`view.fighter.speciesSlug`, frozen
 * at start — never the player's live active Buddy), her image from the species
 * sprite convention `waifumon/<slug>/<slug>_sprite.webp`, and where she stands
 * from the compositor (`layoutPlayerBuddy`). A species with no sprite file is
 * logged once and the scene is composed without her; her card art is never
 * substituted.
 *
 * Which background a node has, which sprite an enemy has and where it stands
 * all come from the run's snapshot (`DungeonRunView`), so a screen never
 * chooses — it only renders. A composed scene is rendered once and cached
 * (`sceneComposition.ts`); later screens attach the cached file.
 */
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { ARTWORK_MIME_EXTENSIONS } from '../modules/artworkAssets/imageInspection';
import type { SpritePlacement } from '../modules/artworkAssets/scenePlacement';
import type { SceneLayer } from '../modules/artworkAssets/sceneComposition';
import { playerBuddySpriteLayer, resolveArtworkLayer, type ArtworkRef } from '../modules/artworkAssets/sceneLayers';
import { speciesDungeonSpritePath } from '../modules/assets/speciesArtworkFile';
import { locateCombatArtwork } from '../modules/combat/combatArtwork';
import type { DungeonRunView } from '../modules/dungeons/dungeonPlayService';
import type { TrialArtwork } from './combatTrialPresenter';
import type { AppContext } from './types';

type ArtContext = Pick<AppContext, 'config' | 'services' | 'logger'>;

function attachment(source: string | Buffer, name: string): TrialArtwork {
  return { file: new AttachmentBuilder(source, { name }), url: `attachment://${name}` };
}

/** A shipped file under `assets/`, named after the file that was found. */
function shippedArtwork(ctx: ArtContext, relative: string | null | undefined): TrialArtwork | null {
  const found = locateCombatArtwork(ctx.config.assetsDir, relative);
  if (found.status !== 'available') return null;
  const base = path.basename(found.absolutePath, path.extname(found.absolutePath)).replace(/[^A-Za-z0-9]+/g, '-');
  return attachment(found.absolutePath, `dungeon-${base}.${found.extension}`);
}

/** A managed asset's own bytes. The name carries the hash, so a replacement is a new file to Discord. */
async function managedArtwork(ctx: ArtContext, assetId: string | null | undefined): Promise<TrialArtwork | null> {
  if (!assetId || !ctx.services.artworkAssets) return null;
  const found = await ctx.services.artworkAssets.readUsable(assetId);
  if (!found) return null;
  const { asset, bytes } = found;
  return attachment(bytes, `dungeon-art-${asset.contentHash.slice(0, 12)}.${ARTWORK_MIME_EXTENSIONS[asset.mimeType]}`);
}

/** One reference as it is: the managed asset, else the shipped file. */
async function plainArtwork(ctx: ArtContext, ref: ArtworkRef): Promise<TrialArtwork | null> {
  return (await managedArtwork(ctx, ref.assetId)) ?? shippedArtwork(ctx, ref.artworkPath);
}

/** Species already warned about, so a missing sprite is one log line, not one per screen. */
const warnedMissingBuddySprites = new Set<string>();

/** The run's Buddy as a scene layer, from the species sprite convention. Null — and a warning — when she has none. */
function playerBuddyActor(ctx: ArtContext, speciesSlug: string | null | undefined): { layer: SceneLayer; label: string } | null {
  if (!speciesSlug) return null;
  const layer = playerBuddySpriteLayer(ctx.config.assetsDir, speciesSlug);
  if (layer) return { layer, label: speciesSlug };
  if (!warnedMissingBuddySprites.has(speciesSlug)) {
    warnedMissingBuddySprites.add(speciesSlug);
    ctx.logger.warn(
      { tag: 'dungeons/buddy-sprite-missing', speciesSlug, expectedPath: speciesDungeonSpritePath(speciesSlug) },
      'dungeon Buddy sprite not found — fight scenes for this species render without her',
    );
  }
  return null;
}

/** A background, optionally with a sprite (and the player's Buddy) over it, through the shared compositor. */
async function composedArtwork(
  ctx: ArtContext,
  backgrounds: readonly (ArtworkRef | null | undefined)[],
  sprite?: { ref: ArtworkRef; placement: SpritePlacement },
  playerBuddy?: { layer: SceneLayer; label: string } | null,
): Promise<TrialArtwork | null> {
  const scenes = ctx.services.sceneComposition;
  if (!scenes) return null;
  const deps = { assets: ctx.services.artworkAssets, assetsDir: ctx.config.assetsDir };
  const spriteLayer = sprite ? await resolveArtworkLayer(deps, sprite.ref) : null;
  if (sprite && !spriteLayer) return null;
  for (const ref of backgrounds) {
    if (!ref) continue;
    const background = await resolveArtworkLayer(deps, ref);
    if (!background) continue;
    const scene = await scenes.compose({
      background,
      sprite: spriteLayer && sprite ? { layer: spriteLayer, placement: sprite.placement } : null,
      playerBuddy: playerBuddy ?? null,
    });
    if (scene) return attachment(scene.absolutePath, `dungeon-scene-${scene.cacheKey.slice(0, 16)}.webp`);
  }
  return null;
}

/** The first candidate that produces a picture. A candidate that throws is logged and skipped. */
async function firstArtwork(
  ctx: ArtContext,
  candidates: readonly (() => Promise<TrialArtwork | null> | TrialArtwork | null)[],
): Promise<TrialArtwork | null> {
  for (const candidate of candidates) {
    try {
      const found = await candidate();
      if (found) return found;
    } catch (err) {
      ctx.logger.warn({ err, tag: 'dungeons/artwork-failed' }, 'dungeon artwork candidate failed — trying the next');
    }
  }
  return null;
}

/** Zone artwork, then the zone background, then nothing — the home and zone screens. */
export async function dungeonZoneArtwork(
  ctx: ArtContext,
  zones: readonly {
    artworkPath: string | null;
    backgroundArtworkPath: string | null;
    artworkAssetId?: string | null;
    backgroundAssetId?: string | null;
  }[],
): Promise<TrialArtwork | null> {
  return firstArtwork(
    ctx,
    zones.flatMap((zone) => [
      () => plainArtwork(ctx, { assetId: zone.artworkAssetId, artworkPath: zone.artworkPath }),
      () => plainArtwork(ctx, { assetId: zone.backgroundAssetId, artworkPath: zone.backgroundArtworkPath }),
    ]),
  );
}

/** The scene for a run's current node. See the module comment for the order. */
export async function dungeonRunSceneArtwork(ctx: ArtContext, view: DungeonRunView): Promise<TrialArtwork | null> {
  const { node, zone } = view;
  const zoneArt: ArtworkRef = { assetId: zone.artworkAssetId, artworkPath: zone.artworkPath };
  const zoneBackground: ArtworkRef = { assetId: zone.backgroundAssetId, artworkPath: zone.backgroundArtworkPath };
  const nodeBackground: ArtworkRef | null = node.background && {
    assetId: node.background.assetId,
    artworkPath: node.background.artworkPath,
  };
  const tail = [
    () => composedArtwork(ctx, [nodeBackground]),
    () => plainArtwork(ctx, zoneArt),
    () => plainArtwork(ctx, zoneBackground),
  ];

  const enemy = node.enemy;
  if (enemy) {
    const { visual } = enemy;
    const sprite: ArtworkRef = { assetId: visual.spriteAssetId, artworkPath: visual.spriteArtworkPath };
    return firstArtwork(ctx, [
      () =>
        sprite.assetId || sprite.artworkPath
          ? composedArtwork(
              ctx,
              [nodeBackground, zoneBackground],
              { ref: sprite, placement: visual.spritePlacement },
              playerBuddyActor(ctx, view.fighter?.speciesSlug),
            )
          : null,
      () => plainArtwork(ctx, { assetId: visual.artworkAssetId, artworkPath: visual.artworkPath }),
      ...tail,
    ]);
  }
  return firstArtwork(ctx, [() => shippedArtwork(ctx, node.event?.artworkPath), ...tail]);
}
