/**
 * Wires request timing into a {@link LatencyRecorder}.
 *
 * ## Where the hooks sit, and why it matters
 *
 * `onRequest` is the earliest hook Fastify offers — before body parsing, before
 * validation, before auth. Starting the clock there is what makes the recorded
 * duration *server-side latency as a client would experience it*, rather than
 * handler time with the expensive parts excluded. A 413 rejected at the body
 * limit and a 401 rejected by the auth hook both belong in the distribution,
 * because a client waited for both.
 *
 * `onResponse` fires after the response has been handed to the socket, so it
 * sees the final status code — including the ones the error handler substituted.
 * `onRequest` + `onResponse` therefore pair exactly once per served request.
 *
 * `onRequestAbort` covers the case that would otherwise leak: a client that
 * disconnects mid-request gets no `onResponse`, so without this hook `inFlight`
 * would ratchet upward for the life of the process. Under a load test that
 * ratchet would be indistinguishable from real saturation, which is precisely
 * the wrong thing to get wrong in an instrument built for load testing.
 *
 * ## Timing source
 *
 * `process.hrtime.bigint()` rather than `Date.now()`: monotonic, unaffected by
 * NTP steps, and nanosecond-resolution, which the recorder needs because it
 * stores microseconds. The start timestamp rides on the request object under a
 * symbol so it cannot collide with a route's own decorators.
 */
import type { FastifyInstance } from 'fastify';
import type { LatencyRecorder } from '../../shared/metrics';

/** Symbol-keyed so nothing else on the request can shadow or read it by accident. */
const START_NS = Symbol('waifumon.metrics.startNs');

interface TimedRequest {
  [START_NS]?: bigint;
}

const NS_PER_MS = 1_000_000;

/**
 * Registers the timing hooks.
 *
 * Must be called before the routes it should observe, for the same reason the
 * auth hook is: Fastify applies hooks to routes registered after them in the
 * same encapsulation context.
 */
export function registerRequestMetrics(app: FastifyInstance, recorder: LatencyRecorder): void {
  app.addHook('onRequest', async (req) => {
    (req as unknown as TimedRequest)[START_NS] = process.hrtime.bigint();
    recorder.requestStarted();
  });

  app.addHook('onResponse', async (req, reply) => {
    const started = (req as unknown as TimedRequest)[START_NS];
    // No start stamp means this request never passed the onRequest hook above —
    // it cannot be timed, and counting it would be counting a duration we did
    // not measure.
    if (started === undefined) return;

    const durationMs = Number(process.hrtime.bigint() - started) / NS_PER_MS;
    recorder.recordResponse({
      method: req.method,
      // The route *pattern* — `routeOptions.url` is undefined for a request
      // that matched nothing, which the recorder folds into `<unrouted>`.
      route: req.routeOptions?.url,
      statusCode: reply.statusCode,
      durationMs,
    });
  });

  app.addHook('onRequestAbort', async (req) => {
    if ((req as unknown as TimedRequest)[START_NS] === undefined) return;
    recorder.requestAborted();
  });
}
