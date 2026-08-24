/**
 * The renderer itself — everything above this file is a part, this is the
 * assembly.
 *
 * ```
 *  background ──────────────────────────────────────┐
 *  artwork ── sharp cover-crop ─────────────────────┤
 *  plates SVG ── resvg ─────────────────────────────┤
 *  frame PNG ── sharp resize ───────────────────────┼─ sharp composite ─ WebP master ─┐
 *  race / affinity / rarity icons ── sharp resize ──┤                                 │
 *  owned badge (optional) ── sharp resize ──────────┤                                 │
 *  text SVG ── resvg ───────────────────────────────┘                                 │
 *                                                                                     │
 *                                                       sharp resize ─ @<width> ──────┘
 * ```
 *
 * Supplied artwork is never redrawn and never routed through the SVG
 * rasterizer: frames, icons and the badge are placed as pixels. resvg draws
 * only the two vector layers — the dark plates behind the frame's transparent
 * holes, and the dynamic text over the top.
 *
 * The master is the card's identity; a requested display width only selects
 * which file derives from it. Asking for 512px never re-runs the composite and
 * never produces a second master.
 */
import { CardAssetLoader } from './assets/loader';
import { validateCardAssets } from './assets/validation';
import {
  buildMasterKeyMaterial,
  computeMasterRenderKey as computeKey,
  effectiveCardMeta,
  effectiveLevel,
  effectiveOwned,
} from './cache/cacheKey';
import { CardDiskCache, InFlightMap } from './cache/diskCache';
import { ArtworkHashMemo } from './cache/hashMemo';
import {
  buildOverlaySvg,
  buildUnderlaySvg,
  planArtworkCrop,
  planIconPlacement,
  planOwnedBadge,
  type ComposeCardInput,
  type RasterPlacement,
} from './composer/cardComposer';
import { hashArtwork, readArtwork } from './contentHash';
import { CardOutputWidthError } from './errors';
import { DEFAULT_ASSET_ROOT, DEFAULT_CACHE_ROOT } from './paths';
import {
  compositeMasterWebp,
  imageSize,
  renderArtwork,
  renderFrame,
  renderPlacement,
  renderVectorLayer,
  resizeFromMaster,
} from './rasterizer/renderer';
import type {
  CardRenderer,
  CardRenderInput,
  CardRenderResult,
  CardRendererOptions,
  CardRendererStats,
} from './types';
import { cardEtag, CARD_MASTER_HEIGHT, CARD_MASTER_WIDTH } from './version';

const CANVAS = { width: CARD_MASTER_WIDTH, height: CARD_MASTER_HEIGHT } as const;

/** Widths the renderer will derive. Wide enough to cover the portal's buckets. */
export const MIN_OUTPUT_WIDTH = 16;
export const MAX_OUTPUT_WIDTH = 2000;

class CardRendererImpl implements CardRenderer {
  private readonly loader: CardAssetLoader;
  private readonly cache: CardDiskCache;
  private readonly hashMemo = new ArtworkHashMemo();
  private readonly masterRenders = new InFlightMap<Buffer>();
  private readonly derivativeRenders = new InFlightMap<Buffer>();
  private readonly logger: CardRendererOptions['logger'];
  private validation: Promise<void> | undefined;
  private readonly stats: CardRendererStats = {
    masterRenders: 0,
    derivativeRenders: 0,
    cacheHits: 0,
    dedupedRenders: 0,
  };

  constructor(options: CardRendererOptions = {}) {
    this.loader = new CardAssetLoader(options.assetRoot ?? DEFAULT_ASSET_ROOT);
    this.cache = new CardDiskCache(options.cacheRoot ?? DEFAULT_CACHE_ROOT, options.logger);
    this.logger = options.logger;
  }

  /** Runs once per renderer; a broken kit fails the first render, loudly. */
  validateAssets(): Promise<void> {
    this.validation ??= validateCardAssets(this.loader).catch((err: unknown) => {
      this.validation = undefined;
      throw err;
    });
    return this.validation;
  }

  hashArtwork(absolutePath: string): Promise<string> {
    return hashArtwork(absolutePath, { memo: this.hashMemo });
  }

  async computeMasterRenderKey(input: CardRenderInput): Promise<string> {
    const [artworkContentHash, kitVersion] = await Promise.all([
      hashArtwork(input.variant.artworkAbsolutePath, {
        memo: this.hashMemo,
        speciesSlug: input.species.slug,
        appearanceId: input.variant.appearanceId,
      }),
      this.loader.kitVersion(),
    ]);
    return computeKey(buildMasterKeyMaterial(input, artworkContentHash, kitVersion));
  }

  getStats(): CardRendererStats {
    return {
      ...this.stats,
      dedupedRenders: this.masterRenders.joined + this.derivativeRenders.joined,
    };
  }

  async renderCard(input: CardRenderInput): Promise<CardRenderResult> {
    await this.validateAssets();

    const width = resolveOutputWidth(input);
    const renderKey = await this.computeMasterRenderKey(input);
    const slug = input.species.slug;

    if (width === CARD_MASTER_WIDTH) {
      const masterPath = this.cache.masterPath(slug, renderKey);
      const cached = await this.cache.read(masterPath);
      if (cached) {
        this.stats.cacheHits += 1;
        return this.result(cached, renderKey, CARD_MASTER_WIDTH, CARD_MASTER_HEIGHT, true);
      }
      const bytes = await this.ensureMaster(input, renderKey, masterPath);
      return this.result(bytes, renderKey, CARD_MASTER_WIDTH, CARD_MASTER_HEIGHT, false);
    }

    const derivativePath = this.cache.derivativePath(slug, renderKey, width);
    const cachedDerivative = await this.cache.read(derivativePath);
    if (cachedDerivative) {
      this.stats.cacheHits += 1;
      return this.result(cachedDerivative, renderKey, width, derivedHeight(width), true, width);
    }

    const bytes = await this.derivativeRenders.run(`${renderKey}@${width}`, async () => {
      const masterPath = this.cache.masterPath(slug, renderKey);
      const master =
        (await this.cache.read(masterPath)) ?? (await this.ensureMaster(input, renderKey, masterPath));
      const resized = await resizeFromMaster(master, width);
      this.stats.derivativeRenders += 1;
      await this.cache.write(derivativePath, resized.bytes);
      return resized.bytes;
    });

    return this.result(bytes, renderKey, width, derivedHeight(width), false, width);
  }

  /**
   * Produces the master, collapsing concurrent identical requests onto a
   * single render. Re-checks the disk inside the critical section so a render
   * that finished while we queued is picked up instead of repeated.
   */
  private ensureMaster(
    input: CardRenderInput,
    renderKey: string,
    masterPath: string,
  ): Promise<Buffer> {
    return this.masterRenders.run(renderKey, async () => {
      const raced = await this.cache.read(masterPath);
      if (raced) return raced;

      const bytes = await this.renderMaster(input);
      this.stats.masterRenders += 1;
      await this.cache.write(masterPath, bytes);
      return bytes;
    });
  }

  /**
   * Draws one card.
   *
   * Reads first (all cached in the loader after the first card), then plans
   * the layout from the frame's geometry, then rasterizes. The plan step is
   * pure and synchronous — every coordinate is decided before a single pixel
   * is touched, which is what makes the layout testable without rendering.
   */
  private async renderMaster(input: CardRenderInput): Promise<Buffer> {
    const { rarity, race, affinity } = input.species;
    const owned = effectiveOwned(input);

    const [geometry, frameBytes, raceIcon, affinityIcon, rarityIcon, artwork, ownedBadgeBytes] =
      await Promise.all([
        this.loader.frameGeometry(rarity),
        this.loader.frame(rarity),
        this.loader.raceIcon(race),
        this.loader.affinityIcon(affinity),
        this.loader.rarityIcon(rarity),
        readArtwork(input.variant.artworkAbsolutePath, {
          speciesSlug: input.species.slug,
          appearanceId: input.variant.appearanceId,
        }),
        owned ? this.loader.ownedBadge() : Promise.resolve(undefined),
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
      placements.push(
        planOwnedBadge(geometry.art, ownedBadgeBytes, await imageSize(ownedBadgeBytes)),
      );
    }

    const fontFiles = this.loader.fontPaths();
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

    this.logger?.debug(
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

  private result(
    bytes: Buffer,
    renderKey: string,
    width: number,
    height: number,
    fromCache: boolean,
    derivativeWidth?: number,
  ): CardRenderResult {
    return {
      bytes,
      contentType: 'image/webp',
      renderKey,
      fromCache,
      width,
      height,
      etag: cardEtag(renderKey, derivativeWidth),
    };
  }
}

function derivedHeight(width: number): number {
  return Math.round((width * CARD_MASTER_HEIGHT) / CARD_MASTER_WIDTH);
}

function resolveOutputWidth(input: CardRenderInput): number {
  const requested = input.output?.width;
  if (requested === undefined) return CARD_MASTER_WIDTH;
  if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
    throw new CardOutputWidthError(requested, MIN_OUTPUT_WIDTH, MAX_OUTPUT_WIDTH);
  }
  if (requested < MIN_OUTPUT_WIDTH || requested > MAX_OUTPUT_WIDTH) {
    throw new CardOutputWidthError(requested, MIN_OUTPUT_WIDTH, MAX_OUTPUT_WIDTH);
  }
  return requested;
}

/**
 * Builds a renderer bound to a specific asset kit and cache root. Callers that
 * just want the shipped kit should use the module-level {@link renderCard}.
 */
export function createCardRenderer(options: CardRendererOptions = {}): CardRenderer {
  return new CardRendererImpl(options);
}

let sharedRenderer: CardRenderer | undefined;

/** The process-wide renderer over the shipped kit and the default cache root. */
export function getCardRenderer(): CardRenderer {
  sharedRenderer ??= createCardRenderer();
  return sharedRenderer;
}

/** Renders one card using the shared renderer. */
export function renderCard(input: CardRenderInput): Promise<CardRenderResult> {
  return getCardRenderer().renderCard(input);
}

/** Master render key for one card, using the shared renderer. */
export function computeCardRenderKey(input: CardRenderInput): Promise<string> {
  return getCardRenderer().computeMasterRenderKey(input);
}
