/**
 * The managed-artwork client against the wire: every helper must call the
 * route the API actually serves (`/api/v1/admin/...`). The page tests mock
 * these helpers, so only a test at this layer can catch a wrong path — which
 * is exactly how a missing `/v1` once reached a deployed Portal as
 * "Could not load artwork" on an empty library.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { data } from '../../../msw/handlers';
import { server } from '../../../msw/server';
import * as api from '../adminArtworkAssets';

const ID = '3f2b8c1e-9a4d-4e7b-8c1a-2b3c4d5e6f70';
const ASSET = { id: ID, name: 'Scrap Night', contentHash: 'a'.repeat(64) };

/** Record `METHOD path?query` for every request, answering each with `body`. */
function record(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  body: unknown,
  binary = false,
) {
  const seen: { url: string; contentType: string | null }[] = [];
  server.use(
    http[method](path, ({ request }) => {
      const url = new URL(request.url);
      seen.push({
        url: `${request.method} ${url.pathname}${url.search}`,
        contentType: request.headers.get('content-type'),
      });
      return binary
        ? new HttpResponse(new Blob(['bytes']), { headers: { 'content-type': 'image/webp' } })
        : data(body);
    }),
  );
  return seen;
}

describe('an empty library', () => {
  it('is a successful, empty list — not an error', async () => {
    const seen = record('get', '/api/v1/admin/artwork/assets', { assets: [], total: 0 });
    await expect(api.listArtworkAssets({ limit: 120 })).resolves.toEqual({ assets: [], total: 0 });
    expect(seen.map((s) => s.url)).toEqual(['GET /api/v1/admin/artwork/assets?limit=120']);
  });
});

describe('every helper calls the route the API serves', () => {
  it('reads', async () => {
    const list = record('get', '/api/v1/admin/artwork/assets', { assets: [], total: 0 });
    await api.listArtworkAssets({
      category: 'enemy_sprite',
      status: 'active',
      q: ' drone ',
      limit: 60,
    });
    expect(list[0]!.url).toBe(
      'GET /api/v1/admin/artwork/assets?category=enemy_sprite&status=active&q=drone&limit=60',
    );

    const meta = record('get', '/api/v1/admin/artwork/meta', api.FALLBACK_ARTWORK_META);
    await api.getArtworkMeta();
    expect(meta[0]!.url).toBe('GET /api/v1/admin/artwork/meta');

    const one = record('get', '/api/v1/admin/artwork/assets/:id', {
      asset: ASSET,
      references: [],
      events: [],
    });
    await api.getArtworkAsset(ID);
    expect(one[0]!.url).toBe(`GET /api/v1/admin/artwork/assets/${ID}`);

    const file = record('get', '/api/v1/admin/artwork/assets/:id/file', null, true);
    await api.artworkAssetBlob(api.artworkAssetSource(ASSET));
    expect(file[0]!.url).toBe(`GET /api/v1/admin/artwork/assets/${ID}/file?v=${'a'.repeat(64)}`);

    const enemies = record('get', '/api/v1/admin/dungeons/enemy-artwork', { enemies: [] });
    await expect(api.listEnemyArtwork()).resolves.toEqual({ enemies: [] });
    expect(enemies[0]!.url).toBe('GET /api/v1/admin/dungeons/enemy-artwork');
  });

  it('uploads and replaces with the file as the body and its type as the content type', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'night sky.png', { type: 'image/png' });
    const upload = record('post', '/api/v1/admin/artwork/assets', { asset: ASSET });
    await expect(
      api.uploadArtworkAsset(file, { category: 'dungeon_background', name: ' Night ' }),
    ).resolves.toEqual(ASSET);
    expect(upload[0]).toEqual({
      url: 'POST /api/v1/admin/artwork/assets?category=dungeon_background&filename=night+sky.png&name=Night',
      contentType: 'image/png',
    });

    const replace = record('put', '/api/v1/admin/artwork/assets/:id/file', { asset: ASSET });
    // A type the API has no parser for is sent as a plain byte stream; the server reads the real type.
    await api.replaceArtworkAsset(ID, new File([new Uint8Array([1])], 'x.bin', { type: '' }));
    expect(replace[0]).toEqual({
      url: `PUT /api/v1/admin/artwork/assets/${ID}/file?filename=x.bin`,
      contentType: 'application/octet-stream',
    });
  });

  it('writes', async () => {
    const patch = record('patch', '/api/v1/admin/artwork/assets/:id', { asset: ASSET });
    await api.updateArtworkAsset(ID, { name: 'Renamed' });
    expect(patch[0]!.url).toBe(`PATCH /api/v1/admin/artwork/assets/${ID}`);

    const enabled = record('put', '/api/v1/admin/artwork/assets/:id/enabled', {
      asset: ASSET,
      references: [],
    });
    await api.setArtworkAssetEnabled(ID, false);
    expect(enabled[0]!.url).toBe(`PUT /api/v1/admin/artwork/assets/${ID}/enabled`);

    const removed = record('delete', '/api/v1/admin/artwork/assets/:id', { deleted: true });
    await api.deleteArtworkAsset(ID);
    expect(removed[0]!.url).toBe(`DELETE /api/v1/admin/artwork/assets/${ID}`);

    const scene = record('post', '/api/v1/admin/artwork/scene-preview', null, true);
    const blob = await api.scenePreviewBlob({ background: { assetId: ID } });
    expect(scene[0]!.url).toBe('POST /api/v1/admin/artwork/scene-preview');
    expect(blob).toBeInstanceOf(Blob);

    const enemy = record('put', '/api/v1/admin/dungeons/enemy-artwork/:key', {
      key: 'scrapyard_drone',
    });
    await api.saveEnemyArtwork('scrapyard_drone', {
      artworkAssetId: null,
      spriteAssetId: ID,
      spritePlacement: null,
      expectedRevision: 0,
    });
    expect(enemy[0]!.url).toBe('PUT /api/v1/admin/dungeons/enemy-artwork/scrapyard_drone');
  });
});
