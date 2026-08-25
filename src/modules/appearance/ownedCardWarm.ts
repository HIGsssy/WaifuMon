/**
 * Warming the cards a player **actually owns**.
 *
 * `tools/cardCacheOps.ts` warms the *encyclopedia* set — every enabled species,
 * default look, level 1. That set is small, static, and says nothing about any
 * one trainer: an owned card carries her real level, the appearance she is
 * wearing, and the CAUGHT badge, so none of it is shared with the preview.
 *
 * This module is the owned counterpart, and it exists so that the collection
 * grid can show rendered cards without a page turn costing twenty-five cold
 * masters.
 *
 * ## What it warms, and what it deliberately does not
 *
 * **Only her current state.** One card per owned copy: current level, current
 * worn appearance, `owned: true`. Not every level she has passed through, not
 * every appearance she has unlocked, not any state she might reach later.
 * Level and appearance are both in the render key, so warming them all would
 * multiply the cache by the level cap for cards nobody will ever request — and
 * when she does level up, the next request simply mints the new card and warms
 * it from then on. The cache follows the player; it does not try to precede her.
 *
 * **The master plus the two grid derivatives (@256, @512).** Those are the
 * buckets the Portal's grid tiles resolve to at 1× and 2× — see
 * `ARTWORK_WIDTH.gridTile` and `bucketFor`. `@1024` is the *hero* bucket and is
 * not warmed here: it is one tap away, not twenty-five, and it is already
 * produced as a side effect of every Discord card.
 *
 * ## Where the decisions come from
 *
 * Nowhere in this file. Which species, which appearance, which artwork file
 * after a fallback, what level, and the ownership flag are all
 * {@link ownedCardRequest}'s answers — the same function the HTTP card route
 * and the Discord attachment builder call. A warm keyed by anything it worked
 * out for itself would warm cards that no request will ever ask for, which is
 * the one failure mode a cache warmer cannot survive.
 *
 * ## Scheduling
 *
 * {@link OwnedCardWarmer} adds the runtime half: dedupe by player, a ceiling on
 * how many warms may be in flight at once, and fire-and-forget entry points for
 * the two places that trigger one (a capture, and a collection listing). It
 * never renders anything itself — every cold master still goes through the
 * renderer's worker pool, which stays the only rasterization path.
 */
import { ownedCardRequest, type CardPresentationDeps } from './cardPresentation';
import {
  getCardRenderer,
  warmCardCache,
  CARD_MASTER_WIDTH,
  type CardRenderInput,
  type CardRenderer,
  type WarmCardCacheFailure,
} from '../cards';
import type { Logger } from '../../shared/logger';

/**
 * The derivative widths a collection tile resolves to.
 *
 * `ARTWORK_WIDTH.gridTile` is 256 CSS px and the Portal's `bucketFor` caps the
 * device-pixel multiplier at 2×, so a tile is served from exactly one of these
 * two — 256 on a 1× display, 512 on a 2×. Warming both is what makes the tile
 * a cache hit on either.
 *
 * `1024` is deliberately absent. It is the hero bucket (384 CSS px at 2×), and
 * a grid draws none of them; warming it for every owned copy would roughly
 * double the warm cost and the cache footprint to serve a page the player may
 * never open. It is also the width Discord already renders at, so for a card
 * that has ever been posted it exists anyway.
 */
export const OWNED_GRID_WIDTHS: readonly number[] = [256, 512];

/**
 * Cards warmed at once, by default.
 *
 * One. Production is a Ryzen mini-PC sharing 16 GB between Postgres, the
 * gateway, Fastify and the renderer, and a warm is *background* work by
 * definition — the player who triggered it has already been served. Its job is
 * to finish eventually without being noticed, not to finish fast.
 *
 * It is also the value that composes correctly with `CARD_RENDER_WORKERS=1`:
 * one warm slot feeding one render thread means a cold master a player is
 * actually waiting for queues behind at most one warm card, not behind twenty.
 */
export const DEFAULT_OWNED_WARM_CONCURRENCY = 1;

/**
 * Background warms allowed in flight at once.
 *
 * The bound that makes fire-and-forget safe: without it, a burst of collection
 * requests from several players would each start a full warm and the queue
 * depth would be however many players happened to load a page. Over the
 * ceiling, a warm is dropped rather than queued — it is self-healing work, and
 * the next collection load asks again.
 */
export const DEFAULT_MAX_ACTIVE_WARMS = 2;

/**
 * The slice of an owned copy a warm needs.
 *
 * Structurally a `CollectionService.OwnedEntry` (and satisfied by one), plus
 * `waifu.id` — which `ownedCardRequest` does not read, but which is what a warm
 * dedupes and logs by.
 */
export interface OwnedCardWarmSubject {
  waifu: { id: number; level: number; variant: string | null };
  species: { slug: string };
}

/** An owned copy that could not be turned into a render input at all. */
export interface OwnedCardWarmSkip {
  waifuId: number;
  slug: string;
  reason: string;
}

export interface OwnedCardWarmPlanOptions {
  /** Derivative widths. Defaults to {@link OWNED_GRID_WIDTHS}. */
  widths?: readonly number[] | undefined;
  /**
   * Warm the full-size master too. On by default.
   *
   * Off is for the post-capture follow-up, where the master was just drawn to
   * produce the 1024px attachment and only the grid derivatives are missing.
   */
  includeMaster?: boolean | undefined;
}

export interface OwnedCardWarmPlan {
  inputs: CardRenderInput[];
  skipped: OwnedCardWarmSkip[];
  /** Owned copies looked at, whether or not they produced an input. */
  ownedConsidered: number;
}

/**
 * Owned copies → the cards to warm for them.
 *
 * A copy whose artwork cannot be resolved (a species that has left the content
 * snapshot, a missing file with no fallback) is recorded as skipped rather than
 * throwing: one broken row must not cost the other twenty-four their warm.
 */
export function planOwnedCardWarm(
  deps: CardPresentationDeps,
  subjects: readonly OwnedCardWarmSubject[],
  options: OwnedCardWarmPlanOptions = {},
): OwnedCardWarmPlan {
  const widths = options.widths ?? OWNED_GRID_WIDTHS;
  const includeMaster = options.includeMaster !== false;
  const plan: OwnedCardWarmPlan = { inputs: [], skipped: [], ownedConsidered: 0 };

  for (const subject of subjects) {
    plan.ownedConsidered += 1;

    let base: CardRenderInput;
    try {
      base = ownedCardRequest(deps, subject).input;
    } catch (err) {
      plan.skipped.push({
        waifuId: subject.waifu.id,
        slug: subject.species.slug,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // The master first, and in the same list rather than a separate pass: a
    // derivative resizes from it, so a 256 that arrives before its master
    // simply draws the master on the way. Ordering them puts that work where
    // it belongs instead of leaving it to whichever entry got there first.
    if (includeMaster) plan.inputs.push(base);
    for (const width of widths) {
      plan.inputs.push({ ...base, output: { width } });
    }
  }

  return plan;
}

/**
 * What a warm run cost, split the way an operator needs to read it.
 *
 * `mastersRendered` is the only expensive number here — it is worker-thread
 * time. Everything else is a `stat`, or a Sharp resize off an image already in
 * hand. A healthy steady state is `mastersRendered: 0`.
 */
export interface OwnedCardWarmResult {
  ownedConsidered: number;
  planned: number;
  /** Cold masters actually drawn. The expensive number. */
  mastersRendered: number;
  /** Masters already on disk. */
  mastersCached: number;
  /** Derivatives resized from a master during this run. */
  derivativesCreated: number;
  /** Derivatives already on disk. */
  derivativesCached: number;
  skipped: OwnedCardWarmSkip[];
  failed: WarmCardCacheFailure[];
  durationMs: number;
}

export interface WarmOwnedCardsOptions extends OwnedCardWarmPlanOptions {
  renderer?: CardRenderer | undefined;
  /** Defaults to {@link DEFAULT_OWNED_WARM_CONCURRENCY}. */
  concurrency?: number | undefined;
  logger?: Logger | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

/**
 * Plans and runs a warm for a set of owned copies.
 *
 * Synchronous from the caller's point of view — the CLI awaits it, and so does
 * {@link OwnedCardWarmer}, which is what turns it into background work.
 */
export async function warmOwnedCards(
  deps: CardPresentationDeps,
  subjects: readonly OwnedCardWarmSubject[],
  options: WarmOwnedCardsOptions = {},
): Promise<OwnedCardWarmResult> {
  const plan = planOwnedCardWarm(deps, subjects, options);

  const tally = { mastersRendered: 0, mastersCached: 0, derivativesCreated: 0, derivativesCached: 0 };

  const result = await warmCardCache(plan.inputs, {
    concurrency: options.concurrency ?? DEFAULT_OWNED_WARM_CONCURRENCY,
    ...(options.renderer === undefined ? {} : { renderer: options.renderer }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    onCard: (input, outcome) => {
      const isMaster = (input.output?.width ?? CARD_MASTER_WIDTH) === CARD_MASTER_WIDTH;
      if (isMaster) {
        if (outcome === 'rendered') tally.mastersRendered += 1;
        else tally.mastersCached += 1;
      } else if (outcome === 'rendered') {
        tally.derivativesCreated += 1;
      } else {
        tally.derivativesCached += 1;
      }
    },
  });

  return {
    ownedConsidered: plan.ownedConsidered,
    planned: plan.inputs.length,
    ...tally,
    skipped: plan.skipped,
    failed: result.failed,
    durationMs: result.durationMs,
  };
}

// ── Scheduling ──────────────────────────────────────────────────────────────

/** What a `schedule…` call actually did. */
export type OwnedCardWarmDisposition =
  /** A background warm was started. */
  | 'started'
  /** One for the same subject is already running; this call is a no-op. */
  | 'deduped'
  /** Too many warms in flight already; dropped rather than queued. */
  | 'saturated';

export interface OwnedCardWarmerOptions {
  presentation: CardPresentationDeps;
  /**
   * A player's current owned copies. Injected rather than queried here: this
   * module is about *which card*, and the collection is the collection
   * service's (or a CLI's) business.
   */
  listSubjects: (playerId: number) => Promise<OwnedCardWarmSubject[]>;
  renderer?: CardRenderer | undefined;
  concurrency?: number | undefined;
  /** Background warms in flight at once. {@link DEFAULT_MAX_ACTIVE_WARMS}. */
  maxActive?: number | undefined;
  widths?: readonly number[] | undefined;
  logger?: Logger | undefined;
}

/**
 * The runtime scheduler around {@link warmOwnedCards}.
 *
 * Three properties, and all three are the reason this is a class rather than a
 * loose function:
 *
 *   - **Deduped by subject.** A player refreshing their collection five times
 *     starts one warm, not five. The in-flight map is the whole mechanism, and
 *     it is per-process on purpose — this is opportunistic self-healing, and a
 *     second app instance warming the same player wastes a little work rather
 *     than corrupting anything.
 *   - **Bounded.** At most `maxActive` warms exist at once; beyond that a
 *     request is dropped, because the *next* collection load will ask again.
 *   - **Detached.** `schedule…` returns immediately and never rejects. Nothing
 *     a warm does may reach the HTTP response or the capture reply it was
 *     triggered from.
 */
export class OwnedCardWarmer {
  private readonly options: OwnedCardWarmerOptions;
  private readonly active = new Map<string, Promise<void>>();
  private readonly logger: Logger | undefined;
  /**
   * Resolved here rather than left to `warmCardCache` to default internally.
   * The same instance has to answer both "draw this" and "how deep is your
   * queue" — a warmer that let the renderer default under it would log an
   * empty queue depth for a pool it was actively filling.
   */
  private readonly renderer: CardRenderer;

  constructor(options: OwnedCardWarmerOptions) {
    this.options = options;
    this.logger = options.logger;
    this.renderer = options.renderer ?? getCardRenderer();
  }

  /** Background warms in flight right now. */
  get activeWarms(): number {
    return this.active.size;
  }

  /** True while a warm for this player is running. */
  isWarmingPlayer(playerId: number): boolean {
    return this.active.has(playerKey(playerId));
  }

  /**
   * Settles when every in-flight background warm has finished.
   *
   * For shutdown and for tests, which otherwise have no way to observe work
   * that was designed to be unobservable.
   */
  async whenIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()]);
    }
  }

  /**
   * The self-healing warm behind a collection listing.
   *
   * Fire-and-forget by contract: the HTTP response that triggered it has
   * already been sent, or is about to be, and must never wait on this.
   */
  schedulePlayerWarm(playerId: number): OwnedCardWarmDisposition {
    return this.schedule(playerKey(playerId), { playerId }, async () => {
      const subjects = await this.options.listSubjects(playerId);
      return this.warmSubjects(subjects);
    });
  }

  /**
   * The post-capture follow-up: the grid derivatives for one freshly-owned
   * copy.
   *
   * The master is not warmed, because there is nothing to warm — the capture
   * reply just rendered her at 1024, which drew the master on the way. All this
   * costs is two Sharp resizes off a file already on disk.
   */
  scheduleCopyWarm(subject: OwnedCardWarmSubject): OwnedCardWarmDisposition {
    return this.schedule(
      copyKey(subject.waifu.id),
      { waifuId: subject.waifu.id, slug: subject.species.slug },
      () => this.warmSubjects([subject], { includeMaster: false }),
    );
  }

  /** Warms one player's collection and reports it. Awaited — for the CLI. */
  async warmPlayer(playerId: number): Promise<OwnedCardWarmResult> {
    const subjects = await this.options.listSubjects(playerId);
    return this.warmSubjects(subjects);
  }

  /** Warms an explicit set of copies and reports it. Awaited — for the CLI. */
  warmSubjects(
    subjects: readonly OwnedCardWarmSubject[],
    options: OwnedCardWarmPlanOptions = {},
  ): Promise<OwnedCardWarmResult> {
    return warmOwnedCards(this.options.presentation, subjects, {
      renderer: this.renderer,
      ...(this.options.concurrency === undefined ? {} : { concurrency: this.options.concurrency }),
      ...(this.options.widths === undefined ? {} : { widths: this.options.widths }),
      ...(this.logger === undefined ? {} : { logger: this.logger }),
      ...options,
    });
  }

  // ----------------------------------------------------------- internals

  /**
   * Starts detached work under a dedupe key, or explains why it did not.
   *
   * The `catch` is not defensive padding: this promise has no `await`ing
   * caller, so an unhandled rejection here would be an unhandled rejection in
   * the process — and `src/index.ts` treats those as fatal.
   */
  private schedule(
    key: string,
    context: Record<string, unknown>,
    work: () => Promise<OwnedCardWarmResult>,
  ): OwnedCardWarmDisposition {
    if (this.active.has(key)) return 'deduped';

    const maxActive = this.options.maxActive ?? DEFAULT_MAX_ACTIVE_WARMS;
    if (this.active.size >= maxActive) {
      this.logger?.debug(
        { tag: 'card-renderer/owned-warm', ...context, active: this.active.size, maxActive },
        'owned card warm dropped; too many already running',
      );
      return 'saturated';
    }

    const started = Date.now();
    this.logger?.debug(
      { tag: 'card-renderer/owned-warm', ...context },
      'owned card warm started',
    );

    const pending = work()
      .then((result) => {
        this.report(context, result);
      })
      .catch((err: unknown) => {
        this.logger?.warn(
          { tag: 'card-renderer/owned-warm', ...context, err, durationMs: Date.now() - started },
          'owned card warm failed',
        );
      })
      .finally(() => {
        this.active.delete(key);
      });

    this.active.set(key, pending);
    return 'started';
  }

  /**
   * One line per warm, never one per card.
   *
   * A run that found everything already cached is the expected steady state and
   * says nothing an operator needs to act on, so it goes to debug. A run that
   * drew a cold master, skipped a copy or failed one is the interesting case
   * and gets INFO — that is the signal that the warm path is not keeping up, or
   * that a species has content debt.
   */
  private report(context: Record<string, unknown>, result: OwnedCardWarmResult): void {
    const noteworthy =
      result.mastersRendered > 0 || result.failed.length > 0 || result.skipped.length > 0;

    const fields = {
      tag: 'card-renderer/owned-warm',
      ...context,
      ownedConsidered: result.ownedConsidered,
      planned: result.planned,
      mastersRendered: result.mastersRendered,
      mastersCached: result.mastersCached,
      derivativesCreated: result.derivativesCreated,
      derivativesCached: result.derivativesCached,
      skipped: result.skipped.length,
      failed: result.failed.length,
      durationMs: result.durationMs,
      queueDepth: this.renderer.getStats().workers?.queued,
    };

    if (noteworthy) this.logger?.info(fields, 'owned card warm complete');
    else this.logger?.debug(fields, 'owned card warm complete (all cached)');
  }
}

function playerKey(playerId: number): string {
  return `player:${playerId}`;
}

function copyKey(waifuId: number): string {
  return `copy:${waifuId}`;
}
