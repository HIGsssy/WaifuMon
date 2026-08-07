/**
 * The developer session's stored identity — dev builds only.
 *
 * Replaces `VITE_DEFAULT_PLAYER_ID` as the answer to "who is the Portal acting
 * as?". A Discord `(guildId, userId)` pair is stored in `localStorage`, and the
 * session provider bridges it to an internal player id through the Platform
 * API's existing `GET /players/lookup`. Switching testers is therefore a form
 * submission rather than an env edit plus a dev-server restart.
 *
 * The pair — not the resolved player id — is what gets persisted, because the
 * pair is what a developer actually knows: it is copy-pasteable straight out of
 * Discord's "Copy User ID". The internal id is derived on every start.
 *
 * **Nothing in this file may be imported from a production code path.** It is
 * reachable only from inside `import.meta.env.DEV` branches, which is what lets
 * Vite drop the whole developer-login subtree from `npm run build` (§23,
 * `scripts/verify-bundle.mjs`).
 */

export interface DevIdentity {
  /** Discord user snowflake — "Copy User ID" in Discord's developer mode. */
  discordUserId: string;
  /** Discord guild snowflake. A player exists per (guild, user) pair. */
  discordGuildId: string;
}

export const DEV_IDENTITY_STORAGE_KEY = 'waifumon-portal:dev-identity';

/**
 * The API's own rule for a snowflake (`snowflakeParam` in
 * `src/api/schemas/common.ts`): an opaque run of digits. Checking it in the
 * browser turns a typo into an inline field message instead of a 400 round trip.
 */
const SNOWFLAKE = /^\d{1,32}$/;

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}

function asIdentity(value: unknown): DevIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const { discordUserId, discordGuildId } = value as Record<string, unknown>;
  if (typeof discordUserId !== 'string' || !isSnowflake(discordUserId)) return null;
  if (typeof discordGuildId !== 'string' || !isSnowflake(discordGuildId)) return null;
  return { discordUserId, discordGuildId };
}

/**
 * The stored identity, or null.
 *
 * Every failure mode — storage disabled, hand-edited JSON, a value written by
 * an older shape of this feature — is the same answer: null, which shows the
 * login screen. A developer tool must not be able to brick the Portal.
 */
export function readDevIdentity(): DevIdentity | null {
  try {
    const raw = localStorage.getItem(DEV_IDENTITY_STORAGE_KEY);
    return raw ? asIdentity(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeDevIdentity(identity: DevIdentity): void {
  try {
    localStorage.setItem(DEV_IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  } catch {
    /* private mode / storage disabled — the in-memory session still works */
  }
}

export function clearDevIdentity(): void {
  try {
    localStorage.removeItem(DEV_IDENTITY_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
