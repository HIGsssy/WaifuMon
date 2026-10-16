/**
 * Region Pools over the Admin API: who may read, edit and publish; CSRF; the
 * structured refusals the editor renders beside species and rarity tiers;
 * and that reads never write.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { regionEncounterPools, regionPoolEvents, regionPoolRevisions, regionPools } from '../../../src/db/schema';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import {
  createPortalAuthorizationService,
  type PortalAuthorizationService,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { contentRegionCatalogue } from '../../../src/modules/regionPools/regionCatalogue';
import { createRegionPoolService } from '../../../src/modules/regionPools/regionPoolService';
import { bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const GUILD_ID = '111222333444555991';
const OWNER_ID = '777888999000111991';
const READER_ID = '777888999000111992';
const WRITER_ID = '777888999000111993';
const PUBLISHER_ID = '777888999000111994';
const STRANGER_ID = '777888999000111995';
const CSRF = 'csrf-token';
const TOKENS: Record<string, string> = {
  owner: OWNER_ID,
  reader: READER_ID,
  writer: WRITER_ID,
  publisher: PUBLISHER_ID,
  stranger: STRANGER_ID,
};

let t: TestDb;
let app: App;
let api: ZodFastify;
/** Empty until a test writes the one species file it needs. */
const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-admin-assets-'));

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  for (const id of Object.values(TOKENS)) await provisionPlayer(app, GUILD_ID, id);
  const regionPoolsService = createRegionPoolService({
    db: t.db,
    getContent: () => app.content,
    catalogue: contentRegionCatalogue(() => app.content),
    huntTables: app.content.tables,
  });

  const ownerOnly = createPortalAuthorizationService({ guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID }) });
  const granted: Record<string, PortalPermission[]> = {
    [READER_ID]: ['admin.access', 'regions.read'],
    [WRITER_ID]: ['admin.access', 'regions.read', 'regions.write'],
    [PUBLISHER_ID]: ['admin.access', 'regions.read', 'regions.publish'],
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
    config: { enabled: true, host: '127.0.0.1', port: 3139, token: TEST_TOKEN, adminBearer: false },
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
      services: { ...app, regionPools: regionPoolsService },
      getContent: () => app.content,
      portalAuthorization,
      adminBearerAllowed: false,
      assetsDir,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

type Json = Record<string, any>;
type Who = keyof typeof TOKENS;
const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, csrf = true) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    cookies: { wm_portal_session: who, wm_portal_csrf: CSRF },
    headers: csrf ? { 'x-portal-csrf': CSRF } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const data = async (who: Who, url: string): Promise<Json> => {
  const res = await call(who, 'GET', url);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
};
const fingerprint = async () =>
  Promise.all([
    t.db.select().from(regionPools).orderBy(asc(regionPools.regionId)),
    t.db.select().from(regionPoolRevisions).orderBy(asc(regionPoolRevisions.id)),
    t.db.select().from(regionPoolEvents).orderBy(asc(regionPoolEvents.id)),
    t.db.select().from(regionEncounterPools),
  ]);

describe('reads', () => {
  it('lists every region with its published revision and drift status', async () => {
    const { regions } = await data('reader', '/admin/region-pools');
    expect(regions.map((r: Json) => r.region.id)).toEqual([
      'waifu-valley',
      'twin-peeks',
      'flaccid-foothills',
      'thirstlands',
      'base-80085',
      'assteroid-belt',
    ]);
    expect(regions[1]).toMatchObject({
      hasPool: true,
      draftRevision: 1,
      unpublishedChanges: false,
      published: { number: 1, source: 'bootstrap', entryCount: 40 },
      driftStatus: 'clean',
    });
    expect(regions[0].rarityCounts).toEqual({ N: 36, R: 27, SR: 18, SSR: 10, UR: 5, LR: 4 });
  });

  it('serves the species picker by slug, with no database ids anywhere', async () => {
    const { species } = await data('reader', '/admin/region-pools/species');
    expect(species.length).toBe(app.content.species.length);
    const sample = species.find((s: Json) => s.publishedIn.length > 1)!;
    expect(Object.keys(sample).sort()).toEqual(
      ['affinity', 'dungeonExclusive', 'enabled', 'huntable', 'imagePath', 'inContent', 'name', 'publishedIn', 'race', 'rarity', 'regionExclusive', 'slug'].sort(),
    );
    const pool = await data('reader', '/admin/region-pools/twin-peeks');
    // Regions and species are addressed by slug; no numeric row id or internal id field leaks.
    const body = JSON.stringify(pool);
    expect(body).not.toMatch(/"id":\d/);
    expect(body).not.toMatch(/"(speciesId|revisionId|publishedRevisionId)"/);
  });

  it('every read — including the analysis and the dry runs — writes nothing', async () => {
    const before = await fingerprint();
    for (const url of [
      '/admin/region-pools',
      '/admin/region-pools/species',
      '/admin/region-pools/twin-peeks',
      '/admin/region-pools/twin-peeks/shipped',
      '/admin/region-pools/twin-peeks/revisions',
      '/admin/region-pools/twin-peeks/revisions/1',
      '/admin/region-pools/twin-peeks/events',
      '/admin/region-pools/twin-peeks/drift',
    ]) {
      await data('reader', url);
    }
    for (const [url, body] of [
      ['/admin/region-pools/twin-peeks/validate', {}],
      ['/admin/region-pools/twin-peeks/validate', { entries: [{ species: 'alley_catgirl', weight: 1 }] }],
      ['/admin/region-pools/twin-peeks/analysis', { mode: 'hunt', level: 40, buddySpecies: 'rainy_day_idol', compare: true }],
      ['/admin/region-pools/twin-peeks/analysis', { mode: 'filtered_selector', filter: { poolScope: 'region', rarities: ['LR'] } }],
    ] as const) {
      const res = await call('reader', 'POST', url, body);
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await fingerprint()).toEqual(before);
  });

  it('returns analysis that sums to the encounter share', async () => {
    const res = await call('reader', 'POST', '/admin/region-pools/twin-peeks/analysis', { mode: 'hunt', level: 1 });
    const result = res.json().data.result;
    const perHunt = result.species.reduce((s: number, x: Json) => s + x.perHunt, 0);
    expect(perHunt).toBeCloseTo(0.74, 10);
    expect(res.json().data.assumptions).toEqual(expect.arrayContaining(['No Buddy equipped.']));
  });
});

describe('permissions', () => {
  it('refuses everything to a signed-in user without region permissions, and to nobody at all', async () => {
    expect((await call('stranger', 'GET', '/admin/region-pools')).statusCode).toBe(403);
    expect((await call('stranger', 'GET', '/admin/region-pools')).json().error.code).toBe('PORTAL_PERMISSION_DENIED');
    const anon = await api.inject({ method: 'GET', url: '/api/v1/admin/region-pools' });
    expect(anon.statusCode).toBe(401);
  });

  it('serves species thumbnails on regions.read alone (the reader holds no dungeons.read)', async () => {
    const sp = app.content.species.find((s) => s.enabled)!;
    const url = `/admin/region-pools/species/artwork?slug=${sp.slug}&width=256`;
    // Nothing on disk yet: 404, which the editor draws as its placeholder.
    expect((await call('reader', 'GET', url)).statusCode).toBe(404);

    const look = app.appearance.currentAppearance(app.appearance.speciesContent(sp.slug)!, null);
    const file = path.join(assetsDir, `${look.assetId.kind}/${look.assetId.slug}/${look.assetId.variant}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNkYPj/n4GBgYGJAQoAHxcCAr7uqmIAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(file, bytes);

    const art = await call('reader', 'GET', url);
    expect(art.statusCode).toBe(200);
    expect(art.headers['content-type']).toBe('image/png');
    expect(art.headers['cache-control']).toBe('private, max-age=300, must-revalidate');
    expect(art.rawPayload).toEqual(bytes);
    const cached = await api.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      cookies: { wm_portal_session: 'reader', wm_portal_csrf: CSRF },
      headers: { 'if-none-match': art.headers.etag as string },
    });
    expect(cached.statusCode).toBe(304);

    // No region permission, no artwork.
    expect((await call('stranger', 'GET', url)).statusCode).toBe(403);
    expect((await api.inject({ method: 'GET', url: `/api/v1${url}` })).statusCode).toBe(401);
    // Addressed by slug only.
    expect((await call('reader', 'GET', '/admin/region-pools/species/artwork?slug=..%2Fsecret')).statusCode).toBe(400);
    expect((await call('reader', 'GET', `/admin/region-pools/species/artwork?slug=${sp.slug}&width=123`)).statusCode).toBe(400);
    expect((await call('reader', 'GET', '/admin/region-pools/species/artwork?slug=no_such_species')).statusCode).toBe(404);
  });

  it('read cannot write, write cannot publish, publish cannot save drafts', async () => {
    const before = await fingerprint();
    const save = { entries: [{ species: 'alley_catgirl', weight: 1 }], expectedDraftRevision: 1 };
    const publish = { expectedDraftRevision: 1, reviewHash: 'x', acknowledgedWarnings: [] };
    expect((await call('reader', 'PUT', '/admin/region-pools/twin-peeks/draft', save)).statusCode).toBe(403);
    expect((await call('reader', 'POST', '/admin/region-pools/twin-peeks/draft/load-shipped', { expectedDraftRevision: 1 })).statusCode).toBe(403);
    expect((await call('writer', 'POST', '/admin/region-pools/twin-peeks/publish', publish)).statusCode).toBe(403);
    expect((await call('writer', 'POST', '/admin/region-pools/twin-peeks/rollback', { ...publish, revision: 1 })).statusCode).toBe(403);
    expect((await call('publisher', 'PUT', '/admin/region-pools/twin-peeks/draft', save)).statusCode).toBe(403);
    expect((await call('publisher', 'POST', '/admin/region-pools/twin-peeks/draft/discard', { expectedDraftRevision: 1 })).statusCode).toBe(403);
    expect(await fingerprint()).toEqual(before);
  });

  it('refuses a write without the CSRF header', async () => {
    const res = await call('owner', 'PUT', '/admin/region-pools/twin-peeks/draft', { entries: [], expectedDraftRevision: 1 }, false);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_CSRF_INVALID');
  });

  it('a writer drafts, a publisher publishes, and each is recorded as the actor', async () => {
    const pool = await data('writer', '/admin/region-pools/base-80085');
    const entries = pool.draft.entries.map((e: Json) => ({ species: e.species, weight: e.weight })).slice(0, -1);
    const saved = await call('writer', 'PUT', '/admin/region-pools/base-80085/draft', { entries, expectedDraftRevision: 1 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data.draft).toMatchObject({ revision: 2, unpublishedChanges: true, updatedBy: WRITER_ID });

    const review = (await call('publisher', 'POST', '/admin/region-pools/base-80085/validate', {})).json().data;
    const published = await call('publisher', 'POST', '/admin/region-pools/base-80085/publish', {
      expectedDraftRevision: review.draftRevision,
      reviewHash: review.reviewHash,
      acknowledgedWarnings: review.requiredAcknowledgements,
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().data.published).toMatchObject({ number: 2, publishedBy: PUBLISHER_ID, entryCount: 29 });
    const { events } = await data('reader', '/admin/region-pools/base-80085/events?limit=3');
    expect(events.map((e: Json) => [e.action, e.actor])).toEqual([
      ['published', PUBLISHER_ID],
      ['projection_rebuilt', PUBLISHER_ID],
      ['draft_saved', WRITER_ID],
    ]);
    const older = await data('reader', `/admin/region-pools/base-80085/events?limit=50&before=${events[2].cursor}`);
    expect(older.events.map((e: Json) => e.action)).toEqual(['projection_rebuilt', 'bootstrapped']);
    // Revisions are named by number in every event, never by row id.
    const bootstrapped = older.events.find((e: Json) => e.action === 'bootstrapped');
    expect(bootstrapped.details.revisionNumber).toBe(1);
    expect(JSON.stringify(older.events)).not.toMatch(/"(revisionId|publishedRevisionId)"/);
  });
});

describe('structured refusals', () => {
  it('400 REGION_POOL_INVALID carries per-species issues', async () => {
    const res = await call('owner', 'PUT', '/admin/region-pools/thirstlands/draft', {
      entries: [{ species: 'alley_catgirl', weight: 0 }, { species: 'no_such_waifu', weight: 1 }],
      expectedDraftRevision: 1,
    });
    expect(res.statusCode).toBe(400);
    const { code, details } = res.json().error;
    expect(code).toBe('REGION_POOL_INVALID');
    const errors = details.issues.filter((i: Json) => i.severity === 'error');
    expect(errors).toEqual([
      expect.objectContaining({ id: 'weight_invalid:alley_catgirl', species: 'alley_catgirl', index: 0 }),
      expect.objectContaining({ id: 'species_unknown:no_such_waifu', species: 'no_such_waifu', index: 1 }),
    ]);
  });

  it('409 REGION_POOL_STALE names both revisions', async () => {
    const res = await call('owner', 'PUT', '/admin/region-pools/base-80085/draft', { entries: [], expectedDraftRevision: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'REGION_POOL_STALE',
      details: { expectedDraftRevision: 1, currentDraftRevision: 2, updatedBy: WRITER_ID },
    });
  });

  it('409 REGION_POOL_REVIEW_STALE and 422 acknowledgement / publish-blocked refusals', async () => {
    const pool = await data('owner', '/admin/region-pools/thirstlands');
    const noLr = pool.draft.entries.filter((e: Json) => e.rarity !== 'LR').map((e: Json) => ({ species: e.species, weight: e.weight }));
    const saved = await call('owner', 'PUT', '/admin/region-pools/thirstlands/draft', { entries: noLr, expectedDraftRevision: 1 });
    expect(saved.json().data.issues.map((i: Json) => i.id)).toEqual(['rarity_tier_empty:LR']);

    const review = (await call('owner', 'POST', '/admin/region-pools/thirstlands/validate', {})).json().data;
    const stale = await call('owner', 'POST', '/admin/region-pools/thirstlands/publish', {
      expectedDraftRevision: review.draftRevision,
      reviewHash: 'sha256:not-the-review',
      acknowledgedWarnings: [],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'REGION_POOL_REVIEW_STALE', details: { reviewHash: review.reviewHash } });

    const unacked = await call('owner', 'POST', '/admin/region-pools/thirstlands/publish', {
      expectedDraftRevision: review.draftRevision,
      reviewHash: review.reviewHash,
      acknowledgedWarnings: [],
    });
    expect(unacked.statusCode).toBe(422);
    expect(unacked.json().error).toMatchObject({
      code: 'REGION_POOL_ACKNOWLEDGEMENT_REQUIRED',
      details: { missing: ['rarity_tier_empty:LR'] },
    });

    // A publish-blocking error: the draft takes another region's exclusive.
    const peeks = await data('owner', '/admin/region-pools/twin-peeks');
    const theirs = peeks.published.entries.find((e: Json) => e.regionExclusive).species;
    const withTheirs = [...noLr, { species: theirs, weight: 1 }];
    const saved2 = await call('owner', 'PUT', '/admin/region-pools/thirstlands/draft', { entries: withTheirs, expectedDraftRevision: 2 });
    expect(saved2.statusCode).toBe(200);
    const review2 = (await call('owner', 'POST', '/admin/region-pools/thirstlands/validate', {})).json().data;
    expect(review2.canPublish).toBe(false);
    const blocked = await call('owner', 'POST', '/admin/region-pools/thirstlands/publish', {
      expectedDraftRevision: review2.draftRevision,
      reviewHash: review2.reviewHash,
      acknowledgedWarnings: review2.requiredAcknowledgements,
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('REGION_POOL_PUBLISH_BLOCKED');
    expect(blocked.json().error.details.issues).toEqual([
      expect.objectContaining({ id: `region_exclusive_conflict:${theirs}`, regions: ['twin-peeks'] }),
    ]);
  });

  it('404s for unknown regions and revisions, 400s for bad request shapes', async () => {
    expect((await call('owner', 'GET', '/admin/region-pools/atlantis')).json().error.code).toBe('REGION_POOL_NOT_FOUND');
    expect((await call('owner', 'GET', '/admin/region-pools/atlantis')).statusCode).toBe(404);
    expect((await call('owner', 'GET', '/admin/region-pools/twin-peeks/revisions/99')).statusCode).toBe(404);
    expect((await call('owner', 'PUT', '/admin/region-pools/twin-peeks/draft', { entries: [] })).statusCode).toBe(400);
    expect((await call('owner', 'POST', '/admin/region-pools/twin-peeks/analysis', { mode: 'filtered_selector' })).json().error.code).toBe(
      'REGION_POOL_SCENARIO_INVALID',
    );
    expect((await call('owner', 'POST', '/admin/region-pools/twin-peeks/analysis', { buddySpecies: 'nobody_at_all' })).statusCode).toBe(400);
  });
});
