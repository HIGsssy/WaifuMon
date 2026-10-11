/**
 * The Enemy Catalogue over the Admin API, against a real database seeded from
 * the shipped content: listing, create / edit / disable / duplicate / delete,
 * usage, export, managed artwork, what the Dungeon editor is given, and who
 * may do any of it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { createArtworkAssetService } from '../../../src/modules/artworkAssets/artworkAssetService';
import { createLocalArtworkStorage } from '../../../src/modules/artworkAssets/artworkStorage';
import { CombatEnemyFileSchema } from '../../../src/modules/combat/enemyDefinitions';
import { createDungeonContentService } from '../../../src/modules/dungeons/dungeonContentService';
import { combatTrialEnemyReferences, dungeonEnemyReferences } from '../../../src/modules/enemies/enemyReferences';
import { createEnemyCatalogueService } from '../../../src/modules/enemies/enemyService';
import { seedCombatEnemies, shippedCombatEnemies } from '../../../src/modules/enemies/enemyStore';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import { createProgressionCurrencyService } from '../../../src/modules/progressionCurrency/progressionCurrencyService';
import { loadShippedRewardTables, seedRewardTables } from '../../../src/modules/rewardTables/rewardTableStore';
import { singleRoomDungeon } from '../../helpers/dungeonFixtures';
import { CONTENT_DIR, bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { solidImage, transparentSprite } from '../../helpers/imageFixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555881';
const OWNER_ID = '777888999000111441';
const NON_OWNER_ID = '999999999999999881';
const OWNER_TOKEN = 'token-owner';
const NON_OWNER_TOKEN = 'token-non-owner';
const CSRF = 'csrf-token';
const DUNGEON = 'api_depths';
const DUNGEON_NAME = 'Api Depths';
/** Where the dungeon below names its second wave, as the enemy's Usage section words it. */
const SECOND_WAVE_USAGE = 'draft: room "Hall" combat "guards", wave 2';

let t: TestDb;
let app: App;
let api: ZodFastify;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-enemies-api-'));

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  await provisionPlayer(app, GUILD_ID, OWNER_ID);
  await provisionPlayer(app, GUILD_ID, NON_OWNER_ID);
  await seedRewardTables(t.db, loadShippedRewardTables(CONTENT_DIR));
  // What startup does: enemies first, then the dungeons that name them.
  const shippedEnemies = shippedCombatEnemies(app.content.combatEnemies);
  await seedCombatEnemies(t.db, shippedEnemies);

  const assets = createArtworkAssetService({ db: t.db, storage: createLocalArtworkStorage(path.join(root, 'managed')) });
  const enemies = createEnemyCatalogueService({
    db: t.db,
    getShipped: () => shippedEnemies,
    assets,
    referenceSources: [dungeonEnemyReferences, combatTrialEnemyReferences(() => app.content.combatTrials)],
  });
  const dungeonContent = createDungeonContentService({
    db: t.db,
    enemies,
    getRegions: () => app.content.regions.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
    environment: 'test',
  });
  // A dungeon draft that names two shipped enemies: one in a fight, one as its boss.
  await dungeonContent.create(
    {
      definition: singleRoomDungeon(
        [
          { id: 'guards', type: 'combat', waves: [{ enemy: { key: 'scrapyard_drone' } }] },
          { id: 'chief', type: 'boss', waves: [{ enemy: { key: 'scrapheap_colossus' } }] },
        ],
        (d) => {
          d.key = DUNGEON;
          d.name = DUNGEON_NAME;
        },
      ),
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
    config: { enabled: true, host: '127.0.0.1', port: 3137, token: TEST_TOKEN, adminBearer: true },
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
      services: { ...app, dungeonContent, progressionCurrency, artworkAssets: assets, enemies },
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

type Json = Record<string, any>;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    headers: AUTH_BEARER,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const data = async (url: string): Promise<Json> => (await call('GET', url)).json().data;
const getEnemy = (key: string) => data(`/admin/enemies/${key}`);
const getDungeon = () => data(`/admin/dungeons/definitions/${DUNGEON}`);
/** The enemies the dungeon's fight fields, wave by wave. */
const guardsOf = (definition: Json): string[] => definition.rooms[0].actions[0].waves.map((wave: Json) => wave.enemy.key);
/** The definition with one more wave on its fight. */
const withWave = (definition: Json, enemyKey: string): Json => {
  const next = JSON.parse(JSON.stringify(definition)) as Json;
  next.rooms[0].actions[0].waves.push({ enemy: { key: enemyKey } });
  return next;
};
const body = (over: Json = {}) => ({ name: 'Api Made', enabled: true, attack: 30, defense: 15, hp: 300, tags: ['api'], ...over });
const fields = (e: Json) => ({ name: e.name, description: e.description, enabled: e.enabled, attack: e.attack, defense: e.defense, hp: e.hp, tags: e.tags });
async function save(key: string, change: Json) {
  const current = await getEnemy(key);
  return call('PUT', `/admin/enemies/${key}`, { enemy: { ...fields(current), ...change }, expectedRevision: current.revision });
}
async function uploadAsset(kind: 'enemy_sprite' | 'enemy_art', filename: string): Promise<string> {
  const res = await api.inject({
    method: 'POST',
    url: `/api/v1/admin/artwork/assets?category=${kind}&filename=${filename}`,
    headers: { ...AUTH_BEARER, 'content-type': 'application/octet-stream' },
    payload: kind === 'enemy_sprite' ? await transparentSprite(200, 300) : await solidImage(300, 300),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.asset.id;
}

describe('the shipped enemies', () => {
  it('are all listed — the originals and the ones added to the JSON since — with stats, tags and origin', async () => {
    const shipped = app.content.combatEnemies ?? [];
    const { enemies } = await data('/admin/enemies');
    expect(enemies.map((e: Json) => e.key)).toEqual(shipped.map((e) => e.key));
    for (const enemy of shipped) {
      expect(enemies.find((e: Json) => e.key === enemy.key), enemy.key).toMatchObject({
        name: enemy.name,
        enabled: enemy.enabled,
        attack: enemy.attack,
        defense: enemy.defense,
        hp: enemy.hp,
        tags: enemy.tags,
        origin: 'shipped',
        matchesShipped: true,
        revision: 1,
      });
    }
    // The newer additions, by name: they are ordinary catalogue rows.
    for (const key of ['discord_lurker', 'reddit_mod_clone', 'catfish_illusionist', 'ecosystem_sucker']) {
      expect(enemies.map((e: Json) => e.key), key).toContain(key);
    }
  });

  it('are exactly what the Dungeon editor offers, with enough to draw a picker row', async () => {
    const shipped = app.content.combatEnemies ?? [];
    const dungeon = await data('/admin/dungeons/reference');
    const central = await data('/admin/enemies/reference');
    // One catalogue: the Dungeon reference lists the same enemies, in the same order, with the same stats…
    expect(dungeon.enemies).toEqual(
      central.enemies.map((e: Json) => ({
        key: e.key,
        name: e.name,
        enabled: e.enabled,
        attack: e.attack,
        defense: e.defense,
        hp: e.hp,
        // Whether a fight composes a sprite or falls back to full artwork, from the same visual the catalogue shows.
        sprite: Boolean(e.visual.spriteAssetId || e.visual.spriteArtworkPath),
        artwork: Boolean(e.visual.artworkAssetId || e.visual.artworkPath),
      })),
    );
    expect(dungeon.enemies.map((e: Json) => e.key)).toEqual(shipped.map((e) => e.key));
    // …and the picker row (tags, artwork) is the catalogue's own.
    expect(central.enemies.find((e: Json) => e.key === 'ecosystem_sucker')).toEqual({
      key: 'ecosystem_sucker',
      name: 'Ecosystem Sucker',
      enabled: true,
      attack: 160,
      defense: 110,
      hp: 1000,
      tags: ['internet_archetype', 'tier_4', 'elite', 'multiplier'],
      visual: {
        artworkAssetId: null,
        artworkPath: null,
        spriteAssetId: null,
        spriteArtworkPath: null,
        spritePlacement: { anchor: 'bottom-right', scaleBasisPoints: 8500, offsetX: 0, offsetY: 0 },
      },
    });
    expect(central.enemies.find((e: Json) => e.key === 'scrapyard_drone').visual.artworkPath).toBe('combat/enemies/scrapyard_drone.webp');
  });

  it('show where they are used: a dungeon and the shipped Trials', async () => {
    const drone = await getEnemy('scrapyard_drone');
    expect(drone.references).toEqual(
      expect.arrayContaining([
        { kind: 'dungeon_zone', key: DUNGEON, name: DUNGEON_NAME, usage: 'draft: room "Hall" combat "guards"' },
        expect.objectContaining({ kind: 'combat_trial', usage: 'primary enemy' }),
      ]),
    );
    expect(drone.usageCount).toBe(drone.references.length);
    expect((await data('/admin/enemies/scrapyard_drone/references')).references).toEqual(drone.references);
    const boss = await getEnemy('scrapheap_colossus');
    expect(boss.references).toContainEqual({ kind: 'dungeon_zone', key: DUNGEON, name: DUNGEON_NAME, usage: 'draft: room "Hall" boss "chief"' });
  });
});

describe('create, edit, disable', () => {
  it('creates an enemy entirely through the API and offers it to the Dungeon editor at once', async () => {
    const created = await call('POST', '/admin/enemies', { key: 'api_made', enemy: body({ description: 'No Git involved.' }) });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().data).toMatchObject({
      key: 'api_made',
      name: 'Api Made',
      description: 'No Git involved.',
      attack: 30,
      defense: 15,
      hp: 300,
      tags: ['api'],
      origin: 'custom',
      matchesShipped: null,
      revision: 1,
      usageCount: 0,
      references: [],
      issues: [],
      shipped: null,
    });
    expect((await data('/admin/dungeons/reference')).enemies.at(-1)).toMatchObject({ key: 'api_made', attack: 30, defense: 15, hp: 300, enabled: true });

    const taken = await call('POST', '/admin/enemies', { key: 'api_made', enemy: body() });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('ENEMY_KEY_TAKEN');
  });

  it('refuses invalid stats and keys with per-field issues, and writes nothing', async () => {
    const res = await call('POST', '/admin/enemies', { key: 'bad_one', enemy: body({ attack: 0, defense: -5, hp: 0 }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'ENEMY_INVALID' });
    expect(res.json().error.details.issues.map((i: Json) => [i.path, i.severity]).sort()).toEqual([
      ['attack', 'error'],
      ['defense', 'error'],
      ['hp', 'error'],
    ]);
    expect((await call('GET', '/admin/enemies/bad_one')).statusCode).toBe(404);
    for (const [key, enemy] of [
      ['Bad Key', body()],
      ['new', body()],
      ['ok_key', body({ hp: 5_000_000 })],
      ['ok_key', body({ tags: ['Not A Tag'] })],
      ['ok_key', body({ unknownField: 1 })],
    ] as const) {
      const bad = await call('POST', '/admin/enemies', { key, enemy });
      expect(bad.statusCode, key).toBe(400);
      expect(bad.json().error.code, key).toBe('ENEMY_INVALID');
    }
    // The dry run says the same without writing, and passes a strong boss.
    const dry = await call('POST', '/admin/enemies/validate', { key: 'bad_one', enemy: body({ attack: 0 }), creating: true });
    expect(dry.json().data.issues).toEqual([expect.objectContaining({ path: 'attack', severity: 'error' })]);
    const boss = await call('POST', '/admin/enemies/validate', { key: 'huge_boss', enemy: body({ attack: 9000, defense: 4000, hp: 500_000 }), creating: true });
    expect(boss.json().data.issues).toEqual([]);
  });

  it('edits stats, bumps the revision, and refuses a stale save with 409 ENEMY_STALE', async () => {
    const before = await getEnemy('api_made');
    const saved = await save('api_made', { attack: 45, hp: 360 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({ attack: 45, defense: 15, hp: 360, revision: before.revision + 1 });

    const stale = await call('PUT', '/admin/enemies/api_made', { enemy: body({ attack: 999 }), expectedRevision: before.revision });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: 'ENEMY_STALE',
      details: { expectedRevision: before.revision, currentRevision: before.revision + 1 },
    });
    expect((await getEnemy('api_made')).attack).toBe(45);
    const invalid = await save('api_made', { attack: -1 });
    expect(invalid.statusCode).toBe(400);
    expect((await call('PUT', '/admin/enemies/no_such_enemy', { enemy: body(), expectedRevision: 1 })).statusCode).toBe(404);
  });

  it('editing a shipped enemy marks it edited and shows the shipped copy beside it', async () => {
    const saved = (await save('wojak_shade', { attack: 46 })).json().data;
    expect(saved).toMatchObject({ origin: 'edited', matchesShipped: false, attack: 46, shipped: { key: 'wojak_shade', attack: 45 } });
    const back = (await save('wojak_shade', { attack: 45 })).json().data;
    expect(back).toMatchObject({ matchesShipped: true, attack: 45 });
  });

  it('disables and re-enables; a disabled enemy stays listed, and dungeon content that names it is flagged', async () => {
    const current = await getEnemy('api_made');
    const off = await call('PUT', '/admin/enemies/api_made/enabled', { enabled: false, expectedRevision: current.revision });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().data).toMatchObject({ enabled: false, revision: current.revision + 1 });
    expect((await data('/admin/enemies')).enemies.find((e: Json) => e.key === 'api_made').enabled).toBe(false);
    expect((await data('/admin/dungeons/reference')).enemies.find((e: Json) => e.key === 'api_made').enabled).toBe(false);

    // The Dungeon editor is told: a definition that adds it is flagged, by a stable code…
    const dungeon = await getDungeon();
    const withDisabled = withWave(dungeon.draft, 'api_made');
    const flagged = await call('POST', '/admin/dungeons/validate', { definition: withDisabled });
    expect(flagged.statusCode, flagged.body).toBe(200);
    expect(flagged.json().data.issues).toContainEqual(
      expect.objectContaining({
        code: 'enemy_disabled',
        path: 'rooms[0].actions[0].waves[1].enemy',
        severity: 'warning',
        message: expect.stringContaining('"api_made" is disabled'),
      }),
    );

    const stale = await call('PUT', '/admin/enemies/api_made/enabled', { enabled: true, expectedRevision: current.revision });
    expect(stale.json().error.code).toBe('ENEMY_STALE');
    const on = await call('PUT', '/admin/enemies/api_made/enabled', { enabled: true, expectedRevision: current.revision + 1 });
    expect(on.json().data.enabled).toBe(true);
    // …and is not once it is back.
    const accepted = await call('PUT', `/admin/dungeons/definitions/${DUNGEON}/draft`, {
      definition: withDisabled,
      expectedRevision: dungeon.draftRevision,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().data.issues.filter((i: Json) => i.code === 'enemy_disabled')).toEqual([]);
    expect((await getEnemy('api_made')).references).toEqual([{ kind: 'dungeon_zone', key: DUNGEON, name: DUNGEON_NAME, usage: SECOND_WAVE_USAGE }]);
  });

  it('disabling an enemy a dungeon already uses keeps the reference and warns on both sides', async () => {
    const current = await getEnemy('api_made');
    const off = (await call('PUT', '/admin/enemies/api_made/enabled', { enabled: false, expectedRevision: current.revision })).json().data;
    expect(off.issues).toEqual([expect.objectContaining({ path: 'enabled', severity: 'warning' })]);
    const dungeon = await getDungeon();
    expect(guardsOf(dungeon.draft)).toContain('api_made');
    expect(dungeon.issues).toContainEqual(
      expect.objectContaining({ code: 'enemy_disabled', severity: 'warning', message: expect.stringContaining('"api_made" is disabled') }),
    );
    // The dungeon still saves with the reference in place.
    const resaved = await call('PUT', `/admin/dungeons/definitions/${DUNGEON}/draft`, {
      definition: dungeon.draft,
      expectedRevision: dungeon.draftRevision,
    });
    expect(resaved.statusCode, resaved.body).toBe(200);
    expect(guardsOf(resaved.json().data.draft)).toContain('api_made');
    await call('PUT', '/admin/enemies/api_made/enabled', { enabled: true, expectedRevision: off.revision });
  });
});

describe('duplicate, delete, export', () => {
  it('duplicates an enemy under a new key, disabled', async () => {
    const res = await call('POST', '/admin/enemies/scrapyard_drone/duplicate', { key: 'scrapyard_drone_mk2', name: 'Scrapyard Drone Mk II' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({
      key: 'scrapyard_drone_mk2',
      name: 'Scrapyard Drone Mk II',
      enabled: false,
      attack: 55,
      defense: 30,
      hp: 300,
      tags: ['starter', 'initial_tuning'],
      artworkPath: 'combat/enemies/scrapyard_drone.webp',
      origin: 'custom',
      references: [],
    });
    expect((await call('POST', '/admin/enemies/scrapyard_drone/duplicate', { key: 'scrapyard_drone_mk2' })).json().error.code).toBe('ENEMY_KEY_TAKEN');
    expect((await call('POST', '/admin/enemies/scrapyard_drone/duplicate', { key: 'Nope' })).json().error.code).toBe('ENEMY_INVALID');
    expect((await call('POST', '/admin/enemies/no_such_enemy/duplicate', { key: 'x' })).statusCode).toBe(404);
  });

  it('refuses to delete a referenced or shipped enemy, naming what uses it; deletes an unused one', async () => {
    const used = await getEnemy('api_made');
    const refused = await call('DELETE', `/admin/enemies/api_made?expectedRevision=${used.revision}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'ENEMY_IN_USE',
      details: { shipped: false, references: [{ kind: 'dungeon_zone', key: DUNGEON, name: DUNGEON_NAME, usage: SECOND_WAVE_USAGE }] },
    });
    const shipped = await getEnemy('fedora_imp');
    const shippedRefusal = await call('DELETE', `/admin/enemies/fedora_imp?expectedRevision=${shipped.revision}`);
    expect(shippedRefusal.json().error).toMatchObject({ code: 'ENEMY_IN_USE', details: { shipped: true } });
    expect((await call('GET', '/admin/enemies/api_made')).statusCode).toBe(200);

    const copy = await getEnemy('scrapyard_drone_mk2');
    expect((await call('DELETE', `/admin/enemies/scrapyard_drone_mk2?expectedRevision=${copy.revision + 5}`)).json().error.code).toBe('ENEMY_STALE');
    const deleted = await call('DELETE', `/admin/enemies/scrapyard_drone_mk2?expectedRevision=${copy.revision}`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((await call('GET', '/admin/enemies/scrapyard_drone_mk2')).statusCode).toBe(404);
    expect((await call('DELETE', '/admin/enemies/scrapyard_drone_mk2?expectedRevision=1')).statusCode).toBe(404);
  });

  it('exports a valid enemies.json, and says which managed artwork it does not carry', async () => {
    const sprite = await uploadAsset('enemy_sprite', 'api-made.png');
    expect((await save('api_made', { spriteAssetId: sprite })).statusCode).toBe(200);

    const exported = await data('/admin/enemies/export');
    expect(exported.file).toBe('combat/enemies.json');
    // The document is exactly what the content loader reads.
    const parsed = CombatEnemyFileSchema.safeParse(exported.document);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(exported.document.enemies.map((e: Json) => e.key)).toEqual((await data('/admin/enemies')).enemies.map((e: Json) => e.key));
    expect(JSON.stringify(exported.document)).not.toContain(sprite);
    expect(exported.environmentLocal.managedArtwork).toEqual([{ key: 'api_made', artworkAssetId: null, spriteAssetId: sprite }]);
    expect(exported.environmentLocal.note).toMatch(/this environment only/);
  });
});

describe('managed artwork on the enemy', () => {
  it('attaches, places and clears artwork, and keeps the asset library in step', async () => {
    const full = await uploadAsset('enemy_art', 'full.png');
    const sprite = (await getEnemy('api_made')).spriteAssetId as string;
    const placement = { anchor: 'bottom-center', scaleBasisPoints: 7000, offsetX: -40, offsetY: 10 };
    const saved = (await save('api_made', { artworkAssetId: full, spritePlacement: placement })).json().data;
    expect(saved).toMatchObject({
      artworkAssetId: full,
      spriteAssetId: sprite,
      spritePlacement: placement,
      visual: { artworkAssetId: full, spriteAssetId: sprite, spritePlacement: placement, artworkPath: null },
    });
    // The asset names the enemy that uses it, and cannot be deleted from under it.
    expect((await data(`/admin/artwork/assets/${sprite}`)).references).toEqual([
      { kind: 'combat_enemy', key: 'api_made', name: 'Api Made', field: 'spriteAssetId' },
    ]);
    expect((await call('DELETE', `/admin/artwork/assets/${sprite}`)).statusCode).toBe(409);

    for (const change of [
      { spritePlacement: { ...placement, scaleBasisPoints: 20_000 } },
      { spritePlacement: { ...placement, anchor: 'top' } },
      { spriteAssetId: '00000000-0000-4000-8000-0000000000cc' },
      { spriteAssetId: 'not-an-id' },
    ]) {
      const bad = await save('api_made', change);
      expect(bad.statusCode, JSON.stringify(change)).toBe(400);
      expect(bad.json().error.code).toBe('ENEMY_INVALID');
    }

    const cleared = (await save('api_made', { artworkAssetId: null, spriteAssetId: null, spritePlacement: null })).json().data;
    expect(cleared.visual).toMatchObject({ artworkAssetId: null, spriteAssetId: null, spritePlacement: { anchor: 'bottom-right', scaleBasisPoints: 8500 } });
    expect((await call('DELETE', `/admin/artwork/assets/${sprite}`)).statusCode).toBe(200);
  });

  it('the old enemy-artwork overlay routes are gone', async () => {
    expect((await call('GET', '/admin/dungeons/enemy-artwork')).statusCode).toBe(404);
  });
});

describe('permissions', () => {
  const asCookie = (token: string, withCsrf: boolean) => ({
    cookies: { wm_portal_session: token, wm_portal_csrf: CSRF },
    headers: withCsrf ? { 'x-portal-csrf': CSRF } : {},
  });
  const WRITES = [
    ['POST', '/admin/enemies', { key: 'sneaky', enemy: body() }],
    ['PUT', '/admin/enemies/api_made', { enemy: body(), expectedRevision: 1 }],
    ['PUT', '/admin/enemies/api_made/enabled', { enabled: false, expectedRevision: 1 }],
    ['POST', '/admin/enemies/api_made/duplicate', { key: 'sneaky_copy' }],
    ['DELETE', '/admin/enemies/api_made?expectedRevision=1', undefined],
  ] as const;

  it('refuses a caller with no session', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/v1/admin/enemies' })).statusCode).toBe(401);
    expect((await api.inject({ method: 'POST', url: '/api/v1/admin/enemies', payload: { key: 'sneaky', enemy: body() } })).statusCode).toBe(401);
  });

  it('refuses a signed-in player with no enemy permission — reads and writes alike', async () => {
    const before = (await data('/admin/enemies')).enemies;
    const player = asCookie(NON_OWNER_TOKEN, true);
    for (const url of ['/admin/enemies', '/admin/enemies/reference', '/admin/enemies/export', '/admin/enemies/api_made', '/admin/enemies/api_made/references']) {
      const res = await api.inject({ method: 'GET', url: `/api/v1${url}`, ...player });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    }
    for (const [method, url, payload] of [...WRITES, ['POST', '/admin/enemies/validate', { key: 'x', enemy: body(), creating: true }] as const]) {
      const res = await api.inject({ method, url: `/api/v1${url}`, ...player, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await data('/admin/enemies')).enemies).toEqual(before);
  });

  it('an owner session writes with a CSRF token, is refused without one, and is recorded as the editor', async () => {
    const noCsrf = await api.inject({ method: 'POST', url: '/api/v1/admin/enemies', ...asCookie(OWNER_TOKEN, false), payload: { key: 'by_owner', enemy: body() } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('PORTAL_CSRF_INVALID');
    const ok = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/enemies',
      ...asCookie(OWNER_TOKEN, true),
      // The actor is the session's user, never something the request said.
      payload: { key: 'by_owner', enemy: body(), updatedBy: 'someone-else' },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.updatedBy).toBe(OWNER_ID);
  });
});
