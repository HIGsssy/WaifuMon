/**
 * The render pool's own behaviour, tested against stand-in threads.
 *
 * The pool exists because drawing a card blocks a thread for ~750 ms. What has
 * to be *true* of it — that it bounds concurrency, queues the rest, survives a
 * thread dying mid-job, and lets go of its threads on shutdown — has nothing to
 * do with cards. So these tests inject a thread that answers in microseconds
 * and can be told to crash on cue, which makes the properties provable rather
 * than merely plausible: a genuine worker crash is not something the render
 * path can be asked for.
 *
 * The real worker, running the real renderer, is covered end to end in
 * `tests/integration/cards/render.worker.test.ts`.
 */
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CardPoolClosedError,
  CardRenderPool,
  CardWorkerCrashedError,
} from '../../../src/modules/cards/worker/workerPool';
import { CardArtworkMissingError, CardAssetMissingError } from '../../../src/modules/cards';
import type { CardRenderInput } from '../../../src/modules/cards';

/**
 * A thread that speaks the pool's protocol without rendering anything.
 *
 * `holdMs` keeps a job occupied long enough for a burst to actually contend,
 * which is what makes the concurrency assertions meaningful. The behaviours
 * are chosen by the *slug* of the job, so one pool can be handed a mix.
 */
function fakeWorker(holdMs = 25): Worker {
  const source = `
    const { parentPort } = require('node:worker_threads');
    parentPort.on('message', (job) => {
      const slug = job.input.species.slug;
      if (slug === 'crash') { process.exit(7); }
      setTimeout(() => {
        if (slug === 'fail-artwork') {
          parentPort.postMessage({
            id: job.id, ok: false,
            error: { name: 'CardArtworkMissingError', code: 'CARD_ARTWORK_MISSING',
                     message: 'no artwork for ' + slug, userMessage: 'nope~',
                     stack: 'stack-from-worker', path: '/art/missing.png' },
          });
          return;
        }
        if (slug === 'fail-asset') {
          parentPort.postMessage({
            id: job.id, ok: false,
            error: { name: 'CardAssetMissingError', code: 'CARD_ASSET_MISSING',
                     message: 'kit broken', userMessage: null,
                     stack: undefined, path: '/kit/frames/ur.png' },
          });
          return;
        }
        const bytes = new Uint8Array([1, 2, 3, job.id % 251]);
        parentPort.postMessage({ id: job.id, ok: true, bytes }, [bytes.buffer]);
      }, ${holdMs});
    });
  `;
  return new Worker(source, { eval: true });
}

function input(slug: string): CardRenderInput {
  return {
    species: { slug, name: slug, rarity: 'SR', race: 'human', affinity: 'primal' },
    variant: { appearanceId: 'standard', artworkAbsolutePath: `/art/${slug}.png` },
  };
}

const pools: CardRenderPool[] = [];

function makePool(size: number, holdMs = 25): CardRenderPool {
  const pool = new CardRenderPool({
    assetRoot: '/kit',
    size,
    spawn: () => fakeWorker(holdMs),
  });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

describe('bounding', () => {
  it('starts no threads until something is actually rendered', () => {
    const pool = makePool(2);
    expect(pool.getStats().workers).toBe(0);
    expect(pool.getStats().spawned).toBe(0);
  });

  it('never runs more renders at once than it was configured for', async () => {
    const pool = makePool(2);

    await Promise.all(Array.from({ length: 12 }, (_, i) => pool.render(input(`card_${i}`))));

    const stats = pool.getStats();
    expect(stats.peakConcurrent).toBe(2);
    expect(stats.dispatched).toBe(12);
  });

  /** The whole point: 25 distinct cold cards must not become 25 threads. */
  it('answers a burst of distinct cards with `size` threads, not one each', async () => {
    const pool = makePool(2);

    await Promise.all(Array.from({ length: 25 }, (_, i) => pool.render(input(`burst_${i}`))));

    expect(pool.getStats().workers).toBe(2);
    expect(pool.getStats().spawned).toBe(2);
  });

  it('grows only as far as there is work for', async () => {
    const pool = makePool(4);
    await pool.render(input('lonely'));
    expect(pool.getStats().spawned).toBe(1);
  });

  it.each([1, 2, 3])('respects a configured size of %i', async (size) => {
    const pool = makePool(size);
    await Promise.all(Array.from({ length: 9 }, (_, i) => pool.render(input(`n${i}`))));
    expect(pool.getStats().peakConcurrent).toBe(size);
  });
});

describe('queueing', () => {
  it('runs every queued job, in order of arrival', async () => {
    const pool = makePool(1, 5);
    const order: string[] = [];

    await Promise.all(
      ['a', 'b', 'c', 'd'].map((slug) =>
        pool.render(input(slug)).then(() => {
          order.push(slug);
        }),
      ),
    );

    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports how deep the queue actually got', async () => {
    const pool = makePool(2);
    const all = Promise.all(Array.from({ length: 10 }, (_, i) => pool.render(input(`q${i}`))));
    expect(pool.getStats().queued).toBeGreaterThan(0);
    await all;
    expect(pool.getStats().peakQueued).toBeGreaterThanOrEqual(8);
    expect(pool.getStats().queued).toBe(0);
  });
});

describe('failures', () => {
  it('rejects with the error class the worker threw, not a plain Error', async () => {
    const pool = makePool(1, 1);
    await expect(pool.render(input('fail-artwork'))).rejects.toBeInstanceOf(
      CardArtworkMissingError,
    );
    await expect(pool.render(input('fail-asset'))).rejects.toBeInstanceOf(CardAssetMissingError);
  });

  it('carries the worker’s message, code and stack across the boundary', async () => {
    const pool = makePool(1, 1);
    await expect(pool.render(input('fail-artwork'))).rejects.toMatchObject({
      code: 'CARD_ARTWORK_MISSING',
      message: 'no artwork for fail-artwork',
      artworkPath: '/art/missing.png',
      stack: 'stack-from-worker',
    });
  });

  it('keeps serving after a failure — one bad card is not a broken pool', async () => {
    const pool = makePool(1, 1);
    await expect(pool.render(input('fail-artwork'))).rejects.toThrow();
    await expect(pool.render(input('fine'))).resolves.toBeInstanceOf(Buffer);
  });

  it('rejects the in-flight render when its thread dies under it', async () => {
    const pool = makePool(1, 1);
    await expect(pool.render(input('crash'))).rejects.toBeInstanceOf(CardWorkerCrashedError);
  });

  /**
   * The crash must cost exactly one card. Everything queued behind it has to
   * survive onto a replacement thread, or one unlucky render takes out the
   * whole burst behind it.
   */
  it('replaces the dead thread and finishes the work queued behind it', async () => {
    const pool = makePool(1, 1);

    const crashed = pool.render(input('crash'));
    const survivors = ['s1', 's2', 's3'].map((slug) => pool.render(input(slug)));

    await expect(crashed).rejects.toBeInstanceOf(CardWorkerCrashedError);
    const results = await Promise.all(survivors);

    expect(results.every((bytes) => Buffer.isBuffer(bytes))).toBe(true);
    expect(pool.getStats().replaced).toBe(1);
    expect(pool.getStats().spawned).toBeGreaterThan(1);
  });

  it('leaves nothing in flight after a crash', async () => {
    const pool = makePool(2, 1);
    await expect(pool.render(input('crash'))).rejects.toThrow();
    await pool.render(input('after'));
    expect(pool.getStats().queued).toBe(0);
  });
});

describe('shutdown', () => {
  it('lets go of every thread', async () => {
    const pool = makePool(2, 1);
    await Promise.all([pool.render(input('a')), pool.render(input('b'))]);
    expect(pool.getStats().workers).toBe(2);

    await pool.shutdown();
    expect(pool.getStats().workers).toBe(0);
  });

  it('refuses new work once closed rather than starting a thread for it', async () => {
    const pool = makePool(2, 1);
    await pool.shutdown();

    await expect(pool.render(input('late'))).rejects.toBeInstanceOf(CardPoolClosedError);
    expect(pool.getStats().spawned).toBe(0);
  });

  it('is safe to call twice, and on a pool that never rendered', async () => {
    const pool = makePool(2);
    await expect(pool.shutdown()).resolves.toBeUndefined();
    await expect(pool.shutdown()).resolves.toBeUndefined();
  });

  /** A queued job is dropped rather than run: shutdown is bounded by one render. */
  it('rejects work still waiting in the queue', async () => {
    const pool = makePool(1, 40);
    const running = pool.render(input('running'));
    const waiting = pool.render(input('waiting'));

    const closing = pool.shutdown();
    await expect(waiting).rejects.toBeInstanceOf(CardPoolClosedError);
    await expect(running).resolves.toBeInstanceOf(Buffer);
    await closing;
  });
});
