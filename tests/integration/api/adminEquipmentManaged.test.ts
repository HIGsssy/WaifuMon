/** E3-E.1: real PostgreSQL services exercised through authenticated Admin routes. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { equipmentAdminEvents, equipmentEvents, playerEquipment } from '../../../src/db/schema';
import { createEquipmentAffixLibraryService } from '../../../src/modules/equipment/equipmentAffixLibraryService';
import { createEquipmentCatalogueService } from '../../../src/modules/equipment/equipmentCatalogueService';
import {
  bootstrapEquipmentRollRules,
  createEquipmentRollRulesService,
  loadShippedCombatBonusFile,
} from '../../../src/modules/equipment/equipmentRollRulesService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../../src/modules/equipment/seed';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import {
  createPortalAuthorizationService,
  type PortalAuthorizationService,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { CONTENT_DIR, bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555991';
const OWNER_ID = '777888999000111551';
const READER_ID = '777888999000111552';
const EDITOR_ID = '777888999000111553';
const PLAYER_ID_DISCORD = '999999999999999991';
const CSRF = 'csrf-token';
const TOKENS: Record<string, string> = {
  owner: OWNER_ID,
  reader: READER_ID,
  editor: EDITOR_ID,
  player: PLAYER_ID_DISCORD,
  publisher: '777888999000111554',
  writer: '777888999000111555',
};

let t: TestDb;
let app: App;
let api: ZodFastify;
let playerId: number;
let managedRules: ReturnType<typeof createEquipmentRollRulesService>;

beforeAll(async () => {
  t = await createTestDb();
  const rollRules = createEquipmentRollRulesService({ db: t.db });
  managedRules = rollRules;
  app = await bootstrapApp(t, { equipmentRollRules: rollRules });
  await bootstrapEquipmentRollRules(t.db, loadShippedCombatBonusFile(CONTENT_DIR));
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  for (const id of Object.values(TOKENS)) await provisionPlayer(app, GUILD_ID, id);
  ({ playerId } = await provisionPlayer(app, GUILD_ID, '555555555555555991'));

  const equipmentCatalogue = createEquipmentCatalogueService({
    db: t.db,
    definitions: app.gear.definitions,
    promotion: app.gear.promotion,
    rollRules,
    getAffixes: app.gear.getAffixes,
    getWorkshopConfig: () => app.content.equipmentWorkshop ?? null,
  });

  const guildOwnership = createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID });
  const ownerOnly = createPortalAuthorizationService({ guildOwnership });
  const granted: Record<string, PortalPermission[]> = {
    [READER_ID]: ['admin.access', 'equipment.read'],
    '777888999000111554': ['equipment.publish'],
    '777888999000111555': ['equipment.write'],
    [EDITOR_ID]: ['admin.access', 'equipment.read', 'equipment.write'],
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
    config: { enabled: true, host: '127.0.0.1', port: 3138, token: TEST_TOKEN, adminBearer: true },
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
      services: {
        ...app,
        equipmentCatalogue,
        equipmentDefinitions: app.gear.definitions,
        equipmentRollRules: rollRules,
        equipmentAffixLibraries: createEquipmentAffixLibraryService({
          db: t.db,
          getLegacyAffixes: app.gear.getAffixes,
        }),
      },
      getContent: () => app.content,
      portalAuthorization,
      adminBearerAllowed: true,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

type Json = Record<string, any>;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    headers: AUTH_BEARER,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const data = async (url: string): Promise<Json> => {
  const res = await call('GET', url);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
};

const ROOT = '/admin/equipment/rarity-rules';
const LIB = '/admin/equipment/affix-libraries';
const rule = () => ({
  bonusCountWeightsBp: [0, 10000, 0, 0],
  families: [
    {
      stat: 'crit_chance_bp',
      enabled: true,
      slots: ['attack', 'defense', 'health'],
      minValue: 500,
      maxValue: 1000,
      step: 25,
    },
  ],
  primarySp: null,
  affixes: { mode: 'none' },
});
const entry = (key = 'e1_test_affix', slots = ['attack', 'defense', 'health']) => ({
  key,
  suffix: `of ${key}`,
  slots,
  enabled: true,
});
async function success(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<Json> {
  const result = await call(method, url, body);
  expect(result.statusCode, result.body).toBe(200);
  return result.json().data;
}
async function saveRules(rules: Json) {
  const current = await data(`${ROOT}/draft`);
  return success('PUT', `${ROOT}/draft`, { rules, expectedDraftRevision: current.draftRevision });
}
async function publishRules() {
  const draft = await data(`${ROOT}/draft`);
  return success('POST', `${ROOT}/publish`, { expectedDraftRevision: draft.draftRevision });
}
const sessionCall = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, csrf = true) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    cookies: { wm_portal_session: token, wm_portal_csrf: CSRF },
    headers: csrf ? { 'x-portal-csrf': CSRF } : {},
    ...(body === undefined ? {} : { payload: body as Json }),
  });

describe('managed equipment permission boundaries', () => {
  it('requires authentication', async () => {
    expect((await api.inject({ method: 'GET', url: `/api/v1${ROOT}/draft` })).statusCode).toBe(401);
  });

  it('does not grant administrative access to the default bearer token', async () => {
    const server = await createPlatformApiServer({
      config: { enabled: true, host: '127.0.0.1', port: 3138, token: TEST_TOKEN },
      logger: createCapturedLogger('silent').logger,
      probes: createProbes(),
      ctx: {
        services: { ...app, equipmentRollRules: managedRules },
        getContent: () => app.content,
        portalAuthorization: createPortalAuthorizationService({
          guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID }),
        }),
      },
    });
    try {
      const result = await server.inject({ method: 'GET', url: `/api/v1${ROOT}/draft`, headers: AUTH_BEARER });
      expect(result.statusCode).toBe(403);
      expect(result.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    } finally {
      await server.close();
    }
  });

  it('enforces read, write and publish independently on every route', async () => {
    const routes: ['GET' | 'POST' | 'PUT', string, string, Json?][] = [
      ['GET', `${ROOT}/published`, 'read'],
      ['GET', `${ROOT}/draft`, 'read'],
      ['GET', `${ROOT}/revisions`, 'read'],
      ['GET', `${ROOT}/export?kind=draft`, 'read'],
      ['POST', `${ROOT}/preview`, 'read', {}],
      ['PUT', `${ROOT}/draft`, 'write', { expectedDraftRevision: 1, rules: {} }],
      ['POST', `${ROOT}/validate`, 'write', {}],
      ['POST', `${ROOT}/import/preview`, 'write', { expectedDraftRevision: 1, file: {} }],
      ['POST', `${ROOT}/import`, 'write', { expectedDraftRevision: 1, file: {} }],
      ['POST', `${ROOT}/publish`, 'publish', { expectedDraftRevision: 1 }],
      ['POST', `${ROOT}/rollback`, 'publish', { expectedDraftRevision: 1, revision: 1 }],
      ['GET', LIB, 'read'],
      ['GET', `${LIB}/missing`, 'read'],
      ['GET', `${LIB}/missing/revisions`, 'read'],
      ['GET', `${LIB}/missing/export?kind=draft`, 'read'],
      ['POST', `${LIB}/missing/preview`, 'read'],
      ['POST', LIB, 'write', { key: 'permission_probe' }],
      ['PUT', `${LIB}/missing/draft`, 'write', { expectedDraftRevision: 1, entries: [] }],
      ['PUT', `${LIB}/missing/meta`, 'write', { expectedDraftRevision: 1, meta: {} }],
      ['PUT', `${LIB}/missing/entries`, 'write', { expectedDraftRevision: 1, entry: {} }],
      ['POST', `${LIB}/missing/validate`, 'write'],
      ['POST', `${LIB}/import`, 'write', { file: {} }],
      ['POST', `${LIB}/missing/publish`, 'publish', { expectedDraftRevision: 1 }],
      ['POST', `${LIB}/missing/rollback`, 'publish', { expectedDraftRevision: 1, revision: 1 }],
    ];
    for (const [method, url, permission, body] of routes) {
      for (const token of [
        'player',
        ...{ read: ['writer', 'publisher'], write: ['reader', 'publisher'], publish: ['reader', 'writer'] }[
          permission
        ]!,
      ]) {
        const res = await sessionCall(token, method, url, body);
        expect(res.statusCode, `${token} ${url}: ${res.body}`).toBe(403);
        expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
      }
    }
  });

  it('requires CSRF for session writes and accepts reader sessions', async () => {
    expect((await sessionCall('reader', 'GET', `${ROOT}/draft`)).statusCode).toBe(200);
    expect((await sessionCall('writer', 'POST', LIB, { key: 'csrf_probe' }, false)).statusCode).toBe(403);
  });
});

describe('rarity-rule lifecycle through the API', () => {
  it('edits only the draft, previews and validates, and leaves grants on published rules', async () => {
    const before = await data(`${ROOT}/published`);
    const draft = await saveRules({ ...before.rules, rarities: { SSR: rule() } });
    expect(draft.dirty).toBe(true);
    expect((await data(`${ROOT}/published`)).rules).toEqual(before.rules);
    const preview = await success('POST', `${ROOT}/preview`, {});
    expect(preview.validation.ok).toBe(true);
    expect(preview.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'rarities.SSR', kind: 'added' })]),
    );
    expect((await success('POST', `${ROOT}/validate`, {})).ok).toBe(true);
    const live = await t.db.transaction((tx) => managedRules.forGrant(tx));
    expect(live.rules).toEqual(before.rules);
    const published = await publishRules();
    expect(published.revision).toBe(2);
    expect(published.rules.rarities.SSR).toEqual(rule());
  });

  it('rejects stale saves, outdated publication and simultaneous publication', async () => {
    const draft = await data(`${ROOT}/draft`);
    const next = { ...draft.rules, flatSpLimits: { perItemMax: 190, perLoadoutMax: 390 } };
    const edits = await Promise.all(
      [1, 2].map(() => call('PUT', `${ROOT}/draft`, { rules: next, expectedDraftRevision: draft.draftRevision })),
    );
    expect(edits.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const stale = edits.find((r) => r.statusCode === 409)!.json();
    expect(stale.error.details).toMatchObject({
      expectedRevision: draft.draftRevision,
      currentRevision: draft.draftRevision + 1,
    });
    expect((await call('POST', `${ROOT}/publish`, { expectedDraftRevision: draft.draftRevision })).statusCode).toBe(
      409,
    );
    const result = await Promise.all(
      [1, 2].map(() => call('POST', `${ROOT}/publish`, { expectedDraftRevision: draft.draftRevision + 1 })),
    );
    expect(result.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await data(`${ROOT}/revisions`)).length).toBe(3);
  });

  it('reports invalid probabilities, ranges, unsupported rarities and missing libraries; refuses publication atomically', async () => {
    const current = await data(`${ROOT}/draft`);
    const scenarios = [
      { SSR: { ...rule(), bonusCountWeightsBp: [0, 9000, 0, 0] } },
      { SSR: { ...rule(), families: [{ ...rule().families[0], minValue: 1001, maxValue: 500 }] } },
      { N: rule() },
      { EX: rule() },
      { SSR: { ...rule(), affixes: { mode: 'library', library: 'missing_library' } } },
    ];
    for (const rarities of scenarios) {
      const validation = await success('POST', `${ROOT}/validate`, { rules: { ...current.rules, rarities } });
      expect(validation.ok).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    }
    const before = await data(`${ROOT}/published`);
    const invalid = await saveRules({ ...current.rules, rarities: scenarios[0] });
    const refused = await call('POST', `${ROOT}/publish`, { expectedDraftRevision: invalid.draftRevision });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details.issues.length).toBeGreaterThan(0);
    expect(await data(`${ROOT}/published`)).toEqual(before);
    await saveRules(before.rules);
  });

  it('refuses changes to legacy rules on save and import', async () => {
    const draft = await data(`${ROOT}/draft`);
    const altered = structuredClone(draft.rules);
    altered.legacy.rarityRules.N.bonusChanceBp++;
    expect(
      (await call('PUT', `${ROOT}/draft`, { rules: altered, expectedDraftRevision: draft.draftRevision })).statusCode,
    ).toBe(400);
    const file = await data(`${ROOT}/export?kind=draft`);
    expect(
      (
        await call('POST', `${ROOT}/import`, {
          file: { ...file, config: altered },
          expectedDraftRevision: draft.draftRevision,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('exports explicit draft/published kinds, previews imports without saving and imports only into a fresh draft', async () => {
    const draft = await data(`${ROOT}/draft`);
    const file = await data(`${ROOT}/export?kind=published`);
    expect(file).toMatchObject({ kind: 'published', format: 'waifumon-equipment-roll-config-export', version: 1 });
    file.config.flatSpLimits.perItemMax = 180;
    const preview = await success('POST', `${ROOT}/import/preview`, {
      file,
      expectedDraftRevision: draft.draftRevision,
    });
    expect(preview.handEdited).toBe(true);
    expect(await data(`${ROOT}/draft`)).toEqual(draft);
    const imported = await success('POST', `${ROOT}/import`, { file, expectedDraftRevision: draft.draftRevision });
    expect(imported.dirty).toBe(true);
    expect((await data(`${ROOT}/published`)).rules.flatSpLimits.perItemMax).toBe(190);
    expect((await data(`${ROOT}/export?kind=draft`)).kind).toBe('draft');
    expect(
      (await call('POST', `${ROOT}/import`, { file, expectedDraftRevision: draft.draftRevision })).statusCode,
    ).toBe(409);
    expect(
      (await call('POST', `${ROOT}/import/preview`, { file, expectedDraftRevision: draft.draftRevision })).statusCode,
    ).toBe(409);
    expect(
      (await call('POST', `${ROOT}/import`, { file: {}, expectedDraftRevision: imported.draftRevision })).statusCode,
    ).toBe(400);
    expect((await call('GET', `${ROOT}/export`)).statusCode).toBe(400);
  });

  it('rolls back as a new auditable immutable revision', async () => {
    const draft = await data(`${ROOT}/draft`);
    const rolled = await success('POST', `${ROOT}/rollback`, {
      revision: 2,
      expectedDraftRevision: draft.draftRevision,
    });
    expect(rolled).toMatchObject({ source: 'rollback', revision: 4 });
    const history = await data(`${ROOT}/revisions`);
    expect(history[0]).toMatchObject({ rolledBackFrom: 2, current: true });
    expect(history[history.length - 1].revision).toBe(1);
    const events = await t.db.select().from(equipmentAdminEvents);
    expect(events.some((e) => e.action === 'rolled_back' && e.subjectKind === 'roll_rules')).toBe(true);
    await expect(
      t.pool.query('UPDATE equipment_roll_config_revisions SET number = 99 WHERE number = 1'),
    ).rejects.toMatchObject({ code: '23001' });
  });
});

describe('affix libraries through the API', () => {
  it('lists and reads immutable N/R/SR libraries and refuses reserved keys', async () => {
    const list = await data(LIB);
    expect(list.legacy.map((l: Json) => l.rarity)).toEqual(['N', 'R', 'SR']);
    for (const lib of list.legacy) {
      expect(lib.readOnly).toBe(true);
      expect((await data(`${LIB}/${lib.key}`)).entries).toEqual(lib.entries);
      expect((await call('PUT', `${LIB}/${lib.key}/draft`, { expectedDraftRevision: 1, entries: [] })).statusCode).toBe(
        404,
      );
    }
    expect((await call('POST', LIB, { key: 'legacy_n' })).statusCode).toBe(400);
  });

  it('creates, edits metadata and slot-specific entries, previews and publishes', async () => {
    const created = await sessionCall('writer', 'POST', LIB, { key: 'api_library', name: 'Test library' });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().data).toMatchObject({ publishedRevision: null, draftRevision: 1 });
    expect(
      (await t.db.select().from(equipmentAdminEvents)).some(
        (e) => e.subjectKey === 'api_library' && e.actor === TOKENS.writer,
      ),
    ).toBe(true);
    await success('PUT', `${LIB}/api_library/meta`, {
      expectedDraftRevision: 1,
      meta: { name: 'Renamed', description: 'test' },
    });
    await success('PUT', `${LIB}/api_library/draft`, {
      expectedDraftRevision: 2,
      entries: [entry('e1_attack', ['attack']), entry('e1_other', ['defense', 'health'])],
    });
    const draft = await success('PUT', `${LIB}/api_library/entries`, {
      expectedDraftRevision: 3,
      entry: { ...entry('e1_attack', ['attack']), enabled: false },
    });
    expect(draft.draftEntries[0].enabled).toBe(false);
    expect(draft.publishedEntries).toEqual([]);
    expect((await success('POST', `${LIB}/api_library/validate`)).ok).toBe(true);
    expect((await success('POST', `${LIB}/api_library/preview`)).changes.length).toBeGreaterThan(0);
    await success('PUT', `${LIB}/api_library/entries`, {
      expectedDraftRevision: 4,
      entry: entry('e1_attack', ['attack']),
    });
    const result = await sessionCall('publisher', 'POST', `${LIB}/api_library/publish`, { expectedDraftRevision: 5 });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toMatchObject({ publishedRevision: 1, dirty: false });
    expect((await call('POST', `${LIB}/api_library/publish`, { expectedDraftRevision: 4 })).statusCode).toBe(409);
  });

  it('assigns a shared published library to SSR and UR; rejects publication that removes a required slot', async () => {
    const draft = await data(`${ROOT}/draft`);
    const shared = { ...rule(), affixes: { mode: 'library', library: 'api_library' } };
    await saveRules({ ...draft.rules, rarities: { SSR: shared, UR: shared } });
    await publishRules();
    const library = await data(`${LIB}/api_library`);
    expect(library.assignedTo).toEqual(['SSR', 'UR']);
    await success('PUT', `${LIB}/api_library/entries`, {
      expectedDraftRevision: library.draftRevision,
      entry: { ...entry('e1_attack', ['attack']), enabled: false },
    });
    expect((await success('POST', `${LIB}/api_library/validate`)).ok).toBe(false);
    expect(
      (await call('POST', `${LIB}/api_library/publish`, { expectedDraftRevision: library.draftRevision + 1 }))
        .statusCode,
    ).toBe(400);
    expect((await data(`${LIB}/api_library`)).publishedEntries[0].enabled).toBe(true);
  });

  it('imports/exports drafts, checks revisions and namespaces, and rolls back with history', async () => {
    const library = await data(`${LIB}/api_library`);
    const file = await data(`${LIB}/api_library/export?kind=published`);
    expect(file.kind).toBe('published');
    const imported = await success('POST', `${LIB}/import`, { file, expectedDraftRevision: library.draftRevision });
    expect(imported.draftEntries).toEqual(file.affixes);
    expect((await call('POST', `${LIB}/import`, { file })).statusCode).toBe(409);
    expect(
      (await call('POST', `${LIB}/import`, { file, expectedDraftRevision: library.draftRevision })).statusCode,
    ).toBe(409);
    expect((await data(`${LIB}/api_library/export?kind=draft`)).kind).toBe('draft');
    const edited = await success('PUT', `${LIB}/api_library/meta`, {
      expectedDraftRevision: imported.draftRevision,
      meta: { name: 'Second revision', description: '' },
    });
    const pubs = await Promise.all(
      [1, 2].map(() => call('POST', `${LIB}/api_library/publish`, { expectedDraftRevision: edited.draftRevision })),
    );
    expect(pubs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const rolled = await success('POST', `${LIB}/api_library/rollback`, {
      revision: 1,
      expectedDraftRevision: edited.draftRevision,
    });
    expect(rolled).toMatchObject({ publishedRevision: 3, name: 'Renamed' });
    const history = await data(`${LIB}/api_library/revisions`);
    expect(history[0]).toMatchObject({ source: 'rollback', rolledBackFrom: 1, current: true });
    const collision = { ...file, library: { ...file.library, key: 'collision_library' } };
    expect((await call('POST', `${LIB}/import`, { file: collision })).statusCode).toBe(400);
    expect((await data(LIB)).managed.some((l: Json) => l.key === 'collision_library')).toBe(false);
    const fresh = {
      ...collision,
      library: { ...collision.library, key: 'fresh_import' },
      affixes: [entry('fresh_import_affix')],
    };
    expect((await success('POST', `${LIB}/import`, { file: fresh })).publishedRevision).toBeNull();
    expect(
      (
        await call('POST', `${LIB}/import`, {
          file: { ...fresh, library: { ...fresh.library, key: 'stale_new' } },
          expectedDraftRevision: 12,
        })
      ).statusCode,
    ).toBe(404);
    expect((await data(LIB)).managed.some((l: Json) => l.key === 'stale_new')).toBe(false);
    await expect(
      t.pool.query('DELETE FROM equipment_affix_library_revisions WHERE library_key = $1', ['api_library']),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('does not write player inventory or equipment grant events', async () => {
    expect(await t.db.select().from(playerEquipment)).toEqual([]);
    expect(await t.db.select().from(equipmentEvents)).toEqual([]);
    const events = await t.db.select().from(equipmentAdminEvents);
    for (const action of ['created', 'draft_saved', 'draft_imported', 'published', 'rolled_back']) {
      expect(events.some((e) => e.subjectKind === 'affix_library' && e.action === action)).toBe(true);
    }
  });

  it('keeps live seeded high-rarity rolls on published content and preserves owned copies after publication', async () => {
    await success('POST', '/admin/equipment/definitions', {
      definition: {
        key: 'e1_roll_probe',
        name: 'Roll probe',
        rarity: 'SSR',
        slot: 'attack',
        multiplierMinBp: 11000,
        multiplierMaxBp: 13000,
        multiplierStepBp: 500,
        primarySpEligible: true,
      },
    });
    await success('PUT', '/admin/equipment/definitions/e1_roll_probe/enabled', { expectedRevision: 1, enabled: true });
    const grant = () =>
      t.db.transaction((tx) =>
        app.gear.equipment.grantEquipment(tx, {
          playerId,
          definitionKey: 'e1_roll_probe',
          source: { type: 'admin' },
          rollSeed: 12345,
        }),
      );
    await grant();
    const owned = await t.db.select().from(playerEquipment);
    const current = await data(`${ROOT}/draft`);
    current.rules.rarities.SSR.primarySp = { chanceBp: 10000, min: 10, max: 10, step: 1 };
    await saveRules(current.rules);
    const library = await data(`${LIB}/api_library`);
    await success('PUT', `${LIB}/api_library/entries`, {
      expectedDraftRevision: library.draftRevision,
      entry: { ...library.draftEntries[0], suffix: 'of an unpublished change' },
    });
    await grant();
    const after = await t.db.select().from(playerEquipment);
    const values = (row: (typeof after)[number]) => ({
      multiplier: row.rolledMultiplierBp,
      bonuses: row.combatBonuses,
      affix: row.affixKey,
      properties: row.rolledProperties,
    });
    expect(values(after[1]!)).toEqual(values(owned[0]!));
    expect(after[0]).toEqual(owned[0]);
    await publishRules();
    expect(await t.db.select().from(playerEquipment)).toEqual(after);
    await grant();
    const live = await t.db.select().from(playerEquipment);
    expect(live[2]!.rolledProperties.flatSp).toBe(10);
    expect(live.slice(0, 2)).toEqual(after);
  });
});
