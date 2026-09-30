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

const AUTH_BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555777';
const OWNER_ID = '777888999000111333';
const NON_OWNER_ID = '999999999999999998';
const NON_OWNER_TOKEN = 'token-non-owner';

let t: TestDb;
let app: App;
let api: ZodFastify;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  await provisionPlayer(app, GUILD_ID, OWNER_ID);
  await provisionPlayer(app, GUILD_ID, NON_OWNER_ID);

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

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
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
    // Before the parent links to it, a chain-only encounter is unreachable.
    const child = encounterInput('test_followup_child', []);
    child.input.huntEligible = false;
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
    const res = await call('POST', '/admin/encounters', input);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.issues[0].message).toMatch(/^Unreachable/);
  });
});
