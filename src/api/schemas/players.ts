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

// ── Guild player directory (Portal "Players") ───────────────────────────────

/**
 * The public-within-guild view of somebody who is not the caller.
 *
 * This is an **allowlist, written out in full**. Every other player resource on
 * this surface describes the caller's own account and can afford to pass a row
 * through; this one describes a stranger, so it names each field it publishes
 * and nothing reaches it by inheritance. Absent on purpose, and each for its
 * own reason:
 *
 *   - `discordUserId` — the directory addresses players by internal id, which
 *     is the identifier the public profile route already takes. Publishing the
 *     snowflake would hand every guild member a machine-readable roster of
 *     Discord accounts for no functional gain.
 *   - `xp` — a raw gameplay metric. `level` is the public expression of it.
 *   - currencies, inventory, quests, care state, `settings`, `showcase` — the
 *     player's own business.
 *   - collection contents — the profile decides what it reveals about a
 *     collection; a directory row does not front-run that.
 *
 * `avatarUrl` is the one field that transitively carries a snowflake, because a
 * Discord CDN avatar URL contains the user id by construction. It is the same
 * URL `player.identity.avatarUrl` has always returned, and there is no other
 * way to render an avatar, so it ships — noted here so the tradeoff is a
 * decision on the record rather than an oversight.
 */
export const directoryBuddySchema = z
  .object({
    speciesSlug: z.string(),
    speciesName: z.string(),
    rarity: z.string().describe('Species rarity band, e.g. "SR".'),
    level: z.number().int(),
    assetId: z
      .object({
        kind: z.literal('waifumon'),
        slug: z.string(),
        variant: z.string(),
      })
      .describe('Abstract artwork identifier — what to render, never where it lives.'),
  })
  .describe('The player\'s active buddy, resolved on the directory query itself — no extra request.');

export const directoryPlayerSchema = z.object({
  id: z
    .number()
    .int()
    .describe(
      'Internal player id. This is also the public profile route identifier — the API has no ' +
        'separate public handle, and this task deliberately did not invent one.',
    ),
  displayName: z
    .string()
    .describe('Discord display name, or "Trainer #<id>" when it cannot be resolved.'),
  avatarUrl: z.string().nullable(),
  level: z.number().int(),
  lastActiveAt: isoDateTime.describe(
    'Last hunt, falling back to when the player joined this guild. A coarse recency signal — ' +
      'never a presence or "online" indicator.',
  ),
  buddy: directoryBuddySchema.nullable(),
});

export const DIRECTORY_SORTS = ['name', 'level', 'recent'] as const;

export const directoryQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
  search: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe('Case-insensitive substring match on display name.'),
  sort: z.enum(DIRECTORY_SORTS).default('name'),
  activity: z
    .enum(['all', 'recent'])
    .default('all')
    .describe(
      '`all` lists every player row in the guild — the application\'s only reliable record of ' +
        'participation. `recent` narrows to the last 30 days of activity.',
    ),
  /**
   * Only a bearer caller may supply this, and a Portal session that supplies a
   * guild other than its selected one is refused (403). See
   * `plugins/guildScope.ts` — the scope is never widened by the request.
   */
  discordGuildId: snowflakeParam.optional(),
});

/**
 * Another player's profile, as their guild-mates may see it.
 *
 * Strictly a superset of the directory row plus the three things a profile page
 * shows and a list row does not: when they joined, where they are standing, and
 * how much of the dex they have filled. Note that dex *counts* ship and dex
 * *contents* do not — "42 of 180 species" says nothing about which.
 */
export const publicPlayerProfileSchema = directoryPlayerSchema.extend({
  createdAt: isoDateTime.describe('When this player first played in this guild.'),
  currentRegion: currentRegionSchema,
  collection: z.object({
    owned: z.number().int().describe('Active (non-released) copies.'),
    distinctSpecies: z.number().int(),
    totalSpecies: z.number().int(),
  }),
});
