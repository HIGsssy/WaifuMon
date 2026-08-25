/**
 * The render worker's entry point. Runs on a `worker_threads` thread.
 *
 * Its whole job: take a render job, draw the master, post the bytes back. It
 * does not know about the disk cache, in-flight dedupe, ETags, derivative
 * widths or HTTP — all of that stays on the main thread, where it is cheap.
 * What is *here* is precisely the part that blocks a thread for ~750 ms, and
 * the point of the exercise is that the thread it blocks is no longer the one
 * serving Discord and Fastify.
 *
 * One job at a time: the pool never dispatches to a busy worker, so there is
 * no queue in here and no interleaving to reason about.
 */
import { parentPort, type MessagePort } from 'node:worker_threads';
import { CardAssetLoader } from '../assets/loader';
import { renderMasterBytes } from '../rasterizer/masterRender';
import { serializeCardError, type CardRenderJob, type CardRenderResponse } from './protocol';

/** Loading this file on the main thread is a wiring bug, not a render failure. */
function requirePort(): MessagePort {
  if (parentPort === null) {
    throw new Error('cardRenderWorker must be started as a worker thread');
  }
  return parentPort;
}

const port = requirePort();

/**
 * One loader per kit root, memoized for the life of the thread.
 *
 * This is what makes worker-side asset loading cheap: the frames, icons, fonts
 * and geometry manifest are read on a worker's first card and held from then
 * on, so the per-job payload stays tiny and the kit never crosses the thread
 * boundary. In practice the map holds one entry — a second appears only in
 * tests that point a renderer at a temp copy of the kit.
 */
const loaders = new Map<string, CardAssetLoader>();

function loaderFor(assetRoot: string): CardAssetLoader {
  let loader = loaders.get(assetRoot);
  if (loader === undefined) {
    loader = new CardAssetLoader(assetRoot);
    loaders.set(assetRoot, loader);
  }
  return loader;
}

async function handle(job: CardRenderJob): Promise<void> {
  let response: CardRenderResponse;
  const transfers: ArrayBuffer[] = [];

  try {
    const master = await renderMasterBytes(loaderFor(job.assetRoot), job.input);

    // Copied into a fresh buffer rather than transferring `master.buffer`
    // directly. A Buffer from sharp can be a *view* into a larger pooled
    // ArrayBuffer, and transferring that would detach memory the encoder may
    // still be holding — and would hand the main thread the whole pool rather
    // than this card. One copy of ~570 KB is a rounding error against the
    // render that produced it.
    const bytes = new Uint8Array(master.byteLength);
    bytes.set(master);
    response = { id: job.id, ok: true, bytes };
    transfers.push(bytes.buffer);
  } catch (err) {
    response = { id: job.id, ok: false, error: serializeCardError(err) };
  }

  port.postMessage(response, transfers);
}

port.on('message', (job: CardRenderJob) => {
  // The handler never rejects — every failure is reported as a response — so
  // an unhandled rejection here would be a bug in `handle`, not a render
  // failure. Kept as a `void` call so the message listener stays synchronous.
  void handle(job);
});
