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

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the player-scope hook on routes carrying a `:playerId` param. */
    player?: PlayerRow;
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
