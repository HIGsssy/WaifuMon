/**
 * Boss artwork over the Admin API, against a real database and a real
 * (temporary) managed artwork store: what an upload must be, the library and
 * who uses what, assigning an upload to a boss, the delete guard, who may do
 * any of it, that shipped artwork paths keep working untouched — and that an
 * uploaded image is what an encounter announces with.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import {
  artworkAssetEvents,
  artworkAssets,
  bossDefinitionEvents,
  bossDefinitions,
  bossEncounters,
  bossParticipations,
  guildBossState,
  guilds,
} from '../../../src/db/schema';
import { resolveBossArtwork } from '../../../src/discord/bossArtwork';
import { buildAnnouncement } from '../../../src/discord/bossPresenter';
import { createArtworkAssetService, type ArtworkAssetService } from '../../../src/modules/artworkAssets/artworkAssetService';
import { createLocalArtworkStorage } from '../../../src/modules/artworkAssets/artworkStorage';
import { ARTWORK_UPLOAD_MAX_BYTES } from '../../../src/modules/artworkAssets/imageInspection';
import { BOSS_ARTWORK_MAX_EDGE, createBossArtworkService } from '../../../src/modules/bosses/bossArtworkService';
import { bootstrapBossDefinitions, createDatabaseBossDefinitionSource } from '../../../src/modules/bosses/bossDefinitions';
import { createBossDefinitionService } from '../../../src/modules/bosses/bossDefinitionService';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import {
  createPortalAuthorizationService,
  type PortalAuthorizationService,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { BLUE, GREEN, RED, solidImage } from '../../helpers/imageFixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555661';
const OWNER_ID = '777888999000111661';
const PLAYER_ID = '999999999999999661';
const EDITOR_ID = '555000000000000661';
const OPERATOR_ID = '555000000000000662';
const READER_ID = '555000000000000663';
const TOKENS: Record<string, string> = {
  'token-owner': OWNER_ID,
  'token-player': PLAYER_ID,
  'token-editor': EDITOR_ID,
  'token-operator': OPERATOR_ID,
  'token-reader': READER_ID,
};
const CSRF = 'csrf-token';
const TABLE = 'standard-scouting-v1';
const SHIPPED = 'bosses/shipped_one.webp';

let t: TestDb;
let app: App;
let api: ZodFastify;
let assets: ArtworkAssetService;
let guildDbId: number;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-boss-artwork-api-'));
const storageDir = path.join(root, 'managed');
const assetsDir = path.join(root, 'assets');
fs.mkdirSync(path.join(assetsDir, 'bosses'), { recursive: true });

type Json = Record<string, any>;

/** Every regular file under a directory, relative, sorted. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...AUTH_BEARER, ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const data = async (url: string): Promise<Json> => (await call('GET', url)).json().data;
const asCookie = (token: string) => ({
  cookies: { wm_portal_session: token, wm_portal_csrf: CSRF },
  headers: { 'x-portal-csrf': CSRF },
});

const uploadUrl = (params: Record<string, string> = {}) => {
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `/api/v1/admin/bosses/artwork/assets${query ? `?${query}` : ''}`;
};
const upload = (bytes: Buffer, params: Record<string, string> = {}, contentType = 'application/octet-stream') =>
  api.inject({ method: 'POST', url: uploadUrl(params), headers: { ...AUTH_BEARER, 'content-type': contentType }, payload: bytes });
async function uploaded(bytes: Buffer, params: Record<string, string> = {}): Promise<Json> {
  const res = await upload(bytes, params);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.asset;
}
const fileOf = (id: string, headers: Record<string, string> = {}, v?: string) =>
  api.inject({
    method: 'GET',
    url: `/api/v1/admin/bosses/artwork/assets/${id}/file${v ? `?v=${v}` : ''}`,
    headers: { ...AUTH_BEARER, ...headers },
  });

const body = (over: Json = {}) => ({
  name: 'Art Boss',
  affinity: 'primal',
  regions: ['waifu-valley'],
  status: 'active',
  artwork: null,
  rewardTable: TABLE,
  scoutingText: 'It arrives.',
  repelledText: 'It leaves, beaten.',
  unchallengedText: 'It leaves, bored.',
  description: 'A boss with a picture.',
  ...over,
});
async function createBoss(id: string, over: Json = {}): Promise<Json> {
  const res = await call('POST', '/admin/bosses', { id, boss: body(over) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
}
const FIELDS = ['name', 'affinity', 'regions', 'status', 'artwork', 'artworkAssetId', 'rewardTable', 'scoutingText', 'repelledText', 'unchallengedText', 'description', 'schedule'];
async function save(id: string, change: Json) {
  const current = await data(`/admin/bosses/${id}`);
  const boss = Object.fromEntries(FIELDS.map((key) => [key, current[key]]));
  return call('PUT', `/admin/bosses/${id}`, { boss: { ...boss, ...change }, expectedRevision: current.revision });
}
const assetEvents = async (id: string) =>
  (await t.db.select().from(artworkAssetEvents).where(eq(artworkAssetEvents.assetId, id)).orderBy(artworkAssetEvents.id)).map((e) => ({
    action: e.action,
    actor: e.actor,
    details: e.details,
  }));
const storedRow = async (id: string) => (await t.db.select().from(artworkAssets).where(eq(artworkAssets.id, id)))[0]!;

beforeAll(async () => {
  fs.writeFileSync(path.join(assetsDir, SHIPPED), await solidImage(64, 48, GREEN, 'webp'));
  t = await createTestDb();
  app = await bootstrapApp(t, {
    bossDefinitions: createDatabaseBossDefinitionSource(),
  });
  ({ guildDbId } = await provisionPlayer(app, GUILD_ID, OWNER_ID));
  await provisionPlayer(app, GUILD_ID, PLAYER_ID);

  assets = createArtworkAssetService({ db: t.db, storage: createLocalArtworkStorage(storageDir) });
  const bossDefinitionService = createBossDefinitionService({
    db: t.db,
    getShippedIds: () => app.content.bosses.map((b) => b.id),
    getEnabledRegions: () => app.content.tables.bossEncounters.regions,
    // Boss reward tables are content on this branch: `content/bossRewards.json`.
    listRewardTables: async () => app.content.bossRewards.map((table) => ({ id: table.id, enabled: table.enabled })),
    assets,
  });
  const bossArtwork = createBossArtworkService({ db: t.db, assets, assetsDir });

  const guildOwnership = createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID });
  const ownerOnly = createPortalAuthorizationService({ guildOwnership });
  const granted: Record<string, PortalPermission[]> = {
    [EDITOR_ID]: ['admin.access', 'bosses.read', 'bosses.write'],
    [OPERATOR_ID]: ['admin.access', 'bosses.read', 'bosses.operate'],
    [READER_ID]: ['admin.access', 'bosses.read'],
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
    selectedGuildDbId: guildDbId,
    playerId: 1,
    eligibleGuilds: [],
    csrfToken: CSRF,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const sessions = {
    getSession: async (token: string | undefined) => (token && TOKENS[token] ? session(TOKENS[token]!) : null),
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
    config: { enabled: true, host: '127.0.0.1', port: 3141, token: TEST_TOKEN, adminBearer: true },
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
      services: { ...app, bossDefinitions: bossDefinitionService, artworkAssets: assets, bossArtwork },
      getContent: () => app.content,
      assetsDir,
      portalAuthorization,
      adminBearerAllowed: true,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await t.db.delete(bossParticipations);
  await t.db.delete(bossEncounters);
  await t.db.delete(guildBossState);
  await t.db.delete(bossDefinitionEvents);
  await t.db.delete(bossDefinitions);
  await t.db.delete(artworkAssetEvents);
  await t.db.delete(artworkAssets);
  fs.rmSync(storageDir, { recursive: true, force: true });
  await t.db.update(guilds).set({ bossChannelId: 'c-boss-art' }).where(eq(guilds.id, guildDbId));
  await bootstrapBossDefinitions(t.db, app.content.bosses);
});

describe('upload validation', () => {
  it('stores a PNG as WebP under a server-generated name, and reports what it stored', async () => {
    const asset = await uploaded(await solidImage(320, 200, RED, 'png'), { filename: 'Candy Gobbler.png' });
    expect(asset).toMatchObject({
      name: 'Candy Gobbler',
      originalFilename: 'Candy Gobbler.png',
      mimeType: 'image/webp',
      width: 320,
      height: 200,
      version: 1,
      status: 'active',
    });
    expect(asset).not.toHaveProperty('storageKey');
    expect(filesUnder(storageDir)).toEqual([`boss_art/${asset.id}/${asset.contentHash}.webp`]);
    expect((await storedRow(asset.id)).category).toBe('boss_art');
  });

  it('accepts JPEG too, whatever Content-Type the client declares', async () => {
    const asset = await uploaded(await solidImage(120, 90, BLUE, 'jpeg'), { filename: 'photo.png' });
    expect(asset.mimeType).toBe('image/webp');
    const lied = await upload(await solidImage(64, 64, BLUE, 'webp'), {}, 'image/png');
    expect(lied.statusCode, lied.body).toBe(200);
  });

  it('stores a WebP that is already small enough byte for byte', async () => {
    const bytes = await solidImage(400, 300, GREEN, 'webp');
    const asset = await uploaded(bytes);
    expect(asset.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await fileOf(asset.id)).rawPayload.equals(bytes)).toBe(true);
  });

  it('scales an oversized image down to the stored maximum, keeping its shape', async () => {
    const asset = await uploaded(await solidImage(3000, 1500, RED, 'webp'));
    expect([asset.width, asset.height]).toEqual([BOSS_ARTWORK_MAX_EDGE, BOSS_ARTWORK_MAX_EDGE / 2]);
    const meta = await sharp((await fileOf(asset.id)).rawPayload).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', BOSS_ARTWORK_MAX_EDGE, BOSS_ARTWORK_MAX_EDGE / 2]);
  });

  it('refuses anything that is not a real PNG, WebP or JPEG', async () => {
    const png = await solidImage(64, 64, RED, 'png');
    const refused: Array<[string, Buffer]> = [
      ['text', Buffer.from('this is not an image')],
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ['gif', Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!', 'latin1')],
      ['html', Buffer.from('<!doctype html><html><body>hi</body></html>')],
      ['truncated png', png.subarray(0, 40)],
      ['png signature, garbage body', Buffer.concat([png.subarray(0, 8), Buffer.alloc(200, 7)])],
    ];
    for (const [what, bytes] of refused) {
      const res = await upload(bytes, { filename: 'boss.png' }, 'image/png');
      expect(res.statusCode, what).toBe(400);
      expect(res.json().error.code, what).toBe('ARTWORK_UPLOAD_INVALID');
    }
    expect((await upload(await solidImage(4, 4, RED, 'png'))).statusCode).toBe(400);
    expect((await upload(await solidImage(5000, 16, RED, 'png'))).statusCode).toBe(400);
    expect(await t.db.select().from(artworkAssets)).toEqual([]);
    expect(filesUnder(storageDir)).toEqual([]);
  });

  it('refuses an empty body and a body over the size limit', async () => {
    const empty = await upload(Buffer.alloc(0));
    expect(empty.statusCode).toBe(400);
    const huge = await upload(Buffer.alloc(ARTWORK_UPLOAD_MAX_BYTES + 1, 1));
    expect(huge.statusCode).toBe(413);
    expect(filesUnder(storageDir)).toEqual([]);
  });

  it('never lets a file name reach the filesystem', async () => {
    const names = ['../../../etc/passwd.png', '..\\..\\windows\\system32\\evil.png', '/abs/olute.png', 'nul\u0000byte.png', '.hidden.png'];
    for (const filename of names) {
      const asset = await uploaded(await solidImage(32, 32, RED, 'png'), { filename });
      expect(asset.originalFilename, filename).not.toMatch(/[\\/\u0000]|^\./);
    }
    const stored = filesUnder(storageDir);
    expect(stored).toHaveLength(names.length);
    for (const file of stored) {
      expect(file).toMatch(/^boss_art\/[0-9a-f-]{36}\/[0-9a-f]{64}\.webp$/);
    }
    // Nothing escaped the store.
    expect(filesUnder(root).filter((f) => !f.startsWith('managed/') && !f.startsWith('assets/'))).toEqual([]);
  });
});

describe('the artwork library', () => {
  it('lists shipped files and uploads, each with the bosses that use it', async () => {
    const asset = await uploaded(await solidImage(200, 100, RED, 'png'), { name: 'Uploaded one' });
    const spare = await uploaded(await solidImage(100, 100, BLUE, 'png'), { name: 'Spare' });
    await createBoss('on_shipped', { name: 'On Shipped', artwork: SHIPPED });
    await createBoss('on_upload', { name: 'On Upload', artworkAssetId: asset.id, status: 'draft' });

    const library = await data('/admin/bosses/artwork/library');
    expect(library.limits).toEqual({
      mimeTypes: ['image/webp', 'image/png', 'image/jpeg'],
      maxBytes: ARTWORK_UPLOAD_MAX_BYTES,
      maxDimension: 4096,
      storedMaxEdge: BOSS_ARTWORK_MAX_EDGE,
    });
    expect(library.shipped.find((s: Json) => s.path === SHIPPED)).toEqual({
      path: SHIPPED,
      exists: true,
      usedBy: [{ id: 'on_shipped', name: 'On Shipped', status: 'active' }],
    });
    // A shipped boss names a path this (temporary) assets directory has no file for: still listed, marked missing.
    const shippedBoss = app.content.bosses.find((b) => b.artwork)!;
    expect(library.shipped.find((s: Json) => s.path === shippedBoss.artwork)).toMatchObject({
      exists: false,
      usedBy: expect.arrayContaining([expect.objectContaining({ id: shippedBoss.id })]),
    });
    const byId = new Map<string, Json>(library.managed.map((m: Json) => [m.asset.id, m]));
    expect(byId.get(asset.id)).toMatchObject({
      asset: { id: asset.id, name: 'Uploaded one', width: 200, height: 100 },
      usedBy: [{ id: 'on_upload', name: 'On Upload', status: 'draft' }],
    });
    expect(byId.get(spare.id)!.usedBy).toEqual([]);
  });

  it('describes one upload: metadata, usage, references and history', async () => {
    const asset = await uploaded(await solidImage(200, 100, RED, 'png'));
    await createBoss('user_one', { name: 'User One', artworkAssetId: asset.id });
    const detail = await data(`/admin/bosses/artwork/assets/${asset.id}`);
    expect(detail.asset).toMatchObject({ id: asset.id, mimeType: 'image/webp', fileSize: asset.fileSize });
    expect(detail.usedBy).toEqual([{ id: 'user_one', name: 'User One', status: 'active' }]);
    expect(detail.references).toEqual([{ kind: 'boss', key: 'user_one', name: 'User One', field: 'artworkAssetId' }]);
    expect(detail.events.map((e: Json) => e.action)).toEqual(['reference_added', 'upload']);
  });

  it('serves the bytes as data, with a hash ETag and an immutable versioned URL', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    const res = await fileOf(asset.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers.etag).toBe(`"${asset.contentHash}"`);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect((await fileOf(asset.id, {}, asset.contentHash)).headers['cache-control']).toContain('immutable');
    expect((await fileOf(asset.id, { 'if-none-match': `"${asset.contentHash}"` })).statusCode).toBe(304);
  });

  it('reaches boss artwork only: another category’s asset is not found here', async () => {
    const other = await assets.upload({ bytes: await solidImage(64, 64, RED, 'png'), category: 'enemy_art' }, 'admin-x');
    expect((await call('GET', `/admin/bosses/artwork/assets/${other.id}`)).statusCode).toBe(404);
    expect((await fileOf(other.id)).statusCode).toBe(404);
    expect((await call('DELETE', `/admin/bosses/artwork/assets/${other.id}`)).statusCode).toBe(404);
    expect((await data('/admin/bosses/artwork/library')).managed).toEqual([]);
    expect((await storedRow(other.id)).status).toBe('active');
    expect((await call('GET', '/admin/bosses/artwork/assets/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('REGRESSION: a library larger than one page of the artwork store', () => {
  it('lists every upload past the store’s 200-row page, with usage, so none is unreachable', async () => {
    const TOTAL = 205;
    const rows = Array.from({ length: TOTAL }, (_, i) => {
      const n = String(i).padStart(3, '0');
      return {
        id: `00000000-0000-4000-8000-000000000${n}`,
        category: 'boss_art' as const,
        name: `Bulk ${n}`,
        originalFilename: `bulk-${n}.webp`,
        mimeType: 'image/webp' as const,
        width: 64,
        height: 64,
        fileSize: 100,
        storageKey: `boss_art/00000000-0000-4000-8000-000000000${n}/${'a'.repeat(64)}.webp`,
        contentHash: 'a'.repeat(64),
        // Oldest first: the listing is newest-first, so `Bulk 000` is on the last page.
        updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
      };
    });
    await t.db.insert(artworkAssets).values(rows);
    // Not boss artwork: must not be counted into, or leak through, the paging.
    await assets.upload({ bytes: await solidImage(64, 64, RED, 'png'), category: 'enemy_art' }, 'admin-x');
    const oldest = rows[0]!.id;
    await createBoss('on_last_page', { name: 'On Last Page', artworkAssetId: oldest, status: 'draft' });

    const { managed } = await data('/admin/bosses/artwork/library');
    expect(managed).toHaveLength(TOTAL);
    expect(new Set(managed.map((m: Json) => m.asset.id)).size).toBe(TOTAL);
    expect(managed.every((m: Json) => m.asset.name.startsWith('Bulk '))).toBe(true);
    // The image on the last page is there, and so is who uses it.
    expect(managed.at(-1)).toMatchObject({
      asset: { id: oldest, name: 'Bulk 000' },
      usedBy: [{ id: 'on_last_page', name: 'On Last Page', status: 'draft' }],
    });
    // An unused image beyond the first page can still be deleted.
    const beyond = rows[1]!.id;
    expect((await call('DELETE', `/admin/bosses/artwork/assets/${beyond}`)).statusCode).toBe(200);
    expect((await data('/admin/bosses/artwork/library')).managed).toHaveLength(TOTAL - 1);
  });
});

describe('REGRESSION: an assigned image moved to another category', () => {
  it('stays viewable for the boss that shows it, and is still announced', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('keeps_it', { artwork: SHIPPED, artworkAssetId: asset.id });
    const before = (await fileOf(asset.id)).rawPayload;
    // Recategorised from elsewhere (the general artwork tooling), while assigned.
    expect((await assets.update(asset.id, { category: 'enemy_art' }, 'admin-x'))!.category).toBe('enemy_art');

    // The boss still names it, and its editor preview still loads.
    expect(await data('/admin/bosses/keeps_it')).toMatchObject({ artworkAssetId: asset.id, issues: [] });
    const file = await fileOf(asset.id);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(before)).toBe(true);
    // A reader sees it too; a player still does not.
    expect((await api.inject({ method: 'GET', url: `/api/v1/admin/bosses/artwork/assets/${asset.id}/file`, ...asCookie('token-reader') })).statusCode).toBe(200);
    expect((await api.inject({ method: 'GET', url: `/api/v1/admin/bosses/artwork/assets/${asset.id}/file`, ...asCookie('token-player') })).statusCode).toBe(403);
    // Saving the boss unchanged still works, and it is still protected from deletion.
    expect((await save('keeps_it', { description: 'Edited after the move.' })).statusCode).toBe(200);
    await expect(assets.delete(asset.id, 'admin-x')).rejects.toMatchObject({ code: 'ARTWORK_ASSET_IN_USE' });
    // It is no longer boss artwork, so the boss-scoped library and delete do not reach it.
    expect((await data('/admin/bosses/artwork/library')).managed).toEqual([]);
    expect((await call('DELETE', `/admin/bosses/artwork/assets/${asset.id}`)).statusCode).toBe(404);

    // Once no boss shows it, the boss routes stop serving it.
    expect((await save('keeps_it', { artworkAssetId: null })).statusCode).toBe(200);
    expect((await fileOf(asset.id)).statusCode).toBe(404);
  });
});

describe('assigning artwork to a boss', () => {
  it('saves an upload onto a boss beside its shipped path, and audits both sides', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('assignee', { artwork: SHIPPED });
    const saved = await save('assignee', { artworkAssetId: asset.id });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({ artwork: SHIPPED, artworkAssetId: asset.id, issues: [] });
    expect((await data('/admin/bosses')).bosses.find((b: Json) => b.id === 'assignee').artworkAssetId).toBe(asset.id);

    const bossEvents = (await data('/admin/bosses/events?bossId=assignee')).events;
    expect(bossEvents[0]).toMatchObject({ action: 'update', details: { changed: ['artworkAssetId'] } });
    expect((await assetEvents(asset.id)).at(-1)).toMatchObject({
      action: 'reference_added',
      details: { entity: 'boss:assignee', field: 'artworkAssetId', from: null, to: asset.id },
    });
  });

  it('records a reassignment on both images, and a clear on the one given up', async () => {
    const first = await uploaded(await solidImage(64, 64, RED, 'png'));
    const second = await uploaded(await solidImage(64, 64, BLUE, 'png'));
    await createBoss('swapper', { artworkAssetId: first.id });
    expect((await save('swapper', { artworkAssetId: second.id })).statusCode).toBe(200);
    expect((await assetEvents(first.id)).map((e) => e.action)).toEqual(['upload', 'reference_added', 'reference_removed']);
    expect((await assetEvents(second.id)).map((e) => e.action)).toEqual(['upload', 'reference_added']);
    expect((await save('swapper', { artworkAssetId: null })).statusCode).toBe(200);
    expect((await assetEvents(second.id)).map((e) => e.action)).toEqual(['upload', 'reference_added', 'reference_removed']);
    expect((await data('/admin/bosses/swapper')).artworkAssetId).toBeNull();
  });

  it('refuses an id that names no artwork on this server, at the field', async () => {
    await createBoss('picky');
    for (const artworkAssetId of ['3f1e0d6a-1111-4222-8333-444455556666', 'not-a-uuid']) {
      const res = await save('picky', { artworkAssetId });
      expect(res.statusCode, artworkAssetId).toBe(400);
      expect(res.json().error.code).toBe('BOSS_DEFINITION_INVALID');
      expect(res.json().error.details.issues).toEqual([
        expect.objectContaining({ path: 'artworkAssetId', severity: 'error' }),
      ]);
    }
    expect((await data('/admin/bosses/picky')).artworkAssetId).toBeNull();
  });

  it('warns, rather than refusing, when the assigned upload is disabled', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('dimmed', { artwork: SHIPPED, artworkAssetId: asset.id });
    await assets.setEnabled(asset.id, false, 'admin-x');
    expect((await data('/admin/bosses/dimmed')).issues).toEqual([
      expect.objectContaining({ path: 'artworkAssetId', severity: 'warning', message: expect.stringContaining('shipped file') }),
    ]);
  });

  it('a duplicate keeps the artwork and counts as another user of it', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('original', { artworkAssetId: asset.id });
    const copy = await call('POST', '/admin/bosses/original/duplicate', { id: 'copycat' });
    expect(copy.statusCode, copy.body).toBe(200);
    expect(copy.json().data.artworkAssetId).toBe(asset.id);
    expect((await data(`/admin/bosses/artwork/assets/${asset.id}`)).usedBy.map((u: Json) => u.id).sort()).toEqual(['copycat', 'original']);
  });
});

describe('safe deletion', () => {
  it('refuses to delete an image a boss uses, and says which boss', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('holder', { name: 'The Holder', artworkAssetId: asset.id });
    const refused = await call('DELETE', `/admin/bosses/artwork/assets/${asset.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'ARTWORK_ASSET_IN_USE',
      details: { references: [{ kind: 'boss', key: 'holder', name: 'The Holder', field: 'artworkAssetId' }] },
    });
    expect((await storedRow(asset.id)).status).toBe('active');
    expect(filesUnder(storageDir)).toHaveLength(1);
    expect((await fileOf(asset.id)).statusCode).toBe(200);
  });

  it('deletes it once every boss has been reassigned: the file goes, the history stays', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('holder', { artworkAssetId: asset.id });
    expect((await save('holder', { artworkAssetId: null })).statusCode).toBe(200);
    const deleted = await call('DELETE', `/admin/bosses/artwork/assets/${asset.id}`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().data).toEqual({ deleted: true });
    expect(filesUnder(storageDir)).toEqual([]);
    expect((await storedRow(asset.id)).status).toBe('deleted');
    expect((await assetEvents(asset.id)).map((e) => e.action)).toEqual(['upload', 'reference_added', 'reference_removed', 'delete']);
    expect((await data('/admin/bosses/artwork/library')).managed).toEqual([]);
    expect((await fileOf(asset.id)).statusCode).toBe(404);
    expect((await call('DELETE', `/admin/bosses/artwork/assets/${asset.id}`)).statusCode).toBe(404);
  });

  it('the general artwork service refuses the same delete, so no other route can orphan a boss', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('holder', { artworkAssetId: asset.id });
    await expect(assets.delete(asset.id, 'admin-x')).rejects.toMatchObject({ code: 'ARTWORK_ASSET_IN_USE' });
    expect(await assets.references(asset.id)).toEqual([{ kind: 'boss', key: 'holder', name: 'Art Boss', field: 'artworkAssetId' }]);
  });

  it('an encounter still open keeps its image from being deleted, even after the boss lets go of it', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('live_one', { name: 'Live One', artworkAssetId: asset.id });
    const spawn = await call('POST', `/admin/bosses/live_one/spawn?guildId=${GUILD_ID}`, {});
    expect(spawn.statusCode, spawn.body).toBe(200);
    const encounterId = spawn.json().data.encounter.id;
    expect((await save('live_one', { artworkAssetId: null })).statusCode).toBe(200);

    const refused = await call('DELETE', `/admin/bosses/artwork/assets/${asset.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details.references).toEqual([
      { kind: 'boss', key: 'live_one', name: 'Live One', field: `liveEncounter[${encounterId}]` },
    ]);
    expect((await call('POST', `/admin/bosses/encounters/${encounterId}/end?guildId=${GUILD_ID}`)).statusCode).toBe(200);
    expect((await call('DELETE', `/admin/bosses/artwork/assets/${asset.id}`)).statusCode).toBe(200);
  });

  it('deleting a boss releases its artwork', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    const boss = await createBoss('short_lived', { artworkAssetId: asset.id, status: 'draft' });
    expect((await call('DELETE', `/admin/bosses/short_lived?expectedRevision=${boss.revision}`)).statusCode).toBe(200);
    expect((await assetEvents(asset.id)).at(-1)).toMatchObject({ action: 'reference_removed', details: { entity: 'boss:short_lived' } });
    expect((await call('DELETE', `/admin/bosses/artwork/assets/${asset.id}`)).statusCode).toBe(200);
  });
});

describe('permissions', () => {
  const READS = (id: string) => ['/admin/bosses/artwork/library', `/admin/bosses/artwork/assets/${id}`, `/admin/bosses/artwork/assets/${id}/file`];
  const cookieUpload = async (token: string, bytes: Buffer) => {
    const who = asCookie(token);
    return api.inject({
      method: 'POST',
      url: uploadUrl({ filename: 'x.png' }),
      cookies: who.cookies,
      headers: { ...who.headers, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
  };

  it('refuses a caller with no session, and a signed-in player with no boss permission', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    const png = await solidImage(64, 64, BLUE, 'png');
    for (const url of READS(asset.id)) {
      expect((await api.inject({ method: 'GET', url: `/api/v1${url}` })).statusCode, url).toBe(401);
      const res = await api.inject({ method: 'GET', url: `/api/v1${url}`, ...asCookie('token-player') });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    }
    expect((await api.inject({ method: 'POST', url: uploadUrl(), headers: { 'content-type': 'image/png' }, payload: png })).statusCode).toBe(401);
    expect((await cookieUpload('token-player', png)).statusCode).toBe(403);
    expect((await api.inject({ method: 'DELETE', url: `/api/v1/admin/bosses/artwork/assets/${asset.id}`, ...asCookie('token-player') })).statusCode).toBe(403);
    expect(await t.db.select().from(artworkAssets)).toHaveLength(1);
    expect((await storedRow(asset.id)).status).toBe('active');
  });

  it('read-only access views the library and the images, and can change nothing', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('viewed', { status: 'draft' });
    const reader = asCookie('token-reader');
    for (const url of READS(asset.id)) {
      expect((await api.inject({ method: 'GET', url: `/api/v1${url}`, ...reader })).statusCode, url).toBe(200);
    }
    expect((await cookieUpload('token-reader', await solidImage(64, 64, BLUE, 'png'))).statusCode).toBe(403);
    expect((await api.inject({ method: 'DELETE', url: `/api/v1/admin/bosses/artwork/assets/${asset.id}`, ...reader })).statusCode).toBe(403);
    // Assigning artwork is a boss save, which a reader may not make either.
    const assign = await api.inject({
      method: 'PUT',
      url: '/api/v1/admin/bosses/viewed',
      ...reader,
      payload: { boss: body({ status: 'draft', artworkAssetId: asset.id }), expectedRevision: 1 },
    });
    expect(assign.statusCode).toBe(403);
    expect(await t.db.select().from(artworkAssets)).toHaveLength(1);
    expect((await data('/admin/bosses/viewed')).artworkAssetId).toBeNull();
  });

  it('operating encounters does not imply managing artwork', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    const operator = asCookie('token-operator');
    expect((await api.inject({ method: 'GET', url: '/api/v1/admin/bosses/artwork/library', ...operator })).statusCode).toBe(200);
    expect((await cookieUpload('token-operator', await solidImage(64, 64, BLUE, 'png'))).statusCode).toBe(403);
    expect((await api.inject({ method: 'DELETE', url: `/api/v1/admin/bosses/artwork/assets/${asset.id}`, ...operator })).statusCode).toBe(403);
    expect((await storedRow(asset.id)).status).toBe('active');
  });

  it('a boss editor uploads and deletes, and both are recorded under their name', async () => {
    const res = await cookieUpload('token-editor', await solidImage(64, 64, BLUE, 'png'));
    expect(res.statusCode, res.body).toBe(200);
    const asset = res.json().data.asset;
    expect(asset.uploadedBy).toBe(EDITOR_ID);
    const deleted = await api.inject({ method: 'DELETE', url: `/api/v1/admin/bosses/artwork/assets/${asset.id}`, ...asCookie('token-editor') });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(await assetEvents(asset.id)).toMatchObject([
      { action: 'upload', actor: EDITOR_ID },
      { action: 'delete', actor: EDITOR_ID },
    ]);
  });

  it('a cookie upload without the CSRF token is refused', async () => {
    const res = await api.inject({
      method: 'POST',
      url: uploadUrl(),
      cookies: asCookie('token-editor').cookies,
      headers: { 'content-type': 'application/octet-stream' },
      payload: await solidImage(64, 64, BLUE, 'png'),
    });
    expect(res.statusCode).toBe(403);
    expect(await t.db.select().from(artworkAssets)).toEqual([]);
  });
});

describe('existing shipped artwork keeps working', () => {
  it('a bootstrapped boss keeps its path and has no managed artwork', async () => {
    const shipped = app.content.bosses.find((b) => b.artwork)!;
    expect(await data(`/admin/bosses/${shipped.id}`)).toMatchObject({ artwork: shipped.artwork, artworkAssetId: null });
    const rows = await t.db.select().from(bossDefinitions);
    expect(rows.every((r) => r.artworkAssetId === null)).toBe(true);
    expect(rows.find((r) => r.bossKey === shipped.id)!.artwork).toBe(shipped.artwork);
  });

  it('still offers and serves shipped files by path', async () => {
    const reference = await data('/admin/bosses/reference');
    expect(reference.artwork).toEqual([SHIPPED]);
    expect(reference.managedArtwork).toBe(true);
    const image = await call('GET', `/admin/bosses/artwork?path=${encodeURIComponent(SHIPPED)}`);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');
    expect((await call('GET', `/admin/bosses/artwork?path=${encodeURIComponent('../secret.webp')}`)).statusCode).toBe(404);
  });

  it('a save that never mentions managed artwork works exactly as before', async () => {
    const res = await call('POST', '/admin/bosses', { id: 'old_shape', boss: body({ artwork: SHIPPED }) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ artwork: SHIPPED, artworkAssetId: null, issues: [] });
  });

  it('an export from before managed artwork imports unchanged', async () => {
    const document = (await data('/admin/bosses/export')).document;
    // A few bosses: the route's JSON body limit is far below the whole shipped roster.
    const legacy = { ...document, bosses: document.bosses.slice(0, 3).map(({ artworkAssetId: _dropped, ...boss }: Json) => boss) };
    const planned = await call('POST', '/admin/bosses/import/plan', { document: legacy });
    expect(planned.statusCode, planned.body).toBe(200);
    const plan = planned.json().data;
    expect(plan.canApply).toBe(true);
    expect(plan.entries.every((e: Json) => e.action === 'unchanged')).toBe(true);
  });
});

describe('import and export', () => {
  const plan = (document: unknown) => call('POST', '/admin/bosses/import/plan', { document });
  const apply = (document: unknown, conflicts: 'skip' | 'overwrite', expectedRevisions?: Record<string, number>) =>
    call('POST', '/admin/bosses/import/apply', { document, conflicts, ...(expectedRevisions ? { expectedRevisions } : {}) });

  it('REGRESSION: a complete exported roster — larger than the API’s default body limit — plans and applies', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('with_upload', { artworkAssetId: asset.id, artwork: SHIPPED });
    const { document } = await data('/admin/bosses/export');
    // The point of the test: this body does not fit in the 64 KB every other route allows.
    expect(JSON.stringify({ document }).length).toBeGreaterThan(64 * 1024);
    expect(document.bosses).toHaveLength(app.content.bosses.length + 1);

    const planned = await plan(document);
    expect(planned.statusCode, planned.body).toBe(200);
    expect(planned.json().data.canApply).toBe(true);
    expect(new Set(planned.json().data.entries.map((e: Json) => e.action))).toEqual(new Set(['unchanged']));

    // Change one boss and add another, then apply the whole document.
    const first = document.bosses[0];
    const edited = {
      ...document,
      bosses: [
        { ...first, description: 'Rewritten by an import.' },
        ...document.bosses.slice(1),
        { ...document.bosses.find((b: Json) => b.id === 'with_upload'), id: 'imported_twin', name: 'Imported Twin', status: 'draft' },
      ],
    };
    const replanned = (await plan(edited)).json().data;
    expect(replanned.entries.filter((e: Json) => e.action !== 'unchanged').map((e: Json) => [e.id, e.action])).toEqual([
      [first.id, 'conflict'],
      ['imported_twin', 'create'],
    ]);
    const revision = replanned.entries.find((e: Json) => e.id === first.id).currentRevision;
    const applied = await apply(edited, 'overwrite', { [first.id]: revision });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().data).toMatchObject({ created: ['imported_twin'], overwritten: [first.id], skipped: [] });
    expect(applied.json().data.unchanged).toHaveLength(document.bosses.length - 1);

    // What comes back out is what went in.
    const after = (await data('/admin/bosses/export')).document;
    expect(after.bosses.find((b: Json) => b.id === first.id).description).toBe('Rewritten by an import.');
    expect(after.bosses.find((b: Json) => b.id === 'imported_twin')).toMatchObject({ artwork: SHIPPED, artworkAssetId: asset.id });
    const again = (await plan(after)).json().data;
    expect(again.entries.every((e: Json) => e.action === 'unchanged')).toBe(true);
    // The imported boss is a user of the image like any other.
    expect((await data(`/admin/bosses/artwork/assets/${asset.id}`)).usedBy.map((u: Json) => u.id).sort()).toEqual(['imported_twin', 'with_upload']);
    expect((await assetEvents(asset.id)).at(-1)).toMatchObject({ action: 'reference_added', details: { entity: 'boss:imported_twin' } });
  });

  it('the raised limit is the import routes’ alone, and is itself enforced', async () => {
    const padded = (bytes: number) => body({ status: 'draft', description: 'x'.repeat(1000), scoutingText: 'y'.repeat(bytes) });
    // An ordinary boss route still stops at 64 KB.
    const create = await call('POST', '/admin/bosses', { id: 'too_big', boss: padded(70 * 1024) });
    expect(create.statusCode).toBe(413);
    expect(create.json().error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { maxBytes: 64 * 1024 } });
    const validate = await call('POST', '/admin/bosses/validate', { id: 'too_big', boss: padded(70 * 1024), creating: true });
    expect(validate.statusCode).toBe(413);
    // The import routes take megabytes, and no more than their own ceiling.
    const filler = Array.from({ length: 1200 }, (_, i) => ({ id: `filler_${i}`, ...body({ status: 'draft', description: 'z'.repeat(1900) }) }));
    expect(JSON.stringify(filler).length).toBeGreaterThan(2 * 1024 * 1024);
    for (const url of ['/admin/bosses/import/plan', '/admin/bosses/import/apply']) {
      const res = await call('POST', url, { document: filler, conflicts: 'skip' });
      expect(res.statusCode, url).toBe(413);
      expect(res.json().error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { maxBytes: 2 * 1024 * 1024 } });
    }
    expect(await data('/admin/bosses/too_big').catch(() => null)).toBeFalsy();
  });

  it('a large import body from a caller without permission is refused before it is read', async () => {
    const document = Array.from({ length: 400 }, (_, i) => ({ id: `sneaky_${i}`, ...body({ description: 'z'.repeat(1900) }) }));
    const anonymous = await api.inject({ method: 'POST', url: '/api/v1/admin/bosses/import/apply', payload: { document, conflicts: 'skip' } });
    expect(anonymous.statusCode).toBe(401);
    const player = await api.inject({ method: 'POST', url: '/api/v1/admin/bosses/import/apply', ...asCookie('token-player'), payload: { document, conflicts: 'skip' } });
    expect(player.statusCode).toBe(403);
    // Planning is a read; applying is a write — for a reader the plan works and the apply does not.
    const small = [{ id: 'sneaky', ...body({ status: 'draft' }) }];
    expect((await api.inject({ method: 'POST', url: '/api/v1/admin/bosses/import/plan', ...asCookie('token-reader'), payload: { document: small } })).statusCode).toBe(200);
    expect((await api.inject({ method: 'POST', url: '/api/v1/admin/bosses/import/apply', ...asCookie('token-reader'), payload: { document: small, conflicts: 'skip' } })).statusCode).toBe(403);
    expect((await data('/admin/bosses')).bosses.some((b: Json) => b.id.startsWith('sneaky'))).toBe(false);
  });

  it('an imported boss naming artwork this server does not have is refused, clearly, and nothing is written', async () => {
    const missing = '3f1e0d6a-1111-4222-8333-444455556666';
    const document = [
      { id: 'fine_one', ...body({ status: 'draft' }) },
      { id: 'from_elsewhere', ...body({ status: 'draft', artwork: SHIPPED, artworkAssetId: missing }) },
    ];
    const planned = (await plan(document)).json().data;
    expect(planned.canApply).toBe(false);
    expect(planned.entries.map((e: Json) => [e.id, e.action])).toEqual([
      ['fine_one', 'create'],
      ['from_elsewhere', 'invalid'],
    ]);
    expect(planned.entries[1].issues).toEqual([
      {
        path: 'artworkAssetId',
        severity: 'error',
        message: 'That uploaded artwork does not exist on this server — choose another image or clear it.',
      },
    ]);
    const applied = await apply(document, 'skip');
    expect(applied.statusCode).toBe(400);
    expect(applied.json().error.code).toBe('BOSS_DEFINITION_INVALID');
    expect(applied.json().error.details.issues).toEqual([expect.objectContaining({ path: 'from_elsewhere.artworkAssetId' })]);
    expect((await call('GET', '/admin/bosses/fine_one')).statusCode).toBe(404);

    // Cleared, the same boss imports and keeps its shipped path.
    const cleared = document.map((b) => ({ ...b, artworkAssetId: null }));
    expect((await apply(cleared, 'skip')).json().data.created).toEqual(['fine_one', 'from_elsewhere']);
    expect(await data('/admin/bosses/from_elsewhere')).toMatchObject({ artwork: SHIPPED, artworkAssetId: null });
  });

  it('an imported boss may not name a deleted upload, and a malformed id is an error at the field', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    expect((await call('DELETE', `/admin/bosses/artwork/assets/${asset.id}`)).statusCode).toBe(200);
    const planned = (await plan([
      { id: 'names_deleted', ...body({ status: 'draft', artworkAssetId: asset.id }) },
      { id: 'names_garbage', ...body({ status: 'draft', artworkAssetId: '../../etc/passwd' }) },
    ])).json().data;
    expect(planned.canApply).toBe(false);
    expect(planned.entries.map((e: Json) => [e.action, e.issues[0].path])).toEqual([
      ['invalid', 'artworkAssetId'],
      ['invalid', 'artworkAssetId'],
    ]);
  });
});

describe('a delete and an assignment that race', () => {
  it('a save naming an image whose delete is in flight waits for it, and is then refused', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('racer', { status: 'draft' });
    // A delete that has locked the row, found no references and marked it — and not yet committed.
    let commit!: () => void;
    const held = new Promise<void>((resolve) => (commit = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const deleting = t.db.transaction(async (tx) => {
      await tx.select().from(artworkAssets).where(eq(artworkAssets.id, asset.id)).for('update');
      await tx.update(artworkAssets).set({ status: 'deleted', deletedAt: new Date() }).where(eq(artworkAssets.id, asset.id));
      locked();
      await held;
    });
    await isLocked;
    const saving = save('racer', { artworkAssetId: asset.id });
    const state = await Promise.race([saving.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 400))]);
    expect(state).toBe('waiting');
    commit();
    await deleting;
    const res = await saving;
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.details.issues).toEqual([expect.objectContaining({ path: 'artworkAssetId', severity: 'error' })]);
    expect((await data('/admin/bosses/racer')).artworkAssetId).toBeNull();
  });

  it('a delete that starts after a save has named the image finds the boss and refuses', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('racer', { status: 'draft' });
    const [saved, deleted] = await Promise.all([
      save('racer', { artworkAssetId: asset.id }),
      call('DELETE', `/admin/bosses/artwork/assets/${asset.id}`),
    ]);
    // Whichever went first, the two never both succeed.
    expect([saved.statusCode, deleted.statusCode].sort()).not.toEqual([200, 200]);
    const boss = await data('/admin/bosses/racer');
    const row = await storedRow(asset.id);
    expect(boss.artworkAssetId === asset.id && row.status === 'deleted').toBe(false);
  });
});

describe('what an encounter announces with', () => {
  const logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
  const ctx = () => ({ config: { assetsDir }, logger, services: { artworkAssets: assets } }) as never;
  async function spawned(bossId: string) {
    const res = await call('POST', `/admin/bosses/${bossId}/spawn?guildId=${GUILD_ID}`, {});
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await t.db.select().from(bossEncounters).where(eq(bossEncounters.id, res.json().data.encounter.id));
    return row!;
  }

  it('freezes the upload onto the encounter and announces with its bytes', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('pictured', { artwork: SHIPPED, artworkAssetId: asset.id });
    const encounter = await spawned('pictured');
    expect(encounter).toMatchObject({ bossArtwork: SHIPPED, bossArtworkAssetId: asset.id });

    const artwork = await resolveBossArtwork(ctx(), encounter);
    expect(artwork.artworkPath).toBeUndefined();
    expect(artwork.artworkImage!.extension).toBe('webp');
    expect(artwork.artworkImage!.bytes.equals((await fileOf(asset.id)).rawPayload)).toBe(true);

    const message = buildAnnouncement({
      encounter,
      boss: app.bosses!.bossFor(encounter),
      config: app.content.tables.bossEncounters,
      participantCount: 0,
      now: new Date(),
      ...artwork,
    });
    const files = message.files as AttachmentBuilder[];
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('boss-pictured.webp');
    expect(Buffer.isBuffer(files[0]!.attachment)).toBe(true);
    expect((message.embeds![0] as EmbedBuilder).toJSON().image?.url).toBe('attachment://boss-pictured.webp');
  });

  it('falls back to the shipped file when the upload is disabled, and to text when there is none', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('fallback', { artwork: SHIPPED, artworkAssetId: asset.id });
    const encounter = await spawned('fallback');
    await assets.setEnabled(asset.id, false, 'admin-x');
    expect(await resolveBossArtwork(ctx(), encounter)).toEqual({ artworkPath: path.join(assetsDir, SHIPPED) });
    expect(await resolveBossArtwork(ctx(), { ...encounter, bossArtwork: null })).toEqual({});
  });

  it('falls back when the stored file has gone missing, or no artwork service is wired', async () => {
    const asset = await uploaded(await solidImage(64, 64, RED, 'png'));
    await createBoss('lost', { artwork: SHIPPED, artworkAssetId: asset.id });
    const encounter = await spawned('lost');
    expect(await resolveBossArtwork({ config: { assetsDir }, logger } as never, encounter)).toEqual({
      artworkPath: path.join(assetsDir, SHIPPED),
    });
    fs.rmSync(storageDir, { recursive: true, force: true });
    expect(await resolveBossArtwork(ctx(), encounter)).toEqual({ artworkPath: path.join(assetsDir, SHIPPED) });
  });

  it('an encounter of a boss with only shipped artwork is announced as it always was', async () => {
    await createBoss('classic', { artwork: SHIPPED });
    const encounter = await spawned('classic');
    expect(encounter.bossArtworkAssetId).toBeNull();
    const artwork = await resolveBossArtwork(ctx(), encounter);
    expect(artwork).toEqual({ artworkPath: path.join(assetsDir, SHIPPED) });
    const message = buildAnnouncement({
      encounter,
      boss: app.bosses!.bossFor(encounter),
      config: app.content.tables.bossEncounters,
      participantCount: 0,
      now: new Date(),
      ...artwork,
    });
    const files = message.files as AttachmentBuilder[];
    expect(files[0]!.name).toBe('boss-classic.webp');
    expect(files[0]!.attachment).toBe(path.join(assetsDir, SHIPPED));
  });

  it('an edit after the spawn does not reach the open encounter', async () => {
    const first = await uploaded(await solidImage(64, 64, RED, 'png'));
    const second = await uploaded(await solidImage(64, 64, BLUE, 'png'));
    await createBoss('frozen', { artworkAssetId: first.id });
    const encounter = await spawned('frozen');
    expect((await save('frozen', { artworkAssetId: second.id })).statusCode).toBe(200);
    const [row] = await t.db.select().from(bossEncounters).where(eq(bossEncounters.id, encounter.id));
    expect(row!.bossArtworkAssetId).toBe(first.id);
  });
});
