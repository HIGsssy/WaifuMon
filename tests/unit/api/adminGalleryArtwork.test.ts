/**
 * Admin Gallery artwork — `GET /admin/gallery/species/:slug/appearances/:id/artwork`.
 *
 * Every fixture file holds distinct bytes, so "which file was served" is an
 * assertion on the body rather than an inference from a status code. That is
 * what pins the rule this route exists for: **the exact appearance or 404** —
 * a missing `level_20` must never come back as `standard`.
 *
 * Also pinned: `gallery.read` and nothing else opens it, before any lookup; an
 * unloaded expansion's art is servable here and nowhere player-facing; the
 * shared containment check refuses every symlink out of the assets root; and
 * the player artwork routes, which now share the response helper, behave as
 * before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { PortalPermission } from '../../../src/modules/portalAuth/portalAuthService';
import { loadContent } from '../../../src/modules/content/loader';
import type { LoadedContent } from '../../../src/modules/content/schemas';
import { createLogger } from '../../../src/shared/logger';
import {
  buildGalleryServer,
  OTHER_GUILD,
  SESSION_COOKIES,
  TEST_TOKEN,
  type GalleryServerOptions,
} from '../../helpers/galleryApiHarness';
import { createGalleryTree, gallerySpecies, type GalleryTree } from '../../helpers/galleryFixtures';

const SECRET = 'OUTSIDE-SECRET-BYTES';

let tree: GalleryTree;
let content: LoadedContent;

/** Writes `bytes` at `relative` and returns them, so assertions can name them. */
function art(relative: string): string {
  const bytes = `BYTES<${relative}>`;
  tree.art(relative, bytes);
  return bytes;
}

const B: Record<string, string> = {};

beforeAll(() => {
  tree = createGalleryTree({
    core: [
      gallerySpecies('art_girl'),
      gallerySpecies('gap_girl'),
      gallerySpecies('ghost_girl'),
      gallerySpecies('disabled_girl', { enabled: false }),
      gallerySpecies('sym_girl'),
      gallerySpecies('dirsym_girl'),
    ],
    packs: [{ id: 'future_pack', enabled: false, species: [gallerySpecies('future_girl')] }],
  });

  // art_girl: WebP standard with every rendition; WebP level_10 with none;
  // level_20 stored only as the PNG master, with a WebP 256 rendition.
  B.artStd = art('waifumon/art_girl/standard.webp');
  B.artStd256 = art('.thumbnails/256/waifumon/art_girl/standard.webp');
  B.artStd512 = art('.thumbnails/512/waifumon/art_girl/standard.webp');
  B.artStd1024 = art('.thumbnails/1024/waifumon/art_girl/standard.webp');
  B.artL10 = art('waifumon/art_girl/level_10.webp');
  B.artL20Png = art('waifumon/art_girl/level_20.png');
  B.artL20Png256 = art('.thumbnails/256/waifumon/art_girl/level_20.webp');

  // gap_girl: level_20 missing — the loader drops it from the runtime.
  B.gapStd = art('waifumon/gap_girl/standard.webp');
  B.gapL10 = art('waifumon/gap_girl/level_10.webp');

  // ghost_girl: nothing at all — the loader disables her.

  // disabled_girl: authored `enabled: false`, artwork complete.
  B.disStd = art('waifumon/disabled_girl/standard.webp');
  art('waifumon/disabled_girl/level_10.webp');
  art('waifumon/disabled_girl/level_20.webp');

  // future_girl: in a switched-off pack.
  B.futStd = art('waifumon/future_girl/standard.webp');
  B.futL20 = art('waifumon/future_girl/level_20.webp');
  art('waifumon/future_girl/level_10.webp');

  // Outside the assets root.
  const secretFile = path.join(tree.root, 'outside.webp');
  fs.writeFileSync(secretFile, SECRET);
  const secretDir = path.join(tree.root, 'outside-dir');
  fs.mkdirSync(secretDir);
  for (const id of ['standard', 'level_10', 'level_20']) {
    fs.writeFileSync(path.join(secretDir, `${id}.webp`), SECRET);
  }

  // sym_girl: level_20 is a symlink out; standard's 256 rendition too.
  B.symStd = art('waifumon/sym_girl/standard.webp');
  art('waifumon/sym_girl/level_10.webp');
  fs.symlinkSync(secretFile, path.join(tree.assetsDir, 'waifumon/sym_girl/level_20.webp'));
  fs.mkdirSync(path.join(tree.assetsDir, '.thumbnails/256/waifumon/sym_girl'), { recursive: true });
  fs.symlinkSync(
    secretFile,
    path.join(tree.assetsDir, '.thumbnails/256/waifumon/sym_girl/standard.webp'),
  );

  // dirsym_girl: her whole directory is a symlink out.
  fs.symlinkSync(secretDir, path.join(tree.assetsDir, 'waifumon/dirsym_girl'));

  content = loadContent(tree.contentDir, tree.assetsDir, createLogger('silent'));
});

afterAll(() => tree.cleanup());

let app: ZodFastify | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Build = Omit<GalleryServerOptions, 'content' | 'assetsDir'>;
const build = (opts: Build = {}) =>
  buildGalleryServer({ content, assetsDir: tree.assetsDir, ...opts });
const admin = () => build({ rolePermissions: ['gallery.read'] });

const url = (slug: string, appearance: string, query = '') =>
  `/api/v1/admin/gallery/species/${slug}/appearances/${appearance}/artwork${query}`;

const get = (target: string, headers: Record<string, string> = SESSION_COOKIES) =>
  app!.inject({ method: 'GET', url: target, headers });

describe('authorization', () => {
  const OK = url('art_girl', 'level_10');

  it('the guild owner may fetch', async () => {
    app = await build({ as: 'owner' });
    expect((await get(OK)).statusCode).toBe(200);
  });

  it('a role granted gallery.read may fetch', async () => {
    app = await admin();
    const res = await get(OK);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(B.artL10);
  });

  it.each<[string, PortalPermission[]]>([
    ['no permission (an ordinary player)', []],
    ['admin.access alone', ['admin.access']],
    ['presentations.read alone', ['presentations.read']],
    [
      'every encounter and presentation permission',
      [
        'admin.access',
        'encounters.read',
        'encounters.write',
        'encounters.publish',
        'encounters.simulate',
        'encounters.history',
        'presentations.read',
        'presentations.write',
      ],
    ],
  ])('%s → 403', async (_label, rolePermissions) => {
    app = await build({ rolePermissions });
    const res = await get(OK);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
  });

  it('a gallery.read grant made in another guild → 403', async () => {
    app = await build({ rolePermissions: ['gallery.read'], grantGuild: OTHER_GUILD });
    expect((await get(OK)).statusCode).toBe(403);
  });

  it('no session → 401', async () => {
    app = await build({ as: 'owner' });
    expect((await get(OK, {})).statusCode).toBe(401);
  });

  it('the bearer token → 403 by default, 200 with the operator opt-in', async () => {
    app = await build();
    expect((await get(OK, { authorization: `Bearer ${TEST_TOKEN}` })).statusCode).toBe(403);
    await app.close();
    app = await build({ adminBearerAllowed: true });
    expect((await get(OK, { authorization: `Bearer ${TEST_TOKEN}` })).statusCode).toBe(200);
  });

  it('owning the species grants nothing here — while the player route still serves her', async () => {
    app = await build({
      rolePermissions: [],
      services: { collection: { hasDiscoveredSpeciesSlug: async () => true } },
    });
    expect((await get(url('art_girl', 'standard'))).statusCode).toBe(403);
    const player = await get('/api/v1/assets/waifumon/art_girl');
    expect(player.statusCode).toBe(200);
    expect(player.body).toBe(B.artStd);
  });

  it('refuses before any lookup: every resource state looks identical without permission', async () => {
    app = await build({ rolePermissions: [] });
    const probes = [
      url('art_girl', 'level_10'), // exists
      url('future_girl', 'standard'), // unreleased, exists
      url('gap_girl', 'level_20'), // authored, missing
      url('sym_girl', 'level_20'), // unsafe
      url('art_girl', 'no_such_look'), // unknown appearance
      url('nobody_girl', 'standard'), // unknown species
      url('NOT-A-SLUG', 'standard'), // malformed
      url('art_girl', 'standard', '?width=300'), // malformed width
    ];
    const answers = await Promise.all(probes.map((p) => get(p)));
    for (const res of answers) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PORTAL_PERMISSION_DENIED');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    }
    const bodies = answers.map((r) => {
      const { error } = r.json();
      return JSON.stringify({ code: error.code, message: error.message });
    });
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('lookup against the authored catalog', () => {
  it('serves a runtime species’ default appearance', async () => {
    app = await admin();
    const res = await get(url('art_girl', 'standard'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(B.artStd);
  });

  it('serves a locked level appearance', async () => {
    app = await admin();
    expect((await get(url('art_girl', 'level_10'))).body).toBe(B.artL10);
  });

  it('serves a species the author disabled', async () => {
    app = await admin();
    const res = await get(url('disabled_girl', 'standard'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(B.disStd);
  });

  it('serves a species from a disabled expansion pack, which gameplay never sees', async () => {
    app = await admin();
    const res = await get(url('future_girl', 'level_20'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(B.futL20);
    expect(content.species.map((s) => s.slug)).not.toContain('future_girl');
    expect(content.expansions.find((e) => e.id === 'future_pack')?.enabled).toBe(false);
  });

  it('serves an authored appearance the runtime dropped, once its file exists', async () => {
    const late = art('waifumon/gap_girl/level_20.webp');
    try {
      // The snapshot was loaded before the file existed: the runtime still
      // lacks level_20, but it is authored, so the gallery can show it.
      expect(content.species.find((s) => s.slug === 'gap_girl')!.appearances!.map((a) => a.id))
        .not.toContain('level_20');
      app = await admin();
      const res = await get(url('gap_girl', 'level_20'));
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(late);
    } finally {
      fs.rmSync(path.join(tree.assetsDir, 'waifumon/gap_girl/level_20.webp'));
    }
  });

  it('unknown species → 404 SPECIES_NOT_FOUND', async () => {
    app = await admin();
    const res = await get(url('nobody_girl', 'standard'));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SPECIES_NOT_FOUND');
  });

  it('unknown appearance → 404', async () => {
    app = await admin();
    const res = await get(url('art_girl', 'no_such_look'));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('the exact appearance, or nothing', () => {
  it('a missing level appearance → 404', async () => {
    app = await admin();
    const res = await get(url('gap_girl', 'level_20'));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it.each(['', '?width=256', '?width=512', '?width=1024'])(
    'a missing level appearance never returns another look’s bytes (%s)',
    async (query) => {
      app = await admin();
      const res = await get(url('gap_girl', 'level_20', query));
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).not.toContain(B.gapStd);
      expect(res.body).not.toContain(B.gapL10);
      expect(res.body).not.toContain('BYTES<');
    },
  );

  it('missing default artwork → 404, with no legacy or placeholder substitute', async () => {
    app = await admin();
    const res = await get(url('ghost_girl', 'standard'));
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('BYTES<');
  });

  it('a PNG-only appearance is served as PNG', async () => {
    app = await admin();
    const res = await get(url('art_girl', 'level_20'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body).toBe(B.artL20Png);
  });
});

describe('renditions', () => {
  it('no width → the original', async () => {
    app = await admin();
    const res = await get(url('art_girl', 'standard'));
    expect(res.body).toBe(B.artStd);
    expect(res.headers['content-type']).toBe('image/webp');
  });

  it.each([
    ['256', 'artStd256'],
    ['512', 'artStd512'],
    ['1024', 'artStd1024'],
  ])('width=%s → that rendition', async (width, key) => {
    app = await admin();
    const res = await get(url('art_girl', 'standard', `?width=${width}`));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(B[key]);
    expect(res.headers['content-type']).toBe('image/webp');
  });

  it('a missing rendition falls back to the same appearance’s original, never another look', async () => {
    app = await admin();
    const res = await get(url('art_girl', 'level_10', '?width=512'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(B.artL10);
  });

  it('a PNG source is served its WebP rendition, with the matching Content-Type', async () => {
    app = await admin();
    const thumb = await get(url('art_girl', 'level_20', '?width=256'));
    expect(thumb.body).toBe(B.artL20Png256);
    expect(thumb.headers['content-type']).toBe('image/webp');
    const original = await get(url('art_girl', 'level_20', '?width=512'));
    expect(original.body).toBe(B.artL20Png);
    expect(original.headers['content-type']).toBe('image/png');
  });

  it.each(['300', '0', '-256', 'abc', '256.5', ''])('width=%s → 400', async (width) => {
    app = await admin();
    const res = await get(url('art_girl', 'standard', `?width=${width}`));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('HTTP caching', () => {
  it('sends a weak ETag and private caching', async () => {
    app = await admin();
    const res = await get(url('art_girl', 'standard'));
    expect(res.headers.etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(res.headers['cache-control']).toBe('private, max-age=300, must-revalidate');
    expect(res.headers['cache-control']).not.toMatch(/public/);
  });

  it('answers a matching If-None-Match with an empty 304', async () => {
    app = await admin();
    const first = await get(url('art_girl', 'standard', '?width=256'));
    const res = await get(url('art_girl', 'standard', '?width=256'), {
      ...SESSION_COOKIES,
      'if-none-match': String(first.headers.etag),
    });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
    expect(res.headers.etag).toBe(first.headers.etag);
    expect(res.headers['cache-control']).toBe('private, max-age=300, must-revalidate');
  });

  it('a stale If-None-Match gets the bytes', async () => {
    app = await admin();
    const res = await get(url('art_girl', 'standard'), {
      ...SESSION_COOKIES,
      'if-none-match': 'W/"0-0"',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(B.artStd);
  });
});

describe('containment', () => {
  it('never serves exact artwork symlinked out of the assets root', async () => {
    app = await admin();
    for (const query of ['', '?width=256']) {
      const res = await get(url('sym_girl', 'level_20', query));
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(SECRET);
    }
  });

  it('never serves a species directory symlinked out of the assets root', async () => {
    app = await admin();
    for (const id of ['standard', 'level_10', 'level_20']) {
      const res = await get(url('dirsym_girl', id));
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(SECRET);
    }
  });

  it('serves the contained original when a rendition is symlinked out', async () => {
    app = await admin();
    const res = await get(url('sym_girl', 'standard', '?width=256'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(B.symStd);
    expect(res.body).not.toContain(SECRET);
  });

  it('errors disclose no filesystem location', async () => {
    app = await admin();
    for (const target of [
      url('sym_girl', 'level_20'),
      url('dirsym_girl', 'standard'),
      url('gap_girl', 'level_20'),
      url('art_girl', 'no_such_look'),
    ]) {
      const body = (await get(target)).body;
      expect(body).not.toContain(tree.root);
      expect(body).not.toContain('outside');
      expect(body).not.toContain('.webp');
      expect(body).not.toContain('.png');
      expect(body).not.toMatch(/ENOENT|ELOOP|realpath|symbolic/i);
    }
  });

  it.each([
    ['..', 'standard'],
    ['%2e%2e', 'standard'],
    ['art_girl', '..'],
    ['art_girl', '%2e%2e'],
    ['art_girl', '..%2F..%2Foutside'],
    ['art_girl', 'a%2Fb'],
    ['art_girl', 'a%5Cb'],
    ['art_girl', 'Level_10'],
    ['art_girl', 'level-10'],
    ['art_girl', 'level_10.webp'],
    ['a%2Fb', 'standard'],
    ['art_girl', 'x'.repeat(121)],
    ['x'.repeat(121), 'standard'],
  ])('rejects a non-identifier segment: %s / %s', async (slug, appearance) => {
    app = await admin();
    const res = await get(url(slug, appearance));
    // 414 is Fastify refusing a parameter over its length limit before routing.
    expect([400, 404, 414]).toContain(res.statusCode);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).not.toContain('BYTES<');
    expect(res.body).not.toContain(SECRET);
  });

  it('accepts no path-like query parameter at all', async () => {
    app = await admin();
    for (const query of ['?path=waifumon/art_girl/standard.webp', '?assetId=x', '?stem=x']) {
      const res = await get(url('art_girl', 'level_10', query));
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('player-facing routes stay closed to unreleased art', () => {
  it('/assets/waifumon/:slug does not know a species from a disabled pack', async () => {
    app = await build({
      as: 'owner',
      services: { collection: { hasDiscoveredSpeciesSlug: async () => true } },
    });
    expect((await get('/api/v1/assets/waifumon/future_girl')).statusCode).toBe(404);
    expect(
      (await get('/api/v1/assets/waifumon/future_girl', { authorization: `Bearer ${TEST_TOKEN}` }))
        .statusCode,
    ).toBe(404);
  });

  it('/content/species does not list it', async () => {
    app = await build();
    const res = await get('/api/v1/content/species');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('future_girl');
  });
});

describe('player species artwork through the shared response helper', () => {
  const discovered = () =>
    build({ services: { collection: { hasDiscoveredSpeciesSlug: async () => true } } });

  it('serves the default look, with the same ETag and cache headers as before', async () => {
    app = await discovered();
    const res = await get('/api/v1/assets/waifumon/art_girl');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(B.artStd);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('private, max-age=300, must-revalidate');
    expect(res.headers.etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    const again = await get('/api/v1/assets/waifumon/art_girl', {
      ...SESSION_COOKIES,
      'if-none-match': String(res.headers.etag),
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('serves renditions, and rejects an unsupported width, as before', async () => {
    app = await discovered();
    expect((await get('/api/v1/assets/waifumon/art_girl?width=512')).body).toBe(B.artStd512);
    const bad = await get('/api/v1/assets/waifumon/art_girl?width=300');
    expect(bad.statusCode).toBe(400);
  });

  it('still refuses an undiscovered species', async () => {
    app = await build({
      services: { collection: { hasDiscoveredSpeciesSlug: async () => false } },
    });
    const res = await get('/api/v1/assets/waifumon/art_girl');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SPECIES_NOT_DISCOVERED');
  });
});
