/**
 * Internal admin web panel (Admin Milestone 1).
 *
 * Disabled by default. When `ADMIN_WEB_ENABLED=true` it binds to
 * `ADMIN_WEB_HOST` (127.0.0.1 by default) so it is reachable only from the
 * host itself — operators tunnel in:
 *
 *   ssh -L 3111:127.0.0.1:3111 user@server
 *
 * The panel is a sibling module of the bot: it shares the content service and
 * the seeding path but owns no gameplay logic of its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import type { AdminWebConfig } from '../config/config';
import type { AdminContentService } from '../modules/content/adminContentService';
import type { Logger } from '../shared/logger';
import { registerAuth } from './auth';
import { registerRoutes } from './routes';
import type { WorldEncounterAdminService } from '../modules/worldEncounters/adminService';

export interface AdminServerDeps {
  config: AdminWebConfig;
  content: AdminContentService;
  /**
   * World-encounter admin CRUD backend. Optional: the panel still boots
   * without it (the Encounters tab explains it is not wired), so a lightly-
   * configured deployment can skip the whole feature without pulling on the
   * server graph.
   */
  worldEncounters?: WorldEncounterAdminService | undefined;
  logger: Logger;
}

/**
 * Builds the Fastify instance without listening — tests drive it with
 * `app.inject()`, and `startAdminServer` binds it for real.
 */
export async function createAdminServer(deps: AdminServerDeps): Promise<FastifyInstance> {
  if (deps.config.token.trim().length === 0) {
    throw new Error('createAdminServer requires a non-empty admin token');
  }

  const app: FastifyInstance = Fastify({
    // Cast keeps the instance at Fastify's generic logger type; pino's own
    // Logger generic would otherwise leak into every route signature.
    // Fastify's default request log records method, url and remote address —
    // never headers or cookies, so the admin token cannot leak into the logs.
    loggerInstance: deps.logger.child({ component: 'admin-web' }) as FastifyBaseLogger,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: false,
  });

  // Several actions (validate, reload, toggle) carry no payload. Fastify's
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

  await app.register(cookie);

  registerAuth(app, {
    token: deps.config.token,
    // Loopback-only by default, so Secure cookies would make login impossible
    // over plain http. Behind a TLS reverse proxy, set the host accordingly.
    secureCookies: false,
  });
  registerRoutes(app, deps.content, deps.worldEncounters);

  app.setNotFoundHandler(async (req, reply) => {
    if (String(req.headers.accept ?? '').includes('text/html')) {
      return reply.code(404).type('text/html').send('<h1>404 — not found</h1><a href="/admin">Back to the dashboard</a>');
    }
    return reply.code(404).send({ ok: false, errors: ['Not found'] });
  });

  app.setErrorHandler(async (err: FastifyError, req, reply) => {
    // Client errors (bad JSON, body too large) keep their own status; anything
    // unexpected is a 500.
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    req.log.error({ err }, 'admin request failed');
    return reply.code(status).send({
      ok: false,
      message: status === 500 ? 'Internal error' : 'Bad request — nothing was written.',
      errors: [err.message],
    });
  });

  return app;
}

export interface AdminServerHandle {
  app: FastifyInstance;
  close: () => Promise<void>;
}

/**
 * A read-only content directory is the most common admin-panel misconfiguration
 * — under Docker it means the image's baked-in `content/` was not bind-mounted,
 * or the container uid does not own the mount. Without this check the symptom is
 * an opaque 500 on the first save; with it, the problem is stated at startup.
 *
 * Reported as a warning rather than a fatal: read-only browsing and content
 * validation are still genuinely useful, and the bot itself is unaffected.
 */
export function checkContentWritable(contentDir: string, logger: Logger): boolean {
  const probe = path.join(contentDir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    logger.warn(
      { contentDir, err: (err as Error).message },
      'admin web panel: CONTENT_DIR is not writable — browsing and validation work, ' +
        'but every save will fail. Under Docker, bind-mount content/ read-write and make ' +
        'sure the container user owns it (see docs/admin-web.md).',
    );
    return false;
  }
}

/**
 * Starts the panel when enabled. Returns null when disabled so the caller can
 * treat "no admin server" as a normal, silent state.
 */
export async function startAdminServer(deps: AdminServerDeps): Promise<AdminServerHandle | null> {
  if (!deps.config.enabled) return null;

  const app = await createAdminServer(deps);
  checkContentWritable(deps.content.contentDir, deps.logger);
  await app.listen({ host: deps.config.host, port: deps.config.port });
  deps.logger.info(
    { host: deps.config.host, port: deps.config.port },
    `admin web panel listening on http://${deps.config.host}:${deps.config.port}/admin`,
  );
  if (deps.config.host !== '127.0.0.1' && deps.config.host !== 'localhost') {
    deps.logger.warn(
      { host: deps.config.host },
      'admin web panel is NOT bound to loopback — put it behind a TLS reverse proxy with its own auth',
    );
  }
  return { app, close: () => app.close() };
}
