/**
 * Admin Gallery routes — the authorization boundary and wire shape over real
 * HTTP (auth hook, permission guard, handler), no database.
 *
 * Sessions get permissions the production way: the guild owner holds every
 * permission unconditionally; anyone else holds exactly what their Discord
 * roles are granted *in the selected guild*.
 *
 * Pinned:
 *   - `gallery.read` opens both routes; the owner has it without a grant;
 *   - no permission, `admin.access`, `presentations.read`, every other
 *     grantable permission, a grant made in another guild, and the bearer
 *     token by default are all refused — before anything is looked up;
 *   - the list carries every authored species, disabled packs included, in one
 *     response; detail carries every authored appearance;
 *   - the player catalog (`/content/species`) is unaffected.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  ALL_PORTAL_PERMISSIONS,
  GRANTABLE_PORTAL_PERMISSIONS,
  PORTAL_PERMISSION_DESCRIPTIONS,
  ROLE_GRANT_PRESETS,
  presetForPermissions,
  type PortalPermission,
} from '../../../src/modules/portalAuth/portalAuthService';
import { loadContent } from '../../../src/modules/content/loader';
import type { LoadedContent } from '../../../src/modules/content/schemas';
import { createLogger } from '../../../src/shared/logger';
import {
  buildGalleryServer,
  OTHER_GUILD,
  SESSION_COOKIES,
  TEST_TOKEN,
} from '../../helpers/galleryApiHarness';
import { createGalleryTree, gallerySpecies, type GalleryTree } from '../../helpers/galleryFixtures';

let tree: GalleryTree;
let content: LoadedContent;

beforeAll(() => {
  tree = createGalleryTree({
    core: [gallerySpecies('complete_girl'), gallerySpecies('dropped_girl')],
    packs: [{ id: 'future_pack', enabled: false, species: [gallerySpecies('future_girl')] }],
  });
  for (const id of ['standard', 'level_10', 'level_20']) {
    tree.art(`waifumon/complete_girl/${id}.webp`);
    tree.art(`waifumon/future_girl/${id}.webp`);
  }
  tree.art('waifumon/dropped_girl/standard.webp');
  tree.art('waifumon/dropped_girl/level_10.webp');
  content = loadContent(tree.contentDir, tree.assetsDir, createLogger('silent'));
});

afterAll(() => tree.cleanup());

interface Build {
  as?: 'owner' | 'member';
  rolePermissions?: readonly PortalPermission[];
  /** The guild the role grant was made in. Defaults to the session's own. */
  grantGuild?: string;
  adminBearerAllowed?: boolean;
}

let app: ZodFastify | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(opts: Build = {}): Promise<ZodFastify> {
  return buildGalleryServer({ content, assetsDir: tree.assetsDir, ...opts });
}

const COOKIES = SESSION_COOKIES;
const LIST = '/api/v1/admin/gallery/species';
const DETAIL = '/api/v1/admin/gallery/species/dropped_girl';
const ROUTES = [LIST, DETAIL];

const get = (url: string, headers: Record<string, string> = COOKIES) =>
  app!.inject({ method: 'GET', url, headers });

describe('permission vocabulary', () => {
  it('adds gallery.read: grantable, described, held by the owner set', () => {
    expect(ALL_PORTAL_PERMISSIONS).toContain('gallery.read');
    expect(GRANTABLE_PORTAL_PERMISSIONS).toContain('gallery.read');
    expect(PORTAL_PERMISSION_DESCRIPTIONS['gallery.read']).toMatch(/\S/);
  });

  it('offers a gallery_viewer preset holding exactly gallery.read', () => {
    expect([...ROLE_GRANT_PRESETS.gallery_viewer]).toEqual(['gallery.read']);
    expect(presetForPermissions(['gallery.read'])).toBe('gallery_viewer');
    for (const [name, preset] of Object.entries(ROLE_GRANT_PRESETS)) {
      if (name !== 'gallery_viewer') expect(preset).not.toContain('gallery.read');
    }
  });
});

describe('who may read the gallery', () => {
  it.each(ROUTES)('the guild owner may GET %s', async (url) => {
    app = await build({ as: 'owner' });
    expect((await get(url)).statusCode).toBe(200);
  });

  it.each(ROUTES)('a role granted gallery.read may GET %s', async (url) => {
    app = await build({ rolePermissions: ['gallery.read'] });
    expect((await get(url)).statusCode).toBe(200);
  });

  it.each(ROUTES)('an ordinary player (no permission) is refused %s', async (url) => {
    app = await build({ rolePermissions: [] });
    const res = await get(url);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
  });

  it.each(ROUTES)('admin.access alone is refused %s', async (url) => {
    app = await build({ rolePermissions: ['admin.access'] });
    expect((await get(url)).statusCode).toBe(403);
  });

  it.each(ROUTES)('presentations.read alone is refused %s', async (url) => {
    app = await build({ rolePermissions: ['presentations.read'] });
    expect((await get(url)).statusCode).toBe(403);
  });

  it.each(ROUTES)('every other grantable permission together is refused %s', async (url) => {
    app = await build({
      rolePermissions: GRANTABLE_PORTAL_PERMISSIONS.filter((p) => p !== 'gallery.read'),
    });
    expect((await get(url)).statusCode).toBe(403);
  });

  it.each(ROUTES)('a gallery.read grant made in another guild is refused %s', async (url) => {
    app = await build({ rolePermissions: ['gallery.read'], grantGuild: OTHER_GUILD });
    expect((await get(url)).statusCode).toBe(403);
  });

  it.each(ROUTES)('no session at all is 401 on %s', async (url) => {
    app = await build({ as: 'owner' });
    expect((await get(url, {})).statusCode).toBe(401);
  });

  it.each(ROUTES)('the bearer token is refused by default on %s', async (url) => {
    app = await build();
    expect((await get(url, { authorization: `Bearer ${TEST_TOKEN}` })).statusCode).toBe(403);
  });

  it.each(ROUTES)('the bearer token passes %s only with the operator opt-in', async (url) => {
    app = await build({ adminBearerAllowed: true });
    expect((await get(url, { authorization: `Bearer ${TEST_TOKEN}` })).statusCode).toBe(200);
  });

  it('refuses before looking anything up, so existence is not disclosed', async () => {
    app = await build({ rolePermissions: [] });
    expect((await get('/api/v1/admin/gallery/species/nobody_girl')).statusCode).toBe(403);
    expect((await get('/api/v1/admin/gallery/species/NOT-A-SLUG')).statusCode).toBe(403);
  });
});

describe('GET /admin/gallery/species', () => {
  it('returns every authored species, including a disabled pack, in one response', async () => {
    app = await build({ rolePermissions: ['gallery.read'] });
    const res = await get(LIST);
    expect(res.statusCode).toBe(200);
    const { species, summary } = res.json().data;
    expect(species.map((s: { slug: string }) => s.slug)).toEqual([
      'complete_girl',
      'dropped_girl',
      'future_girl',
    ]);
    expect(summary).toMatchObject({
      authoredSpecies: 3,
      runtimeLoadedSpecies: 2,
      unloadedSpecies: 1,
      authoredAppearances: 9,
      runtimeAppearances: 5,
    });
    const future = species.find((s: { slug: string }) => s.slug === 'future_girl');
    expect(future).toMatchObject({
      source: { kind: 'expansion', expansionId: 'future_pack', expansionEnabled: false },
      runtime: { loaded: false, enabled: null },
      appearanceCounts: { authored: 3, inRuntime: null, artworkAvailable: 3 },
      primary: { appearanceId: 'standard', status: 'available', format: 'webp' },
      tags: ['waifu_valley'],
    });
  });

  it('carries no imagePath and no filesystem location', async () => {
    app = await build({ rolePermissions: ['gallery.read'] });
    const body = (await get(LIST)).body + (await get(DETAIL)).body;
    expect(body).not.toContain('imagePath');
    expect(body).not.toContain(tree.root);
  });

  it('ignores any path-like query — there is no parameter that names a file', async () => {
    app = await build({ rolePermissions: ['gallery.read'] });
    const res = await get(`${LIST}?path=../../etc/passwd`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('root:');
  });
});

describe('GET /admin/gallery/species/:slug', () => {
  it('returns every authored appearance, marking the one the runtime dropped', async () => {
    app = await build({ rolePermissions: ['gallery.read'] });
    const res = await get(DETAIL);
    expect(res.statusCode).toBe(200);
    const detail = res.json().data;
    expect(detail.appearanceCounts).toEqual({ authored: 3, inRuntime: 2, artworkAvailable: 2 });
    expect(
      detail.appearances.map((a: { id: string; inRuntime: boolean; artwork: { status: string } }) => [
        a.id,
        a.inRuntime,
        a.artwork.status,
      ]),
    ).toEqual([
      ['standard', true, 'available'],
      ['level_10', true, 'available'],
      ['level_20', false, 'missing'],
    ]);
    expect(detail.appearances[2]).toMatchObject({
      assetId: { kind: 'waifumon', slug: 'dropped_girl', variant: 'level_20' },
      loaderDiagnostics: ['appearance_dropped_artwork_missing'],
      unlock: { type: 'level', atLevel: 20 },
      contentRatingSource: 'species',
    });
    expect(detail.appearances[0].artwork.renditions).toEqual({ 256: false, 512: false, 1024: false });
    expect(detail.loaderDiagnostics).toEqual([
      {
        code: 'appearance_dropped_artwork_missing',
        slug: 'dropped_girl',
        appearanceId: 'level_20',
        assetId: { kind: 'waifumon', slug: 'dropped_girl', variant: 'level_20' },
      },
    ]);
  });

  it('inspects a species from a disabled expansion pack', async () => {
    app = await build({ rolePermissions: ['gallery.read'] });
    const res = await get('/api/v1/admin/gallery/species/future_girl');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ runtime: { loaded: false } });
    expect(res.json().data.appearances).toHaveLength(3);
  });

  it('answers 404 for a slug no content defines', async () => {
    app = await build({ rolePermissions: ['gallery.read'] });
    const res = await get('/api/v1/admin/gallery/species/nobody_girl');
    expect(res.statusCode).toBe(404);
  });

  it.each(['NOT-A-SLUG', 'a.b', 'a%2Fb'])('answers 400 for a malformed slug: %s', async (slug) => {
    app = await build({ rolePermissions: ['gallery.read'] });
    expect((await get(`/api/v1/admin/gallery/species/${slug}`)).statusCode).toBe(400);
  });

  it.each(['..', '%2e%2e', '..%2Ffuture_girl'])(
    'never serves a traversal-shaped segment: %s',
    async (slug) => {
      app = await build({ rolePermissions: ['gallery.read'] });
      const res = await get(`/api/v1/admin/gallery/species/${slug}`);
      // Normalized away to a route that does not exist, or refused by the
      // slug pattern — either way nothing is looked up.
      expect([400, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain('appearances');
    },
  );
});

describe('the player catalog is untouched', () => {
  it('/content/species still lists only runtime species, with no authoring record', async () => {
    app = await build({ rolePermissions: [] });
    const res = await get('/api/v1/content/species');
    expect(res.statusCode).toBe(200);
    const slugs = res.json().data.map((s: { slug: string }) => s.slug).sort();
    expect(slugs).toEqual(['complete_girl', 'dropped_girl']);
    expect(res.body).not.toContain('future_girl');
    expect(res.body).not.toContain('authoring');
    expect(res.body).not.toContain('artworkDiagnostics');
  });

  it('/content/species/:slug does not know an unloaded species', async () => {
    app = await build({ rolePermissions: [] });
    expect((await get('/api/v1/content/species/future_girl')).statusCode).toBe(404);
  });
});
