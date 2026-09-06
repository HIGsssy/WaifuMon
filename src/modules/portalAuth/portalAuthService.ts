/**
 * PortalAuthorizationService — the single answer to "what may this Portal
 * session do?".
 *
 * Everything downstream — API route guards, admin nav rendering, admin action
 * buttons — asks this service for a permission set. Callers never ask "is
 * this the guild owner?" directly: that is deliberately hidden here so a
 * later "Content Editor" or "Moderator" role can be added without touching
 * every route.
 *
 * The rules, in order:
 *
 *   Discord guild owner  →  every permission in {@link ALL_PORTAL_PERMISSIONS}
 *   Member holding a granted role
 *                        →  the union of every matching grant's permissions
 *   Everyone else        →  no permissions
 *
 * Owner authorization is checked first and returns immediately, so an owner is
 * never affected by the grant table — they cannot lock themselves out by
 * deleting a grant, and a Discord lookup for their roles never even runs.
 *
 * The role step **fails closed at every stage**: an unknown guild, a member
 * the bot cannot see, a failed gateway read, a grant naming a role that no
 * longer exists, and a grant naming a permission this build does not consider
 * grantable all contribute nothing. There is no path through this function
 * that grants a permission without a live Discord role membership behind it.
 */
import type { PortalSession } from '../../api/portalSession';
import type { GuildOwnershipService } from './guildOwnershipService';
import type { GuildRoleService } from './guildRoleService';
import type { AdminRoleGrantService } from './adminRoleGrantService';

/**
 * Closed set of permissions Phase 2 recognises. New capabilities are added
 * here (and to any route that guards them); the *authorization rules* that
 * grant them live in {@link computePermissionsFor}.
 */
export const ALL_PORTAL_PERMISSIONS = [
  'admin.access',
  'admin.roles.manage',
  'encounters.read',
  'encounters.write',
  'encounters.publish',
  'encounters.simulate',
  'encounters.history',
] as const;
export type PortalPermission = (typeof ALL_PORTAL_PERMISSIONS)[number];

/**
 * Permissions an owner may delegate to a Discord role.
 *
 * Everything except {@link ADMIN_ROLES_MANAGE}. That exclusion is the whole
 * privilege-escalation defence and it lives here, in the vocabulary, rather
 * than in a route check: a role-granted admin cannot be handed the ability to
 * edit grants, so they cannot widen their own access or anyone else's. The
 * grant service refuses to persist a non-grantable permission, and
 * `computePermissionsFor` intersects against this list again when reading —
 * so even a row written directly into the database by another means grants
 * nothing it should not.
 */
export const ADMIN_ROLES_MANAGE = 'admin.roles.manage' satisfies PortalPermission;

export const GRANTABLE_PORTAL_PERMISSIONS: readonly PortalPermission[] =
  ALL_PORTAL_PERMISSIONS.filter((p) => p !== ADMIN_ROLES_MANAGE);

export function isGrantablePermission(value: unknown): value is PortalPermission {
  return (
    typeof value === 'string' &&
    (GRANTABLE_PORTAL_PERMISSIONS as readonly string[]).includes(value)
  );
}

/**
 * The presets the Portal offers, and the vocabulary the API validates against.
 *
 * Named sets rather than free-form checkboxes as the primary affordance: the
 * distinction an owner actually cares about is "can this person publish?", and
 * a preset states that in one word. Custom selection is still permitted — the
 * API takes a permission list, and a payload that matches no preset is
 * accepted as long as every entry is grantable.
 */
export const ROLE_GRANT_PRESETS = {
  encounter_editor: [
    'admin.access',
    'encounters.read',
    'encounters.write',
    'encounters.simulate',
    'encounters.history',
  ],
  encounter_publisher: [
    'admin.access',
    'encounters.read',
    'encounters.write',
    'encounters.publish',
    'encounters.simulate',
    'encounters.history',
  ],
} as const satisfies Record<string, readonly PortalPermission[]>;

export type RoleGrantPreset = keyof typeof ROLE_GRANT_PRESETS;

/**
 * Which preset a permission set corresponds to, or `custom`. Presentation
 * only — the stored grant is always the permission list itself, so a preset
 * that is later redefined cannot silently change what an existing role holds.
 */
export function presetForPermissions(
  permissions: readonly PortalPermission[],
): RoleGrantPreset | 'custom' {
  const key = [...new Set(permissions)].sort().join(',');
  for (const [name, preset] of Object.entries(ROLE_GRANT_PRESETS)) {
    if ([...preset].sort().join(',') === key) return name as RoleGrantPreset;
  }
  return 'custom';
}

export interface PortalPermissionSet {
  /** Sorted, stable ordering — safe to compare across responses in tests. */
  permissions: readonly PortalPermission[];
  /** Why the permissions were granted, opaque to callers; useful in logs. */
  reason: PermissionReason;
}

export type PermissionReason =
  | { kind: 'unauthenticated' }
  | { kind: 'no_guild_selected' }
  | { kind: 'guild_owner'; discordGuildId: string }
  /** One or more granted roles matched. `roleIds` are the ones that matched. */
  | { kind: 'role_grant'; discordGuildId: string; roleIds: readonly string[] }
  /** Discord could not tell us this member's roles — deliberately not `ineligible`. */
  | { kind: 'roles_unavailable'; discordGuildId: string }
  | { kind: 'ineligible' };

export interface PortalAuthorizationService {
  /**
   * Compute the full permission set for a session. Never throws for an
   * unauthenticated or guild-less session — those simply return the empty
   * set with a matching reason.
   */
  computePermissionsFor(session: PortalSession | null): Promise<PortalPermissionSet>;
  /** Convenience: `true` iff the computed set contains `permission`. */
  has(session: PortalSession | null, permission: PortalPermission): Promise<boolean>;
  /**
   * `true` iff this session is the live Discord owner of its selected guild.
   * Not a permission — see the implementation note.
   */
  isGuildOwner(session: PortalSession | null): Promise<boolean>;
}

const EMPTY_SET: readonly PortalPermission[] = [];

function sorted(perms: readonly PortalPermission[]): readonly PortalPermission[] {
  return [...new Set(perms)].sort() as PortalPermission[];
}

/** The permission set every admin currently gets. */
export const ADMIN_PERMISSIONS: readonly PortalPermission[] = [...ALL_PORTAL_PERMISSIONS];

export interface PortalAuthorizationServiceDeps {
  guildOwnership: GuildOwnershipService;
  /**
   * Resolves the roles a member currently holds. Optional: a deployment
   * without the bot attached (or an older wiring) simply has no role step,
   * and behaves exactly as it did before role grants existed.
   */
  guildRoles?: GuildRoleService | undefined;
  /** Reads the grant table. Optional for the same reason as {@link guildRoles}. */
  roleGrants?: AdminRoleGrantService | undefined;
}

export function createPortalAuthorizationService(
  deps: PortalAuthorizationServiceDeps,
): PortalAuthorizationService {
  async function computePermissionsFor(
    session: PortalSession | null,
  ): Promise<PortalPermissionSet> {
    if (!session) return { permissions: EMPTY_SET, reason: { kind: 'unauthenticated' } };
    const discordGuildId = session.selectedDiscordGuildId;
    if (!discordGuildId) return { permissions: EMPTY_SET, reason: { kind: 'no_guild_selected' } };

    const ownerId = await deps.guildOwnership.getOwnerId(discordGuildId);
    if (ownerId && ownerId === session.discordUserId) {
      // First and unconditional. The owner's access does not depend on the
      // grant table, on a role lookup, or on anything they could misconfigure,
      // which is what makes locking themselves out impossible.
      return {
        permissions: sorted(ADMIN_PERMISSIONS),
        reason: { kind: 'guild_owner', discordGuildId },
      };
    }

    // Delegated access. Absent either dependency, this whole step is skipped
    // and the answer is the pre-role-grants one: nothing.
    if (!deps.guildRoles || !deps.roleGrants) {
      return { permissions: EMPTY_SET, reason: { kind: 'ineligible' } };
    }

    const roleIds = await deps.guildRoles.getMemberRoleIds(
      discordGuildId,
      session.discordUserId,
    );
    // `null` is "we do not know" — a failed gateway read, or a member the bot
    // cannot see. Reported distinctly from `ineligible` so an operator reading
    // logs can tell a lookup outage from a user who simply has no roles, but
    // both grant nothing.
    if (roleIds == null) {
      return { permissions: EMPTY_SET, reason: { kind: 'roles_unavailable', discordGuildId } };
    }
    if (roleIds.length === 0) {
      return { permissions: EMPTY_SET, reason: { kind: 'ineligible' } };
    }

    // Guild-scoped: grants for the *selected* guild only, matched against the
    // roles held in that same guild. A grant in another guild is not read, so
    // there is no cross-guild path even if a role snowflake collided.
    const granted = await deps.roleGrants.permissionsForRoles(discordGuildId, roleIds);
    if (granted.length === 0) {
      return { permissions: EMPTY_SET, reason: { kind: 'ineligible' } };
    }

    // Intersected with the grantable set one final time. `admin.roles.manage`
    // cannot arrive here — the grant service refuses to write it and filters
    // it on read — and this is the belt to that braces: whatever the table
    // says, a non-owner never holds it.
    const permissions = sorted(granted).filter(
      (p): p is PortalPermission => isGrantablePermission(p),
    );
    if (permissions.length === 0) {
      return { permissions: EMPTY_SET, reason: { kind: 'ineligible' } };
    }

    const matchedRoleIds = await matchedRoles(discordGuildId, roleIds);
    return {
      permissions,
      reason: { kind: 'role_grant', discordGuildId, roleIds: matchedRoleIds },
    };
  }

  /** Which of the member's roles actually carry a grant — for the log line. */
  async function matchedRoles(
    discordGuildId: string,
    roleIds: readonly string[],
  ): Promise<readonly string[]> {
    if (!deps.roleGrants) return [];
    const grants = await deps.roleGrants.list(discordGuildId);
    const held = new Set(roleIds);
    return grants.filter((g) => held.has(g.roleId)).map((g) => g.roleId);
  }

  /**
   * Is this session the live Discord owner of its selected guild?
   *
   * Exposed because grant management is owner-only and that must not be
   * expressible as a grantable permission. Routes still guard on
   * `admin.roles.manage`, which only the owner branch above ever returns —
   * this is the direct question for callers that need it (the Portal's own
   * "you are the owner" banner).
   */
  async function isGuildOwner(session: PortalSession | null): Promise<boolean> {
    if (!session?.selectedDiscordGuildId) return false;
    const ownerId = await deps.guildOwnership.getOwnerId(session.selectedDiscordGuildId);
    return ownerId != null && ownerId === session.discordUserId;
  }

  async function has(
    session: PortalSession | null,
    permission: PortalPermission,
  ): Promise<boolean> {
    const set = await computePermissionsFor(session);
    return set.permissions.includes(permission);
  }

  return { computePermissionsFor, has, isGuildOwner };
}
