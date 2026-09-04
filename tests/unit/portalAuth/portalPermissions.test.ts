/**
 * Unit tests for the {@link requirePortalPermission} guard.
 *
 * Fakes the FastifyRequest just enough to exercise the three branches
 * (bearer bypass, session with permission, session without permission).
 */
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requirePortalPermission, PortalPermissionError } from '../../../src/api/plugins/portalPermissions';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import type { PortalSession } from '../../../src/api/portalSession';

function makeSession(overrides: Partial<PortalSession> = {}): PortalSession {
  return {
    sessionDigest: 'digest',
    discordUserId: 'user-1',
    discordUsername: null,
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

function makeAuth(ownerId: string | null) {
  const guildOwnership = createGuildOwnershipService({
    fetchOwnerId: async () => ownerId,
  });
  return createPortalAuthorizationService({ guildOwnership });
}

function makeReq(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return { apiAuth: undefined, portalSession: undefined, ...overrides } as FastifyRequest;
}

describe('requirePortalPermission', () => {
  it('rejects a bearer-authenticated request by default', async () => {
    // The shared Platform API token is a read credential. It does not become
    // an administrator just because admin routes exist — an operator has to
    // say so with PLATFORM_API_ADMIN_BEARER.
    const auth = makeAuth(null);
    await expect(
      requirePortalPermission(makeReq({ apiAuth: 'bearer' }), auth, 'encounters.write'),
    ).rejects.toBeInstanceOf(PortalPermissionError);
  });

  it('lets a bearer request through only when the bypass is explicitly enabled', async () => {
    const auth = makeAuth(null);
    await expect(
      requirePortalPermission(makeReq({ apiAuth: 'bearer' }), auth, 'encounters.write', {
        allowBearer: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('treats an absent allowBearer exactly like an explicit false', async () => {
    const auth = makeAuth(null);
    await expect(
      requirePortalPermission(makeReq({ apiAuth: 'bearer' }), auth, 'encounters.write', {}),
    ).rejects.toBeInstanceOf(PortalPermissionError);
    await expect(
      requirePortalPermission(makeReq({ apiAuth: 'bearer' }), auth, 'encounters.write', {
        allowBearer: false,
      }),
    ).rejects.toBeInstanceOf(PortalPermissionError);
  });

  it('rejects requests without any session', async () => {
    const auth = makeAuth('user-1');
    await expect(
      requirePortalPermission(makeReq(), auth, 'encounters.write'),
    ).rejects.toBeInstanceOf(PortalPermissionError);
  });

  it('accepts a session whose user owns the selected guild', async () => {
    const auth = makeAuth('user-1');
    const session = makeSession({ discordUserId: 'user-1' });
    await expect(
      requirePortalPermission(
        makeReq({ apiAuth: 'portal', portalSession: session }),
        auth,
        'encounters.write',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a session that lacks the permission', async () => {
    const auth = makeAuth('someone-else');
    const session = makeSession({ discordUserId: 'user-1' });
    await expect(
      requirePortalPermission(
        makeReq({ apiAuth: 'portal', portalSession: session }),
        auth,
        'encounters.write',
      ),
    ).rejects.toBeInstanceOf(PortalPermissionError);
  });

  it('does not leak a permission granted in one guild to another', async () => {
    // user-1 owns guild-A but the session is scoped to guild-B.
    const guildOwnership = createGuildOwnershipService({
      fetchOwnerId: async (guildId) => (guildId === 'guild-A' ? 'user-1' : 'someone-else'),
    });
    const auth = createPortalAuthorizationService({ guildOwnership });
    const session = makeSession({
      discordUserId: 'user-1',
      selectedDiscordGuildId: 'guild-B',
    });
    await expect(
      requirePortalPermission(
        makeReq({ apiAuth: 'portal', portalSession: session }),
        auth,
        'encounters.read',
      ),
    ).rejects.toBeInstanceOf(PortalPermissionError);
  });
});
