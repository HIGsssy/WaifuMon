/**
 * Player resources.
 *
 * `discordUserId` is exposed deliberately: plan §4.8 keeps Discord out of
 * responses *by default*, with explicitly-named snowflake fields as the
 * exception. Everything else addresses the player by internal `id`.
 */
import { z } from 'zod';
import { isoDateTime, nullableIsoDateTime, snowflakeParam } from './common';
import { currencySchema } from './currency';

export const playerSchema = z.object({
  id: z.number().int(),
  guildId: z.number().int().describe('Internal guild id, not a Discord snowflake.'),
  discordUserId: snowflakeParam,
  level: z.number().int(),
  xp: z.number().int(),
  buddyWaifuId: z
    .number()
    .int()
    .nullable()
    .describe('Owned-waifu id of the active buddy, or null.'),
  lastHuntAt: nullableIsoDateTime,
  careMode: z
    .object({
      active: z.boolean(),
      waifuId: z.number().int().nullable(),
      startedAt: nullableIsoDateTime,
    })
    .describe('Summary only — GET /players/{playerId}/care returns the full state.'),
  createdAt: isoDateTime,
});

export const playerProfileSchema = z.object({
  player: playerSchema,
  currencies: currencySchema,
});

export const playerLookupQuery = z.object({
  discordGuildId: snowflakeParam,
  discordUserId: snowflakeParam,
});

export const playerLookupSchema = z.object({
  playerId: z.number().int(),
});
