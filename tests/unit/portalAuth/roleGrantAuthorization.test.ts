/**
 * Delegated Portal Admin access — the authorization half.
 *
 * The rule being pinned is that role grants add a *second* way to be an admin
 * without weakening the first or opening a path to escalation:
 *
 *   - the owner's access never depends on the grant table or on a role lookup;
 *   - a non-owner's access is exactly the union of grants for roles they
 *     currently hold, in the guild they currently have selected;
 *   - every uncertainty — a failed lookup, a member the bot cannot see, a
 *     grant for a role nobody holds — resolves to no access.
 *
 * No database and no Discord: the grant service is a small in-memory double
 * implementing the same interface, and role membership is a closure.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PortalSession } from '../../../src/api/portalSession';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createGuildRoleService } from '../../../src/modules/portalAuth/guildRoleService';
import {
  ADMIN_ROLES_MANAGE,
  ALL_PORTAL_PERMISSIONS,
  GRANTABLE_PORTAL_PERMISSIONS,
  ROLE_GRANT_PRESETS,
  createPortalAuthorizationService,
  presetForPermissions,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import type {
  AdminRoleGrant,
  AdminRoleGrantService,
} from '../../../src/modules/portalAuth/adminRoleGrantService';

const OWNER = 'owner-1';
const MEMBER = 'member-1';
const GUILD = 'guild-A';
const OTHER_GUILD = 'guild-B';

const EDITOR_ROLE = '100000000000000001';
const PUBLISHER_ROLE = '100000000000000002';
const DELETED_ROLE = '100000000000000009';

function makeSession(overrides: Partial<PortalSession> = {}): PortalSession {
  return {
    sessionDigest: 'digest',
    discordUserId: MEMBER,
    discordUsername: 'trainer',
    discordAvatarUrl: null,
    selectedDiscordGuildId: GUILD,
    selectedGuildDbId: 1,
    playerId: 42,
    eligibleGuilds: [],
    csrfToken: 'csrf',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

/** In-memory stand-in for the real grant service, same interface. */
function grantsDouble(
  seed: Array<{ guildId: string; roleId: string; permissions: readonly PortalPermission[] }>,
): AdminRoleGrantService {
  const rows: AdminRoleGrant[] = seed.map((s) => ({
    discordGuildId: s.guildId,
    roleId: s.roleId,
    permissions: [...s.permissions].sort(),
    createdAt: new Date(0),
    createdBy: OWNER,
    updatedAt: new Date(0),
    updatedBy: OWNER,
  }));
  const forGuild = (guildId: string) => rows.filter((r) => r.discordGuildId === guildId);
  return {
    list: async (guildId) => forGuild(guildId),
    permissionsForRoles: async (guildId, roleIds) => {
      const held = new Set(roleIds);
      const union = new Set<PortalPermission>();
      for (const row of forGuild(guildId)) {
        if (!held.has(row.roleId)) continue;
        for (const p of row.permissions) union.add(p);
      }
      return [...union].sort();
    },
    upsert: async () => {
      throw new Error('not used');
    },
    update: async () => {
      throw new Error('not used');
    },
    remove: async () => false,
  };
}

function makeAuth(opts: {
  ownerId?: string | null;
  memberRoles?: Record<string, readonly string[] | null>;
  memberRolesThrows?: boolean;
  grants?: Parameters<typeof grantsDouble>[0];
}) {
  const guildOwnership = createGuildOwnershipService({
    fetchOwnerId: async () => opts.ownerId ?? OWNER,
    ttlMs: 60_000,
  });
  const fetchMemberRoleIds = vi.fn(async (guildId: string, userId: string) => {
    if (opts.memberRolesThrows) throw new Error('gateway is down');
    return opts.memberRoles?.[`${guildId}:${userId}`] ?? null;
  });
  const guildRoles = createGuildRoleService({
    fetchMemberRoleIds,
    fetchGuildRoles: async () => null,
    memberTtlMs: 60_000,
  });
  const roleGrants = grantsDouble(opts.grants ?? []);
  return {
    auth: createPortalAuthorizationService({ guildOwnership, guildRoles, roleGrants }),
    fetchMemberRoleIds,
  };
}

const editorGrant = {
  guildId: GUILD,
  roleId: EDITOR_ROLE,
  permissions: ROLE_GRANT_PRESETS.encounter_editor,
};
const publisherGrant = {
  guildId: GUILD,
  roleId: PUBLISHER_ROLE,
  permissions: ROLE_GRANT_PRESETS.encounter_publisher,
};

describe('the guild owner is unconditional', () => {
  it('still receives every permission', async () => {
    const { auth } = makeAuth({ ownerId: OWNER });
    const result = await auth.computePermissionsFor(makeSession({ discordUserId: OWNER }));

    expect([...result.permissions].sort()).toEqual([...ALL_PORTAL_PERMISSIONS].sort());
    expect(result.reason.kind).toBe('guild_owner');
  });

  it('holds the one permission that cannot be delegated', async () => {
    const { auth } = makeAuth({ ownerId: OWNER });

    expect(await auth.has(makeSession({ discordUserId: OWNER }), ADMIN_ROLES_MANAGE)).toBe(true);
    expect(GRANTABLE_PORTAL_PERMISSIONS).not.toContain(ADMIN_ROLES_MANAGE);
  });

  it('does not depend on the grant table or on a role lookup', async () => {
    // No grants at all, and a member-role fetcher that would throw. The owner
    // is answered before either is consulted, so they cannot lock themselves
    // out by deleting every grant.
    const { auth, fetchMemberRoleIds } = makeAuth({
      ownerId: OWNER,
      memberRolesThrows: true,
      grants: [],
    });
    const result = await auth.computePermissionsFor(makeSession({ discordUserId: OWNER }));

    expect(result.permissions).toHaveLength(ALL_PORTAL_PERMISSIONS.length);
    expect(fetchMemberRoleIds).not.toHaveBeenCalled();
  });

  it('is reported by isGuildOwner, and a member is not', async () => {
    const { auth } = makeAuth({ ownerId: OWNER });

    expect(await auth.isGuildOwner(makeSession({ discordUserId: OWNER }))).toBe(true);
    expect(await auth.isGuildOwner(makeSession({ discordUserId: MEMBER }))).toBe(false);
    expect(await auth.isGuildOwner(null)).toBe(false);
  });
});

describe('a non-owner gets exactly what their roles grant', () => {
  it('an ordinary member with no roles receives nothing', async () => {
    const { auth } = makeAuth({
      memberRoles: { [`${GUILD}:${MEMBER}`]: [] },
      grants: [editorGrant],
    });
    const result = await auth.computePermissionsFor(makeSession());

    expect(result.permissions).toEqual([]);
    expect(result.reason.kind).toBe('ineligible');
  });

  it('a member holding a role with no grant receives nothing', async () => {
    const { auth } = makeAuth({
      memberRoles: { [`${GUILD}:${MEMBER}`]: ['999999999999999999'] },
      grants: [editorGrant],
    });

    expect((await auth.computePermissionsFor(makeSession())).permissions).toEqual([]);
  });

  it('the Encounter Editor preset grants authoring but not publishing', async () => {
    const { auth } = makeAuth({
      memberRoles: { [`${GUILD}:${MEMBER}`]: [EDITOR_ROLE] },
      grants: [editorGrant],
    });
    const result = await auth.computePermissionsFor(makeSession());

    expect([...result.permissions].sort()).toEqual(
      [...ROLE_GRANT_PRESETS.encounter_editor].sort(),
    );
    expect(result.permissions).toContain('encounters.write');
    expect(result.permissions).not.toContain('encounters.publish');
    expect(result.reason.kind).toBe('role_grant');
  });

  it('an editor cannot publish', async () => {
    const { auth } = makeAuth({
      memberRoles: { [`${GUILD}:${MEMBER}`]: [EDITOR_ROLE] },
      grants: [editorGrant],
    });

    expect(await auth.has(makeSession(), 'encounters.publish')).toBe(false);
    expect(await auth.has(makeSession(), 'encounters.write')).toBe(true);
  });

  it('the Encounter Publisher preset can publish', async () => {
    const { auth } = makeAuth({
      memberRoles: { [`${GUILD}:${MEMBER}`]: [PUBLISHER_ROLE] },
      grants: [publisherGrant],
    });

    expect(await auth.has(makeSession(), 'encounters.publish')).toBe(true);
  });

  it('multiple matching roles union their permissions', async () => {
    // A member in both roles gets the wider of the two, without either grant
    // being edited — which is the whole point of a union.
    const { auth } = makeAuth({
      memberRoles: { [`${GUILD}:${MEMBER}`]: [EDITOR_ROLE, PUBLISHER_ROLE] },
      grants: [editorGrant, publisherGrant],
    });
    const result = await auth.computePermissionsFor(makeSession());

    expect([...result.permissions].sort()).toEqual(
      [...ROLE_GRANT_PRESETS.encounter_publisher].sort(),
    );
    const reason = result.reason as { kind: string; roleIds: readonly string[] };
    expect([...reason.roleIds].sort()).toEqual([EDITOR_ROLE, PUBLISHER_ROLE].sort());
  });

  it('never receives the grant-management permission, whatever the table says', async () => {
    // A row that somehow names `admin.roles.manage` — written by an older
    // build, a migration, or direct SQL. Authorization intersects against the
    // grantable set, so it confers nothing.
    const { auth } = makeAuth({
      memberRoles: { [`${GUILD}:${MEMBER}`]: [EDITOR_ROLE] },
      grants: [
        {
          guildId: GUILD,
          roleId: EDITOR_ROLE,
          permissions: ['admin.access', ADMIN_ROLES_MANAGE] as PortalPermission[],
        },
      ],
    });
    const result = await auth.computePermissionsFor(makeSession());

    expect(result.permissions).not.toContain(ADMIN_ROLES_MANAGE);
    expect(await auth.has(makeSession(), ADMIN_ROLES_MANAGE)).toBe(false);
  });
});

describe('everything uncertain fails closed', () => {
  it('a Discord lookup failure grants nothing', async () => {
    const { auth } = makeAuth({
      memberRolesThrows: true,
      grants: [publisherGrant],
    });
    const result = await auth.computePermissionsFor(makeSession());

    expect(result.permissions).toEqual([]);
    // Reported distinctly from `ineligible` so an outage is legible in logs.
    expect(result.reason.kind).toBe('roles_unavailable');
  });

  it('a member the bot cannot see grants nothing', async () => {
    const { auth } = makeAuth({
      memberRoles: { [`${GUILD}:${MEMBER}`]: null },
      grants: [publisherGrant],
    });
    const result = await auth.computePermissionsFor(makeSession());

    expect(result.permissions).toEqual([]);
    expect(result.reason.kind).toBe('roles_unavailable');
  });

  it('a grant for a deleted role grants nothing', async () => {
    // The row survives; nobody holds the role, so it never matches.
    const { auth } = makeAuth({
      memberRoles: { [`${GUILD}:${MEMBER}`]: [EDITOR_ROLE] },
      grants: [
        { guildId: GUILD, roleId: DELETED_ROLE, permissions: ROLE_GRANT_PRESETS.encounter_publisher },
      ],
    });

    expect((await auth.computePermissionsFor(makeSession())).permissions).toEqual([]);
  });

  it('a grant in another guild cannot authorize this session', async () => {
    // Same role snowflake, different guild. The grant is read guild-scoped, so
    // the member's roles in guild A never meet guild B's grants.
    const { auth } = makeAuth({
      memberRoles: { [`${GUILD}:${MEMBER}`]: [PUBLISHER_ROLE] },
      grants: [{ ...publisherGrant, guildId: OTHER_GUILD }],
    });

    expect((await auth.computePermissionsFor(makeSession())).permissions).toEqual([]);
  });

  it('the role step is skipped entirely when the dependencies are absent', async () => {
    // A deployment without the bot wires neither, and must behave exactly as
    // it did before role grants existed: owner only.
    const guildOwnership = createGuildOwnershipService({
      fetchOwnerId: async () => OWNER,
      ttlMs: 60_000,
    });
    const auth = createPortalAuthorizationService({ guildOwnership });

    expect((await auth.computePermissionsFor(makeSession())).permissions).toEqual([]);
    expect(
      (await auth.computePermissionsFor(makeSession({ discordUserId: OWNER }))).permissions,
    ).toHaveLength(ALL_PORTAL_PERMISSIONS.length);
  });
});

describe('preset naming', () => {
  it('recognises each shipped preset and calls anything else custom', () => {
    expect(presetForPermissions(ROLE_GRANT_PRESETS.encounter_editor)).toBe('encounter_editor');
    expect(presetForPermissions(ROLE_GRANT_PRESETS.encounter_publisher)).toBe(
      'encounter_publisher',
    );
    expect(presetForPermissions(['admin.access', 'encounters.read'])).toBe('custom');
  });

  it('does not depend on ordering', () => {
    const shuffled = [...ROLE_GRANT_PRESETS.encounter_editor].reverse();
    expect(presetForPermissions(shuffled)).toBe('encounter_editor');
  });
});
