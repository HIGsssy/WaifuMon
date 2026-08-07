/**
 * Per-channel session rows — the daily tally and the Trainer Profile pointer.
 *
 * Read-only here; `POST /sessions/ensure` (which creates the row) is Phase 3.
 * A channel the player has never used therefore reads as 404 rather than an
 * empty tally, because there genuinely is no session yet.
 */
import { z } from 'zod';
import type { ApiContext } from '../../context';
import { ApiSessionNotFoundError } from '../../errors';
import { requirePlayer } from '../../plugins/playerScope';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import {
  commonErrorResponses,
  idParam,
  notFoundResponse,
  snowflakeParam,
} from '../../schemas/common';
import { sessionSchema } from '../../schemas/session';

const sessionParams = z.object({ playerId: idParam, channelId: snowflakeParam });

export const sessionRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/:playerId/sessions/:channelId',
      {
        schema: {
          tags: ['Sessions'],
          summary: 'Get the session for a channel',
          description:
            "The player's tally in this channel plus their Care Mode Trainer Profile message id. " +
            '`summaryFresh` is false when the tally is from a previous day — the counters are ' +
            'then last session\'s, not today\'s. Returns 404 when the player has never used the ' +
            'channel.',
          params: sessionParams,
          response: {
            200: dataSchema(sessionSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { session } = ctx.services;
        const row = await session.findByPlayerAndChannel(
          requirePlayer(req).id,
          req.params.channelId,
        );
        if (!row) throw new ApiSessionNotFoundError(req.params.channelId);
        return ok(req, {
          ...row,
          summary: session.readSummary(row),
          summaryFresh: session.isSummaryFresh(row),
        });
      },
    );
  };
