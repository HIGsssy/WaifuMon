/**
 * Result Presentation admin API against a real database.
 *
 * Covers what the routes *do* — CRUD, validation, artwork bytes and the
 * unsaved preview. The authorization matrix lives in
 * `tests/unit/api/resultPresentationAuth.test.ts`; this suite drives the
 * routes with the operator bearer opt-in, exactly like `adminEncounters.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { resultPresentationVariants } from '../../../src/db/schema';
import { RESULT_PRESENTATION_KEYS } from '../../../src/modules/resultPresentation/keys';
import { resolveAppearanceAssetOrLegacyPath } from '../../../src/modules/appearance/assetResolver';
import { PREVIEW_FIXTURES } from '../../../src/modules/resultPresentation/preview';
import { ASSETS_DIR, bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';
import { createGuildOwnershipService } from '../../../src/modules/portalAuth/guildOwnershipService';
import { createPortalAuthorizationService } from '../../../src/modules/portalAuth/portalAuthService';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const BASE = '/api/v1/admin/result-presentations';

let t: TestDb;
let app: App;
let api: ZodFastify;
let playerId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-rp-api', 'u-rp-api'));
  const portalAuthorization = createPortalAuthorizationService({
    guildOwnership: createGuildOwnershipService({ fetchOwnerId: async () => null }),
  });
  api = await createPlatformApiServer({
    config: {
      enabled: true,
      host: '127.0.0.1',
      port: 3150,
      token: TEST_TOKEN,
      adminBearer: true,
    },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: {
      services: app,
      getContent: () => app.content,
      assetsDir: ASSETS_DIR,
      portalAuthorization,
      adminBearerAllowed: true,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(resultPresentationVariants);
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function send(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await api.inject({
    method,
    url,
    headers: AUTH,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.json() as Json };
}

const create = (payload: Json) => send('POST', BASE, payload);
const rowCount = async () => (await t.db.select().from(resultPresentationVariants)).length;
const issuePaths = (body: Json): string[] =>
  (body.error?.details?.issues ?? []).map((i: { path: string }) => i.path);

describe('reference data', () => {
  it('serves the canonical keys, modes, limits and preview species', async () => {
    const { status, body } = await send('GET', `${BASE}/reference`);
    expect(status).toBe(200);
    const data = body.data;
    expect(data.keys.map((k: Json) => k.key)).toEqual([...RESULT_PRESENTATION_KEYS]);
    expect(data.keys.find((k: Json) => k.key === 'encounter.released')).toMatchObject({
      label: 'Waifumon Released',
      allowedArtworkModes: ['encountered', 'custom', 'none'],
      defaultArtworkMode: 'encountered',
    });
    expect(data.keys.find((k: Json) => k.key === 'hunt.waifubux_find')).toMatchObject({
      allowedArtworkModes: ['custom', 'none'],
      defaultArtworkMode: 'none',
    });
    for (const k of data.keys) {
      expect(k.fallbackDescription).toMatch(/\S/);
      expect(k.emptyFlavorDescription).toMatch(/\S/);
    }
    expect(data.flavorTextMaxLength).toBe(500);
    expect(data.supportedArtworkExtensions).toEqual(['png', 'webp', 'jpg', 'jpeg', 'gif']);
    expect(data.previewSpecies.length).toBeGreaterThan(0);
    expect(data.defaultPreviewSpeciesSlug).toBe(data.previewSpecies[0].slug);
  });
});

describe('CRUD', () => {
  it('lists all six result types, even with no variants', async () => {
    const { status, body } = await send('GET', BASE);
    expect(status).toBe(200);
    expect(body.data.groups).toHaveLength(6);
    for (const group of body.data.groups) {
      expect(group).toMatchObject({ variantCount: 0, enabledCount: 0, usingFallback: true, variants: [] });
    }
  });

  it('creates, gets, lists and counts', async () => {
    const a = await create({ presentationKey: 'hunt.waifubux_find', flavorText: '  Coins!\r\n', weight: 3 });
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({
      presentationKey: 'hunt.waifubux_find',
      flavorText: 'Coins!',
      weight: 3,
      enabled: true,
      artworkMode: 'none',
      artworkPath: null,
    });
    await create({ presentationKey: 'hunt.waifubux_find', enabled: false });

    const got = await send('GET', `${BASE}/${a.body.data.id}`);
    expect(got.body.data.flavorText).toBe('Coins!');

    const groups = (await send('GET', BASE)).body.data.groups as Json[];
    const wb = groups.find((g) => g.key === 'hunt.waifubux_find')!;
    expect(wb).toMatchObject({ variantCount: 2, enabledCount: 1, usingFallback: false });
    expect(groups.find((g) => g.key === 'hunt.nothing_found')).toMatchObject({ usingFallback: true });
  });

  it('defaults a new release variant to encountered artwork', async () => {
    const { body } = await create({ presentationKey: 'encounter.released' });
    expect(body.data.artworkMode).toBe('encountered');
  });

  it('updates text, weight and artwork, and enables/disables', async () => {
    const { body } = await create({ presentationKey: 'hunt.item_find', flavorText: 'Old' });
    const id = body.data.id;

    const edited = await send('PATCH', `${BASE}/${id}`, {
      flavorText: 'New',
      weight: 7,
      artworkMode: 'custom',
      artworkPath: 'placeholder.png',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({
      flavorText: 'New',
      weight: 7,
      artworkMode: 'custom',
      artworkPath: 'placeholder.png',
    });

    const disabled = await send('PATCH', `${BASE}/${id}`, { enabled: false });
    expect(disabled.body.data).toMatchObject({ enabled: false, flavorText: 'New', weight: 7 });
    let group = (await send('GET', BASE)).body.data.groups.find((g: Json) => g.key === 'hunt.item_find');
    expect(group).toMatchObject({ enabledCount: 0, usingFallback: true });

    const enabled = await send('PATCH', `${BASE}/${id}`, { enabled: true });
    expect(enabled.body.data.enabled).toBe(true);
    group = (await send('GET', BASE)).body.data.groups.find((g: Json) => g.key === 'hunt.item_find');
    expect(group).toMatchObject({ enabledCount: 1, usingFallback: false });

    // Leaving custom artwork clears the stored path.
    const cleared = await send('PATCH', `${BASE}/${id}`, { artworkMode: 'none' });
    expect(cleared.body.data).toMatchObject({ artworkMode: 'none', artworkPath: null });

    // Clearing the text.
    const blank = await send('PATCH', `${BASE}/${id}`, { flavorText: '   ' });
    expect(blank.body.data.flavorText).toBeNull();
  });

  it('deletes', async () => {
    const { body } = await create({ presentationKey: 'hunt.essence_find' });
    const res = await send('DELETE', `${BASE}/${body.data.id}`);
    expect(res).toMatchObject({ status: 200, body: { data: { id: body.data.id, deleted: true } } });
    expect((await send('GET', `${BASE}/${body.data.id}`)).status).toBe(404);
    expect(await rowCount()).toBe(0);
  });

  it('404s get, update and delete of a missing variant', async () => {
    expect((await send('GET', `${BASE}/999999`)).status).toBe(404);
    expect((await send('PATCH', `${BASE}/999999`, { enabled: false })).status).toBe(404);
    expect((await send('DELETE', `${BASE}/999999`)).status).toBe(404);
  });

  it('never recreates a variant deleted while someone was editing it', async () => {
    const { body } = await create({ presentationKey: 'hunt.item_find', flavorText: 'Mine' });
    await send('DELETE', `${BASE}/${body.data.id}`);
    const stale = await send('PATCH', `${BASE}/${body.data.id}`, { flavorText: 'Still mine?' });
    expect(stale.status).toBe(404);
    expect(stale.body.error.code).toBe('NOT_FOUND');
    expect(await rowCount()).toBe(0);
  });

  it('refuses to change a variant’s result type, and leaves it untouched', async () => {
    const { body } = await create({ presentationKey: 'hunt.item_find', flavorText: 'Stay' });
    const res = await send('PATCH', `${BASE}/${body.data.id}`, {
      presentationKey: 'hunt.rare_item_find',
      flavorText: 'Moved',
    });
    expect(res.status).toBe(400);
    expect(issuePaths(res.body)).toContain('presentationKey');
    const after = await send('GET', `${BASE}/${body.data.id}`);
    expect(after.body.data).toMatchObject({ presentationKey: 'hunt.item_find', flavorText: 'Stay' });
  });

  it('refuses an empty edit and unknown fields', async () => {
    const { body } = await create({ presentationKey: 'hunt.item_find' });
    expect((await send('PATCH', `${BASE}/${body.data.id}`, {})).status).toBe(400);
    expect((await send('PATCH', `${BASE}/${body.data.id}`, { amount: 99 })).status).toBe(400);
    expect((await create({ presentationKey: 'hunt.item_find', amount: 99 })).status).toBe(400);
  });

  it.each([
    [{ presentationKey: 'hunt.jackpot' }, 'presentationKey'],
    [{ presentationKey: 'hunt.item_find', weight: 0 }, 'weight'],
    [{ presentationKey: 'hunt.item_find', weight: 2.5 }, 'weight'],
    [{ presentationKey: 'hunt.item_find', flavorText: 'x'.repeat(501) }, 'flavorText'],
    [{ presentationKey: 'hunt.item_find', artworkMode: 'encountered' }, 'artworkMode'],
    [{ presentationKey: 'hunt.item_find', artworkMode: 'banner' }, 'artworkMode'],
    [{ presentationKey: 'hunt.item_find', artworkMode: 'custom' }, 'artworkPath'],
    [{ presentationKey: 'hunt.item_find', artworkMode: 'custom', artworkPath: '../x.png' }, 'artworkPath'],
    [{ presentationKey: 'hunt.item_find', artworkMode: 'custom', artworkPath: 'x.svg' }, 'artworkPath'],
  ])('rejects %j with a field issue on %s', async (payload, path) => {
    const res = await create(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(issuePaths(res.body)).toContain(path);
    expect(await rowCount()).toBe(0);
  });

  it('rejects invalid edits with the same rules', async () => {
    const { body } = await create({ presentationKey: 'hunt.item_find', flavorText: 'Keep' });
    const res = await send('PATCH', `${BASE}/${body.data.id}`, { weight: -1 });
    expect(res.status).toBe(400);
    expect(issuePaths(res.body)).toContain('weight');
    expect((await send('GET', `${BASE}/${body.data.id}`)).body.data.weight).toBe(1);
  });

  it('writes are visible to the runtime in this process immediately', async () => {
    const svc = app.resultPresentation;
    const { body } = await create({ presentationKey: 'hunt.nothing_found', flavorText: 'Crows.' });
    expect((await svc.resolve('hunt.nothing_found')).flavorText).toBe('Crows.');
    await send('PATCH', `${BASE}/${body.data.id}`, { enabled: false });
    expect((await svc.resolve('hunt.nothing_found', { fallbackFlavorLines: ['pool'] })).usedFallback).toBe(true);
  });
});

describe('artwork preview bytes', () => {
  it('serves an existing image with its MIME type', async () => {
    const res = await api.inject({ method: 'GET', url: `${BASE}/artwork?path=placeholder.png`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('404s a missing file and 400s an unsafe or non-image path', async () => {
    const at = (path: string) =>
      api.inject({ method: 'GET', url: `${BASE}/artwork?path=${encodeURIComponent(path)}`, headers: AUTH });
    expect((await at('encounters/definitely_absent.webp')).statusCode).toBe(404);
    expect((await at('../../etc/passwd')).statusCode).toBe(400);
    expect((await at('../package.json')).statusCode).toBe(400);
    expect((await at('C:/Windows/win.ini')).statusCode).toBe(400);
  });
});

describe('unsaved preview', () => {
  const preview = (variant: Json, previewSpeciesSlug?: string) =>
    send('POST', `${BASE}/preview`, {
      variant,
      ...(previewSpeciesSlug === undefined ? {} : { previewSpeciesSlug }),
    });

  it('renders every hunt key with backend-owned sample values', async () => {
    const expected: Record<string, { title: string; mechanical: string | null }> = {
      'hunt.waifubux_find': { title: '💰 WaifuBux Found', mechanical: '+**12** WaifuBux (balance: 1284)' },
      'hunt.essence_find': { title: '✨ Essence Found', mechanical: '+**24** Essence (balance: 640)' },
      'hunt.item_find': { title: '🎒 Item Found', mechanical: '🩷 **Basic Charm** ×1' },
      'hunt.rare_item_find': { title: '🌟 Rare Find!', mechanical: '💜 **Velvet Charm** ×1' },
      'hunt.nothing_found': { title: '🍃 Nothing but wind…', mechanical: null },
    };
    for (const [key, want] of Object.entries(expected)) {
      const { status, body } = await preview({ presentationKey: key, flavorText: 'Authored words.' });
      expect(status).toBe(200);
      const data = body.data;
      expect(data.screen.title).toBe(want.title);
      expect(data.screen.footer).toBe('Energy left: 18');
      expect(data.screen.sections[0]).toEqual({ kind: 'flavor', text: 'Authored words.', sample: false });
      const mechanical = data.screen.sections.find((s: Json) => s.kind === 'mechanical');
      if (want.mechanical) {
        expect(mechanical).toEqual({ kind: 'mechanical', text: want.mechanical, sample: true });
      } else {
        expect(mechanical).toBeUndefined();
      }
      expect(data.sampleNotice).toMatch(/Sample gameplay values/);
      expect(data.artwork).toEqual({ mode: 'none' });
    }
    // The fixtures are the server's constants, not request input.
    expect(PREVIEW_FIXTURES['hunt.waifubux_find']).toMatchObject({ amount: 12, balanceAfter: 1284 });
  });

  it('shows the fallback pool line and explains it for a text-less "nothing found"', async () => {
    const { body } = await preview({ presentationKey: 'hunt.nothing_found' });
    expect(body.data.screen.description).toBe(app.content.tables.hunt.flavor[0]);
    expect(body.data.flavorSource).toBe('fallback');
    expect(body.data.flavorNote).toMatch(/random line/);
  });

  it('reports custom artwork status without failing the preview', async () => {
    const ok = await preview({ presentationKey: 'hunt.item_find', artworkMode: 'custom', artworkPath: 'placeholder.png' });
    expect(ok.body.data.artwork).toEqual({ mode: 'custom', path: 'placeholder.png', status: 'available' });
    const missing = await preview({
      presentationKey: 'hunt.item_find',
      artworkMode: 'custom',
      artworkPath: 'encounters/not_there.webp',
    });
    expect(missing.status).toBe(200);
    expect(missing.body.data.artwork).toMatchObject({ mode: 'custom', status: 'missing' });
  });

  it('validates with the write rules', async () => {
    const bad = await preview({ presentationKey: 'hunt.item_find', artworkMode: 'custom', artworkPath: '../x.png' });
    expect(bad.status).toBe(400);
    expect(issuePaths(bad.body)).toContain('artworkPath');
    expect((await preview({ presentationKey: 'hunt.item_find', artworkMode: 'encountered' })).status).toBe(400);
    expect((await preview({ presentationKey: 'hunt.nope' })).status).toBe(400);
    expect((await preview({ presentationKey: 'hunt.item_find', flavorText: 'x'.repeat(501) })).status).toBe(400);
  });

  it('refuses author-supplied gameplay values and stored-only fields', async () => {
    expect((await preview({ presentationKey: 'hunt.waifubux_find', amount: 999 })).status).toBe(400);
    expect((await preview({ presentationKey: 'hunt.waifubux_find', weight: 5 })).status).toBe(400);
    const extraTop = await send('POST', `${BASE}/preview`, {
      variant: { presentationKey: 'hunt.waifubux_find' },
      sample: { amount: 999 },
    });
    expect(extraTop.status).toBe(400);
  });

  it('shows the form’s variant only — no weighted selection among stored ones', async () => {
    await create({ presentationKey: 'hunt.waifubux_find', flavorText: 'STORED A', weight: 1000 });
    await create({ presentationKey: 'hunt.waifubux_find', flavorText: 'STORED B', weight: 1000 });
    const resolve = vi.spyOn(app.resultPresentation, 'resolve');
    for (let n = 0; n < 10; n++) {
      const { body } = await preview({ presentationKey: 'hunt.waifubux_find', flavorText: 'FORM' });
      expect(body.data.screen.description).toContain('FORM');
      expect(body.data.screen.description).not.toContain('STORED');
    }
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockRestore();
  });

  it('persists nothing and touches no gameplay state', async () => {
    const hunt = vi.spyOn(app.hunt, 'hunt');
    const letHerGo = vi.spyOn(app.hunt, 'letHerGo');
    const before = await app.currency.getBalances(playerId);
    const rowsBefore = await rowCount();
    for (const key of RESULT_PRESENTATION_KEYS) {
      await preview({ presentationKey: key, flavorText: 'Preview only' });
    }
    expect(await rowCount()).toBe(rowsBefore);
    expect(await app.currency.getBalances(playerId)).toEqual(before);
    expect(hunt).not.toHaveBeenCalled();
    expect(letHerGo).not.toHaveBeenCalled();
    hunt.mockRestore();
    letHerGo.mockRestore();
  });

  describe('release', () => {
    /** An enabled species whose release artwork really resolves. */
    function speciesWithArt(): { slug: string; name: string } {
      for (const sp of app.content.species) {
        if (sp.enabled === false) continue;
        const current = app.appearance.currentAppearance(sp, null);
        if (resolveAppearanceAssetOrLegacyPath({ assetsDir: ASSETS_DIR }, current.assetId, sp.imagePath)) {
          return { slug: sp.slug, name: sp.name };
        }
      }
      throw new Error('no species with resolvable artwork in shipped content');
    }

    it('encountered mode shows the chosen preview Waifumon and serves her art', async () => {
      const sp = speciesWithArt();
      const { status, body } = await preview(
        { presentationKey: 'encounter.released', artworkMode: 'encountered' },
        sp.slug,
      );
      expect(status).toBe(200);
      expect(body.data.screen.title).toBe(`👋 You let ${sp.name} go`);
      expect(body.data.screen.description).toBe('You let her slip back into the neon~');
      expect(body.data.screen.footer).toBeNull();
      expect(body.data.artwork).toMatchObject({ mode: 'encountered', available: true, species: { slug: sp.slug } });

      const art = await api.inject({
        method: 'GET',
        url: `${BASE}/preview/species-artwork?slug=${sp.slug}`,
        headers: AUTH,
      });
      expect(art.statusCode).toBe(200);
      expect(art.headers['content-type']).toMatch(/^image\//);
    });

    it('defaults to the first preview species and never stores it', async () => {
      const ref = (await send('GET', `${BASE}/reference`)).body.data;
      const { body } = await preview({ presentationKey: 'encounter.released' });
      expect(body.data.previewSpecies.slug).toBe(ref.defaultPreviewSpeciesSlug);
      expect(await rowCount()).toBe(0);
    });

    it('custom and none modes', async () => {
      const custom = await preview({
        presentationKey: 'encounter.released',
        artworkMode: 'custom',
        artworkPath: 'placeholder.png',
      });
      expect(custom.body.data.artwork).toMatchObject({ mode: 'custom', status: 'available' });
      const none = await preview({ presentationKey: 'encounter.released', artworkMode: 'none' });
      expect(none.body.data.artwork).toEqual({ mode: 'none' });
    });

    it('rejects an unknown preview Waifumon, and one on a hunt key', async () => {
      expect((await preview({ presentationKey: 'encounter.released' }, 'no_such_waifu')).status).toBe(400);
      const sp = speciesWithArt();
      expect((await preview({ presentationKey: 'hunt.item_find' }, sp.slug)).status).toBe(400);
    });

    it('404s artwork for an unknown species', async () => {
      const res = await api.inject({
        method: 'GET',
        url: `${BASE}/preview/species-artwork?slug=no_such_waifu`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe('a refused write', () => {
  it('leaves no rows behind after a failed create', async () => {
    await create({ presentationKey: 'hunt.item_find', weight: -5 });
    const rows = await t.db
      .select()
      .from(resultPresentationVariants)
      .where(eq(resultPresentationVariants.presentationKey, 'hunt.item_find'));
    expect(rows).toHaveLength(0);
  });
});
