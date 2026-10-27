/**
 * The Admin Equipment Catalogue (Equipment 3.0, E3-D) over the Admin API,
 * against a real database seeded from the shipped content and real published
 * roll rules: listing, authoring, locks, revisions, enable/disable impact,
 * duplicate, roll previews, export, import, history, artwork and who may do
 * any of it.
 *
 * Every high-rarity definition here is test-only data; nothing is published
 * for SSR/UR/LR, so they are authorable but never rollable or rewardable.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { equipmentAdminEvents, equipmentDefinitions, equipmentEvents, equipmentImportLog, playerEquipment } from '../../../src/db/schema';
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
const TOKENS: Record<string, string> = { owner: OWNER_ID, reader: READER_ID, editor: EDITOR_ID, player: PLAYER_ID_DISCORD };

let t: TestDb;
let app: App;
let api: ZodFastify;
let playerId: number;

beforeAll(async () => {
  t = await createTestDb();
  const rollRules = createEquipmentRollRulesService({ db: t.db });
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
      services: { ...app, equipmentCatalogue, equipmentDefinitions: app.gear.definitions },
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
const detail = (key: string) => data(`/admin/equipment/definitions/${key}`);
const gear = (key: string, rarity: string, over: Json = {}) => ({
  key,
  name: key.replace(/_/g, ' '),
  slot: 'attack',
  rarity,
  multiplierMinBp: ['N', 'R', 'SR'].includes(rarity) ? 4_000 : 11_000,
  multiplierMaxBp: ['N', 'R', 'SR'].includes(rarity) ? 6_000 : 13_000,
  multiplierStepBp: 500,
  ...over,
});
/** The editable fields of a detail, as a PUT body expects. */
const authoring = (d: Json) => {
  const { revision: _r, createdAt: _c, updatedAt: _u, updatedBy: _b, ownedCount: _o, instanceCount: _i, ...input } = d.definition;
  return input;
};
async function save(key: string, change: Json, revision?: number) {
  const current = await detail(key);
  return call('PUT', `/admin/equipment/definitions/${key}`, {
    definition: { ...authoring(current), ...change },
    expectedRevision: revision ?? current.definition.revision,
  });
}
const events = (key: string) =>
  t.db.select().from(equipmentAdminEvents).where(eq(equipmentAdminEvents.subjectKey, key)).orderBy(asc(equipmentAdminEvents.id));
const ownedState = async () => ({
  copies: (await t.db.select({ n: sql<number>`count(*)::int` }).from(playerEquipment))[0]!.n,
  events: (await t.db.select({ n: sql<number>`count(*)::int` }).from(equipmentEvents))[0]!.n,
});
const grantFixed = (key: string, multiplier: number) =>
  t.db.transaction((tx) =>
    app.gear.equipment.grantEquipment(tx, {
      playerId,
      definitionKey: key,
      source: { type: 'admin' },
      allowDisabled: true,
      roll: { kind: 'fixed', rolledMultiplierBp: multiplier, affixKey: null },
    }),
  );

// ── listing ─────────────────────────────────────────────────────────────────

describe('the catalogue list', () => {
  it('lists every seeded definition with counts per rarity and status', async () => {
    const page = await data('/admin/equipment/definitions?pageSize=100');
    expect(page.total).toBe(30);
    expect(page.counts).toMatchObject({ total: 30, enabled: 30, disabled: 0 });
    expect(page.counts.byRarity).toEqual({ N: 18, R: 9, SR: 3, SSR: 0, UR: 0, LR: 0 });
    expect(page.definitions[0]).toMatchObject({ revision: 1, primarySpEligible: false, maxAdditionalBonuses: null, ownedCount: 0 });
  });

  it('searches key, name and description; filters by rarity, slot and status; sorts and pages', async () => {
    expect((await data('/admin/equipment/definitions?q=rusty_pipe')).definitions.map((d: Json) => d.key)).toEqual(['rusty_pipe']);
    const byName = await data('/admin/equipment/definitions?q=Rusty');
    expect(byName.definitions.some((d: Json) => d.key === 'rusty_pipe')).toBe(true);
    const [withDescription] = (await data('/admin/equipment/definitions?pageSize=100')).definitions.filter((d: Json) => d.description.length > 12);
    const word = withDescription.description.split(' ').find((w: string) => w.length > 6)!;
    expect((await data(`/admin/equipment/definitions?q=${encodeURIComponent(word)}`)).definitions.length).toBeGreaterThan(0);

    const sr = await data('/admin/equipment/definitions?rarity=SR');
    expect(sr.total).toBe(3);
    expect(sr.definitions.every((d: Json) => d.rarity === 'SR')).toBe(true);
    const defense = await data('/admin/equipment/definitions?slot=defense&pageSize=100');
    expect(defense.definitions.every((d: Json) => d.slot === 'defense')).toBe(true);
    expect((await data('/admin/equipment/definitions?status=disabled')).total).toBe(0);

    const byRarityDesc = await data('/admin/equipment/definitions?sort=rarity&direction=desc&pageSize=3');
    expect(byRarityDesc.definitions.map((d: Json) => d.rarity)).toEqual(['SR', 'SR', 'SR']);
    const p1 = await data('/admin/equipment/definitions?pageSize=10&page=1');
    const p3 = await data('/admin/equipment/definitions?pageSize=10&page=3');
    expect(p1.definitions).toHaveLength(10);
    expect(p3.definitions).toHaveLength(10);
    expect(p1.definitions[0].key).not.toBe(p3.definitions[0].key);
  });

  it('refuses an unknown rarity filter', async () => {
    expect((await call('GET', '/admin/equipment/definitions?rarity=EX')).statusCode).toBe(400);
  });
});

// ── authoring ───────────────────────────────────────────────────────────────

describe('manual authoring', () => {
  it('creates every rarity, always disabled — the request cannot switch it on', async () => {
    for (const rarity of ['N', 'R', 'SR', 'SSR', 'UR', 'LR']) {
      const key = `t_made_${rarity.toLowerCase()}`;
      const res = await call('POST', '/admin/equipment/definitions', { definition: gear(key, rarity, { enabled: true }) });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.definition).toMatchObject({ key, rarity, enabled: false, revision: 1 });
    }
    const [created] = await events('t_made_ssr');
    expect(created).toMatchObject({ subjectKind: 'definition', action: 'created', actor: null });
  });

  it('stores the high-rarity roll policy and explains that it is unconfigured', async () => {
    const res = await call('POST', '/admin/equipment/definitions', {
      definition: gear('t_relic', 'SSR', { primarySpEligible: true, maxAdditionalBonuses: 2 }),
    });
    const body = res.json().data;
    expect(body.definition).toMatchObject({ primarySpEligible: true, maxAdditionalBonuses: 2 });
    expect(body.roll).toMatchObject({ mode: 'high', configured: false, rollable: false });
    expect(body.availability).toMatchObject({ rollConfiguration: 'unconfigured', rollable: false, rewardRarity: false });
  });

  it('refuses a roll policy on N/R/SR with per-field issues', async () => {
    const res = await call('POST', '/admin/equipment/definitions', { definition: gear('t_bad_n', 'N', { primarySpEligible: true, maxAdditionalBonuses: 1 }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EQUIPMENT_INVALID');
    expect(res.json().error.details.issues.map((i: Json) => i.path).sort()).toEqual(['maxAdditionalBonuses', 'primarySpEligible']);
  });

  it('refuses a taken key, and validates without writing', async () => {
    const taken = await call('POST', '/admin/equipment/definitions', { definition: gear('rusty_pipe', 'N') });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('EQUIPMENT_KEY_TAKEN');
    const dry = await call('POST', '/admin/equipment/definitions/validate', { definition: gear('rusty_pipe', 'N'), creating: true });
    expect(dry.json().data.issues).toEqual([expect.objectContaining({ path: 'key' })]);
    const fine = await call('POST', '/admin/equipment/definitions/validate', { definition: gear('t_dry_run', 'UR'), creating: true });
    expect(fine.json().data.issues).toEqual([]);
    expect((await call('GET', '/admin/equipment/definitions/t_dry_run')).statusCode).toBe(404);
  });

  it('a save names its revision; a stale one is refused with who saved first, and nothing changes', async () => {
    const ok = await save('t_made_r', { name: 'Renamed Ring' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.definition).toMatchObject({ name: 'Renamed Ring', revision: 2 });
    const stale = await save('t_made_r', { name: 'Lost Update' }, 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('EQUIPMENT_DEFINITION_STALE');
    expect(stale.json().error.details).toMatchObject({ expectedRevision: 1, currentRevision: 2 });
    expect((await detail('t_made_r')).definition.name).toBe('Renamed Ring');
    const updated = (await events('t_made_r')).find((e) => e.action === 'updated')!;
    expect(updated.details).toMatchObject({ revision: 2, previousRevision: 1, changedFields: ['name'] });
  });

  it('an edit keeps the enabled state; keys never change', async () => {
    const res = await save('t_made_n', { enabled: true });
    expect(res.json().data.definition.enabled).toBe(false);
    const renamed = await save('t_made_n', { key: 't_other' });
    expect(renamed.statusCode).toBe(400);
  });

  it('slot and rarity lock once any copy exists; roll-policy edits leave owned copies untouched', async () => {
    const { instances } = await grantFixed('t_made_ur', 11_000);
    const owned = (await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, instances[0]!.id)))[0]!;
    const current = await detail('t_made_ur');
    expect(current.locks).toEqual({ slotLocked: true, rarityLocked: true, instanceCount: 1 });
    expect((await save('t_made_ur', { rarity: 'LR' })).json().error.code).toBe('EQUIPMENT_RARITY_LOCKED');
    expect((await save('t_made_ur', { slot: 'defense' })).json().error.code).toBe('EQUIPMENT_SLOT_LOCKED');
    expect((await save('t_made_ur', { maxAdditionalBonuses: 1, primarySpEligible: true })).statusCode).toBe(200);
    expect((await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, owned.id)))[0]).toEqual(owned);
  });
});

// ── enable / disable ────────────────────────────────────────────────────────

describe('enabling and disabling', () => {
  it('names the automatic reward sources N/R/SR gear would join, from the live selectors', async () => {
    const impact = await data('/admin/equipment/definitions/t_made_n/impact');
    expect(impact.rewardRarity).toBe(true);
    expect(impact.automatic).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'workshop_recipe', key: 'standard_rebuild', when: 'immediately' })]),
    );
    // The R recipe would never pay N gear.
    expect(impact.automatic.some((e: Json) => e.key === 'improved_rebuild')).toBe(false);
  });

  it('refuses to enable such gear until the impact is acknowledged, then enables and audits', async () => {
    const d = await detail('t_made_n');
    const refused = await call('PUT', '/admin/equipment/definitions/t_made_n/enabled', { enabled: true, expectedRevision: d.definition.revision });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('EQUIPMENT_ENABLE_CONFIRMATION_REQUIRED');
    expect(refused.json().error.details.impact.length).toBeGreaterThan(0);
    expect((await detail('t_made_n')).definition.enabled).toBe(false);

    const ok = await call('PUT', '/admin/equipment/definitions/t_made_n/enabled', {
      enabled: true,
      expectedRevision: d.definition.revision,
      acknowledgeRewardImpact: true,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.definition).toMatchObject({ enabled: true, revision: d.definition.revision + 1 });
    expect((await events('t_made_n')).map((e) => e.action)).toContain('enabled');
    const off = await call('PUT', '/admin/equipment/definitions/t_made_n/enabled', { enabled: false, expectedRevision: d.definition.revision + 1 });
    expect(off.json().data.definition.enabled).toBe(false);
  });

  it('enables SSR/UR/LR without a reward warning — and says it is still not obtainable', async () => {
    expect((await data('/admin/equipment/definitions/t_made_lr/impact')).automatic).toEqual([]);
    const d = await detail('t_made_lr');
    const ok = await call('PUT', '/admin/equipment/definitions/t_made_lr/enabled', { enabled: true, expectedRevision: d.definition.revision });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.availability).toMatchObject({ enabled: true, rollConfiguration: 'unconfigured', rollable: false });
    // No existing selector reaches it.
    const eligible = await t.db.transaction((tx) => app.equipmentRewards.eligibleDefinitions(tx, {}));
    expect(eligible.some((e) => e.key === 't_made_lr')).toBe(false);
    expect(new Set(eligible.map((e) => e.rarity))).toEqual(new Set(['N', 'R', 'SR']));
  });

  it('a stale toggle is refused', async () => {
    const res = await call('PUT', '/admin/equipment/definitions/t_made_lr/enabled', { enabled: false, expectedRevision: 1 });
    expect(res.json().error.code).toBe('EQUIPMENT_DEFINITION_STALE');
  });
});

// ── duplicate ───────────────────────────────────────────────────────────────

describe('duplicating', () => {
  it('copies authoring fields only, under a new key, disabled, through the create path', async () => {
    const before = await ownedState();
    const res = await call('POST', '/admin/equipment/definitions/t_made_ur/duplicate', { key: 't_made_ur_copy' });
    expect(res.statusCode, res.body).toBe(200);
    const copy = res.json().data.definition;
    const source = (await detail('t_made_ur')).definition;
    expect(copy).toMatchObject({
      key: 't_made_ur_copy',
      name: `${source.name} (copy)`,
      rarity: 'UR',
      maxAdditionalBonuses: source.maxAdditionalBonuses,
      primarySpEligible: source.primarySpEligible,
      enabled: false,
      ownedCount: 0,
      instanceCount: 0,
      revision: 1,
    });
    expect(await ownedState()).toEqual(before);
    const [event] = await events('t_made_ur_copy');
    expect(event).toMatchObject({ action: 'duplicated', details: expect.objectContaining({ duplicatedFrom: 't_made_ur' }) });
    expect((await call('POST', '/admin/equipment/definitions/t_made_ur/duplicate', { key: 't_made_ur_copy' })).json().error.code).toBe('EQUIPMENT_KEY_TAKEN');
    expect((await call('POST', '/admin/equipment/definitions/t_made_ur/duplicate', { key: 'Bad Key' })).statusCode).toBe(400);
  });
});

// ── roll previews ───────────────────────────────────────────────────────────

describe('roll previews', () => {
  it('N/R/SR show the legacy rule read-only; seeded samples repeat; nothing is granted or logged', async () => {
    const before = await ownedState();
    const first = (await call('POST', '/admin/equipment/roll-preview', { key: 'combat_knife', seed: 42, count: 5 })).json().data;
    const again = (await call('POST', '/admin/equipment/roll-preview', { key: 'combat_knife', seed: 42, count: 5 })).json().data;
    expect(first.analysis).toMatchObject({ mode: 'legacy', rarity: 'R', bonusChanceBp: 10_000, bonusCount: 1 });
    expect(first.analysis.families.length).toBeGreaterThan(0);
    expect(first.samples).toHaveLength(5);
    expect(again.samples).toEqual(first.samples);
    expect(first.samples.every((s: Json) => s.combatBonuses.length === 1)).toBe(true);
    expect(await ownedState()).toEqual(before);
  });

  it('previews an unsaved definition, and an unconfigured SSR explains why it cannot sample', async () => {
    const res = (await call('POST', '/admin/equipment/roll-preview', { definition: gear('t_unsaved', 'SSR', { primarySpEligible: true }), seed: 1 })).json().data;
    expect(res.analysis).toMatchObject({ mode: 'high', configured: false, rollable: false, primarySpEligible: true });
    expect(res.analysis.issues.some((i: Json) => /configure no SSR/.test(i.message))).toBe(true);
    expect(res.samples).toBeNull();
    expect(res.sampleError).toMatch(/cannot be rolled/);
    expect((await call('POST', '/admin/equipment/roll-preview', {})).statusCode).toBe(400);
  });
});

// ── export / import ─────────────────────────────────────────────────────────

describe('export and import', () => {
  it('exports v3 — everything, named keys, or a filter — with definitions only', async () => {
    const all = await data('/admin/equipment/export');
    expect(all).toMatchObject({ format: 'waifumon-equipment', version: 3 });
    expect(all.definitions.length).toBeGreaterThan(30);
    expect(Object.keys(all.definitions[0]).sort()).not.toContain('revision');
    expect((await data('/admin/equipment/export?keys=rusty_pipe,t_relic')).definitions.map((d: Json) => d.key)).toEqual(['rusty_pipe', 't_relic']);
    const sr = await data('/admin/equipment/export?rarity=SR');
    expect(sr.definitions.every((d: Json) => d.rarity === 'SR')).toBe(true);
  });

  it('a round trip previews as unchanged', async () => {
    const all = await data('/admin/equipment/export');
    const preview = (await call('POST', '/admin/equipment/import/preview', { package: all })).json().data;
    expect(preview.counts.create + preview.counts.update).toBe(0);
    expect(preview.ok).toBe(true);
  });

  it('previews creates and updates, overrides status, flags reward impact, and applies atomically — all disabled', async () => {
    const pkg = {
      format: 'waifumon-equipment',
      version: 3,
      label: 'api test',
      definitions: [
        gear('t_imp_n', 'N', { enabled: true }),
        gear('t_imp_lr', 'LR', { enabled: true, primarySpEligible: true }),
        { ...authoring(await detail('t_made_sr')), name: 'Imported Name', enabled: true },
      ],
    };
    const res = await call('POST', '/admin/equipment/import/preview', { package: pkg });
    expect(res.statusCode, res.body).toBe(200);
    const preview = res.json().data;
    expect(preview.counts).toEqual({ create: 2, update: 1, unchanged: 0 });
    expect(preview.entries.find((e: Json) => e.key === 't_made_sr').changedFields).toEqual(['name']);
    expect(preview.statusNotes).toEqual(
      expect.arrayContaining([
        { key: 't_imp_n', packageEnabled: true, enabled: false, reason: 'new_definitions_start_disabled' },
        { key: 't_made_sr', packageEnabled: true, enabled: false, reason: 'existing_status_kept' },
      ]),
    );
    expect(preview.rewardImpact.map((r: Json) => r.key)).toEqual(['t_imp_n']);
    expect((await call('GET', '/admin/equipment/definitions/t_imp_n')).statusCode).toBe(404);

    const applied = await call('POST', '/admin/equipment/import/apply', { package: pkg, expectedPlanHash: preview.planHash, sourceFilename: 'batch.json' });
    expect(applied.statusCode, applied.body).toBe(200);
    expect((await detail('t_imp_n')).definition.enabled).toBe(false);
    expect((await detail('t_imp_lr')).definition).toMatchObject({ enabled: false, primarySpEligible: true });
    expect((await detail('t_made_sr')).definition).toMatchObject({ name: 'Imported Name', enabled: false, revision: 2 });
    const [log] = await t.db.select().from(equipmentImportLog).where(eq(equipmentImportLog.id, applied.json().data.logId));
    expect(log).toMatchObject({ packageVersion: 3, sourceFilename: 'batch.json', createdCount: 2, updatedCount: 1 });
    expect((await events('t_imp_n')).map((e) => e.action)).toEqual(['imported']);
  });

  it('refuses a stale preview: an edit between preview and apply applies nothing', async () => {
    const pkg = { format: 'waifumon-equipment', version: 3, definitions: [gear('t_stale_new', 'R'), { ...authoring(await detail('t_relic')), name: 'Import Edit' }] };
    const preview = (await call('POST', '/admin/equipment/import/preview', { package: pkg })).json().data;
    expect((await save('t_relic', { description: 'someone else' })).statusCode).toBe(200);
    const stale = await call('POST', '/admin/equipment/import/apply', { package: pkg, expectedPlanHash: preview.planHash });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('EQUIPMENT_IMPORT_STALE');
    expect((await call('GET', '/admin/equipment/definitions/t_stale_new')).statusCode).toBe(404);
    expect((await detail('t_relic')).definition.name).not.toBe('Import Edit');
  });

  it('refuses the whole package for one locked change, naming it — and creates nothing', async () => {
    const pkg = {
      format: 'waifumon-equipment',
      version: 3,
      definitions: [gear('t_atomic_new', 'N'), { ...authoring(await detail('t_made_ur')), rarity: 'SSR' }],
    };
    const preview = (await call('POST', '/admin/equipment/import/preview', { package: pkg })).json().data;
    expect(preview.ok).toBe(false);
    expect(preview.issues).toEqual([expect.objectContaining({ path: 'definitions[1].rarity' })]);
    const res = await call('POST', '/admin/equipment/import/apply', { package: pkg, expectedPlanHash: preview.planHash });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EQUIPMENT_IMPORT_REJECTED');
    expect((await call('GET', '/admin/equipment/definitions/t_atomic_new')).statusCode).toBe(404);
  });

  it('reads package v2, and reports an invalid entry by path', async () => {
    const v2 = { format: 'waifumon-equipment', version: 2, definitions: [gear('t_v2_entry', 'SR', { enabled: true })] };
    const preview = (await call('POST', '/admin/equipment/import/preview', { package: v2 })).json().data;
    expect(preview.counts.create).toBe(1);
    expect((await call('POST', '/admin/equipment/import/apply', { package: v2, expectedPlanHash: preview.planHash })).statusCode).toBe(200);
    expect((await detail('t_v2_entry')).definition.enabled).toBe(false);
    const bad = await call('POST', '/admin/equipment/import/preview', { package: { ...v2, definitions: [gear('t_bad', 'SR', { multiplierStepBp: 300 })] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.issues[0].path).toBe('definitions[0].multiplierStepBp');
  });

  it('history lists definition events and imports, newest first', async () => {
    const history = await data('/admin/equipment/history?key=t_made_sr');
    expect(history.events.map((e: Json) => e.action)).toEqual(['imported', 'created']);
    expect(history.imports[0].definitionKeys).toContain('t_made_sr');
  });
});

// ── artwork ─────────────────────────────────────────────────────────────────

describe('artwork', () => {
  it('browses only the equipment folder, which may be empty, and refuses another area', async () => {
    const res = await call('GET', '/admin/equipment/artwork/browse');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.files).toEqual([]);
    expect((await call('GET', '/admin/equipment/artwork?path=bosses/x.png')).statusCode).toBe(400);
    expect((await call('GET', '/admin/equipment/artwork/browse?path=bosses')).statusCode).toBe(400);
    expect((await call('GET', '/admin/equipment/artwork?path=equipment/missing.webp')).statusCode).toBe(404);
  });
});

// ── permissions ─────────────────────────────────────────────────────────────

describe('permissions', () => {
  const as = (token: string, withCsrf = true) => ({
    cookies: { wm_portal_session: token, wm_portal_csrf: CSRF },
    headers: withCsrf ? { 'x-portal-csrf': CSRF } : {},
  });
  const READS = ['/admin/equipment/definitions', '/admin/equipment/definitions/rusty_pipe', '/admin/equipment/definitions/rusty_pipe/impact', '/admin/equipment/export', '/admin/equipment/history'];
  const WRITES = [
    ['POST', '/admin/equipment/definitions', { definition: gear('t_sneaky', 'N') }],
    ['PUT', '/admin/equipment/definitions/rusty_pipe', { definition: gear('rusty_pipe', 'N'), expectedRevision: 1 }],
    ['PUT', '/admin/equipment/definitions/rusty_pipe/enabled', { enabled: false, expectedRevision: 1 }],
    ['POST', '/admin/equipment/definitions/rusty_pipe/duplicate', { key: 't_sneaky_copy' }],
    ['POST', '/admin/equipment/import/preview', { package: { format: 'waifumon-equipment', version: 3, definitions: [] } }],
    ['POST', '/admin/equipment/import/apply', { package: { format: 'waifumon-equipment', version: 3, definitions: [] }, expectedPlanHash: 'x' }],
  ] as const;

  it('refuses a caller with no session', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/v1/admin/equipment/definitions' })).statusCode).toBe(401);
  });

  it('refuses a player with no equipment permission, reads and writes alike', async () => {
    for (const url of READS) expect((await api.inject({ method: 'GET', url: `/api/v1${url}`, ...as('player') })).statusCode, url).toBe(403);
    for (const [method, url, payload] of WRITES) {
      expect((await api.inject({ method, url: `/api/v1${url}`, ...as('player'), payload })).statusCode, url).toBe(403);
    }
  });

  it('`equipment.read` reads and previews, but cannot write', async () => {
    for (const url of READS) expect((await api.inject({ method: 'GET', url: `/api/v1${url}`, ...as('reader') })).statusCode, url).toBe(200);
    const preview = await api.inject({ method: 'POST', url: '/api/v1/admin/equipment/roll-preview', ...as('reader'), payload: { key: 'rusty_pipe' } });
    expect(preview.statusCode).toBe(200);
    for (const [method, url, payload] of WRITES) {
      const res = await api.inject({ method, url: `/api/v1${url}`, ...as('reader'), payload });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    }
    expect((await detail('rusty_pipe')).definition.revision).toBe(1);
  });

  it('`equipment.write` writes with a CSRF token, is refused without one, and is recorded as the actor', async () => {
    const noCsrf = await api.inject({ method: 'POST', url: '/api/v1/admin/equipment/definitions', ...as('editor', false), payload: { definition: gear('t_by_editor', 'N') } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('PORTAL_CSRF_INVALID');
    const res = await api.inject({ method: 'POST', url: '/api/v1/admin/equipment/definitions', ...as('editor'), payload: { definition: gear('t_by_editor', 'N'), updatedBy: 'someone-else' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.definition.updatedBy).toBe(EDITOR_ID);
    expect((await events('t_by_editor'))[0]!.actor).toBe(EDITOR_ID);
  });
});

// ── migration 0073 ──────────────────────────────────────────────────────────

describe('migration 0073', () => {
  it('existing definitions start at revision 1, and the revision cannot go below 1', async () => {
    const [row] = await t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, 'railcarbine'));
    expect(row!.revision).toBe(1);
    await expect(t.db.update(equipmentDefinitions).set({ revision: 0 }).where(eq(equipmentDefinitions.key, 'railcarbine'))).rejects.toThrow();
  });
});
