/**
 * Drawing one card master — the expensive half of a render, extracted so it
 * can run somewhere other than the main thread.
 *
 * This is verbatim the work the renderer used to do inline. It was lifted out
 * for one reason: it contains two **synchronous** resvg rasterizations of a
 * 1500×2250 canvas (see `renderVectorLayer`), and a single call blocks the
 * Node event loop for roughly 750 ms. This process hosts Fastify *and* the
 * Discord gateway, so that stall is every command's latency and every
 * request's p99.
 *
 * Nothing here knows where it is running. It takes a loader and an input and
 * returns bytes, which is exactly what makes it hostable in a worker thread
 * without the worker learning anything about caching, dedupe or HTTP — and
 * what keeps the in-process path (`workers: 0`) byte-identical to the worker
 * path, since both call this same function.
 *
 * The plan step is pure and synchronous: every coordinate is decided before a
 * pixel is touched, which is what makes the layout testable without rendering.
 */
import type { CardAssetLoader } from '../assets/loader';
import { effectiveCardMeta, effectiveLevel, effectiveOwned } from '../cache/cacheKey';
import {
  buildOverlaySvg,
  buildUnderlaySvg,
  planArtworkCrop,
  planIconPlacement,
  planOwnedBadge,
  type ComposeCardInput,
  type RasterPlacement,
} from '../composer/cardComposer';
import { readArtwork } from '../contentHash';
import {
  compositeMasterWebp,
  imageSize,
  renderArtwork,
  renderFrame,
  renderPlacement,
  renderVectorLayer,
} from './renderer';
import type { CardRenderInput } from '../types';
import { CARD_MASTER_HEIGHT, CARD_MASTER_WIDTH } from '../version';
import type { Logger } from '../../../shared/logger';

const CANVAS = { width: CARD_MASTER_WIDTH, height: CARD_MASTER_HEIGHT } as const;

/**
 * Draws one card master and returns the encoded WebP.
 *
 * Reads first (all memoized in the loader after the first card), then plans the
 * layout from the frame's geometry, then rasterizes.
 */
export async function renderMasterBytes(
  loader: CardAssetLoader,
  input: CardRenderInput,
  logger?: Logger | undefined,
): Promise<Buffer> {
  const { rarity, race, affinity } = input.species;
  const owned = effectiveOwned(input);

  const [geometry, frameBytes, raceIcon, affinityIcon, rarityIcon, artwork, ownedBadgeBytes] =
    await Promise.all([
      loader.frameGeometry(rarity),
      loader.frame(rarity),
      loader.raceIcon(race),
      loader.affinityIcon(affinity),
      loader.rarityIcon(rarity),
      readArtwork(input.variant.artworkAbsolutePath, {
        speciesSlug: input.species.slug,
        appearanceId: input.variant.appearanceId,
      }),
      owned ? loader.ownedBadge() : Promise.resolve(undefined),
    ]);

  const card = effectiveCardMeta(input);
  const composeInput: ComposeCardInput = {
    geometry,
    name: input.species.name,
    race,
    affinity,
    rarity,
    level: effectiveLevel(input),
    description: input.species.description ?? null,
    card,
    icons: { race: raceIcon, affinity: affinityIcon, rarity: rarityIcon },
    ...(ownedBadgeBytes === undefined ? {} : { ownedBadge: ownedBadgeBytes }),
  };

  const placements: RasterPlacement[] = [
    planIconPlacement(geometry.circles.race, raceIcon),
    planIconPlacement(geometry.circles.affinity, affinityIcon),
    planIconPlacement(geometry.circles.rarity, rarityIcon),
  ];
  if (ownedBadgeBytes !== undefined) {
    placements.push(planOwnedBadge(geometry.art, ownedBadgeBytes, await imageSize(ownedBadgeBytes)));
  }

  const fontFiles = loader.fontPaths();
  const crop = planArtworkCrop(await imageSize(artwork), geometry.art);

  const [artworkLayer, frameLayer, ...placementLayers] = await Promise.all([
    renderArtwork(artwork, crop),
    renderFrame(frameBytes),
    ...placements.map((placement) => renderPlacement(placement)),
  ]);

  const master = await compositeMasterWebp({
    artwork: artworkLayer as Buffer,
    artWindow: geometry.art,
    underlay: renderVectorLayer(buildUnderlaySvg(geometry, CANVAS), fontFiles, 'plate'),
    frame: frameLayer as Buffer,
    placements: placementLayers.map((bytes, index) => ({
      bytes: bytes as Buffer,
      left: (placements[index] as RasterPlacement).left,
      top: (placements[index] as RasterPlacement).top,
    })),
    overlay: renderVectorLayer(buildOverlaySvg(composeInput, CANVAS), fontFiles, 'text'),
  });

  logger?.debug(
    {
      tag: 'card-renderer/master',
      slug: input.species.slug,
      rarity,
      race,
      affinity,
      owned,
      width: CARD_MASTER_WIDTH,
      height: CARD_MASTER_HEIGHT,
    },
    'Rendered card master',
  );

  return master;
}
