/**
 * The admin artwork preview routes share one implementation
 * (`api/adminArtwork.ts`) but keep separate authorization.
 *
 * Every supported format is served with its MIME type from a throwaway assets
 * directory, through both the World Encounter route (`encounters.read`) and
 * the Result Presentation route (`presentations.read`). Unsafe paths are a
 * validation error and missing files a 404, on both.
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

let assetsDir: string;
let api: ZodFastify;

beforeAll(async () => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-admin-art-'));
  fs.mkdirSync(path.join(assetsDir, 'results'));
  for (const ext of SUPPORTED_ARTWORK_EXTENSIONS) {
    fs.writeFileSync(path.join(assetsDir, 'results', `scene.${ext}`), `bytes-${ext}`);
  }
  fs.writeFileSync(path.join(assetsDir, 'results', 'notes.txt'), 'text');
  const ctx = createApiContext({
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
  fs.rmSync(assetsDir, { recursive: true, force: true });
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

it('the MIME map covers exactly the supported extensions', () => {
  expect(Object.keys(ARTWORK_CONTENT_TYPES).sort()).toEqual([...SUPPORTED_ARTWORK_EXTENSIONS].sort());
  expect(ARTWORK_CONTENT_TYPES.jpg).toBe('image/jpeg');
  expect(ARTWORK_CONTENT_TYPES.jpeg).toBe('image/jpeg');
  expect(ARTWORK_CONTENT_TYPES.gif).toBe('image/gif');
});
