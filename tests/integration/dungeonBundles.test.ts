/**
 * Content Portability CP-4B — Complete Dungeon Bundles between two isolated
 * environments: A ("staging") and B ("production"), each its own database,
 * shipped artwork root and managed artwork root (`createDungeonWorld`), each
 * with its own Admin API server. Every import goes over a real socket.
 *
 * The central scenario: a dungeon with rooms and a gated connection, a
 * managed cover and room background, a shipped room background, an event with
 * shipped art, a leading-zero text puzzle, weighted combat waves, a boss, a
 * loot-table chest paying currency, an item and equipment, a Scene Sprite on
 * the room and on the chest, a shared WaifuMon pool of a dungeon-exclusive
 * species and its acquisition policy. It is exported from A, A's artwork roots
 * are made unavailable, and it is imported, enabled, published and played in B.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../src/api/server';
import type { ZodFastify } from '../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../src/api/portalSession';
import { DUNGEON_BUNDLE_BODY_LIMIT_BYTES } from '../../src/api/routes/v1/admin/dungeonBundles';
import { MAPPED_ERROR_CODES } from '../../src/api/errors';
import {
  artworkAssets,
  combatEnemies,
  dungeonDefinitions,
  dungeonRevisions,
  dungeonRuns,
  dungeonSceneSprites,
  dungeonSpeciesAcquisitions,
  dungeonSpeciesPools,
  enemyPackageImports,
  equipmentDefinitions,
  species,
} from '../../src/db/schema';
import { createLocalArtworkStorage } from '../../src/modules/artworkAssets/artworkStorage';
import { managedArtworkIndex } from '../../src/modules/artworkAssets/managedArtworkLookup';
import { readZip, writeZip } from '../../src/modules/artworkAssets/package/zipArchive';
import { recoverInterruptedImports } from '../../src/modules/artworkAssets/package/importJournal';
import type { DungeonArtworkRef, DungeonDefinition, DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonDefinitionSchema, dungeonDependencies } from '../../src/modules/dungeons/content/dungeonDefinition';
import { DUNGEON_BUNDLE_LIMITS, parseDungeonBundle, rebindShippedArtwork } from '../../src/modules/dungeons/bundle/dungeonBundle';
import {
  createDungeonBundleService,
  type DungeonBundleDecisions,
  type DungeonBundlePreview,
  type DungeonBundleServiceDeps,
} from '../../src/modules/dungeons/bundle/dungeonBundleService';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonRunService';
import { publishedDungeonSpeciesPolicies } from '../../src/modules/dungeons/dungeonSpeciesPolicy';
import { readDungeonPackage } from '../../src/modules/dungeons/package/dungeonPackage';
import { createSceneSpriteService, type SceneSpriteService } from '../../src/modules/dungeons/sceneSprites/sceneSpriteService';
import { createSharedDungeonPoolService, type SharedDungeonPoolService } from '../../src/modules/dungeons/sharedPools/sharedPoolService';
import { createEnemyPackageService } from '../../src/modules/enemies/enemyPackageService';
import { createGuildOwnershipService } from '../../src/modules/portalAuth/guildOwnershipService';
import {
  createPortalAuthorizationService,
  type PortalAuthorizationService,
  type PortalPermission,
} from '../../src/modules/portalAuth/portalAuthService';
import { CONTRACT, FINITE, installExclusiveSpecies } from '../helpers/dungeonCaptureFixtures';
import { CURRENCY } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { getItemBySlug } from '../helpers/fixtures';
import { solidImage, transparentSprite } from '../helpers/imageFixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../helpers/platformApiFixtures';

type Json = Record<string, any>;

interface Env {
  name: string;
  w: DungeonWorld;
  sprites: SceneSpriteService;
  pools: SharedDungeonPoolService;
  faults: NonNullable<DungeonBundleServiceDeps['faults']>;
  managedDir: string;
  api: ZodFastify;
  baseUrl: string;
}

const CSRF = 'csrf-token';
const ROLES: Record<string, PortalPermission[]> = {
  dungeonEditor: ['admin.access', 'dungeons.read', 'dungeons.write'],
  editor: ['admin.access', 'dungeons.read', 'dungeons.write', 'enemies.read', 'enemies.write', 'artwork.read', 'artwork.write'],
};
const USER_IDS: Record<string, string> = { dungeonEditor: '710000000000000001', editor: '710000000000000002', player: '710000000000000003' };

async function makeEnv(name: string): Promise<Env> {
  const w = await createDungeonWorld();
  await w.t.db.update(species).set({ affinity: 'switch' });
  await installExclusiveSpecies(w);
  w.speciesAccess.set(FINITE, []);
  const managedDir = path.join(w.artworkDir, 'managed');
  const storage = createLocalArtworkStorage(managedDir);
  const faults: Env['faults'] = {};
  const sprites = createSceneSpriteService({ db: w.t.db, assets: w.assets });
  const pools = createSharedDungeonPoolService(w.t.db);
  const enemyPackages = createEnemyPackageService({ db: w.t.db, enemies: w.enemies, assets: w.assets, storage, assetsDir: w.artworkDir, environment: name });
  const bundles = createDungeonBundleService({
    db: w.t.db,
    content: w.content,
    enemyPackages,
    sceneSprites: sprites,
    sharedPools: pools,
    assets: w.assets,
    storage,
    assetsDir: w.artworkDir,
    getRegions: () => w.app.content.regions.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
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
      services: { ...w.app, dungeonBundles: bundles },
      getContent: () => w.app.content,
      portalAuthorization: authorization,
      adminBearerAllowed: true,
    },
  });
  const baseUrl = await api.listen({ host: '127.0.0.1', port: 0 });
  return { name, w, sprites, pools, faults, managedDir, api, baseUrl };
}

let A: Env;
let B: Env;
beforeAll(async () => {
  A = await makeEnv('staging-a');
  B = await makeEnv('production-b');
}, 240_000);
afterAll(async () => {
  for (const e of [A, B]) {
    if (e && fs.existsSync(`${e.w.artworkDir}.away`)) fs.renameSync(`${e.w.artworkDir}.away`, e.w.artworkDir);
    await e?.api.close();
    await e?.w.cleanup();
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const encode = (decisions: Partial<DungeonBundleDecisions>) => Buffer.from(JSON.stringify(decisions), 'utf8').toString('base64url');

async function exportOver(e: Env, key: string, body: Json = {}, headers: Record<string, string> = AUTH): Promise<{ status: number; zip: Buffer; json: Json | null; headers: Headers }> {
  const res = await fetch(`${e.baseUrl}/api/v1/admin/dungeons/definitions/${key}/export/bundle`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, zip: buf, json: res.headers.get('content-type')?.includes('json') ? (JSON.parse(buf.toString()) as Json) : null, headers: res.headers };
}
async function upload(e: Env, url: string, zip: Buffer, headers: Record<string, string> = AUTH): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${e.baseUrl}/api/v1${url}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/zip' }, body: zip });
  return { status: res.status, json: (await res.json()) as Json };
}
async function preview(e: Env, zip: Buffer, decisions: Partial<DungeonBundleDecisions> = {}): Promise<DungeonBundlePreview> {
  const res = await upload(e, `/admin/dungeons/import/bundle/preview?decisions=${encode(decisions)}`, zip);
  expect(res.status, JSON.stringify(res.json).slice(0, 1500)).toBe(200);
  return res.json.data as DungeonBundlePreview;
}
const applyUrl = (p: DungeonBundlePreview, decisions: Partial<DungeonBundleDecisions>, requestId = randomUUID()) =>
  `/admin/dungeons/import/bundle/apply?expectedPlanHash=${encodeURIComponent(p.planHash)}&requestId=${requestId}&decisions=${encode({ dungeon: p.dungeon.decision, ...decisions })}`;
async function apply(e: Env, zip: Buffer, p: DungeonBundlePreview, decisions: Partial<DungeonBundleDecisions> = {}, requestId = randomUUID()) {
  return upload(e, applyUrl(p, decisions, requestId), zip);
}
/** Keep this server's version of everything the review says differs. */
function keepAll(p: DungeonBundlePreview, extra: Partial<DungeonBundleDecisions> = {}): Partial<DungeonBundleDecisions> {
  const of = (kind: string): Record<string, 'keep'> =>
    Object.fromEntries(p.decisionsRequired.filter((k) => k.startsWith(`${kind}:`)).map((k) => [k.slice(kind.length + 1), 'keep' as const]));
  return { enemies: of('enemy'), sceneSprites: of('sprite'), sharedPools: of('pool'), ...extra };
}
const managedFiles = (e: Env): string[] => {
  if (!fs.existsSync(e.managedDir)) return [];
  return (fs.readdirSync(e.managedDir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((d) => d.isFile())
    .map((d) => path.relative(e.managedDir, path.join(d.parentPath, d.name)))
    .sort();
};
async function tables(e: Env): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const name of [
    'dungeon_definitions', 'dungeon_revisions', 'dungeon_runs', 'dungeon_import_history', 'dungeon_loot_tables',
    'dungeon_species_pools', 'dungeon_scene_sprites', 'combat_enemies', 'artwork_assets', 'dungeon_species_acquisitions',
  ])
    out[name] = (await e.w.t.pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]') AS rows FROM "${name}" t`)).rows[0].rows;
  return { ...out, files: managedFiles(e) };
}
const managed = (asset: { category: string; contentHash: string; name: string }): DungeonArtworkRef => ({ kind: 'managed', category: asset.category, contentHash: asset.contentHash, name: asset.name });
const zipText = (zip: Buffer) =>
  readZip(zip, { maxArchiveBytes: 1e9, maxEntries: 1000, maxExpandedBytes: 1e9, maxCompressionRatio: 1000, maxEntryBytes: () => 1e8, allowDirectory: () => true })
    .filter((f) => f.name.endsWith('.json'))
    .map((f) => f.data.toString())
    .join('\n');
/** Re-zip a bundle's entries after `edit`, exactly as a hostile or careless tool would. */
function rezip(zip: Buffer, edit: (entries: { name: string; data: Buffer }[]) => { name: string; data: Buffer }[]): Buffer {
  const entries = readZip(zip, { maxArchiveBytes: 1e9, maxEntries: 1000, maxExpandedBytes: 1e9, maxCompressionRatio: 1000, maxEntryBytes: () => 1e8, allowDirectory: () => true });
  return writeZip(edit(entries.map((e) => ({ name: e.name, data: e.data }))));
}
const assetBytesOf = async (e: Env, id: string) => (await e.w.assets.read(id))!.bytes;
/** Make A's shipped and managed roots unavailable (or available again), idempotently. */
const hideA = () => { if (fs.existsSync(A.w.artworkDir)) fs.renameSync(A.w.artworkDir, `${A.w.artworkDir}.away`); };
const showA = () => { if (fs.existsSync(`${A.w.artworkDir}.away`)) fs.renameSync(`${A.w.artworkDir}.away`, A.w.artworkDir); };
const nextDay = (e: Env) => { e.w.clock.now = new Date(e.w.clock.now.getTime() + 86_400_000); };

/** Play a run to its end: fight, answer, choose, capture when offered and move on through open doors. */
async function drive(e: Env, playerId: number, start: DungeonRunView, opts: { answer: string; capture: boolean; stopBefore?: string }): Promise<DungeonRunView> {
  let view = start;
  for (let guard = 0; view.status === 'active' && guard < 60; guard++) {
    const core = view.core;
    if (opts.stopBefore && core.action?.id === opts.stopBefore) return view;
    if (core.phase === 'action') {
      const a = core.action!;
      if (a.type === 'text_puzzle') view = (await e.w.act(playerId, view, { type: 'answer', answer: opts.answer })).run;
      else if (a.type === 'event') view = (await e.w.act(playerId, view, { type: 'choose', choiceId: 'pray' })).run;
      else if (a.type === 'wild_encounter') {
        if (a.encounter?.available && opts.capture) {
          const selected = (await e.w.act(playerId, view, { type: 'select_item', item: CONTRACT })).run;
          view = (await e.w.act(playerId, selected, { type: 'capture' })).run;
        } else if (a.encounter && !a.encounter.available) view = (await e.w.act(playerId, view, { type: 'dismiss_encounter' })).run;
        else view = (await e.w.act(playerId, view, { type: 'decline' })).run;
      } else view = (await e.w.act(playerId, view, { type: 'advance' })).run;
    } else if (core.phase === 'connections') {
      const next = core.connections.find((c) => c.open && !c.toRoomCompleted);
      if (!next) break;
      view = (await e.w.act(playerId, view, { type: 'move', connectionId: next.id })).run;
    }
  }
  return view;
}

// ── fixture: the dungeon in A ───────────────────────────────────────────────

const KEY = 'cp4b_vault';
const GUARD = 'cp4b_guard';
const DRONE = 'cp4b_drone';
const BOSS = 'cp4b_boss';
const SPRITE = 'cp4b_chest';
const POOL = 'cp4b_exclusives';
const LOOT = 'cp4b_chest_loot';
const LAIR_BG = 'dungeons/backgrounds/cp4b_lair.webp';
const EVENT_ART = 'dungeons/events/cp4b_shrine.png';
const DRONE_ART = 'combat/cp4b/drone.png';
const ANSWER = '0042';
let cover: { category: string; contentHash: string; name: string; id: string };
let hallBackground: typeof cover;

function vault(name = 'CP-4B Vault'): DungeonDefinition {
  const input: DungeonDefinitionInput = {
    key: KEY,
    name,
    description: 'Complete bundle fixture.',
    availableRegions: ['waifu-valley'],
    entranceRoomId: 'hall',
    settings: { progressionCurrency: CURRENCY, defeatCurrencyRetentionBasisPoints: 2500 },
    artwork: managed(cover),
    flags: [{ key: 'door_open', scope: 'run' }],
    speciesPools: [{ id: 'exclusives', name: 'Shared exclusives', sharedPoolKey: POOL, entries: [] }],
    speciesPolicies: [{ species: FINITE, perPlayerLimit: 1 }],
    events: [
      {
        id: 'shrine',
        title: 'A shrine',
        text: 'Candles flicker.',
        artwork: { kind: 'shipped', path: EVENT_ART },
        choices: [
          { id: 'pray', label: 'Pray', outcome: { text: 'Calm.' } },
          { id: 'leave', label: 'Leave', outcome: { text: 'Later.' } },
        ],
      },
    ],
    rooms: [
      {
        id: 'hall',
        name: 'Hall',
        background: managed(hallBackground),
        sceneSprites: [{ id: 'crate_left', spriteKey: SPRITE, placement: { offsetX: -200 } }],
        actions: [
          { id: 'guards', type: 'combat', waves: [{ enemy: { key: GUARD } }, { enemy: { pool: [{ key: GUARD, weight: 3 }, { key: DRONE, weight: 1 }] } }] },
          { id: 'keypad', type: 'text_puzzle', label: 'Door', prompt: 'Enter the code.', answers: [ANSWER], solvedFlag: 'door_open', solvedText: 'Click.', incorrectText: 'Buzz.' },
          { id: 'story', type: 'event', source: { kind: 'event', eventId: 'shrine' } },
          {
            id: 'chest',
            type: 'reward',
            rewards: { guaranteed: [], chances: [], tables: [{ id: 'draw', table: LOOT, draws: 1 }] },
            sceneSprites: [{ id: 'chest_glow', spriteKey: SPRITE, visualLayer: 'foreground' }],
          },
          { id: 'meet', type: 'wild_encounter', source: { kind: 'pool', poolId: 'exclusives' }, intro: 'Something stirs.', capture: {} },
        ],
      },
      { id: 'lair', name: 'Lair', kind: 'exit', background: { kind: 'shipped', path: LAIR_BG }, actions: [{ id: 'boss', type: 'boss', waves: [{ enemy: { key: BOSS } }] }] },
    ],
    connections: [{ id: 'c_lair', from: 'hall', to: 'lair', requires: { type: 'flag', flag: 'door_open' }, lockedText: 'Sealed.' }],
  } as DungeonDefinitionInput;
  return DungeonDefinitionSchema.parse(input);
}

async function buildA(): Promise<void> {
  const up = async (bytes: Buffer, category: Parameters<DungeonWorld['assets']['upload']>[0]['category'], filename: string) =>
    A.w.assets.upload({ bytes, category, filename }, 'author');
  cover = await up(await solidImage(96, 54, { r: 200, g: 120, b: 10 }, 'webp'), 'dungeon_zone', 'vault-cover.webp');
  hallBackground = await up(await solidImage(160, 90, { r: 20, g: 40, b: 90 }, 'png'), 'dungeon_background', 'hall.png');
  for (const [file, bytes] of [
    [LAIR_BG, await solidImage(160, 90, { r: 90, g: 10, b: 10 }, 'webp')],
    [EVENT_ART, await solidImage(120, 90, { r: 240, g: 230, b: 200 }, 'png')],
    [DRONE_ART, await solidImage(64, 64, { r: 0, g: 160, b: 160 }, 'png')],
  ] as const) {
    fs.mkdirSync(path.dirname(path.join(A.w.artworkDir, file)), { recursive: true });
    fs.writeFileSync(path.join(A.w.artworkDir, file), bytes);
  }
  const enemy = async (key: string, i: number, hp: number, shipped: string | null) => {
    const art = shipped ? null : await up(await solidImage(80 + i, 60, { r: 30 * i, g: 90, b: 140 }, 'png'), 'enemy_art', `${key}.png`);
    const sprite = await up(await transparentSprite(48, 64 + i, { r: 200, g: 30 * i, b: 40 }, 'webp'), 'enemy_sprite', `${key}-sprite.webp`);
    await A.w.enemies.create(key, {
      name: key.replace('cp4b_', 'CP-4B ').replace('_', ' '),
      description: `Bundle enemy ${i}`,
      enabled: true,
      attack: 60,
      defense: 0,
      hp,
      tags: ['cp4b'],
      artworkPath: shipped,
      spritePlacement: { anchor: 'bottom-center', scaleBasisPoints: 4200 + i * 100, offsetX: i * 5, offsetY: 0 },
      artworkAssetId: art?.id ?? null,
      spriteAssetId: sprite.id,
    }, 'author');
  };
  await enemy(GUARD, 1, 150, null);
  await enemy(DRONE, 2, 160, DRONE_ART);
  await enemy(BOSS, 3, 300, null);
  const spriteArt = await up(await transparentSprite(100, 100, { r: 240, g: 200, b: 20 }), 'dungeon_scene_sprite', 'chest.png');
  await A.sprites.create(SPRITE, { name: 'Golden chest', category: 'Chest', assetId: spriteArt.id, placement: { anchor: 'bottom-center', scaleBasisPoints: 3000 } }, 'author');
  await A.pools.create({ key: POOL, name: 'Shared exclusives', description: 'Dungeon-exclusive androids', enabled: true, entries: [{ id: 'finite', species: FINITE, weight: 1 }] }, 'author');
  await createDungeonLootTableService({ db: A.w.t.db }).create({
    key: LOOT,
    name: 'Chest loot',
    body: {
      guaranteed: [
        { id: 'cash', grant: { type: 'currency', currency: 'waifubux', amount: { min: 5, max: 5 } } },
        { id: 'stick', grant: { type: 'item', item: 'sticky_joystick', quantity: { min: 1, max: 1 } } },
        { id: 'gear', grant: { type: 'equipment', selector: { definitionKeys: ['rusty_pipe'] } } },
      ],
      chances: [],
      pools: [],
    },
  }, 'author');
  const created = await A.w.content.create({ definition: vault() }, 'author');
  await A.w.content.publish(KEY, { expectedRevision: created.draftRevision }, 'author');
}

// ── the central scenario ────────────────────────────────────────────────────

describe('a complete dungeon, A → B, with A’s artwork gone', () => {
  let zip: Buffer;
  let reviewed: DungeonBundlePreview;
  let aDraft: DungeonDefinition;
  let publishedZip: Buffer;
  const aIds = new Set<string>();

  beforeAll(async () => {
    await buildA();
    // After publication the catalogue sprite moves: the published export must keep the frozen look.
    const detail = (await A.sprites.get(SPRITE))!;
    await A.sprites.update(SPRITE, { name: detail.name, category: detail.category, assetId: detail.assetId, placement: { anchor: 'center', scaleBasisPoints: 6000 }, mirror: true, visualLayer: detail.visualLayer }, detail.revision, 'author');
    const draft = await exportOver(A, KEY);
    expect(draft.status, JSON.stringify(draft.json)).toBe(200);
    zip = draft.zip;
    const published = await exportOver(A, KEY, { origin: 'published' });
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    publishedZip = published.zip;
    aDraft = (await A.w.content.get(KEY))!.draft;
    for (const row of await A.w.t.db.select({ id: artworkAssets.id, key: artworkAssets.storageKey }).from(artworkAssets)) {
      aIds.add(row.id);
      aIds.add(row.key);
    }
    // A's shipped and managed roots become unavailable.
    hideA();
  }, 120_000);
  afterAll(showA);

  it('exports every dependency with bytes, and no source ids, storage keys, URLs or host paths', async () => {
    const bundle = await parseDungeonBundle(zip);
    expect(bundle.pkg.schemaVersion).toBe(4);
    expect(bundle.manifest.source).toMatchObject({ environment: 'staging-a', dungeonKey: KEY, origin: 'draft' });
    expect(bundle.enemies!.definitions.map((d) => d.key).sort()).toEqual([BOSS, DRONE, GUARD]);
    expect(bundle.pools.map((p) => p.key)).toEqual([POOL]);
    expect(bundle.manifest.sceneSprites).toMatchObject({ evidence: 'catalogue', sprites: [{ key: SPRITE, mirror: true, placement: { anchor: 'center', scaleBasisPoints: 6000 } }] });
    // Cover, hall, lair and shrine for the dungeon; three art + three sprites − one shipped-only for enemies; the sprite.
    expect(bundle.manifest.artwork.map((a) => a.ref.kind).sort()).toEqual(['managed', 'managed', 'shipped', 'shipped']);
    expect(bundle.manifest.assets).toHaveLength(4 + 6 + 1);
    const text = zipText(zip);
    for (const id of aIds) expect(text).not.toContain(id);
    expect(text).not.toContain(A.w.artworkDir);
    expect(text).not.toMatch(/https?:\/\//);
    // The leading-zero answer survives as a string.
    expect(bundle.pkg.dungeon.rooms[0]!.actions[1]).toMatchObject({ type: 'text_puzzle', answers: ['0042'] });
  });

  it('the published export carries the revision’s frozen sprite visuals, not the catalogue’s current ones', async () => {
    const bundle = await parseDungeonBundle(publishedZip);
    expect(bundle.manifest.source).toMatchObject({ origin: 'revision', publishedRevision: 1 });
    expect(bundle.manifest.sceneSprites).toMatchObject({
      evidence: 'revision_snapshot',
      snapshotHash: expect.any(String),
      sprites: [{ key: SPRITE, mirror: false, placement: { anchor: 'bottom-center', scaleBasisPoints: 3000 }, category: null }],
    });
  });

  it('previews against B: everything to create, external prerequisites present, disabled until enabled', async () => {
    const before = await tables(B);
    reviewed = await preview(B, zip);
    expect(await tables(B)).toEqual(before);
    expect(reviewed.dungeon).toMatchObject({ key: KEY, decision: 'create', plan: { target: { status: 'new', enabled: null, publishedRevision: null } } });
    expect(reviewed.enemies.map((e) => [e.key, e.outcome]).sort()).toEqual([[BOSS, 'create'], [DRONE, 'create'], [GUARD, 'create']]);
    expect(reviewed.sceneSprites).toMatchObject([{ key: SPRITE, outcome: 'create', resultKey: SPRITE, assetDestination: 'create' }]);
    expect(reviewed.sharedPools).toMatchObject([{ key: POOL, outcome: 'create', enabledAfterImport: false, uses: 'bundled', species: [{ slug: FINITE, status: 'available' }] }]);
    // B lacks both shipped dungeon images: they become managed copies in the draft.
    expect(reviewed.artwork.dungeon.filter((a) => a.rebound).map((a) => a.path).sort()).toEqual([EVENT_ART, LAIR_BG].sort());
    expect(reviewed.artwork.assets.every((a) => a.action === 'create')).toBe(true);
    expect(reviewed.prerequisites).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'species', key: FINITE, status: 'available', notes: expect.arrayContaining([expect.stringContaining('Dungeon-exclusive')]) }),
      expect.objectContaining({ kind: 'item', key: 'sticky_joystick', status: 'available' }),
      expect.objectContaining({ kind: 'equipment', key: 'rusty_pipe', status: 'available' }),
      expect.objectContaining({ kind: 'currency', key: CURRENCY, status: 'available' }),
      expect.objectContaining({ kind: 'region', key: 'waifu-valley', status: 'available' }),
    ]));
    expect(reviewed.remainsDisabled).toEqual(expect.arrayContaining([
      { kind: 'shared_pool', key: POOL, name: 'Shared exclusives', requiredForPublication: true },
      expect.objectContaining({ kind: 'enemy', key: GUARD, requiredForPublication: false }),
    ]));
    expect(reviewed.decisionsRequired).toEqual([]);
    expect(reviewed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(reviewed.readiness).toBe('needs_enabling');
  });

  it('applies atomically: a disabled, unpublished draft whose artwork, enemies, sprite and pool all resolve in B', async () => {
    const res = await apply(B, zip, reviewed);
    expect(res.status, JSON.stringify(res.json).slice(0, 2000)).toBe(200);
    const result = res.json.data;
    expect(result).toMatchObject({
      dungeonKey: KEY, dungeonResult: 'created', enabled: false, publishedRevision: null, readiness: 'needs_enabling', replayed: false,
      enemies: { created: [BOSS, DRONE, GUARD].sort() }, sceneSprites: { created: [SPRITE] }, sharedPools: { created: [POOL] },
      assets: { created: 11, reused: 0 }, createdLootTables: [LOOT],
    });
    const detail = (await B.w.content.get(KEY))!;
    expect(detail).toMatchObject({ enabled: false, published: null });
    // Graph, event, puzzle, encounter, reward and policy content is A's, with shipped images rebound to managed copies.
    const rebinds = new Map<string, DungeonArtworkRef>(detail.draft.rooms.flatMap((r) => (r.background?.kind === 'managed' && r.id === 'lair' ? [[LAIR_BG, r.background] as const] : [])));
    const shrine = detail.draft.events!.find((ev) => ev.id === 'shrine')!.artwork!;
    expect(shrine).toMatchObject({ kind: 'managed', category: 'dungeon_background' });
    rebinds.set(EVENT_ART, shrine);
    expect(detail.draft).toEqual(rebindShippedArtwork(aDraft, rebinds as never));
    expect(detail.draft.rooms[0]!.actions[1]).toMatchObject({ answers: [ANSWER] });

    // Every managed reference resolves to a B-local asset whose file holds exactly the bytes.
    const index = await managedArtworkIndex(B.w.t.db);
    for (const ref of dungeonDependencies(detail.draft).artwork) {
      expect(ref.kind).toBe('managed');
      if (ref.kind !== 'managed') continue;
      const id = index.get(`${ref.category}:${ref.contentHash}`)!;
      expect(aIds.has(id)).toBe(false);
      expect(sha(await assetBytesOf(B, id))).toBe(ref.contentHash);
    }
    // Enemies: B-local ids, bytes intact, placement kept, arriving disabled.
    for (const key of [GUARD, DRONE, BOSS]) {
      const [row] = await B.w.t.db.select().from(combatEnemies).where(eq(combatEnemies.enemyKey, key));
      expect(row).toMatchObject({ enabled: false });
      expect(aIds.has(row!.spriteAssetId!)).toBe(false);
      expect((await B.w.assets.get(row!.spriteAssetId!))!.category).toBe('enemy_sprite');
    }
    const [drone] = await B.w.t.db.select().from(combatEnemies).where(eq(combatEnemies.enemyKey, DRONE));
    // The drone's shipped full art is not on B: its packaged copy is bound as managed artwork.
    expect(drone!.artworkPath).toBe(DRONE_ART);
    expect((await B.w.assets.get(drone!.artworkAssetId!))!.category).toBe('enemy_art');
    // Scene Sprite: B-local asset, catalogue definition as exported.
    const [sprite] = await B.w.t.db.select().from(dungeonSceneSprites).where(eq(dungeonSceneSprites.spriteKey, SPRITE));
    expect(aIds.has(sprite!.assetId)).toBe(false);
    expect(sprite!.definition).toMatchObject({ name: 'Golden chest', category: 'Chest', mirror: true });
    // Shared pool: created disabled with A's body.
    const pool = await B.pools.get(POOL);
    expect(pool.definition).toMatchObject({ enabled: false, entries: [{ id: 'finite', species: FINITE, weight: 1 }] });
    // Nothing was written into B's shipped tree.
    for (const file of [LAIR_BG, EVENT_ART, DRONE_ART]) expect(fs.existsSync(path.join(B.w.artworkDir, file))).toBe(false);
  });

  it('cannot be published until the shared pool is enabled; enabled and published, a run completes and acquisition limits hold', async () => {
    const draftRevision = (await B.w.content.get(KEY))!.draftRevision;
    await expect(B.w.content.publish(KEY, { expectedRevision: draftRevision }, 'publisher')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
    const pool = await B.pools.get(POOL);
    await B.pools.setEnabled(POOL, true, pool.revision, 'operator');
    for (const key of [GUARD, DRONE, BOSS]) {
      const enemy = (await B.w.enemies.get(key))!;
      await B.w.enemies.setEnabled(key, { enabled: true, expectedRevision: enemy.revision }, 'operator');
    }
    const { revision } = await B.w.content.publish(KEY, { expectedRevision: draftRevision }, 'publisher');
    await B.w.content.setEnabled(KEY, true, 'operator');
    expect(revision.number).toBe(1);

    const { playerId } = await B.w.player();
    await B.w.app.inventory.addItem(B.w.t.db, playerId, (await getItemBySlug(B.w.t.db, CONTRACT)).id, 2);
    const start = await B.w.runs.start(playerId, KEY);
    expect(start.sceneSprites?.length).toBeGreaterThan(0);
    const end = await drive(B, playerId, start, { answer: ANSWER, capture: true });
    expect(end.status).toBe('completed');
    const ledger = await B.w.t.db.select().from(dungeonSpeciesAcquisitions).where(eq(dungeonSpeciesAcquisitions.dungeonKey, KEY));
    const [finite] = await B.w.t.db.select().from(species).where(eq(species.slug, FINITE));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ speciesId: finite!.id, mode: 'capture', actionId: 'meet' });
    expect(await publishedDungeonSpeciesPolicies(B.w.t.db, KEY)).toEqual([{ species: FINITE, perPlayerLimit: 1 }]);
    // The per-player limit of 1 stops the next run's offer.
    nextDay(B);
    const again = await B.w.runs.start(playerId, KEY);
    const atMeet = await drive(B, playerId, again, { answer: ANSWER, capture: false, stopBefore: 'boss' });
    const [row] = await B.w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, again.id));
    expect((row!.encounterStates as Record<string, { status: string; unavailableReason?: string }>)['hall:meet']).toMatchObject({ status: 'unavailable', unavailableReason: 'player_limit' });
    if (atMeet.status === 'active') await B.w.act(playerId, atMeet, { type: 'abandon' });
  });

  it('reimporting the identical bundle changes nothing and duplicates no artwork; an exact retry replays its receipt', async () => {
    const before = await tables(B);
    const again = await preview(B, zip);
    expect(again.dungeon.decision).toBe('unchanged');
    expect(again.enemies.every((e) => e.outcome === 'unchanged')).toBe(true);
    expect(again.sceneSprites[0]).toMatchObject({ outcome: 'identical', assetDestination: 'not_needed' });
    expect(again.sharedPools[0]).toMatchObject({ outcome: 'identical' });
    expect(again.artwork.assets.every((a) => a.action !== 'create')).toBe(true);
    const requestId = randomUUID();
    const first = await apply(B, zip, again, {}, requestId);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.data).toMatchObject({ dungeonResult: 'unchanged', assets: { created: 0 }, replayed: false });
    const after = await tables(B);
    expect(after.artwork_assets).toEqual(before.artwork_assets);
    expect(after.files).toEqual(before.files);
    expect(after.combat_enemies).toEqual(before.combat_enemies);
    expect(after.dungeon_scene_sprites).toEqual(before.dungeon_scene_sprites);
    expect(after.dungeon_species_pools).toEqual(before.dungeon_species_pools);
    const replay = await apply(B, zip, again, {}, requestId);
    expect(replay.json.data).toEqual({ ...first.json.data, replayed: true });
    expect((await tables(B)).dungeon_import_history).toEqual(after.dungeon_import_history);
  });
});

// ── a published dungeon updated through a bundle ────────────────────────────

describe('updating a live dungeon in B through a bundle', () => {
  it('keeps revision 1 live for active and new runs until revision 2 is explicitly published', async () => {
    const { playerId } = await B.w.player();
    await B.w.app.inventory.addItem(B.w.t.db, playerId, (await getItemBySlug(B.w.t.db, CONTRACT)).id, 1);
    nextDay(B);
    const active = await B.w.runs.start(playerId, KEY);
    const activeRow = (await B.w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, active.id)))[0]!;
    const r1 = (await B.w.content.get(KEY))!.published!;

    // A edits its draft; the new bundle is A's revision 2 draft.
    showA();
    const aCurrent = (await A.w.content.get(KEY))!;
    await A.w.content.saveDraft(KEY, { definition: vault('CP-4B Vault (revised)'), expectedRevision: aCurrent.draftRevision }, 'author');
    const exported = await exportOver(A, KEY);
    expect(exported.status).toBe(200);
    hideA();

    const p = await preview(B, exported.zip);
    expect(p.dungeon).toMatchObject({ decision: 'replace', plan: { target: { status: 'different', enabled: true, publishedRevision: 1 } } });
    const res = await apply(B, exported.zip, p);
    expect(res.status, JSON.stringify(res.json).slice(0, 1500)).toBe(200);
    expect(res.json.data).toMatchObject({ dungeonResult: 'replaced', enabled: true, publishedRevision: 1, assets: { created: 0 } });

    // Revision 1 stays live; the active run, its frozen dependencies and the acquisition terms are untouched.
    const detail = (await B.w.content.get(KEY))!;
    expect(detail).toMatchObject({ enabled: true, published: { revisionId: r1.revisionId }, draft: { name: 'CP-4B Vault (revised)' } });
    expect((await B.w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, active.id)))[0]).toEqual(activeRow);
    expect(await publishedDungeonSpeciesPolicies(B.w.t.db, KEY)).toEqual([{ species: FINITE, perPlayerLimit: 1 }]);
    const other = await B.w.player();
    const during = await B.w.runs.start(other.playerId, KEY);
    expect((await B.w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, during.id)))[0]!.revisionId).toBe(r1.revisionId);
    expect(during.dungeon.name).toBe('CP-4B Vault');

    // Only an explicit publish moves new runs to revision 2; older runs keep their snapshots.
    const { revision: r2 } = await B.w.content.publish(KEY, { expectedRevision: detail.draftRevision }, 'publisher');
    expect(r2.number).toBe(2);
    const third = await B.w.player();
    const after = await B.w.runs.start(third.playerId, KEY);
    expect(after.dungeon.name).toBe('CP-4B Vault (revised)');
    expect((await B.w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, active.id)))[0]).toEqual(activeRow);
    expect((await B.w.restartedRuns().run(playerId, active.id)).dungeon.revision).toBe(1);
    for (const [id, pid] of [[active.id, playerId], [during.id, other.playerId], [after.id, third.playerId]] as const) {
      const run = await B.w.runs.run(pid, id);
      if (run.status === 'active') await B.w.act(pid, run, { type: 'abandon' });
    }
  });
});

// ── conflicts ───────────────────────────────────────────────────────────────

describe('conflicts in B', () => {
  let zip: Buffer;
  beforeAll(async () => {
    showA();
    zip = (await exportOver(A, KEY)).zip;
  });

  it('a differing enemy another B dungeon uses needs a decision; keep leaves it alone, update keeps its enabled state', async () => {
    const other = DungeonDefinitionSchema.parse({ ...vault(), key: 'cp4b_other', name: 'Other', events: [], speciesPools: [], speciesPolicies: [], rooms: [{ id: 'hall', name: 'Hall', kind: 'exit', actions: [{ id: 'g', type: 'combat', waves: [{ enemy: { key: GUARD } }] }] }], connections: [], artwork: null });
    await B.w.content.create({ definition: other }, 'author');
    const guard = (await B.w.enemies.get(GUARD))!;
    await B.w.enemies.update(GUARD, { enemy: { name: guard.name, description: 'Edited in B', enabled: guard.enabled, attack: 61, defense: guard.defense, hp: guard.hp, tags: guard.tags }, expectedRevision: guard.revision }, 'b-author');
    const p = await preview(B, zip);
    const entry = p.enemies.find((e) => e.key === GUARD)!;
    expect(entry.outcome).toBe('conflict');
    expect(entry.references.map((r) => r.key)).toContain('cp4b_other');
    expect(p.decisionsRequired).toContain(`enemy:${GUARD}`);
    const missing = await apply(B, zip, p);
    expect(missing.status).toBe(409);
    expect(missing.json.error).toMatchObject({ code: 'DUNGEON_BUNDLE_DECISIONS_REQUIRED', details: { keys: expect.arrayContaining([`enemy:${GUARD}`]) } });

    const keep = await preview(B, zip, { enemies: { [GUARD]: 'keep' } });
    expect(keep.decisionsRequired).toEqual([]);
    expect((await apply(B, zip, keep, { enemies: { [GUARD]: 'keep' } })).status).toBe(200);
    expect((await B.w.enemies.get(GUARD))!).toMatchObject({ attack: 61, description: 'Edited in B' });

    const update = await preview(B, zip, { enemies: { [GUARD]: 'update' } });
    expect((await apply(B, zip, update, { enemies: { [GUARD]: 'update' } })).status).toBe(200);
    expect((await B.w.enemies.get(GUARD))!).toMatchObject({ attack: 60, enabled: true });
  });

  it('a shared pool that differs and another dungeon uses: the review names that dungeon; keep leaves the body as B has it', async () => {
    const pool = await B.pools.get(POOL);
    await B.pools.update(POOL, { ...pool.definition, description: 'B description' }, pool.revision, 'b-author');
    const otherDef = (await B.w.content.get('cp4b_other'))!.draft;
    await B.w.content.saveDraft('cp4b_other', { definition: { ...otherDef, speciesPools: [{ id: 'p', name: 'P', sharedPoolKey: POOL, entries: [] }] }, expectedRevision: (await B.w.content.get('cp4b_other'))!.draftRevision }, 'b-author');
    const p = await preview(B, zip);
    expect(p.sharedPools[0]).toMatchObject({ outcome: 'conflict', changedFields: ['description'], otherDungeons: [expect.objectContaining({ dungeonKey: 'cp4b_other' })] });
    expect(p.decisionsRequired).toContain(`pool:${POOL}`);
    const update = await preview(B, zip, { sharedPools: { [POOL]: 'update' } });
    expect(update.issues).toContainEqual(expect.objectContaining({ code: 'shared_pool_shared', message: expect.stringContaining('Other') }));
    const keep = await preview(B, zip, { sharedPools: { [POOL]: 'keep' } });
    const before = await B.pools.get(POOL);
    expect((await apply(B, zip, keep, { sharedPools: { [POOL]: 'keep' } })).status).toBe(200);
    expect(await B.pools.get(POOL)).toMatchObject({ revision: before.revision, definition: { description: 'B description', enabled: true } });
  });

  it('a Scene Sprite that differs: copy creates a new key for this dungeon only; the frozen published snapshot is untouched', async () => {
    const sprite = (await B.sprites.get(SPRITE))!;
    await B.sprites.update(SPRITE, { name: sprite.name, category: sprite.category, assetId: sprite.assetId, placement: { anchor: 'bottom-left', scaleBasisPoints: 2000 }, mirror: sprite.mirror, visualLayer: sprite.visualLayer }, sprite.revision, 'b-author');
    const [published] = await B.w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, KEY)).orderBy(asc(dungeonRevisions.number));
    const frozen = published!.sceneSpriteSnapshot;
    const p = await preview(B, zip);
    expect(p.sceneSprites[0]).toMatchObject({ key: SPRITE, outcome: 'conflict', changedFields: ['placement'], suggestedCopyKey: `${SPRITE}_imported` });
    expect(p.sceneSprites[0]!.references.map((r) => r.source)).toEqual(expect.arrayContaining(['draft', 'revision 1']));
    const choice = { sceneSprites: { [SPRITE]: 'copy' as const }, sharedPools: { [POOL]: 'keep' as const } };
    const copy = await preview(B, zip, choice);
    expect(copy.sceneSprites[0]).toMatchObject({ decision: 'copy', resultKey: `${SPRITE}_imported`, assetDestination: 'reuse' });
    const res = await apply(B, zip, copy, choice);
    expect(res.status, JSON.stringify(res.json).slice(0, 1500)).toBe(200);
    expect(res.json.data.sceneSprites).toMatchObject({ copied: [{ from: SPRITE, to: `${SPRITE}_imported` }] });
    const draft = (await B.w.content.get(KEY))!.draft;
    expect(draft.rooms[0]!.sceneSprites).toEqual([{ id: 'crate_left', spriteKey: `${SPRITE}_imported`, placement: { offsetX: -200 } }]);
    expect((await B.sprites.get(SPRITE))!.placement).toMatchObject({ anchor: 'bottom-left' });
    const [still] = await B.w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.id, published!.id));
    expect(still!.sceneSpriteSnapshot).toEqual(frozen);
  });

  it('a Scene Sprite update changes the shared sprite for future publications only; frozen revisions keep their visuals', async () => {
    const [published] = await B.w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, KEY)).orderBy(asc(dungeonRevisions.number));
    const frozen = published!.sceneSpriteSnapshot;
    const choice = { sceneSprites: { [SPRITE]: 'update' as const }, sharedPools: { [POOL]: 'keep' as const } };
    const p = await preview(B, zip, choice);
    expect(p.sceneSprites[0]).toMatchObject({ outcome: 'conflict', decision: 'update', resultKey: SPRITE });
    expect(p.issues).toContainEqual(expect.objectContaining({ code: 'scene_sprite_shared', message: expect.stringContaining('Published revisions keep their frozen visuals') }));
    const before = (await B.sprites.get(SPRITE))!;
    const res = await apply(B, zip, p, choice);
    expect(res.status, JSON.stringify(res.json).slice(0, 1500)).toBe(200);
    expect(res.json.data.sceneSprites).toMatchObject({ updated: [SPRITE] });
    const after = (await B.sprites.get(SPRITE))!;
    expect(after).toMatchObject({ revision: before.revision + 1, placement: { anchor: 'center', scaleBasisPoints: 6000 }, mirror: true, assetId: before.assetId });
    const [still] = await B.w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.id, published!.id));
    expect(still!.sceneSpriteSnapshot).toEqual(frozen);
  });

  it('different destination reward candidates are reported against the bundled reward evidence', async () => {
    const [gear] = await B.w.t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, 'rusty_pipe'));
    await B.w.t.db.update(equipmentDefinitions).set({ enabled: false }).where(eq(equipmentDefinitions.key, 'rusty_pipe'));
    try {
      const p = await preview(B, zip, keepAll(await preview(B, zip)));
      expect(p.prerequisites).toContainEqual(expect.objectContaining({ kind: 'equipment', key: 'rusty_pipe', status: 'disabled' }));
      expect(p.dungeon.plan.equipmentChanges).toEqual([expect.objectContaining({ removed: [expect.objectContaining({ key: 'rusty_pipe' })] })]);
      expect(p.readiness).not.toBe('ready');
    } finally {
      await B.w.t.db.update(equipmentDefinitions).set({ enabled: gear!.enabled }).where(eq(equipmentDefinitions.key, 'rusty_pipe'));
    }
  });

  it('a stale review is refused with no writes when a dependency changes between preview and apply', async () => {
    const p = await preview(B, zip, { sceneSprites: { [SPRITE]: 'keep' } });
    const pool = await B.pools.get(POOL);
    await B.pools.update(POOL, { ...pool.definition, description: 'Changed after review' }, pool.revision, 'b-author');
    const before = await tables(B);
    const res = await apply(B, zip, p, { sceneSprites: { [SPRITE]: 'keep' } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('DUNGEON_BUNDLE_STALE');
    expect(await tables(B)).toEqual(before);
  });
});

// ── failure, retry and concurrency ──────────────────────────────────────────

describe('failures, retries and concurrency', () => {
  let zip: Buffer;
  beforeAll(async () => {
    showA();
    const d = vault('Second copy');
    await A.w.content.create({ definition: { ...d, key: 'cp4b_second' } }, 'author');
    zip = (await exportOver(A, 'cp4b_second')).zip;
  });

  it('a failure after staging leaves no row, no staged file and no change to reused assets; the same request then succeeds', async () => {
    // Drop B's copy of one sprite so this import must create one new asset while reusing the rest.
    const decisions = keepAll(await preview(B, zip));
    const p = await preview(B, zip, decisions);
    const reusedIds = p.artwork.assets.flatMap((a) => a.reuse);
    expect(reusedIds.length).toBeGreaterThan(0);
    const reusedBytes = await Promise.all(reusedIds.map((id) => assetBytesOf(B, id)));
    const before = await tables(B);
    B.faults.beforeCommit = async () => {
      throw new Error('injected failure before commit');
    };
    const requestId = randomUUID();
    try {
      const failed = await apply(B, zip, p, decisions, requestId);
      expect(failed.status).toBe(500);
    } finally {
      delete B.faults.beforeCommit;
    }
    expect(await tables(B)).toEqual(before);
    expect(await Promise.all(reusedIds.map((id) => assetBytesOf(B, id)))).toEqual(reusedBytes);
    const [journal] = await B.w.t.db.select().from(enemyPackageImports).where(eq(enemyPackageImports.requestId, requestId));
    expect(journal).toMatchObject({ kind: 'dungeon_bundle', status: 'failed' });
    const retried = await apply(B, zip, p, decisions, requestId);
    expect(retried.status, JSON.stringify(retried.json).slice(0, 800)).toBe(200);
    expect(retried.json.data).toMatchObject({ dungeonKey: 'cp4b_second', dungeonResult: 'created', enabled: false });
  });

  it('a crash after staging leaves a staged journal row whose files the shared recovery removes', async () => {
    const storage = createLocalArtworkStorage(B.managedDir);
    const orphan = `dungeon_background/00000000-0000-4000-8000-00000000cafe/${'a'.repeat(64)}.png`;
    await storage.put(orphan, await solidImage(10, 10));
    await B.w.t.db.insert(enemyPackageImports).values({
      kind: 'dungeon_bundle', requestId: randomUUID(), requestHash: 'x', packageHash: 'x', planHash: 'x', status: 'staged',
      stagedStorageKeys: [orphan], createdAt: new Date(Date.now() - 3_600_000),
    });
    const recovered = await recoverInterruptedImports(B.w.t.db, storage, { now: new Date() });
    expect(recovered).toMatchObject({ abandoned: 1, removedFiles: 1 });
    expect(await storage.exists(orphan)).toBe(false);
  });

  it('two concurrent imports of a new dungeon: one applies, the other is refused as stale; nothing is duplicated', async () => {
    const d = vault('Race');
    await A.w.content.create({ definition: { ...d, key: 'cp4b_race' } }, 'author');
    const raceZip = (await exportOver(A, 'cp4b_race')).zip;
    const decisions = keepAll(await preview(B, raceZip));
    const p = await preview(B, raceZip, decisions);
    const assetsBefore = (await B.w.t.db.select({ n: sql<number>`count(*)::int` }).from(artworkAssets))[0]!.n;
    const results = await Promise.all([1, 2].map(() => apply(B, raceZip, p, decisions)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.json.error.code).toBe('DUNGEON_BUNDLE_STALE');
    expect(await B.w.t.db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, 'cp4b_race'))).toHaveLength(1);
    expect((await B.w.t.db.select({ n: sql<number>`count(*)::int` }).from(artworkAssets))[0]!.n).toBe(assetsBefore);
  });
});

// ── refused exports, hostile bundles and prerequisites ──────────────────────

describe('refusals', () => {
  it('a managed image whose stored file is gone refuses the export, naming where it is used', async () => {
    const [asset] = await A.w.t.db.select().from(artworkAssets).where(eq(artworkAssets.id, hallBackground.id));
    const file = path.join(path.join(A.w.artworkDir, 'managed'), asset!.storageKey);
    const saved = fs.readFileSync(file);
    fs.rmSync(file);
    try {
      const res = await exportOver(A, KEY);
      expect(res.status).toBe(422);
      expect(res.json!.error).toMatchObject({ code: 'DUNGEON_BUNDLE_EXPORT_REFUSED', details: { reason: 'artwork_unavailable' } });
      expect(res.json!.error.details.issues[0].path).toContain('Room “Hall” background');
    } finally {
      fs.writeFileSync(file, saved);
    }
  });

  it('a revision without usable frozen sprite visuals refuses a published export (missing or incompatible snapshot)', async () => {
    const [revision] = await A.w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, KEY)).orderBy(asc(dungeonRevisions.number));
    // A frozen asset whose file is gone: the snapshot no longer matches stored bytes.
    const frozen = Object.values((revision!.sceneSpriteSnapshot as { sprites: Record<string, { assetId: string }> }).sprites)[0]!;
    const [asset] = await A.w.t.db.select().from(artworkAssets).where(eq(artworkAssets.id, frozen.assetId));
    const file = path.join(A.w.artworkDir, 'managed', asset!.storageKey);
    const saved = fs.readFileSync(file);
    fs.rmSync(file);
    try {
      const res = await exportOver(A, KEY, { revision: revision!.number });
      expect(res.status).toBe(422);
      expect(res.json!.error.details.issues[0].message).toMatch(/frozen artwork of Scene Sprite .* no longer readable/);
    } finally {
      fs.writeFileSync(file, saved);
    }
    // A legacy revision with placements but no frozen visuals at all. Revisions are immutable, so the
    // disposable test database's triggers are bypassed for this one write, as data from before 0067 would be.
    const legacy = async (snapshot: unknown) =>
      A.w.t.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.update(dungeonRevisions).set({ sceneSpriteSnapshot: snapshot as never }).where(eq(dungeonRevisions.id, revision!.id));
      });
    await legacy(null);
    try {
      const res = await exportOver(A, KEY, { revision: revision!.number });
      expect(res.status).toBe(422);
      expect(res.json!.error.details.issues[0].message).toMatch(/no usable frozen Scene Sprite visuals/);
    } finally {
      await legacy(revision!.sceneSpriteSnapshot);
    }
  });

  it('the Dungeon JSON package keeps refusing Scene Sprites; only the bundle lifts the gate', async () => {
    await expect(A.w.content.exportPackage(KEY, 'draft', null)).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
    const bundle = await parseDungeonBundle((await exportOver(A, KEY)).zip);
    expect(readDungeonPackage(bundle.pkg).issues).toContainEqual(expect.objectContaining({ code: 'package_scene_sprites_unsupported' }));
    expect(readDungeonPackage(bundle.pkg, { allowSceneSprites: true }).ok).toBe(true);
  });

  it('hostile and malformed bundles are refused before anything is written', async () => {
    const zip = (await exportOver(A, KEY)).zip;
    const before = await tables(B);
    const image = (entries: { name: string }[]) => entries.find((e) => e.name.startsWith('artwork/'))!.name;
    const cases: [string, Buffer, RegExp][] = [
      ['not a zip', Buffer.from('definitely not a zip'), /archive/],
      ['tampered image bytes', rezip(zip, (es) => es.map((e) => (e.name === image(es) ? { ...e, data: Buffer.concat([e.data, Buffer.from([0])]) } : e))), /bytes, not the declared|sha256|not an accepted image/],
      ['missing image', rezip(zip, (es) => es.filter((e) => e.name !== image(es))), /missing from the package/],
      ['undeclared file', rezip(zip, (es) => [...es, { name: 'artwork/extra.png', data: Buffer.from('x') }]), /not declared/],
      ['edited dungeon.json', rezip(zip, (es) => es.map((e) => (e.name === 'dungeon.json' ? { ...e, data: Buffer.from(e.data.toString().replace('CP-4B Vault', 'CP-4B Vault!')) } : e))), /edited after it was exported|content hash/],
      ['sprite definitions removed', rezip(zip, (es) => es.map((e) => {
        if (e.name !== 'manifest.json') return e;
        const m = JSON.parse(e.data.toString());
        m.sceneSprites.sprites = [];
        return { ...e, data: Buffer.from(JSON.stringify(m)) };
      })), /placed sprites/],
      ['traversal entry', rezip(zip, (es) => [...es, { name: '../evil.png', data: Buffer.from('x') }]), /\.\./],
    ];
    for (const [label, body, message] of cases) {
      const res = await upload(B, '/admin/dungeons/import/bundle/preview', body);
      expect(res.status, label).toBe(400);
      expect(res.json.error.code, label).toBe('DUNGEON_BUNDLE_INVALID');
      expect(JSON.stringify(res.json.error.details.issues), label).toMatch(message);
      const applied = await upload(B, `/admin/dungeons/import/bundle/apply?expectedPlanHash=x&requestId=${randomUUID()}&decisions=`, body);
      expect(applied.status, label).toBe(400);
    }
    expect(await tables(B)).toEqual(before);
  });

  it('a species B lacks: the shared pool cannot be created (blocked); a named encounter is an incomplete repair draft', async () => {
    const [base] = await A.w.t.db.select().from(species).where(eq(species.slug, FINITE));
    const { id: _id, ...body } = base!;
    await A.w.t.db.insert(species).values({ ...body, slug: 'cp4b_a_only', name: 'A-only android' });
    // A pool whose body names it.
    await A.pools.create({ key: 'cp4b_a_only_pool', name: 'A only', enabled: true, entries: [{ id: 'x', species: 'cp4b_a_only', weight: 1 }] }, 'author');
    const pooled = { ...vault('Pool needs A-only'), key: 'cp4b_pool_missing', speciesPools: [{ id: 'exclusives', name: 'A only', sharedPoolKey: 'cp4b_a_only_pool', entries: [] }], speciesPolicies: [{ species: 'cp4b_a_only', perPlayerLimit: 1 }] };
    A.w.speciesAccess.set('cp4b_a_only', []);
    await A.w.content.create({ definition: DungeonDefinitionSchema.parse(pooled) }, 'author');
    const blocked = await preview(B, (await exportOver(A, 'cp4b_pool_missing')).zip);
    expect(blocked.readiness).toBe('blocked');
    expect(blocked.issues).toContainEqual(expect.objectContaining({ code: 'shared_pool_species_missing' }));
    expect(blocked.prerequisites).toContainEqual(expect.objectContaining({ kind: 'species', key: 'cp4b_a_only', status: 'missing' }));

    // A named encounter of it: importable only as an explicitly accepted repair draft, which cannot be published.
    const named = DungeonDefinitionSchema.parse({
      ...vault('Named A-only'),
      key: 'cp4b_named_missing',
      speciesPools: [],
      speciesPolicies: [{ species: 'cp4b_a_only', perPlayerLimit: 1 }],
      rooms: vault().rooms.map((r) => ({ ...r, actions: r.actions.map((a) => (a.id === 'meet' ? { ...a, source: { kind: 'species', species: 'cp4b_a_only' } } : a)) })),
    });
    await A.w.content.create({ definition: named }, 'author');
    const namedZip = (await exportOver(A, 'cp4b_named_missing')).zip;
    const decisions = keepAll(await preview(B, namedZip));
    const p = await preview(B, namedZip, decisions);
    expect(p.readiness).toBe('incomplete');
    const before = await tables(B);
    const refused = await apply(B, namedZip, p, decisions);
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('DUNGEON_BUNDLE_REJECTED');
    expect(await tables(B)).toEqual(before);
    const repaired = await apply(B, namedZip, p, { ...decisions, allowIncomplete: true });
    expect(repaired.status, JSON.stringify(repaired.json).slice(0, 800)).toBe(200);
    expect(repaired.json.data).toMatchObject({ readiness: 'incomplete', enabled: false, publishedRevision: null });
    const detail = (await B.w.content.get('cp4b_named_missing'))!;
    await expect(B.w.content.publish('cp4b_named_missing', { expectedRevision: detail.draftRevision }, 'publisher')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
  });
});

// ── minimal content ─────────────────────────────────────────────────────────

describe('a dungeon with no enemies, sprites or pools', () => {
  it('wraps a v1 package with only the members it needs and imports as a disabled draft', async () => {
    showA();
    const plain = DungeonDefinitionSchema.parse({
      key: 'cp4b_plain', name: 'Plain', availableRegions: ['waifu-valley'], entranceRoomId: 'hall',
      settings: { progressionCurrency: CURRENCY, defeatCurrencyRetentionBasisPoints: 2500 },
      rooms: [{ id: 'hall', name: 'Hall', kind: 'exit', actions: [{ id: 'rest', type: 'rest', healBasisPoints: 1000 }] }], connections: [],
    });
    await A.w.content.create({ definition: plain }, 'author');
    const exported = await exportOver(A, 'cp4b_plain');
    expect(exported.status).toBe(200);
    const bundle = await parseDungeonBundle(exported.zip);
    expect(bundle.pkg.schemaVersion).toBe(1);
    expect(bundle.manifest).toMatchObject({ enemies: null, sceneSprites: null, sharedPools: null, artwork: [], assets: [] });
    expect(readZip(exported.zip, { maxArchiveBytes: 1e9, maxEntries: 10, maxExpandedBytes: 1e9, maxCompressionRatio: 1000, maxEntryBytes: () => 1e8 }).map((e) => e.name).sort()).toEqual(['dungeon.json', 'manifest.json']);
    const p = await preview(B, exported.zip);
    expect(p).toMatchObject({ readiness: 'ready', decisionsRequired: [], enemies: [], sceneSprites: [], sharedPools: [], remainsDisabled: [] });
    const res = await apply(B, exported.zip, p);
    expect(res.status, JSON.stringify(res.json).slice(0, 800)).toBe(200);
    expect(res.json.data).toMatchObject({ dungeonResult: 'created', enabled: false, publishedRevision: null, readiness: 'ready', assets: { created: 0 } });
    expect((await B.w.content.get('cp4b_plain'))!.draft).toEqual(plain);
  });
});

// ── HTTP ────────────────────────────────────────────────────────────────────

describe('HTTP', () => {
  it('apply needs enemies.write and artwork.write as well as dungeons.write; preview needs dungeons.write', async () => {
    const zip = (await exportOver(A, KEY)).zip;
    const asDungeonEditor = { cookie: `wm_portal_session=dungeonEditor; wm_portal_csrf=${CSRF}`, 'x-portal-csrf': CSRF };
    const p = await upload(B, '/admin/dungeons/import/bundle/preview', zip, asDungeonEditor);
    expect(p.status).toBe(200);
    const denied = await upload(B, applyUrl(p.json.data, {}), zip, asDungeonEditor);
    expect(denied.status).toBe(403);
    const player = await upload(B, '/admin/dungeons/import/bundle/preview', zip, { cookie: `wm_portal_session=player; wm_portal_csrf=${CSRF}`, 'x-portal-csrf': CSRF });
    expect(player.status).toBe(403);
    const exportDenied = await exportOver(A, KEY, {}, asDungeonEditor);
    expect(exportDenied.status).toBe(403);
  });

  it('an oversize body is a JSON 413 naming the limit, with nothing written; codes are mapped', async () => {
    expect(DUNGEON_BUNDLE_BODY_LIMIT_BYTES).toBe(DUNGEON_BUNDLE_LIMITS.maxArchiveBytes);
    const res = await upload(B, '/admin/dungeons/import/bundle/preview', Buffer.alloc(DUNGEON_BUNDLE_BODY_LIMIT_BYTES + 1));
    expect(res.status).toBe(413);
    for (const code of ['DUNGEON_BUNDLE_INVALID', 'DUNGEON_BUNDLE_EXPORT_REFUSED', 'DUNGEON_BUNDLE_REJECTED', 'DUNGEON_BUNDLE_STALE', 'DUNGEON_BUNDLE_DECISIONS_REQUIRED', 'DUNGEON_BUNDLE_REQUEST_CONFLICT'])
      expect(MAPPED_ERROR_CODES).toContain(code);
  });

  it('documents every bundle route in OpenAPI with a summary, a tag and the shared error responses', async () => {
    const spec = (await (await fetch(`${B.baseUrl}/api/v1/openapi.json`)).json()) as { paths: Record<string, Record<string, { summary?: string; tags?: string[]; responses: object }>> };
    for (const route of ['/api/v1/admin/dungeons/definitions/{key}/export/bundle', '/api/v1/admin/dungeons/import/bundle/preview', '/api/v1/admin/dungeons/import/bundle/apply']) {
      const op = spec.paths[route]?.post;
      expect(op?.summary, route).toBeTruthy();
      expect(op?.tags, route).toContain('Admin — Dungeons');
      for (const status of ['400', '401', '500']) expect(Object.keys(op!.responses), `${route} ${status}`).toContain(status);
    }
  });
});
