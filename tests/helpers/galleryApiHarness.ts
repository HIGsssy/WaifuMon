/**
 * A Platform API server for Admin Gallery route tests: real auth hook, real
 * permission guard, real routes, no database.
 *
 * Permissions come from the production authorization service. The guild owner
 * holds everything; a member holds exactly what a role grant made in
 * `grantGuild` says — and nothing when that is not the session's own guild.
 */
import { vi } from 'vitest';
import { createPlatformApiServer } from '../../src/api/server';
import type { ZodFastify } from '../../src/api/plugins/typeProvider';
import {
  PORTAL_CSRF_COOKIE,
  PORTAL_SESSION_COOKIE,
  type PortalSession,
  type PortalSessionService,
} from '../../src/api/portalSession';
import {
  createPortalAuthorizationService,
  type PortalPermission,
} from '../../src/modules/portalAuth/portalAuthService';
import { createGuildOwnershipService } from '../../src/modules/portalAuth/guildOwnershipService';
import { createGuildRoleService } from '../../src/modules/portalAuth/guildRoleService';
import type { AdminRoleGrantService } from '../../src/modules/portalAuth/adminRoleGrantService';
import type { LoadedContent } from '../../src/modules/content/schemas';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
  type ApiContextOverrides,
} from './platformApiFixtures';

export { TEST_TOKEN };

export const OWNER = '111111111111111111';
export const MEMBER = '222222222222222222';
export const GUILD = '333333333333333333';
export const OTHER_GUILD = '555555555555555555';
export const ROLE = '444444444444444444';
/** The player the member's session resolves to. */
export const MEMBER_PLAYER_ID = 7;

const CSRF = 'csrf-token';
const SESSION_TOKEN = 'session-token';

const PORTAL_CONFIG = {
  publicUrl: 'https://portal.example',
  forwardedProto: 'https' as const,
  discordClientId: 'client-id',
  discordClientSecret: 'client-secret',
  sessionSecret: 'x'.repeat(64),
  sessionTtlSeconds: 604800,
};

/** Cookie headers for the signed-in session. */
export const SESSION_COOKIES = {
  cookie: `${PORTAL_SESSION_COOKIE}=${SESSION_TOKEN}; ${PORTAL_CSRF_COOKIE}=${CSRF}`,
};

function session(discordUserId: string): PortalSession {
  return {
    sessionDigest: 'digest',
    discordUserId,
    discordUsername: 'Tester',
    discordAvatarUrl: null,
    selectedDiscordGuildId: GUILD,
    selectedGuildDbId: 3,
    playerId: MEMBER_PLAYER_ID,
    eligibleGuilds: [
      {
        discordGuildId: GUILD,
        guildDbId: 3,
        playerId: MEMBER_PLAYER_ID,
        name: 'Guild',
        iconUrl: null,
      },
    ],
    csrfToken: CSRF,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  };
}

function fakeSessions(s: PortalSession): PortalSessionService {
  return {
    getSession: vi.fn(async (token?: string) => (token === SESSION_TOKEN ? s : null)),
    toBrowserSession: vi.fn(() => ({ authenticated: true })),
    safeEquals: (a: string, b: string) => a === b,
  } as unknown as PortalSessionService;
}

/** A grant table holding one role's permissions, in `grantGuild` only. */
function grants(permissions: readonly PortalPermission[], grantGuild: string): AdminRoleGrantService {
  const row = {
    discordGuildId: grantGuild,
    roleId: ROLE,
    permissions: [...permissions],
    createdAt: new Date(0),
    createdBy: OWNER,
    updatedAt: new Date(0),
    updatedBy: OWNER,
  };
  return {
    list: async (guild) => (guild === grantGuild ? [row] : []),
    permissionsForRoles: async (guild, roleIds) =>
      guild === grantGuild && roleIds.includes(ROLE) ? [...permissions].sort() : [],
    upsert: async () => {
      throw new Error('not used');
    },
    update: async () => {
      throw new Error('not used');
    },
    remove: async () => false,
  };
}

export interface GalleryServerOptions {
  content: LoadedContent;
  assetsDir: string;
  /** Who is signed in: the guild owner, or a member holding `rolePermissions`. */
  as?: 'owner' | 'member';
  rolePermissions?: readonly PortalPermission[];
  /** The guild the role grant was made in. Defaults to the session's own. */
  grantGuild?: string;
  adminBearerAllowed?: boolean;
  /** Extra service stubs, e.g. a collection that says the player owns a species. */
  services?: ApiContextOverrides['services'];
}

export async function buildGalleryServer(opts: GalleryServerOptions): Promise<ZodFastify> {
  const authorization = createPortalAuthorizationService({
    guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => OWNER }),
    guildRoles: createGuildRoleService({
      fetchMemberRoleIds: async () => [ROLE],
      fetchGuildRoles: async () => null,
    }),
    roleGrants: grants(opts.rolePermissions ?? [], opts.grantGuild ?? GUILD),
  });
  return createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3140, token: TEST_TOKEN },
    portalAuth: {
      config: PORTAL_CONFIG,
      sessions: fakeSessions(session(opts.as === 'owner' ? OWNER : MEMBER)),
      authorization,
    },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: {
      ...createApiContext({
        content: opts.content,
        portalAuthorization: authorization,
        ...(opts.services ? { services: opts.services } : {}),
        ...(opts.adminBearerAllowed === undefined
          ? {}
          : { adminBearerAllowed: opts.adminBearerAllowed }),
      }),
      assetsDir: opts.assetsDir,
    },
  });
}
