/**
 * The admin artwork preview routes share one implementation
 * (`api/adminArtwork.ts`) but keep separate authorization.
 *
 * Every supported format is served with its MIME type from a throwaway assets
 * directory, through both the World Encounter route (`encounters.read`) and
 * the Result Presentation route (`presentations.read`). Unsafe paths are a
 * validation error and missing files a 404, on both.
 *
 * Symlinks: a link under the assets directory whose real target is outside
 * it is refused on every byte route (including the release preview's species
 * artwork), while a link that stays inside still serves. Authorization is not
 * part of this file; see the per-area auth suites.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  ARTWORK_CONTENT_TYPES,
  SUPPORTED_ARTWORK_EXTENSIONS,
} from '../../../src/modules/assets/artworkPath';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
} from '../../helpers/platformApiFixtures';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const ROUTES = ['/api/v1/admin/encounters/artwork', '/api/v1/admin/result-presentations/artwork'];

let tmp: string;
let assetsDir: string;
let api: ZodFastify;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-admin-art-'));
  assetsDir = path.join(tmp, 'assets');
  fs.mkdirSync(path.join(assetsDir, 'results'), { recursive: true });
  for (const ext of SUPPORTED_ARTWORK_EXTENSIONS) {
    fs.writeFileSync(path.join(assetsDir, 'results', `scene.${ext}`), `bytes-${ext}`);
  }
  fs.writeFileSync(path.join(assetsDir, 'results', 'notes.txt'), 'text');
  // Outside the assets directory, and links to it from inside.
  fs.writeFileSync(path.join(tmp, 'secret.png'), 'SECRET-BYTES');
  fs.symlinkSync(path.join(tmp, 'secret.png'), path.join(assetsDir, 'results', 'escape.png'));
  fs.symlinkSync(path.join(assetsDir, 'results', 'escape.png'), path.join(assetsDir, 'results', 'escape-hop.png'));
  fs.symlinkSync(tmp, path.join(assetsDir, 'results', 'outside-dir'));
  // A link that stays inside assets.
  fs.symlinkSync(path.join(assetsDir, 'results', 'scene.webp'), path.join(assetsDir, 'results', 'alias.webp'));
  // Species art for the release preview: one ordinary, one linked out.
  fs.mkdirSync(path.join(assetsDir, 'waifumon', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'waifumon', 'alpha', 'standard.webp'), 'alpha-art');
  fs.mkdirSync(path.join(assetsDir, 'waifumon', 'beta'), { recursive: true });
  fs.symlinkSync(path.join(tmp, 'secret.png'), path.join(assetsDir, 'waifumon', 'beta', 'standard.png'));
  const ctx = createApiContext({
    content: {
      species: [
        { slug: 'alpha', name: 'Alpha', rarity: 'N', enabled: true, imagePath: 'waifumon/alpha/standard.webp' },
        { slug: 'beta', name: 'Beta', rarity: 'N', enabled: true, imagePath: 'waifumon/beta/standard.png' },
      ] as never,
    },
    services: {
      // Registration only needs the services to exist; the artwork routes
      // never call them.
      worldEncounterAdmin: {},
      resultPresentation: {},
    },
    adminBearerAllowed: true,
  });
  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3160, token: TEST_TOKEN, adminBearer: true },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: {
      ...ctx,
      assetsDir,
      portalAuthorization: { has: async () => false } as never,
    },
  });
});

afterAll(async () => {
  await api?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (route: string, p: string) =>
  api.inject({ method: 'GET', url: `${route}?path=${encodeURIComponent(p)}`, headers: AUTH });

describe.each(ROUTES)('%s', (route) => {
  it.each(SUPPORTED_ARTWORK_EXTENSIONS)('serves .%s with its MIME type', async (ext) => {
    const res = await get(route, `results/scene.${ext}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(ARTWORK_CONTENT_TYPES[ext]);
    expect(res.body).toBe(`bytes-${ext}`);
  });

  it('404s a missing file', async () => {
    const res = await get(route, 'results/absent.webp');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it.each(['../outside.png', '/etc/passwd.png', 'results\\scene.png', 'C:/scene.png', 'results/notes.txt', 'results/scene'])(
    '400s the unsafe path %s',
    async (p) => {
      const res = await get(route, p);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    },
  );
});

describe.each(ROUTES)('%s and symlinks', (route) => {
  it('serves a symlink whose target stays inside assets', async () => {
    const res = await get(route, 'results/alias.webp');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('bytes-webp');
  });

  it.each(['results/escape.png', 'results/escape-hop.png', 'results/outside-dir/secret.png'])(
    'refuses %s, which leads outside assets, without leaking its bytes or location',
    async (p) => {
      const res = await get(route, p);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(res.body).not.toContain('SECRET-BYTES');
      expect(res.body).not.toContain(tmp);
    },
  );
});

describe('release preview species artwork', () => {
  const species = (slug: string) =>
    api.inject({
      method: 'GET',
      url: `/api/v1/admin/result-presentations/preview/species-artwork?slug=${slug}`,
      headers: AUTH,
    });

  it('serves ordinary species artwork', async () => {
    const res = await species('alpha');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('alpha-art');
  });

  it('treats species artwork that links outside assets as absent', async () => {
    const res = await species('beta');
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('SECRET-BYTES');
  });
});

it('a picker thumbnail is the same byte route, so it gets the same refusal', async () => {
  // The picker never lists `escape.png`; requesting it by hand as a
  // thumbnail is just a request to the artwork route.
  const listing = await api.inject({
    method: 'GET',
    url: '/api/v1/admin/result-presentations/artwork/browse?path=results',
    headers: AUTH,
  });
  const listed = listing.json().data.files.map((f: { path: string }) => f.path);
  expect(listed).toContain('results/alias.webp');
  expect(listed).not.toContain('results/escape.png');
  for (const p of listed) expect((await get(ROUTES[1]!, p)).statusCode).toBe(200);
  expect((await get(ROUTES[1]!, 'results/escape.png')).statusCode).toBe(400);
});

it('the MIME map covers exactly the supported extensions', () => {
  expect(Object.keys(ARTWORK_CONTENT_TYPES).sort()).toEqual([...SUPPORTED_ARTWORK_EXTENSIONS].sort());
  expect(ARTWORK_CONTENT_TYPES.jpg).toBe('image/jpeg');
  expect(ARTWORK_CONTENT_TYPES.jpeg).toBe('image/jpeg');
  expect(ARTWORK_CONTENT_TYPES.gif).toBe('image/gif');
});
