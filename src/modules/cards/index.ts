/**
 * Public surface of the card renderer.
 *
 * **This file is the module boundary.** API routes, cache-warming tools,
 * tests, and future bot integrations import from here; nothing outside
 * `src/modules/cards/` imports the composer, rasterizer, cache, or asset
 * loader directly. That is what lets the whole rasterization strategy be
 * swapped (Satori, a headless browser, a render worker) without touching a
 * single caller.
 *
 * The kit is raster-first: the frames, icons and ownership badge are supplied
 * artwork, and their geometry is derived from them into `geometry.json` rather
 * than transcribed into a coordinate table here. See `frameGeometry.ts`.
 */

export {
  computeCardRenderKey,
  configureCardRenderer,
  createCardRenderer,
  getCardRenderer,
  renderCard,
  shutdownCardRenderer,
  MAX_OUTPUT_WIDTH,
  MIN_OUTPUT_WIDTH,
} from './renderer';

/**
 * Worker isolation. Drawing a master blocks its thread for ~750 ms of
 * synchronous resvg, so it happens on a small pool rather than on the thread
 * serving Discord and Fastify. Callers see none of it — `renderCard` is
 * unchanged — but the pool's size is configuration, and its errors and stats
 * are things an operator legitimately needs to see.
 */
export {
  CardPoolClosedError,
  CardWorkerCrashedError,
  DEFAULT_CARD_RENDER_WORKERS,
  MAX_CARD_RENDER_WORKERS,
  type CardRenderPoolStats,
} from './worker/workerPool';

export {
  CARD_RENDERER_VERSION,
  CARD_WEBP_QUALITY,
  CARD_WIDTH_BUCKETS,
  cardEtag,
  CARD_MASTER_HEIGHT,
  CARD_MASTER_WIDTH,
  SUPPORTED_CARD_WIDTHS,
} from './version';

/** Operational tooling — cache warming and garbage collection. */
export { warmCardCache } from './warm';
export type {
  WarmCardCacheFailure,
  WarmCardCacheOptions,
  WarmCardCacheResult,
  WarmCardOutcome,
} from './warm';

export {
  collectCardCacheGarbage,
  DEFAULT_MAX_AGE_DAYS,
  renderKeyOfCacheFile,
} from './gc';
export type {
  CardCacheGcOptions,
  CardCacheGcReason,
  CardCacheGcRemoval,
  CardCacheGcResult,
} from './gc';

export {
  CardArtworkMissingError,
  CardAssetMissingError,
  CardOutputWidthError,
  CardRenderError,
  CardTemplateError,
} from './errors';

export {
  archetypeToRace,
  DEFAULT_RACE,
  isRaceCode,
  raceLabel,
  RACE_CODES,
  resolveRace,
  type RaceCode,
  type RaceResolvable,
} from './race';

export {
  isRenderableRarity,
  RARITY_FRAME_FILES,
  RARITY_ICON_FILES,
  rarityFrameFile,
  rarityIconFile,
  RENDERABLE_RARITIES,
  UNSUPPORTED_RARITIES,
} from './rarity';

export {
  frameGeometryFor,
  parseCardGeometry,
  GEOMETRY_FILE,
  GEOMETRY_SCHEMA_VERSION,
  type CardGeometryFile,
  type Disc,
  type FrameGeometry,
  type Rect,
} from './frameGeometry';

/**
 * Layout is exported so a test — or a future preview tool — can assert where an
 * element lands without rendering a card. The composition functions themselves
 * stay internal: callers get bytes.
 */
export {
  LAYOUT,
  planArtworkCrop,
  planIconPlacement,
  planOwnedBadge,
  type ArtworkCrop,
  type IconSlot,
  type RasterPlacement,
} from './composer/cardComposer';

export {
  AFFINITY_DESCRIPTIONS,
  AFFINITY_ICON_FILES,
  affinityIconFile,
  affinityLabel,
} from './affinity';

export { hashArtwork } from './contentHash';

export { DEFAULT_ASSET_ROOT, DEFAULT_CACHE_ROOT } from './paths';

export type {
  CardRenderer,
  CardRendererOptions,
  CardRendererStats,
  CardRenderInput,
  CardRenderResult,
  SpeciesCardMeta,
} from './types';

/** Re-exported so callers can type a card input without reaching into `db/schema`. */
export type { Affinity, Rarity } from '../../db/schema';
