/**
 * The `PortalSession` contract (plan §6) — the load-bearing abstraction.
 *
 * Every screen reads the acting player from this one shape. It does not change
 * between the v1 dev provider and a future `OAuthSessionProvider`; only the
 * provider does. That is the entire migration path for §25.14, and it is why no
 * page component ever asks *how* the session was established.
 *
 * **Rules the whole app obeys:**
 *   - a page needing the current player reads `session.playerId`, never a URL param
 *   - `discordUserId` / `discordGuildId` are presentation only
 *
 * Deviation from the plan's sketch, deliberate and documented: `playerId` and
 * `guildDbId` are typed `number`, not `string`. The Platform API models internal
 * ids as positive integers (`src/api/schemas/common.ts`) and every
 * `/players/{playerId}` helper takes a number, so a string here would mean a
 * `Number(...)` conversion at every call site — new failure surface for no
 * benefit. The seam itself is unchanged.
 */

export interface PortalSession {
  /** Internal id used in all `/players/:playerId` endpoints. */
  playerId: number;
  /** Internal guild id, resolved once at session start. Not a snowflake. */
  guildDbId: number;
  /**
   * For the header and avatar. The API's `identity.displayName` when it
   * resolves, otherwise `Trainer #<id>` — never blank, never fabricated.
   */
  displayName: string;
  /** Absolute avatar URL from the API, or null. Fed to the image resolver. */
  avatarUrl: string | null;
  /** Populated when known; presentation only. */
  discordUserId?: string | undefined;
  /** Populated when known; presentation only. */
  discordGuildId?: string | undefined;
  /**
   * Portal permissions computed by the API for this session. UI gating
   * only — every admin API route independently re-checks.
   */
  permissions: readonly string[];
}

export interface PortalEligibleGuild {
  discordGuildId: string;
  guildDbId: number;
  playerId: number;
  name: string | null;
  iconUrl: string | null;
}

export interface PortalSessionPayload {
  authenticated: boolean;
  discordUser?: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  };
  selectedGuild?: PortalEligibleGuild | null;
  playerId?: number | null;
  eligibleGuilds?: PortalEligibleGuild[];
  needsGuildSelection?: boolean;
  noProfile?: boolean;
  csrfToken?: string;
  /**
   * Portal permissions the session holds. Empty (never omitted) when the
   * session has no permissions. The API decides — the frontend only reads.
   */
  permissions?: string[];
}

export type SessionStatus = 'loading' | 'ready' | 'unresolved';

export interface SessionState {
  status: SessionStatus;
  /** Non-null exactly when `status === 'ready'`. */
  session: PortalSession | null;
  /** Why resolution failed, when it did. */
  error: unknown;
  /**
   * The raw `VITE_DEFAULT_PLAYER_ID` value, for the fallback screen (§8.11).
   * Always `undefined` in a dev build, where the acting player comes from the
   * developer-login screen and no env var is consulted.
   */
  configuredPlayerId: string | undefined;
  /** Re-attempts resolution without a page reload. */
  retry: () => void;
  logout?: (() => Promise<void>) | undefined;
  selectGuild?: ((discordGuildId: string) => Promise<void>) | undefined;
  eligibleGuilds?: PortalEligibleGuild[] | undefined;
  noProfile?: boolean | undefined;
}
