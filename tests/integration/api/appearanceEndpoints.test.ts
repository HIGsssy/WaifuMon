/**
 * Appearance endpoints against the real stack, plus the asset-abstraction
 * guardrail that keeps the whole v1 surface location-agnostic.
 *
 * The guardrail is the load-bearing test here. The Platform API's entire
 * promise is that it says *what* artwork to render and never *where it lives*,
 * so migrating to a CDN, object storage, or a mobile-specific backend is a
 * per-consumer change with zero contract impact. A convention cannot hold that
 * line across future edits; a test that walks every response body and fails on
 * any image extension or `assets/` substring can.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  playerProgressionEvents,
  playerWaifus,
  species,
  type SpeciesRow,
} from '../../../src/db/schema';
import {
  APPEARANCE_UNLOCK_EVENT,
  createAppearanceService,
} from '../../../src/modules/appearance/appearanceService';
import type { LoadedContent, SpeciesContent } from '../../../src/modules/content/schemas';
import { bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555666';
const USER_ID = '777888999000111333';
const CHANNEL_ID = '9002';

let t: TestDb;
let app: App;
let api: ZodFastify;
let playerId: number;
let guildDbId: number;
let waifuId: number;
let subject: SpeciesRow;
let liveContent: LoadedContent;

async function get(url: string, expectedStatus = 200): Promise<any> {
  const res = await api.inject({ method: 'GET', url, headers: AUTH });
  expect(res.statusCode, `${url} → ${res.body}`).toBe(expectedStatus);
  return res.json();
}

async function put(
  url: string,
  body: Record<string, unknown>,
  expectedStatus = 200,
): Promise<any> {
  const res = await api.inject({ method: 'PUT', url, headers: AUTH, payload: body });
  expect(res.statusCode, `${url} → ${res.body}`).toBe(expectedStatus);
  return res.json();
}

/** Overlay a catalog onto one species — how shipping artwork actually works. */
function withCatalog(base: LoadedContent, slug: string): LoadedContent {
  return {
    ...base,
    species: base.species.map((s) =>
      s.slug === slug
        ? ({
            ...s,
            appearances: [
              {
                id: 'standard',
                name: 'Standard',
                cosmeticRarity: 'standard',
                sortOrder: 0,
                tags: [],
                unlock: { type: 'owned' },
              },
              {
                id: 'level_5',
                name: 'Midnight Bloom',
                description: 'A darker cut of her usual silhouette.',
                flavorText: 'Prepared for the annual shrine celebration.',
                cosmeticRarity: 'seasonal',
                introducedVersion: 'v1.3',
                sortOrder: 1,
                tags: [],
                unlock: { type: 'level', atLevel: 5 },
              },
              {
                id: 'level_40',
                name: 'Eclipse',
                cosmeticRarity: 'limited',
                sortOrder: 2,
                tags: [],
                unlock: { type: 'level', atLevel: 40 },
              },
            ],
          } as SpeciesContent)
        : s,
    ),
  };
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ guildDbId, playerId } = await provisionPlayer(app, GUILD_ID, USER_ID));

  const [row] = await t.db.select().from(species).where(eq(species.slug, 'alley_catgirl'));
  subject = row!;
  const [waifu] = await t.db
    .insert(playerWaifus)
    .values({ playerId, speciesId: subject.id, level: 10, xp: 200, affection: 7 })
    .returning();
  waifuId = waifu!.id;
  await app.collection.setBuddy(playerId, waifuId);
  await app.session.ensureSession(guildDbId, playerId, CHANNEL_ID);
  await app.quests.ensureDailyQuests(playerId);

  liveContent = withCatalog(app.content, 'alley_catgirl');
  // A dedicated service over `liveContent`, not the bootstrap snapshot: these
  // tests ship artwork mid-run to exercise the retroactive path, which is
  // exactly what an admin-panel "Save + Reload" does in production.
  const appearance = createAppearanceService({ db: t.db, getContent: () => liveContent });
  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3121, token: TEST_TOKEN },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: {
      services: { ...app, appearance } as never,
      // Read through the variable so a test can "ship" new artwork mid-run.
      getContent: () => liveContent,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

beforeEach(async () => {
  liveContent = withCatalog(app.content, 'alley_catgirl');
  await t.db
    .update(playerWaifus)
    .set({ variant: 'standard', seenAppearances: [], level: 10 })
    .where(eq(playerWaifus.id, waifuId));
  await t.db.delete(playerProgressionEvents).where(eq(playerProgressionEvents.playerId, playerId));
});

describe('GET …/appearances', () => {
  it('returns the whole gallery, locked entries included, each with its requirement', async () => {
    const body = await get(
      `/api/v1/players/${playerId}/collection/owned/${waifuId}/appearances`,
    );
    expect(body.data.selected).toBe('standard');
    expect(body.data.appearances.map((a: any) => a.id)).toEqual([
      'standard',
      'level_5',
      'level_40',
    ]);
    expect(body.data.appearances.map((a: any) => a.isUnlocked)).toEqual([true, true, false]);
    expect(body.data.appearances.map((a: any) => a.unlockLabel)).toEqual([
      'Owned',
      'Reach Level 5',
      'Reach Level 40',
    ]);
  });

  it('carries assetId and the cosmetic metadata set', async () => {
    const body = await get(
      `/api/v1/players/${playerId}/collection/owned/${waifuId}/appearances`,
    );
    expect(body.data.appearances[1]).toMatchObject({
      assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: 'level_5' },
      cosmeticRarity: 'seasonal',
      flavorText: 'Prepared for the annual shrine celebration.',
      introducedVersion: 'v1.3',
    });
  });

  it('acknowledges retroactive unlocks on read and audits them', async () => {
    await get(`/api/v1/players/${playerId}/collection/owned/${waifuId}/appearances`);
    const events = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(eq(playerProgressionEvents.playerId, playerId));
    const unlocks = events.filter((e) => e.eventType === APPEARANCE_UNLOCK_EVENT);
    expect(unlocks.map((e) => e.metadata.appearanceId)).toEqual(['level_5']);
    expect(unlocks[0]?.metadata.source).toBe('content_add');
  });

  it('404s a copy the player does not own', async () => {
    const body = await get(
      `/api/v1/players/${playerId}/collection/owned/999999/appearances`,
      404,
    );
    expect(body.error.code).toBe('WAIFU_NOT_OWNED');
  });
});

describe('PUT …/appearance', () => {
  it('selects an unlocked appearance and echoes the updated entry', async () => {
    const body = await put(
      `/api/v1/players/${playerId}/collection/owned/${waifuId}/appearance`,
      { appearanceId: 'level_5' },
    );
    expect(body.data.waifu.variant).toBe('level_5');
    expect(body.data.waifu.selectedAppearance).toMatchObject({
      id: 'level_5',
      name: 'Midnight Bloom',
      cosmeticRarity: 'seasonal',
      unlockLabel: 'Reach Level 5',
      assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: 'level_5' },
      isSelected: true,
    });
  });

  it('409s a locked appearance and changes nothing', async () => {
    const body = await put(
      `/api/v1/players/${playerId}/collection/owned/${waifuId}/appearance`,
      { appearanceId: 'level_40' },
      409,
    );
    expect(body.error.code).toBe('APPEARANCE_LOCKED');
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
    expect(row?.variant).toBe('standard');
  });

  it('400s an appearance the species does not have', async () => {
    const body = await put(
      `/api/v1/players/${playerId}/collection/owned/${waifuId}/appearance`,
      { appearanceId: 'no_such_look' },
      400,
    );
    expect(body.error.code).toBe('APPEARANCE_NOT_FOUND');
  });

  it('404s a copy the player does not own', async () => {
    const body = await put(
      `/api/v1/players/${playerId}/collection/owned/999999/appearance`,
      { appearanceId: 'standard' },
      404,
    );
    expect(body.error.code).toBe('WAIFU_NOT_OWNED');
  });

  it('is cosmetic — no gameplay column drifts', async () => {
    const [before] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
    await put(`/api/v1/players/${playerId}/collection/owned/${waifuId}/appearance`, {
      appearanceId: 'level_5',
    });
    const [after] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));

    expect(after?.variant).toBe('level_5');
    expect({ ...after, variant: null, seenAppearances: null }).toEqual({
      ...before,
      variant: null,
      seenAppearances: null,
    });
  });
});

describe('species catalog on the content endpoint', () => {
  it('exposes the appearance catalog without per-player state', async () => {
    const body = await get('/api/v1/content/species/alley_catgirl');
    expect(body.data.appearances.map((a: any) => a.id)).toEqual([
      'standard',
      'level_5',
      'level_40',
    ]);
    // Catalog metadata only — whether *you* have earned it is the collection
    // endpoint's job, and mixing the two would make this cacheable-per-player.
    expect(body.data.appearances[0]).not.toHaveProperty('isUnlocked');
    expect(body.data.appearances[0]).not.toHaveProperty('isSelected');
  });

  it('gives a species with no authored catalog its implicit standard entry', async () => {
    liveContent = app.content;
    const body = await get('/api/v1/content/species/alley_catgirl');
    expect(body.data.appearances).toHaveLength(1);
    expect(body.data.appearances[0]).toMatchObject({ id: 'standard', unlockLabel: 'Owned' });
  });
});

/**
 * The contract guardrail.
 *
 * Every v1 response body is parsed and asserted to contain no image extension
 * and no `assets/` substring. This is what makes "the Platform API is asset
 * location agnostic" a mechanical property rather than a design intention:
 * re-adding `imagePath`, or leaking a URL or a filename into any response,
 * breaks CI here rather than quietly coupling every client to one storage
 * layout.
 */
describe('asset-abstraction guardrail', () => {
  const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|svg)\b/i;

  it('leaks no path, URL, or file extension from any v1 route', async () => {
    const urls = [
      `/api/v1/players/${playerId}`,
      `/api/v1/players/${playerId}/profile`,
      `/api/v1/players/${playerId}/collection/stats`,
      `/api/v1/players/${playerId}/collection/owned`,
      `/api/v1/players/${playerId}/collection/owned/${waifuId}`,
      `/api/v1/players/${playerId}/collection/owned/${waifuId}/appearances`,
      `/api/v1/players/${playerId}/collection/buddy`,
      `/api/v1/players/${playerId}/currency`,
      `/api/v1/players/${playerId}/inventory`,
      `/api/v1/players/${playerId}/care`,
      `/api/v1/players/${playerId}/quests/daily`,
      `/api/v1/players/${playerId}/sessions/${CHANNEL_ID}`,
      '/api/v1/shop/catalog',
      '/api/v1/content/species',
      '/api/v1/content/species/alley_catgirl',
      '/api/v1/content/items',
    ];

    for (const url of urls) {
      const res = await api.inject({ method: 'GET', url, headers: AUTH });
      expect(res.statusCode, `${url} → ${res.body}`).toBe(200);
      expect(res.body, `${url} leaked an image extension`).not.toMatch(IMAGE_EXTENSION);
      expect(res.body, `${url} leaked an assets/ path`).not.toContain('assets/');
      expect(res.body, `${url} leaked imagePath`).not.toContain('imagePath');
    }
  });

  it('leaks nothing from the appearance write either', async () => {
    const res = await api.inject({
      method: 'PUT',
      url: `/api/v1/players/${playerId}/collection/owned/${waifuId}/appearance`,
      headers: AUTH,
      payload: { appearanceId: 'level_5' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(IMAGE_EXTENSION);
    expect(res.body).not.toContain('assets/');
  });

  it('keeps the OpenAPI document itself free of path and URL fields', async () => {
    // Not just the payloads: a schema that *documents* an `imagePath` field
    // would invite a client to depend on one.
    const res = await api.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('"imagePath"');
  });
});
