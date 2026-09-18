/**
 * Result Presentation admin routes — the authorization boundary over real
 * HTTP (auth hook, CSRF, permission guard, handler), no database.
 *
 * Sessions get their permissions the production way: the guild owner is
 * unconditional, and everyone else holds exactly what their Discord roles are
 * granted. The service double throws on anything unstubbed, and the write
 * methods are spies, so "a refused request never reached the handler" is an
 * assertion.
 *
 * Pinned:
 *   - `presentations.read` opens list/get/reference/preview/artwork (bytes
 *     and the picker's browse/search) and nothing that writes;
 *   - `presentations.write` is required by every write, including
 *     enable/disable (there is no separate lifecycle route to forget);
 *   - no permission, the bearer token by default, and every `encounters.*`
 *     permission are refused everywhere here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  PORTAL_CSRF_COOKIE,
  PORTAL_CSRF_HEADER,
  PORTAL_SESSION_COOKIE,
  type PortalSession,
  type PortalSessionService,
} from '../../../src/api/portalSession';
import {
  ALL_PORTAL_PERMISSIONS,
  GRANTABLE_PORTAL_PERMISSIONS,
  PORTAL_PERMISSION_DESCRIPTIONS,
  ROLE_GRANT_PRESETS,
  createPortalAuthorizationService,
  presetForPermissions,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createGuildRoleService } from '../../../src/modules/portalAuth/guildRoleService';
import type { AdminRoleGrantService } from '../../../src/modules/portalAuth/adminRoleGrantService';
import type { ResultPresentationVariantRecord } from '../../../src/modules/resultPresentation/resultPresentationService';
import type { LoadedContent } from '../../../src/modules/content/schemas';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
} from '../../helpers/platformApiFixtures';

const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const GUILD = '333333333333333333';
const ROLE = '444444444444444444';
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

const VARIANT: ResultPresentationVariantRecord = {
  id: 9,
  presentationKey: 'hunt.waifubux_find',
  enabled: true,
  weight: 1,
  flavorText: 'Coins!',
  artworkMode: 'none',
  artworkPath: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function session(discordUserId: string): PortalSession {
  return {
    sessionDigest: 'digest',
    discordUserId,
    discordUsername: 'Tester',
    discordAvatarUrl: null,
    selectedDiscordGuildId: GUILD,
    selectedGuildDbId: 3,
    playerId: 7,
    eligibleGuilds: [
      { discordGuildId: GUILD, guildDbId: 3, playerId: 7, name: 'Guild', iconUrl: null },
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

function grants(permissions: readonly PortalPermission[]): AdminRoleGrantService {
  return {
    list: async () => [
      {
        discordGuildId: GUILD,
        roleId: ROLE,
        permissions: [...permissions],
        createdAt: new Date(0),
        createdBy: OWNER,
        updatedAt: new Date(0),
        updatedBy: OWNER,
      },
    ],
    permissionsForRoles: async (_guild, roleIds) =>
      roleIds.includes(ROLE) ? [...permissions].sort() : [],
    upsert: async () => {
      throw new Error('not used');
    },
    update: async () => {
      throw new Error('not used');
    },
    remove: async () => false,
  };
}

const CONTENT = {
  items: [{ slug: 'basic_charm', name: 'Basic Charm', emoji: '🩷' }],
  species: [],
  tables: { hunt: { flavor: ['Only the wind.'] } },
} as unknown as Partial<LoadedContent>;

interface Build {
  /** Who is signed in: the owner, or a member holding `rolePermissions`. */
  as?: 'owner' | 'member';
  rolePermissions?: readonly PortalPermission[];
  adminBearerAllowed?: boolean;
}

function buildWrites() {
  return {
    createVariant: vi.fn(async () => VARIANT),
    updateVariant: vi.fn(async () => VARIANT),
    deleteVariant: vi.fn(async () => true),
  };
}

let app: ZodFastify | undefined;
let writes = buildWrites();

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(opts: Build = {}): Promise<ZodFastify> {
  writes = buildWrites();
  const authorization = createPortalAuthorizationService({
    guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => OWNER }),
    guildRoles: createGuildRoleService({
      fetchMemberRoleIds: async () => [ROLE],
      fetchGuildRoles: async () => null,
    }),
    roleGrants: grants(opts.rolePermissions ?? []),
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
    ctx: createApiContext({
      content: CONTENT,
      services: {
        resultPresentation: {
          listVariants: async () => [VARIANT],
          getVariant: async (id: number) => (id === VARIANT.id ? VARIANT : null),
          ...writes,
        },
      },
      portalAuthorization: authorization,
      ...(opts.adminBearerAllowed === undefined ? {} : { adminBearerAllowed: opts.adminBearerAllowed }),
    }),
  });
}

const COOKIES = {
  cookie: `${PORTAL_SESSION_COOKIE}=${SESSION_TOKEN}; ${PORTAL_CSRF_COOKIE}=${CSRF}`,
  [PORTAL_CSRF_HEADER]: CSRF,
};

type Route = { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown };

const READ_ROUTES: Route[] = [
  { method: 'GET', url: '/api/v1/admin/result-presentations' },
  { method: 'GET', url: '/api/v1/admin/result-presentations/9' },
  { method: 'GET', url: '/api/v1/admin/result-presentations/reference' },
  { method: 'GET', url: '/api/v1/admin/result-presentations/artwork?path=placeholder.png' },
  { method: 'GET', url: '/api/v1/admin/result-presentations/artwork/browse' },
  { method: 'GET', url: '/api/v1/admin/result-presentations/artwork/search?q=find' },
  {
    method: 'POST',
    url: '/api/v1/admin/result-presentations/preview',
    payload: { variant: { presentationKey: 'hunt.waifubux_find', flavorText: 'Hi' } },
  },
];

const WRITE_ROUTES: Route[] = [
  {
    method: 'POST',
    url: '/api/v1/admin/result-presentations',
    payload: { presentationKey: 'hunt.waifubux_find', flavorText: 'New' },
  },
  { method: 'PATCH', url: '/api/v1/admin/result-presentations/9', payload: { enabled: false } },
  { method: 'PATCH', url: '/api/v1/admin/result-presentations/9', payload: { flavorText: 'Edit' } },
  { method: 'DELETE', url: '/api/v1/admin/result-presentations/9' },
];

const call = (route: Route, headers: Record<string, string> = COOKIES) =>
  app!.inject({
    method: route.method,
    url: route.url,
    headers,
    ...(route.payload === undefined ? {} : { payload: route.payload as object }),
  });

function expectNoWrites() {
  expect(writes.createVariant).not.toHaveBeenCalled();
  expect(writes.updateVariant).not.toHaveBeenCalled();
  expect(writes.deleteVariant).not.toHaveBeenCalled();
}

describe('permission vocabulary', () => {
  it('adds presentations.read and presentations.write, grantable, with descriptions', () => {
    expect(ALL_PORTAL_PERMISSIONS).toContain('presentations.read');
    expect(ALL_PORTAL_PERMISSIONS).toContain('presentations.write');
    expect(ALL_PORTAL_PERMISSIONS).not.toContain('presentations.publish');
    expect(GRANTABLE_PORTAL_PERMISSIONS).toContain('presentations.read');
    expect(GRANTABLE_PORTAL_PERMISSIONS).toContain('presentations.write');
    for (const p of ALL_PORTAL_PERMISSIONS) {
      expect(PORTAL_PERMISSION_DESCRIPTIONS[p]).toMatch(/\S/);
    }
  });

  it('offers a presentation editor preset that grants nothing about encounters', () => {
    expect([...ROLE_GRANT_PRESETS.presentation_editor].sort()).toEqual([
      'presentations.read',
      'presentations.write',
    ]);
    expect(presetForPermissions(['presentations.write', 'presentations.read'])).toBe(
      'presentation_editor',
    );
    for (const preset of [ROLE_GRANT_PRESETS.encounter_editor, ROLE_GRANT_PRESETS.encounter_publisher]) {
      expect(preset.some((p) => p.startsWith('presentations.'))).toBe(false);
    }
  });
});

describe('presentations.read', () => {
  it.each(READ_ROUTES)('allows $method $url', async (route) => {
    app = await build({ rolePermissions: ['presentations.read'] });
    const res = await call(route);
    expect(res.statusCode).toBe(200);
    expectNoWrites();
  });

  it.each(WRITE_ROUTES)('refuses $method $url with 403 and never writes', async (route) => {
    app = await build({ rolePermissions: ['presentations.read'] });
    const res = await call(route);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    expectNoWrites();
  });
});

describe('presentations.write', () => {
  it.each(WRITE_ROUTES)('allows $method $url', async (route) => {
    app = await build({ rolePermissions: ['presentations.read', 'presentations.write'] });
    const res = await call(route);
    expect(res.statusCode).toBe(200);
  });

  it('is what a write needs — write alone reaches the write handlers', async () => {
    app = await build({ rolePermissions: ['presentations.write'] });
    const res = await call(WRITE_ROUTES[1]!);
    expect(res.statusCode).toBe(200);
    expect(writes.updateVariant).toHaveBeenCalledWith(9, { enabled: false });
  });

  it('is not enough to read', async () => {
    app = await build({ rolePermissions: ['presentations.write'] });
    expect((await call(READ_ROUTES[0]!)).statusCode).toBe(403);
  });
});

describe('everyone else is refused', () => {
  const ALL_ROUTES = [...READ_ROUTES, ...WRITE_ROUTES];

  it.each(ALL_ROUTES)('no permission: $method $url → 403', async (route) => {
    app = await build({ rolePermissions: [] });
    expect((await call(route)).statusCode).toBe(403);
    expectNoWrites();
  });

  it.each(ALL_ROUTES)('every encounters.* permission: $method $url → 403', async (route) => {
    app = await build({
      rolePermissions: [
        'admin.access',
        'encounters.read',
        'encounters.write',
        'encounters.publish',
        'encounters.simulate',
        'encounters.history',
      ],
    });
    expect((await call(route)).statusCode).toBe(403);
    expectNoWrites();
  });

  it.each(ALL_ROUTES)('bearer token by default: $method $url → 403', async (route) => {
    app = await build();
    const res = await call(route, { authorization: `Bearer ${TEST_TOKEN}` });
    expect(res.statusCode).toBe(403);
    expectNoWrites();
  });

  it('refuses before validating, so the body shape is not disclosed', async () => {
    app = await build({ rolePermissions: ['presentations.read'] });
    const res = await call({
      method: 'POST',
      url: '/api/v1/admin/result-presentations',
      payload: { nonsense: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a write without the CSRF header is refused even with permission', async () => {
    app = await build({ rolePermissions: ['presentations.write'] });
    const res = await call(WRITE_ROUTES[0]!, {
      cookie: `${PORTAL_SESSION_COOKIE}=${SESSION_TOKEN}; ${PORTAL_CSRF_COOKIE}=${CSRF}`,
    });
    expect(res.statusCode).toBe(403);
    expectNoWrites();
  });
});

describe('the guild owner', () => {
  it.each([...READ_ROUTES, ...WRITE_ROUTES])('may $method $url', async (route) => {
    app = await build({ as: 'owner' });
    expect((await call(route)).statusCode).toBe(200);
  });
});

describe('the operator bearer opt-in', () => {
  it('passes when PLATFORM_API_ADMIN_BEARER is set', async () => {
    app = await build({ adminBearerAllowed: true });
    const res = await call(WRITE_ROUTES[3]!, { authorization: `Bearer ${TEST_TOKEN}` });
    expect(res.statusCode).toBe(200);
  });
});
