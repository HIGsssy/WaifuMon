/**
 * What this deployment can do — optional features, as booleans.
 *
 * Exists because the alternative is worse. Optional surfaces on this API are
 * gated by *route registration*, so a disabled feature is indistinguishable
 * from a typo: both are 404. A client that wants to know whether card
 * rendering exists would otherwise have to request a card and read the 404 as
 * an answer — which caches badly, logs as an error, and cannot tell "feature
 * off" from "that species does not exist".
 *
 * The backend stays authoritative. This endpoint reports the flags the process
 * actually booted with, so a client can never disagree with the server about
 * what is available. A frontend copy of the same flag (a `VITE_…` variable)
 * would be a second source of truth and would drift.
 *
 * Registered unconditionally, and cheap: it reads config, touches no service,
 * and makes no query. New optional features add a boolean here rather than a
 * new discovery mechanism.
 */
import { z } from 'zod';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses } from '../../schemas/common';

export interface PlatformCapabilities {
  /** `/api/v1/cards/…` is registered — see `CARD_RENDERER_ENABLED`. */
  cards: boolean;
}

const capabilitiesSchema = z
  .object({
    cards: z
      .boolean()
      .describe('Rendered card images are available at /api/v1/cards/…'),
  })
  .describe(
    'Optional features this deployment has enabled. Clients should tolerate ' +
      'unknown keys being added.',
  );

export const capabilityRoutes =
  (capabilities: PlatformCapabilities): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/capabilities',
      {
        schema: {
          tags: ['System'],
          summary: 'What this deployment supports',
          description:
            'Optional features, as booleans, so a client can hide UI for a feature that is ' +
            'switched off instead of discovering it by requesting a route and getting a 404.\n\n' +
            'Additive: treat unknown keys as features you do not understand, and a missing key ' +
            'as `false`.',
          response: {
            200: dataSchema(capabilitiesSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, capabilities),
    );
  };
