/**
 * Card routes over HTTP.
 *
 * Everything runs against a temp assets root and a temp cache, with fixture
 * content, so the suite never touches `assets/.card-cache/` and never depends
 * on shipped artwork. The renderer itself is real — these tests are about the
 * HTTP contract *and* the identity rules underneath it, and stubbing the
 * renderer would verify neither.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ApiContext } from '../../../src/api/context';
import { createCardRenderer, CARD_MASTER_HEIGHT, CARD_MASTER_WIDTH } from '../../../src/modules/cards';
import { createAppearanceService } from '../../../src/modules/appearance/appearanceService';
import { SpeciesFileSchema, type LoadedContent } from '../../../src/modules/content/schemas';
import { WaifuNotOwnedError } from '../../../src/shared/errors';
import type { AppServices } from '../../../src/discord/types';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
} from '../../helpers/platformApiFixtures';
import { dimensionsOf, isWebp, makeTempDir } from '../../helpers/cardFixtures';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

let workdir: string;
let assetsDir: string;
let content: LoadedContent;
let app: ZodFastify;
/** Log capture for the shared `app` only — `buildApp` returns its own. */
let logLines: () => string[];

/**
 * Fixture content. `fallback_girl` is the important one: it declares two
 * level-gated appearances and ships artwork for **none** of them, so both fall
 * back to the species default — which is exactly the case where keying by the
 * requested appearance would mint two masters of one image.
 */
const SPECIES = SpeciesFileSchema.parse([
  {
    slug: 'card_test_n',
    name: 'Card Test N',
    rarity: 'N',
    archetype: 'demi-human',
    race: 'demi-human',
    contentRating: 'suggestive',
    affinity: 'dominant',
    imagePath: 'waifumon/card_test_n/standard.png',
    card: { subtitle: 'Fixture Subtitle', artist: 'Fixture Artist' },
  },
  {
    slug: 'card_test_ex',
    name: 'Card Test EX',
    rarity: 'EX',
    archetype: 'android',
    race: 'android',
    contentRating: 'suggestive',
    affinity: 'primal',
    imagePath: 'waifumon/card_test_ex/standard.png',
  },
  {
    slug: 'fallback_girl',
    name: 'Fallback Girl',
    rarity: 'SR',
    archetype: 'angel',
    contentRating: 'suggestive',
    affinity: 'caregiver',
    imagePath: 'waifumon/fallback_girl/standard.png',
    appearances: [
      { id: 'standard', name: 'Standard', unlock: { type: 'owned' } },
      { id: 'alt_a', name: 'Alt A', unlock: { type: 'level', atLevel: 10 } },
      { id: 'alt_b', name: 'Alt B', unlock: { type: 'level', atLevel: 20 } },
    ],
  },
  {
    slug: 'no_art_girl',
    name: 'No Art Girl',
    rarity: 'R',
    archetype: 'spirit',
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: 'waifumon/no_art_girl/standard.png',
  },
  /**
   * The species the unlock fence is tested against. Unlike `fallback_girl`,
   * her gated appearance **ships real artwork** — so a request for it would
   * genuinely serve the reward if nothing stopped it, and a 409 here is the
   * fence working rather than a missing file quietly saving us.
   */
  {
    slug: 'gated_girl',
    name: 'Gated Girl',
    rarity: 'SR',
    archetype: 'demon',
    race: 'demon',
    contentRating: 'suggestive',
    affinity: 'primal',
    imagePath: 'waifumon/gated_girl/standard.png',
    appearances: [
      { id: 'standard', name: 'Standard', unlock: { type: 'owned' } },
      { id: 'secret', name: 'Secret', unlock: { type: 'level', atLevel: 30 } },
    ],
  },
  {
    // Expansion provenance changes where content is authored, never where its
    // runtime artwork lives or how the API serves it.
    slug: 'onsen_maid',
    name: 'Onsen Maid',
    rarity: 'R',
    archetype: 'spirit',
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: 'waifumon/onsen_maid/standard.png',
  },
]);

const TABLES = { waifuProgression: { maxLevel: 50 } } as unknown as LoadedContent['tables'];

/** An owned copy of `fallback_girl` wearing `alt_a`, at level 22. */
const OWNED_WAIFU = { id: 77, playerId: 1, speciesId: 3, level: 22, variant: 'alt_a' };

/**
 * Two copies of `gated_girl` for the gallery's per-appearance artwork route.
 * `secret` unlocks at level 30 and ships real (distinct) art, so `GATED_HIGH`
 * has earned it and `GATED_LOW` has not — the difference the unlock fence and
 * the reward test both hinge on.
 */
const GATED_HIGH = { id: 88, playerId: 1, speciesId: 5, level: 30, variant: 'standard' };
const GATED_LOW = { id: 89, playerId: 1, speciesId: 5, level: 10, variant: 'standard' };

async function writeArt(slug: string, variant: string, rgb: { r: number; g: number; b: number }) {
  const dir = path.join(assetsDir, 'waifumon', slug);
  fs.mkdirSync(dir, { recursive: true });
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: rgb } })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(dir, `${variant}.png`), png);
}

function buildContext(overrides: Partial<ApiContext> = {}): ApiContext {
  const appearance = createAppearanceService({ db: null as never, getContent: () => content });
  const services = {
    appearance,
    players: {
      getById: async (id: number) => (id === 1 ? { id: 1, discordUserId: '1' } : null),
    },
    collection: {
      getOwned: async (playerId: number, waifuId: number) => {
        if (playerId !== 1) throw new WaifuNotOwnedError(waifuId);
        if (waifuId === OWNED_WAIFU.id) {
          return {
            waifu: OWNED_WAIFU,
            species: content.species.find((s) => s.slug === 'fallback_girl'),
          };
        }
        if (waifuId === GATED_HIGH.id || waifuId === GATED_LOW.id) {
          return {
            waifu: waifuId === GATED_HIGH.id ? GATED_HIGH : GATED_LOW,
            species: content.species.find((s) => s.slug === 'gated_girl'),
          };
        }
        throw new WaifuNotOwnedError(waifuId);
      },
    },
  } as unknown as AppServices;

  return {
    services,
    getContent: () => content,
    assetsDir,
    cardRenderer: createCardRenderer({ cacheRoot: path.join(workdir, 'cache') }),
    ...overrides,
  };
}

async function buildApp(
  options: { cards?: boolean; ctx?: ApiContext } = {},
): Promise<{ app: ZodFastify; lines: () => string[] }> {
  const captured = createCapturedLogger();
  const built = await createPlatformApiServer({
    config: {
      enabled: true,
      host: '127.0.0.1',
      port: 3120,
      token: TEST_TOKEN,
      cardRendererEnabled: options.cards ?? true,
    },
    logger: captured.logger,
    probes: createProbes(),
    ctx: options.ctx ?? buildContext(),
  });
  return { app: built, lines: captured.lines };
}

beforeAll(async () => {
  workdir = await makeTempDir('api-cards');
  assetsDir = path.join(workdir, 'assets');
  content = {
    items: [],
    species: SPECIES,
    tables: TABLES,
    bosses: [],
    bossRewards: [],
    regions: [],
    expansions: [],
    speciesOrigin: {},
  };

  await writeArt('card_test_n', 'standard', { r: 200, g: 40, b: 90 });
  await writeArt('card_test_ex', 'standard', { r: 40, g: 200, b: 90 });
  await writeArt('fallback_girl', 'standard', { r: 90, g: 40, b: 200 });
  await writeArt('gated_girl', 'standard', { r: 10, g: 10, b: 10 });
  // The reward itself: on disk, renderable, and unreachable through the
  // species route. Distinctly coloured so a leak would be unmistakable.
  await writeArt('gated_girl', 'secret', { r: 250, g: 250, b: 250 });
  await writeArt('onsen_maid', 'standard', { r: 80, g: 160, b: 220 });
  // `no_art_girl` deliberately gets nothing.

  const built = await buildApp();
  app = built.app;
  logLines = built.lines;
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(workdir, { recursive: true, force: true });
});

const url = (p: string): string => `/api/v1${p}`;

/**
 * The owned copy's card. Module-scoped because it is now the route that
 * exercises appearance *fallback* — the species route refuses gated ids, so
 * "she wears a look whose artwork is missing" only happens on an owned copy.
 */
const ownedUrl = url(`/players/1/collection/owned/${OWNED_WAIFU.id}/card`);

/** The full-size masters cached for a species, sorted. `@` marks a rendition. */
function mastersOf(slug: string): string[] {
  const dir = path.join(workdir, 'cache', slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => !f.includes('@')).sort();
}

describe('feature flag', () => {
  it('does not register the routes when disabled — they 404 like any unknown path', async () => {
    const { app: off } = await buildApp({ cards: false });
    const res = await off.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await off.close();
  });

  it('keeps the disabled routes out of the OpenAPI document', async () => {
    const { app: off } = await buildApp({ cards: false });
    const spec = (await off.inject({ method: 'GET', url: url('/openapi.json') })).json() as {
      paths: Record<string, unknown>;
    };

    expect(Object.keys(spec.paths).some((p) => p.includes('/cards/'))).toBe(false);
    await off.close();
  });

  it('registers and documents them when enabled', async () => {
    const spec = (await app.inject({ method: 'GET', url: url('/openapi.json') })).json() as {
      paths: Record<string, unknown>;
    };
    expect(spec.paths['/api/v1/cards/species/{slug}']).toBeDefined();
    expect(spec.paths['/api/v1/players/{playerId}/collection/owned/{waifuId}/card']).toBeDefined();
  });

  it('still requires the bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: url('/cards/species/card_test_n') });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /capabilities', () => {
  /**
   * The Portal asks this instead of requesting a card and reading the 404 —
   * a disabled feature and a typo are both 404, and probing cannot tell them
   * apart. So the flag has to be reported honestly in both directions.
   */
  it('reports cards on when the routes are registered', async () => {
    const res = await app.inject({ method: 'GET', url: url('/capabilities'), headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { cards: true } });
  });

  it('reports cards off — and still answers — when they are not', async () => {
    const { app: off } = await buildApp({ cards: false });
    const res = await off.inject({ method: 'GET', url: url('/capabilities'), headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { cards: false } });
    await off.close();
  });

  it('requires the bearer token like every other v1 route', async () => {
    const res = await app.inject({ method: 'GET', url: url('/capabilities') });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET canonical artwork', () => {
  it('serves starter and expansion base artwork through the same API route', async () => {
    for (const slug of ['card_test_n', 'onsen_maid']) {
      const res = await app.inject({
        method: 'GET',
        url: url(`/assets/waifumon/${slug}`),
        headers: AUTH,
      });
      expect(res.statusCode, slug).toBe(200);
      expect(res.headers['content-type'], slug).toBe('image/png');
      expect(res.rawPayload.length, slug).toBeGreaterThan(0);
    }
  });

  it('answers 304 when the base-art ETag matches', async () => {
    const first = await app.inject({
      method: 'GET',
      url: url('/assets/waifumon/onsen_maid'),
      headers: AUTH,
    });
    const second = await app.inject({
      method: 'GET',
      url: url('/assets/waifumon/onsen_maid'),
      headers: { ...AUTH, 'if-none-match': first.headers.etag! },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(304);
    expect(second.rawPayload).toHaveLength(0);
  });

  it('serves owned artwork only after the existing ownership and level checks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url(`/players/1/collection/owned/${OWNED_WAIFU.id}/artwork`),
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=300, must-revalidate');
  });

  it('does not expose a route or query parameter for guessing gated variants', async () => {
    const pathGuess = await app.inject({
      method: 'GET',
      url: url('/assets/waifumon/gated_girl/secret'),
      headers: AUTH,
    });
    const queryGuess = await app.inject({
      method: 'GET',
      url: url('/assets/waifumon/gated_girl?variant=secret'),
      headers: AUTH,
    });
    expect(pathGuess.statusCode).toBe(404);
    expect(queryGuess.statusCode).toBe(400);
  });

  /**
   * The gallery's per-tile artwork route: `?appearance=<id>` serves a *specific*
   * unlocked look of an owned copy, so each tile can show its own art rather
   * than the worn one. The id is a selector, re-validated against the copy —
   * never an authorization input.
   */
  describe('per-appearance selector (?appearance=)', () => {
    it('serves a specific unlocked look, distinct from the copy’s default', async () => {
      const secret = await app.inject({
        method: 'GET',
        url: url(`/players/1/collection/owned/${GATED_HIGH.id}/artwork?appearance=secret`),
        headers: AUTH,
      });
      const standard = await app.inject({
        method: 'GET',
        url: url(`/players/1/collection/owned/${GATED_HIGH.id}/artwork?appearance=standard`),
        headers: AUTH,
      });

      expect(secret.statusCode).toBe(200);
      expect(secret.headers['content-type']).toBe('image/png');
      expect(secret.headers['cache-control']).toBe('private, max-age=300, must-revalidate');
      expect(standard.statusCode).toBe(200);
      // The reward is the reward: `secret` is the white fixture, `standard` the
      // black one, so the two responses are genuinely different bytes — the
      // tile is not just being handed the worn look under a different URL.
      expect(secret.rawPayload.equals(standard.rawPayload)).toBe(false);
    });

    it('refuses a locked look for a copy that has not earned it — 409, not the art', async () => {
      const res = await app.inject({
        method: 'GET',
        url: url(`/players/1/collection/owned/${GATED_LOW.id}/artwork?appearance=secret`),
        headers: AUTH,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'APPEARANCE_LOCKED' } });
      // The refusal is a JSON envelope, never the withheld artwork.
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('answers 400 for an appearance id the species does not have', async () => {
      const res = await app.inject({
        method: 'GET',
        url: url(`/players/1/collection/owned/${GATED_HIGH.id}/artwork?appearance=nonesuch`),
        headers: AUTH,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'APPEARANCE_NOT_FOUND' } });
    });

    it('does not serve another player’s copy through the selector', async () => {
      const res = await app.inject({
        method: 'GET',
        url: url(`/players/2/collection/owned/${GATED_HIGH.id}/artwork?appearance=secret`),
        headers: AUTH,
      });
      // Player 2 does not resolve in this harness, so the copy is unreachable —
      // the route is scoped to the authenticated player, never the path guess.
      expect(res.statusCode).toBe(404);
    });
  });

  it('requires the same bearer-token proxy as rendered cards', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/assets/waifumon/onsen_maid'),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /cards/species/:slug', () => {
  it('returns a full-size WebP with cache headers', async () => {
    const res = await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('public, max-age=300, must-revalidate');
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(isWebp(res.rawPayload)).toBe(true);
    expect(await dimensionsOf(res.rawPayload)).toEqual({
      width: CARD_MASTER_WIDTH,
      height: CARD_MASTER_HEIGHT,
    });
  });

  it('serves the second request from cache with identical bytes and ETag', async () => {
    const first = await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });
    const second = await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });

    expect(second.headers.etag).toBe(first.headers.etag);
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
    expect(logLines().some((l) => l.includes('"fromCache":true'))).toBe(true);
  });

  it('answers 304 with no body when If-None-Match matches', async () => {
    const first = await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });
    const res = await app.inject({
      method: 'GET',
      url: url('/cards/species/card_test_n'),
      headers: { ...AUTH, 'if-none-match': String(first.headers.etag) },
    });

    expect(res.statusCode).toBe(304);
    expect(res.rawPayload.length).toBe(0);
    expect(res.headers.etag).toBe(first.headers.etag);
  });

  it('honours a wildcard If-None-Match', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/cards/species/card_test_n'),
      headers: { ...AUTH, 'if-none-match': '*' },
    });
    expect(res.statusCode).toBe(304);
  });

  it('re-sends the body when If-None-Match is stale', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/cards/species/card_test_n'),
      headers: { ...AUTH, 'if-none-match': '"0000000000000000"' },
    });
    expect(res.statusCode).toBe(200);
    expect(isWebp(res.rawPayload)).toBe(true);
  });

  it('renders every supported width, tagging derivatives distinctly', async () => {
    const master = await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });

    for (const width of [256, 512, 1024]) {
      const res = await app.inject({
        method: 'GET',
        url: url(`/cards/species/card_test_n?width=${width}`),
        headers: AUTH,
      });
      expect(res.statusCode, `width ${width}`).toBe(200);
      expect((await dimensionsOf(res.rawPayload)).width, `width ${width}`).toBe(width);
      // Same card, different entity: the key is shared, the ETag is not.
      expect(res.headers.etag).toBe(`${String(master.headers.etag).slice(0, -1)}@${width}"`);
    }
  });

  it('treats an explicit master width as the master', async () => {
    const master = await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });
    const explicit = await app.inject({
      method: 'GET',
      url: url(`/cards/species/card_test_n?width=${CARD_MASTER_WIDTH}`),
      headers: AUTH,
    });
    expect(explicit.headers.etag).toBe(master.headers.etag);
  });

  /**
   * `EX` has no frame artwork yet. It must surface as a server-side asset gap —
   * never as a card wearing another rarity's frame, and never as a 404, which
   * would say the species does not exist.
   */
  it('fails loudly for a rarity whose frame has not shipped', async () => {
    const res = await app.inject({ method: 'GET', url: url('/cards/species/card_test_ex'), headers: AUTH });
    // 500, not 404: the species exists, the install is incomplete. The body
    // reports `INTERNAL_ERROR` because this route family masks every 500-class
    // code from clients — the specific `CARD_ASSET_MISSING` goes to the log,
    // which is where an operator reads it.
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(logLines().join('\n')).toContain('CARD_ASSET_MISSING');
  });

  it('accepts an explicit valid appearance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/cards/species/fallback_girl?variant=standard'),
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
  });

  it('prints the requested level on a different card than the default', async () => {
    const one = await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });
    const forty = await app.inject({
      method: 'GET',
      url: url('/cards/species/card_test_n?level=40'),
      headers: AUTH,
    });
    expect(forty.statusCode).toBe(200);
    expect(forty.headers.etag).not.toBe(one.headers.etag);
  });
});

describe('resolved asset identity', () => {
  /**
   * The regression this phase exists for. `alt_a` has no artwork, so a copy
   * wearing it resolves to `fallback_girl/standard.png` — the same pixels as
   * the plain species card at the same level, and therefore the same cached
   * master. Keying by the *requested* appearance would mint two masters of one
   * image, and every future fallback would double the cache again.
   *
   * This used to be asserted by naming `alt_a`/`alt_b` on the species route.
   * That route no longer renders gated appearances at all (see the fence
   * below), so the fallback is now exercised where it actually happens in
   * production: an owned copy who has *earned* the look wearing it.
   */
  it('gives a copy whose look falls back the same identity as the species default', async () => {
    const [owned, standard] = await Promise.all([
      app.inject({ method: 'GET', url: ownedUrl, headers: AUTH }),
      app.inject({
        method: 'GET',
        url: url(`/cards/species/fallback_girl?level=${OWNED_WAIFU.level}`),
        headers: AUTH,
      }),
    ]);

    expect(owned!.statusCode).toBe(200);
    expect(owned!.headers.etag).toBe(standard!.headers.etag);
    expect(owned!.rawPayload.equals(standard!.rawPayload)).toBe(true);
  });

  it('mints no extra master for the look that fell back', async () => {
    await app.inject({
      method: 'GET',
      url: url(`/cards/species/fallback_girl?level=${OWNED_WAIFU.level}`),
      headers: AUTH,
    });
    // Snapshot rather than count: other tests in this file legitimately render
    // her at other levels, and the invariant is "the fallback added nothing",
    // not "this species has exactly one card".
    const before = mastersOf('fallback_girl');

    await app.inject({ method: 'GET', url: ownedUrl, headers: AUTH });

    expect(mastersOf('fallback_girl')).toEqual(before);
  });

  it('logs the fallback so a content gap is diagnosable', async () => {
    await app.inject({ method: 'GET', url: ownedUrl, headers: AUTH });
    const line = logLines().find((l) => l.includes('card-renderer/artwork-fallback'));
    expect(line).toBeDefined();
    expect(line).toContain('"requestedAppearanceId":"alt_a"');
    expect(line).toContain('"resolvedAppearanceId":"standard"');
  });
});

/**
 * The species card route is public in the sense that matters here: it takes a
 * slug and an appearance id, and no owned copy is in scope to establish that
 * anyone has earned the look. It was therefore a complete bypass of the
 * appearance gate — `?variant=level_20` rendered and streamed Level 20 artwork
 * to a Level 1 player, which is the whole reward handed over by query string.
 *
 * `gated_girl/secret` exists on disk specifically so these assertions are about
 * refusal rather than about a missing file.
 */
describe('gated appearances are not renderable on the species route', () => {
  const secretUrl = url('/cards/species/gated_girl?variant=secret');

  it('409s a gated appearance instead of rendering it', async () => {
    const res = await app.inject({ method: 'GET', url: secretUrl, headers: AUTH });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'APPEARANCE_LOCKED' } });
  });

  it('returns no image bytes and names no asset location in the refusal', async () => {
    const res = await app.inject({ method: 'GET', url: secretUrl, headers: AUTH });

    expect(res.headers['content-type']).not.toContain('image/');
    // The refusal is a JSON envelope, and it must not describe the artwork it
    // is refusing — no path, no filename, no extension.
    expect(res.payload).not.toMatch(/\.(png|webp|jpe?g)\b/i);
    expect(res.payload).not.toContain('assets/');
    expect(res.payload).not.toContain('waifumon/');
  });

  it('renders nothing, so no master for the locked artwork is ever written', async () => {
    // Render her default first so the cache directory is populated, then take
    // the snapshot: a refusal must add nothing to it.
    await app.inject({
      method: 'GET',
      url: url('/cards/species/gated_girl'),
      headers: AUTH,
    });
    const before = mastersOf('gated_girl');

    await app.inject({ method: 'GET', url: secretUrl, headers: AUTH });

    expect(mastersOf('gated_girl')).toEqual(before);
  });

  it('still renders her ungated default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/cards/species/gated_girl?variant=standard'),
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/');
  });

  it('cannot be reached with a conditional GET either', async () => {
    // The 304 short-circuit runs before rendering, so a fence placed after it
    // would let `If-None-Match: *` confirm the card exists. It runs after.
    const res = await app.inject({
      method: 'GET',
      url: secretUrl,
      headers: { ...AUTH, 'if-none-match': '*' },
    });

    expect(res.statusCode).toBe(409);
  });
});

describe('errors', () => {
  it('404s an unknown species', async () => {
    const res = await app.inject({ method: 'GET', url: url('/cards/species/nope_not_here'), headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'SPECIES_NOT_FOUND' } });
  });

  it('400s an appearance the species does not have', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/cards/species/fallback_girl?variant=not_a_look'),
      headers: AUTH,
    });
    // Matches the established convention in api/errors.ts: a hand-typed or
    // stale appearance id is a malformed request, not a missing resource.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'APPEARANCE_NOT_FOUND' } });
  });

  it('404s when no artwork resolves at all', async () => {
    const res = await app.inject({ method: 'GET', url: url('/cards/species/no_art_girl'), headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'CARD_ARTWORK_MISSING' } });
  });

  it('400s an unsupported width', async () => {
    for (const width of [999, 0, -1, 4096]) {
      const res = await app.inject({
        method: 'GET',
        url: url(`/cards/species/card_test_n?width=${width}`),
        headers: AUTH,
      });
      expect(res.statusCode, `width ${width}`).toBe(400);
    }
  });

  it('400s an invalid level', async () => {
    for (const level of [0, -5]) {
      const res = await app.inject({
        method: 'GET',
        url: url(`/cards/species/card_test_n?level=${level}`),
        headers: AUTH,
      });
      expect(res.statusCode, `level ${level}`).toBe(400);
    }
  });

  it('400s a level above the progression ceiling, quoting the real cap', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/cards/species/card_test_n?level=9999'),
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Level must be between 1 and 50.' } });
  });

  it('never leaks a filesystem path in an error body', async () => {
    for (const target of ['no_art_girl', 'nope_not_here']) {
      const res = await app.inject({ method: 'GET', url: url(`/cards/species/${target}`), headers: AUTH });
      const body = res.rawPayload.toString('utf8');
      expect(body).not.toContain(assetsDir);
      expect(body).not.toContain('waifumon/');
      expect(body).not.toContain('.png');
    }
  });
});

describe('GET /players/:playerId/collection/owned/:waifuId/card', () => {
  it('renders the owned copy for its owner', async () => {
    const res = await app.inject({ method: 'GET', url: ownedUrl, headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(isWebp(res.rawPayload)).toBe(true);
  });

  /**
   * The owned card and a species preview at the same level with the same
   * resolved appearance are now the same image — ownership no longer forks the
   * cache (only an explicit CAUGHT-badge context does, and no owned surface
   * sets it). What the level actually drives is asserted two ways: the serve
   * log reports the level that reached the renderer, and the species route
   * still re-keys across levels.
   */
  it('uses the copy’s own level, not the preview default', async () => {
    const owned = await app.inject({ method: 'GET', url: ownedUrl, headers: AUTH });
    expect(owned.statusCode).toBe(200);

    const line = logLines()
      .filter((l) => l.includes('card-renderer/serve') && l.includes(`/owned/${OWNED_WAIFU.id}/card`) === false)
      .reverse()
      .find((l) => l.includes('"slug":"fallback_girl"'));
    expect(line, 'the owned render logs the level it used').toContain('"level":22');

    const [atLevel22, atLevel1] = await Promise.all([
      app.inject({ method: 'GET', url: url('/cards/species/fallback_girl?level=22'), headers: AUTH }),
      app.inject({ method: 'GET', url: url('/cards/species/fallback_girl'), headers: AUTH }),
    ]);
    expect(atLevel22.headers.etag).not.toBe(atLevel1.headers.etag);

    // Same species, same worn appearance, same level → same image now that
    // the CAUGHT badge is opt-in rather than ownership-derived.
    expect(owned.headers.etag).toBe(atLevel22.headers.etag);
  });

  it('uses the appearance she is wearing, resolved through the shared resolver', async () => {
    // She wears `alt_a`, which has no artwork and falls back to `standard` — so
    // her card is keyed by the asset that actually resolved, exactly like the
    // species route. The serve log is what records which one that was.
    const owned = await app.inject({ method: 'GET', url: ownedUrl, headers: AUTH });
    expect(owned.statusCode).toBe(200);

    const line = logLines()
      .reverse()
      .find((l) => l.includes('card-renderer/serve') && l.includes('"slug":"fallback_girl"'));

    expect(line, 'the owned render logs what it resolved').toBeDefined();
    expect(line).toContain('"requestedAppearanceId":"alt_a"');
    expect(line).toContain('"resolvedAppearanceId":"standard"');
    expect(line).toContain('"resolutionSource":"species-default"');
  });

  it('supports width on the owned route too', async () => {
    const res = await app.inject({ method: 'GET', url: `${ownedUrl}?width=512`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect((await dimensionsOf(res.rawPayload)).width).toBe(512);
  });

  it('answers 304 on a matching ETag', async () => {
    const first = await app.inject({ method: 'GET', url: ownedUrl, headers: AUTH });
    const res = await app.inject({
      method: 'GET',
      url: ownedUrl,
      headers: { ...AUTH, 'if-none-match': String(first.headers.etag) },
    });
    expect(res.statusCode).toBe(304);
  });

  it('401s without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: ownedUrl });
    expect(res.statusCode).toBe(401);
  });

  it('404s a copy owned by a different player', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url(`/players/2/collection/owned/${OWNED_WAIFU.id}/card`),
      headers: AUTH,
    });
    // Player 2 does not exist in the fixture, so player-scope 404s first —
    // either way an outsider learns nothing about someone else's collection.
    expect(res.statusCode).toBe(404);
  });

  it('404s a waifu this player does not own', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url('/players/1/collection/owned/999/card'),
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'WAIFU_NOT_OWNED' } });
  });

  it('404s an unknown player', async () => {
    const res = await app.inject({
      method: 'GET',
      url: url(`/players/4242/collection/owned/${OWNED_WAIFU.id}/card`),
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'PLAYER_NOT_FOUND' } });
  });
});

describe('artist credit', () => {
  /**
   * The credit is drawn from `card.artist`, so it changes the bytes — which
   * means it has to change the ETag too, or an edited credit would keep serving
   * the old card from every cache between here and the browser.
   */
  it('gives a different entity when the artist changes', async () => {
    const before = await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });
    expect(before.statusCode).toBe(200);

    const species = content.species.find((s) => s.slug === 'card_test_n') as {
      card?: Record<string, unknown> | undefined;
    };
    const original = species.card;
    species.card = { ...original, artist: 'Someone Else Entirely' };

    try {
      const after = await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });
      expect(after.statusCode).toBe(200);
      expect(after.headers.etag).not.toBe(before.headers.etag);
      expect(after.rawPayload.equals(before.rawPayload)).toBe(false);
    } finally {
      species.card = original;
    }
  });

  it('serves a card for a species with no artist at all', async () => {
    const res = await app.inject({ method: 'GET', url: url('/cards/species/fallback_girl'), headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(isWebp(res.rawPayload)).toBe(true);
  });
});

describe('observability', () => {
  it('logs slug, resolved appearance, width, key, cache hit and duration', async () => {
    await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });
    const line = logLines().find(
      (l) => l.includes('card-renderer/serve') && l.includes('card_test_n'),
    );

    expect(line).toBeDefined();
    for (const field of [
      '"slug":"card_test_n"',
      '"resolvedAppearanceId":"standard"',
      '"renderKey"',
      '"fromCache"',
      '"durationMs"',
      '"width"',
    ]) {
      expect(line, field).toContain(field);
    }
  });

  /**
   * Artwork paths must never reach the log — they are per-species filesystem
   * detail, and a card is identified by its render key. A missing *kit* asset is
   * the opposite case: `CardAssetMissingError` names the exact file an operator
   * has to go and put on disk, so `frames/ex.png` appearing there is correct and
   * necessary.
   */
  it('never writes an absolute artwork path to the log', async () => {
    await app.inject({ method: 'GET', url: url('/cards/species/card_test_n'), headers: AUTH });
    const text = logLines().join('\n');

    expect(text).not.toContain(assetsDir.replace(/\\/g, '\\\\'));
    expect(text).not.toContain('artworkAbsolutePath');

    // Every .png the log does mention belongs to the card kit, not to content.
    for (const match of text.matchAll(/[\w\\/.-]*\.png/g)) {
      expect(match[0], 'only kit assets may be named in logs').toContain('cardart');
    }
  });
});
