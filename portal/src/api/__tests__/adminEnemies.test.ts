/**
 * The Enemy Catalogue client against the wire: every helper must call the
 * route the API actually serves (`/api/v1/admin/enemies...`) with the body it
 * expects. The page tests mock these helpers, so only a test at this layer
 * can catch a wrong path, a misplaced `expectedRevision` or a dropped field.
 */
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { data } from '../../../msw/handlers';
import { server } from '../../../msw/server';
import * as api from '../adminEnemies';

/** Record `METHOD path?query` and the JSON body of every request, answering each with `body`. */
function record(method: 'get' | 'post' | 'put' | 'delete', path: string, body: unknown) {
  const seen: { url: string; body: unknown }[] = [];
  server.use(
    http[method](path, async ({ request }) => {
      const url = new URL(request.url);
      seen.push({
        url: `${request.method} ${url.pathname}${url.search}`,
        body: request.method === 'GET' || request.method === 'DELETE' ? null : await request.json(),
      });
      return data(body);
    }),
  );
  return seen;
}

const ENEMY: api.EnemyInput = {
  name: 'Scrapyard Drone',
  enabled: true,
  attack: 55,
  defense: 30,
  hp: 300,
  tags: ['robotic'],
};
const DETAIL = { key: 'scrapyard_drone', revision: 4 };

describe('every helper calls the route the API serves', () => {
  it('reads', async () => {
    const list = record('get', '/api/v1/admin/enemies', { enemies: [] });
    await expect(api.listEnemies()).resolves.toEqual({ enemies: [] });
    expect(list[0]!.url).toBe('GET /api/v1/admin/enemies');

    const reference = record('get', '/api/v1/admin/enemies/reference', { enemies: [] });
    await expect(api.getEnemyReference()).resolves.toEqual({ enemies: [] });
    expect(reference[0]!.url).toBe('GET /api/v1/admin/enemies/reference');

    const exported = record('get', '/api/v1/admin/enemies/export', { file: 'combat/enemies.json' });
    await api.exportEnemies();
    expect(exported[0]!.url).toBe('GET /api/v1/admin/enemies/export');

    const one = record('get', '/api/v1/admin/enemies/:key', DETAIL);
    await expect(api.getEnemy('scrapyard_drone')).resolves.toEqual(DETAIL);
    expect(one[0]!.url).toBe('GET /api/v1/admin/enemies/scrapyard_drone');

    const references = record('get', '/api/v1/admin/enemies/:key/references', { references: [] });
    await api.getEnemyReferences('scrapyard_drone');
    expect(references[0]!.url).toBe('GET /api/v1/admin/enemies/scrapyard_drone/references');
  });

  it('validates and creates with the key beside the enemy', async () => {
    const validate = record('post', '/api/v1/admin/enemies/validate', { issues: [] });
    await expect(api.validateEnemy('scrapyard_drone', ENEMY, true)).resolves.toEqual({
      issues: [],
    });
    expect(validate[0]).toEqual({
      url: 'POST /api/v1/admin/enemies/validate',
      body: { key: 'scrapyard_drone', enemy: ENEMY, creating: true },
    });

    const create = record('post', '/api/v1/admin/enemies', DETAIL);
    await api.createEnemy('scrapyard_drone', ENEMY);
    expect(create[0]).toEqual({
      url: 'POST /api/v1/admin/enemies',
      body: { key: 'scrapyard_drone', enemy: ENEMY },
    });
  });

  it('names the revision it edited on every write', async () => {
    const update = record('put', '/api/v1/admin/enemies/:key', DETAIL);
    await api.updateEnemy('scrapyard_drone', { ...ENEMY, spriteAssetId: null }, 4);
    expect(update[0]).toEqual({
      url: 'PUT /api/v1/admin/enemies/scrapyard_drone',
      // `null` is sent as null: it clears the managed sprite back to the shipped one.
      body: { enemy: { ...ENEMY, spriteAssetId: null }, expectedRevision: 4 },
    });

    const enabled = record('put', '/api/v1/admin/enemies/:key/enabled', DETAIL);
    await api.setEnemyEnabled('scrapyard_drone', false, 4);
    expect(enabled[0]).toEqual({
      url: 'PUT /api/v1/admin/enemies/scrapyard_drone/enabled',
      body: { enabled: false, expectedRevision: 4 },
    });

    const removed = record('delete', '/api/v1/admin/enemies/:key', { ok: true });
    await expect(api.deleteEnemy('scrapyard_drone', 4)).resolves.toEqual({ ok: true });
    expect(removed[0]!.url).toBe('DELETE /api/v1/admin/enemies/scrapyard_drone?expectedRevision=4');
  });

  it('duplicates under the new key', async () => {
    const copy = record('post', '/api/v1/admin/enemies/:key/duplicate', DETAIL);
    await api.duplicateEnemy('scrapyard_drone', {
      key: 'scrapyard_drone_copy',
      copyArtwork: false,
    });
    expect(copy[0]).toEqual({
      url: 'POST /api/v1/admin/enemies/scrapyard_drone/duplicate',
      body: { key: 'scrapyard_drone_copy', copyArtwork: false },
    });
  });
});
