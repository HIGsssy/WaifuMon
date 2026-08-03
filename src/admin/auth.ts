/**
 * Admin panel authentication (Admin Milestone 1).
 *
 * One shared secret (`ADMIN_WEB_TOKEN`), two ways to present it:
 *  - browsers POST it once to `/admin/login`, which sets an httpOnly,
 *    SameSite=Strict session cookie holding a SHA-256 digest of the token —
 *    the secret itself never goes back to the client;
 *  - scripts send `Authorization: Bearer <token>` per request.
 *
 * CSRF: cookie-authenticated writes must echo the non-httpOnly `wm_admin_csrf`
 * cookie in an `x-admin-csrf` header (double-submit). Bearer requests skip it —
 * a browser cannot be tricked into attaching an Authorization header.
 *
 * The token is never logged, never rendered, and never written to a cookie.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'wm_admin_session';
export const CSRF_COOKIE = 'wm_admin_csrf';
export const CSRF_HEADER = 'x-admin-csrf';

/** Public paths that must stay reachable without a session. */
const PUBLIC_PATHS = new Set(['/admin/login']);

const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Brute-force damper: per-IP failed-login budget over a rolling window. */
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_FAILURES = 10;

export function sessionDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook once credentials check out. */
    adminAuth?: 'cookie' | 'bearer';
  }
}

/** Only same-origin admin paths are accepted as a post-login destination. */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string') return '/admin';
  if (!value.startsWith('/admin')) return '/admin';
  if (value.startsWith('//') || value.includes('\\')) return '/admin';
  return value;
}

/**
 * Browsers get a redirect to the login form; anything else (fetch, curl, the
 * page script) gets a 401 it can act on. A missing Accept header is treated as
 * an API client, not a browser.
 */
function wantsHtml(req: FastifyRequest): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return String(req.headers.accept ?? '').includes('text/html');
}

export interface AuthDeps {
  token: string;
  /** Set the Secure cookie flag (only correct behind TLS). */
  secureCookies: boolean;
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const expectedSession = sessionDigest(deps.token);
  const failures = new Map<string, { count: number; resetAt: number }>();

  function noteFailure(ip: string): boolean {
    const now = Date.now();
    const entry = failures.get(ip);
    if (!entry || entry.resetAt <= now) {
      failures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return false;
    }
    entry.count += 1;
    return entry.count > LOGIN_MAX_FAILURES;
  }

  function throttled(ip: string): boolean {
    const entry = failures.get(ip);
    return entry != null && entry.resetAt > Date.now() && entry.count > LOGIN_MAX_FAILURES;
  }

  app.addHook('onRequest', async (req, reply) => {
    const pathname = req.url.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(pathname)) return;

    const authHeader = String(req.headers.authorization ?? '');
    if (authHeader.startsWith('Bearer ')) {
      if (constantTimeEquals(authHeader.slice(7).trim(), deps.token)) {
        req.adminAuth = 'bearer';
        return;
      }
      return deny(req, reply, pathname);
    }

    const session = req.cookies[SESSION_COOKIE];
    if (!session || !constantTimeEquals(session, expectedSession)) {
      return deny(req, reply, pathname);
    }
    req.adminAuth = 'cookie';

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const header = String(req.headers[CSRF_HEADER] ?? '');
      const cookie = req.cookies[CSRF_COOKIE] ?? '';
      if (!header || !cookie || !constantTimeEquals(header, cookie)) {
        req.log.warn({ path: pathname }, 'admin request rejected: CSRF token mismatch');
        await reply.code(403).send({ ok: false, errors: ['CSRF token missing or invalid'] });
      }
    }
  });

  async function deny(
    req: FastifyRequest,
    reply: FastifyReply,
    pathname: string,
  ): Promise<void> {
    req.log.warn({ path: pathname, method: req.method }, 'admin request rejected: unauthorized');
    if (wantsHtml(req)) {
      await reply.redirect(`/admin/login?next=${encodeURIComponent(pathname)}`, 302);
      return;
    }
    await reply.code(401).send({ ok: false, errors: ['Unauthorized'] });
  }

  app.post('/admin/login', async (req, reply) => {
    const ip = req.ip ?? 'unknown';
    if (throttled(ip)) {
      return reply
        .code(429)
        .send({ ok: false, errors: ['Too many failed attempts — wait a few minutes.'] });
    }
    const body = (req.body ?? {}) as { token?: unknown; next?: unknown };
    const supplied = typeof body.token === 'string' ? body.token.trim() : '';
    if (!supplied || !constantTimeEquals(supplied, deps.token)) {
      noteFailure(ip);
      req.log.warn({ ip }, 'admin login failed');
      return reply.code(401).send({ ok: false, errors: ['Invalid admin token'] });
    }
    failures.delete(ip);
    const base = {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: deps.secureCookies,
      maxAge: SESSION_MAX_AGE_SECONDS,
    } as const;
    reply.setCookie(SESSION_COOKIE, expectedSession, base);
    // Readable by the page script on purpose — this is the double-submit half.
    reply.setCookie(CSRF_COOKIE, randomBytes(24).toString('hex'), { ...base, httpOnly: false });
    req.log.info({ ip }, 'admin login succeeded');
    return reply.send({ ok: true, redirect: safeNextPath(body.next) });
  });

  app.post('/admin/logout', async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.send({ ok: true, redirect: '/admin/login' });
  });
}
