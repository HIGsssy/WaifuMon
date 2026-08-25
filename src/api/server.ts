/**
 * Waifumon Platform API — internal REST surface (plan §1, §12 Phase 1).
 *
 * A second Fastify instance in the bot's own process, on its own port. It is
 * a thin HTTP adapter over the existing service layer: it owns no gameplay
 * logic, touches no tables directly, and shares `AppContext` in memory. The
 * Discord command pipeline is unaffected and unaware of it.
 *
 * Disabled by default. When `PLATFORM_API_ENABLED=true` it binds to
 * `PLATFORM_API_HOST` (127.0.0.1 by default) behind a shared bearer token —
 * operators reach it over an SSH tunnel or a tailnet address:
 *
 *   ssh -L 3120:127.0.0.1:3120 user@server
 *
 * The bind is not the address clients use: `PLATFORM_API_PUBLIC_URL` carries
 * that, and is what the OpenAPI `servers` list (and so Swagger UI's "Try it
 * out") advertises.
 *
 * Deliberate omissions in v1: no TLS (loopback/tailnet only), no CORS
 * (browsers are not a v1 client), no rate limiting (§10.7), and no
 * `GameEvent` emission from HTTP handlers (§5) — a documented, temporary gap.
 */
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { resolvePublicUrl, type PlatformApiConfig } from '../config/config';
import { AppError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import { registerAuth } from './auth';
import type { ApiContext } from './context';
import {
  ApiNotFoundError,
  ApiValidationError,
  mapAppErrorToStatus,
  toErrorBody,
} from './errors';
import { API_VERSION, genRequestId, registerRequestId } from './plugins/requestId';
import { registerTypeProvider, type ZodFastify } from './plugins/typeProvider';
import { registerHealthRoutes, type ReadinessProbes } from './routes/health';
import { v1Routes } from './routes/v1/index';

/** No v1 endpoint needs a large body; a small cap is free DoS hygiene. */
const BODY_LIMIT_BYTES = 64 * 1024;

export interface PlatformApiDeps {
  config: PlatformApiConfig;
  logger: Logger;
  probes: ReadinessProbes;
  /** Services + content snapshot the v1 routes adapt. */
  ctx: ApiContext;
}

/**
 * Loopback (127.0.0.0/8) and the Tailscale CGNAT range (100.64.0.0/10) are the
 * two binds this API is designed for. Anything else — including the 0.0.0.0
 * that Docker requires *inside* the container — gets a startup warning, since
 * from the process's point of view it cannot tell a published-to-loopback
 * container from a publicly reachable one.
 */
export function isPrivateBind(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  if (octets.length !== 4) return false;
  const parts = octets.map((o) => Number(o));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true;
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Builds the instance without listening — tests drive it with `app.inject()`,
 * and `startPlatformApi` binds it for real.
 */
export async function createPlatformApiServer(deps: PlatformApiDeps): Promise<ZodFastify> {
  if (deps.config.token.trim().length === 0) {
    throw new Error('createPlatformApiServer requires a non-empty platform API token');
  }

  const base: FastifyInstance = Fastify({
    // Cast keeps the instance at Fastify's generic logger type; pino's own
    // Logger generic would otherwise leak into every route signature.
    // Fastify's request log records method, url and remote address — never
    // headers — and the redaction below is the belt to that braces, so the
    // bearer token cannot reach the log even if someone logs a request object.
    loggerInstance: deps.logger.child(
      { component: 'platform-api' },
      { redact: { paths: ['req.headers.authorization', 'headers.authorization'], censor: '[redacted]' } },
    ) as FastifyBaseLogger,
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: false,
    genReqId: genRequestId,
  });

  const app = registerTypeProvider(base);

  // Idempotent actions (`/ensure`, `/care/exit`) carry no payload. Fastify's
  // default parser rejects an empty body outright, which would make
  // `curl -X POST -H 'content-type: application/json'` fail confusingly.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done): void => {
      const text = String(body).trim();
      if (text.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        const parseError = err as Error & { statusCode?: number };
        parseError.statusCode = 400;
        done(parseError, undefined);
      }
    },
  );

  registerRequestId(app);

  await app.register(helmet, {
    // JSON only, plus a Swagger UI that needs inline styles — a CSP here would
    // buy nothing and break the docs page.
    contentSecurityPolicy: false,
  });

  // Auth before every route registration below: Fastify hooks apply to routes
  // registered after them in the same encapsulation context. Public paths
  // (health, ready, docs, spec) are allow-listed inside the hook.
  registerAuth(app, { token: deps.config.token });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Waifumon Platform API',
        version: `${API_VERSION}.0.0`,
        description:
          'Internal REST surface over the Waifumon game service layer.\n\n' +
          '**Private by default.** Bound to loopback and gated by a shared bearer token; ' +
          'there is no TLS, no CORS and no player authentication in v1.\n\n' +
          '**v1 API mutations do not emit Game Events.** Actions taken through this API do not ' +
          'appear in the Activity Feed and do not update Trainer Profiles. This is an intentional, ' +
          'temporary limitation of the internal API (see the plan, §5) and will be lifted additively.\n\n' +
          'Success responses are `{ "data": … }` (plus `page`/`pageSize`/`total` when paginated) with an ' +
          'optional forward-compatible `meta` object. Errors are ' +
          '`{ "error": { "code", "message", "details"? }, "requestId" }`.',
      },
      // The bind is deliberately *not* used here: under Docker it is 0.0.0.0,
      // which is a listening address, not one a browser can dial. Swagger UI
      // builds its "Try it out" requests from this list.
      servers: [
        {
          url: resolvePublicUrl(deps.config),
          description: 'Base URL clients use (set PLATFORM_API_PUBLIC_URL to override).',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'The value of `PLATFORM_API_TOKEN`.',
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'System', description: 'Liveness, readiness and platform metadata.' },
        { name: 'Players', description: 'Identity, level and the composite profile.' },
        { name: 'Collection', description: 'Owned Waifumon, dex progress and the active buddy.' },
        { name: 'Currency', description: 'Hunt Energy, WaifuBux and Essence balances.' },
        { name: 'Inventory', description: 'Items a player holds.' },
        { name: 'Effects', description: 'Active consumable buffs.' },
        { name: 'Care Mode', description: 'Idle energy recovery and Waifumon training.' },
        { name: 'Encounters', description: 'The short-lived encounter a hunt raises.' },
        { name: 'Daily', description: 'Daily reward status.' },
        { name: 'Quests', description: 'Assigned daily quests and their progress.' },
        { name: 'Shop', description: 'What is for sale.' },
        { name: 'Sessions', description: 'Per-channel tallies and Trainer Profile pointers.' },
        { name: 'Content', description: 'Authored species, items, tuning tables and quest pool.' },
        { name: 'Guilds', description: 'Guild configuration (read-only in v1).' },
        {
          name: 'Cards',
          description:
            'Server-rendered card images (`image/webp`, not JSON). Present only when ' +
            'CARD_RENDERER_ENABLED.',
        },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/api/v1/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // Both handlers must be installed *before* the routes. Fastify's error and
  // not-found handlers are encapsulated: a child context created by
  // `register` captures whatever handler is on its parent at that moment, so
  // setting them afterwards would leave every v1 route on the framework
  // defaults — and those emit `{statusCode, error, message}`, which does not
  // match the error schema the routes declare.
  app.setNotFoundHandler(async (req, reply) => {
    const err = new ApiNotFoundError(`No route for ${req.method} ${req.url.split('?')[0] ?? ''}`);
    return reply.code(404).send(toErrorBody(err, 404, String(req.id)));
  });

  app.setErrorHandler(async (err: FastifyError, req, reply) => {
    const requestId = String(req.id);

    // Zod rejected the request shape — 400, with the offending paths so a
    // client can fix its call. Field paths only, never submitted values.
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({
        path: v.instancePath,
        message: v.message,
      }));
      const validationError = new ApiValidationError('Request failed schema validation');
      req.log.info({ issues, path: req.url }, 'platform api request failed validation');
      return reply.code(400).send(toErrorBody(validationError, 400, requestId, { issues }));
    }

    if (err instanceof AppError) {
      const status = mapAppErrorToStatus(err);
      // 5xx is ours to fix and gets a stack; 4xx is the caller's and does not.
      if (status >= 500) req.log.error({ err, requestId }, 'platform api request failed');
      else req.log.info({ code: err.code, status, path: req.url }, 'platform api request refused');
      return reply.code(status).send(toErrorBody(err, status, requestId));
    }

    // Fastify's own client errors (malformed JSON, body too large, unsupported
    // media type) already carry the right status; keep it, drop the detail.
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err, requestId }, 'platform api request failed');
    const wrapped = new AppError(
      status === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      err.message,
      status >= 500 ? 'Internal error.' : 'The request was not valid.',
    );
    return reply.code(status).send(toErrorBody(wrapped, status, requestId));
  });

  registerHealthRoutes(app, deps.probes);
  await app.register(
    v1Routes(deps.ctx, { cards: deps.config.cardRendererEnabled === true }),
    { prefix: '/api/v1' },
  );

  return app;
}

export interface PlatformApiHandle {
  app: ZodFastify;
  close: () => Promise<void>;
}

/**
 * Starts the API when enabled. Returns null when disabled so the caller can
 * treat "no platform API" as a normal, silent state — that null is what makes
 * `PLATFORM_API_ENABLED=false` a true zero-overhead rollback (§14).
 */
export async function startPlatformApi(deps: PlatformApiDeps): Promise<PlatformApiHandle | null> {
  if (!deps.config.enabled) return null;

  const app = await createPlatformApiServer(deps);
  await app.listen({ host: deps.config.host, port: deps.config.port });
  // Two addresses, on purpose: the bind is where we listen, the public URL is
  // what a client (and Swagger UI) should actually call. They differ under
  // Docker, where the bind is 0.0.0.0 and a printed link to it would not work.
  const publicUrl = resolvePublicUrl(deps.config);
  deps.logger.info(
    { host: deps.config.host, port: deps.config.port, publicUrl },
    `platform API listening on ${deps.config.host}:${deps.config.port} — ` +
      `clients use ${publicUrl}/api/v1 (docs: ${publicUrl}/api/v1/docs)`,
  );
  if (!isPrivateBind(deps.config.host)) {
    deps.logger.warn(
      { host: deps.config.host },
      'platform API is bound to a public interface — it is neither loopback (127.0.0.0/8) nor ' +
        'Tailscale (100.64.0.0/10). Under Docker this is expected (the container binds 0.0.0.0 and ' +
        'the host publishes on PLATFORM_API_PUBLISH_HOST); anywhere else, fix the bind or front it ' +
        'with a TLS reverse proxy.',
    );
  }
  return { app, close: () => app.close() };
}
