/**
 * Registration root for `/api/v1` (plan §8.1).
 *
 * Adding an endpoint is one new file plus one `register` line here — that is
 * the pattern §16 asks the reviewer to be able to see at a glance.
 *
 * Phase 2 is read-only: every route below is a GET. Mutations (hunt, capture,
 * purchase, claim, care actions, `POST /players/ensure`) land in Phase 3.
 * `/api/v1/system` stays a reserved, unregistered namespace (§8.1, §17.3).
 */
import type { ApiContext } from '../../context';
import { registerPlayerScope } from '../../plugins/playerScope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { careRoutes } from './care';
import { collectionRoutes } from './collection';
import { contentRoutes } from './content';
import { currencyRoutes } from './currency';
import { dailyRoutes } from './daily';
import { effectsRoutes } from './effects';
import { encounterRoutes } from './encounter';
import { guildRoutes } from './guilds';
import { inventoryRoutes } from './inventory';
import { playerRoutes } from './players';
import { questRoutes } from './quests';
import { sessionRoutes } from './session';
import { shopRoutes } from './shop';

export const v1Routes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    // Served here rather than by Swagger UI's own `/docs/json` so the spec has
    // a stable, version-scoped URL the contract test and clients can pin to.
    app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

    // Resolves `:playerId` to a real player (or 404s) for every route below
    // that has one. Registered before the routes: Fastify hooks only apply to
    // routes registered after them in the same encapsulation context.
    registerPlayerScope(app, ctx);

    // Player-scoped resources.
    await app.register(playerRoutes(ctx));
    await app.register(collectionRoutes(ctx));
    await app.register(currencyRoutes(ctx));
    await app.register(inventoryRoutes(ctx));
    await app.register(effectsRoutes(ctx));
    await app.register(careRoutes(ctx));
    await app.register(encounterRoutes(ctx));
    await app.register(dailyRoutes(ctx));
    await app.register(questRoutes(ctx));
    await app.register(sessionRoutes(ctx));

    // Global resources.
    await app.register(shopRoutes(ctx));
    await app.register(contentRoutes(ctx));
    await app.register(guildRoutes(ctx));
  };
