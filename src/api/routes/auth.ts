import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors';
import {
  PORTAL_CSRF_COOKIE,
  PORTAL_CSRF_HEADER,
  PORTAL_OAUTH_STATE_COOKIE,
  PORTAL_SESSION_COOKIE,
  portalRedirectUri,
  type PortalSessionConfig,
  type PortalSessionService,
} from '../portalSession';

const guildBody = z.object({ discordGuildId: z.string().min(1) });

function frontendRedirect(config: PortalSessionConfig, path: string): string {
  return new URL(path, config.publicUrl).toString();
}

function cookieBase(config: PortalSessionConfig) {
  return {
    httpOnly: true,
    secure: config.forwardedProto === 'https',
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionTtlSeconds,
  } as const;
}

function setSessionCookies(reply: FastifyReply, config: PortalSessionConfig, token: string, csrf: string): void {
  reply.setCookie(PORTAL_SESSION_COOKIE, token, cookieBase(config));
  reply.setCookie(PORTAL_CSRF_COOKIE, csrf, { ...cookieBase(config), httpOnly: false });
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(PORTAL_SESSION_COOKIE, { path: '/' });
  reply.clearCookie(PORTAL_CSRF_COOKIE, { path: '/' });
}

function assertCsrf(req: FastifyRequest, sessions: PortalSessionService, expected: string): void {
  const header = String(req.headers[PORTAL_CSRF_HEADER] ?? '');
  const cookie = req.cookies[PORTAL_CSRF_COOKIE] ?? '';
  if (!header || !cookie || !sessions.safeEquals(header, expected) || !sessions.safeEquals(cookie, expected)) {
    throw new AppError('PORTAL_CSRF_INVALID', 'Portal CSRF token mismatch', 'Request rejected.');
  }
}

export interface PortalAuthRouteDeps {
  config: PortalSessionConfig;
  sessions: PortalSessionService;
}

export function registerPortalAuthRoutes(app: FastifyInstance, deps: PortalAuthRouteDeps): void {
  const { config, sessions } = deps;
  const redirectUri = portalRedirectUri(config.publicUrl);

  app.get('/auth/discord', async (_req, reply) => {
    const state = await sessions.createOAuthState();
    reply.setCookie(PORTAL_OAUTH_STATE_COOKIE, state, {
      ...cookieBase(config),
      maxAge: 10 * 60,
    });
    const auth = new URL('https://discord.com/oauth2/authorize');
    auth.searchParams.set('client_id', config.discordClientId);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', 'identify guilds');
    auth.searchParams.set('state', state);
    return reply.redirect(auth.toString(), 302);
  });

  app.get('/auth/discord/callback', async (req, reply) => {
    const query = req.query as { code?: unknown; state?: unknown; error?: unknown; error_description?: unknown };
    if (typeof query.error === 'string') {
      req.log.info({ discordError: query.error }, 'portal oauth denied');
      return reply.redirect(frontendRedirect(config, '/select-player?auth=denied'), 302);
    }

    const code = typeof query.code === 'string' ? query.code : '';
    const state = typeof query.state === 'string' ? query.state : '';
    const cookieState = req.cookies[PORTAL_OAUTH_STATE_COOKIE] ?? '';
    reply.clearCookie(PORTAL_OAUTH_STATE_COOKIE, { path: '/' });

    if (!code || !state || !cookieState || !sessions.safeEquals(state, cookieState)) {
      throw new AppError('OAUTH_STATE_INVALID', 'Portal OAuth state missing or mismatched', 'Sign-in expired. Try again.');
    }
    if (!(await sessions.consumeOAuthState(state))) {
      throw new AppError('OAUTH_STATE_INVALID', 'Portal OAuth state expired or already used', 'Sign-in expired. Try again.');
    }

    const created = await sessions.completeOAuth(code, redirectUri);
    setSessionCookies(reply, config, created.token, created.session.csrfToken);
    return reply.redirect(frontendRedirect(config, '/dashboard'), 302);
  });

  app.get('/auth/session', async (req, reply) => {
    const session = await sessions.getSession(req.cookies[PORTAL_SESSION_COOKIE]);
    if (session) reply.setCookie(PORTAL_CSRF_COOKIE, session.csrfToken, { ...cookieBase(config), httpOnly: false });
    return reply.send(sessions.toBrowserSession(session));
  });

  app.post('/auth/logout', async (req, reply) => {
    const session = await sessions.getSession(req.cookies[PORTAL_SESSION_COOKIE]);
    if (session) assertCsrf(req, sessions, session.csrfToken);
    await sessions.logout(req.cookies[PORTAL_SESSION_COOKIE]);
    clearSessionCookies(reply);
    return reply.send({ ok: true });
  });

  app.post('/auth/guild', async (req: FastifyRequest, reply) => {
    const parsed = guildBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'Invalid guild selection body', 'The request was not valid.');
    }
    const session = await sessions.getSession(req.cookies[PORTAL_SESSION_COOKIE]);
    if (!session) throw new AppError('UNAUTHORIZED', 'Portal session required', 'Unauthorized.');
    assertCsrf(req, sessions, session.csrfToken);
    const next = await sessions.selectGuild(session, parsed.data.discordGuildId);
    if (!next) {
      throw new AppError('PORTAL_GUILD_FORBIDDEN', 'Guild selection was not eligible', 'That server is not available for this account.');
    }
    return reply.send(sessions.toBrowserSession(next));
  });
}
