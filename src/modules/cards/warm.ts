/**
 * Cache warming — render a batch of cards ahead of the first request.
 *
 * Deliberately takes `CardRenderInput[]` rather than species content. Deciding
 * *which* cards are worth warming is a content question (which species are
 * enabled, which appearances exist, what a sensible preview level is), and the
 * cards module does not know what a species is. The caller assembles inputs
 * through the content bridge and hands them over; this module only knows how to
 * render many of them without falling over.
 *
 * Warming is a convenience, not a correctness requirement: every card renders
 * on demand anyway. So a failure warms what it can and reports the rest rather
 * than aborting the run.
 *
 * Most of a warm run's work is discovering there is none: a second pass over
 * the same set is entirely cache hits. So each entry is *probed* first
 * (`renderer.isCached`, one `stat`) and only rendered on a miss — otherwise a
 * hot run would read every cached card into memory to immediately discard it.
 */
import { getCardRenderer } from './renderer';
import type { CardRenderInput, CardRenderer } from './types';
import type { Logger } from '../../shared/logger';

/** What one planned card turned out to cost. */
export type WarmCardOutcome = 'rendered' | 'cached';

/** Rasterizing is CPU-bound; a small pool keeps a warm run off every core. */
const DEFAULT_CONCURRENCY = 2;

export interface WarmCardCacheOptions {
  /** Defaults to the process-wide renderer over the shipped kit. */
  renderer?: CardRenderer | undefined;
  concurrency?: number | undefined;
  logger?: Logger | undefined;
  /** Cancels the run between cards — a long warm should be interruptible. */
  signal?: AbortSignal | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
  /**
   * Called once per entry that did not fail, with what it cost.
   *
   * The aggregate counters below cannot say *which* card was a hit, and a
   * caller warming a master plus its derivatives legitimately wants that split
   * — "the masters were all cached, only the 256s were drawn" is the difference
   * between a warm run that did nothing and one that did the useful thing.
   * Attributing it here beats re-deriving it from widths at every call site.
   */
  onCard?: ((input: CardRenderInput, outcome: WarmCardOutcome) => void) | undefined;
}

export interface WarmCardCacheFailure {
  slug: string;
  appearanceId: string;
  message: string;
}

export interface WarmCardCacheResult {
  /** Cards that were rasterized by this run. */
  rendered: number;
  /** Cards already on disk — the useful number on a second run. */
  cached: number;
  failed: WarmCardCacheFailure[];
  durationMs: number;
}

/**
 * Renders each input, skipping those already cached. Returns counts rather
 * than bytes: a warm run may touch hundreds of cards and holding them all in
 * memory would be pointless.
 */
export async function warmCardCache(
  inputs: readonly CardRenderInput[],
  options: WarmCardCacheOptions = {},
): Promise<WarmCardCacheResult> {
  const renderer = options.renderer ?? getCardRenderer();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const started = Date.now();

  const result: WarmCardCacheResult = { rendered: 0, cached: 0, failed: [], durationMs: 0 };
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (options.signal?.aborted) return;
      const index = next;
      next += 1;
      const input = inputs[index];
      if (!input) return;

      try {
        // Probe before rendering: on an already-warm set this is the whole
        // run, and it costs a `stat` per entry rather than a full file read.
        if (await renderer.isCached(input)) {
          result.cached += 1;
          options.onCard?.(input, 'cached');
        } else {
          const card = await renderer.renderCard(input);
          if (card.fromCache) result.cached += 1;
          else result.rendered += 1;
          options.onCard?.(input, card.fromCache ? 'cached' : 'rendered');
        }
      } catch (err) {
        result.failed.push({
          slug: input.species.slug,
          appearanceId: input.variant.appearanceId,
          message: err instanceof Error ? err.message : String(err),
        });
        options.logger?.warn(
          {
            tag: 'card-renderer/warm-failed',
            slug: input.species.slug,
            appearanceId: input.variant.appearanceId,
            err,
          },
          'card warm failed for one entry; continuing',
        );
      }

      done += 1;
      options.onProgress?.(done, inputs.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));

  result.durationMs = Date.now() - started;
  return result;
}
