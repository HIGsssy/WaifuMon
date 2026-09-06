/**
 * AdminRoleGrantService against a real database.
 *
 * The two invariants the service exists to hold, tested where they actually
 * live: every query is guild-scoped, and only delegable permissions survive a
 * round trip — on the way in *and* on the way back out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { guildAdminRoleGrants } from '../../../src/db/schema';
import {
  InvalidRoleGrantError,
  RoleGrantNotFoundError,
  createAdminRoleGrantService,
  normalizeGrantPermissions,
  type AdminRoleGrantService,
} from '../../../src/modules/portalAuth/adminRoleGrantService';
import { ROLE_GRANT_PRESETS } from '../../../src/modules/portalAuth/portalAuthService';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const GUILD_A = '111222333444555666';
const GUILD_B = '222333444555666777';
const ROLE = '100000000000000001';
const OTHER_ROLE = '100000000000000002';
const ACTOR = '777888999000111222';

let t: TestDb;
let service: AdminRoleGrantService;

beforeAll(async () => {
  t = await createTestDb();
  service = createAdminRoleGrantService(t.db);
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await t.db.delete(guildAdminRoleGrants);
});

describe('permission normalisation', () => {
  it('sorts and de-duplicates, so a stored set has one canonical form', () => {
    expect(
      normalizeGrantPermissions(['encounters.read', 'admin.access', 'encounters.read']),
    ).toEqual(['admin.access', 'encounters.read']);
  });

  it('adds admin.access when it was omitted', () => {
    // Without it the holder has capabilities behind a door they cannot open.
    expect(normalizeGrantPermissions(['encounters.read'])).toContain('admin.access');
  });

  it('rejects the management permission and anything unknown', () => {
    expect(() => normalizeGrantPermissions(['admin.roles.manage'])).toThrow(
      InvalidRoleGrantError,
    );
    expect(() => normalizeGrantPermissions(['encounters.destroy'])).toThrow(
      InvalidRoleGrantError,
    );
    expect(() => normalizeGrantPermissions([])).toThrow(InvalidRoleGrantError);
  });
});

describe('guild scoping', () => {
  it('never returns another guild’s grants', async () => {
    await service.upsert({
      discordGuildId: GUILD_A,
      roleId: ROLE,
      permissions: [...ROLE_GRANT_PRESETS.encounter_editor],
      actorDiscordUserId: ACTOR,
    });
    await service.upsert({
      discordGuildId: GUILD_B,
      roleId: ROLE,
      permissions: [...ROLE_GRANT_PRESETS.encounter_publisher],
      actorDiscordUserId: ACTOR,
    });

    expect((await service.list(GUILD_A)).map((g) => g.roleId)).toEqual([ROLE]);
    // Same role snowflake in both guilds; each side sees only its own.
    const aPerms = await service.permissionsForRoles(GUILD_A, [ROLE]);
    const bPerms = await service.permissionsForRoles(GUILD_B, [ROLE]);
    expect(aPerms).not.toContain('encounters.publish');
    expect(bPerms).toContain('encounters.publish');
  });

  it('cannot update or delete across guilds', async () => {
    await service.upsert({
      discordGuildId: GUILD_A,
      roleId: ROLE,
      permissions: [...ROLE_GRANT_PRESETS.encounter_editor],
      actorDiscordUserId: ACTOR,
    });

    await expect(
      service.update({
        discordGuildId: GUILD_B,
        roleId: ROLE,
        permissions: [...ROLE_GRANT_PRESETS.encounter_publisher],
        actorDiscordUserId: ACTOR,
      }),
    ).rejects.toBeInstanceOf(RoleGrantNotFoundError);

    expect(await service.remove(GUILD_B, ROLE)).toBe(false);
    // Guild A's grant is untouched by either attempt.
    const [grant] = await service.list(GUILD_A);
    expect(grant!.permissions).not.toContain('encounters.publish');
  });
});

describe('storage behaviour', () => {
  it('re-adding a role replaces its grant rather than duplicating it', async () => {
    await service.upsert({
      discordGuildId: GUILD_A,
      roleId: ROLE,
      permissions: [...ROLE_GRANT_PRESETS.encounter_editor],
      actorDiscordUserId: ACTOR,
    });
    await service.upsert({
      discordGuildId: GUILD_A,
      roleId: ROLE,
      permissions: [...ROLE_GRANT_PRESETS.encounter_publisher],
      actorDiscordUserId: ACTOR,
    });

    const grants = await service.list(GUILD_A);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.permissions).toContain('encounters.publish');
  });

  it('unions permissions across several matching roles', async () => {
    await service.upsert({
      discordGuildId: GUILD_A,
      roleId: ROLE,
      permissions: ['admin.access', 'encounters.read'],
      actorDiscordUserId: ACTOR,
    });
    await service.upsert({
      discordGuildId: GUILD_A,
      roleId: OTHER_ROLE,
      permissions: ['admin.access', 'encounters.publish'],
      actorDiscordUserId: ACTOR,
    });

    const union = await service.permissionsForRoles(GUILD_A, [ROLE, OTHER_ROLE]);
    expect([...union].sort()).toEqual([
      'admin.access',
      'encounters.publish',
      'encounters.read',
    ]);
  });

  it('grants nothing for roles with no grant, or an empty role list', async () => {
    await service.upsert({
      discordGuildId: GUILD_A,
      roleId: ROLE,
      permissions: ['admin.access', 'encounters.read'],
      actorDiscordUserId: ACTOR,
    });

    expect(await service.permissionsForRoles(GUILD_A, ['999999999999999999'])).toEqual([]);
    expect(await service.permissionsForRoles(GUILD_A, [])).toEqual([]);
  });

  it('drops a non-delegable permission written straight into the table', async () => {
    // A row from an older build, a migration, or direct SQL. Validation on
    // write is the friendly guard; this filter is the one that cannot be
    // bypassed.
    await t.db.insert(guildAdminRoleGrants).values({
      discordGuildId: GUILD_A,
      roleId: ROLE,
      permissions: ['admin.access', 'admin.roles.manage', 'not-a-permission'],
    });

    const [grant] = await service.list(GUILD_A);
    expect(grant!.permissions).toEqual(['admin.access']);
    expect(await service.permissionsForRoles(GUILD_A, [ROLE])).toEqual(['admin.access']);
  });

  it('rejects a role id that is not a snowflake', async () => {
    await expect(
      service.upsert({
        discordGuildId: GUILD_A,
        roleId: 'Encounter Developer',
        permissions: ['admin.access'],
        actorDiscordUserId: ACTOR,
      }),
    ).rejects.toBeInstanceOf(InvalidRoleGrantError);
  });

  it('records who created and who last changed a grant', async () => {
    const created = await service.upsert({
      discordGuildId: GUILD_A,
      roleId: ROLE,
      permissions: ['admin.access', 'encounters.read'],
      actorDiscordUserId: ACTOR,
    });
    expect(created.createdBy).toBe(ACTOR);

    const updated = await service.update({
      discordGuildId: GUILD_A,
      roleId: ROLE,
      permissions: ['admin.access', 'encounters.write'],
      actorDiscordUserId: 'someone-else',
    });
    expect(updated.createdBy).toBe(ACTOR);
    expect(updated.updatedBy).toBe('someone-else');
  });
});
