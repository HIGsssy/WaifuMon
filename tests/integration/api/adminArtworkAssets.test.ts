/**
 * Managed artwork over the Admin API, against a real database and a real
 * (temporary) storage directory: uploads and their validation, metadata,
 * replacement and cache invalidation, reference integrity, the audit trail,
 * the scene preview, and who may do any of it.
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
import { ARTWORK_UPLOAD_MAX_BYTES } from '../../../src/modules/artworkAssets/imageInspection';
import { createSceneCompositionService } from '../../../src/modules/artworkAssets/sceneComposition';
import { createDungeonContentService } from '../../../src/modules/dungeons/dungeonContentService';
import { dungeonEnemyReferences } from '../../../src/modules/enemies/enemyReferences';
import { createEnemyCatalogueService } from '../../../src/modules/enemies/enemyService';
import { seedCombatEnemies, shippedCombatEnemies } from '../../../src/modules/enemies/enemyStore';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import { createProgressionCurrencyService } from '../../../src/modules/progressionCurrency/progressionCurrencyService';
import { loadShippedRewardTables, seedRewardTables } from '../../../src/modules/rewardTables/rewardTableStore';
import { TEST_ENEMIES, singleRoomDungeon } from '../../helpers/dungeonFixtures';
import { CONTENT_DIR, bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { BLUE, GREEN, RED, isNear, opaqueSprite, pixelAt, solidImage, transparentSprite } from '../../helpers/imageFixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555991';
const OWNER_ID = '777888999000111551';
const NON_OWNER_ID = '999999999999999991';
const OWNER_TOKEN = 'token-owner';
const NON_OWNER_TOKEN = 'token-non-owner';
const CSRF = 'csrf-token';
const DUNGEON = 'art_depths';
const DUNGEON_NAME = 'Art Depths';

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

  assets = createArtworkAssetService({ db: t.db, storage: createLocalArtworkStorage(storageDir) });
  const sceneComposition = createSceneCompositionService({ cacheDir });
  const shippedEnemies = shippedCombatEnemies(TEST_ENEMIES);
  await seedCombatEnemies(t.db, shippedEnemies);
  const enemies = createEnemyCatalogueService({
    db: t.db,
    getShipped: () => shippedEnemies,
    assets,
    referenceSources: [dungeonEnemyReferences],
  });
  const dungeonContent = createDungeonContentService({
    db: t.db,
    enemies,
    getRegions: () => app.content.regions.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
    assetsDir,
    environment: 'test',
  });
  // One dungeon draft — rooms `hall` and `out` — for the artwork references below.
  await dungeonContent.create(
    {
      definition: singleRoomDungeon([{ id: 'guards', type: 'combat', waves: [{ enemy: { key: 'grunt' } }] }], (d) => {
        d.key = DUNGEON;
        d.name = DUNGEON_NAME;
      }),
    },
    'test',
  );
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
      services: { ...app, dungeonContent, enemies, progressionCurrency, artworkAssets: assets, sceneComposition },
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
const getDungeon = async () => (await call('GET', `/admin/dungeons/definitions/${DUNGEON}`)).json().data;
/** Save the dungeon's draft with `patch` applied; `hallBackground` sets the first room's backdrop. */
const saveDungeon = async ({ hallBackground, ...patch }: Record<string, unknown>) => {
  const current = await getDungeon();
  const definition = { ...current.draft, ...patch };
  if (hallBackground !== undefined) {
    definition.rooms = current.draft.rooms.map((room: Asset) => (room.id === 'hall' ? { ...room, background: hallBackground } : room));
  }
  return call('PUT', `/admin/dungeons/definitions/${DUNGEON}/draft`, { definition, expectedRevision: current.draftRevision });
};
/** How a dungeon names a managed image: by category and the hash of its bytes, never its id. */
const managed = (asset: Asset, name?: string) => ({
  kind: 'managed',
  category: asset.category,
  contentHash: asset.contentHash,
  ...(name ? { name } : {}),
});
const artworkIssues = (detail: Asset) => (detail.issues as Asset[]).filter((i) => i.code === 'artwork_missing');

describe('with nothing uploaded yet', () => {
  it('lists an empty library as a success, exactly as the Portal asks for it', async () => {
    // The Browse panel's request, and the pickers'.
    for (const url of ['/admin/artwork/assets?limit=120', '/admin/artwork/assets?limit=120&status=active&category=dungeon_background']) {
      const res = await call('GET', url);
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
      expect(res.json().data).toEqual({ assets: [], total: 0 });
    }
    expect((await call('GET', '/admin/artwork/meta')).statusCode).toBe(200);
    // Nothing shipped in Git is listed here: shipped art is a separate system.
    expect(filesUnder(storageDir)).toEqual([]);
  });
});

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
  it('a dungeon names managed artwork by a well-formed hash; one this environment lacks is flagged, not stored silently', async () => {
    // A reference that is not a sha256 (an asset id, say) is an unreadable shape: refused.
    for (const bad of [
      { kind: 'managed', category: 'dungeon_background', contentHash: '00000000-0000-4000-8000-0000000000aa' },
      { kind: 'managed', category: 'dungeon_background', contentHash: 'not-a-hash' },
      { kind: 'managed', contentHash: 'a'.repeat(64) },
    ]) {
      const res = await saveDungeon({ background: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error.code).toBe('DUNGEON_INVALID');
      expect(res.json().error.details.issues).toContainEqual(
        expect.objectContaining({ code: 'schema', severity: 'error', path: expect.stringContaining('background') }),
      );
    }
    const room = await saveDungeon({ hallBackground: { kind: 'managed', category: 'dungeon_background', contentHash: 'nope' } });
    expect(room.statusCode).toBe(400);
    expect(room.json().error.details.issues).toContainEqual(
      expect.objectContaining({ code: 'schema', severity: 'error', path: 'rooms[0].background.contentHash' }),
    );
    expect((await getDungeon()).draft).toMatchObject({ artwork: null, background: null });

    // A well-formed hash no asset here holds: reported by the dry run, with the stable code.
    const ghost = { kind: 'managed', category: 'dungeon_background', contentHash: 'b'.repeat(64), name: 'ghost.png' };
    const dry = await call('POST', '/admin/dungeons/validate', { definition: { ...(await getDungeon()).draft, background: ghost } });
    expect(dry.json().data.issues).toContainEqual(
      expect.objectContaining({ code: 'artwork_missing', severity: 'warning', message: expect.stringContaining('ghost.png') }),
    );
  });

  it('a referenced asset cannot be deleted, can be disabled, and is released once cleared', async () => {
    // Bytes no other asset in this file holds: a dungeon's reference is to the bytes, whichever asset has them.
    const art = await uploaded(await solidImage(302, 302, RED), { category: 'dungeon_zone', filename: 'zone.png' });
    const bg = await uploaded(await solidImage(642, 362, BLUE), { filename: 'bg.png', name: 'Scrap Night' });
    const saved = await saveDungeon({
      artwork: managed(art),
      background: managed(bg, 'Scrap Night'),
      hallBackground: managed(bg, 'Scrap Night'),
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data.draft).toMatchObject({ artwork: managed(art), background: managed(bg, 'Scrap Night') });
    expect(saved.json().data.draft.rooms[0].background).toEqual(managed(bg, 'Scrap Night'));
    expect(artworkIssues(saved.json().data)).toEqual([]);

    // The asset knows what uses it.
    const detail = (await call('GET', `/admin/artwork/assets/${bg.id}`)).json().data;
    expect(detail.references).toEqual([
      { kind: 'dungeon_zone', key: DUNGEON, name: DUNGEON_NAME, field: 'draft.background' },
      { kind: 'dungeon_zone', key: DUNGEON, name: DUNGEON_NAME, field: 'draft.rooms[hall].background' },
    ]);
    expect((await call('GET', `/admin/artwork/assets/${art.id}`)).json().data.references).toEqual([
      { kind: 'dungeon_zone', key: DUNGEON, name: DUNGEON_NAME, field: 'draft.artwork' },
    ]);

    // Deleting it is refused, with the references, and changes nothing.
    const refused = await call('DELETE', `/admin/artwork/assets/${bg.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'ARTWORK_ASSET_IN_USE' });
    expect(refused.json().error.details.references).toHaveLength(2);
    expect((await getFile(bg.id)).statusCode).toBe(200);
    expect((await storedRow(bg.id)).status).toBe('active');

    // Disabling is allowed, says what it affects, and the dungeon is told (a warning, not an error).
    const disabled = await call('PUT', `/admin/artwork/assets/${bg.id}/enabled`, { enabled: false });
    expect(disabled.json().data).toMatchObject({ asset: { status: 'disabled' } });
    expect(disabled.json().data.references).toHaveLength(2);
    const dungeon = await getDungeon();
    expect(dungeon.issues).toContainEqual(
      expect.objectContaining({ code: 'artwork_missing', path: 'artwork', severity: 'warning', message: expect.stringContaining('Scrap Night') }),
    );
    expect(dungeon.issues.filter((i: Asset) => i.severity === 'error')).toEqual([]);
    // Players no longer get it; the admin still can preview it.
    expect(await assets.readUsable(bg.id)).toBeNull();
    expect(await assets.layer(bg.id)).toBeNull();
    expect((await getFile(bg.id)).statusCode).toBe(200);
    await call('PUT', `/admin/artwork/assets/${bg.id}/enabled`, { enabled: true });
    expect(await assets.readUsable(bg.id)).not.toBeNull();
    expect(artworkIssues(await getDungeon())).toEqual([]);

    // Clearing every reference releases it.
    const cleared = await saveDungeon({ background: null, hallBackground: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.draft).toMatchObject({ background: null, artwork: managed(art) });
    expect(cleared.json().data.draft.rooms[0].background).toBeNull();
    expect((await call('GET', `/admin/artwork/assets/${bg.id}`)).json().data.references).toEqual([]);
    const key = (await storedRow(bg.id)).storageKey;
    const deleted = await call('DELETE', `/admin/artwork/assets/${bg.id}`);
    expect(deleted.json().data).toEqual({ deleted: true });
    expect((await call('GET', `/admin/artwork/assets/${bg.id}`)).statusCode).toBe(404);
    expect((await getFile(bg.id)).statusCode).toBe(404);
    expect(fs.existsSync(path.join(storageDir, ...key.split('/')))).toBe(false);
    // Soft: the row and its history remain.
    expect(await storedRow(bg.id)).toMatchObject({ status: 'deleted' });
    expect(await eventsOf(bg.id)).toEqual(['upload', 'disable', 'enable', 'delete']);
    // A deleted asset no longer backs a reference: naming its bytes again is flagged.
    const again = await saveDungeon({ background: managed(bg, 'Scrap Night') });
    expect(again.statusCode, again.body).toBe(200);
    expect(artworkIssues(again.json().data)).toEqual([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining(bg.contentHash.slice(0, 12)) }),
    ]);
    expect((await call('DELETE', `/admin/artwork/assets/${bg.id}`)).statusCode).toBe(404);

    await saveDungeon({ artwork: null, background: null });
  });

  it('records who changed a reference, from the session — never the bytes', async () => {
    const asset = await uploaded(await transparentSprite(120, 160, GREEN), { category: 'enemy_sprite', filename: 'audited.png' });
    const current = (await call('GET', '/admin/enemies/grunt')).json().data;
    const res = await api.inject({
      method: 'PUT',
      url: '/api/v1/admin/enemies/grunt',
      cookies: { wm_portal_session: OWNER_TOKEN, wm_portal_csrf: CSRF },
      headers: { 'x-portal-csrf': CSRF },
      payload: {
        enemy: {
          name: current.name,
          description: current.description,
          enabled: current.enabled,
          attack: current.attack,
          defense: current.defense,
          hp: current.hp,
          tags: current.tags,
          spriteAssetId: asset.id,
        },
        expectedRevision: current.revision,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [event] = (await call('GET', `/admin/artwork/assets/${asset.id}`)).json().data.events;
    expect(event).toMatchObject({
      action: 'reference_added',
      actor: OWNER_ID,
      details: { entity: 'combat_enemy:grunt', field: 'spriteAssetId', from: null, to: asset.id },
    });
    expect(event.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('shipped and managed artwork are separate stores', () => {
  it('the dungeon shipped-art browser reads ASSETS_DIR only — never managed uploads or the scene cache', async () => {
    const uploadedBg = await uploaded(await solidImage(64, 64, RED), { filename: 'managed-only-marker.png', name: 'Managed Only Marker' });
    const row = await storedRow(uploadedBg.id);

    // Browse: exactly what is under <ASSETS_DIR>/dungeons, and nothing uploaded.
    const top = (await call('GET', '/admin/dungeons/artwork/browse')).json().data;
    expect(top).toMatchObject({ path: 'dungeons', missing: false });
    expect(top.directories.map((d: Asset) => d.path)).toEqual(['dungeons/backgrounds']);
    const folder = (await call('GET', '/admin/dungeons/artwork/browse?path=dungeons/backgrounds')).json().data;
    expect(folder.files.map((f: Asset) => f.path)).toEqual(['dungeons/backgrounds/shipped.png']);
    // Search never finds an upload by name, file name, id or hash.
    for (const q of ['managed-only-marker', 'Marker', uploadedBg.id, uploadedBg.contentHash.slice(0, 12), 'dungeon_background']) {
      expect((await call('GET', `/admin/dungeons/artwork/search?q=${encodeURIComponent(q)}`)).json().data.results, q).toEqual([]);
    }
    // The shipped-path byte route cannot be pointed at a managed file or the cache.
    for (const p of [row.storageKey, `../managed/${row.storageKey}`, `../cache/x.webp`, `dungeons/../../managed/${row.storageKey}`]) {
      const res = await call('GET', `/admin/dungeons/artwork?path=${encodeURIComponent(p)}`);
      expect([400, 404], p).toContain(res.statusCode);
    }
    // And the shipped file it does serve comes from the assets tree.
    const shipped = await call('GET', '/admin/dungeons/artwork?path=dungeons/backgrounds/shipped.png');
    expect(shipped.statusCode).toBe(200);
    expect(shipped.rawPayload.equals(fs.readFileSync(path.join(assetsDir, 'dungeons', 'backgrounds', 'shipped.png')))).toBe(true);

    // The other direction: the managed list knows nothing of shipped files.
    const managed = (await call('GET', '/admin/artwork/assets?q=shipped&limit=200')).json().data.assets;
    expect(managed).toEqual([]);
  });

  it('managed upload, select, preview and composition work with no shipped dungeon artwork at all', async () => {
    const parked = path.join(root, 'dungeons-parked');
    fs.renameSync(path.join(assetsDir, 'dungeons'), parked);
    try {
      expect((await call('GET', '/admin/dungeons/artwork/browse')).json().data).toMatchObject({ missing: true, files: [] });
      const bg = await uploaded(await solidImage(320, 180, BLUE), { filename: 'no-shipped-bg.png' });
      const sprite = await uploaded(await transparentSprite(120, 120, RED), { category: 'enemy_sprite', filename: 'no-shipped-sprite.png' });
      expect(((await call('GET', '/admin/artwork/assets?q=no-shipped')).json().data.assets as Asset[]).map((a) => a.id).sort()).toEqual(
        [bg.id, sprite.id].sort(),
      );
      expect((await getFile(bg.id)).statusCode).toBe(200);
      const scene = await call('POST', '/admin/artwork/scene-preview', {
        background: { assetId: bg.id },
        sprite: { assetId: sprite.id },
        placement: { anchor: 'center', scaleBasisPoints: 8000, offsetX: 0, offsetY: 0 },
      });
      expect(scene.statusCode, scene.body).toBe(200);
      expect(isNear(await pixelAt(scene.rawPayload, 600, 337), RED)).toBe(true);
      // A dungeon can use the upload while a shipped path beside it points at nothing.
      const saved = await saveDungeon({
        background: managed(bg),
        hallBackground: { kind: 'shipped', path: 'dungeons/backgrounds/shipped.png' },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      // Only the shipped file is reported missing; the upload is usable.
      expect(artworkIssues(saved.json().data)).toEqual([
        expect.objectContaining({ severity: 'warning', message: expect.stringContaining('dungeons/backgrounds/shipped.png') }),
      ]);
      await saveDungeon({ background: null, hallBackground: null });
    } finally {
      fs.renameSync(parked, path.join(assetsDir, 'dungeons'));
    }
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

describe('scene preview: the reserved player Buddy', () => {
  const spriteDir = (slug: string) => path.join(assetsDir, 'waifumon', slug);
  const ship = async (slug: string) => {
    fs.mkdirSync(spriteDir(slug), { recursive: true });
    fs.writeFileSync(path.join(spriteDir(slug), `${slug}_sprite.webp`), await opaqueSprite(200, 300, GREEN, 'webp'));
  };

  it('draws a stand-in Buddy bottom-left on request, and reports whether the enemy collides with her', async () => {
    const slugs = app.content.species.map((s) => s.slug).sort();
    const bg = await uploaded(await solidImage(800, 450, BLUE), { filename: 'buddy-preview-bg.png' });
    const sprite = await uploaded(await opaqueSprite(200, 300, RED), { category: 'enemy_sprite', filename: 'buddy-preview-sprite.png' });
    const preview = (placement: Record<string, unknown>, playerBuddy?: Record<string, unknown> | null) =>
      call('POST', '/admin/artwork/scene-preview', {
        background: { assetId: bg.id },
        sprite: { assetId: sprite.id },
        placement: { anchor: 'bottom-right', scaleBasisPoints: 5000, offsetX: 0, offsetY: 0, ...placement },
        ...(playerBuddy !== undefined ? { playerBuddy } : {}),
      });
    // Where a 200×300 Buddy stands: the compositor's reserved box.
    const at = { x: 228, y: 391 };

    // No species has a sprite deployed: the preview is the scene without her, and says nothing.
    const none = await preview({}, {});
    expect(none.statusCode, none.body).toBe(200);
    expect(none.headers['x-scene-player-buddy']).toBeUndefined();
    expect(isNear(await pixelAt(none.rawPayload, at.x, at.y), BLUE)).toBe(true);

    await ship(slugs[1]!);
    await ship(slugs[2]!);
    try {
      // Not asked for: no Buddy, exactly the scene it always was.
      const plain = await preview({});
      expect(plain.headers.etag).toBe(none.headers.etag);
      expect(plain.headers['x-scene-player-buddy']).toBeUndefined();

      // Asked for: the first species with a sprite stands in, clear of a right-side enemy.
      const clear = await preview({}, {});
      expect(clear.statusCode, clear.body).toBe(200);
      expect(clear.headers).toMatchObject({
        'x-scene-player-buddy': slugs[1],
        'x-scene-player-buddy-overlap': '0',
        'x-scene-player-buddy-collision': 'false',
      });
      expect(clear.headers.etag).not.toBe(plain.headers.etag);
      expect(isNear(await pixelAt(clear.rawPayload, at.x, at.y), GREEN)).toBe(true);
      expect(isNear(await pixelAt(clear.rawPayload, 1000, 500), RED)).toBe(true);

      // A named species is used as given.
      expect((await preview({}, { speciesSlug: slugs[2] })).headers['x-scene-player-buddy']).toBe(slugs[2]);
      // One without a sprite: no Buddy, still a picture.
      const spriteless = await preview({}, { speciesSlug: slugs[0] });
      expect(spriteless.statusCode).toBe(200);
      expect(spriteless.headers['x-scene-player-buddy']).toBeUndefined();

      // The left anchors are still accepted — and flagged, with the enemy drawn over her.
      const over = await preview({ anchor: 'bottom-left', scaleBasisPoints: 8000 }, {});
      expect(over.statusCode, over.body).toBe(200);
      expect(over.headers).toMatchObject({ 'x-scene-player-buddy-overlap': '100', 'x-scene-player-buddy-collision': 'true' });
      expect(isNear(await pixelAt(over.rawPayload, at.x, at.y), RED)).toBe(true);

      // A species whose sprite faces left is mirrored, as a run would draw her: a different picture, same box.
      const species = app.content.species.find((s) => s.slug === slugs[1])!;
      species.spriteFacing = 'left';
      try {
        const mirrored = await preview({}, {});
        expect(mirrored.headers).toMatchObject({ 'x-scene-player-buddy': slugs[1], 'x-scene-player-buddy-overlap': '0' });
        expect(mirrored.headers.etag).not.toBe(clear.headers.etag);
        expect(isNear(await pixelAt(mirrored.rawPayload, at.x, at.y), GREEN)).toBe(true);
      } finally {
        delete species.spriteFacing;
      }
      expect((await preview({}, {})).headers.etag).toBe(clear.headers.etag);

      // She is not a placement: nothing about where she stands is accepted.
      expect((await preview({}, { anchor: 'right' })).statusCode).toBe(400);
      expect((await preview({}, { speciesSlug: '../x' })).statusCode).toBe(400);
    } finally {
      fs.rmSync(path.join(assetsDir, 'waifumon'), { recursive: true, force: true });
    }
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
    for (const url of ['/admin/artwork/assets', '/admin/artwork/meta', `/admin/artwork/assets/${asset.id}`, `/admin/artwork/assets/${asset.id}/file`]) {
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

describe('dungeon pictures as a run resolves them', () => {
  const replaceImage = (id: string, bytes: Buffer) =>
    api.inject({
      method: 'PUT',
      url: `/api/v1/admin/artwork/assets/${id}/file?filename=replaced.png`,
      headers: { ...AUTH_BEARER, 'content-type': 'image/png' },
      payload: bytes,
    });
  const managedBytes = (ref: { category: string; contentHash: string }) =>
    call('GET', `/admin/dungeons/artwork/managed?category=${ref.category}&contentHash=${ref.contentHash}`);
  const setGruntArtwork = async (fields: { spriteAssetId: string | null; artworkAssetId: string | null }) => {
    const current = (await call('GET', '/admin/enemies/grunt')).json().data;
    const res = await call('PUT', '/admin/enemies/grunt', {
      enemy: {
        name: current.name,
        description: current.description,
        enabled: current.enabled,
        attack: current.attack,
        defense: current.defense,
        hp: current.hp,
        tags: current.tags,
        ...fields,
      },
      expectedRevision: current.revision,
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  const scene = (backgrounds: unknown[]) => call('POST', '/admin/dungeons/scene-preview', { enemyKey: 'grunt', backgrounds });
  const gruntReference = async () =>
    (await call('GET', '/admin/dungeons/reference')).json().data.enemies.find((e: Asset) => e.key === 'grunt');

  it('a dungeon keeps its background when the image is replaced in the asset manager', async () => {
    const first = await solidImage(644, 364, BLUE);
    const bg = await uploaded(first, { filename: 'tunnels.png', name: 'Tunnels' });
    const reference = managed(bg, 'Tunnels');
    expect((await saveDungeon({ background: reference, hallBackground: reference })).statusCode).toBe(200);
    expect((await managedBytes(reference)).rawPayload.equals(first)).toBe(true);

    // The artist uploads a new version of the same picture: the asset keeps its id, its bytes change.
    const second = await solidImage(648, 368, GREEN);
    const replaced: Asset = (await replaceImage(bg.id, second)).json().data.asset;
    expect(replaced.contentHash).not.toBe(bg.contentHash);

    // The dungeon still names the old bytes, untouched — and still resolves, to the new look.
    const dungeon = await getDungeon();
    expect(dungeon.draft.background).toEqual(reference);
    expect(artworkIssues(dungeon)).toEqual([]);
    const dry = await call('POST', '/admin/dungeons/validate', { definition: dungeon.draft });
    expect(artworkIssues(dry.json().data)).toEqual([]);
    const served = await managedBytes(reference);
    expect(served.statusCode, served.body).toBe(200);
    expect(served.rawPayload.equals(second)).toBe(true);
    expect((await managedBytes(managed(replaced))).rawPayload.equals(second)).toBe(true);

    // Nor moved to another category, which would orphan the reference; a rename is fine.
    const moved = await call('PATCH', `/admin/artwork/assets/${bg.id}`, { category: 'dungeon_zone' });
    expect(moved.statusCode, moved.body).toBe(409);
    expect(moved.json().error).toMatchObject({ code: 'ARTWORK_ASSET_IN_USE' });
    expect(moved.json().error.details.references.map((r: Asset) => r.field)).toEqual(['draft.background', 'draft.rooms[hall].background']);
    expect((await call('PATCH', `/admin/artwork/assets/${bg.id}`, { name: 'Tunnels v2' })).statusCode).toBe(200);
    expect((await managedBytes(reference)).statusCode).toBe(200);

    // It is still in use, so it still cannot be deleted from under the dungeon.
    const detail = (await call('GET', `/admin/artwork/assets/${bg.id}`)).json().data;
    expect(detail.references.map((r: Asset) => r.field)).toEqual(['draft.background', 'draft.rooms[hall].background']);
    expect((await call('DELETE', `/admin/artwork/assets/${bg.id}`)).statusCode).toBe(409);

    // Switched off, players lose it — and the editor is told the truth, by warning and by preview.
    await call('PUT', `/admin/artwork/assets/${bg.id}/enabled`, { enabled: false });
    expect((await managedBytes(reference)).statusCode).toBe(404);
    expect(artworkIssues(await getDungeon())).toHaveLength(1);
    await call('PUT', `/admin/artwork/assets/${bg.id}/enabled`, { enabled: true });
    expect((await managedBytes(reference)).statusCode).toBe(200);

    // Bytes no asset here ever held are simply not found.
    expect((await managedBytes({ category: 'dungeon_background', contentHash: 'c'.repeat(64) })).statusCode).toBe(404);
    expect((await managedBytes({ category: 'dungeon_background', contentHash: 'nope' })).statusCode).toBe(400);
    await saveDungeon({ background: null, hallBackground: null });
  });

  it('previews a fight as a run composes it: sprite first, on the first usable background', async () => {
    const room = await uploaded(await solidImage(652, 372, BLUE), { filename: 'room.png' });
    const dungeon = await uploaded(await solidImage(656, 376, GREEN), { filename: 'dungeon.png' });
    const sprite = await uploaded(await transparentSprite(304, 304, RED), { category: 'enemy_sprite', filename: 'grunt-sprite.png' });
    const artBytes = await solidImage(660, 380, GREEN);
    const art = await uploaded(artBytes, { category: 'enemy_art', filename: 'grunt-art.png' });
    await setGruntArtwork({ spriteAssetId: sprite.id, artworkAssetId: art.id });
    expect(await gruntReference()).toMatchObject({ sprite: true, artwork: true });

    const ghost = { kind: 'managed', category: 'dungeon_background', contentHash: 'd'.repeat(64) };
    const withRoom = await scene([managed(room), managed(dungeon)]);
    expect(withRoom.statusCode, withRoom.body).toBe(200);
    expect(withRoom.headers).toMatchObject({ 'content-type': 'image/webp', 'x-dungeon-scene': 'sprite', 'x-dungeon-scene-background': '0' });
    expect(isNear(await pixelAt(withRoom.rawPayload, 1180, 15), BLUE)).toBe(true);

    // A room background that is gone falls through to the dungeon's; with none at all, the plain stage.
    const fallen = await scene([ghost, managed(dungeon)]);
    expect(fallen.headers['x-dungeon-scene-background']).toBe('1');
    expect(isNear(await pixelAt(fallen.rawPayload, 1180, 15), GREEN)).toBe(true);
    const bare = await scene([null, ghost]);
    expect(bare.headers).toMatchObject({ 'x-dungeon-scene': 'sprite', 'x-dungeon-scene-background': 'plain' });
    const [r, g, b] = await pixelAt(bare.rawPayload, 1180, 15);
    expect(Math.max(r, g, b)).toBeLessThan(80);

    // No sprite: the full artwork is the picture — the image itself, not a scene with the Buddy
    // composed over it — and the reference data says so up front.
    await setGruntArtwork({ spriteAssetId: null, artworkAssetId: art.id });
    expect(await gruntReference()).toMatchObject({ sprite: false, artwork: true });
    const fullArt = await scene([managed(room)]);
    expect(fullArt.headers).toMatchObject({ 'x-dungeon-scene': 'full-art', 'content-type': 'image/png' });
    expect(fullArt.headers['x-dungeon-scene-background']).toBeUndefined();
    expect(fullArt.rawPayload.equals(artBytes)).toBe(true);

    // A sprite that is switched off is not usable either: the same fallback a player gets.
    await setGruntArtwork({ spriteAssetId: sprite.id, artworkAssetId: art.id });
    await call('PUT', `/admin/artwork/assets/${sprite.id}/enabled`, { enabled: false });
    expect((await scene([managed(room)])).headers['x-dungeon-scene']).toBe('full-art');
    await call('PUT', `/admin/artwork/assets/${sprite.id}/enabled`, { enabled: true });

    // Nothing to show at all, and an enemy that does not exist.
    await setGruntArtwork({ spriteAssetId: null, artworkAssetId: null });
    expect(await gruntReference()).toMatchObject({ sprite: false });
    expect((await scene([managed(room)])).statusCode).toBe(404);
    expect((await call('POST', '/admin/dungeons/scene-preview', { enemyKey: 'no_such_enemy', backgrounds: [] })).statusCode).toBe(404);
  });
});
