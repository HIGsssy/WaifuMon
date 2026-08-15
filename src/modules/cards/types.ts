/**
 * Public shapes of the card renderer. Kept free of Fastify, drizzle, and
 * content-loader types on purpose: the renderer is a pure
 * data-in / bytes-out function that the API, a cache warmer, a test, or a
 * future Discord attachment builder can all call the same way.
 */
import type { Affinity, Rarity } from '../../db/schema';
import type { RaceCode } from './race';

/**
 * Presentation-only species fields the SVG kit expects. Phase 2 adds this
 * block to `SpeciesContentSchema`; Phase 1 declares it locally so the renderer
 * can be built and tested without touching the content schema.
 */
/**
 * Optional fields are spelled `?: T | undefined` throughout this file. The repo
 * compiles with `exactOptionalPropertyTypes`, and callers assemble these
 * objects out of optional data (`species.card?.subtitle`), so accepting an
 * explicit `undefined` is what makes the type usable without spread gymnastics
 * at every call site.
 */
export interface SpeciesCardMeta {
  /** Epithet under the name, e.g. "Curious Companion". */
  subtitle?: string | undefined;
  /** Artwork credit. Rendered as "Artist - <name>"; omitted entirely if absent. */
  artist?: string | undefined;
  /** Both fields required together, or the whole panel is dropped. */
  ability?: { name: string; text: string } | undefined;
  flavorQuote?: string | undefined;
  /** Free-form collector number, e.g. "012/100". */
  cardNumber?: string | undefined;
}

export interface CardRenderInput {
  species: {
    slug: string;
    name: string;
    rarity: Rarity;
    /** Already resolved — use {@link resolveRace} before calling. */
    race: RaceCode;
    affinity: Affinity;
    card?: SpeciesCardMeta | undefined;
  };
  variant: {
    /** Appearance id, e.g. `standard`, `level_20`. */
    appearanceId: string;
    /**
     * Absolute path to the artwork PNG. The renderer hashes the bytes itself —
     * callers cannot supply (or mis-supply) a content hash.
     */
    artworkAbsolutePath: string;
  };
  progress?:
    | {
        /** Level printed on the card. Defaults to 1. */
        level?: number | undefined;
        /** Reserved for owner-personalised cards; unused in v1, not in the key. */
        ownedCopyId?: number | undefined;
      }
    | undefined;
  output?:
    | {
        /**
         * Requested display width in px. Defaults to the master width (1000).
         * Never part of the master render key — derivatives are resized from
         * the master, not re-rasterized.
         */
        width?: number | undefined;
      }
    | undefined;
  /** Per-render overrides of the card metadata block. Rare; still keyed. */
  overrides?: SpeciesCardMeta | undefined;
}

export interface CardRenderResult {
  bytes: Buffer;
  contentType: 'image/webp';
  /**
   * Identity of the canonical 1000×1400 card. Stable across requested widths —
   * a 512px request of the same card reports the same `renderKey`.
   */
  renderKey: string;
  /** True when the returned bytes were read from the disk cache. */
  fromCache: boolean;
  width: number;
  height: number;
  /**
   * Strong ETag. Unlike `renderKey` this *does* vary with width, because two
   * different-sized responses are different entities.
   */
  etag: string;
}

/** Counters for observability and for proving dedupe/caching behaviour in tests. */
export interface CardRendererStats {
  /** Full resvg + composite passes actually performed. */
  masterRenders: number;
  /** Sharp resizes performed from an existing master. */
  derivativeRenders: number;
  /** Responses served from files already on disk. */
  cacheHits: number;
  /** Renders that joined an in-flight identical render instead of starting one. */
  dedupedRenders: number;
}

export interface CardRendererOptions {
  /** Root of the SVG kit. Defaults to `<repo>/assets/cardart`. */
  assetRoot?: string;
  /** Root of the disk cache. Defaults to `<repo>/assets/.card-cache`. */
  cacheRoot?: string;
  logger?: import('../../shared/logger').Logger;
}

export interface CardRenderer {
  renderCard(input: CardRenderInput): Promise<CardRenderResult>;
  /** The canonical master identity for an input, independent of output width. */
  computeMasterRenderKey(input: CardRenderInput): Promise<string>;
  /** SHA-256 (hex) of the artwork bytes at `absolutePath`. */
  hashArtwork(absolutePath: string): Promise<string>;
  /** Throws {@link CardAssetMissingError} for the first missing required asset. */
  validateAssets(): Promise<void>;
  getStats(): CardRendererStats;
}

export type { Affinity, Rarity, RaceCode };
