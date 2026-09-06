/**
 * GuildRoleService — the one place that answers "which roles does this member
 * hold?" and "what roles does this guild have?".
 *
 * The sibling of {@link GuildOwnershipService}, and deliberately built the
 * same way, for the same reasons: role membership is Discord's state, changes
 * without telling us, and must never be persisted in Postgres where it would
 * quietly disagree with reality. The runtime source of truth is the bot's
 * gateway client.
 *
 * Like the ownership service it takes closures rather than a `discord.js`
 * `Client`, so the API layer holds no Discord types and a deployment running
 * the API without the bot can wire the null fetchers below — which resolve to
 * "unknown", and therefore to no access.
 *
 * ## Fail closed, twice over
 *
 * `getMemberRoleIds` distinguishes three outcomes and collapses two of them:
 *
 *   - the member exists and holds roles  → those role ids
 *   - the member is not in the guild     → `null`
 *   - the lookup threw                   → `null`
 *
 * `null` means "we do not know", and the authorization service grants nothing
 * on `null`. An empty array is different — it means "we asked, and they hold
 * no roles" — but both lead to no grants, so the distinction matters only for
 * logging. Nothing here ever returns a *partial* answer that could be read as
 * a complete one.
 *
 * ## Caching, and why the TTL is short
 *
 * Member roles are read on every authorization, so they are cached — but a
 * role *removed* in Discord must not keep granting admin access. The default
 * TTL is therefore one minute, well under the ownership service's five: losing
 * a role is a security event in a way that transferring a guild is not, and
 * the read behind it is a cache hit on the bot's own gateway state rather than
 * an HTTP call. The bot also invalidates from `guildMemberUpdate`, so the TTL
 * is the backstop rather than the mechanism.
 */
import type { Logger } from '../../shared/logger';

/** One role as the Portal's role picker needs it. */
export interface GuildRoleSummary {
  id: string;
  name: string;
  /** Discord's integer colour, for rendering the role chip. 0 = default. */
  color: number;
  /** Position in the guild's hierarchy; higher sorts first in the picker. */
  position: number;
  /** `@everyone` and bot-managed integration roles are not sensible grantees. */
  managed: boolean;
}

/** Reads the role ids a member currently holds, or null when unknown. */
export type FetchMemberRoleIds = (
  discordGuildId: string,
  discordUserId: string,
) => Promise<readonly string[] | null>;

/** Reads every role defined in a guild, or null when unknown. */
export type FetchGuildRoles = (
  discordGuildId: string,
) => Promise<readonly GuildRoleSummary[] | null>;

export interface GuildRoleService {
  /**
   * Role ids this member holds right now, or `null` when the answer is not
   * known — the member is not in the guild, the guild is not known to the
   * bot, or the lookup failed. Callers must treat `null` as "grant nothing".
   */
  getMemberRoleIds(
    discordGuildId: string,
    discordUserId: string,
  ): Promise<readonly string[] | null>;
  /** Every role in the guild, for the Portal's picker. Null when unknown. */
  listGuildRoles(discordGuildId: string): Promise<readonly GuildRoleSummary[] | null>;
  /** Drop one member's cached roles — called from `guildMemberUpdate`. */
  invalidateMember(discordGuildId: string, discordUserId: string): void;
  /** Drop a guild's cached role list — called from role create/update/delete. */
  invalidateGuildRoles(discordGuildId: string): void;
  /** Wipe everything. Tests, and the bot's `ready` sweep. */
  clear(): void;
}

export interface GuildRoleServiceOptions {
  fetchMemberRoleIds: FetchMemberRoleIds;
  fetchGuildRoles: FetchGuildRoles;
  logger?: Logger;
  /** Member-role cache lifetime. Short by design — see the module comment. */
  memberTtlMs?: number;
  /** Guild role-list cache lifetime; presentation data, so it can be longer. */
  rolesTtlMs?: number;
}

const DEFAULT_MEMBER_TTL_MS = 60_000;
const DEFAULT_ROLES_TTL_MS = 5 * 60_000;
/** How long a *failed* lookup is remembered, so a broken gateway is not hammered. */
const FAILURE_TTL_MS = 10_000;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

function memberKey(discordGuildId: string, discordUserId: string): string {
  return `${discordGuildId}:${discordUserId}`;
}

export function createGuildRoleService(opts: GuildRoleServiceOptions): GuildRoleService {
  const memberCache = new Map<string, Entry<readonly string[] | null>>();
  const rolesCache = new Map<string, Entry<readonly GuildRoleSummary[] | null>>();
  const memberTtl = opts.memberTtlMs ?? DEFAULT_MEMBER_TTL_MS;
  const rolesTtl = opts.rolesTtlMs ?? DEFAULT_ROLES_TTL_MS;

  async function getMemberRoleIds(
    discordGuildId: string,
    discordUserId: string,
  ): Promise<readonly string[] | null> {
    const now = Date.now();
    const key = memberKey(discordGuildId, discordUserId);
    const hit = memberCache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    try {
      const roles = await opts.fetchMemberRoleIds(discordGuildId, discordUserId);
      // Normalised to a frozen copy so a caller cannot mutate the cached array
      // and quietly widen (or narrow) the next authorization.
      const value = roles == null ? null : Object.freeze([...roles]);
      memberCache.set(key, { value, expiresAt: now + memberTtl });
      return value;
    } catch (err) {
      opts.logger?.warn(
        { err, tag: 'guild-roles/member-fetch-failed', discordGuildId },
        'failed to fetch guild member roles; granting nothing',
      );
      memberCache.set(key, { value: null, expiresAt: now + Math.min(FAILURE_TTL_MS, memberTtl) });
      return null;
    }
  }

  async function listGuildRoles(
    discordGuildId: string,
  ): Promise<readonly GuildRoleSummary[] | null> {
    const now = Date.now();
    const hit = rolesCache.get(discordGuildId);
    if (hit && hit.expiresAt > now) return hit.value;
    try {
      const roles = await opts.fetchGuildRoles(discordGuildId);
      const value = roles == null ? null : Object.freeze([...roles]);
      rolesCache.set(discordGuildId, { value, expiresAt: now + rolesTtl });
      return value;
    } catch (err) {
      opts.logger?.warn(
        { err, tag: 'guild-roles/list-fetch-failed', discordGuildId },
        'failed to list guild roles',
      );
      rolesCache.set(discordGuildId, {
        value: null,
        expiresAt: now + Math.min(FAILURE_TTL_MS, rolesTtl),
      });
      return null;
    }
  }

  return {
    getMemberRoleIds,
    listGuildRoles,
    invalidateMember(discordGuildId, discordUserId) {
      memberCache.delete(memberKey(discordGuildId, discordUserId));
    },
    invalidateGuildRoles(discordGuildId) {
      rolesCache.delete(discordGuildId);
    },
    clear() {
      memberCache.clear();
      rolesCache.clear();
    },
  };
}

/**
 * Fetchers that always say "unknown". Used to wire the API in deployments
 * without the bot attached, and in tests that must never touch Discord. Every
 * session resolves to no role grants, which is the safe default.
 */
export const nullFetchMemberRoleIds: FetchMemberRoleIds = async () => null;
export const nullFetchGuildRoles: FetchGuildRoles = async () => null;
