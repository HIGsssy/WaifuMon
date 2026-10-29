/**
 * Content Portability CP-3 — standalone Enemy Catalogue packages with
 * artwork, between two isolated environments: A ("staging") and B
 * ("production"), each its own database, shipped artwork root and managed
 * artwork root (`createDungeonWorld`), each with its own Admin API server.
 *
 * The central scenario: ten enemies with full art and transparent sprites are
 * created in A, exported, A's artwork roots are made unavailable, and the
 * package is imported into B — where nothing belongs to a dungeon.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../src/api/server';
import type { ZodFastify } from '../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../src/api/portalSession';
import { ENEMY_PACKAGE_BODY_LIMIT_BYTES } from '../../src/api/routes/v1/admin/enemyPackages';
import { MAPPED_ERROR_CODES } from '../../src/api/errors';
import { artworkAssets, combatEnemies, dungeonRuns, enemyPackageImports } from '../../src/db/schema';
import { createLocalArtworkStorage } from '../../src/modules/artworkAssets/artworkStorage';
import { readZip, writeZip } from '../../src/modules/artworkAssets/package/zipArchive';
import { ENEMY_PACKAGE_LIMITS, parseEnemyPackage } from '../../src/modules/enemies/enemyPackage';
import {
  createEnemyPackageService,
  type EnemyImportPreview,
  type EnemyPackageService,
  type EnemyPackageServiceDeps,
} from '../../src/modules/enemies/enemyPackageService';
import { createGuildOwnershipService } from '../../src/modules/portalAuth/guildOwnershipService';
import {
  createPortalAuthorizationService,
  type PortalAuthorizationService,
  type PortalPermission,
} from '../../src/modules/portalAuth/portalAuthService';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { solidImage, transparentSprite } from '../helpers/imageFixtures';

type Rgba = { r: number; g: number; b: number };
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../helpers/platformApiFixtures';

type Json = Record<string, any>;

interface Env {
  w: DungeonWorld;
  packages: EnemyPackageService;
  faults: NonNullable<EnemyPackageServiceDeps['faults']>;
  managedDir: string;
  api: ZodFastify;
  baseUrl: string;
}

const CSRF = 'csrf-token';
const ROLES: Record<string, PortalPermission[]> = {
  reader: ['admin.access', 'enemies.read', 'artwork.read'],
  enemyOnly: ['admin.access', 'enemies.read', 'enemies.write'],
  editor: ['admin.access', 'enemies.read', 'enemies.write', 'artwork.read', 'artwork.write'],
};
const USER_IDS: Record<string, string> = { reader: '700000000000000001', enemyOnly: '700000000000000002', editor: '700000000000000003', player: '700000000000000004' };

async function makeEnv(name: string): Promise<Env> {
  const w = await createDungeonWorld();
  const managedDir = path.join(w.artworkDir, 'managed');
  const faults: Env['faults'] = {};
  const packages = createEnemyPackageService({
    db: w.t.db,
    enemies: w.enemies,
    assets: w.assets,
    storage: createLocalArtworkStorage(managedDir),
    assetsDir: w.artworkDir,
    environment: name,
    faults,
  });
  const ownerOnly = createPortalAuthorizationService({ guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => null }) });
  const authorization: PortalAuthorizationService = {
    ...ownerOnly,
    async computePermissionsFor(session) {
      const role = Object.entries(USER_IDS).find(([, id]) => id === session?.discordUserId)?.[0];
      const permissions = role ? ROLES[role] : undefined;
      if (!permissions) return ownerOnly.computePermissionsFor(session);
      return { ...(await ownerOnly.computePermissionsFor(session)), permissions };
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
    selectedDiscordGuildId: '111',
    selectedGuildDbId: 1,
    playerId: 1,
    eligibleGuilds: [],
    csrfToken: CSRF,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const sessions = {
    getSession: async (token: string | undefined) => (token && USER_IDS[token] ? session(USER_IDS[token]!) : null),
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
  const api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 0, token: TEST_TOKEN, adminBearer: true },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    portalAuth: {
      config: { publicUrl: 'http://localhost', forwardedProto: 'http', discordClientId: 'x', discordClientSecret: 'x', sessionSecret: 'x', sessionTtlSeconds: 3600 },
      sessions: sessions as unknown as PortalSessionService,
      authorization,
    },
    ctx: {
      services: { ...w.app, enemies: w.enemies, artworkAssets: w.assets, enemyPackages: packages },
      getContent: () => w.app.content,
      portalAuthorization: authorization,
      adminBearerAllowed: true,
    },
  });
  const baseUrl = await api.listen({ host: '127.0.0.1', port: 0 });
  return { w, packages, faults, managedDir, api, baseUrl };
}

let A: Env;
let B: Env;

beforeAll(async () => {
  A = await makeEnv('staging-a');
  B = await makeEnv('production-b');
}, 180_000);

afterAll(async () => {
  for (const e of [A, B]) {
    await e?.api.close();
    await e?.w.cleanup();
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const color = (i: number): Rgba => ({ r: (i * 23) % 256, g: (255 - i * 17) % 256, b: (i * 59) % 256 });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const placement = (i: number) => ({ anchor: i % 2 ? 'bottom-center' : 'center', scaleBasisPoints: 4000 + i * 300, offsetX: i * 7, offsetY: -(i * 3) || 0 }) as const;

async function exportOver(e: Env, body: Json, headers: Record<string, string> = AUTH): Promise<{ status: number; zip: Buffer; json: Json | null }> {
  const res = await fetch(`${e.baseUrl}/api/v1/admin/enemies/export/package`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, zip: buf, json: res.headers.get('content-type')?.includes('json') ? (JSON.parse(buf.toString()) as Json) : null };
}
async function upload(e: Env, url: string, zip: Buffer, headers: Record<string, string> = AUTH): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${e.baseUrl}/api/v1${url}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/zip' }, body: zip });
  return { status: res.status, json: (await res.json()) as Json };
}
const preview = async (e: Env, zip: Buffer): Promise<EnemyImportPreview> => {
  const res = await upload(e, '/admin/enemies/import/preview', zip);
  expect(res.status, JSON.stringify(res.json).slice(0, 800)).toBe(200);
  return res.json.data as EnemyImportPreview;
};
const applyUrl = (p: EnemyImportPreview, decisions = '', requestId = randomUUID()) =>
  `/admin/enemies/import/apply?expectedPlanHash=${encodeURIComponent(p.planHash)}&requestId=${requestId}&decisions=${decisions}`;
const enemyRow = async (e: Env, key: string) => (await e.w.t.db.select().from(combatEnemies).where(eq(combatEnemies.enemyKey, key)))[0];
const assetCount = async (e: Env) => (await e.w.t.db.select({ n: sql<number>`count(*)::int` }).from(artworkAssets))[0]!.n;
const managedFiles = (e: Env): string[] => {
  if (!fs.existsSync(e.managedDir)) return [];
  return (fs.readdirSync(e.managedDir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((d) => d.isFile())
    .map((d) => path.relative(e.managedDir, path.join(d.parentPath, d.name)))
    .sort();
};
async function edit(e: Env, key: string, change: Json) {
  const current = (await e.w.enemies.get(key))!;
  const { name, description, enabled, attack, defense, hp, tags } = current;
  return e.w.enemies.update(key, { enemy: { name, description, enabled, attack, defense, hp, tags, ...change }, expectedRevision: current.revision }, 'admin');
}
const fightDungeon = (key: string, enemy: string) =>
  singleRoomDungeon([{ id: 'guards', type: 'combat', waves: [{ enemy: { key: enemy } }] }], (d) => {
    d.key = key;
    d.name = key;
  });

/** Ten enemies in A, every one with full art and a transparent sprite; a few with shipped files too. */
const TEN = Array.from({ length: 10 }, (_, i) => `cp3_enemy_${String(i + 1).padStart(2, '0')}`);
async function createTen(): Promise<void> {
  fs.mkdirSync(path.join(A.w.artworkDir, 'combat/cp3'), { recursive: true });
  for (const [i, key] of TEN.entries()) {
    const art = await A.w.assets.upload({ bytes: await solidImage(64 + i, 48, color(i), i % 3 === 0 ? 'webp' : 'png'), category: 'enemy_art', filename: `${key}.png` }, 'admin');
    const sprite = await A.w.assets.upload({ bytes: await transparentSprite(40, 56 + i, color(i + 40), 'webp'), category: 'enemy_sprite', filename: `${key}-sprite.webp` }, 'admin');
    // Enemy 1 ships its full art as a file only (no managed full art): the shipped file is the picture.
    // Enemy 2 has managed full art AND a shipped fallback.
    const shipped = i === 0 || i === 1 ? `combat/cp3/${key}.png` : null;
    if (shipped) fs.writeFileSync(path.join(A.w.artworkDir, shipped), await solidImage(30, 30, color(i + 90)));
    await A.w.enemies.create(
      key,
      {
        name: `Enemy ${i + 1}`,
        description: `CP-3 test enemy ${i + 1}`,
        enabled: i % 2 === 0,
        attack: 10 + i,
        defense: i,
        hp: 100 + 10 * i,
        tags: ['cp3', `tier_${(i % 3) + 1}`],
        artworkPath: shipped,
        spritePlacement: placement(i),
        artworkAssetId: i === 0 ? null : art.id,
        spriteAssetId: sprite.id,
      },
      'admin',
    );
  }
}

// ── export ──────────────────────────────────────────────────────────────────

describe('export', () => {
  beforeAll(createTen, 60_000);

  it('an empty selection is refused, never widened to the whole catalogue', async () => {
    const res = await exportOver(A, { scope: 'selected', keys: [] });
    expect(res.status).toBe(422);
    expect(res.json!.error).toMatchObject({ code: 'ENEMY_EXPORT_REFUSED', details: { reason: 'empty' } });
  });

  it('unknown selected keys are named, and nothing is exported', async () => {
    const res = await exportOver(A, { scope: 'selected', keys: [TEN[0], 'cp3_nope_b', 'cp3_nope_a'] });
    expect(res.status).toBe(404);
    expect(res.json!.error).toMatchObject({ code: 'ENEMY_EXPORT_KEYS_NOT_FOUND', details: { missingKeys: ['cp3_nope_a', 'cp3_nope_b'] } });
  });

  it('a selection exports exactly those enemies with their artwork bytes, and no source ids, keys or paths of A', async () => {
    const res = await exportOver(A, { scope: 'selected', keys: [TEN[2]!, TEN[0]!, TEN[2]!] });
    expect(res.status).toBe(200);
    const pkg = await parseEnemyPackage(res.zip);
    expect(pkg.definitions.map((d) => d.key)).toEqual([TEN[0], TEN[2]]);
    const text = readZip(res.zip, { maxArchiveBytes: 1e9, maxEntries: 100, maxExpandedBytes: 1e9, maxCompressionRatio: 1000, maxEntryBytes: () => 1e8, allowDirectory: () => true })
      .filter((f) => f.name.endsWith('.json'))
      .map((f) => f.data.toString())
      .join('\n');
    const row0 = (await enemyRow(A, TEN[2]!))!;
    expect(text).not.toContain(row0.artworkAssetId!);
    expect(text).not.toContain(row0.spriteAssetId!);
    expect(text).not.toContain(A.w.artworkDir);
    expect(text).not.toContain('managed/');
  });

  it('refuses when an enemy’s required shipped artwork is missing here — the full catalogue includes the seeded grunt, whose file A lacks', async () => {
    const res = await exportOver(A, { scope: 'all' });
    expect(res.status).toBe(422);
    expect(res.json!.error.details).toMatchObject({ reason: 'artwork_unavailable' });
    expect(res.json!.error.details.issues).toContainEqual({ path: 'grunt.artwork', message: expect.stringContaining('combat/enemies/grunt.webp is missing') });
  });

  it('refuses a shipped format managed artwork cannot accept (GIF), naming it', async () => {
    fs.mkdirSync(path.join(A.w.artworkDir, 'combat/enemies'), { recursive: true });
    // A minimal GIF89a header is enough: inspection refuses it by signature.
    fs.writeFileSync(path.join(A.w.artworkDir, 'combat/enemies/grunt.gif'), Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'));
    await edit(A, 'grunt', { artworkPath: 'combat/enemies/grunt.gif' });
    const res = await exportOver(A, { scope: 'selected', keys: ['grunt'] });
    expect(res.status).toBe(422);
    expect(res.json!.error.details).toMatchObject({ reason: 'unsupported_artwork' });
    expect(res.json!.error.details.issues[0].message).toMatch(/grunt\.gif cannot be imported as managed artwork/);
    await edit(A, 'grunt', { artworkPath: 'combat/enemies/grunt.webp' });
  });

  it('refuses when a managed image’s stored file is gone', async () => {
    const victim = (await enemyRow(A, TEN[3]!))!;
    const [asset] = await A.w.t.db.select().from(artworkAssets).where(eq(artworkAssets.id, victim.spriteAssetId!));
    const file = path.join(A.managedDir, asset!.storageKey);
    const saved = fs.readFileSync(file);
    fs.rmSync(file);
    try {
      const res = await exportOver(A, { scope: 'selected', keys: [TEN[3]!] });
      expect(res.status).toBe(422);
      expect(res.json!.error.details.issues).toContainEqual({ path: `${TEN[3]}.sprite`, message: expect.stringContaining('has no stored file') });
    } finally {
      fs.writeFileSync(file, saved);
    }
  });

  it('a full-catalogue export is an explicit scope and includes every enemy, disabled ones too', async () => {
    fs.writeFileSync(path.join(A.w.artworkDir, 'combat/enemies/grunt.webp'), await solidImage(50, 50, color(200), 'webp'));
    const res = await exportOver(A, { scope: 'all' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const pkg = await parseEnemyPackage(res.zip);
    const all = await A.w.enemies.list();
    expect(pkg.definitions.map((d) => d.key)).toEqual(all.map((e) => e.key));
    expect(pkg.definitions.some((d) => !d.enabled)).toBe(true);
    expect(pkg.manifest.scope).toBe('all');
  });
});

// ── the central scenario ────────────────────────────────────────────────────

describe('ten enemies with artwork, A → B, with A’s artwork gone', () => {
  let zip: Buffer;
  let first: EnemyImportPreview;
  const aState = new Map<string, Json>();

  beforeAll(async () => {
    const res = await exportOver(A, { scope: 'selected', keys: TEN });
    expect(res.status).toBe(200);
    zip = res.zip;
    for (const key of TEN) aState.set(key, (await A.w.enemies.get(key))!);
    // A's shipped and managed roots become unavailable.
    fs.renameSync(A.w.artworkDir, `${A.w.artworkDir}.away`);
  });
  afterAll(() => {
    if (fs.existsSync(`${A.w.artworkDir}.away`)) fs.renameSync(`${A.w.artworkDir}.away`, A.w.artworkDir);
  });

  it('previews ten creates, all disabled, binding every image to an asset B will create', async () => {
    expect(await assetCount(B)).toBe(0);
    first = await preview(B, zip);
    expect(first.ok).toBe(true);
    expect(first.counts).toEqual({ create: 10, update: 0, conflict: 0, unchanged: 0, invalid: 0 });
    expect(first.decisionKeys).toEqual([]);
    expect(first.entries.filter((e) => e.activation).map((e) => e.activation)).toEqual(
      Array(5).fill({ packageEnabled: true, enabled: false, reason: 'new_enemies_start_disabled' }),
    );
    const e1 = first.entries.find((e) => e.key === TEN[0])!;
    expect(e1.artwork).toMatchObject({ source: 'shipped', destination: { kind: 'create' } });
    expect(e1.artwork.notes[0]).toMatch(/not on this server; the packaged copy is used as managed artwork/);
    const e2 = first.entries.find((e) => e.key === TEN[1])!;
    expect(e2.artwork.source).toBe('managed');
    expect(e2.artwork.notes[0]).toMatch(/fallback combat\/cp3\/cp3_enemy_02\.png is not on this server/);
    expect(first.assets.every((a) => a.action === 'create' || a.action === 'not_needed')).toBe(true);
  });

  it('applies: every definition, both images per enemy, under B’s own ids, bytes intact, placement kept, all disabled, no dungeon needed', async () => {
    const pkg = await parseEnemyPackage(zip);
    const res = await upload(B, applyUrl(first), zip);
    expect(res.status, JSON.stringify(res.json).slice(0, 800)).toBe(200);
    expect(res.json.data.created.sort()).toEqual([...TEN].sort());

    for (const [i, key] of TEN.entries()) {
      const a = aState.get(key)!;
      const b = (await B.w.enemies.get(key))!;
      // 1, 2, 6, 7: the definition, placement included, and disabled.
      expect({ ...b, enabled: a.enabled }).toMatchObject({
        name: a.name,
        description: a.description,
        attack: a.attack,
        defense: a.defense,
        hp: a.hp,
        tags: a.tags,
        artworkPath: a.artworkPath,
        spritePlacement: placement(i),
      });
      expect(b.enabled).toBe(false);
      expect(b.references).toEqual([]);
      expect(b.issues.filter((x) => x.severity === 'error')).toEqual([]);
      // 3, 4: full art and sprite present, as B-local assets, not A's ids.
      expect(b.artworkAssetId).not.toBeNull();
      expect(b.spriteAssetId).not.toBeNull();
      expect(b.artworkAssetId).not.toBe(a.artworkAssetId);
      expect(b.spriteAssetId).not.toBe(a.spriteAssetId);
      const binding = pkg.manifest.enemies[i]!;
      const fullEntry = pkg.assets.get(binding.artwork.managed ?? binding.artwork.shipped!.asset!)!.entry;
      const spriteEntry = pkg.assets.get(binding.sprite.managed!)!.entry;
      for (const [id, entry] of [[b.artworkAssetId!, fullEntry], [b.spriteAssetId!, spriteEntry]] as const) {
        const read = await B.w.assets.readUsable(id);
        expect(read, key).not.toBeNull();
        // 5: the bytes are the exported bytes.
        expect(sha(read!.bytes)).toBe(entry.sha256);
        expect(read!.asset.category).toBe(entry.category);
      }
      expect(b.visual).toMatchObject({ artworkAssetId: b.artworkAssetId, spriteAssetId: b.spriteAssetId, spritePlacement: placement(i) });
    }
    // The shipped-only full art became managed artwork in B; nothing was written into B's shipped tree.
    expect(fs.existsSync(path.join(B.w.artworkDir, 'combat/cp3'))).toBe(false);
    expect(await assetCount(B)).toBe(20);
  });

  it('reimporting the same package changes nothing and duplicates no artwork', async () => {
    const before = { assets: await assetCount(B), files: managedFiles(B), revisions: await Promise.all(TEN.map(async (k) => (await enemyRow(B, k))!.revision)) };
    const again = await preview(B, zip);
    expect(again.counts).toEqual({ create: 0, update: 0, conflict: 0, unchanged: 10, invalid: 0 });
    expect(again.assets.every((a) => a.action === 'reuse' || a.action === 'not_needed')).toBe(true);
    const res = await upload(B, applyUrl(again), zip);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ created: [], updated: [], unchanged: expect.arrayContaining(TEN) });
    expect({ assets: await assetCount(B), files: managedFiles(B), revisions: await Promise.all(TEN.map(async (k) => (await enemyRow(B, k))!.revision)) }).toEqual(before);
  });

  it('a repeated request id replays its receipt instead of applying again', async () => {
    const p = await preview(B, zip);
    const requestId = randomUUID();
    const one = await upload(B, applyUrl(p, '', requestId), zip);
    const two = await upload(B, applyUrl(p, '', requestId), zip);
    expect(one.json.data.replayed).toBe(false);
    expect(two.json.data).toMatchObject({ replayed: true, importId: one.json.data.importId });
    const other = await upload(B, applyUrl(p, 'u', requestId), zip);
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe('ENEMY_IMPORT_REQUEST_CONFLICT');
  });
});

// ── updates, decisions, staleness, failure ─────────────────────────────────

describe('updating existing enemies in B', () => {
  const key = TEN[4]!;
  const unrelated = TEN.filter((k) => k !== key);
  const snapshotOthers = async () => Promise.all(unrelated.map((k) => enemyRow(B, k)));

  it('a changed enemy needs an explicit decision; an update keeps B’s enabled state and touches nothing else', async () => {
    // B switched it on; A then retunes it and is disabled there.
    const current = (await B.w.enemies.get(key))!;
    await B.w.enemies.setEnabled(key, { enabled: true, expectedRevision: current.revision }, 'ops');
    await edit(A, key, { attack: 77, name: 'Retuned', enabled: false });
    const zip = (await exportOver(A, { scope: 'selected', keys: [key] })).zip;
    const others = await snapshotOthers();

    const p = await preview(B, zip);
    expect(p.entries[0]).toMatchObject({ outcome: 'update', changedFields: ['name', 'attack'] });
    expect(p.entries[0]!.activation).toEqual({ packageEnabled: false, enabled: true, reason: 'existing_status_kept' });
    expect(p.decisionKeys).toEqual([key]);

    const undecided = await upload(B, applyUrl(p, ''), zip);
    expect(undecided.status).toBe(409);
    expect(undecided.json.error).toMatchObject({ code: 'ENEMY_IMPORT_DECISIONS_REQUIRED', details: { keys: [key] } });
    expect((await enemyRow(B, key))!.attack).not.toBe(77);

    const skipped = await upload(B, applyUrl(p, 's'), zip);
    expect(skipped.json.data).toMatchObject({ skipped: [key], updated: [] });
    expect((await enemyRow(B, key))!.attack).not.toBe(77);

    const p2 = await preview(B, zip);
    const updated = await upload(B, applyUrl(p2, 'u'), zip);
    expect(updated.status, JSON.stringify(updated.json)).toBe(200);
    expect(updated.json.data.updated).toEqual([key]);
    expect(await enemyRow(B, key)).toMatchObject({ attack: 77, name: 'Retuned', enabled: true });
    expect(await snapshotOthers()).toEqual(others);
  });

  it('a stale preview refuses to apply and changes nothing', async () => {
    await edit(A, key, { hp: 999 });
    const zip = (await exportOver(A, { scope: 'selected', keys: [key] })).zip;
    const p = await preview(B, zip);
    await edit(B, key, { description: 'edited in B after the preview' });
    const res = await upload(B, applyUrl(p, 'u'), zip);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('ENEMY_IMPORT_STALE');
    expect((await enemyRow(B, key))!.hp).not.toBe(999);
  });

  it('an enemy B’s content uses is a conflict that names the use and needs explicit approval', async () => {
    await B.w.publish(fightDungeon('cp3_hall', key));
    const zip = (await exportOver(A, { scope: 'selected', keys: [key] })).zip;
    const p = await preview(B, zip);
    expect(p.entries[0]).toMatchObject({ outcome: 'conflict', references: expect.arrayContaining([expect.objectContaining({ kind: 'dungeon_zone', key: 'cp3_hall' })]) });
    expect((await upload(B, applyUrl(p, ''), zip)).status).toBe(409);
    const ok = await upload(B, applyUrl(p, 'u'), zip);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await enemyRow(B, key))!.hp).toBe(999);
  });

  it('an active run keeps the enemy and images it started with; a new run gets the import', async () => {
    const { playerId } = await B.w.player();
    const started = await B.w.runs.start(playerId, 'cp3_hall');
    const runBefore = (await B.w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, started.id)))[0]!;
    const oldSprite = (await enemyRow(B, key))!.spriteAssetId!;
    const oldBytes = (await B.w.assets.readUsable(oldSprite))!.bytes;

    // A gives it a new sprite and stats.
    const fresh = await A.w.assets.upload({ bytes: await transparentSprite(44, 70, color(250), 'png'), category: 'enemy_sprite', filename: 'new.png' }, 'admin');
    await edit(A, key, { spriteAssetId: fresh.id, attack: 88 });
    const zip = (await exportOver(A, { scope: 'selected', keys: [key] })).zip;
    const p = await preview(B, zip);
    expect(p.entries[0]!.sprite.destination.kind).toBe('create');
    expect((await upload(B, applyUrl(p, 'u'), zip)).status).toBe(200);

    expect((await B.w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, started.id)))[0]).toEqual(runBefore);
    const frozen = (await B.w.runs.activeRun(playerId))!;
    expect(frozen.enemy).toMatchObject({ attack: 77, visual: { spriteAssetId: oldSprite } });
    // The old image is still there, unchanged, for the run to keep showing.
    const still = await B.w.assets.readUsable(oldSprite);
    expect(still!.bytes.equals(oldBytes)).toBe(true);

    const other = await B.w.player();
    const next = await B.w.runs.start(other.playerId, 'cp3_hall');
    expect(next.enemy).toMatchObject({ attack: 88 });
    expect(next.enemy!.visual.spriteAssetId).not.toBe(oldSprite);
  });

  it('a failed apply leaves no definition, no new asset row and no staged file — and never deletes reused artwork', async () => {
    // One new enemy reusing B's existing sprite bytes, plus a brand-new image.
    const reusedSprite = (await enemyRow(B, TEN[6]!))!.spriteAssetId!;
    const reusedBytes = (await B.w.assets.readUsable(reusedSprite))!.bytes;
    const reusedA = await A.w.assets.upload({ bytes: reusedBytes, category: 'enemy_sprite', filename: 'same.webp' }, 'admin');
    const brandNew = await A.w.assets.upload({ bytes: await solidImage(90, 90, color(123)), category: 'enemy_art', filename: 'brand-new.png' }, 'admin');
    await A.w.enemies.create('cp3_doomed', { name: 'Doomed', enabled: true, attack: 5, defense: 1, hp: 50, spriteAssetId: reusedA.id, artworkAssetId: brandNew.id }, 'admin');
    const zip = (await exportOver(A, { scope: 'selected', keys: ['cp3_doomed'] })).zip;
    const p = await preview(B, zip);
    expect(p.entries[0]!.sprite.destination).toMatchObject({ kind: 'reuse', assetId: reusedSprite });
    expect(p.entries[0]!.artwork.destination.kind).toBe('create');

    const before = { assets: await assetCount(B), files: managedFiles(B) };
    B.faults.beforeCommit = async () => {
      throw new Error('simulated failure after every write');
    };
    try {
      const res = await upload(B, applyUrl(p), zip);
      expect(res.status).toBe(500);
    } finally {
      delete B.faults.beforeCommit;
    }
    expect(await enemyRow(B, 'cp3_doomed')).toBeUndefined();
    expect({ assets: await assetCount(B), files: managedFiles(B) }).toEqual(before);
    const reused = await B.w.assets.readUsable(reusedSprite);
    expect(reused!.bytes.equals(reusedBytes)).toBe(true);
    const [journal] = await B.w.t.db.select().from(enemyPackageImports).where(eq(enemyPackageImports.planHash, p.planHash));
    expect(journal).toMatchObject({ status: 'failed', error: 'simulated failure after every write' });

    // The same package then applies cleanly.
    const ok = await upload(B, applyUrl(await preview(B, zip)), zip);
    expect(ok.json.data.created).toEqual(['cp3_doomed']);
    expect((await enemyRow(B, 'cp3_doomed'))!.spriteAssetId).toBe(reusedSprite);
  });

  it('the same bytes in another category are not reused', async () => {
    const bytes = await solidImage(70, 70, color(77));
    await B.w.assets.upload({ bytes, category: 'dungeon_background', filename: 'bg.png' }, 'admin');
    const art = await A.w.assets.upload({ bytes, category: 'enemy_art', filename: 'art.png' }, 'admin');
    await A.w.enemies.create('cp3_samebytes', { name: 'Same Bytes', enabled: false, attack: 5, defense: 1, hp: 50, artworkAssetId: art.id }, 'admin');
    const p = await preview(B, (await exportOver(A, { scope: 'selected', keys: ['cp3_samebytes'] })).zip);
    expect(p.entries[0]!.artwork.destination.kind).toBe('create');
  });

  it('a shipped file B already has with the same bytes is used as is — no managed asset', async () => {
    const bytes = await solidImage(33, 33, color(150));
    for (const e of [A, B]) {
      fs.mkdirSync(path.join(e.w.artworkDir, 'combat/both'), { recursive: true });
      fs.writeFileSync(path.join(e.w.artworkDir, 'combat/both/twin.png'), bytes);
    }
    await A.w.enemies.create('cp3_twin', { name: 'Twin', enabled: false, attack: 5, defense: 1, hp: 50, artworkPath: 'combat/both/twin.png' }, 'admin');
    const zip = (await exportOver(A, { scope: 'selected', keys: ['cp3_twin'] })).zip;
    const p = await preview(B, zip);
    expect(p.entries[0]!.artwork.destination).toEqual({ kind: 'shipped_file', path: 'combat/both/twin.png' });
    expect(p.assets[0]!.action).toBe('not_needed');
    const assets = await assetCount(B);
    expect((await upload(B, applyUrl(p), zip)).status).toBe(200);
    expect(await assetCount(B)).toBe(assets);
    expect((await enemyRow(B, 'cp3_twin'))!.artworkAssetId).toBeNull();
  });
});

// ── concurrency and recovery ────────────────────────────────────────────────

describe('concurrency and recovery', () => {
  it('two concurrent imports of the same new package: one applies, the other is refused, and nothing is duplicated', async () => {
    const art = await A.w.assets.upload({ bytes: await solidImage(81, 81, color(181)), category: 'enemy_art', filename: 'race.png' }, 'admin');
    await A.w.enemies.create('cp3_race', { name: 'Race', enabled: false, attack: 5, defense: 1, hp: 50, artworkAssetId: art.id }, 'admin');
    const zip = (await exportOver(A, { scope: 'selected', keys: ['cp3_race'] })).zip;
    const p = await preview(B, zip);
    const before = await assetCount(B);
    const results = await Promise.all([upload(B, applyUrl(p), zip), upload(B, applyUrl(p), zip)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.json.error.code).toBe('ENEMY_IMPORT_STALE');
    expect(await assetCount(B)).toBe(before + 1);
    const holders = await B.w.t.db.select().from(artworkAssets).where(and(eq(artworkAssets.category, 'enemy_art'), eq(artworkAssets.contentHash, p.assets[0]!.sha256)));
    expect(holders).toHaveLength(1);
  });

  it('recovery removes the files of an import interrupted before commit, and never a file an asset row names', async () => {
    const storage = createLocalArtworkStorage(B.managedDir);
    const orphanKey = `enemy_art/${randomUUID()}/${'a'.repeat(64)}.png`;
    await storage.put(orphanKey, Buffer.from('half an import'));
    const [kept] = await B.w.t.db.select().from(artworkAssets).limit(1);
    await B.w.t.db.insert(enemyPackageImports).values({
      requestId: randomUUID(),
      requestHash: 'h',
      packageHash: 'p',
      planHash: 'x',
      status: 'staged',
      stagedStorageKeys: [orphanKey, kept!.storageKey],
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    // A fresh staged row (a live import) is left alone.
    const liveKey = `enemy_art/${randomUUID()}/${'b'.repeat(64)}.png`;
    await storage.put(liveKey, Buffer.from('in flight'));
    await B.w.t.db.insert(enemyPackageImports).values({ requestId: randomUUID(), requestHash: 'h', packageHash: 'p', planHash: 'y', status: 'staged', stagedStorageKeys: [liveKey] });

    const recovered = await B.packages.recoverInterruptedImports();
    expect(recovered).toEqual({ abandoned: 1, removedFiles: 1 });
    expect(await storage.exists(orphanKey)).toBe(false);
    expect(await storage.exists(kept!.storageKey)).toBe(true);
    expect(await storage.exists(liveKey)).toBe(true);
    const [row] = await B.w.t.db.select().from(enemyPackageImports).where(eq(enemyPackageImports.planHash, 'x'));
    expect(row).toMatchObject({ status: 'abandoned', error: 'interrupted; 1 staged file(s) removed' });
    await B.w.t.db.delete(enemyPackageImports).where(eq(enemyPackageImports.planHash, 'y'));
    await storage.delete(liveKey);
  });
});

// ── hostile and broken packages ─────────────────────────────────────────────

describe('package validation', () => {
  let good: Buffer;
  let entries: { name: string; data: Buffer }[];
  beforeAll(async () => {
    good = (await exportOver(A, { scope: 'selected', keys: [TEN[1]!] })).zip;
    entries = readZip(good, { maxArchiveBytes: 1e9, maxEntries: 100, maxExpandedBytes: 1e9, maxCompressionRatio: 1000, maxEntryBytes: () => 1e8 });
  });
  const rezip = (change: (files: { name: string; data: Buffer; mode?: number }[]) => { name: string; data: Buffer; mode?: number }[]) =>
    writeZip(change(entries.map((e) => ({ ...e, data: Buffer.from(e.data) }))));
  const refused = async (zip: Buffer, pattern: RegExp) => {
    const res = await upload(B, '/admin/enemies/import/preview', zip);
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json.error.code).toBe('ENEMY_PACKAGE_INVALID');
    expect(JSON.stringify(res.json.error.details.issues)).toMatch(pattern);
  };
  const image = () => entries.find((e) => e.name.startsWith('artwork/'))!;

  it('accepts the untouched package', async () => {
    expect((await preview(B, good)).ok).toBe(true);
  });

  it('refuses a hash mismatch, a missing declared image, an undeclared extra file and a corrupt image', async () => {
    await refused(rezip((f) => f.map((e) => (e.name === image().name ? { ...e, data: Buffer.concat([e.data.subarray(0, -1), Buffer.from([e.data.at(-1)! ^ 1])]) } : e))), /does not match its declared sha256|not an accepted image/);
    await refused(rezip((f) => f.filter((e) => e.name !== image().name)), /is missing from the package/);
    await refused(rezip((f) => [...f, { name: 'artwork/asset-999.png', data: image().data }]), /is not declared in the manifest/);
    // Bytes that are not an image, with a manifest that honestly declares their hash and size.
    const junk = Buffer.from('this is not an image at all, but it is the right length'.padEnd(image().data.length, '!'));
    await refused(
      rezip((f) =>
        f.map((e) => {
          if (e.name === image().name) return { ...e, data: junk };
          if (e.name !== 'manifest.json') return e;
          const m = JSON.parse(e.data.toString());
          const a = m.assets.find((x: Json) => x.file === image().name);
          a.sha256 = sha(junk);
          return { ...e, data: Buffer.from(JSON.stringify(m)) };
        }),
      ),
      /not an accepted image/,
    );
  });

  it('refuses traversal, a symlink, a duplicate entry and a decompression bomb', async () => {
    await refused(rezip((f) => [...f, { name: 'artwork/../../etc/cron.d/x', data: Buffer.from('x') }]), /\\"\.\.\\" path segment/);
    await refused(rezip((f) => f.map((e) => (e.name === image().name ? { ...e, mode: 0o120777 } : e))), /links are not accepted/);
    await refused(rezip((f) => [...f, f.find((e) => e.name === 'enemies.json')!]), /more than once/);
    await refused(writeZip([{ name: 'manifest.json', data: Buffer.alloc(1024 * 1024, 32), compress: true }]), /compressed more than 100:1/);
  });

  it('refuses a package whose manifest disagrees with its enemies', async () => {
    await refused(
      rezip((f) =>
        f.map((e) => {
          if (e.name !== 'manifest.json') return e;
          const m = JSON.parse(e.data.toString());
          m.enemies[0].key = 'someone_else';
          return { ...e, data: Buffer.from(JSON.stringify(m)) };
        }),
      ),
      /must list exactly the enemies/,
    );
  });
});

// ── HTTP: limits and authorisation ──────────────────────────────────────────

describe('HTTP limits and authorisation', () => {
  const as = (role: string, withCsrf = true): Record<string, string> => ({
    cookie: `wm_portal_session=${role}; wm_portal_csrf=${CSRF}`,
    ...(withCsrf ? { 'x-portal-csrf': CSRF } : {}),
  });
  let zip: Buffer;
  beforeAll(async () => {
    zip = (await exportOver(A, { scope: 'selected', keys: [TEN[8]!] })).zip;
  });

  it('a body over the route limit is a JSON 413 naming the limit, and nothing is written', async () => {
    expect(ENEMY_PACKAGE_BODY_LIMIT_BYTES).toBe(ENEMY_PACKAGE_LIMITS.maxArchiveBytes);
    const before = { assets: await assetCount(B), journal: (await B.w.t.db.select().from(enemyPackageImports)).length };
    const big = Buffer.alloc(ENEMY_PACKAGE_BODY_LIMIT_BYTES + 1);
    for (const url of ['/admin/enemies/import/preview', `/admin/enemies/import/apply?expectedPlanHash=x&requestId=${randomUUID()}`]) {
      const res = await upload(B, url, big);
      expect(res.status, url).toBe(413);
      expect(res.json.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { maxBytes: ENEMY_PACKAGE_BODY_LIMIT_BYTES } });
    }
    expect({ assets: await assetCount(B), journal: (await B.w.t.db.select().from(enemyPackageImports)).length }).toEqual(before);
  });

  it('refuses without a session before reading a large body', async () => {
    const res = await upload(B, '/admin/enemies/import/preview', Buffer.alloc(ENEMY_PACKAGE_BODY_LIMIT_BYTES + 1), {});
    expect(res.status).toBe(401);
  });

  it('export needs enemies.read and artwork.read; preview enemies.write; apply also artwork.write — with CSRF', async () => {
    expect((await exportOver(B, { scope: 'all' }, as('player'))).status).toBe(403);
    expect((await exportOver(B, { scope: 'selected', keys: [TEN[0]!] }, as('enemyOnly'))).status).toBe(403);
    expect((await exportOver(B, { scope: 'selected', keys: [TEN[0]!] }, as('reader'))).status).toBe(200);

    expect((await upload(B, '/admin/enemies/import/preview', zip, as('reader'))).status).toBe(403);
    const p = await upload(B, '/admin/enemies/import/preview', zip, as('enemyOnly'));
    expect(p.status).toBe(200);
    const plan = p.json.data as EnemyImportPreview;
    const decisions = 'u'.repeat(plan.decisionKeys.length);
    const noArtwork = await upload(B, applyUrl(plan, decisions), zip, as('enemyOnly'));
    expect(noArtwork.status).toBe(403);
    expect(noArtwork.json.error.code).toBe('PORTAL_PERMISSION_DENIED');
    const noCsrf = await upload(B, applyUrl(plan, decisions), zip, as('editor', false));
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json.error.code).toBe('PORTAL_CSRF_INVALID');
    const applied = await upload(B, applyUrl(plan, decisions), zip, as('editor'));
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    const [receipt] = await B.w.t.db.select().from(enemyPackageImports).where(eq(enemyPackageImports.id, applied.json.data.importId));
    expect(receipt!.actor).toBe(USER_IDS.editor);
  });

  it('documents each package route with a summary, a tag and the shared error responses', async () => {
    const spec = (await B.api.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    for (const [route, verb] of [
      ['/api/v1/admin/enemies/export/package', 'post'],
      ['/api/v1/admin/enemies/import/preview', 'post'],
      ['/api/v1/admin/enemies/import/apply', 'post'],
    ] as const) {
      const op = spec.paths[route]?.[verb];
      expect(op?.summary, route).toBeTruthy();
      expect(op.tags).toEqual(['Admin — Enemies']);
      expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['400', '401', '500']));
    }
  });

  it('every new error code has a considered HTTP status', () => {
    expect(MAPPED_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'ENEMY_PACKAGE_INVALID',
        'ENEMY_EXPORT_KEYS_NOT_FOUND',
        'ENEMY_EXPORT_REFUSED',
        'ENEMY_IMPORT_REJECTED',
        'ENEMY_IMPORT_STALE',
        'ENEMY_IMPORT_DECISIONS_REQUIRED',
        'ENEMY_IMPORT_REQUEST_CONFLICT',
      ]),
    );
  });
});
