/**
 * The renderer itself — everything above this file is a part, this is the
 * assembly.
 *
 * ```
 * artwork bytes ─┐
 *                ├─ composed base SVG ─ resvg ─ base PNG ─┐
 * base template ─┘                                        ├─ sharp composite ─ 1000×1400 WebP master
 *                   rarity SVG ─ resvg ─ rarity PNG ──────┘                          │
 *                                                                                    └─ sharp resize ─ @<width> derivative
 * ```
 *
 * The master is the card's identity; a requested display width only selects
 * which file derives from it. Asking for 512px never re-runs resvg and never
 * produces a second master.
 */
import { CardAssetLoader } from './assets/loader';
import { validateCardAssets } from './assets/validation';
import {
  buildMasterKeyMaterial,
  computeMasterRenderKey as computeKey,
  effectiveCardMeta,
  effectiveLevel,
} from './cache/cacheKey';
import { CardDiskCache, InFlightMap } from './cache/diskCache';
import { ArtworkHashMemo } from './cache/hashMemo';
import { composeBaseSvg } from './composer/baseComposer';
import { hashArtwork, readArtwork } from './contentHash';
import { CardOutputWidthError } from './errors';
import { DEFAULT_ASSET_ROOT, DEFAULT_CACHE_ROOT } from './paths';
import {
  compositeMasterWebp,
  renderBasePng,
  renderOverlayPng,
  resizeFromMaster,
} from './rasterizer/renderer';
import type {
  CardRenderer,
  CardRenderInput,
  CardRenderResult,
  CardRendererOptions,
  CardRendererStats,
} from './types';
import { cardEtag, MASTER_HEIGHT, MASTER_WIDTH } from './version';

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

    if (width === MASTER_WIDTH) {
      const masterPath = this.cache.masterPath(slug, renderKey);
      const cached = await this.cache.read(masterPath);
      if (cached) {
        this.stats.cacheHits += 1;
        return this.result(cached, renderKey, MASTER_WIDTH, MASTER_HEIGHT, true);
      }
      const bytes = await this.ensureMaster(input, renderKey, masterPath);
      return this.result(bytes, renderKey, MASTER_WIDTH, MASTER_HEIGHT, false);
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

  private async renderMaster(input: CardRenderInput): Promise<Buffer> {
    const [baseSvg, raceIconSvg, affinityIconSvg, overlaySvg, artwork] = await Promise.all([
      this.loader.baseTemplate(),
      this.loader.raceIcon(input.species.race),
      this.loader.affinityIcon(input.species.affinity),
      this.loader.rarityOverlay(input.species.rarity),
      readArtwork(input.variant.artworkAbsolutePath, {
        speciesSlug: input.species.slug,
        appearanceId: input.variant.appearanceId,
      }),
    ]);

    const composed = composeBaseSvg({
      baseSvg,
      raceIconSvg,
      affinityIconSvg,
      name: input.species.name,
      race: input.species.race,
      affinity: input.species.affinity,
      level: effectiveLevel(input),
      card: effectiveCardMeta(input),
    });

    const fontFiles = this.loader.fontPaths();
    const base = renderBasePng(composed.svg, artwork, fontFiles);
    const overlay = renderOverlayPng(overlaySvg, fontFiles);

    this.logger?.debug(
      {
        tag: 'card-renderer/master',
        slug: input.species.slug,
        rarity: input.species.rarity,
        width: base.width,
        height: base.height,
      },
      'Rendered card master',
    );

    return compositeMasterWebp(base.png, overlay);
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
  return Math.round((width * MASTER_HEIGHT) / MASTER_WIDTH);
}

function resolveOutputWidth(input: CardRenderInput): number {
  const requested = input.output?.width;
  if (requested === undefined) return MASTER_WIDTH;
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
