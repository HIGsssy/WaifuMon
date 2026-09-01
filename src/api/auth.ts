/**
 * Platform API authentication (plan §9 v1).
 *
 * One shared secret (`PLATFORM_API_TOKEN`), one way to present it:
 * `Authorization: Bearer <token>`. No cookies, therefore no CSRF surface —
 * a browser cannot be tricked into attaching an Authorization header.
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
import type { FastifyInstance } from 'fastify';
import { AppError } from '../shared/errors';
import { UnauthorizedError, mapAppErrorToStatus, toErrorBody } from './errors';
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
}

declare module 'fastify' {
  interface FastifyRequest {
    portalSession?: PortalSession;
    apiAuth?: 'bearer' | 'portal';
  }
}

export function registerAuth(app: FastifyInstance, deps: ApiAuthDeps): void {
  app.addHook('onRequest', async (req, reply) => {
    const pathname = req.url.split('?')[0] ?? '';
    if (isPublicPath(pathname)) return;

    const header = String(req.headers.authorization ?? '');
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
