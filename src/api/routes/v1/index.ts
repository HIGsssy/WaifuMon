/**
 * Registration root for `/api/v1` (plan §8.1).
 *
 * Phase 1 deliberately ships no gameplay endpoints — the point of this phase
 * is that the skeleton, auth, error contract and docs are provably correct
 * before any service is exposed. Phase 2 adds one `register` line per resource
 * group here (players, collection, currency, …), and nothing else in the
 * server changes.
 *
 * `/api/v1/system` stays a reserved, unregistered namespace (§8.1, §17.3).
 */
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';

export const v1Routes: FastifyPluginAsyncZod = async (app) => {
  // Served here rather than by Swagger UI's own `/docs/json` so the spec has a
  // stable, version-scoped URL the contract test and clients can pin to.
  app.get(
    '/openapi.json',
    { schema: { hide: true } },
    async () => app.swagger(),
  );
};
