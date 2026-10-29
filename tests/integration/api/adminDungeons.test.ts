import { REGIONS } from '../../../src/modules/locations/regions';
import { publishRegionPoolRevisionForTest } from '../../helpers/regionPoolFixtures';
import { createSharedDungeonPoolService } from '../../../src/modules/dungeons/sharedPools/sharedPoolService';
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
import { dungeonContentEvents, dungeonDefinitions, dungeonRevisions, dungeonRunEvents, dungeonRuns, items, playerInventory, species, regionPools, regionPoolRevisions, regionPoolRevisionEntries, regionEncounterPools } from '../../../src/db/schema';
import { DungeonDefinitionSchema } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { startDungeonRun } from '../../../src/modules/dungeons/engine/step';
import { createDungeonLootTableService } from '../../../src/modules/dungeons/dungeonLootTableService';
import { buildDungeonPackage, readDungeonPackage } from '../../../src/modules/dungeons/package/dungeonPackage';
import { resolveDungeonRewardDependencies } from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { DungeonLootTableBodySchema } from '../../../src/modules/dungeons/content/dungeonRewards';
import { randomUUID } from 'node:crypto';
import { DUNGEON_ISSUE_CODES } from '../../../src/modules/dungeons/validation/dungeonValidation';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import {
  createPortalAuthorizationService,
  type PortalAuthorizationService,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { CURRENCY, STARTER, TEST_ENEMIES, testDungeonInput, singleRoomDungeon } from '../../helpers/dungeonFixtures';
import { eventContext, eventDungeonInput } from '../../helpers/dungeonEventFixtures';
import { createDungeonWorld, type DungeonWorld } from '../../helpers/dungeonWorld';
import { provisionPlayer } from '../../helpers/fixtures';
import { createSceneSpriteService } from '../../../src/modules/dungeons/sceneSprites/sceneSpriteService';
import { solidImage, transparentSprite, twoToneSprite, pixelAt, isNear, BLUE, GREEN, RED } from '../../helpers/imageFixtures';
import { DEFAULT_SPRITE_PLACEMENT, layoutSprite } from '../../../src/modules/artworkAssets/scenePlacement';
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
        dungeonSpeciesPools: createSharedDungeonPoolService(w.t.db),
        dungeonRuns: w.runs,
        dungeonAllowance: w.allowance,
        progressionCurrency: w.currencies,
        enemies: w.enemies,
        artworkAssets: w.assets,
        sceneComposition: w.scenes,
        dungeonSceneSprites: createSceneSpriteService({ db: w.t.db, assets: w.assets }),
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
  gameplayHash: string | null;
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

let v2ApiSerial = 0;
function v2ApiPackage() {
  const key = `api_v2_import_${++v2ApiSerial}`;
  const table = `${key}_loot`;
  const body = DungeonLootTableBodySchema.parse({ guaranteed: [{ id: 'coins', grant: { type: 'currency', currency: 'waifubux', amount: { min: 7, max: 9 } } }], chances: [], pools: [] });
  const definition = singleRoomDungeon([{ id: 'hoard', type: 'reward', rewards: { guaranteed: [], chances: [], tables: [{ id: 'loot', table, draws: 1 }] } }], d => { d.key = key; d.flags = []; });
  const rewardSnapshot = resolveDungeonRewardDependencies(definition, { lootTables: new Map([[table, { name: 'Coin hoard', body, archivedAt: null }]]) }).snapshot!;
  return { pkg: buildDungeonPackage({ definition, rewardSnapshot, source: { environment: 'staging', origin: 'revision', draftRevision: null, publishedRevision: 1 } }), table, body };
}
describe('package import API', () => {
  it('v3 event-only preview/apply returns named item dependencies, null evidence and secured receipts', async () => {
    const definition = singleRoomDungeon([{ id: 'story', type: 'event', source: { kind: 'event', eventId: 'door' } }], d => {
      d.key = 'api_v3_import'; d.flags = [];
      d.events = [{ id: 'door', title: 'Door', text: 'A closed door.', choices: [
        { id: 'open', label: 'Open it', items: [{ item: 'sticky_joystick', quantity: 1 }], outcome: {} },
        { id: 'skip', label: 'Carry on', outcome: {} },
      ] }];
    });
    const pkg = buildDungeonPackage({ definition, source: { environment: 'source', origin: 'revision', draftRevision: null, publishedRevision: 1 } });
    const preview = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', { package: pkg });
    expect(preview.statusCode, preview.body).toBe(200);
    const plan = data<Json>(preview);
    expect(plan).toMatchObject({ validPackage: true, lootTables: [], eventDependencies: { eventCount: 1, poolCount: 0, requiredItems: [{ key: 'sticky_joystick', status: 'available', name: expect.any(String) }] }, rewardSource: { snapshotHash: null, resolverVersion: null } });
    const request = { package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash, expectedRevision: null, decisions: { dungeon: 'create', enemies: {}, allowMissingDependencies: false } };
    for (const endpoint of ['plan', 'apply']) {
      const payload = endpoint === 'plan' ? { package: pkg } : request;
      expect((await as(READER_TOKEN, 'POST', `/admin/dungeons/import/${endpoint}`, payload)).statusCode).toBe(403);
      expect((await api.inject({ method: 'POST', url: `/api/v1/admin/dungeons/import/${endpoint}`, cookies: { wm_portal_session: WRITER_TOKEN }, payload })).statusCode).toBe(403);
    }
    const applied = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', request);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(data<Json>(applied)).toMatchObject({ sourceSchemaVersion: 3, rewardSnapshotHash: null, createdLootTables: [] });
    expect(await w.content.get(definition.key)).toMatchObject({ enabled: false, published: null, draft: definition });
    expect(data<Json>(await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', request))).toMatchObject({ replayed: true, importId: data<Json>(applied).importId });
  });
  it('v4 export, review and apply retain species/capture dependency fields over HTTP', async () => {
    const definition = singleRoomDungeon([{ id: 'meet', type: 'wild_encounter', source: { kind: 'species', species: 'neko_barista' }, intro: 'Hello.', capture: { allowedItems: ['basic_charm'] } }], d => { d.key = 'v4_api_source'; });
    await w.content.create({ definition }, 'source');
    const response = await as(READER_TOKEN, 'GET', '/admin/dungeons/definitions/v4_api_source/export?origin=draft');
    expect(response.statusCode, response.body).toBe(200);
    const pkg = data<Json>(response);
    expect(pkg).toMatchObject({ schemaVersion: 4, dependencies: { requiredSpecies: [expect.objectContaining({ slug: 'neko_barista', rarity: 'N' })], captureItems: ['basic_charm'] } });
    const preview = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', { package: pkg });
    expect(preview.statusCode, preview.body).toBe(200); const plan = data<Json>(preview);
    expect(plan).toMatchObject({ validPackage: true, encounterDependencies: { encounterCount: 1, requiredSpecies: [{ slug: 'neko_barista', status: 'available', sourceRarity: 'N', targetRarity: 'N' }], captureItems: [{ key: 'basic_charm', status: 'available' }] } });
    const applied = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', { package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash, expectedRevision: plan.target.expectedRevision, decisions: { dungeon: 'replace', enemies: {}, allowMissingDependencies: false } });
    expect(applied.statusCode, applied.body).toBe(200); expect(data<Json>(applied)).toMatchObject({ sourceSchemaVersion: 4, publishable: true });
    expect(await w.content.get(definition.key)).toMatchObject({ enabled: false, published: null });
  });
  it('v2 conflict preview and copy application return reward-aware contracts and an unchanged destination table', async () => {
    const { pkg, table, body } = v2ApiPackage();
    const loot = createDungeonLootTableService({ db: w.t.db });
    const targetBody = DungeonLootTableBodySchema.parse({ ...body, guaranteed: [{ id: 'coins', grant: { type: 'currency', currency: 'waifubux', amount: { min: 99, max: 99 } } }] });
    await loot.create({ key: table, name: 'Target coins', body: targetBody }, 'author');
    const first = data<Json>(await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', { package: pkg }));
    expect(first.lootTables).toMatchObject([{ key: table, status: 'different', decision: null, incomingBody: body, currentBody: targetBody }]);
    const lootTables = { [table]: { action: 'copy', key: `${table}_copy` } };
    const preview = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', { package: pkg, lootTables });
    expect(preview.statusCode).toBe(200);
    const plan = data<Json>(preview); expect(plan.resultingContentHash).not.toBe(pkg.contentHash);
    const request = { package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash, expectedRevision: null, decisions: { dungeon: 'create', enemies: {}, lootTables, allowMissingDependencies: false } };
    const response = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', request);
    expect(response.statusCode, response.body).toBe(200);
    expect(data<Json>(response)).toMatchObject({ createdLootTables: [`${table}_copy`], contentHash: plan.resultingContentHash, tableKeyChanges: { [table]: `${table}_copy` }, sourceSchemaVersion: 2 });
    expect((await loot.get(table))!.body).toEqual(targetBody);
    expect((await w.content.get(pkg.dungeon.key))).toMatchObject({ enabled: false, published: null, draftHash: plan.resultingContentHash });
    expect(data<Json>(await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', request))).toMatchObject({ replayed: true, importId: data<Json>(response).importId });
  });
  it('v2 preview/apply enforce write permission, CSRF and strict copy decisions', async () => {
    const { pkg } = v2ApiPackage();
    const plan = data<Json>(await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', { package: pkg }));
    const request = { package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash, expectedRevision: null, decisions: { dungeon: 'create', enemies: {}, allowMissingDependencies: false } };
    for (const endpoint of ['plan', 'apply']) {
      const payload = endpoint === 'plan' ? { package: pkg } : request;
      expect((await as(READER_TOKEN, 'POST', `/admin/dungeons/import/${endpoint}`, payload)).statusCode).toBe(403);
      const missingCsrf = await api.inject({ method: 'POST', url: `/api/v1/admin/dungeons/import/${endpoint}`, cookies: { wm_portal_session: WRITER_TOKEN }, payload });
      expect(missingCsrf.statusCode).toBe(403);
    }
    expect((await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', { package: pkg, lootTables: { unknown: { action: 'copy', key: 'Invalid Key' } } })).statusCode).toBe(400);
    expect((await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', { ...request, decisions: { ...request.decisions, lootTables: { unknown: { action: 'overwrite' } } } })).statusCode).toBe(400);
  });
  it('v2 table changes return a stale-plan conflict and tampered packages fail explicitly', async () => {
    const { pkg, table, body } = v2ApiPackage(); const loot = createDungeonLootTableService({ db: w.t.db });
    await loot.create({ key: table, name: 'Same table', body }, 'author');
    const plan = data<Json>(await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', { package: pkg }));
    await loot.archive(table, { expectedRevision: 1 }, 'author');
    const request = { package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash, expectedRevision: null, decisions: { dungeon: 'create', enemies: {}, allowMissingDependencies: false } };
    const stale = await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', request); expect(stale.statusCode).toBe(409); expect(errorOf(stale).code).toBe('DUNGEON_IMPORT_STALE');
    const tampered = { ...pkg, contentHash: `sha256:${'0'.repeat(64)}` };
    const read = data<Json>(await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/plan', { package: tampered })); expect(read.validPackage).toBe(false);
    expect((await as(WRITER_TOKEN, 'POST', '/admin/dungeons/import/apply', { ...request, package: tampered })).statusCode).toBe(400);
    expect(await w.content.get(pkg.dungeon.key)).toBeNull();
  });
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

  it('answers how the definition’s events would play, for an imagined run, and writes nothing', async () => {
    type Odds = { totalWeight: number; nothingProbability: number; entries: { id: string; eligible: boolean; reason: string | null; probability: number }[] };
    type Events = { eventPools: { poolId: string; base: Odds; scenario: Odds }[]; eventPreviews: { eventId: string; choices: Json[] }[] };
    const insight = async (body: Json) => {
      const res = await call('POST', '/admin/dungeons/validate', body);
      expect(res.statusCode, res.body).toBe(200);
      return data<Events & { definition: Json | null }>(res);
    };
    const shares = (odds: Odds) => Object.fromEntries(odds.entries.map((e) => [e.id, e.eligible ? Number(e.probability.toFixed(4)) : e.reason]));
    const definition = eventDungeonInput('val_events');
    const counts = await rowCounts();

    // No scenario: an empty run, an average Buddy.
    const plain = await insight({ definition });
    expect(plain.eventPools.map((p) => p.poolId)).toEqual(['scrapheap_finds']);
    expect(shares(plain.eventPools[0]!.base)).toEqual({ e_crate: 0.3, e_drone: 0.2, e_trader: 0.1, e_nothing: 0.4 });
    expect(shares(plain.eventPools[0]!.scenario)).toEqual(shares(plain.eventPools[0]!.base));
    const vault = (report: Events) => Object.fromEntries(report.eventPreviews.find((e) => e.eventId === 'sealed_vault')!.choices.map((c) => [c.id, c]));
    expect(vault(plain).pick_lock).toMatchObject({ check: { chanceBasisPoints: 5500, sp: 200 }, chances: { weakest: 4000, average: 5500, strongest: 7000 } });
    expect(vault(plain).use_key).toMatchObject({ available: false, unavailableReason: 'items', consumesOnSelect: true, hidden: false });
    expect(vault(plain).secret).toMatchObject({ available: false, hidden: true });

    // Flags, events already met, an assumed inventory and a strong Buddy at the entrance.
    const tried = await insight({
      definition,
      eventScenario: { flags: ['alarm_triggered'], seenEvents: ['buried_crate'], inventory: { vault_key: 1 }, currentSp: 350, canTurnBack: false },
    });
    expect(shares(tried.eventPools[0]!.base)).toEqual(shares(plain.eventPools[0]!.base));
    expect(shares(tried.eventPools[0]!.scenario)).toEqual({ e_crate: 'already_seen', e_drone: 0.3333, e_trader: 'condition', e_nothing: 0.6667 });
    expect(vault(tried).use_key).toMatchObject({ available: true, items: [{ item: 'vault_key', quantity: 1, consume: true, owned: 1 }] });
    expect(vault(tried).pick_lock.check).toEqual({ chanceBasisPoints: 7000, sp: 350 });
    expect(vault(tried).secret).toMatchObject({ available: true, hidden: false });
    expect(vault(tried).leave).toMatchObject({ available: false, unavailableReason: 'no_way_back' });

    // Every conditional or once-per-run entry gone, and no Nothing entry: the pool presents nothing.
    const bare = eventDungeonInput('val_events_bare');
    bare.eventPools![0]!.entries.pop();
    const empty = await insight({ definition: bare, eventScenario: { flags: ['alarm_triggered'], seenEvents: ['buried_crate', 'sparking_drone'] } });
    expect(empty.eventPools[0]!.scenario).toMatchObject({ totalWeight: 0, nothingProbability: 1 });
    expect(empty.eventPools[0]!.scenario.entries.every((e) => !e.eligible)).toBe(true);

    // Nothing to say about a dungeon without events, or one whose shape cannot be read.
    expect(await insight({ definition: definitionOf('val_no_events') })).toMatchObject({ eventPools: [], eventPreviews: [] });
    expect(await insight({ definition: { key: 'val_shapeless' }, eventScenario: { flags: ['x'] } })).toMatchObject({ definition: null, eventPools: [], eventPreviews: [] });
    // A scenario is bounded like any other input.
    expect((await call('POST', '/admin/dungeons/validate', { definition, eventScenario: { currentSp: -1 } })).statusCode).toBe(400);
    expect((await call('POST', '/admin/dungeons/validate', { definition, eventScenario: { inventory: { vault_key: 1.5 } } })).statusCode).toBe(400);
    expect(await rowCounts()).toEqual(counts);
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
    const historyBefore = await history(KEY);
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
    expect(await history(KEY)).toEqual(historyBefore);
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

  it('plays event choices with an assumed inventory, shows what they did, and writes nothing', async () => {
    const [key] = await w.t.db.insert(items).values({ slug: 'sand_vault_key', name: 'Vault Key', category: 'material', enabled: true }).returning();
    const { playerId } = await w.player();
    await w.app.inventory.addItem(w.t.db, playerId, key!.id, 3);
    // The event fixture without loot this server lacks, needing an item that exists here.
    const definition = eventDungeonInput('sand_events') as Json;
    for (const event of definition.events) for (const choice of event.choices) {
      for (const branch of ['outcome', 'success', 'failure']) delete choice[branch]?.rewards;
      for (const requirement of choice.items ?? []) requirement.item = 'sand_vault_key';
    }
    const pure = eventContext(DungeonDefinitionSchema.parse(definition), { rewards: null });
    const seed = Array.from({ length: 5000 }, (_, i) => i).find((i) => startDungeonRun(pure, i).state.events!['hall:find']!.eventId === null)!;
    const counts = await rowCounts();
    const inventoryBefore = await w.t.db.select().from(playerInventory);
    const body = { definition, seed, fighter: { ...STARTER, currentSp: 350 } };
    type EventSandbox = Sandbox & { eventResults: { eventTitle: string; choiceLabel: string; text: string; tone: string }[] };
    const playEvents = async (extra: Json) => {
      const res = await call('POST', '/admin/dungeons/sandbox', { ...body, ...extra });
      expect(res.statusCode, res.body).toBe(200);
      return data<EventSandbox>(res);
    };

    // The offered event, as a player would see it: no key assumed, so that choice is unavailable.
    const offered = await playEvents({ inputs: [{ type: 'move', connectionId: 'c_vault' }] });
    expect(offered.view.action.event).toMatchObject({ eventId: 'sealed_vault', title: 'The Sealed Vault' });
    const choice = (played: EventSandbox, id: string) => played.view.action.event.choices.find((c: Json) => c.id === id);
    expect(choice(offered, 'use_key')).toMatchObject({ available: false, unavailableReason: 'items', consumesOnSelect: true });
    expect(choice(offered, 'pick_lock').check).toEqual({ chanceBasisPoints: 7000, sp: 350 });
    expect(offered.state.events).toMatchObject({ 'hall:find': { status: 'nothing' }, 'vault:door': { eventId: 'sealed_vault', status: 'offered' } });
    expect(offered.eventResults).toEqual([]);

    const refused = await playEvents({ inputs: [{ type: 'move', connectionId: 'c_vault' }, { type: 'choose', choiceId: 'use_key' }] });
    expect(refused).toMatchObject({ stoppedBy: 'refused', refusal: 'choice_unavailable', steps: 1 });
    expect((await playEvents({ inputs: [{ type: 'move', connectionId: 'c_vault' }, { type: 'advance' }] })).refusal).toBe('choice_required');

    // With a key assumed: the choice resolves, the item use is listed as an effect, and nobody's inventory moves.
    const used = await playEvents({ inventory: { sand_vault_key: 1 }, inputs: [{ type: 'move', connectionId: 'c_vault' }, { type: 'choose', choiceId: 'use_key' }] });
    expect(used.refusal).toBeNull();
    expect(used.effects).toEqual([expect.objectContaining({ type: 'consume_items', items: [{ item: 'sand_vault_key', quantity: 1 }] })]);
    expect(used.state.flags).toEqual({ vault_opened: true });
    expect(used.state.events['vault:door']).toMatchObject({ status: 'resolved', resolution: { choiceId: 'use_key', branch: 'outcome' } });
    expect(used.eventResults).toEqual([{ roomId: 'vault', actionId: 'door', eventTitle: 'The Sealed Vault', choiceLabel: 'Use the Vault Key', text: 'The door rolls aside.', tone: 'good' }]);
    expect(used.log.map((entry) => entry.type)).toEqual(expect.arrayContaining(['event_selected', 'action_completed']));

    // The same request plays out the same way, check included; a stronger Buddy only changes the odds.
    const checked = { inputs: [{ type: 'move', connectionId: 'c_vault' }, { type: 'choose', choiceId: 'pick_lock' }] };
    const once = await playEvents(checked);
    expect(await playEvents(checked)).toEqual(once);
    const { check } = once.state.events['vault:door'].resolution;
    expect(check).toMatchObject({ sp: 350, chanceBasisPoints: 7000, success: check.roll < 7000 });
    const weaker = await playEvents({ ...checked, fighter: { ...STARTER } });
    expect(weaker.state.events['vault:door'].resolution.check).toMatchObject({ sp: 200, chanceBasisPoints: 5500, roll: check.roll });

    // Auto-play answers events and reaches an ending.
    expect((await playEvents({ autoPlay: true })).view.status).toBe('completed');

    expect((await call('POST', '/admin/dungeons/sandbox', { ...body, inventory: { sand_vault_key: -1 } })).statusCode).toBe(400);
    expect((await call('POST', '/admin/dungeons/sandbox', { ...body, inputs: [{ type: 'choose' }] })).statusCode).toBe(400);
    expect(await rowCounts()).toEqual(counts);
    expect(await w.t.db.select().from(playerInventory)).toEqual(inventoryBefore);
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
        // Whether a combat sprite / full artwork is configured, for the editor's fight preview.
        sprite: expect.any(Boolean),
        artwork: expect.any(Boolean),
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
    expect(await offered()).toEqual({ key: 'ref_newcomer', name: 'Newcomer', enabled: true, attack: 12, defense: 3, hp: 40, sprite: false, artwork: false });
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

/* ───────────────────────── reward snapshots (T6) ───────────────────────── */

describe('reward dependency reporting', () => {
  it('returns gameplay hashes, dependency changes and the pinned snapshot on list, detail, publish and revision reads', async () => {
    const KEY = 'snapshot_api_tunnels';
    const tables = createDungeonLootTableService({ db: w.t.db });
    await w.t.db.insert(items).values({ slug: 'snapshot_api_prize', name: 'API Prize', category: 'material', enabled: true });
    const body = (quantity: number) => ({
      guaranteed: [{ id: 'prize', grant: { type: 'item', item: 'snapshot_api_prize', quantity: { min: quantity, max: quantity } } }],
      chances: [],
      pools: [],
    });
    const loot = await tables.create({ key: 'snapshot_api_table', name: 'API hoard', body: body(1) as never }, 'author');
    await create(KEY, (d) => {
      d.rooms[0].actions.push({ id: 'api_hoard', type: 'reward', rewards: { guaranteed: [], chances: [], tables: [{ id: 'loot', table: loot.key, draws: 1 }] } });
    });
    const first = await publish(KEY);
    expect(first).toMatchObject({
      unchanged: false,
      revision: { number: 1, gameplayHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
      dungeon: { draftDiffers: false, dependenciesDiffer: false, dependencyChanges: [], draftGameplayHash: first.revision.gameplayHash },
    });
    expect(first.revision.gameplayHash).not.toBe(first.revision.contentHash);

    const edited = await tables.update(loot.key, { expectedRevision: 1, body: body(3) as never }, 'author');
    const changed = {
      draftDiffers: false,
      dependenciesDiffer: true,
      dependencyChanges: [{ kind: 'table', tableKey: loot.key, name: 'API hoard', status: 'changed', publishedHash: loot.contentHash, currentHash: edited.contentHash }],
      published: { number: 1, gameplayHash: first.revision.gameplayHash },
    };
    expect(await getDungeon(KEY)).toMatchObject(changed);
    const listed = data<{ dungeons: Json[] }>(await call('GET', '/admin/dungeons/definitions')).dungeons;
    expect(listed.find((d) => d.key === KEY)).toMatchObject(changed);
    // Dungeons with no v2 rewards report nothing.
    for (const other of listed.filter((d) => d.key !== KEY && !d.key.startsWith('api_v2_import_'))) {
      expect(other, other.key).toMatchObject({ draftGameplayHash: null, dependencyChanges: [] });
    }

    const second = await publish(KEY);
    expect(second).toMatchObject({ unchanged: false, revision: { number: 2, contentHash: first.revision.contentHash } });
    expect(second.revision.gameplayHash).not.toBe(first.revision.gameplayHash);
    expect((await getRevisions(KEY)).map((r) => [r.number, r.gameplayHash])).toEqual([
      [2, second.revision.gameplayHash],
      [1, first.revision.gameplayHash],
    ]);
    const one = data<Json>(await call('GET', `${base(KEY)}/revisions/1`));
    expect(one.rewardSnapshot).toMatchObject({
      format: 'waifumon-dungeon-reward-snapshot',
      tables: { [loot.key]: { body: body(1), contentHash: loot.contentHash } },
      items: { snapshot_api_prize: { name: 'API Prize', category: 'material' } },
    });
    expect(data<Json>(await call('GET', `${base(KEY)}/revisions/2`)).rewardSnapshot.tables[loot.key].body).toEqual(body(3));
  });

  it('reads a legacy revision with a null snapshot and gameplay hash', async () => {
    const KEY = 'snapshot_api_legacy';
    await create(KEY);
    expect(await publish(KEY)).toMatchObject({ revision: { gameplayHash: null }, dungeon: { published: { gameplayHash: null }, dependenciesDiffer: false } });
    expect(data<Json>(await call('GET', `${base(KEY)}/revisions/1`))).toMatchObject({ rewardSnapshot: null, gameplayHash: null });
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


describe('P4C2A species pool authoring API', () => {
  it('catalogue is read-only, permission-gated, reports central policy and scoped limits', async () => {
    const slug = w.app.content.species.find((s) => s.enabled)?.slug!;
    w.speciesAccess.set(slug, [{ dungeon: 'pool_authoring', perPlayerLimit: 2, directRescue: true }, { dungeon: 'other', perPlayerLimit: 'unlimited' }]);
    const result = await as(READER_TOKEN, 'GET', '/admin/dungeons/species?dungeonKey=pool_authoring');
    expect(result.statusCode).toBe(200);
    const row = data<Json>(result).species.find((s: Json) => s.slug === slug);
    expect(row).toMatchObject({ permitted: true, perPlayerLimit: 2, directRescue: { available: true, reason: null } });
    expect(row.dungeonAccess).toHaveLength(2);
    expect(row.race).toBeTruthy(); expect(row.affinity).toBeTruthy(); expect(row).not.toHaveProperty('imagePath');
    expect((await as(NON_OWNER_TOKEN, 'GET', '/admin/dungeons/species?dungeonKey=pool_authoring')).statusCode).toBe(403);
    expect((await as(NON_OWNER_TOKEN, 'GET', `/admin/dungeons/species/artwork?slug=${slug}`)).statusCode).toBe(403);
    expect((await as(READER_TOKEN, 'GET', '/admin/dungeons/species/artwork?slug=..%2Fsecret')).statusCode).toBe(400);
    expect((await as(READER_TOKEN, 'GET', '/admin/dungeons/species/artwork?slug=no_such_species')).statusCode).toBe(404);
    expect((await call('POST', '/admin/dungeons/species', {})).statusCode).toBe(404);
    const sp = w.app.appearance.speciesContent(slug)!;
    const look = w.app.appearance.currentAppearance(sp, null);
    const relative = `${look.assetId.kind}/${look.assetId.slug}/${look.assetId.variant}.png`;
    const artworkFile = path.join(assetsDir, relative);
    fs.mkdirSync(path.dirname(artworkFile), { recursive: true });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNkYPj/n4GBgYGJAQoAHxcCAr7uqmIAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(artworkFile, bytes);
    const art = await as(READER_TOKEN, 'GET', `/admin/dungeons/species/artwork?slug=${slug}&width=256`);
    expect(art.statusCode).toBe(200); expect(art.headers['content-type']).toBe('image/png');
    expect(art.rawPayload).toEqual(bytes); expect(art.headers.etag).toBeTruthy();
    const cached = await api.inject({ method: 'GET', url: `/api/v1/admin/dungeons/species/artwork?slug=${slug}&width=256`, headers: { ...AUTH_BEARER, 'if-none-match': art.headers.etag as string } });
    expect(cached.statusCode).toBe(304);
    expect((await call('GET', `/admin/dungeons/species/artwork?slug=${slug}&width=123`)).statusCode).toBe(400);
    w.speciesAccess.delete(slug);
  });
  it('returns runtime odds and policy without redistributing unavailable or acquisition-limited weights', async () => {
    const normal = w.app.content.species.find((s) => s.enabled && !s.tags.includes('region_exclusive'))!;
    const restricted = w.app.content.species.find((s) => s.enabled && s.tags.includes('region_exclusive'))!;
    w.speciesAccess.set(normal.slug, [{ dungeon: 'pool_odds', perPlayerLimit: 1 }]);
    const definition = definitionOf('pool_odds');
    definition.flags = [{ key: 'open', scope: 'run' }];
    definition.speciesPools = [{ id: 'sp_test', name: 'Wild', entries: [
      { id: 'normal', species: normal.slug, weight: 3 },
      { id: 'restricted', species: restricted.slug, weight: 1, when: { type: 'flag', flag: 'open' } },
      { id: 'none', nothing: true, weight: 2 },
    ] }];
    const preview = data<Json>(await call('POST', '/admin/dungeons/validate', { definition, speciesScenario: { flags: ['open'], acquisitions: { [normal.slug]: 1 } } }));
    const p = preview.speciesPools[0];
    expect(p.base.entries.map((e: Json) => e.probability)).toEqual([0.5, 1 / 6, 1 / 3]);
    expect(p.scenario.entries.map((e: Json) => e.probability)).toEqual([0.5, 1 / 6, 1 / 3]);
    expect(p.scenario.entries.map((e: Json) => e.unavailableReason)).toEqual(['player_limit', 'not_permitted', null]);
    expect(p.scenario.nothingProbability).toBe(1 / 3); expect(p.scenario.unavailableProbability).toBe(2 / 3);
    const seen = data<Json>(await call('POST', '/admin/dungeons/validate', { definition, speciesScenario: { seenSpecies: [normal.slug] } }));
    expect(seen.speciesPools[0].scenario).toMatchObject({ totalWeight: 2, nothingProbability: 1 });
    expect(seen.speciesPools[0].scenario.entries.map((e: Json) => e.reason)).toEqual(['already_seen', 'condition', null]);
    expect((await call('POST', '/admin/dungeons/validate', { definition, speciesScenario: { acquisitions: { [normal.slug]: -1 } } })).statusCode).toBe(400);
    w.speciesAccess.delete(normal.slug);
  });
  it('saves and reloads stable pool identities and refuses publication through existing policy validation', async () => {
    const restricted = w.app.content.species.find((s) => s.enabled && s.tags.includes('region_exclusive'))!;
    const definition = definitionOf('pool_persistence');
    definition.speciesPools = [{ id: 'sp_stable', name: 'Pool', entries: [{ id: 'se_stable', species: restricted.slug, weight: 2, oncePerRun: false }, { id: 'none', nothing: true, weight: 1, text: 'Quiet.' }] }];
    definition.rooms[0].actions.unshift({ id: 'wild', type: 'wild_encounter', source: { kind: 'pool', poolId: 'sp_stable' }, intro: '', capture: {} });
    const created = data<Detail>(await call('POST', '/admin/dungeons/definitions', { definition }));
    const edited = structuredClone(created.draft); edited.speciesPools[0].name = 'Renamed'; edited.speciesPools[0].entries[0].weight = 7;
    const savedResponse = await call('PUT', `${base(definition.key)}/draft`, { expectedRevision: created.draftRevision, definition: edited });
    expect(savedResponse.statusCode).toBe(200);
    const saved = data<Detail>(savedResponse);
    const loaded = data<Detail>(await call('GET', base(definition.key)));
    expect(loaded.draft.speciesPools).toEqual(saved.draft.speciesPools);
    expect(loaded.draft.speciesPools[0]).toMatchObject({ id: 'sp_stable', name: 'Renamed', entries: [{ id: 'se_stable', weight: 7, oncePerRun: false }, { id: 'none', text: 'Quiet.' }] });
    const refused = await call('POST', `${base(definition.key)}/publish`, { expectedRevision: saved.draftRevision });
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused).details?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'species_not_permitted' })]));
    const duplicate = structuredClone(saved.draft); duplicate.speciesPools[0].entries.push({ ...duplicate.speciesPools[0].entries[0], id: 'dupe' });
    expect(data<Json>(await call('POST', '/admin/dungeons/validate', { definition: duplicate })).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'species_pool_duplicate_entry' })]));
    await w.t.db.update(species).set({ enabled: false }).where(eq(species.slug, restricted.slug));
    try {
      const catalogue = data<Json>(await call('GET', '/admin/dungeons/species?dungeonKey=pool_persistence'));
      expect(catalogue.species.find((s: Json) => s.slug === restricted.slug)).toMatchObject({ enabled: false, permitted: false, unavailableReason: 'disabled' });
    } finally { await w.t.db.update(species).set({ enabled: true }).where(eq(species.slug, restricted.slug)); }
  });
});

describe('P4C2B encounter authoring, presenter and isolated sandbox', () => {
  const stageUrl = '/admin/dungeons/encounter-preview';
  const sandboxUrl = '/admin/dungeons/sandbox';
  function encounterDefinition(key: string, mode: 'wild' | 'capture' | 'direct' = 'wild') {
    const normal = w.app.content.species.find((s) => s.enabled && !s.tags.includes('region_exclusive') && !s.tags.includes('dungeon_exclusive'))!;
    const definition = definitionOf(key);
    definition.flags = [...definition.flags, { key: 'acquired', scope: 'run', description: 'Found a companion' }];
    definition.rooms[0].actions = [{ id: 'encounter', type: mode === 'wild' ? 'wild_encounter' : 'rescue', ...(mode !== 'wild' ? { mode } : {}), source: { kind: 'species', species: normal.slug }, intro: 'She waits by the doorway.', ...(mode !== 'direct' ? { capture: { maxAttempts: 2, allowGuaranteedItems: false } } : {}), results: { [mode === 'wild' ? 'captured' : 'rescued']: { text: 'Together at last.', flags: [{ flag: 'acquired', value: true }] }, escaped: { text: 'She is gone.' }, unavailable: { text: 'She cannot join.' }, left: { text: 'You walk away.' }, nothing: { text: 'An empty doorway.' } }, outcomes: { [mode === 'wild' ? 'captured' : 'rescued']: { type: 'action', actionId: 'after' } } }, { id: 'after', type: 'rest', healBasisPoints: 0 }];
    if (mode === 'direct') { delete definition.rooms[0].actions[0].results.escaped; w.speciesAccess.set(normal.slug, [{ dungeon: key, perPlayerLimit: 1, directRescue: true }]); }
    return { definition, slug: normal.slug, roomId: definition.rooms[0].id, actionId: 'encounter' };
  }
  it('exposes live capture charms to readers; preview and sandbox remain permission gated', async () => {
    expect(data<Json>(await as(READER_TOKEN, 'GET', '/admin/dungeons/capture-items')).items.some((i: Json) => i.enabled && i.slug === 'basic_charm')).toBe(true);
    expect((await as(NON_OWNER_TOKEN, 'GET', '/admin/dungeons/capture-items')).statusCode).toBe(403);
    const d = encounterDefinition('authoring_permissions');
    expect((await as(NON_OWNER_TOKEN, 'POST', stageUrl, { ...d, stage: 'offered' })).statusCode).toBe(403);
    expect((await as(NON_OWNER_TOKEN, 'POST', sandboxUrl, { definition: d.definition })).statusCode).toBe(403);
  });
  it.each(['offered', 'captured', 'failure', 'escaped', 'left', 'nothing', 'unavailable'])(
    'renders the production wild presenter for %s without real writes', async (stage) => {
      const d = encounterDefinition(`authoring_${stage}`);
      const response = await call('POST', stageUrl, { definition: d.definition, roomId: d.roomId, actionId: d.actionId, species: d.slug, stage });
      expect(response.statusCode, response.body).toBe(200);
      const preview = data<Json>(response);
      expect(preview.simulated).toBe(true);
      expect(preview.embeds[0].title).toContain(d.definition.name);
      const fields = JSON.stringify(preview.embeds);
      const expected: Record<string, RegExp> = { offered: /She waits by the doorway/, captured: /Together at last/, failure: /failed|missed|Attempts left/i, escaped: /She is gone/, left: /You walk away/, nothing: /An empty doorway/, unavailable: /She cannot join/ };
      expect(fields).toMatch(expected[stage]!);
      expect(JSON.stringify(preview.components)).not.toContain('dg|fight');
    },
  );
  it.each(['capture', 'direct'] as const)('previews %s rescue through production presentation', async (mode) => {
    const d = encounterDefinition(`authoring_rescue_${mode}`, mode);
    try {
      const offered = data<Json>(await call('POST', stageUrl, { definition: d.definition, roomId: d.roomId, actionId: d.actionId, stage: 'offered' }));
      expect(JSON.stringify(offered)).toMatch(mode === 'direct' ? /Rescue her/ : /capture charm/);
      const done = await call('POST', stageUrl, { definition: d.definition, roomId: d.roomId, actionId: d.actionId, stage: 'rescued' });
      expect(done.statusCode, done.body).toBe(200); expect(JSON.stringify(data<Json>(done))).toContain('Together at last.');
    } finally { w.speciesAccess.delete(d.slug); }
  });
  it('runs real capture success/failure, routing and flags; consumes simulated quantities across attempts', async () => {
    const d = encounterDefinition('authoring_sandbox');
    const inputs = [{ type: 'select_item', item: 'basic_charm' }, { type: 'capture' }];
    const successResponse = await call('POST', sandboxUrl, { definition: d.definition, inventory: { basic_charm: 2 }, inputs, encounterScenario: { captureOutcome: 'success' } });
    expect(successResponse.statusCode, successResponse.body).toBe(200);
    const success = data<Json>(successResponse);
    expect(success.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'capture_attempt', attempt: expect.objectContaining({ success: true }) })]));
    expect(success.view.flags.acquired).toBe(true); expect(success.view.action.id).toBe('after');
    expect(success.simulatedGrants[0]).toMatchObject({ copies: 1, success: true, item: 'basic_charm' });
    expect(success.simulatedGrants[0].xp).toBeGreaterThan(0);
    const failure = data<Json>(await call('POST', sandboxUrl, { definition: d.definition, inventory: { basic_charm: 2 }, inputs, encounterScenario: { captureOutcome: 'failure' } }));
    expect(failure.view.action.encounter.attemptsLeft).toBe(1); expect(failure.view.action.encounter.items.find((i: Json) => i.item === 'basic_charm').owned).toBe(1);
    expect(failure.simulatedGrants[0]).toMatchObject({ copies: 0, success: false, item: 'basic_charm' });
    const escaped = data<Json>(await call('POST', sandboxUrl, { definition: d.definition, inventory: { basic_charm: 2 }, inputs: [...inputs, { type: 'capture' }], encounterScenario: { captureOutcome: 'failure' } }));
    expect(escaped.state.encounters[`${d.roomId}:encounter`].status).toBe('escaped');
    const insufficient = data<Json>(await call('POST', sandboxUrl, { definition: d.definition, inventory: { basic_charm: 1 }, inputs: [...inputs, { type: 'capture' }], encounterScenario: { captureOutcome: 'failure' } }));
    expect(insufficient.refusal).toBe('capture_item_unavailable'); expect(insufficient.effects).toHaveLength(1);
    const normal1 = data<Json>(await call('POST', sandboxUrl, { definition: d.definition, seed: 42, inventory: { basic_charm: 2 }, inputs }));
    const normal2 = data<Json>(await call('POST', sandboxUrl, { definition: d.definition, seed: 42, inventory: { basic_charm: 2 }, inputs }));
    expect(normal1).toEqual(normal2);
  });
  it('simulates authorized direct rescue, finite limits, species disables and seeded conditions', async () => {
    const d = encounterDefinition('authoring_direct', 'direct');
    try {
      const rescued = data<Json>(await call('POST', sandboxUrl, { definition: d.definition, inputs: [{ type: 'rescue' }] }));
      expect(rescued.view.flags.acquired).toBe(true); expect(rescued.simulatedGrants[0]).toMatchObject({ copies: 1, item: null, success: true });
      const limited = data<Json>(await call('POST', sandboxUrl, { definition: d.definition, encounterScenario: { acquisitions: { [d.slug]: 1 } } }));
      expect(limited.state.encounters[`${d.roomId}:encounter`]).toMatchObject({ status: 'unavailable', unavailableReason: 'player_limit' });
      expect(limited.effects).toEqual([]);
      const disabled = data<Json>(await call('POST', sandboxUrl, { definition: d.definition, encounterScenario: { disabledSpecies: [d.slug] } }));
      expect(disabled.encounterDiagnostics[0].reason).toBe('disabled'); expect(disabled.simulatedGrants).toEqual([]);
      d.definition.rooms[0].actions[0].when = { type: 'flag', flag: 'acquired' };
      const seeded = await call('POST', sandboxUrl, { definition: d.definition, encounterScenario: { flags: ['acquired'] } });
      expect(seeded.statusCode, seeded.body).toBe(200); expect(data<Json>(seeded).view.action.encounter.species).toBe(d.slug);
    } finally { w.speciesAccess.delete(d.slug); }
  });
  it('sandbox and presenter requests leave every gameplay and authoring database row unchanged', async () => {
    const d = encounterDefinition('authoring_isolation');
    const fingerprint = async () => {
      const tables = await w.t.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
      const result: Record<string, unknown> = {};
      for (const { tablename } of tables.rows) {
        // Database schema tables are test-owned; names are server-selected and quoted.
        const rows = await w.t.pool.query(`SELECT md5(coalesce(string_agg(row_to_json(t)::text || t.xmin::text, '' ORDER BY row_to_json(t)::text || t.xmin::text), '')) AS hash, count(*)::int AS count FROM "${tablename.replaceAll('"', '""')}" t`);
        result[tablename] = rows.rows[0];
      }
      return result;
    };
    const before = await fingerprint();
    for (const captureOutcome of ['success', 'failure', 'normal']) expect((await call('POST', sandboxUrl, { definition: d.definition, inventory: { basic_charm: 3 }, inputs: [{ type: 'select_item', item: 'basic_charm' }, { type: 'capture' }], encounterScenario: { captureOutcome } })).statusCode).toBe(200);
    expect((await call('POST', stageUrl, { definition: d.definition, roomId: d.roomId, actionId: 'encounter', stage: 'captured' })).statusCode).toBe(200);
    const direct = encounterDefinition('authoring_isolation_direct', 'direct');
    try { expect((await call('POST', sandboxUrl, { definition: direct.definition, inputs: [{ type: 'rescue' }] })).statusCode).toBe(200); } finally { w.speciesAccess.delete(direct.slug); }
    expect(await fingerprint()).toEqual(before);
  });
  it('preserves missing references, invalid authorization and publication/package gates in repair drafts', async () => {
    const d = encounterDefinition('authoring_repair', 'direct'); w.speciesAccess.delete(d.slug);
    const createdResponse = await call('POST', '/admin/dungeons/definitions', { definition: d.definition });
    expect(createdResponse.statusCode, createdResponse.body).toBe(201);
    const created = data<Detail>(createdResponse);
    expect(created.issues.some((i: Json) => i.code === 'rescue_direct_not_permitted')).toBe(true);
    expect((await call('POST', `${base(d.definition.key)}/publish`, { expectedRevision: created.draftRevision })).statusCode).toBe(400);
    d.definition.rooms[0].actions[0].source = { kind: 'pool', poolId: 'missing_pool' };
    const saved = data<Detail>(await call('PUT', `${base(d.definition.key)}/draft`, { expectedRevision: created.draftRevision, definition: d.definition }));
    expect(saved.draft.rooms[0].actions[0].source.poolId).toBe('missing_pool'); expect(saved.issues.some((i: Json) => i.code === 'species_pool_missing')).toBe(true);
    expect((await call('GET', `${base(d.definition.key)}/export?origin=draft`)).statusCode).toBe(400);
  });
  it('reports published species drift, republishing metadata and old revisions with active runs; missing evidence stays unknown', async () => {
    const d = encounterDefinition('authoring_drift');
    const created = data<Detail>(await call('POST', '/admin/dungeons/definitions', { definition: d.definition }));
    const first = data<Json>(await call('POST', `${base(d.definition.key)}/publish`, { expectedRevision: created.draftRevision }));
    expect(first.dungeon.speciesDiffer).toBe(false);
    const initial = data<Json>(await call('GET', `${base(d.definition.key)}/species-status`));
    expect(initial.revisions[0]).toMatchObject({ evidence: 'recorded', differs: false, current: true });
    const [row] = await w.t.db.select().from(species).where(eq(species.slug, d.slug));
    await w.t.db.update(species).set({ rarity: row!.rarity === 'N' ? 'R' : 'N' }).where(eq(species.slug, d.slug));
    try {
      const drift = data<Json>(await call('GET', `${base(d.definition.key)}/species-status`));
      expect(drift.revisions[0].dependencies[0].changes.join(' ')).toContain('Rarity changed');
      expect(data<Json>(await call('GET', base(d.definition.key))).speciesDiffer).toBe(true);
      const player = await w.player(); const run = await w.runs.start(player.playerId, d.definition.key, { seed: 1 });
      const second = data<Json>(await call('POST', `${base(d.definition.key)}/publish`, { expectedRevision: created.draftRevision }));
      expect(second.unchanged).toBe(false); expect(second.revision.contentHash).toBe(first.revision.contentHash);
      const current = data<Json>(await call('GET', `${base(d.definition.key)}/species-status`));
      expect(current.revisions).toHaveLength(2); expect(current.revisions.find((r: Json) => !r.current)).toMatchObject({ revision: 1, activeRuns: 1, differs: true });
      expect((await w.runs.run(player.playerId, run.id)).dungeon.revision).toBe(1);
      await w.t.db.update(dungeonContentEvents).set({ details: {} }).where(eq(dungeonContentEvents.dungeonKey, d.definition.key));
      expect(data<Json>(await call('GET', `${base(d.definition.key)}/species-status`)).revisions[0]).toMatchObject({ evidence: 'unknown', differs: null });
      expect((await as(NON_OWNER_TOKEN, 'GET', `${base(d.definition.key)}/species-status`)).statusCode).toBe(403);
    } finally { await w.t.db.update(species).set({ rarity: row!.rarity }).where(eq(species.slug, d.slug)); }
  });
});

describe('P4C2B production encounter scene endpoint', () => {
  it('renders placement, mirroring, Buddy and both environmental scopes with production fallback and permissions', async () => {
    const slug = w.app.content.species.find((s) => s.enabled && !s.tags.includes('region_exclusive'))!.slug;
    const spritePath = path.join(assetsDir, 'waifumon', slug, `${slug}_sprite.webp`);
    fs.mkdirSync(path.dirname(spritePath), { recursive: true });
    fs.writeFileSync(spritePath, await twoToneSprite(300, 300, GREEN, RED));
    const background = 'dungeons/backgrounds/encounter.png'; fs.writeFileSync(path.join(assetsDir, background), await solidImage(1200, 675, BLUE));
    const placement = { ...DEFAULT_SPRITE_PLACEMENT, anchor: 'bottom-right' as const, scaleBasisPoints: 5000, offsetX: -80 };
    const body = { encounter: { species: slug, placement, mirror: false }, backgrounds: [{ kind: 'shipped', path: background }] };
    const response = await call('POST', '/admin/dungeons/scene-preview', body);
    expect(response.statusCode, response.body).toBe(200); expect(response.headers['x-dungeon-scene']).toBe('sprite');
    const box = layoutSprite({ width: 300, height: 300 }, placement, { width: 1200, height: 675 });
    const x = Math.round(box.left + box.width * .3), y = Math.round(box.top + box.height * .5);
    expect(isNear(await pixelAt(response.rawPayload, x, y), GREEN)).toBe(true);
    const mirrored = await call('POST', '/admin/dungeons/scene-preview', { ...body, encounter: { ...body.encounter, mirror: true } });
    expect(isNear(await pixelAt(mirrored.rawPayload, x, y), RED)).toBe(true);
    const service = createSceneSpriteService({ db: w.t.db, assets: w.assets });
    const back = await w.assets.upload({ category: 'dungeon_scene_sprite', bytes: await transparentSprite(300, 300, GREEN), name: 'Back' }, OWNER_ID);
    const front = await w.assets.upload({ category: 'dungeon_scene_sprite', bytes: await transparentSprite(300, 300, RED), name: 'Front' }, OWNER_ID);
    await service.create('authoring_back', { name: 'Back', assetId: back.id, placement: { ...placement, anchor: 'center', offsetX: -300 }, visualLayer: 'background' }, OWNER_ID);
    const foregroundPlacement = { ...placement, anchor: 'bottom-left' as const, scaleBasisPoints: 2000, offsetX: 100 };
    await service.create('authoring_front', { name: 'Front', assetId: front.id, placement: foregroundPlacement, visualLayer: 'foreground' }, OWNER_ID);
    const combined = await call('POST', '/admin/dungeons/scene-preview', { ...body, roomSprites: [{ id: 'back', spriteKey: 'authoring_back' }], activitySprites: [{ id: 'front', spriteKey: 'authoring_front' }] });
    expect(combined.statusCode, combined.body).toBe(200); expect(combined.rawPayload).not.toEqual(response.rawPayload);
    const frontBox = layoutSprite({ width: 300, height: 300 }, foregroundPlacement, { width: 1200, height: 675 });
    expect(isNear(await pixelAt(combined.rawPayload, Math.round(frontBox.left + frontBox.width / 2), Math.round(frontBox.top + frontBox.height / 2)), RED)).toBe(true);
    const terminal = await call('POST', '/admin/dungeons/scene-preview', { ...body, encounter: { ...body.encounter, stage: 'left' } });
    expect(terminal.statusCode).toBe(200); expect(terminal.rawPayload).not.toEqual(response.rawPayload);
    expect((await as(NON_OWNER_TOKEN, 'POST', '/admin/dungeons/scene-preview', body)).statusCode).toBe(403);
    expect((await call('POST', '/admin/dungeons/scene-preview', { ...body, encounter: { species: '../secret' } })).statusCode).toBe(400);
    fs.rmSync(spritePath);
    const fallbackSpecies = w.app.appearance.speciesContent(slug)!;
    const look = w.app.appearance.currentAppearance(fallbackSpecies, null);
    const standardPath = path.join(assetsDir, `${look.assetId.kind}/${look.assetId.slug}/${look.assetId.variant}.png`);
    fs.mkdirSync(path.dirname(standardPath), { recursive: true }); fs.writeFileSync(standardPath, await solidImage(100, 150, GREEN));
    const fallback = await call('POST', '/admin/dungeons/scene-preview', body);
    expect(fallback.statusCode, fallback.body).toBe(200); expect(fallback.headers['x-dungeon-scene']).toBe('full-art');
    expect(fallback.rawPayload).toEqual(fs.readFileSync(standardPath));
  });
});

describe('P4C2B preview mechanics edge cases', () => {
  it('labels the extra remaining attempt simulation and refuses failure with guaranteed-only charms', async () => {
    const definition = definitionOf('preview_mechanics');
    const slug = w.app.content.species.find((s) => s.enabled && !s.tags.includes('region_exclusive') && !s.tags.includes('dungeon_exclusive'))!.slug;
    definition.rooms[0].actions.unshift({ id: 'wild', type: 'wild_encounter', source: { kind: 'species', species: slug }, intro: '', capture: { maxAttempts: 1, allowGuaranteedItems: false } });
    const body = { definition, roomId: definition.rooms[0].id, actionId: 'wild', stage: 'failure' };
    const response = await call('POST', '/admin/dungeons/encounter-preview', body);
    expect(response.statusCode, response.body).toBe(200);
    expect(data<Json>(response).context).toContain('would escape instead');
    expect(JSON.stringify(data<Json>(response).embeds)).toContain('Used');
    definition.rooms[0].actions[0].capture = { maxAttempts: 1, allowGuaranteedItems: true, allowedItems: ['mythic_contract'] };
    const impossible = await call('POST', '/admin/dungeons/encounter-preview', body);
    expect(impossible.statusCode, impossible.body).toBe(400);
    expect(errorOf(impossible).message).toContain('non-guaranteed charm');
  });
});


describe('shared Dungeon WaifuMon Pools API', () => {
  const root = '/admin/dungeons/waifumon-pools';
  const definition = { key: 'api_shared_pool', name: 'API pool', description: '', enabled: false, entries: [{ id: 'e', species: 'neko_barista', weight: 2, oncePerRun: true }] };
  it('enforces read/write permissions and authenticated access', async () => {
    expect((await api.inject({ method: 'GET', url: `/api/v1${root}` })).statusCode).toBe(401);
    expect((await as(NON_OWNER_TOKEN, 'GET', root)).statusCode).toBe(403);
    expect((await as(READER_TOKEN, 'GET', root)).statusCode).toBe(200);
    for (const token of [READER_TOKEN, PUBLISHER_TOKEN]) {
      expect((await as(token, 'POST', root, definition)).statusCode).toBe(403);
      expect((await as(token, 'POST', `${root}/import`, { package: {}, expectedRevisions: {} })).statusCode).toBe(403);
    }
    expect((await as(WRITER_TOKEN, 'POST', root, definition)).statusCode).toBe(200);
  });
  it('reads, edits, rejects stale revisions, duplicates disabled, exports/imports and exposes references/history', async () => {
    const read = await as(READER_TOKEN, 'GET', `${root}/api_shared_pool`);
    expect(data<Json>(read)).toMatchObject({ revision: 1, definition });
    const enabled = await as(WRITER_TOKEN, 'POST', `${root}/api_shared_pool/enabled`, { enabled: true, expectedRevision: 1 });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const stale = await as(WRITER_TOKEN, 'PUT', `${root}/api_shared_pool`, { definition, expectedRevision: 1 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(errorOf(stale).details).toMatchObject({ currentRevision: 2 });
    expect((await as(WRITER_TOKEN, 'POST', `${root}/api_shared_pool/duplicate`, { key: 'api_shared_copy', expectedRevision: 2 })).statusCode).toBe(200);
    expect(data<Json>(await as(READER_TOKEN, 'GET', `${root}/api_shared_copy`)).definition.enabled).toBe(false);
    const pkg = data<Json>(await as(READER_TOKEN, 'GET', `${root}/export?key=api_shared_pool`));
    pkg.pools[0].key = 'api_shared_import';
    const imported = await as(WRITER_TOKEN, 'POST', `${root}/import`, { package: pkg, expectedRevisions: { api_shared_import: null } });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(data<Json[]>(imported)[0]!.definition.enabled).toBe(false);
    expect(data<unknown[]>(await as(READER_TOKEN, 'GET', `${root}/api_shared_pool/references`))).toEqual([]);
    expect(data<Json[]>(await as(READER_TOKEN, 'GET', `${root}/api_shared_pool/history`)).map(e => e.action)).toEqual(['created', 'enabled']);
    expect((await as(WRITER_TOKEN, 'DELETE', `${root}/api_shared_pool`)).statusCode).toBe(404);
    expect((await as(WRITER_TOKEN, 'PUT', `${root}/api_shared_pool`, { definition: { ...definition, entries: [{ id: 'e', species: 'missing', weight: 1 }] }, expectedRevision: 2 })).statusCode).toBe(400);
  });
});


describe('Dungeon species reference region metadata', () => {
  it('reports published multi-region membership, all supported regions, and independent exclusivity without writes', async () => {
    for (const regionId of ['waifu-valley', 'twin-peeks'] as const) {
      await w.t.db.insert(regionPools).values({ regionId, draftEntries: [], draftHash: `sha256:${'0'.repeat(64)}` }).onConflictDoNothing();
      await publishRegionPoolRevisionForTest(w.t.db, regionId, [{ species: 'neko_barista', weight: 1 }]);
      await w.t.db.update(regionPools).set({ draftEntries: [{ species: 'gym_oni', weight: 10 }] }).where(eq(regionPools.regionId, regionId));
    }
    const snapshot = async () => ({ pools: await w.t.db.select().from(regionPools), revisions: await w.t.db.select().from(regionPoolRevisions), entries: await w.t.db.select().from(regionPoolRevisionEntries), hunting: await w.t.db.select().from(regionEncounterPools), species: await w.t.db.select().from(species) });
    const before = await snapshot();
    const result = await as(READER_TOKEN, 'GET', '/admin/dungeons/species?dungeonKey=shared_pool_catalogue');
    expect(result.statusCode, result.body).toBe(200);
    const response = data<Json>(result);
    expect(response.regions.map((r: Json) => r.id)).toEqual([...REGIONS]);
    expect(response.regions.every((r: Json) => !!r.name)).toBe(true);
    expect(response.species.find((s: Json) => s.slug === 'neko_barista').regions).toEqual(expect.arrayContaining(['twin-peeks', 'waifu-valley']));
    const publishedIds = new Set(before.pools.map(p => p.publishedRevisionId));
    const assigned = new Set(before.entries.filter(e => publishedIds.has(e.revisionId)).map(e => e.speciesId));
    const unassignedRow = before.species.find(s => !assigned.has(s.id))!;
    expect(unassignedRow).toBeDefined();
    const unassigned = response.species.find((s: Json) => s.slug === unassignedRow.slug);
    expect(unassigned.regions).toEqual([]);
    expect(response.species.find((s: Json) => s.slug === 'gym_oni').regions).not.toEqual(expect.arrayContaining(['waifu-valley', 'twin-peeks']));
    expect(unassigned.dungeonExclusive).toBe(before.species.find(s => s.slug === unassigned.slug)!.tags.includes('dungeon_exclusive'));
    expect(await snapshot()).toEqual(before);
  });
});
