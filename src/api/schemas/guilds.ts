/**
 * Guilds — read-only in v1 (the bot's `/waifumon-admin` commands own writes).
 *
 * Addressed by `discordGuildId` rather than the internal id, matching how the
 * bot looks guilds up. Further Considerations #2 defers a by-internal-id
 * variant until a client actually needs one.
 */
import { z } from 'zod';
import { isoDateTime, raritySchema, snowflakeParam } from './common';

export const guildSchema = z.object({
  id: z.number().int().describe('Internal guild id — what players reference via guildId.'),
  discordGuildId: snowflakeParam,
  announceChannelId: z
    .string()
    .nullable()
    .describe('Activity Feed channel ("Waifumon Log"), or null when unconfigured.'),
  hereThresholdRarity: raritySchema,
  createdAt: isoDateTime,
});

export const guildChannelsSchema = z.object({
  announceChannelId: z.string().nullable(),
  allowedChannelIds: z
    .array(z.string())
    .nullable()
    .describe('Admin play-channel allowlist. Null means "any guild channel is allowed".'),
});

export const guildParams = z.object({ discordGuildId: snowflakeParam });
