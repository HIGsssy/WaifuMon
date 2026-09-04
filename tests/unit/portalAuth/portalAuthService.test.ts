/**
 * Unit tests for {@link PortalAuthorizationService}.
 *
 * These tests never touch Discord: the guild-ownership dependency is a
 * `FetchGuildOwnerId` closure, and every case pins that closure with a
 * fixed answer.
 */
import { describe, expect, it } from 'vitest';
import type { PortalSession } from '../../../src/api/portalSession';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';

function makeSession(overrides: Partial<PortalSession> = {}): PortalSession {
  return {
    sessionDigest: 'digest',
    discordUserId: 'user-1',
    discordUsername: 'trainer',
    discordAvatarUrl: null,
    selectedDiscordGuildId: 'guild-A',
    selectedGuildDbId: 1,
    playerId: 42,
    eligibleGuilds: [],
    csrfToken: 'csrf',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function makeAuth(fetchOwnerId: (guildId: string) => Promise<string | null>) {
  const guildOwnership = createGuildOwnershipService({
    fetchOwnerId,
    ttlMs: 60_000,
  });
  return { auth: createPortalAuthorizationService({ guildOwnership }), guildOwnership };
}

describe('PortalAuthorizationService', () => {
  it('returns empty permissions when no session is provided', async () => {
    const { auth } = makeAuth(async () => 'user-1');
    const result = await auth.computePermissionsFor(null);
    expect(result.permissions).toEqual([]);
    expect(result.reason.kind).toBe('unauthenticated');
  });

  it('returns empty permissions when no guild is selected', async () => {
    const { auth } = makeAuth(async () => 'user-1');
    const result = await auth.computePermissionsFor(
      makeSession({ selectedDiscordGuildId: null, selectedGuildDbId: null }),
    );
    expect(result.permissions).toEqual([]);
    expect(result.reason.kind).toBe('no_guild_selected');
  });

  it('grants every admin permission when the session user owns the selected guild', async () => {
    const { auth } = makeAuth(async () => 'user-1');
    const result = await auth.computePermissionsFor(
      makeSession({ discordUserId: 'user-1', selectedDiscordGuildId: 'guild-A' }),
    );
    expect(result.permissions).toEqual(
      expect.arrayContaining([
        'admin.access',
        'encounters.read',
        'encounters.write',
        'encounters.publish',
        'encounters.simulate',
        'encounters.history',
      ]),
    );
    expect(result.reason.kind).toBe('guild_owner');
  });

  it('rejects a non-owner of the selected guild', async () => {
    const { auth } = makeAuth(async () => 'someone-else');
    const result = await auth.computePermissionsFor(
      makeSession({ discordUserId: 'user-1' }),
    );
    expect(result.permissions).toEqual([]);
    expect(result.reason.kind).toBe('ineligible');
  });

  it('does not leak permission from one guild to another (guild scoping)', async () => {
    // Fetcher: user-1 owns guild-A only.
    const { auth } = makeAuth(async (guildId) => (guildId === 'guild-A' ? 'user-1' : 'user-B'));

    const inA = await auth.computePermissionsFor(
      makeSession({ discordUserId: 'user-1', selectedDiscordGuildId: 'guild-A' }),
    );
    expect(inA.permissions.length).toBeGreaterThan(0);

    const inB = await auth.computePermissionsFor(
      makeSession({ discordUserId: 'user-1', selectedDiscordGuildId: 'guild-B' }),
    );
    expect(inB.permissions).toEqual([]);
  });

  it('reflects a fetcher failure as "unknown owner" and denies access', async () => {
    const { auth } = makeAuth(async () => {
      throw new Error('discord api down');
    });
    const result = await auth.computePermissionsFor(
      makeSession({ discordUserId: 'user-1' }),
    );
    expect(result.permissions).toEqual([]);
    expect(result.reason.kind).toBe('ineligible');
  });

  it('caches ownership between checks (single fetcher call for two lookups)', async () => {
    let calls = 0;
    const { auth } = makeAuth(async () => {
      calls++;
      return 'user-1';
    });
    await auth.computePermissionsFor(makeSession({ discordUserId: 'user-1' }));
    await auth.computePermissionsFor(makeSession({ discordUserId: 'user-1' }));
    expect(calls).toBe(1);
  });

  it('honours `set`: primed ownership never invokes the fetcher', async () => {
    let calls = 0;
    const { auth, guildOwnership } = makeAuth(async () => {
      calls++;
      return null;
    });
    guildOwnership.set('guild-A', 'user-1');
    const result = await auth.computePermissionsFor(
      makeSession({ discordUserId: 'user-1', selectedDiscordGuildId: 'guild-A' }),
    );
    expect(result.reason.kind).toBe('guild_owner');
    expect(calls).toBe(0);
  });
});
