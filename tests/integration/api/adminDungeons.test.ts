/**
 * Portal admin — dungeon authoring over HTTP, against a real database. Pins
 * the contract the editor depends on: who may read, write and publish; the
 * draft's optimistic lock (409 `DUNGEON_DRAFT_STALE` with the current
 * revision); validation issues with stable codes; a publish that refuses an
 * invalid draft (400 `DUNGEON_INVALID`); immutable revisions and rollback;
 * the export package and its inspection; a sandbox that plays the real engine
 * and writes nothing; and the reference data, Delve settings, progression
 * currency and artwork picker routes beside them.
 *
 * Driven with the bearer token under `adminBearer: true`, like
 * `adminBosses.test.ts`; permissions are checked with role-holder sessions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { dungeonContentEvents, dungeonDefinitions, dungeonRevisions, dungeonRunEvents, dungeonRuns } from '../../../src/db/schema';
import { readDungeonPackage } from '../../../src/modules/dungeons/package/dungeonPackage';
import { randomUUID } from 'node:crypto';
import { DUNGEON_ISSUE_CODES } from '../../../src/modules/dungeons/validation/dungeonValidation';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import {
  createPortalAuthorizationService,
  type PortalAuthorizationService,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { CURRENCY, STARTER, TEST_ENEMIES, testDungeonInput } from '../../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../../helpers/dungeonWorld';
import { provisionPlayer } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555661';
const OWNER_ID = '777888999000111221';
const NON_OWNER_ID = '999999999999999661';
/** Role-holders who are not the owner, each with exactly the grants its name says. */
const READER_ID = '555000000000000011';
const WRITER_ID = '555000000000000012';
const PUBLISHER_ID = '555000000000000013';
const NON_OWNER_TOKEN = 'token-non-owner';
const READER_TOKEN = 'token-reader';
const WRITER_TOKEN = 'token-writer';
const PUBLISHER_TOKEN = 'token-publisher';
const CSRF = 'csrf-token';

let w: DungeonWorld;
let api: ZodFastify;
/** A small assets tree: one deployed dungeon image, and a file in another area's folder. */
const assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-admin-assets-'));
const assetsDir = path.join(assetsRoot, 'assets');
for (const [file, bytes] of [
  ['dungeons/zones/deployed.webp', 'webp-bytes'],
  ['dungeons/backgrounds/.keep', ''],
  ['results/secret.webp', 'not for this picker'],
] as const) {
  fs.mkdirSync(path.join(assetsDir, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, file), bytes);
}
fs.writeFileSync(path.join(assetsRoot, 'outside.webp'), 'outside the assets root');

beforeAll(async () => {
  w = await createDungeonWorld();
  await provisionPlayer(w.app, GUILD_ID, OWNER_ID);
  await provisionPlayer(w.app, GUILD_ID, NON_OWNER_ID);

  const guildOwnership = createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID });
  const ownerOnly = createPortalAuthorizationService({ guildOwnership });
  const granted: Record<string, PortalPermission[]> = {
    [READER_ID]: ['admin.access', 'dungeons.read'],
    [WRITER_ID]: ['admin.access', 'dungeons.read', 'dungeons.write'],
    [PUBLISHER_ID]: ['admin.access', 'dungeons.read', 'dungeons.publish'],
  };
  const portalAuthorization: PortalAuthorizationService = {
    ...ownerOnly,
    async computePermissionsFor(session) {
      const role = session ? granted[session.discordUserId] : undefined;
      if (!role) return ownerOnly.computePermissionsFor(session);
      return { ...(await ownerOnly.computePermissionsFor(session)), permissions: role };
    },
    async has(session, permission) {
      return (await this.computePermissionsFor(session)).permissions.includes(permission);
    },
  };
  const session = (discordUserId: string): PortalSession => ({
    sessionDigest: `digest-${discordUserId}`,
    discordUserId,
    discordUsername: null,
    discordAvatarUrl: null,
    selectedDiscordGuildId: GUILD_ID,
    selectedGuildDbId: 1,
    playerId: 1,
    eligibleGuilds: [],
    csrfToken: CSRF,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const tokens: Record<string, string> = {
    [NON_OWNER_TOKEN]: NON_OWNER_ID,
    [READER_TOKEN]: READER_ID,
    [WRITER_TOKEN]: WRITER_ID,
    [PUBLISHER_TOKEN]: PUBLISHER_ID,
  };
  const sessions = {
    getSession: async (token: string | undefined) => (token && tokens[token] ? session(tokens[token]!) : null),
    toBrowserSession: () => ({ authenticated: false }),
    safeEquals: (a: string, b: string) => a === b,
    logout: async () => {},
    selectGuild: async () => null,
    completeOAuth: async () => {
      throw new Error('not stubbed');
    },
    createOAuthState: async () => 'state',
    consumeOAuthState: async () => true,
  };

  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3135, token: TEST_TOKEN, adminBearer: true },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    portalAuth: {
      config: {
        publicUrl: 'http://localhost',
        forwardedProto: 'http',
        discordClientId: 'x',
        discordClientSecret: 'x',
        sessionSecret: 'x',
        sessionTtlSeconds: 3600,
      },
      sessions: sessions as unknown as PortalSessionService,
      authorization: portalAuthorization,
    },
    ctx: {
      assetsDir,
      services: {
        ...w.app,
        dungeonContent: w.content,
        dungeonRuns: w.runs,
        dungeonAllowance: w.allowance,
        progressionCurrency: w.currencies,
        enemies: w.enemies,
        artworkAssets: w.assets,
      },
      getContent: () => w.app.content,
      portalAuthorization,
      adminBearerAllowed: true,
    },
  });
});

afterAll(async () => {
  fs.rmSync(assetsRoot, { recursive: true, force: true });
  await api?.close();
  await w?.cleanup();
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Json = Record<string, any>;
interface Issue {
  code: string;
  path: string;
  severity: 'error' | 'warning';
  message: string;
}
interface Detail {
  key: string;
  name: string;
  enabled: boolean;
  roomCount: number;
  draftRevision: number;
  draftHash: string;
  published: { revisionId: number; number: number; contentHash: string; publishedAt: string; publishedBy: string | null } | null;
  draftDiffers: boolean;
  open: boolean;
  updatedBy: string | null;
  draft: Json;
  layout: Json;
  issues: Issue[];
}
interface Revision {
  revisionId: number;
  number: number;
  contentHash: string;
  source: string;
  draftRevision: number;
  publishedBy: string | null;
  current: boolean;
  activeRuns: number;
}
interface PublishResult {
  dungeon: Detail;
  revision: Revision;
  unchanged: boolean;
}
interface ErrorBody {
  error: { code: string; message: string; details?: { issues?: Issue[] } & Json };
}

const call = (method: Method, url: string, payload?: unknown) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    headers: AUTH_BEARER,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
/** The same request as a signed-in Portal user, CSRF header and all. */
const as = (token: string, method: Method, url: string, payload?: unknown) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    cookies: { wm_portal_session: token, wm_portal_csrf: CSRF },
    headers: { 'x-portal-csrf': CSRF },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const data = <T>(res: { json(): unknown }) => (res.json() as { data: T }).data;
const errorOf = (res: { json(): unknown }) => (res.json() as ErrorBody).error;
const errorCodes = (issues: readonly Issue[]) => issues.filter((i) => i.severity === 'error').map((i) => i.code);

describe('package import API', () => {
  it('requires write permission for planning and application before body parsing', async () => {
    for (const endpoint of ['plan', 'apply']) {
      expect((await as(READER_TOKEN, 'POST', `/admin/dungeons/import/${endpoint}`, { package: {} })).statusCode).toBe(403);
      expect((await as(PUBLISHER_TOKEN, 'POST', `/admin/dungeons/import/${endpoint}`, { package: {} })).statusCode).toBe(403);
      const unauthenticated = await api.inject({ method: 'POST', url: `/api/v1/admin/dungeons/import/${endpoint}`, headers: { 'content-type': 'application/json' }, payload: '{broken-json' });
      expect(unauthenticated.statusCode).toBe(401);
    }
  });
  it('plans, applies, retries and reads history using the authenticated administrator', async () => {
    await w.content.create({ definition: testDungeonInput('import_api_source') }, 'source');
    const pkg = await w.content.exportPackage('import_api_source', 'draft', 'source');
    const planResponse = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', { package: pkg });
    expect(planResponse.statusCode).toBe(200);
    const plan = data<Json>(planResponse);
    expect(plan.target.status).toBe('identical');
    const body = { package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash, expectedRevision: plan.target.expectedRevision, decisions: { dungeon: 'unchanged', enemies: {}, allowMissingDependencies: false } };
    const applied = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', body);
    expect(applied.statusCode).toBe(200);expect(data<Json>(applied).result).toBe('unchanged');
    const retry = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', body);expect(data<Json>(retry)).toMatchObject({ replayed: true, importId: data<Json>(applied).importId });
    const history = await as(READER_TOKEN, 'GET', '/admin/dungeons/definitions/import_api_source/import-history?limit=5');
    expect(history.statusCode).toBe(200);expect(data<Json>(history).imports[0]).toMatchObject({ packageId: pkg.packageId, actor: WRITER_ID, sourceEnvironment: 'test' });
    expect((await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', { ...body, expectedRevision: 100, requestId: randomUUID() })).statusCode).toBe(409);
  });
  it('returns actionable malformed-package issues and enforces payload limits', async () => {
    const plan = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', { package: {} });expect(plan.statusCode).toBe(200);expect(data<Json>(plan)).toMatchObject({ validPackage: false, issues: [{ code: 'package_format', severity: 'error', path: 'format' }] });
    const large = { package: 'x'.repeat(2 * 1024 * 1024 + 1) };
    expect((await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', large)).statusCode).toBe(413);
    expect((await as(READER_TOKEN, 'POST', '/admin/dungeons/import/plan', large)).statusCode).toBe(403);
  });
});
const base = (key: string) => `/admin/dungeons/definitions/${key}`;
const getDungeon = async (key: string) => data<Detail>(await call('GET', base(key)));
const getRevisions = async (key: string) => data<{ revisions: Revision[] }>(await call('GET', `${base(key)}/revisions`)).revisions;
const history = async (key: string) =>
  data<{ events: { action: string; actor: string | null; details: Json }[] }>(await call('GET', `${base(key)}/history`)).events;

/** The test dungeon under a new key and name. */
const definitionOf = (key: string, patch: (definition: Json) => void = () => {}): Json => {
  const definition = testDungeonInput(key) as Json;
  definition.name = `Dungeon ${key}`;
  patch(definition);
  return definition;
};
/** Create a dungeon through the API. */
async function create(key: string, patch?: (definition: Json) => void): Promise<Detail> {
  const res = await call('POST', '/admin/dungeons/definitions', { definition: definitionOf(key, patch) });
  expect(res.statusCode, res.body).toBe(201);
  return data<Detail>(res);
}
/** Save the draft with `patch` applied to what is stored, at its current revision. */
async function saveDraft(key: string, patch: (definition: Json) => void) {
  const current = await getDungeon(key);
  const definition = JSON.parse(JSON.stringify(current.draft)) as Json;
  patch(definition);
  return call('PUT', `${base(key)}/draft`, { definition, expectedRevision: current.draftRevision });
}
async function publish(key: string): Promise<PublishResult> {
  const current = await getDungeon(key);
  const res = await call('POST', `${base(key)}/publish`, { expectedRevision: current.draftRevision });
  expect(res.statusCode, res.body).toBe(200);
  return data<PublishResult>(res);
}
/** Name an enemy the catalogue does not have: a readable draft that cannot be published. */
const breakIt = (definition: Json) => {
  definition.rooms[0].actions[0].waves[0].enemy = { key: 'nobody_home' };
};
const rowCounts = async () => ({
  definitions: (await w.t.db.select({ id: dungeonDefinitions.dungeonKey }).from(dungeonDefinitions)).length,
  revisions: (await w.t.db.select({ id: dungeonRevisions.id }).from(dungeonRevisions)).length,
  events: (await w.t.db.select({ id: dungeonContentEvents.id }).from(dungeonContentEvents)).length,
  runs: (await w.t.db.select({ id: dungeonRuns.id }).from(dungeonRuns)).length,
  runEvents: (await w.t.db.select({ id: dungeonRunEvents.id }).from(dungeonRunEvents)).length,
});

/* ───────────────────────── permissions ───────────────────────── */

describe('permissions', () => {
  const KEY = 'perm_tunnels';
  const READS = (key: string) => [
    '/admin/dungeons/definitions',
    base(key),
    `${base(key)}/revisions`,
    `${base(key)}/history`,
    `${base(key)}/export`,
    '/admin/dungeons/reference',
    '/admin/dungeons/currencies',
    '/admin/dungeons/settings',
    '/admin/dungeons/artwork/browse',
    '/admin/dungeons/artwork/search?q=x',
    '/admin/dungeons/artwork?path=dungeons/zones/deployed.webp',
  ];
  /** Dry runs: they take a body but write nothing, and need only `dungeons.read`. */
  const DRY_RUNS = (key: string): [Method, string, unknown][] => [
    ['POST', '/admin/dungeons/validate', { definition: definitionOf('perm_dry') }],
    ['POST', '/admin/dungeons/package/inspect', { package: {} }],
    ['POST', '/admin/dungeons/sandbox', { key }],
  ];
  const WRITES = (key: string): [Method, string, unknown][] => [
    ['POST', '/admin/dungeons/definitions', { definition: definitionOf('perm_sneaky') }],
    ['PUT', `${base(key)}/draft`, { definition: definitionOf(key), expectedRevision: 1 }],
    ['PUT', `${base(key)}/enabled`, { enabled: false }],
    ['PUT', `/admin/dungeons/currencies/${CURRENCY}`, { singularName: 'X', pluralName: 'Xs', enabled: true, expectedRevision: 1 }],
    ['PUT', '/admin/dungeons/settings', { dailyRunLimit: 9 }],
  ];
  const PUBLISHES = (key: string): [Method, string, unknown][] => [
    ['POST', `${base(key)}/publish`, { expectedRevision: 1 }],
    ['POST', `${base(key)}/rollback`, { revision: 1 }],
  ];

  beforeAll(async () => {
    await create(KEY);
  });

  it('refuses a caller with no session, on reads, writes and publishes alike', async () => {
    for (const url of READS(KEY)) {
      expect((await api.inject({ method: 'GET', url: `/api/v1${url}` })).statusCode, url).toBe(401);
    }
    for (const [method, url, payload] of [...DRY_RUNS(KEY), ...WRITES(KEY), ...PUBLISHES(KEY)]) {
      const res = await api.inject({ method, url: `/api/v1${url}`, payload: payload as Record<string, unknown> });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('refuses a signed-in player with no dungeon permission, and changes nothing', async () => {
    const before = await getDungeon(KEY);
    const counts = await rowCounts();
    for (const url of READS(KEY)) {
      const res = await as(NON_OWNER_TOKEN, 'GET', url);
      expect(res.statusCode, url).toBe(403);
      expect(errorOf(res).code, url).toBe('PORTAL_PERMISSION_DENIED');
    }
    for (const [method, url, payload] of [...DRY_RUNS(KEY), ...WRITES(KEY), ...PUBLISHES(KEY)]) {
      const res = await as(NON_OWNER_TOKEN, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(errorOf(res).code, `${method} ${url}`).toBe('PORTAL_PERMISSION_DENIED');
    }
    expect(await getDungeon(KEY)).toEqual(before);
    expect(await rowCounts()).toEqual(counts);
    expect((await call('GET', base('perm_sneaky'))).statusCode).toBe(404);
  });

  it('dungeons.read reads and dry-runs, and can neither write nor publish', async () => {
    const before = await getDungeon(KEY);
    for (const url of READS(KEY)) {
      expect((await as(READER_TOKEN, 'GET', url)).statusCode, url).toBe(200);
    }
    for (const [method, url, payload] of DRY_RUNS(KEY)) {
      const res = await as(READER_TOKEN, method, url, payload);
      expect(res.statusCode, `${method} ${url} ${res.body}`).toBe(200);
    }
    for (const [method, url, payload] of [...WRITES(KEY), ...PUBLISHES(KEY)]) {
      const res = await as(READER_TOKEN, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(errorOf(res).code, `${method} ${url}`).toBe('PORTAL_PERMISSION_DENIED');
    }
    // Only the reader's own export left a trace; the dungeon is as it was.
    const after = await getDungeon(KEY);
    expect({ ...after, issues: [] }).toMatchObject({ draftRevision: before.draftRevision, draftHash: before.draftHash, published: null, enabled: true });
    expect((await call('GET', base('perm_sneaky'))).statusCode).toBe(404);
  });

  it('dungeons.write authors a draft, and gets 403 on publish and on rollback', async () => {
    const created = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/definitions', { definition: definitionOf('perm_written') });
    expect(created.statusCode, created.body).toBe(201);
    expect(data<Detail>(created)).toMatchObject({ key: 'perm_written', draftRevision: 1, updatedBy: WRITER_ID, published: null });
    const saved = await as(WRITER_TOKEN, 'PUT', `${base('perm_written')}/draft`, {
      definition: definitionOf('perm_written', (d) => {
        d.description = 'Written by a writer.';
      }),
      expectedRevision: 1,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(data<Detail>(saved)).toMatchObject({ draftRevision: 2, updatedBy: WRITER_ID });
    expect((await as(WRITER_TOKEN, 'PUT', `${base('perm_written')}/enabled`, { enabled: true })).statusCode).toBe(200);

    // The two acts that change what players get are a separate grant.
    const refusedPublish = await as(WRITER_TOKEN, 'POST', `${base('perm_written')}/publish`, { expectedRevision: 2 });
    expect(refusedPublish.statusCode).toBe(403);
    expect(errorOf(refusedPublish).code).toBe('PORTAL_PERMISSION_DENIED');
    expect(await getDungeon('perm_written')).toMatchObject({ published: null, open: false, draftRevision: 2 });
    expect(await getRevisions('perm_written')).toEqual([]);

    // …also once there is something to roll back to.
    await publish('perm_written');
    await saveDraft('perm_written', (d) => {
      d.description = 'A second revision.';
    });
    await publish('perm_written');
    const refusedRollback = await as(WRITER_TOKEN, 'POST', `${base('perm_written')}/rollback`, { revision: 1 });
    expect(refusedRollback.statusCode).toBe(403);
    expect(errorOf(refusedRollback).code).toBe('PORTAL_PERMISSION_DENIED');
    const stillSecond = await as(WRITER_TOKEN, 'POST', `${base('perm_written')}/publish`, { expectedRevision: 3 });
    expect(stillSecond.statusCode).toBe(403);
    expect((await getRevisions('perm_written')).map((r) => [r.number, r.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect((await history('perm_written')).map((e) => e.action)).not.toContain('rolled_back');
  });

  it('dungeons.publish publishes and rolls back under its own name, and cannot edit', async () => {
    await create('perm_published');
    const published = await as(PUBLISHER_TOKEN, 'POST', `${base('perm_published')}/publish`, { expectedRevision: 1 });
    expect(published.statusCode, published.body).toBe(200);
    expect(data<PublishResult>(published)).toMatchObject({ unchanged: false, revision: { number: 1, current: true, publishedBy: PUBLISHER_ID } });
    await saveDraft('perm_published', (d) => {
      d.description = 'Edited by the bearer.';
    });
    expect((await as(PUBLISHER_TOKEN, 'POST', `${base('perm_published')}/publish`, { expectedRevision: 2 })).statusCode).toBe(200);
    const rolled = await as(PUBLISHER_TOKEN, 'POST', `${base('perm_published')}/rollback`, { revision: 1 });
    expect(rolled.statusCode, rolled.body).toBe(200);
    expect(data<PublishResult>(rolled).revision).toMatchObject({ number: 1, current: true });
    // The actor is the session's, never the body's.
    const acts = (await history('perm_published')).filter((e) => e.action === 'published' || e.action === 'rolled_back');
    expect(acts.map((e) => e.actor)).toEqual([PUBLISHER_ID, PUBLISHER_ID, PUBLISHER_ID]);

    for (const [method, url, payload] of WRITES('perm_published')) {
      const res = await as(PUBLISHER_TOKEN, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await getDungeon('perm_published')).draftRevision).toBe(2);
  });
});

/* ───────────────────────── drafts ───────────────────────── */

describe('create, get and save a draft', () => {
  const KEY = 'draft_tunnels';

  it('creates a dungeon as an unpublished draft, and lists it', async () => {
    const created = await create(KEY);
    expect(created).toMatchObject({
      key: KEY,
      name: `Dungeon ${KEY}`,
      enabled: true,
      roomCount: 5,
      draftRevision: 1,
      published: null,
      draftDiffers: true,
      // Nothing is published: players cannot start a run yet.
      open: false,
      updatedBy: null,
    });
    expect(created.draftHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(errorCodes(created.issues)).toEqual([]);
    // Defaults are applied: the stored draft is the whole document.
    expect(created.draft).toMatchObject({ key: KEY, entranceRoomId: 'gate', artwork: null, background: null });
    expect(created.draft.rooms.map((r: Json) => r.id)).toEqual(['gate', 'pump_room', 'locker_room', 'bulkhead', 'den']);

    const listed = data<{ dungeons: Json[] }>(await call('GET', '/admin/dungeons/definitions')).dungeons.find((d) => d.key === KEY)!;
    expect(listed).toMatchObject({ key: KEY, name: `Dungeon ${KEY}`, roomCount: 5, draftRevision: 1, draftHash: created.draftHash, published: null, open: false });
    expect(listed.draft).toBeUndefined();
    expect((await history(KEY)).map((e) => e.action)).toEqual(['created']);
  });

  it('gets it back whole, and 404s an unknown key', async () => {
    const got = await call('GET', base(KEY));
    expect(got.statusCode).toBe(200);
    expect(data<Detail>(got)).toMatchObject({ key: KEY, draftRevision: 1, published: null });
    expect(data<Detail>(got).draft).toEqual((await getDungeon(KEY)).draft);
    const missing = await call('GET', base('no_such_dungeon'));
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('DUNGEON_NOT_FOUND');
    expect((await call('GET', `${base('no_such_dungeon')}/revisions`)).statusCode).toBe(404);
  });

  it('refuses a taken key, a reserved key and an unreadable definition', async () => {
    const taken = await call('POST', '/admin/dungeons/definitions', { definition: definitionOf(KEY) });
    expect(taken.statusCode).toBe(409);
    expect(errorOf(taken).code).toBe('DUNGEON_KEY_TAKEN');
    for (const definition of [definitionOf('definitions'), definitionOf('Bad Key'), { key: 'no_rooms' }, 'not an object']) {
      const res = await call('POST', '/admin/dungeons/definitions', { definition });
      expect(res.statusCode, JSON.stringify(definition).slice(0, 60)).toBe(400);
      expect(errorOf(res).code).toBe('DUNGEON_INVALID');
      expect(errorOf(res).details!.issues!.length).toBeGreaterThan(0);
    }
    expect((await call('GET', base('no_rooms'))).statusCode).toBe(404);
    expect((await getDungeon(KEY)).draftRevision).toBe(1);
  });

  it('saves the draft at the revision it loaded, and bumps it', async () => {
    const before = await getDungeon(KEY);
    const saved = await saveDraft(KEY, (d) => {
      d.description = 'Now with a description.';
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = data<Detail>(saved);
    expect(after).toMatchObject({ draftRevision: 2, published: null, open: false });
    expect(after.draft.description).toBe('Now with a description.');
    expect(after.draftHash).not.toBe(before.draftHash);
    expect((await history(KEY)).map((e) => e.action)).toEqual(['draft_saved', 'created']);
  });

  it('refuses a save with a stale expectedRevision — 409 DUNGEON_DRAFT_STALE with the current one — and writes nothing', async () => {
    const before = await getDungeon(KEY);
    expect(before.draftRevision).toBe(2);
    const stale = await call('PUT', `${base(KEY)}/draft`, {
      definition: definitionOf(KEY, (d) => {
        d.description = 'From an editor that loaded revision 1.';
      }),
      expectedRevision: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale)).toMatchObject({
      code: 'DUNGEON_DRAFT_STALE',
      details: { expectedRevision: 1, currentRevision: 2, updatedBy: null },
    });
    expect(errorOf(stale).details!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // A revision from the future is just as stale.
    const ahead = await call('PUT', `${base(KEY)}/draft`, { definition: before.draft, expectedRevision: 9 });
    expect(ahead.statusCode).toBe(409);
    expect(errorOf(ahead).details).toMatchObject({ expectedRevision: 9, currentRevision: 2 });

    expect(await getDungeon(KEY)).toEqual(before);
    expect((await history(KEY)).map((e) => e.action)).toEqual(['draft_saved', 'created']);
    // The loser reloads, and its save goes through at the revision it was told.
    const retried = await call('PUT', `${base(KEY)}/draft`, {
      definition: { ...before.draft, description: 'Reloaded, then saved.' },
      expectedRevision: errorOf(stale).details!.currentRevision,
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(data<Detail>(retried).draftRevision).toBe(3);
  });

  it('a draft may be saved with validation errors — but not with an unreadable shape or another key', async () => {
    const broken = await saveDraft(KEY, breakIt);
    expect(broken.statusCode, broken.body).toBe(200);
    expect(data<Detail>(broken).issues).toContainEqual(
      expect.objectContaining({ code: 'enemy_missing', severity: 'error', path: 'rooms[0].actions[0].waves[0].enemy' }),
    );
    const current = await getDungeon(KEY);
    const unreadable = await call('PUT', `${base(KEY)}/draft`, { definition: { ...current.draft, rooms: 'none' }, expectedRevision: current.draftRevision });
    expect(unreadable.statusCode).toBe(400);
    expect(errorOf(unreadable).code).toBe('DUNGEON_INVALID');
    expect(errorOf(unreadable).details!.issues).toContainEqual(expect.objectContaining({ code: 'schema', severity: 'error' }));
    const renamed = await call('PUT', `${base(KEY)}/draft`, { definition: { ...current.draft, key: 'another_key' }, expectedRevision: current.draftRevision });
    expect(renamed.statusCode).toBe(400);
    expect((await call('GET', base('another_key'))).statusCode).toBe(404);
    expect((await call('PUT', `${base('no_such_dungeon')}/draft`, { definition: current.draft, expectedRevision: 1 })).statusCode).toBe(404);
    expect(await getDungeon(KEY)).toEqual(current);
  });

  it('enables and disables without touching the draft; there is no delete', async () => {
    const before = await getDungeon(KEY);
    const off = await call('PUT', `${base(KEY)}/enabled`, { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(data<Detail>(off)).toMatchObject({ enabled: false, open: false, draftHash: before.draftHash });
    expect(data<Detail>(await call('PUT', `${base(KEY)}/enabled`, { enabled: true }))).toMatchObject({ enabled: true });
    expect((await call('PUT', `${base('no_such_dungeon')}/enabled`, { enabled: true })).statusCode).toBe(404);
    expect((await call('DELETE', base(KEY))).statusCode).toBe(404);
    expect((await call('GET', base(KEY))).statusCode).toBe(200);
  });
});

/* ───────────────────────── validation ───────────────────────── */

describe('validate', () => {
  const validate = async (definition: unknown) => {
    const res = await call('POST', '/admin/dungeons/validate', { definition });
    expect(res.statusCode, res.body).toBe(200);
    return data<{ definition: Json | null; contentHash: string | null; issues: Issue[]; publishable: boolean }>(res);
  };

  it('passes a sound definition, with the hash a save of it would get, and writes nothing', async () => {
    const counts = await rowCounts();
    const report = await validate(definitionOf('val_sound'));
    expect(errorCodes(report.issues)).toEqual([]);
    expect(report.publishable).toBe(true);
    expect(report.definition).toMatchObject({ key: 'val_sound', entranceRoomId: 'gate' });
    expect(report.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await rowCounts()).toEqual(counts);
    expect((await call('GET', base('val_sound'))).statusCode).toBe(404);
    // The same definition, saved, has that hash.
    expect((await create('val_sound')).draftHash).toBe(report.contentHash);
  });

  it('reports every problem with a stable code and a path', async () => {
    const report = await validate(
      definitionOf('val_broken', (d) => {
        // An enemy the catalogue lacks, twice over in one pool; a connection to nowhere;
        // a currency and a region this server does not have; a flag nobody declared.
        d.rooms[0].actions[0].waves[0].enemy = { key: 'nobody_home' };
        d.rooms[0].actions[0].waves[1].enemy = { pool: [{ key: 'grunt', weight: 1 }, { key: 'grunt', weight: 2 }] };
        d.connections.push({ id: 'c_nowhere', from: 'gate', to: 'the_void' });
        d.settings.progressionCurrency = 'doubloons';
        d.availableRegions = ['atlantis'];
        d.rooms[1].actions[2].flag = 'undeclared_flag';
      }),
    );
    expect(report.publishable).toBe(false);
    expect(report.definition).not.toBeNull();
    const found = report.issues.map((i) => [i.code, i.severity, i.path]);
    expect(found).toEqual(
      expect.arrayContaining([
        ['enemy_missing', 'error', 'rooms[0].actions[0].waves[0].enemy'],
        ['enemy_pool_duplicate', 'error', 'rooms[0].actions[0].waves[1].enemy.pool'],
        ['connection_unknown_room', 'error', expect.stringContaining('connections[7]')],
        ['currency_missing', 'error', 'settings.progressionCurrency'],
        ['region_missing', 'error', 'availableRegions[0]'],
        ['flag_undeclared', 'error', expect.stringContaining('rooms[1].actions[2]')],
      ]),
    );
    // Every code is one of the published, stable ones, and every issue says something.
    for (const issue of report.issues) {
      expect(DUNGEON_ISSUE_CODES as readonly string[], issue.code).toContain(issue.code);
      expect(issue.message.length, issue.code).toBeGreaterThan(0);
      expect(['error', 'warning']).toContain(issue.severity);
    }
    // The same definition, asked again, gives the same answer.
    const again = await validate(
      definitionOf('val_broken', (d) => {
        d.rooms[0].actions[0].waves[0].enemy = { key: 'nobody_home' };
        d.rooms[0].actions[0].waves[1].enemy = { pool: [{ key: 'grunt', weight: 1 }, { key: 'grunt', weight: 2 }] };
        d.connections.push({ id: 'c_nowhere', from: 'gate', to: 'the_void' });
        d.settings.progressionCurrency = 'doubloons';
        d.availableRegions = ['atlantis'];
        d.rooms[1].actions[2].flag = 'undeclared_flag';
      }),
    );
    expect(again.issues).toEqual(report.issues);
  });

  it('answers an unreadable shape with `schema` issues and no definition — never a 500', async () => {
    for (const definition of [{ key: 'val_shapeless' }, { ...definitionOf('val_shapeless'), rooms: [{ id: 'gate', actions: [{ id: 'x', type: 'teleport' }] }] }, 42, null]) {
      const report = await validate(definition);
      expect(report.publishable).toBe(false);
      expect(report.issues.length).toBeGreaterThan(0);
      for (const issue of report.issues) expect(DUNGEON_ISSUE_CODES as readonly string[], issue.code).toContain(issue.code);
      expect(errorCodes(report.issues).length).toBeGreaterThan(0);
    }
    expect((await validate({ key: 'val_shapeless' })).definition).toBeNull();
    expect((await validate({ key: 'val_shapeless' })).contentHash).toBeNull();
    expect((await call('POST', '/admin/dungeons/validate', {})).statusCode).toBe(200);
  });
});

/* ───────────────────────── publish, revisions, rollback ───────────────────────── */

describe('publish, revisions and rollback', () => {
  const KEY = 'pub_tunnels';
  let firstHash: string;
  let secondHash: string;

  it('refuses to publish an invalid draft — 400 DUNGEON_INVALID with the issues — and publishes nothing', async () => {
    await create(KEY, breakIt);
    const current = await getDungeon(KEY);
    expect(errorCodes(current.issues)).toEqual(['enemy_missing']);

    const refused = await call('POST', `${base(KEY)}/publish`, { expectedRevision: current.draftRevision });
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused).code).toBe('DUNGEON_INVALID');
    expect(errorOf(refused).details!.issues).toContainEqual({
      code: 'enemy_missing',
      severity: 'error',
      path: 'rooms[0].actions[0].waves[0].enemy',
      message: expect.stringContaining('"nobody_home"'),
    });
    expect(await getDungeon(KEY)).toMatchObject({ published: null, open: false, draftRevision: current.draftRevision });
    expect(await getRevisions(KEY)).toEqual([]);
    expect((await history(KEY)).map((e) => e.action)).not.toContain('published');
    // Players are not offered it.
    const { playerId } = await w.player();
    expect((await w.runs.home(playerId)).dungeons.map((d) => d.key)).not.toContain(KEY);
  });

  it('publishes the repaired draft as revision 1, and lists it', async () => {
    const repaired = await saveDraft(KEY, (d) => {
      d.rooms[0].actions[0].waves[0].enemy = { key: 'grunt' };
    });
    expect(errorCodes(data<Detail>(repaired).issues)).toEqual([]);
    const draft = data<Detail>(repaired);

    // A publish names the draft revision that was reviewed.
    const stale = await call('POST', `${base(KEY)}/publish`, { expectedRevision: draft.draftRevision - 1 });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale)).toMatchObject({ code: 'DUNGEON_DRAFT_STALE', details: { currentRevision: draft.draftRevision } });
    expect(await getRevisions(KEY)).toEqual([]);

    const result = await publish(KEY);
    expect(result.unchanged).toBe(false);
    expect(result.revision).toMatchObject({ number: 1, current: true, contentHash: draft.draftHash, draftRevision: draft.draftRevision, activeRuns: 0 });
    expect(result.dungeon).toMatchObject({ open: true, draftDiffers: false, published: { number: 1, contentHash: draft.draftHash } });
    firstHash = draft.draftHash;

    expect(await getRevisions(KEY)).toEqual([expect.objectContaining({ number: 1, current: true, contentHash: firstHash })]);
    const one = data<Revision & { content: Json; layout: Json }>(await call('GET', `${base(KEY)}/revisions/1`));
    expect(one).toMatchObject({ number: 1, current: true, contentHash: firstHash });
    expect(one.content).toEqual(draft.draft);
    expect((await call('GET', `${base(KEY)}/revisions/2`)).statusCode).toBe(404);
    expect(errorOf(await call('GET', `${base(KEY)}/revisions/2`)).code).toBe('DUNGEON_REVISION_NOT_FOUND');
    // Now players are offered it.
    const { playerId } = await w.player();
    expect((await w.runs.home(playerId)).dungeons.map((d) => d.key)).toContain(KEY);
  });

  it('publishing what is already published writes no new revision', async () => {
    const again = await publish(KEY);
    expect(again).toMatchObject({ unchanged: true, revision: { number: 1, current: true } });
    expect((await getRevisions(KEY)).map((r) => r.number)).toEqual([1]);
  });

  it('a save does not publish; a second publish after a draft change is revision 2', async () => {
    const saved = await saveDraft(KEY, (d) => {
      d.description = 'The second cut.';
      d.rooms[0].actions[1].reward.currency = { min: 4, max: 4 };
    });
    expect(saved.statusCode, saved.body).toBe(200);
    // Saved, not published: players still get revision 1.
    expect(data<Detail>(saved)).toMatchObject({ draftDiffers: true, open: true, published: { number: 1, contentHash: firstHash } });
    expect((await getRevisions(KEY)).map((r) => [r.number, r.current])).toEqual([[1, true]]);

    const result = await publish(KEY);
    secondHash = result.revision.contentHash;
    expect(result).toMatchObject({ unchanged: false, revision: { number: 2, current: true }, dungeon: { draftDiffers: false, published: { number: 2 } } });
    expect(secondHash).not.toBe(firstHash);
    // Newest first; exactly one is current; revision 1 is unchanged.
    expect((await getRevisions(KEY)).map((r) => [r.number, r.current, r.contentHash])).toEqual([
      [2, true, secondHash],
      [1, false, firstHash],
    ]);
    const one = data<{ content: Json }>(await call('GET', `${base(KEY)}/revisions/1`));
    expect(one.content.description).toBe('For tests.');
    expect(one.content.rooms[0].actions[1].reward.currency).toEqual({ min: 2, max: 2 });
    expect(data<{ content: Json }>(await call('GET', `${base(KEY)}/revisions/2`)).content.description).toBe('The second cut.');
  });

  it('rollback makes revision 1 current again, copies nothing, and leaves the draft alone', async () => {
    const before = await getDungeon(KEY);
    const rolled = await call('POST', `${base(KEY)}/rollback`, { revision: 1 });
    expect(rolled.statusCode, rolled.body).toBe(200);
    expect(data<PublishResult>(rolled)).toMatchObject({ unchanged: false, revision: { number: 1, current: true, contentHash: firstHash } });

    expect((await getRevisions(KEY)).map((r) => [r.number, r.current, r.contentHash])).toEqual([
      [2, false, secondHash],
      [1, true, firstHash],
    ]);
    const after = await getDungeon(KEY);
    expect(after).toMatchObject({ published: { number: 1, contentHash: firstHash }, open: true, draftDiffers: true });
    // The draft is still the second cut, at the same revision and hash.
    expect(after.draft).toEqual(before.draft);
    expect(after).toMatchObject({ draftRevision: before.draftRevision, draftHash: before.draftHash });

    // New runs start on revision 1: the gate pays 2 again, not 4.
    const { playerId } = await w.player();
    const run = await w.runs.start(playerId, KEY);
    expect(run.dungeon).toMatchObject({ key: KEY, revision: 1, description: 'For tests.' });
    expect((await getRevisions(KEY)).map((r) => [r.number, r.activeRuns])).toEqual([
      [2, 0],
      [1, 1],
    ]);
    await w.runs.act(playerId, run.id, { type: 'abandon' });

    expect((await history(KEY)).map((e) => e.action).slice(0, 3)).toEqual(['rolled_back', 'published', 'draft_saved']);
  });

  it('rolling back to the current revision changes nothing; an unknown one is 404', async () => {
    const same = await call('POST', `${base(KEY)}/rollback`, { revision: 1 });
    expect(same.statusCode, same.body).toBe(200);
    expect(data<PublishResult>(same)).toMatchObject({ unchanged: true, revision: { number: 1, current: true } });
    const missing = await call('POST', `${base(KEY)}/rollback`, { revision: 7 });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe('DUNGEON_REVISION_NOT_FOUND');
    expect((await call('POST', `${base('no_such_dungeon')}/rollback`, { revision: 1 })).statusCode).toBe(404);
    expect((await call('POST', `${base(KEY)}/rollback`, { revision: 0 })).statusCode).toBe(400);
    expect((await getRevisions(KEY)).map((r) => [r.number, r.current])).toEqual([
      [2, false],
      [1, true],
    ]);
  });
});

/* ───────────────────────── export and inspection ───────────────────────── */

describe('export and package inspection', () => {
  const KEY = 'pkg_tunnels';
  const inspect = async (pkg: unknown) => {
    const res = await call('POST', '/admin/dungeons/package/inspect', { package: pkg });
    expect(res.statusCode, res.body).toBe(200);
    return data<{ ok: boolean; issues: Issue[]; summary: Json | null }>(res);
  };

  beforeAll(async () => {
    await create(KEY);
    await publish(KEY);
    await saveDraft(KEY, (d) => {
      d.description = 'A draft ahead of what is published.';
    });
  });

  it('exports the draft as a package `readDungeonPackage` accepts, hashed like the draft', async () => {
    const detail = await getDungeon(KEY);
    const res = await call('GET', `${base(KEY)}/export`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[^"]*pkg_tunnels[^"]*\.json"$/);
    const pkg = data<Json>(res);

    const read = readDungeonPackage(pkg);
    expect(read.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(read.ok).toBe(true);
    expect(read.package).not.toBeNull();
    expect(pkg.contentHash).toBe(detail.draftHash);
    expect(read.package!.contentHash).toBe(detail.draftHash);
    expect(pkg.dungeon).toEqual(detail.draft);
    expect(pkg.source).toMatchObject({ dungeonKey: KEY });
    // The manifest names what the dungeon needs from a server.
    expect(pkg.dependencies.enemies.map((e: Json) => e.key).sort()).toEqual(['grunt', 'overlord', 'sentinel', 'warden']);
    expect(pkg.dependencies.currencies).toEqual([CURRENCY]);
    expect(pkg.dependencies.regions).toEqual(['waifu-valley']);
    // The file is what a text round trip gives back, too.
    expect(readDungeonPackage(JSON.stringify(pkg)).ok).toBe(true);
    expect((await history(KEY))[0]).toMatchObject({ action: 'exported' });
  });

  it('exports the published revision, or a numbered one, with that revision’s hash', async () => {
    const detail = await getDungeon(KEY);
    expect(detail.draftDiffers).toBe(true);
    const published = data<Json>(await call('GET', `${base(KEY)}/export?origin=published`));
    expect(published.contentHash).toBe(detail.published!.contentHash);
    expect(published.contentHash).not.toBe(detail.draftHash);
    expect(published.dungeon.description).toBe('For tests.');
    expect(readDungeonPackage(published).ok).toBe(true);
    const numbered = data<Json>(await call('GET', `${base(KEY)}/export?revision=1`));
    expect(numbered.contentHash).toBe(detail.published!.contentHash);
    expect(numbered.dungeon).toEqual(published.dungeon);

    expect((await call('GET', `${base(KEY)}/export?origin=published&revision=1`)).statusCode).toBe(400);
    expect((await call('GET', `${base(KEY)}/export?revision=9`)).statusCode).toBe(404);
    expect((await call('GET', `${base('no_such_dungeon')}/export`)).statusCode).toBe(404);
  });

  it('package/inspect accepts that export, and reports a tampered copy as package_hash_mismatch', async () => {
    const pkg = data<Json>(await call('GET', `${base(KEY)}/export`));
    const counts = await rowCounts();

    const sound = await inspect(pkg);
    expect(sound.ok).toBe(true);
    expect(sound.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(sound.summary).toMatchObject({ dungeonKey: KEY, contentHash: pkg.contentHash, schemaVersion: 1, rooms: 5 });

    // Edited after export: the reward doubled, the hash left alone.
    const tampered = JSON.parse(JSON.stringify(pkg)) as Json;
    tampered.dungeon.rooms[0].actions[1].reward.currency = { min: 200, max: 200 };
    const caught = await inspect(tampered);
    expect(caught.ok).toBe(false);
    expect(caught.issues).toContainEqual(expect.objectContaining({ code: 'package_hash_mismatch', severity: 'error', path: 'contentHash' }));
    expect(readDungeonPackage(tampered).ok).toBe(false);

    // Other ways a file can be wrong, each with its own code.
    expect((await inspect({ ...pkg, format: 'something-else' })).issues.map((i) => i.code)).toEqual(['package_format']);
    expect((await inspect({ ...pkg, schemaVersion: 99 })).issues.map((i) => i.code)).toEqual(['package_schema_version']);
    expect((await inspect('{ not json')).issues.map((i) => i.code)).toEqual(['package_not_json']);
    const renamed = JSON.parse(JSON.stringify(pkg)) as Json;
    renamed.source.dungeonKey = 'someone_else';
    expect((await inspect(renamed)).issues.map((i) => i.code)).toContain('package_key_mismatch');
    for (const bad of [{ ...pkg, format: 'something-else' }, '{ not json', renamed]) {
      expect((await inspect(bad)).ok).toBe(false);
    }
    // Inspecting imports nothing and writes nothing.
    expect(await rowCounts()).toEqual(counts);
  });
});

/* ───────────────────────── sandbox ───────────────────────── */

describe('sandbox', () => {
  const KEY = 'sand_tunnels';
  interface Sandbox {
    view: Json;
    state: Json;
    effects: Json[];
    log: { type: string; roomId: string | null; actionId: string | null; payload: Json }[];
    steps: number;
    stoppedBy: string | null;
    refusal: string | null;
  }
  const play = async (body: Json) => {
    const res = await call('POST', '/admin/dungeons/sandbox', body);
    expect(res.statusCode, res.body).toBe(200);
    return data<Sandbox>(res);
  };

  beforeAll(async () => {
    await create(KEY);
    await publish(KEY);
  });

  it('auto-plays the published dungeon to `completed`, and writes nothing', async () => {
    const { playerId } = await w.player();
    const counts = await rowCounts();
    const runsBefore = await w.t.db.select().from(dungeonRuns);

    const played = await play({ key: KEY, source: 'published', autoPlay: true, seed: 7, fighter: { ...STARTER } });
    expect(played.stoppedBy).toBe('ended');
    expect(played.refusal).toBeNull();
    expect(played.view).toMatchObject({ status: 'completed', phase: 'ended', room: { id: 'den' } });
    expect(played.state).toMatchObject({ status: 'completed', end: { outcome: 'completed', cause: 'exit_reached' } });
    expect(played.steps).toBeGreaterThan(5);
    // The route auto-play takes: gate → pumps → bulkhead (no keycard, so no vault) → the Den.
    expect(played.log.filter((e) => e.type === 'room_entered').map((e) => e.roomId)).toEqual(['gate', 'pump_room', 'bulkhead', 'den']);
    expect(played.log.at(-1)!.type).toBe('completion');
    // The gate's 2 and the hoard's 10 — described, not paid.
    const settle = played.effects.filter((e) => e.type === 'settle_run');
    expect(settle).toHaveLength(1);
    expect(settle[0]!.end).toMatchObject({ outcome: 'completed', earned: 12, banked: 12, lost: 0 });
    // The combat event lists are not shipped to the editor.
    for (const entry of played.log) expect(entry.payload.events, entry.type).toBeUndefined();

    // Nothing was persisted and nothing was granted.
    expect(await w.t.db.select().from(dungeonRuns)).toEqual(runsBefore);
    expect(await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.dungeonKey, KEY))).toEqual([]);
    expect(await rowCounts()).toEqual(counts);
    expect(await w.balance(playerId)).toBe(0);
    expect((await getRevisions(KEY)).map((r) => r.activeRuns)).toEqual([0]);
    expect((await history(KEY)).map((e) => e.action)).toEqual(['published', 'created']);
  });

  it('plays out the same way every time for the same request', async () => {
    const body = { key: KEY, source: 'published', autoPlay: true, seed: 12345, fighter: { ...STARTER } };
    const first = await play(body);
    const second = await play(body);
    expect(second).toEqual(first);
    expect(first.state.seed).toBe(12345);
  });

  it('applies given inputs in order and stops at the first one refused', async () => {
    const stepped = await play({ key: KEY, fighter: { ...STARTER }, inputs: [{ type: 'advance' }, { type: 'advance' }] });
    expect(stepped).toMatchObject({ steps: 2, stoppedBy: null, refusal: null });
    expect(stepped.view).toMatchObject({ status: 'active', room: { id: 'gate' } });
    expect(stepped.log.filter((e) => e.type === 'combat_wave_resolved')).toHaveLength(2);

    // Moving while a fight is pending is refused; the later inputs are not tried.
    const refused = await play({
      key: KEY,
      fighter: { ...STARTER },
      inputs: [{ type: 'advance' }, { type: 'move', connectionId: 'c_main' }, { type: 'advance' }],
    });
    expect(refused).toMatchObject({ steps: 1, stoppedBy: 'refused' });
    expect(refused.refusal).toEqual(expect.any(String));
    expect(refused.log.filter((e) => e.type === 'combat_wave_resolved')).toHaveLength(1);
  });

  it('plays an unsaved definition, the draft by default, and refuses an invalid one with the issues', async () => {
    const counts = await rowCounts();
    const unsaved = await play({ definition: definitionOf('sand_unsaved'), autoPlay: true, fighter: { ...STARTER } });
    expect(unsaved.view.status).toBe('completed');
    expect((await call('GET', base('sand_unsaved'))).statusCode).toBe(404);

    const invalid = await call('POST', '/admin/dungeons/sandbox', { definition: definitionOf('sand_broken', breakIt), autoPlay: true });
    expect(invalid.statusCode).toBe(400);
    expect(errorOf(invalid).code).toBe('DUNGEON_INVALID');
    expect(errorOf(invalid).details!.issues!.map((i) => i.code)).toContain('enemy_missing');

    // A request names exactly one of a definition and a key.
    expect((await call('POST', '/admin/dungeons/sandbox', {})).statusCode).toBe(400);
    expect((await call('POST', '/admin/dungeons/sandbox', { key: KEY, definition: definitionOf(KEY) })).statusCode).toBe(400);
    expect((await call('POST', '/admin/dungeons/sandbox', { key: 'no_such_dungeon' })).statusCode).toBe(404);
    // A draft that was never published has no published revision to play.
    await create('sand_draft_only');
    const unpublished = await call('POST', '/admin/dungeons/sandbox', { key: 'sand_draft_only', source: 'published' });
    expect(unpublished.statusCode).toBe(404);
    expect(errorOf(unpublished).code).toBe('DUNGEON_REVISION_NOT_FOUND');
    expect((await play({ key: 'sand_draft_only', autoPlay: true, fighter: { ...STARTER } })).view.status).toBe('completed');

    expect(await rowCounts()).toEqual({ ...counts, definitions: counts.definitions + 1, events: counts.events + 1 });
  });

  it('a fighter that cannot win is defeated in the sandbox, not on the server', async () => {
    const lost = await play({ key: KEY, autoPlay: true, fighter: { attack: 1, defense: 1, maxHp: 1 } });
    expect(lost.stoppedBy).toBe('ended');
    expect(lost.view).toMatchObject({ status: 'defeated', hp: 0 });
    expect(await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.dungeonKey, KEY))).toEqual([]);
  });
});

/* ───────────────────────── reference data ───────────────────────── */

describe('reference data', () => {
  it('offers the enemies, regions, currencies and action types the editor picks from', async () => {
    const res = await call('GET', '/admin/dungeons/reference');
    expect(res.statusCode).toBe(200);
    const reference = data<{
      actionTypes: string[];
      reservedActionTypes: Record<string, string>;
      enemies: { key: string; name: string; enabled: boolean; attack: number; defense: number; hp: number }[];
      rewardTables: { id: string; enabled: boolean }[];
      currencies: { key: string; singularName: string; pluralName: string; enabled: boolean }[];
      regions: { id: string; name: string; enabled: boolean }[];
    }>(res);

    // Enemies: the catalogue's own rows, stats included.
    expect(reference.enemies.map((e) => e.key)).toEqual(expect.arrayContaining(TEST_ENEMIES.map((e) => e.key)));
    for (const enemy of TEST_ENEMIES) {
      expect(reference.enemies.find((e) => e.key === enemy.key), enemy.key).toEqual({
        key: enemy.key,
        name: enemy.name,
        enabled: true,
        attack: enemy.attack,
        defense: enemy.defense,
        hp: enemy.hp,
      });
    }
    // Regions: stable ids and display names, from the region catalogue.
    expect(reference.regions).toEqual(w.app.content.regions.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })));
    expect(reference.regions).toContainEqual({ id: 'waifu-valley', name: 'Waifu Valley', enabled: true });
    expect(reference.currencies.find((c) => c.key === CURRENCY)).toMatchObject({ key: CURRENCY, enabled: true });
    expect(reference.rewardTables.length).toBeGreaterThan(0);
    for (const table of reference.rewardTables) expect(table).toEqual({ id: expect.any(String), enabled: expect.any(Boolean) });
    expect(reference.actionTypes).toEqual(expect.arrayContaining(['combat', 'boss', 'rest', 'gate', 'set_flag', 'reward', 'leave']));
    for (const reserved of Object.keys(reference.reservedActionTypes)) expect(reference.actionTypes).not.toContain(reserved);
  });

  it('follows the catalogue: a new enemy is offered at once, a disabled one is marked', async () => {
    await w.enemies.create('ref_newcomer', { name: 'Newcomer', enabled: true, attack: 12, defense: 3, hp: 40, tags: [] }, 'admin-1');
    const offered = async () =>
      data<{ enemies: Json[] }>(await call('GET', '/admin/dungeons/reference')).enemies.find((e) => e.key === 'ref_newcomer');
    expect(await offered()).toEqual({ key: 'ref_newcomer', name: 'Newcomer', enabled: true, attack: 12, defense: 3, hp: 40 });
    const current = (await w.enemies.get('ref_newcomer'))!;
    await w.enemies.setEnabled('ref_newcomer', { enabled: false, expectedRevision: current.revision }, 'admin-1');
    expect(await offered()).toMatchObject({ enabled: false });
  });
});

/* ───────────────────────── Delve settings ───────────────────────── */

describe('Delve settings', () => {
  interface Settings {
    dailyRunLimit: number;
    dailyRunLimitMin: number;
    dailyRunLimitMax: number;
    updatedAt: string | null;
    updatedBy: string | null;
  }
  const getSettings = async () => data<Settings>(await call('GET', '/admin/dungeons/settings'));

  it('reads the shared daily run limit with its bounds', async () => {
    expect(await getSettings()).toMatchObject({ dailyRunLimit: 3, dailyRunLimitMin: 0, dailyRunLimitMax: 50, updatedBy: null });
  });

  it('saves a new limit, which the allowance then uses', async () => {
    const { playerId } = await w.player();
    const res = await call('PUT', '/admin/dungeons/settings', { dailyRunLimit: 5 });
    expect(res.statusCode).toBe(200);
    expect(data<Settings>(res)).toMatchObject({ dailyRunLimit: 5 });
    expect((await getSettings()).dailyRunLimit).toBe(5);
    expect(await w.allowance.status(playerId)).toMatchObject({ limit: 5, used: 0, remaining: 5 });
    // 0 is accepted: it closes Delve to new runs.
    expect(data<Settings>(await call('PUT', '/admin/dungeons/settings', { dailyRunLimit: 0 }))).toMatchObject({ dailyRunLimit: 0 });
    expect(await w.allowance.status(playerId)).toMatchObject({ limit: 0, remaining: 0 });
    await call('PUT', '/admin/dungeons/settings', { dailyRunLimit: 3 });
  });

  it('refuses a fraction, a negative, a value past the cap, a string and an unknown field — and keeps the old value', async () => {
    for (const dailyRunLimit of [2.5, -1, 51]) {
      const res = await call('PUT', '/admin/dungeons/settings', { dailyRunLimit });
      expect(res.statusCode, String(dailyRunLimit)).toBe(400);
      expect(errorOf(res).code).toBe('DUNGEON_SETTINGS_INVALID');
    }
    expect((await call('PUT', '/admin/dungeons/settings', { dailyRunLimit: '4' })).statusCode).toBe(400);
    expect((await call('PUT', '/admin/dungeons/settings', { dailyRunLimit: 4, perZone: true })).statusCode).toBe(400);
    expect((await call('PUT', '/admin/dungeons/settings', {})).statusCode).toBe(400);
    expect((await getSettings()).dailyRunLimit).toBe(3);
  });
});

/* ───────────────────────── progression currency ───────────────────────── */

describe('progression currency', () => {
  const KEY = 'cur_tunnels';
  interface Currency {
    key: string;
    singularName: string;
    pluralName: string;
    description: string;
    icon: string | null;
    enabled: boolean;
    revision: number;
  }
  const getCurrency = async () =>
    data<{ currencies: Currency[] }>(await call('GET', '/admin/dungeons/currencies')).currencies.find((c) => c.key === CURRENCY)!;
  let original: Currency;

  beforeAll(async () => {
    await create(KEY);
    original = await getCurrency();
  });
  afterAll(async () => {
    // Other files' worlds are their own databases, but leave this one as it was found.
    const current = await getCurrency();
    await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, {
      singularName: original.singularName,
      pluralName: original.pluralName,
      description: original.description,
      icon: original.icon,
      enabled: true,
      expectedRevision: current.revision,
    });
  });

  it('lists the currency the test dungeon pays', async () => {
    expect(original).toMatchObject({ key: CURRENCY, singularName: 'Ascension Token', pluralName: 'Ascension Tokens', enabled: true });
    expect((await getDungeon(KEY)).draft.settings.progressionCurrency).toBe(CURRENCY);
  });

  it('edits the display metadata and keeps the key', async () => {
    const before = await getCurrency();
    const res = await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, {
      singularName: 'Star Shard',
      pluralName: 'Star Shards',
      description: 'Spent on Ascension.',
      icon: '✨',
      enabled: true,
      expectedRevision: before.revision,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await getCurrency()).toMatchObject({
      key: CURRENCY,
      singularName: 'Star Shard',
      pluralName: 'Star Shards',
      description: 'Spent on Ascension.',
      icon: '✨',
      revision: before.revision + 1,
    });
    // Dungeons still reference the same key, and still validate.
    const dungeon = await getDungeon(KEY);
    expect(dungeon.draft.settings.progressionCurrency).toBe(CURRENCY);
    expect(dungeon.issues.filter((i) => i.code.startsWith('currency_'))).toEqual([]);
    expect(data<{ currencies: Json[] }>(await call('GET', '/admin/dungeons/reference')).currencies.find((c) => c.key === CURRENCY)).toMatchObject({
      singularName: 'Star Shard',
      pluralName: 'Star Shards',
    });
  });

  it('refuses a key in the body, a stale revision, an empty name and an unknown currency', async () => {
    const current = await getCurrency();
    const body = { singularName: 'A', pluralName: 'As', enabled: true, expectedRevision: current.revision };
    expect((await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, { ...body, key: 'renamed' })).statusCode).toBe(400);
    const stale = await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, { ...body, expectedRevision: current.revision + 5 });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale)).toMatchObject({ code: 'PROGRESSION_CURRENCY_STALE', details: { currentRevision: current.revision } });
    const empty = await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, { ...body, pluralName: '   ' });
    expect(empty.statusCode).toBe(400);
    expect(errorOf(empty).code).toBe('PROGRESSION_CURRENCY_INVALID');
    expect((await call('PUT', '/admin/dungeons/currencies/doubloons', body)).statusCode).toBe(404);
    expect(await getCurrency()).toEqual(current);
  });

  it('warns on dungeons when the currency is disabled, without blocking them', async () => {
    const current = await getCurrency();
    const body = { singularName: current.singularName, pluralName: current.pluralName, expectedRevision: current.revision };
    await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, { ...body, enabled: false });
    const warned = await getDungeon(KEY);
    expect(warned.issues.filter((i) => i.code.startsWith('currency_'))).toEqual([
      expect.objectContaining({ code: 'currency_disabled', path: 'settings.progressionCurrency', severity: 'warning' }),
    ]);
    expect(errorCodes(warned.issues)).toEqual([]);
    await call('PUT', `/admin/dungeons/currencies/${CURRENCY}`, { ...body, enabled: true, expectedRevision: current.revision + 1 });
    expect((await getDungeon(KEY)).issues.filter((i) => i.code.startsWith('currency_'))).toEqual([]);
  });
});

/* ───────────────────────── artwork picker ───────────────────────── */

describe('dungeon artwork picker', () => {
  interface Listing {
    path: string;
    directories: { path: string }[];
    files: { path: string }[];
  }

  it('serves the bytes of a deployed file, 404s a missing one and 400s an unsafe path', async () => {
    const ok = await call('GET', '/admin/dungeons/artwork?path=dungeons/zones/deployed.webp');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/webp');
    expect(ok.body).toBe('webp-bytes');
    expect((await call('GET', '/admin/dungeons/artwork?path=dungeons/zones/not_there.webp')).statusCode).toBe(404);
    expect((await call('GET', `/admin/dungeons/artwork?path=${encodeURIComponent('../outside.webp')}`)).statusCode).toBe(400);
    expect((await call('GET', '/admin/dungeons/artwork?path=dungeons/zones/deployed.exe')).statusCode).toBe(400);
    expect((await call('GET', '/admin/dungeons/artwork')).statusCode).toBe(400);
  });

  it('browses and searches the dungeon folders only — never the rest of the assets tree', async () => {
    const top = data<Listing>(await call('GET', '/admin/dungeons/artwork/browse'));
    expect(top.path).toBe('dungeons');
    expect(top.directories.map((d) => d.path).sort()).toEqual(['dungeons/backgrounds', 'dungeons/zones']);
    const folder = data<Listing>(await call('GET', '/admin/dungeons/artwork/browse?path=dungeons/zones'));
    expect(folder.files.map((f) => f.path)).toEqual(['dungeons/zones/deployed.webp']);
    // Another area's folder is not this picker's to list.
    expect((await call('GET', '/admin/dungeons/artwork/browse?path=results')).statusCode).toBe(400);
    expect((await call('GET', `/admin/dungeons/artwork/browse?path=${encodeURIComponent('dungeons/../results')}`)).statusCode).toBe(400);
    const found = data<{ results: { path: string }[] }>(await call('GET', '/admin/dungeons/artwork/search?q=deployed'));
    expect(found.results.map((r) => r.path)).toEqual(['dungeons/zones/deployed.webp']);
    expect(data<{ results: unknown[] }>(await call('GET', '/admin/dungeons/artwork/search?q=secret')).results).toEqual([]);
  });

  it('with no shipped dungeon artwork at all, browsing is an empty success — not a server error', async () => {
    const dungeons = path.join(assetsDir, 'dungeons');
    const parked = path.join(assetsRoot, 'dungeons-parked');
    fs.renameSync(dungeons, parked);
    try {
      const top = await call('GET', '/admin/dungeons/artwork/browse');
      expect(top.statusCode, top.body).toBe(200);
      expect(top.json().data).toEqual({
        path: 'dungeons',
        parent: null,
        breadcrumbs: [{ name: 'dungeons', path: 'dungeons' }],
        directories: [],
        files: [],
        missing: true,
      });
      expect((await call('GET', '/admin/dungeons/artwork/browse?path=dungeons/backgrounds')).statusCode).toBe(404);
      expect(data<{ results: unknown[] }>(await call('GET', '/admin/dungeons/artwork/search?q=deployed')).results).toEqual([]);
      expect((await call('GET', '/admin/dungeons/artwork?path=dungeons/zones/deployed.webp')).statusCode).toBe(404);
      // A dungeon still loads: missing art is never an error.
      expect((await call('GET', '/admin/dungeons/definitions')).statusCode).toBe(200);
    } finally {
      fs.renameSync(parked, dungeons);
    }
    expect((await call('GET', '/admin/dungeons/artwork/browse')).json().data).toMatchObject({ path: 'dungeons', missing: false });
  });
});

/* ───────────────────────── the old routes ───────────────────────── */

describe('the zone routes of the old prototype', () => {
  it('are gone', async () => {
    for (const [method, url] of [
      ['GET', '/admin/dungeons/zones'],
      ['GET', '/admin/dungeons/zones/scrapheap_gauntlet'],
      ['POST', '/admin/dungeons/zones'],
      ['POST', '/admin/dungeons/preview'],
    ] as const) {
      expect((await call(method, url, method === 'POST' ? {} : undefined)).statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
