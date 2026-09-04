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
 * Phase 2 rule (deliberately narrow):
 *
 *   Discord guild owner  →  every admin permission listed in
 *                            {@link ALL_PORTAL_PERMISSIONS}
 *   Everyone else        →  no permissions
 *
 * Configurable Discord-role mapping is a Phase 3 concern. The API here is
 * shaped so that layer plugs in with a new "authoritative check" step
 * appended to {@link computePermissionsFor}; the callers do not change.
 */
import type { PortalSession } from '../../api/portalSession';
import type { GuildOwnershipService } from './guildOwnershipService';

/**
 * Closed set of permissions Phase 2 recognises. New capabilities are added
 * here (and to any route that guards them); the *authorization rules* that
 * grant them live in {@link computePermissionsFor}.
 */
export const ALL_PORTAL_PERMISSIONS = [
  'admin.access',
  'encounters.read',
  'encounters.write',
  'encounters.publish',
  'encounters.simulate',
  'encounters.history',
] as const;
export type PortalPermission = (typeof ALL_PORTAL_PERMISSIONS)[number];

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
}

const EMPTY_SET: readonly PortalPermission[] = [];

function sorted(perms: readonly PortalPermission[]): readonly PortalPermission[] {
  return [...new Set(perms)].sort() as PortalPermission[];
}

/** The permission set every admin currently gets. */
export const ADMIN_PERMISSIONS: readonly PortalPermission[] = [
  'admin.access',
  'encounters.read',
  'encounters.write',
  'encounters.publish',
  'encounters.simulate',
  'encounters.history',
];

export interface PortalAuthorizationServiceDeps {
  guildOwnership: GuildOwnershipService;
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
      return {
        permissions: sorted(ADMIN_PERMISSIONS),
        reason: { kind: 'guild_owner', discordGuildId },
      };
    }
    return { permissions: EMPTY_SET, reason: { kind: 'ineligible' } };
  }

  async function has(
    session: PortalSession | null,
    permission: PortalPermission,
  ): Promise<boolean> {
    const set = await computePermissionsFor(session);
    return set.permissions.includes(permission);
  }

  return { computePermissionsFor, has };
}
