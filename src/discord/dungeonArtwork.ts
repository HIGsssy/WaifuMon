/**
 * The large picture on a Delve screen.
 *
 * Every image reference resolves by the same rule — a managed asset while it
 * is active, else the shipped path under `assets/`, else nothing — and every
 * failure (a disabled or deleted asset, a missing file, an image that will
 * not decode) is skipped, so a screen falls through to the next candidate and
 * finally to text. Artwork is decoration; it never costs a player a screen.
 *
 * ## Precedence — a fight (the run has an enemy in the picture)
 *
 *   1. the **composed scene** — whenever the enemy has a sprite: the room's
 *      background, else the dungeon background, else the dungeon artwork,
 *      else a plain generated stage, with the run's Buddy on the reserved
 *      left side and the enemy's sprite layered over it. A dungeon with no
 *      usable background therefore never costs an enemy its sprite;
 *   2. the enemy's full artwork, alone — only for an enemy with no usable
 *      sprite. It is an opaque scene of its own with the enemy already in it,
 *      so the Buddy is not drawn: she would look pasted over it;
 *   3. the room's background;
 *   4. the dungeon artwork;
 *   5. the dungeon background;
 *   6. text only.
 *
 * The Buddy is resolved once, on her own. She is drawn in the composed scene
 * (1) and over the backgrounds of 3–5, which are places rather than character
 * art, composed as the scene's background; never over the enemy's full
 * artwork (2). Without a Buddy sprite each of 3–5 is exactly the plain image
 * it always was.
 *
 * A fight is whenever `view.enemy` is set: the enemy about to be fought, else
 * the one just fought this step.
 *
 * ## Precedence — a WaifuMon on offer (`view.encounterActor`)
 *
 *   1. the **composed scene** — her species dungeon sprite as the scene's
 *      actor, at the activity's authored placement and mirror, with the run's
 *      Buddy and the room's Scene Sprites, on the first usable background
 *      (else the plain stage), exactly as a fight composes an enemy;
 *   2. her standard artwork, alone — as a hunt reveals her;
 *   3. the room's background (with its Scene Sprites), then the dungeon's;
 *   4. text only.
 *
 * She is drawn only while she is on offer. Once she is caught, rescued, has
 * escaped or been left, the view no longer names her and the screen falls
 * back to the ordinary room scene; a caught or rescued copy's card is the
 * caller's to show.
 *
 * ## Precedence — anything else (rest, reward, choosing a way on, the end)
 *
 *   1. the room's background on its own;
 *   2. the dungeon artwork;
 *   3. the dungeon background;
 *   4. text only.
 *
 * An enemy is never composed onto a screen that is not a fight — and neither
 * is the Buddy: she is in the picture on fights and offered encounters only.
 * Her card art stays the thumbnail throughout; that is the caller's.
 *
 * ## The player's Buddy
 *
 * A reserved runtime actor, never authored into a dungeon, room or enemy. Who she
 * is comes from the run's fighter snapshot (`view.fighter.speciesSlug`, frozen
 * at start — never the player's live active Buddy), her image from the species
 * sprite convention `waifumon/<slug>/<slug>_sprite.webp`, and where she stands
 * from the compositor (`layoutPlayerBuddy`). A species whose content says its
 * sprite faces left (`spriteFacing`) is mirrored to look at the enemy. A
 * species with no sprite file is logged once and the scene is composed without
 * her; her card art is never substituted.
 *
 * Which background a room has, which sprite an enemy has and where it stands
 * all come from the run's snapshot (`DungeonRunView`), so a screen never
 * chooses — it only renders. A composed scene is rendered once and cached
 * (`sceneComposition.ts`); later screens attach the cached file.
 */
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { ARTWORK_MIME_EXTENSIONS } from '../modules/artworkAssets/imageInspection';
import { mirrorsPlayerBuddy, type SpritePlacement } from '../modules/artworkAssets/scenePlacement';
import type { SceneLayer, SceneRequest } from '../modules/artworkAssets/sceneComposition';
import {
  composeFightScene,
  composeEnvironmentalScene,
  playerBuddySpriteLayer,
  resolveArtworkLayer,
  type ArtworkRef,
} from '../modules/artworkAssets/sceneLayers';
import { speciesDungeonSpritePath } from '../modules/assets/speciesArtworkFile';
import { artworkAttachmentUrl, resolveAppearanceAssetOrPath } from './assets/resolveAppearanceAsset';
import { locateCombatArtwork } from '../modules/combat/combatArtwork';
import type { DungeonEncounterActor, DungeonRunView } from '../modules/dungeons/dungeonRunService';
import type { TrialArtwork } from './combatTrialPresenter';
import type { AppContext } from './types';

type ArtContext = { config: Pick<AppContext['config'], 'assetsDir'>; services: Pick<AppContext['services'], 'artworkAssets' | 'sceneComposition' | 'appearance'>; logger: AppContext['logger']; content?: AppContext['content'] };
type BuddyActor = { layer: SceneLayer; mirror: boolean; label: string };

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
function playerBuddyActor(ctx: ArtContext, speciesSlug: string | null | undefined): BuddyActor | null {
  if (!speciesSlug) return null;
  const layer = playerBuddySpriteLayer(ctx.config.assetsDir, speciesSlug);
  if (layer) {
    // How the art faces is the species' own metadata; which way she should look is the scene's.
    const facing = ctx.content?.species.find((s) => s.slug === speciesSlug)?.spriteFacing;
    return { layer, mirror: mirrorsPlayerBuddy(facing), label: speciesSlug };
  }
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
  sprite?: { ref: ArtworkRef; placement: SpritePlacement } | null,
  playerBuddy?: BuddyActor | null,
  /** Answer null unless the Buddy made it into the picture. */
  options: { requireBuddy?: boolean } = {},
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
    if (scene && (scene.playerBuddy || !options.requireBuddy)) {
      return attachment(scene.absolutePath, `dungeon-scene-${scene.cacheKey.slice(0, 16)}.webp`);
    }
  }
  return null;
}

/** The enemy's sprite and the Buddy on the first usable background, else on the plain stage. */
async function spriteScene(
  ctx: ArtContext,
  backgrounds: readonly (ArtworkRef | null | undefined)[],
  sprite: ArtworkRef,
  placement: SpritePlacement,
  playerBuddy: BuddyActor | null,
  environmentalSprites?: SceneRequest['environmentalSprites'],
  mirror = false,
): Promise<TrialArtwork | null> {
  const scenes = ctx.services.sceneComposition;
  if (!scenes) return null;
  const composed = await composeFightScene(
    { assets: ctx.services.artworkAssets, assetsDir: ctx.config.assetsDir, scenes },
    { backgrounds, sprite: { ref: sprite, placement, ...(mirror ? { mirror } : {}) }, playerBuddy, ...(environmentalSprites ? { environmentalSprites } : {}) },
  );
  return composed && attachment(composed.scene.absolutePath, `dungeon-scene-${composed.scene.cacheKey.slice(0, 16)}.webp`);
}

/** Species already warned about, so a missing encounter sprite is one log line, not one per screen. */
const warnedMissingEncounterSprites = new Set<string>();

/** The offered WaifuMon as the scene's actor, with the Buddy and the room's Scene Sprites. Null when she has no sprite. */
async function encounterScene(
  ctx: ArtContext,
  backgrounds: readonly (ArtworkRef | null | undefined)[],
  actor: DungeonEncounterActor,
  playerBuddy: BuddyActor | null,
  environmentalSprites?: SceneRequest['environmentalSprites'],
): Promise<TrialArtwork | null> {
  if (!/^[a-z0-9_]+$/.test(actor.speciesSlug)) return null;
  const scene = await spriteScene(ctx, backgrounds, { artworkPath: speciesDungeonSpritePath(actor.speciesSlug) }, actor.placement, playerBuddy, environmentalSprites, actor.mirror);
  if (!scene && !warnedMissingEncounterSprites.has(actor.speciesSlug)) {
    warnedMissingEncounterSprites.add(actor.speciesSlug);
    ctx.logger.warn(
      { tag: 'dungeons/encounter-sprite-missing', speciesSlug: actor.speciesSlug, expectedPath: speciesDungeonSpritePath(actor.speciesSlug) },
      'dungeon encounter sprite not found — showing her standard artwork instead',
    );
  }
  return scene;
}

/**
 * A species' standard artwork as her default appearance — what a hunt shows
 * before there is a copy to draw a card for. Null when there is none.
 */
export function speciesArtwork(ctx: ArtContext, speciesSlug: string | null | undefined): TrialArtwork | null {
  const species = speciesSlug ? ctx.content?.species.find((s) => s.slug === speciesSlug) : undefined;
  const appearance = ctx.services.appearance;
  if (!species || !appearance) return null;
  const file = resolveAppearanceAssetOrPath(ctx, appearance.currentAppearance(species, null).assetId, species.imagePath);
  return file && { file, url: artworkAttachmentUrl(file) };
}

/**
 * A fallback picture with the Buddy in front of it — the picture as the
 * scene's background — or, when she has no sprite or cannot be drawn, the
 * picture exactly as it is.
 */
async function artworkWithBuddy(ctx: ArtContext, ref: ArtworkRef, buddy: BuddyActor | null): Promise<TrialArtwork | null> {
  if (buddy) {
    const composed = await composedArtwork(ctx, [ref], null, buddy, { requireBuddy: true });
    if (composed) return composed;
  }
  return plainArtwork(ctx, ref);
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

/** Dungeon artwork, then the dungeon background, then nothing — the home and dungeon screens. */
export async function dungeonZoneArtwork(
  ctx: ArtContext,
  dungeons: readonly { artwork: ArtworkRef; background: ArtworkRef }[],
): Promise<TrialArtwork | null> {
  return firstArtwork(
    ctx,
    dungeons.flatMap((dungeon) => [() => plainArtwork(ctx, dungeon.artwork), () => plainArtwork(ctx, dungeon.background)]),
  );
}

/** The scene for where a run stands. See the module comment for the order. */
export async function dungeonRunSceneArtwork(ctx: ArtContext, view: Pick<DungeonRunView, 'dungeon' | 'roomBackground' | 'sceneSprites' | 'eventArtwork' | 'encounterActor' | 'enemy'> & { fighter: Pick<DungeonRunView['fighter'], 'speciesSlug'> }): Promise<TrialArtwork | null> {
  const { artwork: dungeonArt, background: dungeonBackground } = view.dungeon;
  const roomBackground: ArtworkRef | null = view.roomBackground ?? null;
  if (view.sceneSprites?.length && ctx.services.sceneComposition) {
    const environmentalSprites: NonNullable<SceneRequest['environmentalSprites']>[number][] = [];
    for (const visual of view.sceneSprites) {
      try {
        const layer = await ctx.services.artworkAssets?.layer(visual.assetId);
        if (layer && layer.hash === visual.contentHash) environmentalSprites.push({ layer, placement: visual.placement, mirror: visual.mirror, visualLayer: visual.visualLayer });
      } catch (err) { ctx.logger.warn({ err, tag: 'dungeons/scene-sprite-unavailable' }, 'Scene sprite artwork unavailable — skipped'); }
    }
    const scenes = ctx.services.sceneComposition;
    const deps = { assets: ctx.services.artworkAssets, assetsDir: ctx.config.assetsDir, scenes };
    const compose = async (backgrounds: (ArtworkRef | null | undefined)[], buddy?: BuddyActor | null) => {
      const rendered = await composeEnvironmentalScene(deps, { backgrounds, environmentalSprites, playerBuddy: buddy });
      return rendered && attachment(rendered.scene.absolutePath, `dungeon-scene-${rendered.scene.cacheKey.slice(0, 16)}.webp`);
    };
    if (view.eventArtwork) return compose([view.eventArtwork, roomBackground, dungeonBackground, dungeonArt]);
    const actor = view.encounterActor;
    if (actor) {
      const buddy = playerBuddyActor(ctx, view.fighter?.speciesSlug);
      return firstArtwork(ctx, [
        () => encounterScene(ctx, [roomBackground, dungeonBackground, dungeonArt], actor, buddy, environmentalSprites),
        () => speciesArtwork(ctx, actor.speciesSlug),
        () => compose([roomBackground, dungeonBackground, dungeonArt]),
      ]);
    }
    if (view.enemy) {
      const visual = view.enemy.visual;
      const buddy = playerBuddyActor(ctx, view.fighter?.speciesSlug);
      return firstArtwork(ctx, [
        () => spriteScene(ctx, [roomBackground, dungeonBackground, dungeonArt], { assetId: visual.spriteAssetId, artworkPath: visual.spriteArtworkPath }, visual.spritePlacement, buddy, environmentalSprites),
        async () => {
          const full = { assetId: visual.artworkAssetId, artworkPath: visual.artworkPath };
          if (!await resolveArtworkLayer(deps, full)) return null;
          return compose([full]);
        },
        () => compose([roomBackground, dungeonBackground, dungeonArt], buddy),
      ]);
    }
    return compose([roomBackground, dungeonBackground, dungeonArt]);
  }


  // An offered event shows its own picture, as uploaded: no stage and no Buddy over it.
  // Without one (or if it cannot be read) the room, then the dungeon, stand in.
  // (`eventArtwork` is on the view exactly when an event is offered.)
  const eventArt = view.eventArtwork;
  if (eventArt) {
    return firstArtwork(ctx, [
      () => plainArtwork(ctx, eventArt),
      () => (roomBackground ? plainArtwork(ctx, roomBackground) : null),
      () => plainArtwork(ctx, dungeonBackground),
      () => plainArtwork(ctx, dungeonArt),
    ]);
  }

  const actor = view.encounterActor;
  if (actor) {
    const buddy = playerBuddyActor(ctx, view.fighter?.speciesSlug);
    return firstArtwork(ctx, [
      () => encounterScene(ctx, [roomBackground, dungeonBackground, dungeonArt], actor, buddy),
      () => speciesArtwork(ctx, actor.speciesSlug),
      () => composedArtwork(ctx, [roomBackground]),
      () => plainArtwork(ctx, dungeonArt),
      () => plainArtwork(ctx, dungeonBackground),
    ]);
  }

  const enemy = view.enemy;
  if (enemy) {
    const { visual } = enemy;
    const sprite: ArtworkRef = { assetId: visual.spriteAssetId, artworkPath: visual.spriteArtworkPath };
    // Resolved once and on her own: nothing below decides whether she is drawn.
    const buddy = playerBuddyActor(ctx, view.fighter?.speciesSlug);
    return firstArtwork(ctx, [
      () => (sprite.assetId || sprite.artworkPath ? spriteScene(ctx, [roomBackground, dungeonBackground, dungeonArt], sprite, visual.spritePlacement, buddy) : null),
      // Full character art is shown as it is: no Buddy over an opaque scene.
      () => plainArtwork(ctx, { assetId: visual.artworkAssetId, artworkPath: visual.artworkPath }),
      () => composedArtwork(ctx, [roomBackground], null, buddy),
      () => artworkWithBuddy(ctx, dungeonArt, buddy),
      () => artworkWithBuddy(ctx, dungeonBackground, buddy),
    ]);
  }
  return firstArtwork(ctx, [
    () => composedArtwork(ctx, [roomBackground]),
    () => plainArtwork(ctx, dungeonArt),
    () => plainArtwork(ctx, dungeonBackground),
  ]);
}
