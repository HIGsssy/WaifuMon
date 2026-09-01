import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  guilds,
  players,
  portalOauthStates,
  portalSessions,
  type PortalEligibleGuild,
} from '../db/schema';

export const PORTAL_SESSION_COOKIE = 'wm_portal_session';
export const PORTAL_CSRF_COOKIE = 'wm_portal_csrf';
export const PORTAL_CSRF_HEADER = 'x-portal-csrf';
export const PORTAL_OAUTH_STATE_COOKIE = 'wm_portal_oauth_state';

const STATE_TTL_MS = 10 * 60_000;

export interface DiscordUserProfile {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface DiscordGuildProfile {
  id: string;
  name: string;
  icon?: string | null;
}

export interface DiscordOAuthClient {
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  fetchUser(accessToken: string): Promise<DiscordUserProfile>;
  fetchGuilds(accessToken: string): Promise<DiscordGuildProfile[]>;
}

export interface PortalSessionConfig {
  publicUrl: string;
  forwardedProto: 'http' | 'https';
  discordClientId: string;
  discordClientSecret: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
}

export interface PortalSession {
  sessionDigest: string;
  discordUserId: string;
  discordUsername: string | null;
  discordAvatarUrl: string | null;
  selectedDiscordGuildId: string | null;
  selectedGuildDbId: number | null;
  playerId: number | null;
  eligibleGuilds: PortalEligibleGuild[];
  csrfToken: string;
  expiresAt: Date;
}

export interface BrowserSession {
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
}

export function createDiscordOAuthClient(config: Pick<PortalSessionConfig, 'discordClientId' | 'discordClientSecret'>): DiscordOAuthClient {
  return {
    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      });
      const res = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) throw new Error('Discord token exchange failed');
      const json = (await res.json()) as { access_token?: unknown };
      if (typeof json.access_token !== 'string') throw new Error('Discord token response missing access token');
      return { accessToken: json.access_token };
    },
    async fetchUser(accessToken) {
      const res = await fetch('https://discord.com/api/users/@me', {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Discord user fetch failed');
      return (await res.json()) as DiscordUserProfile;
    },
    async fetchGuilds(accessToken) {
      const res = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Discord guild fetch failed');
      return (await res.json()) as DiscordGuildProfile[];
    },
  };
}

export function portalRedirectUri(publicUrl: string): string {
  const url = new URL(publicUrl);
  url.pathname = '/auth/discord/callback';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function createPortalSessionService(
  db: Db,
  config: PortalSessionConfig,
  discord: DiscordOAuthClient = createDiscordOAuthClient(config),
) {
  function digest(value: string): string {
    return createHmac('sha256', config.sessionSecret).update(value, 'utf8').digest('hex');
  }

  function randomToken(): string {
    return randomBytes(32).toString('base64url');
  }

  function safeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  async function createOAuthState(now = new Date()): Promise<string> {
    const state = randomToken();
    await db.insert(portalOauthStates).values({
      stateDigest: digest(state),
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    });
    return state;
  }

  async function consumeOAuthState(state: string, now = new Date()): Promise<boolean> {
    const [row] = await db
      .update(portalOauthStates)
      .set({ consumedAt: now })
      .where(
        and(
          eq(portalOauthStates.stateDigest, digest(state)),
          isNull(portalOauthStates.consumedAt),
          gt(portalOauthStates.expiresAt, now),
        ),
      )
      .returning({ stateDigest: portalOauthStates.stateDigest });
    return row !== undefined;
  }

  async function eligibleGuildsFor(
    discordUserId: string,
    discordGuilds: DiscordGuildProfile[],
  ): Promise<PortalEligibleGuild[]> {
    const guildIds = discordGuilds.map((g) => g.id);
    if (guildIds.length === 0) return [];
    const byId = new Map(discordGuilds.map((g) => [g.id, g]));
    const rows = await db
      .select({
        discordGuildId: guilds.discordGuildId,
        guildDbId: guilds.id,
        playerId: players.id,
      })
      .from(players)
      .innerJoin(guilds, eq(players.guildId, guilds.id))
      .where(and(eq(players.discordUserId, discordUserId), inArray(guilds.discordGuildId, guildIds)));
    return rows.map((row) => {
      const profile = byId.get(row.discordGuildId);
      return {
        discordGuildId: row.discordGuildId,
        guildDbId: row.guildDbId,
        playerId: row.playerId,
        name: profile?.name ?? null,
        iconUrl: profile?.icon
          ? `https://cdn.discordapp.com/icons/${row.discordGuildId}/${profile.icon}.png`
          : null,
      };
    });
  }

  async function createSession(input: {
    user: DiscordUserProfile;
    eligibleGuilds: PortalEligibleGuild[];
    selected?: PortalEligibleGuild | undefined;
    now?: Date | undefined;
  }): Promise<{ token: string; session: PortalSession }> {
    const token = randomToken();
    const csrfToken = randomToken();
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + config.sessionTtlSeconds * 1000);
    const displayName = input.user.global_name?.trim() || input.user.username;
    const avatarUrl = input.user.avatar
      ? `https://cdn.discordapp.com/avatars/${input.user.id}/${input.user.avatar}.png`
      : null;
    const [row] = await db
      .insert(portalSessions)
      .values({
        sessionDigest: digest(token),
        discordUserId: input.user.id,
        discordUsername: displayName,
        discordAvatarUrl: avatarUrl,
        selectedDiscordGuildId: input.selected?.discordGuildId ?? null,
        selectedGuildDbId: input.selected?.guildDbId ?? null,
        playerId: input.selected?.playerId ?? null,
        eligibleGuilds: input.eligibleGuilds,
        csrfToken,
        expiresAt,
      })
      .returning();
    if (!row) throw new Error('Portal session insert returned no row');
    return { token, session: row };
  }

  async function getSession(token: string | undefined, now = new Date()): Promise<PortalSession | null> {
    if (!token) return null;
    const row = await db.query.portalSessions.findFirst({
      where: and(
        eq(portalSessions.sessionDigest, digest(token)),
        isNull(portalSessions.revokedAt),
        gt(portalSessions.expiresAt, now),
      ),
    });
    return row ?? null;
  }

  async function logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await db
      .update(portalSessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(portalSessions.sessionDigest, digest(token)));
  }

  async function selectGuild(session: PortalSession, discordGuildId: string): Promise<PortalSession | null> {
    const selected = session.eligibleGuilds.find((g) => g.discordGuildId === discordGuildId);
    if (!selected) return null;
    const [row] = await db
      .update(portalSessions)
      .set({
        selectedDiscordGuildId: selected.discordGuildId,
        selectedGuildDbId: selected.guildDbId,
        playerId: selected.playerId,
      })
      .where(eq(portalSessions.sessionDigest, session.sessionDigest))
      .returning();
    return row ?? null;
  }

  async function completeOAuth(code: string, redirectUri: string) {
    const token = await discord.exchangeCode(code, redirectUri);
    const [user, userGuilds] = await Promise.all([
      discord.fetchUser(token.accessToken),
      discord.fetchGuilds(token.accessToken),
    ]);
    const eligible = await eligibleGuildsFor(user.id, userGuilds);
    const selected = eligible.length === 1 ? eligible[0] : undefined;
    return createSession({ user, eligibleGuilds: eligible, selected });
  }

  function toBrowserSession(session: PortalSession | null): BrowserSession {
    if (!session) return { authenticated: false };
    const selected =
      session.selectedDiscordGuildId === null
        ? null
        : session.eligibleGuilds.find((g) => g.discordGuildId === session.selectedDiscordGuildId) ?? null;
    return {
      authenticated: true,
      discordUser: {
        id: session.discordUserId,
        displayName: session.discordUsername ?? `Discord user ${session.discordUserId}`,
        avatarUrl: session.discordAvatarUrl,
      },
      selectedGuild: selected,
      playerId: session.playerId,
      eligibleGuilds: session.eligibleGuilds,
      needsGuildSelection: session.playerId === null && session.eligibleGuilds.length > 1,
      noProfile: session.eligibleGuilds.length === 0,
      csrfToken: session.csrfToken,
    };
  }

  return {
    createOAuthState,
    consumeOAuthState,
    completeOAuth,
    getSession,
    logout,
    selectGuild,
    toBrowserSession,
    safeEquals,
  };
}

export type PortalSessionService = ReturnType<typeof createPortalSessionService>;
