/**
 * Managed artwork over the Admin API, against a real database and a real
 * (temporary) storage directory: uploads and their validation, metadata,
 * replacement and cache invalidation, reference integrity, the audit trail,
 * enemy artwork, the scene preview, and who may do any of it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { artworkAssetEvents, artworkAssets } from '../../../src/db/schema';
import { createArtworkAssetService, type ArtworkAssetService } from '../../../src/modules/artworkAssets/artworkAssetService';
import { createLocalArtworkStorage } from '../../../src/modules/artworkAssets/artworkStorage';
import { createEnemyArtworkService } from '../../../src/modules/artworkAssets/enemyArtworkService';
import { ARTWORK_UPLOAD_MAX_BYTES } from '../../../src/modules/artworkAssets/imageInspection';
import { createSceneCompositionService } from '../../../src/modules/artworkAssets/sceneComposition';
import { createDungeonZoneService } from '../../../src/modules/dungeons/dungeonZoneService';
import { loadShippedDungeonZones, seedDungeonZones } from '../../../src/modules/dungeons/dungeonZoneStore';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import { createProgressionCurrencyService } from '../../../src/modules/progressionCurrency/progressionCurrencyService';
import { loadShippedRewardTables, seedRewardTables } from '../../../src/modules/rewardTables/rewardTableStore';
import { CONTENT_DIR, bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { BLUE, GREEN, RED, isNear, pixelAt, solidImage, transparentSprite } from '../../helpers/imageFixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555991';
const OWNER_ID = '777888999000111551';
const NON_OWNER_ID = '999999999999999991';
const OWNER_TOKEN = 'token-owner';
const NON_OWNER_TOKEN = 'token-non-owner';
const CSRF = 'csrf-token';
const ZONE = 'scrapheap_gauntlet';

let t: TestDb;
let app: App;
let api: ZodFastify;
let assets: ArtworkAssetService;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-artwork-api-'));
const storageDir = path.join(root, 'managed');
const cacheDir = path.join(root, 'cache');
const assetsDir = path.join(root, 'assets');
fs.mkdirSync(path.join(assetsDir, 'dungeons', 'backgrounds'), { recursive: true });

/** Every regular file under a directory, relative, sorted. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

beforeAll(async () => {
  fs.writeFileSync(path.join(assetsDir, 'dungeons', 'backgrounds', 'shipped.png'), await solidImage(320, 180, GREEN));
  t = await createTestDb();
  app = await bootstrapApp(t);
  await provisionPlayer(app, GUILD_ID, OWNER_ID);
  await provisionPlayer(app, GUILD_ID, NON_OWNER_ID);
  await seedRewardTables(t.db, loadShippedRewardTables(CONTENT_DIR));
  const shipped = loadShippedDungeonZones(CONTENT_DIR);
  await seedDungeonZones(t.db, shipped);

  assets = createArtworkAssetService({ db: t.db, storage: createLocalArtworkStorage(storageDir) });
  const enemyArtwork = createEnemyArtworkService({ db: t.db, getEnemies: () => app.content.combatEnemies ?? [], assets });
  const sceneComposition = createSceneCompositionService({ cacheDir });
  const dungeonZones = createDungeonZoneService({ db: t.db, getContent: () => app.content, getShipped: () => shipped, assets });
  const progressionCurrency = createProgressionCurrencyService(t.db);

  const guildOwnership = createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID });
  const portalAuthorization = createPortalAuthorizationService({ guildOwnership });
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
  const sessions = {
    getSession: async (token: string | undefined) =>
      token === OWNER_TOKEN ? session(OWNER_ID) : token === NON_OWNER_TOKEN ? session(NON_OWNER_ID) : null,
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
    config: { enabled: true, host: '127.0.0.1', port: 3136, token: TEST_TOKEN, adminBearer: true },
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
      services: { ...app, dungeonZones, progressionCurrency, artworkAssets: assets, enemyArtwork, sceneComposition },
      getContent: () => app.content,
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

type Asset = Record<string, any>;
const query = (params: Record<string, string | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join('&');

function upload(bytes: Buffer, params: { category?: string; filename?: string; name?: string } = {}, contentType = 'application/octet-stream') {
  return api.inject({
    method: 'POST',
    url: `/api/v1/admin/artwork/assets?${query({ category: 'dungeon_background', ...params })}`,
    headers: { ...AUTH_BEARER, 'content-type': contentType },
    payload: bytes,
  });
}
async function uploaded(bytes: Buffer, params: { category?: string; filename?: string; name?: string } = {}): Promise<Asset> {
  const res = await upload(bytes, params);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.asset;
}
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...AUTH_BEARER, ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const getFile = (id: string, headers: Record<string, string> = {}, v?: string) =>
  api.inject({ method: 'GET', url: `/api/v1/admin/artwork/assets/${id}/file${v ? `?v=${v}` : ''}`, headers: { ...AUTH_BEARER, ...headers } });
const storedRow = async (id: string) => (await t.db.select().from(artworkAssets).where(eq(artworkAssets.id, id)))[0]!;
const eventsOf = async (id: string) =>
  (await t.db.select().from(artworkAssetEvents).where(eq(artworkAssetEvents.assetId, id)).orderBy(artworkAssetEvents.id)).map((e) => e.action);
const getZone = async () => (await call('GET', `/admin/dungeons/zones/${ZONE}`)).json().data;
const saveZone = async (patch: Record<string, unknown>) => {
  const current = await getZone();
  return call('PUT', `/admin/dungeons/zones/${ZONE}`, { zone: { ...current.zone, ...patch }, expectedRevision: current.revision });
};

describe('upload', () => {
  it('accepts PNG, WebP and JPEG, and records what the bytes are', async () => {
    const cases = [
      ['png', 'image/png', 'png'],
      ['webp', 'image/webp', 'webp'],
      ['jpeg', 'image/jpeg', 'jpg'],
    ] as const;
    for (const [format, mimeType, extension] of cases) {
      const bytes = await solidImage(640, 360, BLUE, format);
      const res = await upload(bytes, { filename: `cave.${format}` }, mimeType);
      expect(res.statusCode, res.body).toBe(200);
      const asset: Asset = res.json().data.asset;
      expect(asset).toMatchObject({
        category: 'dungeon_background',
        name: 'cave',
        originalFilename: `cave.${format}`,
        mimeType,
        width: 640,
        height: 360,
        hasAlpha: false,
        fileSize: bytes.length,
        version: 1,
        status: 'active',
        replacedAt: null,
      });
      expect(asset.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(asset.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // The storage location never leaves the server.
      expect(JSON.stringify(asset)).not.toMatch(/storageKey|storage_key/);
      expect(res.body).not.toContain(storageDir);
      // Stored under a key the server built from the category, id and hash.
      const row = await storedRow(asset.id);
      expect(row.storageKey).toBe(`dungeon_background/${asset.id}/${asset.contentHash}.${extension}`);
      expect(fs.readFileSync(path.join(storageDir, ...row.storageKey.split('/'))).equals(bytes)).toBe(true);
    }
  });

  it('accepts a transparent sprite and records its alpha channel', async () => {
    for (const format of ['png', 'webp'] as const) {
      const asset = await uploaded(await transparentSprite(256, 256, RED, format), { category: 'enemy_sprite', filename: `drone.${format}`, name: 'Scrap Drone' });
      expect(asset).toMatchObject({ category: 'enemy_sprite', name: 'Scrap Drone', hasAlpha: true, width: 256, height: 256 });
    }
  });

  it('reads the type from the bytes: a wrong extension or declared type changes nothing', async () => {
    // A real PNG named .svg and declared as JPEG is stored as the PNG it is.
    const png = await solidImage(64, 64);
    const res = await upload(png, { filename: 'totally.svg' }, 'image/jpeg');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.asset).toMatchObject({ mimeType: 'image/png', originalFilename: 'totally.svg' });
    expect((await storedRow(res.json().data.asset.id)).storageKey).toMatch(/\.png$/);
  });

  it('refuses a non-image, and an extension or content-type spoof', async () => {
    const before = filesUnder(storageDir);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).gif().toBuffer();
    for (const [bytes, filename, type] of [
      [svg, 'scene.svg', 'image/png'],
      [svg, 'scene.png', 'image/png'],
      [html, 'photo.png', 'image/png'],
      [html, 'photo.jpg', 'image/jpeg'],
      [gif, 'anim.png', 'image/png'],
      [Buffer.from('MZ\u0090\u0000 this is a program'), 'sprite.webp', 'image/webp'],
      [Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), html]), 'polyglot.png', 'image/png'],
    ] as const) {
      const res = await upload(bytes, { filename }, type);
      expect(res.statusCode, filename).toBe(400);
      expect(res.json().error.code, filename).toBe('ARTWORK_UPLOAD_INVALID');
    }
    // A declared type this route does not take is refused whatever the bytes are.
    for (const type of ['image/svg+xml', 'image/gif', 'text/plain', 'multipart/form-data; boundary=x']) {
      const res = await upload(await solidImage(32, 32), {}, type);
      expect([400, 415], type).toContain(res.statusCode);
    }
    // An unknown category is refused before anything is stored.
    expect((await upload(await solidImage(32, 32), { category: 'player_avatar' })).statusCode).toBe(400);
    expect((await upload(Buffer.alloc(0))).statusCode).toBe(400);
    expect(filesUnder(storageDir)).toEqual(before);
  });

  it('refuses a file over the size limit with 413', async () => {
    const before = filesUnder(storageDir);
    const res = await upload(Buffer.concat([await solidImage(64, 64), Buffer.alloc(ARTWORK_UPLOAD_MAX_BYTES)]));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { maxBytes: ARTWORK_UPLOAD_MAX_BYTES } });
    expect(filesUnder(storageDir)).toEqual(before);
  });

  it('refuses absurd dimensions', async () => {
    const res = await upload(await solidImage(5000, 16));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/longest edge/);
  });

  it('never lets a file name reach the filesystem', async () => {
    for (const filename of ['../../../etc/passwd.png', '/abs/evil.png', '..\\..\\win.png', 'a/b/c.png', '%2e%2e%2fescape.png']) {
      const asset = await uploaded(await solidImage(48, 48, { r: 1, g: 2, b: filename.length }), { filename });
      expect(asset.originalFilename).not.toMatch(/[\\/]/);
      const row = await storedRow(asset.id);
      expect(row.storageKey).toBe(`dungeon_background/${asset.id}/${asset.contentHash}.png`);
    }
    // Everything written is inside the storage root, under <category>/<uuid>/<hash>.<ext>.
    for (const file of filesUnder(storageDir)) {
      expect(file).toMatch(/^[a-z_]+\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(png|webp|jpg)$/);
    }
    expect(fs.readdirSync(root).sort()).toEqual(['assets', 'managed']);
  });
});

describe('browse', () => {
  it('lists, filters by category and status, and searches by name or file name', async () => {
    const sprite = await uploaded(await transparentSprite(64, 64), { category: 'enemy_sprite', filename: 'findme_boss.png', name: 'Warden Sprite' });
    const all = (await call('GET', '/admin/artwork/assets?limit=200')).json().data;
    expect(all.total).toBe(all.assets.length);
    expect(all.assets.map((a: Asset) => a.id)).toContain(sprite.id);

    const sprites = (await call('GET', '/admin/artwork/assets?category=enemy_sprite')).json().data.assets as Asset[];
    expect(sprites.length).toBeGreaterThan(0);
    expect(sprites.every((a) => a.category === 'enemy_sprite')).toBe(true);

    const byName = (await call('GET', '/admin/artwork/assets?q=warden')).json().data.assets as Asset[];
    expect(byName.map((a) => a.id)).toEqual([sprite.id]);
    const byFile = (await call('GET', '/admin/artwork/assets?q=FINDME')).json().data.assets as Asset[];
    expect(byFile.map((a) => a.id)).toEqual([sprite.id]);
    // A search term is text, not a pattern: `%` and `_` match only themselves.
    const literal = (await call('GET', '/admin/artwork/assets?q=%25&limit=200')).json().data.assets as Asset[];
    expect(literal.every((a) => `${a.name}${a.originalFilename}`.includes('%'))).toBe(true);
    expect(literal.length).toBeLessThan(all.total);
    expect((await call('GET', '/admin/artwork/assets?q=find_e')).json().data.assets).toEqual([]);

    await call('PUT', `/admin/artwork/assets/${sprite.id}/enabled`, { enabled: false });
    const disabled = (await call('GET', '/admin/artwork/assets?status=disabled')).json().data.assets as Asset[];
    expect(disabled.map((a) => a.id)).toEqual([sprite.id]);
    expect(((await call('GET', '/admin/artwork/assets?status=active&limit=200')).json().data.assets as Asset[]).map((a) => a.id)).not.toContain(sprite.id);
    expect((await call('GET', '/admin/artwork/assets?category=nonsense')).statusCode).toBe(400);
  });

  it('describes the limits an uploader needs', async () => {
    const meta = (await call('GET', '/admin/artwork/meta')).json().data;
    expect(meta).toMatchObject({
      mimeTypes: ['image/png', 'image/webp', 'image/jpeg'],
      maxBytes: ARTWORK_UPLOAD_MAX_BYTES,
      scene: { width: 1200, height: 675 },
    });
    expect(meta.categories).toEqual(
      expect.arrayContaining(['dungeon_zone', 'dungeon_background', 'enemy_sprite', 'event_art', 'npc_portrait', 'equipment_art']),
    );
    expect(meta.placement.anchors).toEqual(['left', 'center', 'right', 'bottom-left', 'bottom-center', 'bottom-right']);
  });

  it('renames and re-categorises without touching the image', async () => {
    const asset = await uploaded(await solidImage(40, 40), { filename: 'x.png' });
    const res = await call('PATCH', `/admin/artwork/assets/${asset.id}`, { name: '  Night Scrapyard  ', category: 'dungeon_zone' });
    expect(res.json().data.asset).toMatchObject({ name: 'Night Scrapyard', category: 'dungeon_zone', contentHash: asset.contentHash, version: 1 });
    expect((await getFile(asset.id)).statusCode).toBe(200);
    expect(await eventsOf(asset.id)).toEqual(['upload', 'update']);
  });
});

describe('serving and cache invalidation', () => {
  it('serves the bytes as data, with an ETag of the content hash', async () => {
    const bytes = await solidImage(100, 60, RED, 'webp');
    const asset = await uploaded(bytes, { filename: 'served.webp' });
    const res = await getFile(asset.id);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers).toMatchObject({
      'content-type': 'image/webp',
      etag: `"${asset.contentHash}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-cache',
    });
    // Revalidation costs no bytes while nothing changed.
    const notModified = await getFile(asset.id, { 'if-none-match': `"${asset.contentHash}"` });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.rawPayload.length).toBe(0);
    // A URL that names the current hash may be cached forever.
    expect((await getFile(asset.id, {}, asset.contentHash)).headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect((await getFile('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await getFile('not-a-uuid')).statusCode).toBe(400);
  });

  it('replacing keeps the id and invalidates every cache of the old image', async () => {
    const first = await solidImage(100, 60, RED);
    const second = await solidImage(200, 120, GREEN, 'webp');
    const asset = await uploaded(first, { filename: 'before.png', name: 'Replace Me' });
    const oldKey = (await storedRow(asset.id)).storageKey;

    const res = await api.inject({
      method: 'PUT',
      url: `/api/v1/admin/artwork/assets/${asset.id}/file?filename=after.webp`,
      headers: { ...AUTH_BEARER, 'content-type': 'image/webp' },
      payload: second,
    });
    expect(res.statusCode, res.body).toBe(200);
    const replaced: Asset = res.json().data.asset;
    expect(replaced).toMatchObject({
      id: asset.id,
      name: 'Replace Me',
      category: asset.category,
      version: 2,
      mimeType: 'image/webp',
      width: 200,
      height: 120,
      originalFilename: 'after.webp',
      fileSize: second.length,
    });
    expect(replaced.contentHash).not.toBe(asset.contentHash);
    expect(replaced.replacedAt).not.toBeNull();

    // The same URL now serves the new image under a new ETag…
    const served = await getFile(asset.id);
    expect(served.rawPayload.equals(second)).toBe(true);
    expect(served.headers.etag).toBe(`"${replaced.contentHash}"`);
    // …a client holding the old ETag is not told "not modified"…
    expect((await getFile(asset.id, { 'if-none-match': `"${asset.contentHash}"` })).statusCode).toBe(200);
    // …and the old versioned URL is no longer immutable.
    expect((await getFile(asset.id, {}, asset.contentHash)).headers['cache-control']).toBe('private, no-cache');
    expect((await getFile(asset.id, {}, replaced.contentHash)).headers['cache-control']).toContain('immutable');

    // The old file is gone; the new one is at the key its hash names.
    const row = await storedRow(asset.id);
    expect(row.storageKey).toBe(`${asset.category}/${asset.id}/${replaced.contentHash}.webp`);
    expect(fs.existsSync(path.join(storageDir, ...oldKey.split('/')))).toBe(false);
    expect(fs.existsSync(path.join(storageDir, ...row.storageKey.split('/')))).toBe(true);

    // The audit trail can diagnose it: both hashes and both versions.
    const detail = (await call('GET', `/admin/artwork/assets/${asset.id}`)).json().data;
    expect(detail.events[0]).toMatchObject({
      action: 'replace',
      oldHash: asset.contentHash,
      newHash: replaced.contentHash,
      details: { fromVersion: 1, toVersion: 2 },
    });
    expect(detail.events.map((e: Asset) => e.action)).toEqual(['replace', 'upload']);
    expect(JSON.stringify(detail.events)).not.toContain(second.toString('base64').slice(0, 40));
  });

  it('refuses to replace with a non-image, and leaves the asset as it was', async () => {
    const asset = await uploaded(await solidImage(50, 50), { filename: 'keep.png' });
    const res = await api.inject({
      method: 'PUT',
      url: `/api/v1/admin/artwork/assets/${asset.id}/file`,
      headers: { ...AUTH_BEARER, 'content-type': 'image/png' },
      payload: Buffer.from('<svg/>'),
    });
    expect(res.statusCode).toBe(400);
    expect(await storedRow(asset.id)).toMatchObject({ version: 1, contentHash: asset.contentHash });
    const missing = await api.inject({
      method: 'PUT',
      url: '/api/v1/admin/artwork/assets/00000000-0000-4000-8000-000000000000/file',
      headers: { ...AUTH_BEARER, 'content-type': 'image/png' },
      payload: await solidImage(20, 20),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('handles a stored file that has gone missing: 404 for the admin, unusable for players', async () => {
    const asset = await uploaded(await solidImage(30, 30, { r: 9, g: 9, b: 9 }), { filename: 'lost.png' });
    fs.rmSync(path.join(storageDir, ...(await storedRow(asset.id)).storageKey.split('/')));
    expect((await getFile(asset.id)).statusCode).toBe(404);
    expect(await assets.readUsable(asset.id)).toBeNull();
    // The layer still exists (the row does), but loads nothing — the compositor falls back.
    expect(await (await assets.layer(asset.id))!.load()).toBeNull();
    // The row is still listed, so the admin can replace it.
    expect((await call('GET', `/admin/artwork/assets/${asset.id}`)).statusCode).toBe(200);
  });
});

describe('reference integrity', () => {
  it('a zone may only reference artwork that exists', async () => {
    const res = await saveZone({ backgroundAssetId: '00000000-0000-4000-8000-0000000000aa' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.issues).toContainEqual(
      expect.objectContaining({ path: 'backgroundAssetId', severity: 'error' }),
    );
    const pool = await saveZone({ backgrounds: [{ id: 'ghost', weight: 1, assetId: '00000000-0000-4000-8000-0000000000bb' }] });
    expect(pool.json().error.details.issues).toContainEqual(expect.objectContaining({ path: 'backgrounds[0].assetId' }));
    expect((await saveZone({ artworkAssetId: 'not-a-uuid' })).statusCode).toBe(400);
  });

  it('a referenced asset cannot be deleted, can be disabled, and is released once cleared', async () => {
    const art = await uploaded(await solidImage(300, 300, RED), { category: 'dungeon_zone', filename: 'zone.png' });
    const bg = await uploaded(await solidImage(640, 360, BLUE), { filename: 'bg.png', name: 'Scrap Night' });
    const saved = await saveZone({
      artworkAssetId: art.id,
      backgroundAssetId: bg.id,
      backgrounds: [
        { id: 'night', weight: 40, assetId: bg.id, maxDepth: 4 },
        { id: 'shipped', weight: 20, artworkPath: 'dungeons/backgrounds/shipped.png', minDepth: 5 },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data.zone).toMatchObject({ artworkAssetId: art.id, backgroundAssetId: bg.id });
    expect(saved.json().data.zone.backgrounds).toHaveLength(2);

    // The asset knows what uses it.
    const detail = (await call('GET', `/admin/artwork/assets/${bg.id}`)).json().data;
    expect(detail.references).toEqual([
      { kind: 'dungeon_zone', key: ZONE, name: expect.any(String), field: 'backgroundAssetId' },
      { kind: 'dungeon_zone', key: ZONE, name: expect.any(String), field: 'backgrounds[night].assetId' },
    ]);

    // Deleting it is refused, with the references, and changes nothing.
    const refused = await call('DELETE', `/admin/artwork/assets/${bg.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'ARTWORK_ASSET_IN_USE' });
    expect(refused.json().error.details.references).toHaveLength(2);
    expect((await getFile(bg.id)).statusCode).toBe(200);
    expect((await storedRow(bg.id)).status).toBe('active');

    // Disabling is allowed, says what it affects, and the zone is told (a warning, not an error).
    const disabled = await call('PUT', `/admin/artwork/assets/${bg.id}/enabled`, { enabled: false });
    expect(disabled.json().data).toMatchObject({ asset: { status: 'disabled' } });
    expect(disabled.json().data.references).toHaveLength(2);
    const zone = await getZone();
    expect(zone.issues).toContainEqual(
      expect.objectContaining({ path: 'backgroundAssetId', severity: 'warning', message: expect.stringContaining('Scrap Night') }),
    );
    expect(zone.issues.filter((i: Asset) => i.severity === 'error')).toEqual([]);
    // Players no longer get it; the admin still can preview it.
    expect(await assets.readUsable(bg.id)).toBeNull();
    expect(await assets.layer(bg.id)).toBeNull();
    expect((await getFile(bg.id)).statusCode).toBe(200);
    await call('PUT', `/admin/artwork/assets/${bg.id}/enabled`, { enabled: true });
    expect(await assets.readUsable(bg.id)).not.toBeNull();

    // Clearing every reference releases it: the override falls back to the shipped path.
    const cleared = await saveZone({ backgroundAssetId: null, backgrounds: [] });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.zone).toMatchObject({ backgroundAssetId: null, artworkAssetId: art.id });
    const key = (await storedRow(bg.id)).storageKey;
    const deleted = await call('DELETE', `/admin/artwork/assets/${bg.id}`);
    expect(deleted.json().data).toEqual({ deleted: true });
    expect((await call('GET', `/admin/artwork/assets/${bg.id}`)).statusCode).toBe(404);
    expect((await getFile(bg.id)).statusCode).toBe(404);
    expect(fs.existsSync(path.join(storageDir, ...key.split('/')))).toBe(false);
    // Soft: the row and its history remain.
    expect(await storedRow(bg.id)).toMatchObject({ status: 'deleted' });
    expect(await eventsOf(bg.id)).toEqual([
      'upload',
      'reference_added',
      'reference_added',
      'disable',
      'enable',
      'reference_removed',
      'reference_removed',
      'delete',
    ]);
    // A deleted asset can no longer be referenced or replaced.
    expect((await saveZone({ backgroundAssetId: bg.id })).statusCode).toBe(400);
    expect((await call('DELETE', `/admin/artwork/assets/${bg.id}`)).statusCode).toBe(404);

    await saveZone({ artworkAssetId: null });
  });

  it('records who changed a reference, from the session — never the bytes', async () => {
    const asset = await uploaded(await solidImage(64, 64, GREEN), { filename: 'audited.png' });
    const current = await getZone();
    const res = await api.inject({
      method: 'PUT',
      url: `/api/v1/admin/dungeons/zones/${ZONE}`,
      cookies: { wm_portal_session: OWNER_TOKEN, wm_portal_csrf: CSRF },
      headers: { 'x-portal-csrf': CSRF },
      payload: { zone: { ...current.zone, artworkAssetId: asset.id }, expectedRevision: current.revision },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [event] = (await call('GET', `/admin/artwork/assets/${asset.id}`)).json().data.events;
    expect(event).toMatchObject({
      action: 'reference_added',
      actor: OWNER_ID,
      details: { entity: `dungeon_zone:${ZONE}`, field: 'artworkAssetId', from: null, to: asset.id },
    });
    expect(event.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await saveZone({ artworkAssetId: null });
  });
});

describe('enemy artwork', () => {
  const enemyKey = () => (app.content.combatEnemies ?? [])[0]!.key;
  const entry = async (key: string) =>
    ((await call('GET', '/admin/dungeons/enemy-artwork')).json().data.enemies as Asset[]).find((e) => e.key === key)!;

  it('lists every enemy with its shipped art and no override', async () => {
    const enemies = (await call('GET', '/admin/dungeons/enemy-artwork')).json().data.enemies as Asset[];
    expect(enemies.map((e) => e.key)).toEqual((app.content.combatEnemies ?? []).map((e) => e.key));
    const first = enemies[0]!;
    expect(first.managed).toBeNull();
    expect(first.visual).toMatchObject({
      artworkAssetId: null,
      spriteAssetId: null,
      artworkPath: first.artworkPath,
      spritePlacement: { anchor: 'bottom-right', scaleBasisPoints: 8500, offsetX: 0, offsetY: 0 },
    });
  });

  it('sets a sprite, full art and placement; clears back to shipped; and is optimistic', async () => {
    const key = enemyKey();
    const sprite = await uploaded(await transparentSprite(200, 300), { category: 'enemy_sprite', filename: 'sprite.png' });
    const full = await uploaded(await solidImage(400, 400, RED), { category: 'enemy_art', filename: 'full.png' });
    const placement = { anchor: 'bottom-center', scaleBasisPoints: 7000, offsetX: -40, offsetY: 10 };

    const saved = await call('PUT', `/admin/dungeons/enemy-artwork/${key}`, {
      artworkAssetId: full.id,
      spriteAssetId: sprite.id,
      spritePlacement: placement,
      expectedRevision: 0,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({
      key,
      managed: { artworkAssetId: full.id, spriteAssetId: sprite.id, spritePlacement: placement, revision: 1 },
      visual: { artworkAssetId: full.id, spriteAssetId: sprite.id, spritePlacement: placement },
    });
    // The shipped path is still there underneath.
    expect(saved.json().data.visual.artworkPath).toBe((await entry(key)).artworkPath);

    // The sprite now knows the enemy uses it, and cannot be deleted.
    expect((await call('GET', `/admin/artwork/assets/${sprite.id}`)).json().data.references).toEqual([
      { kind: 'combat_enemy', key, name: null, field: 'spriteAssetId' },
    ]);
    expect((await call('DELETE', `/admin/artwork/assets/${sprite.id}`)).statusCode).toBe(409);

    // A stale save is refused, not merged.
    const stale = await call('PUT', `/admin/dungeons/enemy-artwork/${key}`, {
      artworkAssetId: null,
      spriteAssetId: null,
      spritePlacement: null,
      expectedRevision: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'ENEMY_ARTWORK_STALE', details: { expectedRevision: 0, currentRevision: 1 } });

    // Out-of-range placement, an unknown asset and an unknown enemy are refused.
    const bad = (body: Record<string, unknown>, k = key) =>
      call('PUT', `/admin/dungeons/enemy-artwork/${k}`, { artworkAssetId: null, spriteAssetId: null, spritePlacement: null, expectedRevision: 1, ...body });
    expect((await bad({ spritePlacement: { ...placement, scaleBasisPoints: 20_000 } })).statusCode).toBe(400);
    expect((await bad({ spritePlacement: { ...placement, anchor: 'top' } })).statusCode).toBe(400);
    expect((await bad({ spriteAssetId: '00000000-0000-4000-8000-0000000000cc' })).statusCode).toBe(400);
    expect((await bad({}, 'no_such_enemy')).statusCode).toBe(404);
    expect((await entry(key)).managed.revision).toBe(1);

    // Clearing the override falls back to shipped art and the default placement, and frees the assets.
    const cleared = await bad({});
    expect(cleared.json().data).toMatchObject({
      managed: { artworkAssetId: null, spriteAssetId: null, spritePlacement: null, revision: 2 },
      visual: { artworkAssetId: null, spriteAssetId: null, spritePlacement: { anchor: 'bottom-right', scaleBasisPoints: 8500 } },
    });
    expect(await eventsOf(sprite.id)).toEqual(['upload', 'reference_added', 'reference_removed']);
    expect((await call('DELETE', `/admin/artwork/assets/${sprite.id}`)).statusCode).toBe(200);
  });
});

describe('scene preview', () => {
  it('composes a managed background and sprite with the production renderer', async () => {
    const bg = await uploaded(await solidImage(800, 450, BLUE), { filename: 'preview-bg.png' });
    const sprite = await uploaded(await transparentSprite(300, 300, RED), { category: 'enemy_sprite', filename: 'preview-sprite.png' });
    const res = await call('POST', '/admin/artwork/scene-preview', {
      background: { assetId: bg.id },
      sprite: { assetId: sprite.id },
      placement: { anchor: 'center', scaleBasisPoints: 8000, offsetX: 0, offsetY: 0 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(await sharp(res.rawPayload).metadata()).toMatchObject({ format: 'webp', width: 1200, height: 675 });
    expect(isNear(await pixelAt(res.rawPayload, 600, 337), RED)).toBe(true);
    expect(isNear(await pixelAt(res.rawPayload, 20, 20), BLUE)).toBe(true);

    // The render is cached by content: the same request is the same scene.
    const again = await call('POST', '/admin/artwork/scene-preview', {
      background: { assetId: bg.id },
      sprite: { assetId: sprite.id },
      placement: { anchor: 'center', scaleBasisPoints: 8000, offsetX: 0, offsetY: 0 },
    });
    expect(again.headers.etag).toBe(res.headers.etag);
    const moved = await call('POST', '/admin/artwork/scene-preview', {
      background: { assetId: bg.id },
      sprite: { assetId: sprite.id },
      placement: { anchor: 'left', scaleBasisPoints: 8000, offsetX: 0, offsetY: 0 },
    });
    expect(moved.headers.etag).not.toBe(res.headers.etag);

    // A disabled asset can still be previewed — the admin is deciding about it.
    await call('PUT', `/admin/artwork/assets/${sprite.id}/enabled`, { enabled: false });
    expect((await call('POST', '/admin/artwork/scene-preview', { background: { assetId: bg.id }, sprite: { assetId: sprite.id } })).statusCode).toBe(200);
  });

  it('composes over shipped artwork, background alone, and answers 404 for what is not there', async () => {
    const shipped = await call('POST', '/admin/artwork/scene-preview', { background: { artworkPath: 'dungeons/backgrounds/shipped.png' } });
    expect(shipped.statusCode, shipped.body).toBe(200);
    expect(isNear(await pixelAt(shipped.rawPayload, 600, 337), GREEN)).toBe(true);

    expect((await call('POST', '/admin/artwork/scene-preview', { background: { assetId: '00000000-0000-4000-8000-0000000000dd' } })).statusCode).toBe(404);
    expect((await call('POST', '/admin/artwork/scene-preview', { background: { artworkPath: 'dungeons/backgrounds/missing.png' } })).statusCode).toBe(404);
    // A path cannot leave the assets root, and nothing but the two named fields is accepted.
    expect((await call('POST', '/admin/artwork/scene-preview', { background: { artworkPath: '../managed/x.png' } })).statusCode).toBe(404);
    expect((await call('POST', '/admin/artwork/scene-preview', { background: { url: 'http://example.com/x.png' } })).statusCode).toBe(400);
    expect(
      (await call('POST', '/admin/artwork/scene-preview', {
        background: { artworkPath: 'dungeons/backgrounds/shipped.png' },
        placement: { anchor: 'center', scaleBasisPoints: 8000, offsetX: 9999, offsetY: 0 },
      })).statusCode,
    ).toBe(400);
  });
});

describe('permissions and CSRF', () => {
  const png = () => solidImage(32, 32, { r: 7, g: 7, b: 7 });
  const asCookie = (token: string, withCsrf: boolean, extra: Record<string, string> = {}) => ({
    cookies: { wm_portal_session: token, wm_portal_csrf: CSRF },
    headers: { ...(withCsrf ? { 'x-portal-csrf': CSRF } : {}), ...extra },
  });

  it('refuses a caller with no session', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/v1/admin/artwork/assets' })).statusCode).toBe(401);
    const res = await api.inject({ method: 'POST', url: '/api/v1/admin/artwork/assets?category=enemy_sprite', headers: { 'content-type': 'image/png' }, payload: await png() });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a signed-in player with no artwork permission — reads and writes alike', async () => {
    const asset = await uploaded(await png(), { filename: 'guarded.png' });
    const before = filesUnder(storageDir);
    const player = asCookie(NON_OWNER_TOKEN, true);
    for (const url of ['/admin/artwork/assets', '/admin/artwork/meta', `/admin/artwork/assets/${asset.id}`, `/admin/artwork/assets/${asset.id}/file`, '/admin/dungeons/enemy-artwork']) {
      const res = await api.inject({ method: 'GET', url: `/api/v1${url}`, ...player });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    }
    const uploadAttempt = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/artwork/assets?category=enemy_sprite',
      cookies: player.cookies,
      headers: { ...player.headers, 'content-type': 'image/png' },
      payload: await png(),
    });
    expect(uploadAttempt.statusCode).toBe(403);
    for (const [method, url, payload] of [
      ['PATCH', `/admin/artwork/assets/${asset.id}`, { name: 'x' }],
      ['PUT', `/admin/artwork/assets/${asset.id}/enabled`, { enabled: false }],
      ['DELETE', `/admin/artwork/assets/${asset.id}`, undefined],
      ['POST', '/admin/artwork/scene-preview', { background: { assetId: asset.id } }],
      ['PUT', '/admin/dungeons/enemy-artwork/scrapyard_drone', { artworkAssetId: null, spriteAssetId: null, spritePlacement: null, expectedRevision: 0 }],
    ] as const) {
      const res = await api.inject({ method, url: `/api/v1${url}`, ...player, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(filesUnder(storageDir)).toEqual(before);
    expect(await storedRow(asset.id)).toMatchObject({ status: 'active', name: 'guarded' });
  });

  it('an admin session uploads with a CSRF token and is refused without one', async () => {
    const before = filesUnder(storageDir);
    const owner = asCookie(OWNER_TOKEN, false, { 'content-type': 'image/png' });
    const noCsrf = await api.inject({ method: 'POST', url: '/api/v1/admin/artwork/assets?category=enemy_sprite&filename=csrf.png', ...owner, payload: await png() });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('PORTAL_CSRF_INVALID');
    const wrong = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/artwork/assets?category=enemy_sprite&filename=csrf.png',
      cookies: owner.cookies,
      headers: { 'content-type': 'image/png', 'x-portal-csrf': 'wrong' },
      payload: await png(),
    });
    expect(wrong.statusCode).toBe(403);
    expect(filesUnder(storageDir)).toEqual(before);

    const withCsrf = asCookie(OWNER_TOKEN, true, { 'content-type': 'image/png' });
    const ok = await api.inject({ method: 'POST', url: '/api/v1/admin/artwork/assets?category=enemy_sprite&filename=csrf.png', ...withCsrf, payload: await png() });
    expect(ok.statusCode, ok.body).toBe(200);
    // The uploader is the session's user, never something the request said.
    expect(ok.json().data.asset).toMatchObject({ uploadedBy: OWNER_ID, updatedBy: OWNER_ID });
    expect(filesUnder(storageDir)).toHaveLength(before.length + 1);
  });
});

describe('performance sanity', () => {
  it('uploads, first renders and cached renders stay well inside an interaction', async () => {
    const background = await sharp({ create: { width: 2400, height: 1350, channels: 3, background: BLUE, noise: { type: 'gaussian', mean: 128, sigma: 30 } } })
      .webp({ quality: 85 })
      .toBuffer();
    const spriteBytes = await transparentSprite(900, 1200, RED);
    const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
      const start = performance.now();
      const result = await work();
      return [result, performance.now() - start];
    };
    const [bg, uploadMs] = await timed(() => assets.upload({ bytes: background, category: 'dungeon_background', filename: 'big.webp' }, null));
    const sprite = await assets.upload({ bytes: spriteBytes, category: 'enemy_sprite', filename: 'big-sprite.png' }, null);
    const scenes = createSceneCompositionService({ cacheDir: path.join(root, 'perf-cache') });
    const request = async () => ({
      background: (await assets.layer(bg.id))!,
      sprite: { layer: (await assets.layer(sprite.id))!, placement: { anchor: 'bottom-right' as const, scaleBasisPoints: 8500, offsetX: 0, offsetY: 0 } },
    });
    const [first, firstMs] = await timed(async () => scenes.compose(await request()));
    const [second, cachedMs] = await timed(async () => scenes.compose(await request()));
    expect(first).toMatchObject({ cached: false });
    expect(second).toMatchObject({ cached: true });
    // eslint-disable-next-line no-console
    console.info(
      `[artwork perf] upload ${(background.length / 1024).toFixed(0)}KB 2400x1350: ${uploadMs.toFixed(0)}ms · ` +
        `first compose: ${firstMs.toFixed(0)}ms · cached compose: ${cachedMs.toFixed(1)}ms · ` +
        `scene ${(fs.statSync(first!.absolutePath).size / 1024).toFixed(0)}KB`,
    );
    // Generous ceilings: Discord allows 3s to acknowledge an interaction.
    expect(uploadMs).toBeLessThan(2500);
    expect(firstMs).toBeLessThan(2500);
    expect(cachedMs).toBeLessThan(250);
    fs.rmSync(path.join(root, 'perf-cache'), { recursive: true, force: true });
  });
});
