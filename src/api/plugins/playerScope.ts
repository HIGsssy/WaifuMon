/**
 * One place that turns `:playerId` into a real player — or a 404.
 *
 * Most read services answer harmlessly for an id that does not exist
 * (`getInventory` returns `[]`, `getDexStats` returns zeros), which would make
 * an unknown player look like an empty one. Plan §8.2 requires 404 for unknown
 * resources, so this hook resolves the id once, up front, for every
 * player-scoped route.
 *
 * Cost: one indexed primary-key lookup. It is not wasted — the row is stashed
 * on the request, so `GET /players/{id}` serves it directly and `/profile`
 * pairs it with one balance read instead of re-fetching the player. Routes
 * that only need the id (currency, inventory, care, …) pay the one extra
 * lookup in exchange for a correct status code.
 *
 * The hook is registered once at the v1 root and no-ops on any route without a
 * `playerId` param, so Phase 3's mutation routes inherit it for free.
 */
import type { FastifyInstance } from 'fastify';
import type { PlayerRow } from '../../db/schema';
import type { ApiContext } from '../context';
import { ApiPlayerNotFoundError } from '../errors';
import { AppError } from '../../shared/errors';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the player-scope hook on routes carrying a `:playerId` param. */
    player?: PlayerRow;
  }
  interface FastifyContextConfig {
    /**
     * This route may be pointed at *another* player, provided that player is
     * in the requesting Portal session's currently selected guild.
     *
     * Opt-in per route and default-absent, which is what keeps the rule
     * fail-closed: every existing route stays self-only without being touched,
     * and a new cross-player route has to say so in its own definition where a
     * reviewer will see it. Set by `GET /players/:playerId/public` and by
     * nothing else.
     */
    publicGuildProfile?: boolean;
  }
}

export function registerPlayerScope(app: FastifyInstance, ctx: ApiContext): void {
  // preHandler, not onRequest: it runs *after* schema validation, so the param
  // has already been coerced to a positive integer and a garbage id fails as a
  // 400 rather than reaching the database.
  app.addHook('preHandler', async (req) => {
    const params = req.params as { playerId?: unknown } | undefined;
    const raw = params?.playerId;
    if (raw === undefined) return;

    const playerId = Number(raw);
    if (!Number.isInteger(playerId) || playerId <= 0) throw new ApiPlayerNotFoundError(playerId);

    const player = await ctx.services.players.getById(playerId);
    if (!player) throw new ApiPlayerNotFoundError(playerId);

    if (req.apiAuth === 'portal' && req.portalSession?.playerId !== player.id) {
      // The one widening: a public guild profile may name somebody else, but
      // only inside the guild the session has selected. Everything else — a
      // player from another guild, a session with no selection at all, any
      // route that has not opted in — is refused exactly as before.
      const isPublicRoute = req.routeOptions.config?.publicGuildProfile === true;
      const inScope =
        isPublicRoute &&
        req.portalSession?.selectedGuildDbId != null &&
        req.portalSession.selectedGuildDbId === player.guildId;
      if (!inScope) {
        // A public route refusing an out-of-guild player answers 404 —
        // deliberately the same response an id that does not exist gets, so
        // walking ids cannot map out who plays where. Every other route keeps
        // the 403, where the caller already knows the player is theirs to ask
        // about and the refusal is about the resource, not the existence.
        if (isPublicRoute) throw new ApiPlayerNotFoundError(playerId);
        throw new AppError('PORTAL_FORBIDDEN', 'Portal session tried to access another player', 'Not found.');
      }
    }
    req.player = player;
  });
}

/**
 * The resolved player for the current request. Throws rather than returning
 * undefined: reaching a player-scoped handler without a resolved player would
 * mean the hook was not registered, which is a wiring bug, not a 404.
 */
export function requirePlayer(req: { player?: PlayerRow }): PlayerRow {
  if (!req.player) throw new Error('player-scope hook did not run for this route');
  return req.player;
}
