/**
 * Platform API authentication (plan §9 v1).
 *
 * One shared secret (`PLATFORM_API_TOKEN`), one way to present it:
 * `Authorization: Bearer <token>`. No cookies, therefore no CSRF surface —
 * a browser cannot be tricked into attaching an Authorization header.
 *
 * Beside it: Portal session cookies (CSRF-checked below), and read-only
 * integration keys (`Authorization: Integration <keyId>.<secret>`), which are
 * admitted only to opted-in GET routes — see `integrationAuth.ts`.
 *
 * Two deliberate choices:
 *
 *  - **`onRequest`, not `preHandler`.** The plan sketches this as a
 *    `preHandler`; running it at `onRequest` instead rejects before body
 *    parsing and schema validation, so an unauthenticated caller gets a flat
 *    401 rather than a 400 that would describe the route's expected shape.
 *    The v2 hook that resolves an identity onto `request.user` still belongs
 *    at `preHandler` — that one needs the route context, this one does not.
 *
 *  - **No per-IP failure budget.** The admin panel damps brute force because
 *    it fronts a browser login form; here the surface is loopback/tailnet only
 *    and a throttle would leak "that token was nearly right" through timing.
 *    Rate limiting arrives with public exposure in v2 (§10.7).
 *
 * The token is never logged and never echoed.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IntegrationApiConfig } from '../config/config';
import { AppError } from '../shared/errors';
import {
  IntegrationForbiddenError,
  IntegrationRateLimitedError,
  UnauthorizedError,
  mapAppErrorToStatus,
  toErrorBody,
} from './errors';
import {
  INTEGRATION_PATH_PREFIX,
  INTEGRATION_SCHEME,
  createIntegrationVerifier,
  createIntegrationRateLimiter,
  parseIntegrationCredential,
  type IntegrationRateLimiter,
} from './integrationAuth';
import {
  PORTAL_CSRF_COOKIE,
  PORTAL_CSRF_HEADER,
  PORTAL_SESSION_COOKIE,
  type PortalSession,
  type PortalSessionService,
} from './portalSession';

/**
 * Reachable without a token (plan §9). `/health` and `/ready` are ops targets;
 * the docs describe the contract, not the data behind it.
 *
 * Local copy of the admin panel's equivalents rather than a shared import:
 * this project treats `src/admin/**` as untouched, and the two surfaces are
 * meant to be able to diverge.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/ready',
  '/api/v1/openapi.json',
  '/auth/discord',
  '/auth/discord/callback',
  '/auth/session',
  '/auth/logout',
]);

/** Swagger UI serves its own JS/CSS beneath this prefix. */
const PUBLIC_PREFIXES: readonly string[] = ['/api/v1/docs'];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface ApiAuthDeps {
  token: string;
  portalSessions?: PortalSessionService | undefined;
  /** Read-only integration keys; absent means the `Integration` scheme is always 401. */
  integration?: IntegrationApiConfig | undefined;
  /** Per-key budget; defaults to `createIntegrationRateLimiter()`. */
  integrationRateLimiter?: IntegrationRateLimiter | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    portalSession?: PortalSession;
    apiAuth?: 'bearer' | 'portal' | 'integration';
  }
}

export function registerAuth(app: FastifyInstance, deps: ApiAuthDeps): void {
  const verifyIntegration = createIntegrationVerifier(deps.integration);
  const rateLimiter = deps.integrationRateLimiter ?? createIntegrationRateLimiter();

  async function refuse(req: FastifyRequest, reply: FastifyReply, err: AppError): Promise<void> {
    const status = mapAppErrorToStatus(err);
    await reply.code(status).send(toErrorBody(err, status, String(req.id)));
  }

  app.addHook('onRequest', async (req, reply) => {
    const pathname = req.url.split('?')[0] ?? '';
    if (isPublicPath(pathname)) return;

    const header = String(req.headers.authorization ?? '');

    // Integration credentials never fall back to a cookie or the bearer
    // token: a request that says `Integration` is judged as one, and a bad
    // one is a 401 even if the same browser also carries a Portal session.
    if (header.startsWith(INTEGRATION_SCHEME)) {
      const credential = parseIntegrationCredential(header.slice(INTEGRATION_SCHEME.length).trim());
      if (!deps.integration || !credential || !verifyIntegration(credential)) {
        // Path and method only — never the header, nor the presented key id,
        // which is attacker-controlled text.
        req.log.warn({ path: pathname, method: req.method }, 'platform api integration credential rejected');
        await refuse(req, reply, new UnauthorizedError());
        return;
      }
      req.apiAuth = 'integration';
      req.integrationKeyId = credential.keyId;

      const retryAfter = rateLimiter.take(credential.keyId);
      if (retryAfter !== null) {
        req.log.info({ keyId: credential.keyId, path: pathname }, 'platform api integration rate limited');
        void reply.header('retry-after', String(retryAfter));
        await refuse(req, reply, new IntegrationRateLimitedError());
        return;
      }

      // The allowlist: a read method, on a matched route that opted in, under
      // the integration prefix. The route flag is what actually decides — the
      // prefix test is a second, independent reading of the same intent.
      const readMethod = req.method === 'GET' || req.method === 'HEAD';
      const optedIn = req.routeOptions.config?.integrationRoute === true;
      if (!readMethod || !optedIn || !pathname.startsWith(INTEGRATION_PATH_PREFIX)) {
        req.log.warn(
          { keyId: credential.keyId, path: pathname, method: req.method },
          'platform api integration request outside its allowlist',
        );
        await refuse(req, reply, new IntegrationForbiddenError());
      }
      return;
    }

    if (header.startsWith('Bearer ') && constantTimeEquals(header.slice(7).trim(), deps.token)) {
      req.apiAuth = 'bearer';
      return;
    }

    const session = await deps.portalSessions?.getSession(req.cookies[PORTAL_SESSION_COOKIE]);
    if (session) {
      req.portalSession = session;
      req.apiAuth = 'portal';

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const csrfHeader = String(req.headers[PORTAL_CSRF_HEADER] ?? '');
        const csrfCookie = req.cookies[PORTAL_CSRF_COOKIE] ?? '';
        if (
          !csrfHeader ||
          !csrfCookie ||
          !constantTimeEquals(csrfHeader, session.csrfToken) ||
          !constantTimeEquals(csrfCookie, session.csrfToken)
        ) {
          const err = new AppError('PORTAL_CSRF_INVALID', 'Portal CSRF token mismatch', 'Request rejected.');
          await reply
            .code(mapAppErrorToStatus(err))
            .send(toErrorBody(err, mapAppErrorToStatus(err), String(req.id)));
          return;
        }
      }
      return;
    }

    // Path and method only — never the header, which holds the credential.
    req.log.warn({ path: pathname, method: req.method }, 'platform api request rejected: unauthorized');
    const err = new UnauthorizedError();
    await reply
      .code(mapAppErrorToStatus(err))
      .send(toErrorBody(err, mapAppErrorToStatus(err), String(req.id)));
  });
}
