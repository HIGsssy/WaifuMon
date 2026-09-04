/**
 * Player resources.
 *
 * `discordUserId` is exposed deliberately: plan §4.8 keeps Discord out of
 * responses *by default*, with explicitly-named snowflake fields as the
 * exception. Everything else addresses the player by internal `id`.
 */
import { z } from 'zod';
import { REGIONS } from '../../modules/locations/regions';
import { isoDateTime, nullableIsoDateTime, snowflakeParam } from './common';
import { currencySchema } from './currency';

/**
 * Presentation-only Discord identity, resolved outside the service layer
 * (`src/api/identity.ts`).
 *
 * Nullable by contract, and clients must treat it that way: the gateway may be
 * reconnecting, the user may have left, or the process may be running with no
 * Discord client at all. Nothing about a player's game state depends on it.
 */
export const playerIdentitySchema = z
  .object({
    displayName: z
      .string()
      .describe('Discord global display name, falling back to the username.'),
    avatarUrl: z
      .string()
      .nullable()
      .describe('Absolute Discord CDN URL for the avatar, or null.'),
  })
  .nullable()
  .describe('Presentation only. Null whenever the identity cannot be resolved.');

/**
 * The trainer's position on the level curve.
 *
 * Deliberately the same shape `waifuProgressSchema` gives an owned copy, and
 * for the same reason: the client renders a bar, it does not own the curve.
 * Resolved server-side by `progressionService.progressFor(xp)` — the one
 * implementation of the rule, already read by Discord — over the player row the
 * scope hook has in hand, so it costs no query.
 *
 * Shipping it is what keeps a second copy of the curve out of every consumer:
 * `levelCurve` is published in the tuning blob, so a client *could* recompute
 * this, and the moment one does the game has two definitions of a level.
 */
export const playerProgressSchema = z.object({
  level: z.number().int(),
  totalXp: z.number().int().describe('Lifetime XP, the same figure as `xp`.'),
  xpIntoLevel: z.number().int(),
  xpToNext: z.number().int().describe('XP from this level to the next. 0 at max level.'),
  atMaxLevel: z.boolean(),
});

/**
 * Where the trainer currently stands.
 *
 * `name` travels with the id for the same reason `unlockLabel` does: the
 * player-facing wording is resolved from the authored region file, falling back
 * to the id-derived label, and doing that once here beats every client
 * reimplementing `regionLabel` and drifting from the name content authored.
 */
export const currentRegionSchema = z.object({
  id: z.enum(REGIONS),
  name: z.string().describe('Player-facing region name, e.g. "Waifu Valley".'),
});

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
  progress: playerProgressSchema,
  currentRegion: currentRegionSchema,
  lastHuntAt: nullableIsoDateTime,
  careMode: z
    .object({
      active: z.boolean(),
      waifuId: z.number().int().nullable(),
      startedAt: nullableIsoDateTime,
    })
    .describe('Summary only — GET /players/{playerId}/care returns the full state.'),
  createdAt: isoDateTime,
  identity: playerIdentitySchema,
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
