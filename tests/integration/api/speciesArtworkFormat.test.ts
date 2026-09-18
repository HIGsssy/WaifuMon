/**
 * The artwork routes serve whatever format the resolver found, and say so.
 *
 * The URLs are extensionless (`/v1/assets/waifumon/<slug>`), so the route is
 * the only thing that knows what bytes it is sending — and it must not guess
 * from a filename it expected. Each species here exists in exactly one
 * arrangement of formats, and the Content-Type has to follow the file that was
 * actually chosen: WebP when present, PNG otherwise, the pre-generated WebP
 * rendition when a width is asked for and one exists.
 *
 * Bearer-token calls throughout: the discovery gate is covered in
 * `speciesArtworkGating.test.ts` and is orthogonal to format.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ApiContext } from '../../../src/api/context';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalSessionConfig, PortalSessionService } from '../../../src/api/portalSession';
import { createAppearanceService } from '../../../src/modules/appearance/appearanceService';
import { createCardRenderer } from '../../../src/modules/cards';
import { SpeciesFileSchema, type LoadedContent } from '../../../src/modules/content/schemas';
import type { AppServices } from '../../../src/discord/types';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { makeTempDir } from '../../helpers/cardFixtures';

const WEBP_ONLY = 'format_webp_only';
const PNG_ONLY = 'format_png_only';
const BOTH = 'format_both';
const ALL_SLUGS = [WEBP_ONLY, PNG_ONLY, BOTH];

const SPECIES = SpeciesFileSchema.parse(
  ALL_SLUGS.map((slug, index) => ({
    slug,
    name: `Format Subject ${index + 1}`,
    rarity: 'R',
    archetype: 'spirit',
    race: 'spirit',
    contentRating: 'suggestive',
    affinity: 'switch',
    // Legacy content still names a PNG; the WebP-only species must be served
    // regardless.
    imagePath: `waifumon/${slug}/standard.png`,
  })),
);

const TABLES = { waifuProgression: { maxLevel: 50 } } as unknown as LoadedContent['tables'];
const BEARER = { authorization: `Bearer ${TEST_TOKEN}` };

let workdir: string;
let assetsDir: string;
let content: LoadedContent;
let app: ZodFastify;

async function writeImage(relative: string, format: 'png' | 'webp'): Promise<void> {
  const absolute = path.join(assetsDir, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const image = sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 30, b: 160 } },
  });
  fs.writeFileSync(absolute, await (format === 'png' ? image.png() : image.webp()).toBuffer());
}

/** The format sharp detects in a response body — the bytes, not the header. */
async function bodyFormat(payload: Buffer): Promise<string | undefined> {
  return (await sharp(payload).metadata()).format;
}

function get(slug: string, query = '', headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/assets/waifumon/${slug}${query}`,
    headers: { ...BEARER, ...headers },
  });
}

beforeAll(async () => {
  workdir = await makeTempDir('api-species-artwork-format');
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

  await writeImage(`waifumon/${WEBP_ONLY}/standard.webp`, 'webp');
  await writeImage(`waifumon/${PNG_ONLY}/standard.png`, 'png');
  await writeImage(`waifumon/${BOTH}/standard.png`, 'png');
  await writeImage(`waifumon/${BOTH}/standard.webp`, 'webp');
  // A 512 rendition for the PNG-only species only; 256 exists for nobody.
  await writeImage(`.thumbnails/512/waifumon/${PNG_ONLY}/standard.webp`, 'webp');

  const appearance = createAppearanceService({ db: null as never, getContent: () => content });
  const ctx: ApiContext = {
    services: { appearance, collection: {}, players: {} } as unknown as AppServices,
    getContent: () => content,
    assetsDir,
    cardRenderer: createCardRenderer({ cacheRoot: path.join(workdir, 'cache') }),
  };

  app = await createPlatformApiServer({
    config: {
      enabled: true,
      host: '127.0.0.1',
      port: 3120,
      token: TEST_TOKEN,
      cardRendererEnabled: true,
    },
    portalAuth: {
      config: { publicUrl: 'http://localhost' } as unknown as PortalSessionConfig,
      sessions: { getSession: async () => undefined } as unknown as PortalSessionService,
    },
    logger: createCapturedLogger().logger,
    probes: createProbes(),
    ctx,
  });
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe('full-size species artwork', () => {
  it('serves a WebP-only species as image/webp', async () => {
    const res = await get(WEBP_ONLY);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(await bodyFormat(res.rawPayload)).toBe('webp');
  });

  it('serves a PNG-only species as image/png', async () => {
    const res = await get(PNG_ONLY);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(await bodyFormat(res.rawPayload)).toBe('png');
  });

  it('prefers the WebP when both formats exist', async () => {
    const res = await get(BOTH);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(await bodyFormat(res.rawPayload)).toBe('webp');
  });

  it('keeps the existing caching behaviour: private, revalidated, 304 on a matching ETag', async () => {
    const first = await get(WEBP_ONLY);
    expect(first.headers['cache-control']).toBe('private, max-age=300, must-revalidate');

    const again = await get(WEBP_ONLY, '', { 'if-none-match': String(first.headers.etag) });
    expect(again.statusCode).toBe(304);
  });
});

describe('sized species artwork', () => {
  it('serves the pre-generated WebP rendition for a PNG source', async () => {
    const res = await get(PNG_ONLY, '?width=512');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(await bodyFormat(res.rawPayload)).toBe('webp');
  });

  it('falls back to the source, labelled by its own format, when no rendition exists', async () => {
    const png = await get(PNG_ONLY, '?width=256');
    expect(png.headers['content-type']).toBe('image/png');
    expect(await bodyFormat(png.rawPayload)).toBe('png');

    const webp = await get(WEBP_ONLY, '?width=256');
    expect(webp.headers['content-type']).toBe('image/webp');
    expect(await bodyFormat(webp.rawPayload)).toBe('webp');
  });
});

describe('rendered cards from WebP artwork', () => {
  it('renders a card for a species whose only artwork is WebP', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cards/species/${WEBP_ONLY}?width=256`,
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
  });
});
