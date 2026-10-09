/**
 * Boss Management over the Admin API, against a real database bootstrapped
 * from the shipped content: definitions and their schedules, the Activity and
 * Diagnostics views, Spawn Now and End Encounter with their audit entries, and
 * who may do any of it.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ApiContext } from '../../../src/api/context';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { describeSchedulerStatus } from '../../../src/api/routes/v1/admin/bosses';
import {
  bossDefinitionEvents,
  bossDefinitions,
  bossEncounters,
  bossParticipations,
  guildBossState,
  guilds,
  playerWaifus,
  players,
  species,
} from '../../../src/db/schema';
import { bootstrapBossDefinitions, createDatabaseBossDefinitionSource } from '../../../src/modules/bosses/bossDefinitions';
import {
  createBossDefinitionService,
  type BossDefinitionService,
} from '../../../src/modules/bosses/bossDefinitionService';
import { createBossScheduler, type BossSchedulerStatus } from '../../../src/modules/bosses/bossScheduler';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import {
  createPortalAuthorizationService,
  type PortalAuthorizationService,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { ASSETS_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555771';
const OTHER_GUILD_ID = '111222333444555772';
const OWNER_ID = '777888999000111331';
const NON_OWNER_ID = '999999999999999771';
const OWNER_TOKEN = 'token-owner';
const NON_OWNER_TOKEN = 'token-non-owner';
const CSRF = 'csrf-token';
const TABLE = 'standard-scouting-v1';

let t: TestDb;
let app: App;
let api: ZodFastify;
let guildDbId: number;
let playerId: number;
let otherGuildDbId: number;
let definitionService: BossDefinitionService;
const bossRuntime: NonNullable<ApiContext['bossRuntime']> = {};
/** Role-holders who are not the owner: one may edit definitions, the other may operate encounters. */
const EDITOR_ID = '555000000000000001';
const OPERATOR_ID = '555000000000000002';
const EDITOR_TOKEN = 'token-editor';
const OPERATOR_TOKEN = 'token-operator';

type Json = Record<string, any>;
const q = `guildId=${GUILD_ID}`;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    headers: AUTH_BEARER,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const data = async (url: string): Promise<Json> => (await call('GET', url)).json().data;
const getBoss = (id: string) => data(`/admin/bosses/${id}`);
const body = (over: Json = {}) => ({
  name: 'Api Made',
  affinity: 'primal',
  regions: ['waifu-valley'],
  status: 'active',
  artwork: null,
  rewardTable: TABLE,
  scoutingText: 'It arrives.',
  repelledText: 'It leaves, beaten.',
  unchallengedText: 'It leaves, bored.',
  description: 'Made over the API.',
  ...over,
});
const fields = (b: Json) =>
  Object.fromEntries(
    ['name', 'affinity', 'regions', 'status', 'artwork', 'rewardTable', 'scoutingText', 'repelledText', 'unchallengedText', 'description', 'schedule'].map(
      (key) => [key, b[key]],
    ),
  );
async function save(id: string, change: Json) {
  const current = await getBoss(id);
  return call('PUT', `/admin/bosses/${id}`, { boss: { ...fields(current), ...change }, expectedRevision: current.revision });
}
const audit = async (bossId: string): Promise<Json[]> => (await data(`/admin/bosses/events?bossId=${bossId}`)).events;
/** Outside every October: the seasonal boss below is out of season. */
const SEASONAL = { timezone: 'America/Toronto', dateRange: { kind: 'yearly', start: '01-01', end: '01-01' } };

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, {
    bossDefinitions: createDatabaseBossDefinitionSource(),
  });
  ({ guildDbId, playerId } = await provisionPlayer(app, GUILD_ID, OWNER_ID));
  await provisionPlayer(app, GUILD_ID, NON_OWNER_ID);
  ({ guildDbId: otherGuildDbId } = await provisionPlayer(app, OTHER_GUILD_ID, 'someone-else'));

  const bossDefinitionService = createBossDefinitionService({
    db: t.db,
    getShippedIds: () => app.content.bosses.map((b) => b.id),
    getEnabledRegions: () => app.content.tables.bossEncounters.regions,
    listRewardTables: async () => app.content.bossRewards.map((t) => ({ id: t.id, enabled: t.enabled })),
  });
  definitionService = bossDefinitionService;

  const guildOwnership = createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID });
  const ownerOnly = createPortalAuthorizationService({ guildOwnership });
  // Two role-holders with exactly the grants under test; everyone else is
  // decided by the real service.
  const granted: Record<string, PortalPermission[]> = {
    [EDITOR_ID]: ['admin.access', 'bosses.read', 'bosses.write'],
    [OPERATOR_ID]: ['admin.access', 'bosses.read', 'bosses.operate'],
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
    getSession: async (token: string | undefined) =>
      token === OWNER_TOKEN
        ? session(OWNER_ID)
        : token === NON_OWNER_TOKEN
          ? session(NON_OWNER_ID)
          : token === EDITOR_TOKEN
            ? session(EDITOR_ID)
            : token === OPERATOR_TOKEN
              ? session(OPERATOR_ID)
              : null,
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
      services: { ...app, bossDefinitions: bossDefinitionService },
      getContent: () => app.content,
      assetsDir: ASSETS_DIR,
      portalAuthorization,
      adminBearerAllowed: true,
      bossRuntime,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(bossParticipations);
  await t.db.delete(bossEncounters);
  await t.db.delete(guildBossState);
  await t.db.delete(bossDefinitionEvents);
  await t.db.delete(bossDefinitions);
  await t.db.update(players).set({ buddyWaifuId: null });
  await t.db.delete(playerWaifus);
  await t.db.update(guilds).set({ bossChannelId: 'c-boss-api' }).where(eq(guilds.id, guildDbId));
  await t.db.update(guilds).set({ bossChannelId: 'c-boss-other' }).where(eq(guilds.id, otherGuildDbId));
  await bootstrapBossDefinitions(t.db, app.content.bosses);
  bossRuntime.scheduler = undefined;
});

describe('the boss list and the editor reference', () => {
  it('lists every shipped boss with its status, schedule summary and availability', async () => {
    const shipped = app.content.bosses;
    const { bosses } = await data('/admin/bosses');
    expect(bosses.map((b: Json) => b.id)).toEqual(shipped.map((b) => b.id));
    expect(bosses[0]).toMatchObject({
      id: shipped[0]!.id,
      name: shipped[0]!.name,
      regions: ['waifu-valley'],
      status: shipped[0]!.enabled ? 'active' : 'disabled',
      artwork: shipped[0]!.artwork,
      rewardTable: TABLE,
      scheduleSummary: 'Always available',
      availability: { mode: 'always', availableNow: true, nextWindow: null, unavailableReason: null },
      encounterCount: 0,
      lastEncounterAt: null,
      revision: 1,
      shipped: true,
      source: 'bootstrap',
    });
  });

  it('offers regions, affinities, boss reward tables, artwork files and the shared tuning', async () => {
    const reference = await data('/admin/bosses/reference');
    const config = app.content.tables.bossEncounters;
    expect(reference).toMatchObject({
      regions: [{ id: 'waifu-valley', label: 'Waifu Valley', enabled: true }],
      affinities: ['dominant', 'submissive', 'caregiver', 'primal', 'switch'],
      defaultTimezone: 'America/Toronto',
      // The window and the respawn cooldown are global, not per boss.
      tuning: {
        enabled: true,
        scoutingMinutes: config.scoutingMinutes,
        downtimeMinutesMin: config.downtimeMinutesMin,
        downtimeMinutesMax: config.downtimeMinutesMax,
        attacksPerParticipation: config.attacksPerParticipation,
      },
    });
    expect(reference.rewardTables).toContainEqual({ id: TABLE, enabled: true });
    expect(reference.artwork).toContain(app.content.bosses.find((b) => b.artwork)!.artwork);
  });

  it('serves shipped boss artwork, and nothing outside the assets directory', async () => {
    const artwork = app.content.bosses.find((b) => b.artwork)!.artwork!;
    const image = await call('GET', `/admin/bosses/artwork?path=${encodeURIComponent(artwork)}`);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');
    expect(image.rawPayload.length).toBeGreaterThan(100);
    for (const path of ['../package.json', 'bosses/../../package.json', '/etc/passwd', 'bosses/nope.webp', 'bosses']) {
      expect((await call('GET', `/admin/bosses/artwork?path=${encodeURIComponent(path)}`)).statusCode, path).toBe(404);
    }
  });
});

describe('authoring over the API', () => {
  it('creates, reads, saves and changes the status of a boss', async () => {
    const created = await call('POST', '/admin/bosses', { id: 'api_made', boss: body({ status: 'draft' }) });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().data).toMatchObject({ id: 'api_made', status: 'draft', revision: 1, shipped: false, issues: [] });

    const saved = await save('api_made', { name: 'Api Renamed' });
    expect(saved.json().data).toMatchObject({ name: 'Api Renamed', revision: 2 });

    const activated = await call('PUT', '/admin/bosses/api_made/status', { status: 'active', expectedRevision: 2 });
    expect(activated.json().data).toMatchObject({ status: 'active', revision: 3 });

    const copy = await call('POST', '/admin/bosses/api_made/duplicate', { id: 'api_copy' });
    expect(copy.json().data).toMatchObject({ id: 'api_copy', status: 'draft', name: 'Api Renamed (copy)' });

    const deleted = await call('DELETE', '/admin/bosses/api_copy?expectedRevision=1');
    expect(deleted.json().data).toEqual({ ok: true });
    expect((await call('GET', '/admin/bosses/api_copy')).statusCode).toBe(404);
  });

  it('answers a validation failure with 400 and an issue per field', async () => {
    const res = await call('POST', '/admin/bosses', { id: 'incomplete', boss: { name: 'Incomplete', affinity: 'switch', status: 'active' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BOSS_DEFINITION_INVALID');
    expect(res.json().error.details.issues.map((i: Json) => i.path)).toEqual(
      expect.arrayContaining(['description', 'scoutingText', 'regions', 'rewardTable']),
    );
    // The dry run says the same without writing.
    const dry = await call('POST', '/admin/bosses/validate', { id: 'incomplete', boss: { name: 'Incomplete', affinity: 'switch', status: 'active' }, creating: true });
    expect(dry.json().data.issues.filter((i: Json) => i.severity === 'error').length).toBeGreaterThan(0);
    expect((await call('GET', '/admin/bosses/incomplete')).statusCode).toBe(404);
  });

  it('answers a stale save with 409 and the revision that won', async () => {
    await call('POST', '/admin/bosses', { id: 'contested', boss: body({ status: 'draft' }) });
    await save('contested', { name: 'Theirs' });
    const stale = await call('PUT', '/admin/bosses/contested', { boss: body({ status: 'draft', name: 'Mine' }), expectedRevision: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'BOSS_DEFINITION_STALE', details: { expectedRevision: 1, currentRevision: 2 } });
    expect((await getBoss('contested')).name).toBe('Theirs');
  });

  it('answers a taken id and a protected delete with 409', async () => {
    const shipped = app.content.bosses[0]!.id;
    const taken = await call('POST', '/admin/bosses', { id: shipped, boss: body() });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('BOSS_DEFINITION_KEY_TAKEN');
    const protectedDelete = await call('DELETE', `/admin/bosses/${shipped}?expectedRevision=1`);
    expect(protectedDelete.statusCode).toBe(409);
    expect(protectedDelete.json().error).toMatchObject({ code: 'BOSS_DEFINITION_IN_USE', details: { shipped: true, encounterCount: 0 } });
  });

  it('saves a schedule and reports it in words and as windows', async () => {
    const id = app.content.bosses.find((b) => b.enabled)!.id;
    const saved = await save(id, {
      schedule: {
        timezone: 'America/Toronto',
        weekly: [
          { day: 'fri', windows: [{ start: '18:00', end: '23:59' }] },
          { day: 'sat', allDay: true },
          { day: 'sun', windows: [{ start: '12:00', end: '22:00' }] },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data).toMatchObject({
      scheduleSummary: 'Fri 18:00–23:59, Sat all day, Sun 12:00–22:00 (America/Toronto)',
      availability: { mode: 'weekly' },
    });
    const { availability } = saved.json().data;
    // Whichever it is right now, there is always a window to point at.
    expect(availability.currentWindow ?? availability.nextWindow).not.toBeNull();
  });

  it('previews a schedule without saving it, and explains one that can never open', async () => {
    const ok = await call('POST', '/admin/bosses/schedule/preview', {
      schedule: { timezone: 'America/Toronto', weekly: [{ day: 'sat', allDay: true }] },
    });
    expect(ok.json().data).toMatchObject({ issues: [], summary: 'Sat all day (America/Toronto)', availability: { mode: 'weekly' } });

    const ended = await call('POST', '/admin/bosses/schedule/preview', {
      schedule: { timezone: 'America/Toronto', dateRange: { kind: 'fixed', start: '2020-10-25', end: '2020-10-31' } },
    });
    expect(ended.json().data).toMatchObject({
      availability: { availableNow: false, nextWindow: null },
      issues: [{ severity: 'warning', message: expect.stringContaining('ended on 2020-10-31') }],
    });

    const invalid = await call('POST', '/admin/bosses/schedule/preview', { schedule: { timezone: 'Nowhere/Land', weekly: [] } });
    expect(invalid.json().data).toMatchObject({ summary: null, availability: null });
    expect(invalid.json().data.issues.map((i: Json) => i.path)).toEqual(['timezone', 'weekly']);
  });

  it('exports, plans and applies an import', async () => {
    const exported = await data('/admin/bosses/export');
    expect(exported).toMatchObject({ file: 'boss-definitions.json', document: { format: 'waifumon-boss-definitions', version: 1 } });
    const [first] = exported.document.bosses;
    const document = { ...exported.document, bosses: [{ ...first, name: 'Imported Name' }, { id: 'imported_new', ...body() }] };

    const plan = (await call('POST', '/admin/bosses/import/plan', { document })).json().data;
    expect(plan.entries.map((e: Json) => e.action)).toEqual(['conflict', 'create']);

    const skipped = await call('POST', '/admin/bosses/import/apply', { document, conflicts: 'skip' });
    expect(skipped.json().data).toEqual({ created: ['imported_new'], overwritten: [], skipped: [first.id], unchanged: [] });
    expect((await getBoss(first.id)).name).toBe(first.name);

    const stale = await call('POST', '/admin/bosses/import/apply', { document, conflicts: 'overwrite', expectedRevisions: { [first.id]: 99 } });
    expect(stale.statusCode).toBe(409);
    const overwritten = await call('POST', '/admin/bosses/import/apply', { document, conflicts: 'overwrite', expectedRevisions: { [first.id]: 1 } });
    expect(overwritten.json().data.overwritten).toEqual([first.id]);
    expect((await getBoss(first.id)).name).toBe('Imported Name');
    expect((await audit(first.id))[0]).toMatchObject({ action: 'import', details: { result: 'overwritten' } });
  });
});

describe('activity, Spawn Now and End Encounter', () => {
  const active = () => app.content.bosses.find((b) => b.enabled)!;

  it('shows nothing active and no history on a quiet server', async () => {
    expect(await data(`/admin/bosses/activity?${q}`)).toEqual({ featureEnabled: true, active: [], recent: [] });
  });

  it('Spawn Now creates an ordinary encounter through the spawn service, and audits it', async () => {
    const boss = active();
    const res = await call('POST', `/admin/bosses/${boss.id}/spawn?${q}`, {});
    expect(res.statusCode, res.body).toBe(200);
    const { encounter, scheduleOverridden, announcement } = res.json().data;
    expect(encounter).toMatchObject({ bossId: boss.id, bossName: boss.name, status: 'scheduled', forced: true, participantCount: 0, rewardTable: TABLE });
    expect(scheduleOverridden).toBe(false);
    // No scheduler in this process: the announcement waits for whichever process runs one.
    expect(announcement).toBe('no_scheduler');

    // The row is a real encounter, naming the reward table payout reads.
    const [stored] = await t.db.select().from(bossEncounters).where(eq(bossEncounters.id, encounter.id));
    expect(stored).toMatchObject({ guildId: guildDbId, forced: true, rewardTable: TABLE, rewardTableVersion: TABLE });
    expect(stored!.bossSnapshot).toMatchObject({ scoutingText: boss.scoutingText });

    expect((await data(`/admin/bosses/activity?${q}`)).active).toEqual([expect.objectContaining({ id: encounter.id })]);
    expect((await audit(boss.id)).map((e) => e.action)).toEqual(['manual_spawn', 'bootstrap']);
    expect((await audit(boss.id))[0]).toMatchObject({ details: { encounterId: encounter.id, guildDbId, scheduleOverridden: false } });
  });

  it('refuses a second spawn while one encounter is active', async () => {
    const boss = active();
    await call('POST', `/admin/bosses/${boss.id}/spawn?${q}`, {});
    const second = await call('POST', `/admin/bosses/${boss.id}/spawn?${q}`, {});
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({ code: 'BOSS_SPAWN_REFUSED', details: { reason: 'encounter_active' } });
    expect((await data(`/admin/bosses/activity?${q}`)).active).toHaveLength(1);
  });

  it('refuses a boss that is not Active, and a server with no boss channel', async () => {
    const disabled = app.content.bosses.find((b) => !b.enabled)!;
    const notActive = await call('POST', `/admin/bosses/${disabled.id}/spawn?${q}`, { overrideSchedule: true });
    expect(notActive.statusCode).toBe(409);
    expect(notActive.json().error.details.reason).toBe('not_active');

    await t.db.update(guilds).set({ bossChannelId: null }).where(eq(guilds.id, guildDbId));
    const noChannel = await call('POST', `/admin/bosses/${active().id}/spawn?${q}`, {});
    expect(noChannel.statusCode).toBe(404);
    expect(noChannel.json().error.code).toBe('BOSS_CHANNEL_NOT_CONFIGURED');
    expect((await call('POST', `/admin/bosses/no_such_boss/spawn?${q}`, {})).statusCode).toBe(404);
  });

  it('refuses a boss outside its schedule until the override is explicit, then audits the override', async () => {
    const boss = active();
    await save(boss.id, { schedule: SEASONAL });
    // Skip the one day a year this schedule is open.
    if ((await getBoss(boss.id)).availability.availableNow) return;

    const refused = await call('POST', `/admin/bosses/${boss.id}/spawn?${q}`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'BOSS_SPAWN_REFUSED', details: { reason: 'outside_schedule' } });
    expect((await data(`/admin/bosses/activity?${q}`)).active).toEqual([]);
    expect((await audit(boss.id)).map((e) => e.action)).not.toContain('manual_spawn');

    const forced = await call('POST', `/admin/bosses/${boss.id}/spawn?${q}`, { overrideSchedule: true });
    expect(forced.statusCode, forced.body).toBe(200);
    expect(forced.json().data).toMatchObject({ scheduleOverridden: true, encounter: { bossId: boss.id, forced: true } });
    const trail = await audit(boss.id);
    expect(trail.slice(0, 2).map((e) => e.action).sort()).toEqual(['manual_spawn', 'schedule_override']);
    expect(trail.find((e) => e.action === 'schedule_override')).toMatchObject({
      details: { encounterId: forced.json().data.encounter.id, scheduleOverridden: true },
    });
  });

  it('End Encounter pays whoever committed, records history, and audits it', async () => {
    const boss = active();
    const { encounter } = (await call('POST', `/admin/bosses/${boss.id}/spawn?${q}`, {})).json().data;
    await app.bosses.beginScouting(encounter.id, 'c-boss-api', 'm-1');
    const [sp] = await t.db.select({ id: species.id }).from(species).limit(1);
    const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: sp!.id, level: 5, xp: 0, baseSp: 120 });
    await t.db.update(players).set({ buddyWaifuId: waifu.id }).where(eq(players.id, playerId));
    await app.bosses.commit(encounter.id, guildDbId, playerId, { discordUserId: OWNER_ID, trainerName: 'Committed' });

    const ended = await call('POST', `/admin/bosses/encounters/${encounter.id}/end?${q}`);
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json().data.encounter).toMatchObject({ id: encounter.id, status: 'resolved', resolutionReason: 'cancelled_admin', participantCount: 1 });

    const [participation] = await t.db.select().from(bossParticipations).where(eq(bossParticipations.encounterId, encounter.id));
    expect(participation).toMatchObject({ rewardStatus: 'applied' });
    expect(participation!.xpAwarded).toBeGreaterThan(0);

    const activity = await data(`/admin/bosses/activity?${q}`);
    expect(activity.active).toEqual([]);
    expect(activity.recent).toEqual([expect.objectContaining({ id: encounter.id, status: 'resolved', participantCount: 1 })]);
    expect((await audit(boss.id))[0]).toMatchObject({
      action: 'manual_end',
      details: { encounterId: encounter.id, participantCount: 1, outcome: 'resolved' },
    });
    expect((await getBoss(boss.id)).encounterCount).toBe(1);

    // Already finished: it cannot be ended again.
    const again = await call('POST', `/admin/bosses/encounters/${encounter.id}/end?${q}`);
    expect(again.statusCode).toBe(409);
  });

  it('cannot see or end another server\'s encounter', async () => {
    const boss = active();
    const spawn = await app.bosses.forceSpawn(otherGuildDbId, boss.id);
    expect((await data(`/admin/bosses/activity?${q}`)).active).toEqual([]);
    const res = await call('POST', `/admin/bosses/encounters/${spawn.encounter.id}/end?${q}`);
    expect(res.statusCode).toBe(404);
    expect((await app.bosses.getEncounter(spawn.encounter.id))!.status).toBe('scheduled');
  });

  it('asks this process\'s scheduler for a pass when it is running', async () => {
    let passes = 0;
    bossRuntime.scheduler = {
      running: true,
      tick: async () => {
        passes += 1;
      },
      start: () => {},
      stop: () => {},
      status: () => ({}) as BossSchedulerStatus,
    };
    const res = await call('POST', `/admin/bosses/${active().id}/spawn?${q}`, {});
    expect(res.json().data.announcement).toBe('requested');
    expect(passes).toBe(1);
  });
});

describe('diagnostics', () => {
  it('reports no scheduler status at all when this process runs none', async () => {
    const diagnostics = await data(`/admin/bosses/diagnostics?${q}`);
    expect(diagnostics.scheduler).toBeNull();
    expect(diagnostics.featureEnabled).toBe(true);
  });

  it('reports what the scheduler recorded, not a guess', async () => {
    const scheduler = createBossScheduler({
      db: t.db,
      encounters: app.bosses,
      announcer: {
        verifyChannel: async () => ({ missing: [] }),
        postAnnouncement: async () => 'm-1',
        refreshAnnouncement: async () => {},
        publishResults: async () => {},
      },
      logger: t.logger,
    });
    bossRuntime.scheduler = scheduler;
    // Built but never started.
    expect((await data(`/admin/bosses/diagnostics?${q}`)).scheduler).toMatchObject({ health: 'stopped', running: false, passes: 0, lastPassCompletedAt: null });

    await scheduler.tick();
    const after = (await data(`/admin/bosses/diagnostics?${q}`)).scheduler;
    expect(after).toMatchObject({ health: 'stopped', passes: 1, lastPassGuilds: 2, lastPassUsableGuilds: 2, lastError: null });
    expect(after.lastPassCompletedAt).not.toBeNull();
  });

  it('turns recorded facts into a health verdict', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const base: BossSchedulerStatus = {
      running: true,
      intervalMs: 60_000,
      passes: 10,
      lastPassStartedAt: new Date('2026-10-09T11:59:30Z'),
      lastPassCompletedAt: new Date('2026-10-09T11:59:31Z'),
      lastPassDurationMs: 1000,
      lastPassGuilds: 1,
      lastPassUsableGuilds: 1,
      lastError: null,
    };
    expect(describeSchedulerStatus(base, now).health).toBe('ok');
    expect(describeSchedulerStatus({ ...base, lastPassCompletedAt: new Date('2026-10-09T11:50:00Z') }, now).health).toBe('stalled');
    expect(describeSchedulerStatus({ ...base, lastError: { at: now, message: 'database is down' } }, now)).toMatchObject({
      health: 'failing',
      explanation: 'The last scheduler pass failed: database is down',
    });
    expect(describeSchedulerStatus({ ...base, passes: 0, lastPassCompletedAt: null }, now).health).toBe('starting');
    expect(describeSchedulerStatus({ ...base, running: false }, now).health).toBe('stopped');
  });

  it('sorts every definition into exactly one verdict, and shows the guild state behind a spawn', async () => {
    const [scheduled, eligible] = app.content.bosses.filter((b) => b.enabled);
    await save(scheduled!.id, { schedule: SEASONAL });
    if ((await getBoss(scheduled!.id)).availability.availableNow) return;
    await call('POST', '/admin/bosses', { id: 'a_draft', boss: body({ status: 'draft' }) });
    await app.bosses.ensureState(guildDbId);
    const cooldownEnds = new Date(Date.now() + 10 * 60_000);
    await t.db.update(guildBossState).set({ nextSpawnAt: cooldownEnds, paused: true }).where(eq(guildBossState.guildId, guildDbId));

    const diagnostics = await data(`/admin/bosses/diagnostics?${q}`);
    expect(diagnostics.guild).toMatchObject({
      region: 'waifu-valley',
      channelConfigured: true,
      paused: true,
      suspendedReason: null,
      nextSpawnAt: cooldownEnds.toISOString(),
      cooldownActive: true,
    });
    expect(diagnostics.active).toBeNull();
    const verdict = (id: string) => diagnostics.bosses.find((b: Json) => b.id === id);
    expect(diagnostics.bosses).toHaveLength(app.content.bosses.length + 1);
    // Eligible, but held back by the guild's cooldown.
    expect(verdict(eligible!.id)).toMatchObject({ verdict: 'eligible', heldByCooldown: true });
    expect(verdict(scheduled!.id)).toMatchObject({ verdict: 'outside_schedule', heldByCooldown: false, availability: { availableNow: false } });
    expect(verdict(scheduled!.id).availability.nextWindow).not.toBeNull();
    expect(verdict('a_draft')).toMatchObject({ verdict: 'not_active', status: 'draft' });
    expect(verdict(app.content.bosses.find((b) => !b.enabled)!.id)).toMatchObject({ verdict: 'not_active', status: 'disabled' });
  });

  it('says whether the shipped roster reached the database, and what the last bootstrap reported', async () => {
    const healthy = (await data(`/admin/bosses/diagnostics?${q}`)).bootstrap;
    expect(healthy).toEqual({ definitions: app.content.bosses.length, missingShipped: [], lastRun: null });

    // A bootstrap that failed, as startup would record it — and a boss it never inserted.
    const missing = app.content.bosses[2]!.id;
    await t.db.delete(bossDefinitions).where(eq(bossDefinitions.bossKey, missing));
    definitionService.noteBootstrap({ at: new Date('2026-10-09T12:00:00Z'), error: 'connection refused', created: [], heldBack: [] });
    try {
      expect((await data(`/admin/bosses/diagnostics?${q}`)).bootstrap).toEqual({
        definitions: app.content.bosses.length - 1,
        missingShipped: [missing],
        lastRun: { at: '2026-10-09T12:00:00.000Z', error: 'connection refused', created: [], heldBack: [] },
      });
    } finally {
      definitionService.noteBootstrap({ at: new Date(), error: null, created: [], heldBack: [] });
    }
  });

  it('shows the active encounter', async () => {
    const boss = app.content.bosses.find((b) => b.enabled)!;
    const { encounter } = (await call('POST', `/admin/bosses/${boss.id}/spawn?${q}`, {})).json().data;
    expect((await data(`/admin/bosses/diagnostics?${q}`)).active).toMatchObject({ id: encounter.id, bossId: boss.id });
  });
});

describe('permissions', () => {
  const asCookie = (token: string, withCsrf: boolean) => ({
    cookies: { wm_portal_session: token, wm_portal_csrf: CSRF },
    headers: withCsrf ? { 'x-portal-csrf': CSRF } : {},
  });
  const READS = [
    '/admin/bosses',
    '/admin/bosses/reference',
    '/admin/bosses/export',
    '/admin/bosses/events',
    '/admin/bosses/activity',
    '/admin/bosses/diagnostics',
    '/admin/bosses/artwork?path=bosses/x.webp',
  ];
  const writes = (boss: string) =>
    [
      ['POST', '/admin/bosses', { id: 'sneaky', boss: body() }],
      ['PUT', `/admin/bosses/${boss}`, { boss: body(), expectedRevision: 1 }],
      ['PUT', `/admin/bosses/${boss}/status`, { status: 'disabled', expectedRevision: 1 }],
      ['POST', `/admin/bosses/${boss}/duplicate`, { id: 'sneaky_copy' }],
      ['DELETE', `/admin/bosses/${boss}?expectedRevision=1`, undefined],
      ['POST', '/admin/bosses/import/apply', { document: [{ id: 'sneaky', ...body() }], conflicts: 'overwrite' }],
      ['POST', `/admin/bosses/${boss}/spawn`, { overrideSchedule: true }],
      ['POST', '/admin/bosses/encounters/1/end', undefined],
    ] as const;

  it('refuses a caller with no session', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/v1/admin/bosses' })).statusCode).toBe(401);
    expect((await api.inject({ method: 'POST', url: '/api/v1/admin/bosses', payload: { id: 'sneaky', boss: body() } })).statusCode).toBe(401);
    expect((await api.inject({ method: 'POST', url: `/api/v1/admin/bosses/${app.content.bosses[0]!.id}/spawn`, payload: {} })).statusCode).toBe(401);
  });

  it('refuses a signed-in player with no boss permission — reads, writes, spawn and end alike', async () => {
    const boss = app.content.bosses.find((b) => b.enabled)!.id;
    const before = (await data('/admin/bosses')).bosses;
    const player = asCookie(NON_OWNER_TOKEN, true);
    for (const url of [...READS, `/admin/bosses/${boss}`]) {
      const res = await api.inject({ method: 'GET', url: `/api/v1${url}`, ...player });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    }
    const dryRuns = [
      ['POST', '/admin/bosses/validate', { id: 'x', boss: body(), creating: true }],
      ['POST', '/admin/bosses/schedule/preview', { schedule: {} }],
      ['POST', '/admin/bosses/import/plan', { document: [] }],
    ] as const;
    for (const [method, url, payload] of [...writes(boss), ...dryRuns]) {
      const res = await api.inject({ method, url: `/api/v1${url}`, ...player, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await data('/admin/bosses')).bosses).toEqual(before);
    expect(await t.db.select().from(bossEncounters)).toEqual([]);
    expect((await audit(boss)).map((e) => e.action)).toEqual(['bootstrap']);
  });

  it('editing definitions and operating encounters are separate grants', async () => {
    const boss = app.content.bosses.find((b) => b.enabled)!.id;
    const editor = asCookie(EDITOR_TOKEN, true);
    const operator = asCookie(OPERATOR_TOKEN, true);
    const post = (who: typeof editor, url: string, payload?: unknown) =>
      api.inject({ method: 'POST', url: `/api/v1${url}`, ...who, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

    // An editor authors definitions…
    const created = await post(editor, '/admin/bosses', { id: 'by_editor', boss: body({ status: 'draft' }) });
    expect(created.statusCode, created.body).toBe(200);
    // …but cannot spawn a boss or end an encounter.
    const refusedSpawn = await post(editor, `/admin/bosses/${boss}/spawn`, { overrideSchedule: true });
    expect(refusedSpawn.statusCode).toBe(403);
    expect(refusedSpawn.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    expect(await t.db.select().from(bossEncounters)).toEqual([]);

    // An operator spawns and ends…
    const spawned = await post(operator, `/admin/bosses/${boss}/spawn`, {});
    expect(spawned.statusCode, spawned.body).toBe(200);
    expect((await post(editor, `/admin/bosses/encounters/${spawned.json().data.encounter.id}/end`)).statusCode).toBe(403);
    const ended = await post(operator, `/admin/bosses/encounters/${spawned.json().data.encounter.id}/end`);
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await audit(boss)).slice(0, 2).map((e) => [e.action, e.actor])).toEqual([
      ['manual_end', OPERATOR_ID],
      ['manual_spawn', OPERATOR_ID],
    ]);
    // …but cannot change a definition, its status, or import one.
    for (const [method, url, payload] of [
      ['POST', '/admin/bosses', { id: 'by_operator', boss: body() }],
      ['PUT', `/admin/bosses/${boss}`, { boss: body(), expectedRevision: 1 }],
      ['PUT', `/admin/bosses/${boss}/status`, { status: 'disabled', expectedRevision: 1 }],
      ['DELETE', '/admin/bosses/by_editor?expectedRevision=1', undefined],
      ['POST', '/admin/bosses/import/apply', { document: [{ id: 'by_operator', ...body() }], conflicts: 'skip' }],
    ] as const) {
      const res = await api.inject({ method, url: `/api/v1${url}`, ...operator, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await getBoss(boss)).revision).toBe(1);
    // Both can read.
    expect((await api.inject({ method: 'GET', url: '/api/v1/admin/bosses', ...editor })).statusCode).toBe(200);
    expect((await api.inject({ method: 'GET', url: '/api/v1/admin/bosses/diagnostics', ...operator })).statusCode).toBe(200);
  });

  it('an owner session writes with a CSRF token, is refused without one, and is recorded as the actor', async () => {
    const boss = app.content.bosses.find((b) => b.enabled)!.id;
    const noCsrf = await api.inject({ method: 'POST', url: '/api/v1/admin/bosses', ...asCookie(OWNER_TOKEN, false), payload: { id: 'by_owner', boss: body() } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('PORTAL_CSRF_INVALID');

    const created = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/bosses',
      ...asCookie(OWNER_TOKEN, true),
      // The actor is the session's user, never something the request said.
      payload: { id: 'by_owner', boss: body(), updatedBy: 'someone-else' },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().data.updatedBy).toBe(OWNER_ID);
    expect((await audit('by_owner'))[0]).toMatchObject({ action: 'create', actor: OWNER_ID });

    // The session's selected server is the one acted on: no guildId needed, and no other accepted.
    const spawned = await api.inject({ method: 'POST', url: `/api/v1/admin/bosses/${boss}/spawn`, ...asCookie(OWNER_TOKEN, true), payload: {} });
    expect(spawned.statusCode, spawned.body).toBe(200);
    expect((await audit(boss))[0]).toMatchObject({ action: 'manual_spawn', actor: OWNER_ID, details: { guildDbId, discordGuildId: GUILD_ID } });
    const elsewhere = await api.inject({
      method: 'GET',
      url: `/api/v1/admin/bosses/activity?guildId=${OTHER_GUILD_ID}`,
      ...asCookie(OWNER_TOKEN, true),
    });
    expect(elsewhere.statusCode).toBe(403);

    const ended = await api.inject({
      method: 'POST',
      url: `/api/v1/admin/bosses/encounters/${spawned.json().data.encounter.id}/end`,
      ...asCookie(OWNER_TOKEN, true),
    });
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await audit(boss))[0]).toMatchObject({ action: 'manual_end', actor: OWNER_ID });
  });
});
