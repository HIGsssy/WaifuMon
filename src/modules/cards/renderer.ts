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
 *
 * ## Where the work happens
 *
 * Everything on this page is cheap: hashing artwork, reading the disk cache,
 * collapsing identical in-flight keys, resizing a derivative. The one expensive
 * step — drawing the master, which blocks a thread for ~750 ms in synchronous
 * resvg — is handed to a worker pool (`worker/workerPool.ts`) so it stops
 * blocking the thread that serves Discord and Fastify.
 *
 * The order matters and is load-bearing: **cache first, dedupe second, worker
 * last**. A warm hit must never queue behind a cold render, and two callers
 * asking for the same card must produce one job rather than two.
 */
import { CardAssetLoader } from './assets/loader';
import { validateCardAssets } from './assets/validation';
import { buildMasterKeyMaterial, computeMasterRenderKey as computeKey } from './cache/cacheKey';
import { CardDiskCache, InFlightMap } from './cache/diskCache';
import { ArtworkHashMemo } from './cache/hashMemo';
import { hashArtwork } from './contentHash';
import { CardOutputWidthError } from './errors';
import { DEFAULT_ASSET_ROOT, DEFAULT_CACHE_ROOT } from './paths';
import { renderMasterBytes } from './rasterizer/masterRender';
import { resizeFromMaster } from './rasterizer/renderer';
import { CardRenderPool, DEFAULT_CARD_RENDER_WORKERS } from './worker/workerPool';
import type {
  CardRenderer,
  CardRenderInput,
  CardRenderResult,
  CardRendererOptions,
  CardRendererStats,
} from './types';
import { cardEtag, CARD_MASTER_HEIGHT, CARD_MASTER_WIDTH } from './version';

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
  private readonly workerCount: number;
  private workerPool: CardRenderPool | undefined;
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
    this.workerCount = Math.max(0, options.workers ?? DEFAULT_CARD_RENDER_WORKERS);
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

  /**
   * Whether the exact file a `renderCard` of this input would return is
   * already on disk — one `stat`, no read, no rasterizing.
   *
   * It still hashes the artwork, because the render key *is* the artwork hash
   * and there is no cheaper way to name the file. That hash is memoised per
   * path+mtime, so a warm run over a collection pays it once per appearance.
   *
   * Deliberately a probe rather than a guarantee: the answer can go stale
   * between the check and the request (a GC sweep, a content edit). Callers
   * use it to *skip* work, never to promise a hit — `renderCard` re-checks the
   * disk itself and simply renders if the file has gone.
   */
  async isCached(input: CardRenderInput): Promise<boolean> {
    const width = resolveOutputWidth(input);
    const renderKey = await this.computeMasterRenderKey(input);
    const filePath =
      width === CARD_MASTER_WIDTH
        ? this.cache.masterPath(input.species.slug, renderKey)
        : this.cache.derivativePath(input.species.slug, renderKey, width);
    return this.cache.exists(filePath);
  }

  getStats(): CardRendererStats {
    return {
      ...this.stats,
      dedupedRenders: this.masterRenders.joined + this.derivativeRenders.joined,
      ...(this.workerPool === undefined ? {} : { workers: this.workerPool.getStats() }),
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
   * Draws one card, on a worker thread when the pool is enabled.
   *
   * This is the only expensive step in the renderer, and the only one that
   * leaves the main thread. `workers: 0` keeps it here instead — same
   * function, same bytes — which is what makes the in-process path a genuine
   * fallback rather than a second implementation to keep in step.
   */
  private renderMaster(input: CardRenderInput): Promise<Buffer> {
    const pool = this.pool();
    return pool === null
      ? renderMasterBytes(this.loader, input, this.logger)
      : pool.render(input);
  }

  /**
   * The pool, started on the first cold master.
   *
   * Lazy on purpose: card rendering is off by default, most processes never
   * draw one, and a test that constructs a renderer to check a cache key
   * should not pay for two threads to find that out.
   */
  private pool(): CardRenderPool | null {
    if (this.workerCount === 0) return null;
    this.workerPool ??= new CardRenderPool({
      assetRoot: this.loader.assetRoot,
      size: this.workerCount,
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    });
    return this.workerPool;
  }

  /** Releases the worker threads. Safe to call when none were ever started. */
  async shutdown(): Promise<void> {
    const pool = this.workerPool;
    this.workerPool = undefined;
    if (pool !== undefined) await pool.shutdown();
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
let sharedOptions: CardRendererOptions = {};

/**
 * Settings for the process-wide renderer — in practice the worker count, which
 * is deployment configuration (`CARD_RENDER_WORKERS`) rather than something the
 * cards module can know.
 *
 * Must run before the first card, because the singleton is built once and the
 * worker count is fixed at construction. Called from application startup; a
 * later call is a wiring bug and says so rather than silently doing nothing.
 */
export function configureCardRenderer(options: CardRendererOptions): void {
  if (sharedRenderer !== undefined) {
    throw new Error('configureCardRenderer must be called before the first card is rendered');
  }
  sharedOptions = options;
}

/** The process-wide renderer over the shipped kit and the default cache root. */
export function getCardRenderer(): CardRenderer {
  sharedRenderer ??= createCardRenderer(sharedOptions);
  return sharedRenderer;
}

/** Renders one card using the shared renderer. */
export function renderCard(input: CardRenderInput): Promise<CardRenderResult> {
  return getCardRenderer().renderCard(input);
}

/**
 * Releases the shared renderer's worker threads.
 *
 * Called from application shutdown. A no-op when no card was ever rendered,
 * which is the common case — the threads are started lazily.
 */
export async function shutdownCardRenderer(): Promise<void> {
  const renderer = sharedRenderer;
  sharedRenderer = undefined;
  await renderer?.shutdown();
}

/** Master render key for one card, using the shared renderer. */
export function computeCardRenderKey(input: CardRenderInput): Promise<string> {
  return getCardRenderer().computeMasterRenderKey(input);
}
