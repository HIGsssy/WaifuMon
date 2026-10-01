/**
 * Portal admin — World Encounter vendor authoring, against a real database.
 *
 * Covers what the vendor editor relies on: list with stock and referencing
 * encounters, create/edit/delete, the stock rules (known items, one line per
 * item), the immutable key, refusing to delete a vendor in use, and that a
 * vendor authored here travels in an encounter export exactly as a seeded one
 * does. Also pins the encounter routes' refusal shape: a rule the author can
 * fix (an unreachable encounter) is a 400 with issues, not a 500.
 *
 * Driven with the bearer token under `adminBearer: true`, like
 * `adminEncounters.test.ts`; permission is checked with a non-owner session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';
import { createEncounterPromotionService } from '../../../src/modules/worldEncounters/encounterImportService';
import { activeWorldEncounters, worldEncounterHistory } from '../../../src/db/schema';

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555777';
const OWNER_ID = '777888999000111333';
const NON_OWNER_ID = '999999999999999998';
const NON_OWNER_TOKEN = 'token-non-owner';

let t: TestDb;
let app: App;
let api: ZodFastify;
let guildDbId: number;
let ownerPlayerId: number;
let nonOwnerPlayerId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ guildDbId, playerId: ownerPlayerId } = await provisionPlayer(app, GUILD_ID, OWNER_ID));
  ({ playerId: nonOwnerPlayerId } = await provisionPlayer(app, GUILD_ID, NON_OWNER_ID));

  const guildOwnership = createGuildOwnershipService({ fetchOwnerId: async () => OWNER_ID });
  const portalAuthorization = createPortalAuthorizationService({ guildOwnership });
  const encounterPromotion = createEncounterPromotionService({
    db: t.db,
    getContent: () => app.content,
  });

  const nonOwner: PortalSession = {
    sessionDigest: 'digest',
    discordUserId: NON_OWNER_ID,
    discordUsername: null,
    discordAvatarUrl: null,
    selectedDiscordGuildId: GUILD_ID,
    selectedGuildDbId: 1,
    playerId: 1,
    eligibleGuilds: [],
    csrfToken: 'csrf-token',
    expiresAt: new Date(Date.now() + 60_000),
  };
  const sessions = {
    getSession: async (token: string | undefined) => (token === NON_OWNER_TOKEN ? nonOwner : null),
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
    config: {
      enabled: true,
      host: '127.0.0.1',
      port: 3133,
      token: TEST_TOKEN,
      adminBearer: true,
    },
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
      services: { ...app, encounterPromotion },
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

interface VendorResource {
  vendorKey: string;
  name: string;
  description: string;
  stock: Array<{ itemSlug: string; quantity: number; price: number; currency: string }>;
  usedBy: Array<{ slug: string; name: string; lifecycle: string }>;
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  api.inject({
    method,
    url: `/api/v1${url}`,
    headers: AUTH_BEARER,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

function encounterInput(slug: string, effects: unknown[]) {
  return {
    input: {
      slug,
      name: slug,
      description: '',
      type: 'vendor',
      rarity: 'common',
      weight: 1,
      lifecycle: 'draft',
      huntEligible: true,
      travelEligible: false,
      cooldownSeconds: 0,
      artworkPath: null,
      chainedEncounterSlug: null,
      choicesRequired: true,
      regions: [],
      routes: [],
      metadata: {},
      choices: [{ label: 'Browse', check: { type: 'none' }, successEffects: effects, failureEffects: [] }],
    },
  };
}

describe('vendor list', () => {
  it('lists the seeded Wandering Merchant with its stock and the encounter that opens it', async () => {
    const res = await call('GET', '/admin/vendors');
    expect(res.statusCode).toBe(200);
    const vendors = (res.json() as { data: { vendors: VendorResource[] } }).data.vendors;
    const merchant = vendors.find((v) => v.vendorKey === 'wandering_merchant');
    expect(merchant).toBeDefined();
    expect(merchant!.stock).toEqual([
      { itemSlug: 'basic_charm', quantity: 3, price: 150, currency: 'waifubux' },
      { itemSlug: 'silk_charm', quantity: 1, price: 900, currency: 'waifubux' },
    ]);
    expect(merchant!.usedBy.map((e) => e.slug)).toContain('tv_wandering_merchant');
  });

  it('is refused without auth, and to a portal user without encounter permissions', async () => {
    expect((await api.inject({ method: 'GET', url: '/api/v1/admin/vendors' })).statusCode).toBe(401);
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/admin/vendors',
      cookies: { wm_portal_session: NON_OWNER_TOKEN },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('vendor authoring', () => {
  it('creates, edits and reads back a vendor with per-vendor prices', async () => {
    const created = await call('POST', '/admin/vendors', {
      vendorKey: 'test_tinker',
      name: 'Test Tinker',
      description: 'Sells odds and ends.',
      stock: [{ itemSlug: 'basic_charm', quantity: 2, price: 75, currency: 'waifubux' }],
    });
    expect(created.statusCode).toBe(200);
    expect((created.json() as { data: VendorResource }).data.usedBy).toEqual([]);

    const updated = await call('PUT', '/admin/vendors/test_tinker', {
      name: 'Test Tinker II',
      description: '',
      stock: [
        { itemSlug: 'silk_charm', quantity: 1, price: 500, currency: 'essence' },
        { itemSlug: 'basic_charm', quantity: 5, price: 60, currency: 'waifubux' },
      ],
    });
    expect(updated.statusCode).toBe(200);

    const read = await call('GET', '/admin/vendors/test_tinker');
    const vendor = (read.json() as { data: VendorResource }).data;
    expect(vendor.name).toBe('Test Tinker II');
    // Order is preserved — it is the order the shop lists its wares in.
    expect(vendor.stock.map((s) => [s.itemSlug, s.price, s.currency])).toEqual([
      ['silk_charm', 500, 'essence'],
      ['basic_charm', 60, 'waifubux'],
    ]);
  });

  it('refuses a key that is already taken, without touching the existing vendor', async () => {
    const res = await call('POST', '/admin/vendors', {
      vendorKey: 'wandering_merchant',
      name: 'Impostor',
      stock: [],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VENDOR_KEY_TAKEN');
    const read = await call('GET', '/admin/vendors/wandering_merchant');
    expect((read.json() as { data: VendorResource }).data.name).toBe('The Wandering Merchant');
  });

  it('refuses unknown items and a second line for the same item', async () => {
    const unknown = await call('POST', '/admin/vendors', {
      vendorKey: 'test_bad_stock',
      name: 'Bad Stock',
      stock: [{ itemSlug: 'no_such_item', quantity: 1, price: 10, currency: 'waifubux' }],
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.details.issues[0].path).toBe('/stock/0/itemSlug');

    const duplicate = await call('POST', '/admin/vendors', {
      vendorKey: 'test_bad_stock',
      name: 'Bad Stock',
      stock: [
        { itemSlug: 'basic_charm', quantity: 1, price: 10, currency: 'waifubux' },
        { itemSlug: 'basic_charm', quantity: 1, price: 20, currency: 'waifubux' },
      ],
    });
    expect(duplicate.statusCode).toBe(400);
    expect((await call('GET', '/admin/vendors/test_bad_stock')).statusCode).toBe(404);
  });

  it('404s an update to a vendor that does not exist rather than creating it', async () => {
    const res = await call('PUT', '/admin/vendors/test_ghost', { name: 'Ghost', stock: [] });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to delete a vendor an encounter opens, then deletes it once unlinked', async () => {
    await call('POST', '/admin/vendors', { vendorKey: 'test_popup', name: 'Pop-up', stock: [] });
    const enc = await call(
      'POST',
      '/admin/encounters',
      encounterInput('test_popup_stall', [{ type: 'open_vendor', vendorKey: 'test_popup' }]),
    );
    expect(enc.statusCode).toBe(200);

    const refused = await call('DELETE', '/admin/vendors/test_popup');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('VENDOR_IN_USE');

    const id = (enc.json() as { data: { id: number } }).data.id;
    await call('PUT', `/admin/encounters/${id}`, encounterInput('test_popup_stall', []));
    expect((await call('DELETE', '/admin/vendors/test_popup')).statusCode).toBe(200);
    expect((await call('GET', '/admin/vendors/test_popup')).statusCode).toBe(404);
  });

  it('is refused to a portal user without encounters.write', async () => {
    const res = await api.inject({
      method: 'POST',
      url: '/api/v1/admin/vendors',
      cookies: { wm_portal_session: NON_OWNER_TOKEN, wm_portal_csrf: 'csrf-token' },
      headers: { 'x-csrf-token': 'csrf-token' },
      payload: { vendorKey: 'test_denied', name: 'Denied', stock: [] },
    });
    expect([401, 403]).toContain(res.statusCode);
    expect((await call('GET', '/admin/vendors/test_denied')).statusCode).toBe(404);
  });
});

describe('vendors in content promotion', () => {
  it('exports an admin-authored vendor alongside the encounter that opens it', async () => {
    await call('POST', '/admin/vendors', {
      vendorKey: 'test_exported',
      name: 'Exported',
      stock: [{ itemSlug: 'basic_charm', quantity: 4, price: 99, currency: 'waifubux' }],
    });
    await call(
      'POST',
      '/admin/encounters',
      encounterInput('test_exported_stall', [{ type: 'open_vendor', vendorKey: 'test_exported' }]),
    );
    const res = await call('GET', '/admin/encounters/export?slugs=test_exported_stall');
    expect(res.statusCode).toBe(200);
    const pkg = res.json().data as { vendors: Array<{ vendorKey: string; stockTemplate: unknown }> };
    expect(pkg.vendors).toEqual([
      {
        vendorKey: 'test_exported',
        name: 'Exported',
        description: '',
        stockTemplate: [{ itemSlug: 'basic_charm', quantity: 4, price: 99, currency: 'waifubux' }],
      },
    ]);
  });
});

describe('encounter create never overwrites', () => {
  it('creates a new slug, refuses an existing one with 409, and leaves the original untouched', async () => {
    const first = await call('POST', '/admin/encounters', encounterInput('test_conflict', []));
    expect(first.statusCode).toBe(200);
    const id = (first.json() as { data: { id: number } }).data.id;

    const again = encounterInput('test_conflict', []);
    again.input.name = 'Impostor';
    const refused = await call('POST', '/admin/encounters', again);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('ENCOUNTER_SLUG_TAKEN');

    const read = await call('GET', `/admin/encounters/${id}`);
    expect((read.json() as { data: { name: string } }).data.name).toBe('test_conflict');
  });

  it('still updates an existing encounter through PUT', async () => {
    const created = await call('POST', '/admin/encounters', encounterInput('test_update_path', []));
    const id = (created.json() as { data: { id: number } }).data.id;
    const edit = encounterInput('test_update_path', []);
    edit.input.name = 'Renamed';
    const res = await call('PUT', `/admin/encounters/${id}`, edit);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { id: number; name: string } }).data).toMatchObject({ id, name: 'Renamed' });
  });

  it('clones to a new slug, and refuses to clone over an existing one', async () => {
    const created = await call('POST', '/admin/encounters', encounterInput('test_clone_src', []));
    const id = (created.json() as { data: { id: number } }).data.id;
    const cloned = await call('POST', `/admin/encounters/${id}/clone`, { newSlug: 'test_clone_copy' });
    expect(cloned.statusCode).toBe(200);
    expect((cloned.json() as { data: { slug: string; lifecycle: string } }).data).toMatchObject({
      slug: 'test_clone_copy',
      lifecycle: 'draft',
    });

    const over = await call('POST', `/admin/encounters/${id}/clone`, { newSlug: 'tv_wandering_merchant' });
    expect(over.statusCode).toBe(409);
    const merchant = await call('GET', '/admin/encounters');
    const shipped = (merchant.json() as { data: { encounters: Array<{ slug: string; name: string }> } }).data.encounters.find(
      (e) => e.slug === 'tv_wandering_merchant',
    );
    expect(shipped!.name).not.toContain('(copy)');
  });
});

describe('encounter writes the Portal editor relies on', () => {
  it('accepts a chain-only follow-up once its parent links to it (the "create follow-up" order)', async () => {
    // Before the parent links to it, an active chain-only encounter is unreachable.
    const child = encounterInput('test_followup_child', []);
    child.input.huntEligible = false;
    child.input.lifecycle = 'active';
    expect((await call('POST', '/admin/encounters', child)).statusCode).toBe(400);

    const parent = await call(
      'POST',
      '/admin/encounters',
      encounterInput('test_followup_parent', [
        { type: 'trigger_encounter', encounterSlug: 'test_followup_child' },
      ]),
    );
    expect(parent.statusCode).toBe(200);
    expect((await call('POST', '/admin/encounters', child)).statusCode).toBe(200);
  });


  it('reports an unreachable encounter as a 400 with issues, not a 500', async () => {
    const input = encounterInput('test_unreachable', []);
    input.input.huntEligible = false;
    input.input.lifecycle = 'active';
    const res = await call('POST', '/admin/encounters', input);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.issues[0].message).toMatch(/^Unreachable/);
  });
});

describe('reachability only gates active encounters', () => {
  const idOf = (res: { json: () => unknown }) => (res.json() as { data: { id: number } }).data.id;

  it('saves a draft or disabled chain node with no Hunt/Travel and no parent yet', async () => {
    for (const lifecycle of ['draft', 'disabled']) {
      const node = encounterInput(`test_inert_${lifecycle}`, []);
      node.input.huntEligible = false;
      node.input.lifecycle = lifecycle;
      const created = await call('POST', '/admin/encounters', node);
      expect(created.statusCode).toBe(200);
      // And edits keep saving while it stays inactive.
      node.input.name = 'Renamed';
      expect((await call('PUT', `/admin/encounters/${idOf(created)}`, node)).statusCode).toBe(200);
    }
  });

  it('refuses to activate an unreachable encounter, through PUT and through the lifecycle switch', async () => {
    const node = encounterInput('test_inert_activate', []);
    node.input.huntEligible = false;
    const id = idOf(await call('POST', '/admin/encounters', node));

    node.input.lifecycle = 'active';
    const put = await call('PUT', `/admin/encounters/${id}`, node);
    expect(put.statusCode).toBe(400);
    expect(put.json().error.details.issues[0].message).toMatch(/^Unreachable/);

    const patch = await call('PATCH', `/admin/encounters/${id}/lifecycle`, { lifecycle: 'active' });
    expect(patch.statusCode).toBe(400);
    expect(patch.json().error.details.issues[0].message).toMatch(/^Unreachable/);
    const read = await call('GET', `/admin/encounters/${id}`);
    expect((read.json() as { data: { lifecycle: string } }).data.lifecycle).toBe('draft');

    // Once something continues to it, activation goes through.
    await call(
      'POST',
      '/admin/encounters',
      encounterInput('test_inert_activate_parent', [
        { type: 'trigger_encounter', encounterSlug: 'test_inert_activate' },
      ]),
    );
    expect(
      (await call('PATCH', `/admin/encounters/${id}/lifecycle`, { lifecycle: 'active' })).statusCode,
    ).toBe(200);
  });
});

describe('encounter delete', () => {
  const idOf = (res: { json: () => unknown }) => (res.json() as { data: { id: number } }).data.id;
  const create = async (slug: string, effects: unknown[] = [], chained: string | null = null) => {
    const body = encounterInput(slug, effects);
    (body.input as { chainedEncounterSlug: string | null }).chainedEncounterSlug = chained;
    const res = await call('POST', '/admin/encounters', body);
    expect(res.statusCode).toBe(200);
    return idOf(res);
  };
  const session = (encounterId: number, playerId: number, status: string, continuationOfId?: number) =>
    t.db
      .insert(activeWorldEncounters)
      .values({
        playerId,
        encounterId,
        source: 'hunt',
        regionId: 'waifu-valley',
        guildId: guildDbId,
        channelId: 'c-1',
        status,
        contextJson: {},
        expiresAt: new Date(Date.now() + 10 * 60_000),
        continuationOfId: continuationOfId ?? null,
      })
      .returning()
      .then((rows) => rows[0]!);
  const exists = async (id: number) => (await call('GET', `/admin/encounters/${id}`)).statusCode === 200;

  interface Blockers {
    referencedBy: Array<{ slug: string; name: string; via: string; choiceLabel: string | null }>;
    historyCount: number;
    pendingCount: number;
    queuedContinuationCount: number;
    closedSessionCount: number;
  }
  const refusal = (res: { json: () => unknown }) =>
    (res.json() as { error: { code: string; message: string; details: { blockers: Blockers } } }).error;

  it('deletes an encounter nothing references', async () => {
    const id = await create('test_delete_free');
    const res = await call('DELETE', `/admin/encounters/${id}`);
    expect(res.statusCode).toBe(200);
    expect(await exists(id)).toBe(false);
  });

  it('refuses with 409 naming every encounter that continues to it', async () => {
    const target = await create('test_delete_linked');
    await create('test_delete_by_choice', [{ type: 'trigger_encounter', encounterSlug: 'test_delete_linked' }]);
    await create('test_delete_by_column', [], 'test_delete_linked');

    const res = await call('DELETE', `/admin/encounters/${target}`);
    expect(res.statusCode).toBe(409);
    const error = refusal(res);
    expect(error.code).toBe('ENCOUNTER_DELETE_UNSAFE');
    expect(error.message).toContain('"test_delete_by_choice"');
    expect(error.message).toContain('"test_delete_by_column"');
    expect(error.details.blockers.referencedBy).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'test_delete_by_choice', via: 'choice', choiceLabel: 'Browse' }),
        expect.objectContaining({ slug: 'test_delete_by_column', via: 'after_any_choice', choiceLabel: null }),
      ]),
    );
    expect(error.details.blockers.referencedBy).toHaveLength(2);
    expect(await exists(target)).toBe(true);
  });

  it('refuses a queued follow-up target with 409 rather than a foreign-key 500', async () => {
    const parent = await create('test_delete_queue_parent');
    const target = await create('test_delete_queue_target');
    const parentRow = await session(parent, ownerPlayerId, 'resolved');
    await session(target, ownerPlayerId, 'pending', parentRow.id);

    const res = await call('DELETE', `/admin/encounters/${target}`);
    expect(res.statusCode).toBe(409);
    const { blockers } = refusal(res).details;
    expect(blockers).toMatchObject({
      referencedBy: [],
      pendingCount: 1,
      queuedContinuationCount: 1,
      historyCount: 0,
      closedSessionCount: 0,
    });
    expect(refusal(res).message).toMatch(/1 player has it open \(1 queued as a chain follow-up\)/);
    expect(await exists(target)).toBe(true);
  });

  it('refuses when only past sessions or history remain, and says to disable instead', async () => {
    const target = await create('test_delete_played');
    await session(target, nonOwnerPlayerId, 'expired');
    const expired = await call('DELETE', `/admin/encounters/${target}`);
    expect(expired.statusCode).toBe(409);
    expect(refusal(expired).details.blockers.closedSessionCount).toBe(1);
    expect(refusal(expired).message).toMatch(/Disable it instead/);

    await t.db.insert(worldEncounterHistory).values({
      playerId: nonOwnerPlayerId,
      encounterId: target,
      source: 'hunt',
      regionId: 'waifu-valley',
      startedAt: new Date(),
    });
    const played = await call('DELETE', `/admin/encounters/${target}`);
    expect(played.statusCode).toBe(409);
    expect(refusal(played).details.blockers.historyCount).toBe(1);
    expect(refusal(played).message).toMatch(/1 recorded play in history/);
    expect(await exists(target)).toBe(true);
  });
});
