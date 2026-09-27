/**
 * Synthetic load-test identities.
 *
 * Every load-test player lives in one synthetic guild and carries a synthetic
 * Discord user id.
 *
 * ## Why these numbers
 *
 * They must be numeric: the API's response schemas declare every Discord id a
 * snowflake (`snowflakeParam`, digits only), and a player resource carrying a
 * non-numeric id fails serialization. They must also never collide with a real
 * Discord id — and a snowflake cannot be small. A snowflake's top bits are
 * milliseconds since the Discord epoch (2015-01-01), so every real user and
 * guild id is 17 digits or more. `7357xxx` — seven digits, "TEST" on a phone
 * pad — decodes to a creation time about one millisecond after that epoch. No
 * account has one, and none ever will.
 *
 * ## Why every external lookup checks them
 *
 * Identity, guild-ownership and role lookups call the gateway's REST API for
 * an id they have not cached; for a synthetic id that would be a
 * guaranteed-404 request against a rate-limited external service, made once
 * per virtual player. `isSyntheticDiscordId` short-circuits them.
 */

const SYNTHETIC_PREFIX = '7357';
/** Players are 7357001 … 7357999; the guild is 7357000. */
const SYNTHETIC_PATTERN = /^7357\d{3}$/;
export const MAX_SYNTHETIC_PLAYERS = 999;

/** The `guilds.discord_guild_id` of the one guild every synthetic player joins. */
export const SYNTHETIC_GUILD_DISCORD_ID = `${SYNTHETIC_PREFIX}000`;

/** `players.discord_user_id` for synthetic player `index` (0-based). */
export function syntheticDiscordUserId(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SYNTHETIC_PLAYERS) {
    throw new RangeError(`synthetic player index out of range: ${index}`);
  }
  return `${SYNTHETIC_PREFIX}${String(index + 1).padStart(3, '0')}`;
}

/** True for any id minted here — guild or user. Never true for a real snowflake. */
export function isSyntheticDiscordId(id: string | null | undefined): boolean {
  return typeof id === 'string' && SYNTHETIC_PATTERN.test(id);
}

/** POSIX regex for the same test, for use in SQL (`~`). */
export const SYNTHETIC_ID_SQL_PATTERN = '^7357[0-9]{3}$';
