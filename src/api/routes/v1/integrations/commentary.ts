/**
 * `GET /integrations/commentary/context` — guild-public facts about one
 * WaifuMon announcement, for a read-only integration.
 *
 * ## Who may call it
 *
 * Only an integration credential. The auth hook already admits integrations
 * to nothing but opted-in GET routes; this handler closes the other direction
 * and refuses the shared bearer token and Portal sessions, so neither becomes
 * a second way into commentary data.
 *
 * ## What it answers
 *
 * The caller names a guild and a message. The guild must be the one
 * configured guild, and the message must be one WaifuMon recorded in it;
 * every other case — unknown message, another guild's message, the wrong guild
 * id, a kind v1 does not record — is the same 404, so a probe learns nothing
 * from the difference. No parameter names a player.
 *
 * ## Caching
 *
 * Answers are reused for 60 seconds per message, and concurrent requests for
 * one message share one computation. Live facts carry `asOf`, so a cached
 * answer says how old it is. Misses are never cached: the ledger row is written
 * just after Discord confirms the post, and a caller that raced it should find
 * it on retry.
 */
import type { z } from 'zod';
import type { ApiContext } from '../../../context';
import {
  AnnouncementNotFoundError,
  IntegrationCredentialRequiredError,
} from '../../../errors';
import { noIdentity } from '../../../identity';
import { dataSchema, ok } from '../../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../../plugins/typeProvider';
import { commonErrorResponses, errorSchema } from '../../../schemas/common';
import { commentaryContextQuery, commentaryContextSchema } from '../../../schemas/integrations';
import type { CommentaryContext } from '../../../../modules/commentary/commentaryContextService';

type CommentaryResponse = z.input<typeof commentaryContextSchema>;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  value: CommentaryContext;
  expiresAt: number;
}

export const commentaryRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const integration = ctx.integration;
    if (!integration) return;
    const resolveIdentity = ctx.resolveIdentity ?? noIdentity;
    const now = () => Date.now();

    const cache = new Map<string, CacheEntry>();
    const inFlight = new Map<string, Promise<CommentaryContext | null>>();

    async function contextFor(guildDbId: number, messageId: string): Promise<CommentaryContext | null> {
      const hit = cache.get(messageId);
      if (hit && hit.expiresAt > now()) return hit.value;
      const pending = inFlight.get(messageId);
      if (pending) return pending;

      const work = integration!.commentary
        .forMessage(guildDbId, messageId)
        .then((value) => {
          if (value) {
            // Insertion-ordered Map: deleting the first key evicts the oldest.
            if (cache.size >= CACHE_MAX_ENTRIES) {
              const oldest = cache.keys().next();
              if (!oldest.done) cache.delete(oldest.value);
            }
            cache.set(messageId, { value, expiresAt: now() + CACHE_TTL_MS });
          }
          return value;
        })
        .finally(() => inFlight.delete(messageId));
      inFlight.set(messageId, work);
      return work;
    }

    app.get(
      '/integrations/commentary/context',
      {
        config: { integrationRoute: true },
        // No body is ever accepted here.
        bodyLimit: 1,
        schema: {
          tags: ['Integrations'],
          summary: 'Guild-public context for one WaifuMon announcement',
          description:
            'Integration credential only (`Authorization: Integration <keyId>.<secret>`); the ' +
            'bearer token and Portal sessions get 403. Resolves a WaifuMon announcement message ' +
            'in the configured guild to the facts it published (`announced`, immutable) and ' +
            'guild-public live statistics (`facts`, each `verified` with `asOf` or `unavailable` ' +
            'with a reason). Unknown messages, other guilds and unrecorded kinds are all 404.',
          querystring: commentaryContextQuery,
          response: {
            200: dataSchema(commentaryContextSchema),
            ...commonErrorResponses,
            403: errorSchema.describe('Not an integration credential, or outside its allowlist.'),
            404: errorSchema.describe('`ANNOUNCEMENT_NOT_FOUND`.'),
            429: errorSchema.describe('`RATE_LIMITED`; see `Retry-After`.'),
            503: errorSchema.describe('`DB_UNAVAILABLE`; skip, do not retry in a loop.'),
          },
        },
      },
      async (req) => {
        if (req.apiAuth !== 'integration') throw new IntegrationCredentialRequiredError();

        const { discordGuildId, messageId } = req.query;
        if (discordGuildId !== integration.guildId) throw new AnnouncementNotFoundError();
        const guild = await ctx.services.guilds.getByDiscordId(discordGuildId);
        if (!guild) throw new AnnouncementNotFoundError();

        const context = await contextFor(guild.id, messageId);
        if (!context) throw new AnnouncementNotFoundError();

        const identity =
          context.player?.discordUserId != null ? await resolveIdentity(context.player.discordUserId) : null;

        return ok(req, {
          ...context,
          // Stored JSONB, so untyped here. The response schema parses it on
          // the way out: a payload that does not match is a 500, never a leak.
          announced: context.announced as CommentaryResponse['announced'],
          facts: context.facts as CommentaryResponse['facts'],
          announcement: { ...context.announcement, discordGuildId },
          player: context.player ? { ...context.player, displayName: identity?.displayName ?? null } : null,
        });
      },
    );
  };
