/**
 * Admin web server — auth, CSRF, route wiring and the shared reload hand-off.
 * Driven with Fastify's `inject()`, so nothing binds a real port here.
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdminServer } from '../../src/admin/server';
import type { ReloadResult } from '../../src/modules/content/reloadService';
import {
  createAdminFixture,
  validItemInput,
  validSpeciesInput,
  type AdminFixture,
} from '../helpers/adminFixtures';

const TOKEN = 'super-secret-admin-token';
const HTML = { accept: 'text/html' };

let f: AdminFixture;
let app: FastifyInstance;
let reloadResult: ReloadResult;

beforeEach(async () => {
  reloadResult = {
    content: { items: [], species: [], tables: {} },
    summary: { items: 7, species: 49, disabledItems: 0, disabledSpecies: 2 },
  } as unknown as ReloadResult;
  f = createAdminFixture({ reload: async () => reloadResult });
  app = await createAdminServer({
    config: { enabled: true, host: '127.0.0.1', port: 3111, token: TOKEN },
    content: f.service,
    logger: f.logger,
  });
});

afterEach(async () => {
  await app.close();
  f.cleanup();
});

const bearer = { authorization: `Bearer ${TOKEN}` };

/** Logs in and returns the cookie header plus the CSRF value to echo back. */
async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/login',
    payload: { token: TOKEN },
  });
  expect(res.statusCode).toBe(200);
  const session = res.cookies.find((c) => c.name === 'wm_admin_session')!;
  const csrf = res.cookies.find((c) => c.name === 'wm_admin_csrf')!;
  return {
    cookie: `${session.name}=${session.value}; ${csrf.name}=${csrf.value}`,
    csrf: csrf.value,
  };
}

describe('authentication', () => {
  it('rejects every admin page without credentials', async () => {
    for (const url of ['/admin', '/admin/species', '/admin/items', '/admin/tables', '/admin/quests']) {
      const res = await app.inject({ method: 'GET', url, headers: HTML });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location).toContain('/admin/login');
    }
  });

  it('returns 401 rather than a redirect for API-style requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/species' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it('rejects a wrong bearer token and accepts the right one', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: '/admin/species',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({ method: 'GET', url: '/admin/species', headers: bearer });
    expect(good.statusCode).toBe(200);
    expect(good.body).toContain('alley_catgirl');
  });

  it('serves the login page unauthenticated and rejects a wrong token', async () => {
    const page = await app.inject({ method: 'GET', url: '/admin/login', headers: HTML });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Admin token');
    // The secret must never be rendered into the page.
    expect(page.body).not.toContain(TOKEN);

    const bad = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { token: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.cookies).toHaveLength(0);
  });

  it('sets an httpOnly, SameSite=Strict session cookie that does not contain the token', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/login', payload: { token: TOKEN } });
    const session = res.cookies.find((c) => c.name === 'wm_admin_session')!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe('Strict');
    expect(session.value).not.toContain(TOKEN);
    expect(res.json()).toMatchObject({ ok: true, redirect: '/admin' });
  });

  it('honours a safe next path and ignores an off-site one', async () => {
    const safe = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { token: TOKEN, next: '/admin/items' },
    });
    expect(safe.json().redirect).toBe('/admin/items');

    const unsafe = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { token: TOKEN, next: 'https://evil.example/steal' },
    });
    expect(unsafe.json().redirect).toBe('/admin');
  });

  it('accepts a cookie session for page loads', async () => {
    const { cookie } = await login();
    const res = await app.inject({ method: 'GET', url: '/admin', headers: { ...HTML, cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Dashboard');
  });

  it('rejects a cookie-authenticated write without the CSRF header', async () => {
    const { cookie, csrf } = await login();
    const missing = await app.inject({
      method: 'POST',
      url: '/admin/validate-content',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(403);

    const wrong = await app.inject({
      method: 'POST',
      url: '/admin/validate-content',
      headers: { cookie, 'x-admin-csrf': 'not-the-value' },
    });
    expect(wrong.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: '/admin/validate-content',
      headers: { cookie, 'x-admin-csrf': csrf },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('clears both cookies on logout', async () => {
    const { cookie, csrf } = await login();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/logout',
      headers: { cookie, 'x-admin-csrf': csrf },
    });
    expect(res.json()).toMatchObject({ ok: true, redirect: '/admin/login' });
    expect(res.cookies.map((c) => c.value)).toEqual(['', '']);
  });

  it('accepts a payload-free POST that still declares a JSON content type', async () => {
    // curl -X POST -H 'content-type: application/json' sends an empty body;
    // Fastify's stock parser would reject it.
    const res = await app.inject({
      method: 'POST',
      url: '/admin/validate-content',
      headers: { ...bearer, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('answers malformed JSON with a 400, not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/species',
      headers: { ...bearer, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });

  it('refuses to build a server without a token', async () => {
    await expect(
      createAdminServer({
        config: { enabled: true, host: '127.0.0.1', port: 3111, token: '   ' },
        content: f.service,
        logger: f.logger,
      }),
    ).rejects.toThrow(/token/i);
  });
});

describe('rendered pages', () => {
  const pages = [
    '/admin',
    '/admin/species',
    '/admin/species/new',
    '/admin/species/alley_catgirl',
    '/admin/items',
    '/admin/items/new',
    '/admin/items/basic_charm',
    '/admin/tables',
    '/admin/quests',
    '/admin/quests/new',
  ];

  it.each(pages)('renders %s with a syntactically valid page script', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: bearer });
    expect(res.statusCode).toBe(200);
    const script = /<script>([\s\S]*?)<\/script>/.exec(res.body)?.[1];
    expect(script, 'page script missing').toBeTruthy();
    // A syntax error here would silently break every form on the page.
    expect(() => new Function(script!)).not.toThrow();
    expect(res.body).not.toContain(TOKEN);
  });

  it('does not warn about a read-only content directory when it is writable', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin', headers: bearer });
    expect(res.body).not.toContain('Content directory is read-only');
  });

  it('warns on the dashboard when the content directory has gone missing', async () => {
    // Stands in for a container whose content mount is absent or read-only.
    fs.renameSync(f.contentDir, `${f.contentDir}-moved`);
    try {
      const res = await app.inject({ method: 'GET', url: '/admin', headers: bearer });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Content directory is read-only');
    } finally {
      fs.renameSync(`${f.contentDir}-moved`, f.contentDir);
    }
  });

  it('exposes every requested tables.json section as an editable block', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/tables', headers: bearer });
    for (const section of [
      'hunt',
      'capture',
      'buddyAffinity',
      'energy',
      'inventory',
      'dailyPackage',
      'duplicate',
      'progression',
      'waifuProgression',
      'dailyQuests',
      'uiFlavor',
      'uiSplash',
      'session',
    ]) {
      expect(res.body, section).toContain(`"section":"${section}"`);
    }
    // Weighted-table diagnostics are rendered alongside the editors.
    expect(res.body).toContain('total weight');
  });
});

describe('asset preview', () => {
  const asset = '/admin/assets/waifumon/alley_catgirl/standard.png';

  it('requires auth', async () => {
    expect((await app.inject({ method: 'GET', url: asset })).statusCode).toBe(401);
    const redirected = await app.inject({ method: 'GET', url: asset, headers: HTML });
    expect(redirected.statusCode).toBe(302);
  });

  it('serves an image inside the assets root when authenticated', async () => {
    const res = await app.inject({ method: 'GET', url: asset, headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('refuses traversal and non-image types', async () => {
    const escape = await app.inject({
      method: 'GET',
      url: '/admin/assets/..%2f..%2fcontent%2fitems.json',
      headers: bearer,
    });
    expect([400, 404, 415]).toContain(escape.statusCode);

    const notImage = await app.inject({
      method: 'GET',
      url: '/admin/assets/notes.txt',
      headers: bearer,
    });
    expect(notImage.statusCode).toBe(415);
  });
});

describe('species routes', () => {
  it('filters, searches and sorts the list', async () => {
    const filtered = await app.inject({
      method: 'GET',
      url: '/admin/species?rarity=N&q=catgirl',
      headers: bearer,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.body).toContain('alley_catgirl');
    expect(filtered.body).not.toContain('>shrine_assistant<');
  });

  it('creates a species and rejects a duplicate slug', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/species',
      headers: bearer,
      payload: validSpeciesInput(),
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ ok: true });
    expect(f.service.findSpecies('test_admin_waifu')).toBeDefined();

    const dup = await app.inject({
      method: 'POST',
      url: '/admin/species',
      headers: bearer,
      payload: validSpeciesInput(),
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().errors.join(' ')).toContain('already exists');
  });

  it('rejects invalid rarity, affinity, contentRating and imagePath on update', async () => {
    for (const override of [
      { rarity: 'MEGA' },
      { affinity: 'chaotic' },
      { contentRating: 'wholesome' },
      { imagePath: '../../../etc/passwd.png' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/species/alley_catgirl',
        headers: bearer,
        payload: validSpeciesInput({ slug: 'alley_catgirl', ...override }),
      });
      expect(res.statusCode, JSON.stringify(override)).toBe(400);
      expect(res.json().errors.length).toBeGreaterThan(0);
    }
    expect(f.service.findSpecies('alley_catgirl')?.species.rarity).toBe('N');
  });

  it('toggles enabled and leaves content valid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/species/alley_catgirl/toggle-enabled',
      headers: bearer,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('disabled');
    expect(f.service.findSpecies('alley_catgirl')?.species.enabled).toBe(false);
    expect(f.service.validateContent().ok).toBe(true);
  });

  it('404s an unknown slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/species/nope', headers: bearer });
    expect(res.statusCode).toBe(404);
  });
});

describe('item routes', () => {
  it('creates and updates items, rejecting schema violations', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/items',
      headers: bearer,
      payload: validItemInput(),
    });
    expect(created.statusCode).toBe(200);

    const invalid = await app.inject({
      method: 'POST',
      url: '/admin/items/test_admin_item',
      headers: bearer,
      payload: validItemInput({ purchasable: true, buyPrice: null }),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().errors.join(' ')).toContain('buy_price');
  });

  it('has no delete route — disabling is the supported path', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: '/admin/items/basic_charm',
      headers: bearer,
    });
    expect(del.statusCode).toBe(404);

    const disabled = await app.inject({
      method: 'POST',
      url: '/admin/items/basic_charm/toggle-enabled',
      headers: bearer,
    });
    expect(disabled.statusCode).toBe(200);
    expect(f.service.findItem('basic_charm')?.enabled).toBe(false);
  });

  it('shows where an item is referenced', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/items', headers: bearer });
    expect(res.body).toContain('hunt.itemFind');
    expect(res.body).toContain('dailyPackage.items');
  });
});

describe('tables and quest routes', () => {
  it('saves a section and reports warnings alongside success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tables',
      headers: bearer,
      payload: { section: 'session', value: { inactiveTimeoutMinutes: 90 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(f.service.readRaw().tables.session.inactiveTimeoutMinutes).toBe(90);
  });

  it('rejects an invalid section payload with path information', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tables',
      headers: bearer,
      payload: { section: 'session', value: { inactiveTimeoutMinutes: 'soon' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.join(' ')).toContain('inactiveTimeoutMinutes');
  });

  it('creates, edits and removes a quest in the pool', async () => {
    const quest = {
      slug: 'test_admin_quest',
      title: 'Test Quest',
      description: 'Spend energy for the test suite.',
      type: 'hunt_energy_spent',
      target: 5,
      weight: 10,
      difficulty: 'easy',
      rarityAtLeast: '',
      rewards: { waifubux: 50, essence: 0, items: [] },
    };
    const created = await app.inject({
      method: 'POST',
      url: '/admin/quests',
      headers: bearer,
      payload: quest,
    });
    expect(created.statusCode).toBe(200);
    expect(f.service.readRaw().tables.dailyQuests.pool.some((q) => q.slug === quest.slug)).toBe(
      true,
    );

    const invalid = await app.inject({
      method: 'POST',
      url: '/admin/quests/test_admin_quest',
      headers: bearer,
      payload: { ...quest, rewards: { waifubux: 0, essence: 0, items: [] } },
    });
    expect(invalid.statusCode).toBe(400);

    const badItem = await app.inject({
      method: 'POST',
      url: '/admin/quests/test_admin_quest',
      headers: bearer,
      payload: { ...quest, rewards: { waifubux: 0, essence: 0, items: [{ slug: 'ghost', quantity: 1 }] } },
    });
    expect(badItem.statusCode).toBe(400);
    expect(badItem.json().errors.join(' ')).toContain('ghost');

    const removed = await app.inject({
      method: 'POST',
      url: '/admin/quests/test_admin_quest/remove',
      headers: bearer,
    });
    expect(removed.statusCode).toBe(200);
    expect(f.service.readRaw().tables.dailyQuests.pool.some((q) => q.slug === quest.slug)).toBe(
      false,
    );
  });
});

describe('validate and reload', () => {
  it('validate-content returns counts, warnings and a summary', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/validate-content',
      headers: bearer,
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.summary.speciesTotal).toBeGreaterThan(40);
    expect(body.summary.itemsTotal).toBeGreaterThan(0);
    expect(body.summary.byRarity.length).toBeGreaterThan(0);
    expect(body.warnings.some((w: string) => w.includes('image'))).toBe(true);
    expect(body.message).toContain('species');
  });

  it('validate-content reports errors when content is broken', async () => {
    // Written straight to disk — the service itself would (correctly) refuse.
    f.writeTablesRaw({ ...f.readTables(), dailyPackage: { waifubux: 10, items: { ghost_item: 1 } } });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/validate-content',
      headers: bearer,
    });
    expect(res.json().ok).toBe(false);
    expect(res.json().errors.join(' ')).toContain('ghost_item');
  });

  it('reload-content calls the shared reloader and reports its counts', async () => {
    expect(f.reloadCalls).toBe(0);
    const res = await app.inject({ method: 'POST', url: '/admin/reload-content', headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(f.reloadCalls).toBe(1);
    expect(res.json().summary).toEqual(reloadResult.summary);
    expect(res.json().message).toContain('49 species');
  });

  it('refuses to reload while content is invalid', async () => {
    // Written straight to disk — the service itself would (correctly) refuse.
    f.writeTablesRaw({ ...f.readTables(), dailyPackage: { waifubux: 10, items: { ghost_item: 1 } } });
    const res = await app.inject({ method: 'POST', url: '/admin/reload-content', headers: bearer });
    expect(res.statusCode).toBe(400);
    expect(f.reloadCalls).toBe(0);
  });

  it('surfaces a recovery path when the reload itself fails', async () => {
    const broken = createAdminFixture({
      reload: async () => {
        throw new Error('connection refused');
      },
    });
    const brokenApp = await createAdminServer({
      config: { enabled: true, host: '127.0.0.1', port: 3111, token: TOKEN },
      content: broken.service,
      logger: broken.logger,
    });
    const res = await brokenApp.inject({
      method: 'POST',
      url: '/admin/reload-content',
      headers: bearer,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toContain('restart the bot');
    await brokenApp.close();
    broken.cleanup();
  });
});
