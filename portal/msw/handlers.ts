/**
 * Mocked Platform API (plan §22).
 *
 * One handler per endpoint the Portal calls, returning the API's real
 * envelopes — `{ data, meta }` for singletons, `{ data, page, pageSize, total }`
 * for the paginated collection, and `{ error: { code, message }, requestId }`
 * for failures. Tests that need an error path override a single handler with
 * `server.use(...)` rather than reaching into the client.
 *
 * The envelope helpers are exported so per-test overrides stay one line.
 */
import { http, HttpResponse } from 'msw';

import * as fixtures from './fixtures';

/** Matches the API's success envelope, `meta.requestId` included. */
export function data<T>(payload: T) {
  return HttpResponse.json({ data: payload, meta: { requestId: 'test-request-id' } });
}

export function page<T>(items: T[], pageNumber = 1, pageSize = 25, total = items.length) {
  return HttpResponse.json({
    data: items,
    page: pageNumber,
    pageSize,
    total,
    meta: { requestId: 'test-request-id' },
  });
}

export function apiError(status: number, code: string, message: string) {
  return HttpResponse.json({ error: { code, message }, requestId: 'test-request-id' }, { status });
}

const P = String(fixtures.PLAYER_ID);

/**
 * A card response. Mirrors the real route's headers — `image/webp`, a strong
 * ETag and the revalidating cache policy — so tests see the same contract the
 * API actually serves.
 */
function webpResponse(request: Request): Response {
  const width = new URL(request.url).searchParams.get('width');
  return new HttpResponse(fixtures.cardWebpBytes(), {
    headers: {
      'Content-Type': 'image/webp',
      ETag: '"testcardkey000000"',
      'Cache-Control': 'public, max-age=300, must-revalidate',
      // Test-only: lets a test assert the requested bucket cheaply.
      'X-Test-Card-Width': width ?? 'master',
    },
  });
}

export const handlers = [
  // ── Players ───────────────────────────────────────────────────────────────
  // The identity bridge the dev-login session provider starts from. It answers
  // for exactly one pair, so a test can exercise "this account has not played
  // here" by signing in as anyone else — the API's real behaviour, since this
  // endpoint never provisions.
  http.get('/api/v1/players/lookup', ({ request }) => {
    const query = new URL(request.url, 'http://localhost').searchParams;
    const known =
      query.get('discordGuildId') === fixtures.DISCORD_GUILD_ID &&
      query.get('discordUserId') === fixtures.DISCORD_USER_ID;
    return known
      ? data({ playerId: fixtures.PLAYER_ID })
      : apiError(404, 'PLAYER_NOT_FOUND', 'No player for that Discord identity.');
  }),

  http.get('/api/v1/players/:playerId', ({ params }) =>
    params.playerId === P
      ? data(fixtures.player)
      : apiError(404, 'PLAYER_NOT_FOUND', 'No player with that id.'),
  ),

  http.get('/api/v1/players/:playerId/profile', () =>
    data({ player: fixtures.player, currencies: fixtures.currencies }),
  ),

  // ── Collection ────────────────────────────────────────────────────────────
  http.get('/api/v1/players/:playerId/collection/stats', () => data(fixtures.dexStats)),

  http.get('/api/v1/players/:playerId/collection/owned', ({ request }) => {
    const url = new URL(request.url, 'http://localhost');
    const rarity = url.searchParams.get('rarity');
    const pageNumber = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
    const filtered = rarity
      ? fixtures.ownedEntries.filter((entry) => entry.species.rarity === rarity)
      : fixtures.ownedEntries;
    return page(filtered, pageNumber, pageSize, filtered.length);
  }),

  http.get('/api/v1/players/:playerId/collection/owned/:waifuId', ({ params }) => {
    const entry = fixtures.ownedEntries.find(
      (candidate) => String(candidate.waifu.id) === params.waifuId,
    );
    return entry ? data(entry) : apiError(404, 'WAIFU_NOT_OWNED', 'You do not own that Waifumon.');
  }),

  http.get('/api/v1/players/:playerId/collection/buddy', () => data(fixtures.buddyEntry)),

  // ── Appearances ───────────────────────────────────────────────────────────
  http.get('/api/v1/players/:playerId/collection/owned/:waifuId/appearances', ({ params }) => {
    const gallery = fixtures.appearanceGalleries[Number(params.waifuId)];
    return gallery
      ? data(gallery)
      : apiError(404, 'WAIFU_NOT_OWNED', 'You do not own that Waifumon.');
  }),

  http.put(
    '/api/v1/players/:playerId/collection/owned/:waifuId/appearance',
    async ({ params, request }) => {
      const waifuId = Number(params.waifuId);
      const entry = fixtures.ownedEntries.find((candidate) => candidate.waifu.id === waifuId);
      const gallery = fixtures.appearanceGalleries[waifuId];
      if (!entry || !gallery) {
        return apiError(404, 'WAIFU_NOT_OWNED', 'You do not own that Waifumon.');
      }

      const body = (await request.json()) as { appearanceId?: unknown };
      const appearanceId = typeof body.appearanceId === 'string' ? body.appearanceId : '';
      const appearance = gallery.appearances.find((candidate) => candidate.id === appearanceId);
      if (!appearance) {
        return apiError(400, 'APPEARANCE_NOT_FOUND', 'That appearance does not exist.');
      }
      if (!appearance.isUnlocked || !appearance.assetId) {
        return apiError(409, 'APPEARANCE_LOCKED', 'That appearance is not unlocked yet.');
      }

      return data({
        ...entry,
        waifu: {
          ...entry.waifu,
          variant: appearance.id,
          selectedAppearance: { ...appearance, isSelected: true },
        },
      });
    },
  ),

  // ── Care, inventory, shop ─────────────────────────────────────────────────
  http.get('/api/v1/players/:playerId/care', () => data(fixtures.careState)),
  http.get('/api/v1/players/:playerId/inventory', () => data(fixtures.inventoryEntries)),
  http.get('/api/v1/shop/catalog', () => data(fixtures.shopCatalog)),

  // ── Content ───────────────────────────────────────────────────────────────
  http.get('/api/v1/content/species', () => data(fixtures.contentSpecies)),
  http.get('/api/v1/content/species/:slug', ({ params }) => {
    const found = fixtures.contentSpecies.find((s) => s.slug === params.slug);
    return found ? data(found) : apiError(404, 'SPECIES_NOT_FOUND', 'No species with that slug.');
  }),
  http.get('/api/v1/content/items', () => data(fixtures.contentItems)),
  http.get('/api/v1/content/items/:slug', ({ params }) => {
    const found = fixtures.contentItems.find((i) => i.slug === params.slug);
    return found ? data(found) : apiError(404, 'ITEM_NOT_FOUND', 'No item with that slug.');
  }),
  http.get('/api/v1/content/tables', () => data(fixtures.tuningTables)),
  http.get('/api/v1/content/tables/:key', ({ params }) => {
    const key = String(params.key);
    return Object.hasOwn(fixtures.tuningTables, key)
      ? data(fixtures.tuningTables[key])
      : apiError(404, 'TABLE_NOT_FOUND', 'No tuning table with that key.');
  }),

  // ── Capabilities ──────────────────────────────────────────────────────────
  // Cards on by default, so component tests exercise the feature-present path.
  // A test that wants the feature absent overrides this with
  // `server.use(http.get('/api/v1/capabilities', () => data({ cards: false })))`.
  http.get('/api/v1/capabilities', () => data(fixtures.capabilities)),

  // ── Rendered cards ────────────────────────────────────────────────────────
  // Real bytes, not JSON: these routes answer `image/webp`. The fixture is a
  // tiny valid WebP so an <img> can actually decode it and the export flow has
  // a real Blob to save. `width` is echoed in a header so a test can assert
  // which size was requested without decoding the image.
  http.get('/api/v1/cards/species/:slug', ({ request }) => webpResponse(request)),
  http.get('/api/v1/players/:playerId/collection/owned/:waifuId/card', ({ request }) =>
    webpResponse(request),
  ),

  // ── System (root-level, not under /api) ───────────────────────────────────
  http.get('/ready', () =>
    HttpResponse.json({
      status: 'ok',
      components: {
        database: { status: 'ok', checkedAt: '2026-08-06T10:00:00.000Z' },
        content: { status: 'ok', checkedAt: '2026-08-06T10:00:00.000Z' },
      },
      checkedAt: '2026-08-06T10:00:00.000Z',
    }),
  ),
];
