/**
 * AdminRoleGrantService — CRUD over `guild_admin_role_grants`.
 *
 * Two rules hold everywhere in this file, and they are the reason it exists
 * as a service rather than as queries inline in a route:
 *
 *  1. **Every read and write is scoped by `discordGuildId`.** There is no
 *     method that takes a role id alone. A grant belongs to one guild, and an
 *     owner of guild A addressing a role id that happens to exist in guild B
 *     touches nothing — the `and(guild, role)` predicate simply matches no
 *     row. That is what makes cross-guild leakage structurally impossible
 *     rather than something each route has to remember.
 *
 *  2. **Only grantable permissions are persisted.** `admin.roles.manage` is
 *     excluded from {@link GRANTABLE_PORTAL_PERMISSIONS}, so a grant can never
 *     confer the ability to edit grants. Unknown strings are rejected too, so
 *     a typo becomes an error at write time rather than a permission that
 *     silently never matches.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { guildAdminRoleGrants, type GuildAdminRoleGrantRow } from '../../db/schema';
import { AppError } from '../../shared/errors';
import {
  GRANTABLE_PORTAL_PERMISSIONS,
  isGrantablePermission,
  type PortalPermission,
} from './portalAuthService';

/** One stored grant, with its permission list narrowed to the known set. */
export interface AdminRoleGrant {
  discordGuildId: string;
  roleId: string;
  permissions: readonly PortalPermission[];
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

export class InvalidRoleGrantError extends AppError {
  constructor(message: string, userMessage: string) {
    super('ROLE_GRANT_INVALID', message, userMessage);
  }
}

export class RoleGrantNotFoundError extends AppError {
  constructor(roleId: string) {
    super(
      'ROLE_GRANT_NOT_FOUND',
      `No admin role grant for role ${roleId} in this guild`,
      'That role no longer has Portal Admin access.',
    );
  }
}

export interface AdminRoleGrantService {
  list(discordGuildId: string): Promise<AdminRoleGrant[]>;
  /**
   * Permissions granted to any of `roleIds`, unioned. Returns the empty set
   * for an empty role list, an unknown guild, or roles with no grants — the
   * caller cannot tell those apart, and does not need to.
   */
  permissionsForRoles(
    discordGuildId: string,
    roleIds: readonly string[],
  ): Promise<readonly PortalPermission[]>;
  /** Create or replace the grant for one role. Idempotent by (guild, role). */
  upsert(input: {
    discordGuildId: string;
    roleId: string;
    permissions: readonly string[];
    actorDiscordUserId: string | null;
  }): Promise<AdminRoleGrant>;
  /** Replace an existing grant's permissions. Throws if the grant is absent. */
  update(input: {
    discordGuildId: string;
    roleId: string;
    permissions: readonly string[];
    actorDiscordUserId: string | null;
  }): Promise<AdminRoleGrant>;
  /** Remove a grant. Returns false when there was nothing to remove. */
  remove(discordGuildId: string, roleId: string): Promise<boolean>;
}

/** Discord snowflakes are 17–20 digits. Anything else is not a role id. */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Validate and normalise a permission list.
 *
 * Sorted and de-duplicated so a stored row has one canonical form — which is
 * what lets `presetForPermissions` recognise a preset, and what makes two
 * equivalent grants compare equal in tests and in the UI.
 */
export function normalizeGrantPermissions(
  permissions: readonly string[],
): readonly PortalPermission[] {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new InvalidRoleGrantError(
      'A role grant must include at least one permission',
      'Pick at least one permission for this role.',
    );
  }
  const unknown = permissions.filter((p) => !isGrantablePermission(p));
  if (unknown.length > 0) {
    throw new InvalidRoleGrantError(
      `Not grantable: ${unknown.join(', ')}`,
      `Those permissions cannot be granted to a role: ${unknown.join(', ')}.`,
    );
  }
  const set = [...new Set(permissions as readonly PortalPermission[])].sort();
  // `admin.access` is what makes the Portal admin area reachable at all, so a
  // grant without it would be a set of capabilities behind a door the holder
  // cannot open. Added rather than rejected: the owner's intent is clear.
  if (!set.includes('admin.access')) set.unshift('admin.access');
  return set.sort();
}

function assertRoleId(roleId: string): void {
  if (!SNOWFLAKE.test(roleId)) {
    throw new InvalidRoleGrantError(
      `Not a Discord role snowflake: ${roleId}`,
      'That is not a valid Discord role.',
    );
  }
}

/**
 * Read a stored row back into a grant, dropping any permission that is no
 * longer grantable.
 *
 * The second half of the defence described at the top of the file: validation
 * on write is the friendly guard, and this is the one that cannot be bypassed.
 * A row written by a migration, an older release, or direct SQL cannot confer
 * a permission this build does not consider grantable.
 */
function rowToGrant(row: GuildAdminRoleGrantRow): AdminRoleGrant {
  const permissions = (row.permissions ?? []).filter(isGrantablePermission).sort();
  return {
    discordGuildId: row.discordGuildId,
    roleId: row.roleId,
    permissions,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export function createAdminRoleGrantService(db: Db): AdminRoleGrantService {
  async function list(discordGuildId: string): Promise<AdminRoleGrant[]> {
    const rows = await db
      .select()
      .from(guildAdminRoleGrants)
      .where(eq(guildAdminRoleGrants.discordGuildId, discordGuildId))
      .orderBy(asc(guildAdminRoleGrants.createdAt), asc(guildAdminRoleGrants.roleId));
    return rows.map(rowToGrant);
  }

  return {
    list,

    async permissionsForRoles(discordGuildId, roleIds) {
      if (roleIds.length === 0) return [];
      const held = new Set(roleIds);
      // One guild-scoped read, filtered in memory: a guild's grant list is a
      // handful of rows, and this keeps the guild predicate the only thing the
      // query trusts. Role ids come from Discord, never from a request body,
      // but reading them into an `IN (...)` would still put caller-adjacent
      // data in the query.
      const rows = await list(discordGuildId);
      const union = new Set<PortalPermission>();
      for (const grant of rows) {
        if (!held.has(grant.roleId)) continue;
        for (const permission of grant.permissions) union.add(permission);
      }
      return [...union].sort();
    },

    async upsert({ discordGuildId, roleId, permissions, actorDiscordUserId }) {
      assertRoleId(roleId);
      const normalized = normalizeGrantPermissions(permissions);
      const [row] = await db
        .insert(guildAdminRoleGrants)
        .values({
          discordGuildId,
          roleId,
          permissions: [...normalized],
          createdBy: actorDiscordUserId,
          updatedBy: actorDiscordUserId,
        })
        .onConflictDoUpdate({
          target: [guildAdminRoleGrants.discordGuildId, guildAdminRoleGrants.roleId],
          set: {
            permissions: [...normalized],
            updatedBy: actorDiscordUserId,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error('role grant upsert returned no row');
      return rowToGrant(row);
    },

    async update({ discordGuildId, roleId, permissions, actorDiscordUserId }) {
      assertRoleId(roleId);
      const normalized = normalizeGrantPermissions(permissions);
      const [row] = await db
        .update(guildAdminRoleGrants)
        .set({
          permissions: [...normalized],
          updatedBy: actorDiscordUserId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(guildAdminRoleGrants.discordGuildId, discordGuildId),
            eq(guildAdminRoleGrants.roleId, roleId),
          ),
        )
        .returning();
      if (!row) throw new RoleGrantNotFoundError(roleId);
      return rowToGrant(row);
    },

    async remove(discordGuildId, roleId) {
      const rows = await db
        .delete(guildAdminRoleGrants)
        .where(
          and(
            eq(guildAdminRoleGrants.discordGuildId, discordGuildId),
            eq(guildAdminRoleGrants.roleId, roleId),
          ),
        )
        .returning({ id: guildAdminRoleGrants.id });
      return rows.length > 0;
    },
  };
}

/** Re-exported so route schemas can enumerate the vocabulary in one import. */
export { GRANTABLE_PORTAL_PERMISSIONS };
