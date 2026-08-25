/**
 * Cold masters are drawn on a worker thread — and nothing else is.
 *
 * The isolation only pays off if the *cheap* paths stay on the main thread: a
 * warm cache hit that queued behind two 1.4-second renders would be slower than
 * the blocking renderer it replaced. So the load-bearing assertions here are
 * as much about what never reaches a thread as about what does.
 *
 * `getStats().workers` is the instrument. It is absent until a pool actually
 * exists, and the pool is created lazily on the first cold master — so
 * `workers === undefined` is a direct statement that no expensive work
 * happened, not a proxy for one.
 *
 * The pool's own mechanics (bounding, queueing, crash recovery) are proved
 * against stand-in threads in `tests/unit/cards/renderPool.test.ts`; this file
 * is about the real worker running the real renderer.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CardArtworkMissingError,
  createCardRenderer,
  CARD_MASTER_WIDTH,
  type CardRenderer,
} from '../../../src/modules/cards';
import { cardInput, dimensionsOf, isWebp, makeTempDir, writeArtwork } from '../../helpers/cardFixtures';

let workdir: string;
let artwork: string;
const renderers: CardRenderer[] = [];

/** Each renderer gets its own cache root unless one is shared deliberately. */
function makeRenderer(options: { workers: number; cacheRoot?: string }): CardRenderer {
  const renderer = createCardRenderer({
    cacheRoot: options.cacheRoot ?? path.join(workdir, `cache-${renderers.length}`),
    workers: options.workers,
  });
  renderers.push(renderer);
  return renderer;
}

beforeAll(async () => {
  workdir = await makeTempDir('cards-worker');
  artwork = await writeArtwork(path.join(workdir, 'art', 'subject.png'), { r: 90, g: 40, b: 130 });
}, 60_000);

afterAll(async () => {
  // Every renderer, even the ones a failing test left behind: a leaked thread
  // would keep the Vitest worker alive after the suite reports.
  await Promise.all(renderers.map((renderer) => renderer.shutdown()));
  await fs.rm(workdir, { recursive: true, force: true });
});

describe('what reaches a worker', () => {
  it('draws a cold master on a thread', async () => {
    const renderer = makeRenderer({ workers: 2 });

    const card = await renderer.renderCard(cardInput(artwork, { slug: 'cold_master' }));

    expect(isWebp(card.bytes)).toBe(true);
    expect(card.fromCache).toBe(false);
    expect(renderer.getStats().workers?.dispatched).toBe(1);
  }, 60_000);

  it('serves a warm cache hit without ever starting a thread', async () => {
    const cacheRoot = path.join(workdir, 'shared-hit');
    // Warmed by a *different* renderer, so the one under test has no history.
    const warmer = makeRenderer({ workers: 0, cacheRoot });
    const input = cardInput(artwork, { slug: 'warm_hit' });
    await warmer.renderCard(input);

    const reader = makeRenderer({ workers: 2, cacheRoot });
    const card = await reader.renderCard(input);

    expect(card.fromCache).toBe(true);
    expect(reader.getStats().cacheHits).toBe(1);
    expect(reader.getStats().workers).toBeUndefined();
  }, 60_000);

  /**
   * A derivative is a sharp resize of bytes already on disk — milliseconds.
   * Sending it to the pool would put a 512px thumbnail behind however many
   * cold masters were queued at the time.
   */
  it('resizes a derivative from an existing master without a thread', async () => {
    const cacheRoot = path.join(workdir, 'shared-derivative');
    const warmer = makeRenderer({ workers: 0, cacheRoot });
    await warmer.renderCard(cardInput(artwork, { slug: 'derivative' }));

    const reader = makeRenderer({ workers: 2, cacheRoot });
    const card = await reader.renderCard(cardInput(artwork, { slug: 'derivative', width: 512 }));

    expect((await dimensionsOf(card.bytes)).width).toBe(512);
    expect(reader.getStats().derivativeRenders).toBe(1);
    expect(reader.getStats().workers).toBeUndefined();
  }, 60_000);

  /**
   * Dedupe happens on the main thread, before the queue, because it is the
   * only side that can see the disk cache. Five callers wanting one card must
   * cost one render — the alternative is five threads drawing the same image.
   */
  it('collapses concurrent identical requests into one worker job', async () => {
    const renderer = makeRenderer({ workers: 3 });
    const input = cardInput(artwork, { slug: 'deduped' });

    const cards = await Promise.all(Array.from({ length: 5 }, () => renderer.renderCard(input)));

    const stats = renderer.getStats();
    expect(stats.workers?.dispatched).toBe(1);
    expect(stats.masterRenders).toBe(1);
    expect(stats.dedupedRenders).toBe(4);
    expect(cards.every((card) => card.bytes.equals(cards[0]!.bytes))).toBe(true);
  }, 60_000);

  it('keeps a burst of distinct cards inside the configured thread count', async () => {
    const renderer = makeRenderer({ workers: 2 });

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        renderer.renderCard(cardInput(artwork, { slug: `burst_${i}` })),
      ),
    );

    const stats = renderer.getStats();
    expect(stats.workers?.dispatched).toBe(6);
    expect(stats.workers?.peakConcurrent).toBeLessThanOrEqual(2);
    expect(stats.workers?.workers).toBe(2);
  }, 120_000);
});

describe('equivalence with in-process rendering', () => {
  /**
   * The reason `workers: 0` is kept: it is the control case. Both paths call
   * the same `renderMasterBytes`, and this is what proves the thread boundary
   * added nothing — no re-encode, no colour shift, no truncation.
   */
  it('produces byte-identical masters either way', async () => {
    const input = cardInput(artwork, { slug: 'equivalence', level: 47, owned: true });

    const inProcess = await makeRenderer({ workers: 0 }).renderCard(input);
    const onWorker = await makeRenderer({ workers: 2 }).renderCard(input);

    expect(onWorker.bytes.equals(inProcess.bytes)).toBe(true);
    expect(onWorker.renderKey).toBe(inProcess.renderKey);
    expect(onWorker.etag).toBe(inProcess.etag);
    expect(onWorker.width).toBe(CARD_MASTER_WIDTH);
  }, 120_000);

  it('renders the same bytes twice from a cold cache', async () => {
    const input = cardInput(artwork, { slug: 'determinism', level: 3 });

    const first = await makeRenderer({ workers: 2 }).renderCard(input);
    const second = await makeRenderer({ workers: 2 }).renderCard(input);

    expect(second.bytes.equals(first.bytes)).toBe(true);
  }, 120_000);
});

describe('failures', () => {
  /**
   * A structured clone would arrive as a plain `Error`, and the HTTP layer
   * chooses between 404 and 500 on exactly this class. So the error has to
   * survive the thread boundary as itself.
   */
  it('reports missing artwork as its own error class, from the worker', async () => {
    const renderer = makeRenderer({ workers: 1 });
    const input = cardInput(path.join(workdir, 'art', 'does-not-exist.png'), { slug: 'no_art' });

    await expect(renderer.renderCard(input)).rejects.toBeInstanceOf(CardArtworkMissingError);
  }, 60_000);

  it('writes no cache file for a render that failed', async () => {
    const cacheRoot = path.join(workdir, 'failed-cache');
    const renderer = makeRenderer({ workers: 1, cacheRoot });
    const input = cardInput(path.join(workdir, 'art', 'missing-too.png'), { slug: 'no_art_cache' });

    await expect(renderer.renderCard(input)).rejects.toThrow();

    const entries = await fs.readdir(path.join(cacheRoot, 'no_art_cache')).catch(() => []);
    expect(entries).toEqual([]);
  }, 60_000);

  /** The in-flight key must clear, or the same card is unrenderable forever. */
  it('lets a card be retried after a failure, and succeed', async () => {
    const cacheRoot = path.join(workdir, 'retry-cache');
    const renderer = makeRenderer({ workers: 1, cacheRoot });
    const artPath = path.join(workdir, 'art', 'appears-later.png');

    await expect(
      renderer.renderCard(cardInput(artPath, { slug: 'retried' })),
    ).rejects.toBeInstanceOf(CardArtworkMissingError);

    await writeArtwork(artPath, { r: 10, g: 200, b: 90 });
    const card = await renderer.renderCard(cardInput(artPath, { slug: 'retried' }));

    expect(isWebp(card.bytes)).toBe(true);
  }, 60_000);
});

describe('shutdown', () => {
  it('releases the threads and reports none left', async () => {
    const renderer = makeRenderer({ workers: 2 });
    await renderer.renderCard(cardInput(artwork, { slug: 'shutdown_subject' }));
    expect(renderer.getStats().workers?.workers).toBeGreaterThan(0);

    await renderer.shutdown();

    expect(renderer.getStats().workers).toBeUndefined();
  }, 60_000);

  it('is a no-op on a renderer that never drew a card', async () => {
    await expect(makeRenderer({ workers: 2 }).shutdown()).resolves.toBeUndefined();
  });

  /** Shutting down must not be a one-way door for a still-running process. */
  it('renders again after a shutdown, on a fresh pool', async () => {
    const renderer = makeRenderer({ workers: 1 });
    await renderer.renderCard(cardInput(artwork, { slug: 'restart_a' }));
    await renderer.shutdown();

    const card = await renderer.renderCard(cardInput(artwork, { slug: 'restart_b' }));
    expect(isWebp(card.bytes)).toBe(true);
  }, 120_000);
});
