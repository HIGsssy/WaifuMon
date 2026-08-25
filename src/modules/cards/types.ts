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
/**
 * Note on what the card face currently *draws*. The production frame's
 * information panel carries four rows — name, two lines of description, and a
 * credit row of `Artist — <name>` on the left against the wordmark on the
 * right — so of the fields below only `artist` reaches the card today.
 * `subtitle`, `ability`, `flavorQuote` and `cardNumber` remain part of the
 * authored content contract (and of the admin panel, and of the API) and are
 * simply not rendered; they are deliberately kept rather than deleted so a
 * later frame with room for them does not need a content migration.
 */
export interface SpeciesCardMeta {
  /** Epithet under the name, e.g. "Curious Companion". Not currently drawn. */
  subtitle?: string | undefined;
  /** Artwork credit. Rendered as "Artist - <name>"; omitted entirely if absent. */
  artist?: string | undefined;
  /** Both fields required together, or the whole panel is dropped. Not currently drawn. */
  ability?: { name: string; text: string } | undefined;
  /** Not currently drawn — the panel shows `species.description` instead. */
  flavorQuote?: string | undefined;
  /**
   * Free-form collector number. Reserved, **not drawn**: there is no set
   * numbering system, so every value would be invented. Do not fill it in to
   * make the card look complete.
   */
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
    /**
     * Flavour line for the information panel, wrapped to two lines. This is
     * the species' own `description` — the same sentence the encyclopedia
     * shows — not a card-specific field, so one character reads the same way
     * everywhere she appears.
     */
    description?: string | undefined;
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
  /**
   * How this render is being presented, as opposed to what is being rendered.
   *
   * Ownership is the only member today. It exists because the same species card
   * is drawn in contexts where ownership is meaningless — the encyclopedia, a
   * hunt encounter, an admin preview — and the "CAUGHT" badge must not be baked
   * into that master. It defaults to off, and it is part of the render key, so
   * an owned and an unowned card of the same Waifumon are two distinct cached
   * images rather than one that flickers between states.
   */
  context?:
    | {
        owned?: boolean | undefined;
      }
    | undefined;
  output?:
    | {
        /**
         * Requested display width in px. Defaults to the master width.
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
   * Identity of the canonical full-size card. Stable across requested widths —
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
  /**
   * Worker-pool counters, present once a cold master has actually been drawn
   * on a thread. Absent when the pool is disabled (`workers: 0`) or when
   * everything so far was served from cache — which is itself the useful
   * signal that no expensive work happened.
   */
  workers?: import('./worker/workerPool').CardRenderPoolStats | undefined;
}

export interface CardRendererOptions {
  /** Root of the SVG kit. Defaults to `<repo>/assets/cardart`. */
  assetRoot?: string;
  /** Root of the disk cache. Defaults to `<repo>/assets/.card-cache`. */
  cacheRoot?: string;
  /**
   * Threads used to draw cold masters. Defaults to
   * {@link DEFAULT_CARD_RENDER_WORKERS} (2), configurable via
   * `CARD_RENDER_WORKERS`.
   *
   * `0` renders in-process instead — the same function on the main thread,
   * producing identical bytes. That is the escape hatch for an environment
   * where threads are unavailable or unwanted, and the control case that keeps
   * the two paths provably equivalent. It is not the default because it
   * reinstates the ~750 ms event-loop stall this option exists to remove.
   */
  workers?: number;
  logger?: import('../../shared/logger').Logger;
}

export interface CardRenderer {
  renderCard(input: CardRenderInput): Promise<CardRenderResult>;
  /** The canonical master identity for an input, independent of output width. */
  computeMasterRenderKey(input: CardRenderInput): Promise<string>;
  /**
   * Whether the file `renderCard(input)` would return is already on disk — a
   * `stat`, not a read, and never a render.
   *
   * It exists for warming, which spends most of its time discovering that
   * there is nothing to do: probing is what lets a warm run over an already-hot
   * collection cost a few hundred directory lookups instead of reading every
   * cached card into memory to throw it away.
   *
   * A hint, never a promise. The answer can go stale between the probe and the
   * request, so it may only be used to *skip* work — `renderCard` re-checks the
   * disk itself.
   */
  isCached(input: CardRenderInput): Promise<boolean>;
  /** SHA-256 (hex) of the artwork bytes at `absolutePath`. */
  hashArtwork(absolutePath: string): Promise<string>;
  /** Throws {@link CardAssetMissingError} for the first missing required asset. */
  validateAssets(): Promise<void>;
  getStats(): CardRendererStats;
  /**
   * Releases worker threads. Idempotent, and a no-op when none were started.
   * Application shutdown calls this; so should any test that renders a card.
   */
  shutdown(): Promise<void>;
}

export type { Affinity, Rarity, RaceCode };
