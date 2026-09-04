/**
 * The dex spoiler rule, enforced server-side.
 *
 * The Portal draws a silhouette for a species the player has not caught. That
 * is presentation: the slug is public through `/content/species`, the artwork
 * routes are addressed by slug, and before this gate existed the entire
 * encyclopedia was one hand-typed URL away from any signed-in player. These
 * tests are the fence — a browser session may fetch artwork only for a species
 * it has actually discovered, and the refusal is a JSON envelope rather than
 * the bytes it is withholding.
 *
 * Two callers, deliberately different:
 *
 *   - **bearer token** — the bot, the card-warming tools, the admin panel. No
 *     player is in scope and every species is legitimately renderable. It is
 *     also the credential the dev-mode Vite proxy attaches, which is why a
 *     developer's Portal is unaffected by this change.
 *   - **portal session** — a real player's browser. Gets the dex rule.
 *
 * Species here are generated rather than named: the rule is about *discovery
 * state*, not about any particular Waifumon, so nothing below may depend on
 * which slugs the shipped content happens to contain.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ApiContext } from '../../../src/api/context';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  PORTAL_SESSION_COOKIE,
  type PortalSessionConfig,
  type PortalSessionService,
} from '../../../src/api/portalSession';
import { createAppearanceService } from '../../../src/modules/appearance/appearanceService';
import { createCardRenderer } from '../../../src/modules/cards';
import { SpeciesFileSchema, type LoadedContent } from '../../../src/modules/content/schemas';
import type { AppServices } from '../../../src/discord/types';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { makeTempDir } from '../../helpers/cardFixtures';

/**
 * Two interchangeable species with the same shape. Which one the player owns
 * is decided per test, so neither slug carries any meaning of its own.
 */
const DISCOVERED = 'gating_subject_a';
const UNDISCOVERED = 'gating_subject_b';
const ALL_SLUGS = [DISCOVERED, UNDISCOVERED];

const PLAYER_ID = 1;
const OTHER_PLAYER_ID = 2;

const SPECIES = SpeciesFileSchema.parse(
  ALL_SLUGS.map((slug, index) => ({
    slug,
    name: `Gating Subject ${index + 1}`,
    rarity: 'R',
    archetype: 'spirit',
    race: 'spirit',
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: `waifumon/${slug}/standard.png`,
  })),
);

const TABLES = { waifuProgression: { maxLevel: 50 } } as unknown as LoadedContent['tables'];

const BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
const url = (p: string): string => `/api/v1${p}`;

let workdir: string;
let assetsDir: string;
let content: LoadedContent;
let app: ZodFastify;

/** Which slugs each player has caught. Rewritten per test. */
let dex: Record<number, string[]>;
/** Every `hasDiscoveredSpeciesSlug` call, so a test can prove one was made. */
let dexQueries: Array<{ playerId: number; slug: string }>;
/** The session the cookie resolves to, or null for "no session". */
let currentSession: { playerId: number | null } | null;

/** A browser request: the session cookie, and deliberately no bearer token. */
const portalCookie = { cookie: `${PORTAL_SESSION_COOKIE}=test-session` };

function buildContext(): ApiContext {
  const appearance = createAppearanceService({ db: null as never, getContent: () => content });
  const services = {
    appearance,
    players: {
      getById: async (id: number) => (id === PLAYER_ID ? { id, discordUserId: '1' } : null),
    },
    collection: {
      hasDiscoveredSpeciesSlug: async (playerId: number, slug: string) => {
        dexQueries.push({ playerId, slug });
        return (dex[playerId] ?? []).includes(slug);
      },
    },
  } as unknown as AppServices;

  return {
    services,
    getContent: () => content,
    assetsDir,
    cardRenderer: createCardRenderer({ cacheRoot: path.join(workdir, 'cache') }),
  };
}

/**
 * A portal-session service stub. `getSession` is the only method the auth hook
 * reaches on a GET, and every route under test is a GET.
 */
function buildSessions(): PortalSessionService {
  return {
    getSession: async (token: string | undefined) =>
      token === undefined || currentSession === null ? undefined : currentSession,
  } as unknown as PortalSessionService;
}

async function writeArt(slug: string, rgb: { r: number; g: number; b: number }): Promise<void> {
  const dir = path.join(assetsDir, 'waifumon', slug);
  fs.mkdirSync(dir, { recursive: true });
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: rgb } })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(dir, 'standard.png'), png);
}

beforeAll(async () => {
  workdir = await makeTempDir('api-species-gating');
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
  // Both ship real artwork, so a leak would genuinely serve the reward rather
  // than being quietly saved by a missing file.
  await writeArt(DISCOVERED, { r: 20, g: 20, b: 20 });
  await writeArt(UNDISCOVERED, { r: 240, g: 240, b: 240 });

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
      sessions: buildSessions(),
    },
    logger: createCapturedLogger().logger,
    probes: createProbes(),
    ctx: buildContext(),
  });
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  dex = { [PLAYER_ID]: [DISCOVERED], [OTHER_PLAYER_ID]: ALL_SLUGS };
  dexQueries = [];
  currentSession = { playerId: PLAYER_ID };
});

const artworkUrl = (slug: string): string => url(`/assets/waifumon/${slug}`);
const cardUrl = (slug: string): string => url(`/cards/species/${slug}`);

describe('raw species artwork — a browser session', () => {
  it('refuses a species the player has not discovered, with JSON rather than bytes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: artworkUrl(UNDISCOVERED),
      headers: portalCookie,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'SPECIES_NOT_DISCOVERED' } });
    // The refusal must not be the withheld image under a different status.
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.rawPayload.subarray(0, 8).toString('binary')).not.toContain('PNG');
  });

  it('serves a species the player has discovered', async () => {
    const res = await app.inject({
      method: 'GET',
      url: artworkUrl(DISCOVERED),
      headers: portalCookie,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('asks the dex about the requesting player, never the path', async () => {
    await app.inject({ method: 'GET', url: artworkUrl(DISCOVERED), headers: portalCookie });
    expect(dexQueries).toEqual([{ playerId: PLAYER_ID, slug: DISCOVERED }]);
  });

  it('refuses when the session has no resolved player — unknown is not allowed', async () => {
    // Mid guild-selection, or a Discord account with no profile in the guild.
    // There is no dex to consult, so there is nothing to authorize against.
    currentSession = { playerId: null };
    const res = await app.inject({
      method: 'GET',
      url: artworkUrl(DISCOVERED),
      headers: portalCookie,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'SPECIES_NOT_DISCOVERED' } });
    expect(dexQueries).toEqual([]);
  });

  it('does not inherit another player’s dex', async () => {
    // Player 2 owns both. The answer must follow the session, not the widest
    // dex the process has recently seen.
    const res = await app.inject({
      method: 'GET',
      url: artworkUrl(UNDISCOVERED),
      headers: portalCookie,
    });

    expect(res.statusCode).toBe(403);
    expect(dexQueries).toEqual([{ playerId: PLAYER_ID, slug: UNDISCOVERED }]);
  });

  it('still answers 404 for a slug that does not exist', async () => {
    // Existence is decided before discovery, so a typo stays a typo rather
    // than becoming an ambiguous 403.
    const res = await app.inject({
      method: 'GET',
      url: artworkUrl('no_such_species_here'),
      headers: portalCookie,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'SPECIES_NOT_FOUND' } });
  });

  it('marks the response private, so no shared cache can re-serve it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: artworkUrl(DISCOVERED),
      headers: portalCookie,
    });

    expect(res.headers['cache-control']).toBe('private, max-age=300, must-revalidate');
  });

  it('cannot be reached at all without a credential', async () => {
    const res = await app.inject({ method: 'GET', url: artworkUrl(UNDISCOVERED) });
    expect(res.statusCode).toBe(401);
  });
});

describe('rendered species cards — the same rule', () => {
  it('refuses an undiscovered species: a frame around the art is still the art', async () => {
    const res = await app.inject({
      method: 'GET',
      url: cardUrl(UNDISCOVERED),
      headers: portalCookie,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'SPECIES_NOT_DISCOVERED' } });
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('renders a discovered species', async () => {
    const res = await app.inject({
      method: 'GET',
      url: cardUrl(DISCOVERED),
      headers: portalCookie,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
  });
});

describe('bearer-token callers are unrestricted', () => {
  it('serves any species’ artwork — the bot and the tools have no dex', async () => {
    for (const slug of ALL_SLUGS) {
      const res = await app.inject({ method: 'GET', url: artworkUrl(slug), headers: BEARER });
      expect(res.statusCode, slug).toBe(200);
    }
    expect(dexQueries).toEqual([]);
  });

  it('renders any species’ card', async () => {
    for (const slug of ALL_SLUGS) {
      const res = await app.inject({ method: 'GET', url: cardUrl(slug), headers: BEARER });
      expect(res.statusCode, slug).toBe(200);
    }
  });
});
