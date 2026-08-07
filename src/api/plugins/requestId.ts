/**
 * Request correlation (plan §14 Observability).
 *
 * Every request carries an id: the caller's `X-Request-Id` when it supplies a
 * sane one, otherwise a fresh UUID. It becomes Fastify's `request.id`, so Pino
 * stamps it on the request/response log lines for free, and it is echoed back
 * on the response header and in the error body.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';
export const API_VERSION_HEADER = 'x-waifumon-api-version';
export const API_VERSION = '1';

/** Ids end up in log lines and headers — keep them boring and bounded. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function normalizeRequestId(supplied: unknown): string {
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (typeof value === 'string' && SAFE_REQUEST_ID.test(value)) return value;
  return randomUUID();
}

/** Fastify `genReqId` — runs before hooks, so `request.id` is set everywhere. */
export function genRequestId(req: { headers: FastifyRequest['headers'] }): string {
  return normalizeRequestId(req.headers[REQUEST_ID_HEADER]);
}

/**
 * Echoes the correlation id and the API version on every response — including
 * 401s, 404s and 500s, because it is set on the way in rather than per route.
 */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
    reply.header(API_VERSION_HEADER, API_VERSION);
  });
}
