/**
 * The artwork picker routes over real HTTP.
 *
 * Two consumers share `modules/assets/artworkBrowser.ts` but nothing else:
 *
 *   - `/admin/result-presentations/artwork/{browse,search}` — `presentations.read`,
 *     rooted at `results/`;
 *   - `/admin/encounters/artwork/{browse,search}` — `encounters.read`,
 *     rooted at `encounters/`.
 *
 * Pinned here: each sees only its own root, bad paths are 400 and gone folders
 * 404, payloads carry relative paths only, and neither permission opens the
 * other consumer's picker. The listing rules themselves are covered in
 * `tests/unit/artworkBrowser.test.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  createPortalAuthorizationService,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createGuildRoleService } from '../../../src/modules/portalAuth/guildRoleService';
import type { AdminRoleGrantService } from '../../../src/modules/portalAuth/adminRoleGrantService';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
} from '../../helpers/platformApiFixtures';

const PRESENTATIONS = '/api/v1/admin/result-presentations/artwork';
const ENCOUNTERS = '/api/v1/admin/encounters/artwork';

let tmp: string;
let assetsDir: string;

function write(rel: string, base = assetsDir) {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `bytes:${rel}`);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-art-routes-'));
  assetsDir = path.join(tmp, 'assets');
  write('results/hunt/waifubux/suspicious-purse-03.webp');
  write('results/hunt/waifubux/purse-01.webp');
  write('results/nothing1.webp');
  write('results/readme.md');
  write('results/.thumbnails/x.webp');
  write('encounters/wv_lost_cub.webp');
  write('encounters/tp_mountain_bandit.webp');
  write('waifumon/alpha/standard.webp');
  write('outside.png', tmp);
  fs.symlinkSync(tmp, path.join(assetsDir, 'results', 'escape'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ─────────────── Behaviour, through the operator bearer ─────────────── */

describe('picker routes', () => {
  let api: ZodFastify;

  beforeAll(async () => {
    const ctx = createApiContext({
      services: { worldEncounterAdmin: {}, resultPresentation: {} },
      adminBearerAllowed: true,
    });
    api = await createPlatformApiServer({
      config: { enabled: true, host: '127.0.0.1', port: 3161, token: TEST_TOKEN, adminBearer: true },
      logger: createCapturedLogger('silent').logger,
      probes: createProbes(),
      ctx: { ...ctx, assetsDir, portalAuthorization: { has: async () => false } as never },
    });
  });

  afterAll(async () => {
    await api?.close();
  });

  const get = (url: string) =>
    api.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  const browse = (base: string, p?: string) =>
    get(`${base}/browse${p === undefined ? '' : `?path=${encodeURIComponent(p)}`}`);
  const search = (base: string, q: string, extra = '') =>
    get(`${base}/search?q=${encodeURIComponent(q)}${extra}`);

  it('opens the presentation root with folders first, then images', async () => {
    const res = await browse(PRESENTATIONS);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      path: 'results',
      parent: null,
      breadcrumbs: [{ name: 'results', path: 'results' }],
      directories: [{ name: 'hunt', path: 'results/hunt' }],
      files: [{ name: 'nothing1.webp', path: 'results/nothing1.webp', folder: 'results', extension: 'webp' }],
    });
  });

  it('browses a child folder with its parent', async () => {
    const res = await browse(PRESENTATIONS, 'results/hunt/waifubux');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.parent).toBe('results/hunt');
    expect(data.files.map((f: { path: string }) => f.path)).toEqual([
      'results/hunt/waifubux/purse-01.webp',
      'results/hunt/waifubux/suspicious-purse-03.webp',
    ]);
  });

  it('opens the encounter root for the encounter picker', async () => {
    const res = await browse(ENCOUNTERS);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.files.map((f: { path: string }) => f.path)).toEqual([
      'encounters/tp_mountain_bandit.webp',
      'encounters/wv_lost_cub.webp',
    ]);
  });

  it.each([
    [PRESENTATIONS, 'encounters'],
    [PRESENTATIONS, 'waifumon/alpha'],
    [ENCOUNTERS, 'results'],
    [ENCOUNTERS, 'results/hunt'],
  ])('%s refuses to browse %s, another area’s folder', async (base, p) => {
    const res = await browse(base, p);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it.each(['../', '..%2f', 'results/../waifumon', '/etc', 'results\\hunt', 'results/.thumbnails'])(
    'refuses the unsafe folder %s with 400',
    async (p) => {
      const res = await get(`${PRESENTATIONS}/browse?path=${p === '..%2f' ? p : encodeURIComponent(p)}`);
      expect(res.statusCode).toBe(400);
    },
  );

  it('404s a folder that has gone, and one that is a symlink out of the tree', async () => {
    for (const p of ['results/gone', 'results/escape']) {
      const res = await browse(PRESENTATIONS, p);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
  });

  it('searches by name and by folder, case-insensitively, within the root only', async () => {
    const byName = (await search(PRESENTATIONS, 'PURSE')).json().data;
    expect(byName.results.map((r: { path: string }) => r.path)).toEqual([
      'results/hunt/waifubux/purse-01.webp',
      'results/hunt/waifubux/suspicious-purse-03.webp',
    ]);
    expect(byName.truncated).toBe(false);
    const byFolder = (await search(PRESENTATIONS, 'waifubux')).json().data;
    expect(byFolder.results).toHaveLength(2);
    expect((await search(PRESENTATIONS, 'bandit')).json().data.results).toEqual([]);
    expect((await search(ENCOUNTERS, 'bandit')).json().data.results).toHaveLength(1);
    expect((await search(ENCOUNTERS, 'purse')).json().data.results).toEqual([]);
    expect((await search(PRESENTATIONS, 'outside')).json().data.results).toEqual([]);
    expect((await search(PRESENTATIONS, 'readme')).json().data.results).toEqual([]);
  });

  it('honours a limit and reports truncation', async () => {
    const data = (await search(PRESENTATIONS, 'webp', '&limit=1')).json().data;
    expect(data.results).toHaveLength(1);
    expect(data.truncated).toBe(true);
    expect(data.limit).toBe(1);
  });

  it('refuses an empty or oversized search', async () => {
    expect((await get(`${PRESENTATIONS}/search?q=`)).statusCode).toBe(400);
    expect((await get(`${PRESENTATIONS}/search`)).statusCode).toBe(400);
    expect((await search(PRESENTATIONS, 'x'.repeat(101))).statusCode).toBe(400);
    expect((await search(PRESENTATIONS, 'purse', '&limit=100000')).statusCode).toBe(400);
  });

  it('never puts a filesystem path in a response', async () => {
    const bodies = await Promise.all([
      browse(PRESENTATIONS),
      browse(PRESENTATIONS, 'results/hunt'),
      browse(PRESENTATIONS, 'results/escape'),
      browse(PRESENTATIONS, '../'),
      search(PRESENTATIONS, 'purse'),
      browse(ENCOUNTERS),
    ]);
    for (const res of bodies) {
      expect(res.body).not.toContain(tmp);
      expect(res.body).not.toContain(assetsDir);
    }
  });

  it('a browsed path is exactly what the existing artwork route serves', async () => {
    const listed = (await browse(PRESENTATIONS, 'results/hunt/waifubux')).json().data.files[0].path;
    const bytes = await get(`${PRESENTATIONS}?path=${encodeURIComponent(listed)}`);
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/webp');
    expect(bytes.body).toBe(`bytes:${listed}`);
    const encounter = (await browse(ENCOUNTERS)).json().data.files[0].path;
    const encounterBytes = await get(`${ENCOUNTERS}?path=${encodeURIComponent(encounter)}`);
    expect(encounterBytes.statusCode).toBe(200);
  });
});

/* ─────────────── Authorization, through Portal sessions ─────────────── */

const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const GUILD = '333333333333333333';
const ROLE = '444444444444444444';
const CSRF = 'csrf-token';
const SESSION_TOKEN = 'session-token';

const COOKIES = {
  cookie: `${PORTAL_SESSION_COOKIE}=${SESSION_TOKEN}; ${PORTAL_CSRF_COOKIE}=${CSRF}`,
  [PORTAL_CSRF_HEADER]: CSRF,
};

function session(): PortalSession {
  return {
    sessionDigest: 'digest',
    discordUserId: MEMBER,
    discordUsername: 'Tester',
    discordAvatarUrl: null,
    selectedDiscordGuildId: GUILD,
    selectedGuildDbId: 3,
    playerId: 7,
    eligibleGuilds: [{ discordGuildId: GUILD, guildDbId: 3, playerId: 7, name: 'Guild', iconUrl: null }],
    csrfToken: CSRF,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  };
}

function grants(permissions: readonly PortalPermission[]): AdminRoleGrantService {
  return {
    list: async () => [],
    permissionsForRoles: async (_guild, roleIds) => (roleIds.includes(ROLE) ? [...permissions].sort() : []),
    upsert: async () => {
      throw new Error('not used');
    },
    update: async () => {
      throw new Error('not used');
    },
    remove: async () => false,
  };
}

describe('picker authorization', () => {
  let app: ZodFastify | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function build(permissions: readonly PortalPermission[]): Promise<ZodFastify> {
    const authorization = createPortalAuthorizationService({
      guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => OWNER }),
      guildRoles: createGuildRoleService({
        fetchMemberRoleIds: async () => [ROLE],
        fetchGuildRoles: async () => null,
      }),
      roleGrants: grants(permissions),
    });
    return createPlatformApiServer({
      config: { enabled: true, host: '127.0.0.1', port: 3162, token: TEST_TOKEN },
      portalAuth: {
        config: {
          publicUrl: 'https://portal.example',
          forwardedProto: 'https' as const,
          discordClientId: 'client-id',
          discordClientSecret: 'client-secret',
          sessionSecret: 'x'.repeat(64),
          sessionTtlSeconds: 604800,
        },
        sessions: {
          getSession: vi.fn(async (token?: string) => (token === SESSION_TOKEN ? session() : null)),
          toBrowserSession: vi.fn(() => ({ authenticated: true })),
          safeEquals: (a: string, b: string) => a === b,
        } as unknown as PortalSessionService,
        authorization,
      },
      logger: createCapturedLogger('silent').logger,
      probes: createProbes(),
      ctx: {
        ...createApiContext({
          services: { worldEncounterAdmin: {}, resultPresentation: {} },
          portalAuthorization: authorization,
        }),
        assetsDir,
      },
    });
  }

  const PRESENTATION_PICKER = [`${PRESENTATIONS}/browse`, `${PRESENTATIONS}/search?q=purse`];
  const ENCOUNTER_PICKER = [`${ENCOUNTERS}/browse`, `${ENCOUNTERS}/search?q=cub`];
  const call = (url: string) => app!.inject({ method: 'GET', url, headers: COOKIES });

  it('presentations.read opens the presentation picker and not the encounter picker', async () => {
    app = await build(['presentations.read']);
    for (const url of PRESENTATION_PICKER) expect((await call(url)).statusCode).toBe(200);
    for (const url of ENCOUNTER_PICKER) expect((await call(url)).statusCode).toBe(403);
  });

  it('presentations.write alone does not open the picker', async () => {
    app = await build(['presentations.write']);
    for (const url of PRESENTATION_PICKER) expect((await call(url)).statusCode).toBe(403);
  });

  it('encounters.read opens the encounter picker and not the presentation picker', async () => {
    app = await build(['encounters.read']);
    for (const url of ENCOUNTER_PICKER) expect((await call(url)).statusCode).toBe(200);
    for (const url of PRESENTATION_PICKER) expect((await call(url)).statusCode).toBe(403);
  });

  it('no permission opens neither, and refuses before validating the query', async () => {
    app = await build([]);
    for (const url of [...PRESENTATION_PICKER, ...ENCOUNTER_PICKER, `${PRESENTATIONS}/browse?path=../`]) {
      const res = await call(url);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    }
  });

  it('the shared API token is refused by default', async () => {
    app = await build([]);
    for (const url of [...PRESENTATION_PICKER, ...ENCOUNTER_PICKER]) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });
      expect(res.statusCode).toBe(403);
    }
  });
});
