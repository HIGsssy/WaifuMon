/**
 * Guilds — read-only in v1. Guild configuration is written by the bot's own
 * admin slash commands; exposing writes here is deferred (plan §3).
 *
 * Addressed by Discord snowflake, matching how the bot looks guilds up. The
 * response carries the internal `id`, which is the value `player.guildId`
 * refers to — that is the bridge between the two id spaces.
 */
import type { ApiContext } from '../../context';
import { ApiGuildNotFoundError } from '../../errors';
import { toGuildResource } from '../../resources';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse } from '../../schemas/common';
import { guildChannelsSchema, guildParams, guildSchema } from '../../schemas/guilds';

export const guildRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/guilds/:discordGuildId',
      {
        schema: {
          tags: ['Guilds'],
          summary: 'Get a guild',
          description:
            'Read-only lookup — never provisions a guild row, so a server the bot has not been ' +
            'used in yet returns 404.',
          params: guildParams,
          response: {
            200: dataSchema(guildSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const guild = await ctx.services.guilds.getByDiscordId(req.params.discordGuildId);
        if (!guild) throw new ApiGuildNotFoundError(req.params.discordGuildId);
        return ok(req, toGuildResource(guild));
      },
    );

    app.get(
      '/guilds/:discordGuildId/channels',
      {
        schema: {
          tags: ['Guilds'],
          summary: 'Get a guild\'s channel configuration',
          description:
            'The Activity Feed channel and the play-channel allowlist. A null `allowedChannelIds` ' +
            'means no allowlist is configured, which permits any NSFW channel — it is not the ' +
            'same as an empty array, which permits none.',
          params: guildParams,
          response: {
            200: dataSchema(guildChannelsSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const guild = await ctx.services.guilds.getByDiscordId(req.params.discordGuildId);
        if (!guild) throw new ApiGuildNotFoundError(req.params.discordGuildId);
        return ok(req, {
          announceChannelId: guild.announceChannelId,
          allowedChannelIds: guild.allowedChannelIds,
        });
      },
    );
  };
