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
 * Phase 1 ships the renderer only — no HTTP route, no portal provider, no
 * content-schema change. See `.ai/SVGPlan.md`.
 */

export {
  computeCardRenderKey,
  createCardRenderer,
  getCardRenderer,
  renderCard,
  MAX_OUTPUT_WIDTH,
  MIN_OUTPUT_WIDTH,
} from './renderer';

export {
  CARD_RENDERER_VERSION,
  CARD_WEBP_QUALITY,
  CARD_WIDTH_BUCKETS,
  cardEtag,
  MASTER_HEIGHT,
  MASTER_WIDTH,
  SUPPORTED_CARD_WIDTHS,
} from './version';

/** Operational tooling — cache warming and garbage collection. */
export { warmCardCache } from './warm';
export type {
  WarmCardCacheFailure,
  WarmCardCacheOptions,
  WarmCardCacheResult,
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

export { RARITY_OVERLAY_FILES, rarityOverlayFile } from './rarity';

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
