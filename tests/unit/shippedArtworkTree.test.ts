/**
 * The shipped artwork tree as it really is in this repository, run through
 * the same resolver and browser the Admin Portal and Discord use.
 *
 * Two things this pins down:
 *
 *   - the resolver/browser work against the real `assets/` root — known
 *     shipped images (onboarding's Patches, the Combat Trial enemies) resolve
 *     and are browsable;
 *   - what content *configures* versus what is actually shipped. A configured
 *     path with no file is legal (screens fall back), so nothing here fails
 *     because art is missing — but a path that exists must resolve, and the
 *     Docker runtime must mount the whole tree at `ASSETS_DIR`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { locateArtworkFile } from '../../src/modules/assets/artworkFile';
import { browseArtworkDirectory, searchArtwork } from '../../src/modules/assets/artworkBrowser';
import { conventionalCombatArtworkPath } from '../../src/modules/combat/combatArtwork';
import { CombatEnemyFileSchema } from '../../src/modules/combat/enemyDefinitions';

const REPO = path.resolve(__dirname, '..', '..');
const ASSETS = path.join(REPO, 'assets');
const CONTENT = path.join(REPO, 'content');
const onDisk = (relative: string) => fs.existsSync(path.join(ASSETS, relative));
/** The root the Admin dungeon artwork picker is confined to (`api/routes/v1/admin/dungeons.ts`). */
const DUNGEON_ARTWORK_ROOTS = ['dungeons'] as const;

describe('known shipped artwork resolves through the shared resolver', () => {
  it('the onboarding NPC portrait', () => {
    expect(locateArtworkFile(ASSETS, 'npc/patches.webp')).toMatchObject({
      status: 'available',
      absolutePath: path.join(ASSETS, 'npc', 'patches.webp'),
      contentType: 'image/webp',
    });
  });

  it('every Combat enemy that names artwork, at the underscore-key convention', () => {
    const { enemies } = CombatEnemyFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTENT, 'combat', 'enemies.json'), 'utf8')));
    const withArt = enemies.filter((e) => e.artworkPath !== null);
    expect(withArt.length).toBeGreaterThan(0);
    for (const enemy of withArt) {
      // The convention is the content key verbatim — underscores, not hyphens.
      expect(enemy.artworkPath).toBe(conventionalCombatArtworkPath('enemies', enemy.key));
      expect(locateArtworkFile(ASSETS, enemy.artworkPath!).status, enemy.artworkPath!).toBe('available');
    }
  });

  it('a well-formed path with no file is "missing", and a bad one "unsafe" — never a throw', () => {
    expect(locateArtworkFile(ASSETS, 'dungeons/backgrounds/not_a_real_file.webp')).toEqual({ status: 'missing' });
    expect(locateArtworkFile(ASSETS, '../package.json').status).toBe('unsafe');
    expect(locateArtworkFile(ASSETS, 'assets/npc/patches.webp').status).toBe('missing');
  });
});

describe('the shipped-art browser works against the real tree', () => {
  it('lists the Combat enemy folder and finds its files by search', async () => {
    const top = await browseArtworkDirectory(ASSETS, ['combat'], '');
    expect(top).toMatchObject({ path: 'combat', missing: false });
    expect(top.directories.map((d) => d.path)).toContain('combat/enemies');
    const enemies = await browseArtworkDirectory(ASSETS, ['combat'], 'combat/enemies');
    expect(enemies.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['combat/enemies/alley_bruiser.webp', 'combat/enemies/scrapyard_drone.webp']),
    );
    const found = await searchArtwork(ASSETS, ['combat'], 'scrapyard');
    expect(found.results.map((r) => r.path)).toEqual(['combat/enemies/scrapyard_drone.webp']);
  });

  it('lists the NPC folder', async () => {
    const npc = await browseArtworkDirectory(ASSETS, ['npc'], '');
    expect(npc.files.map((f) => f.path)).toContain('npc/patches.webp');
  });

  it('the dungeon root answers for whatever is really there: a listing, or "nothing shipped yet"', async () => {
    const listing = await browseArtworkDirectory(ASSETS, DUNGEON_ARTWORK_ROOTS, '');
    expect(listing.path).toBe('dungeons');
    // Whichever it is today, the answer agrees with the disk — and is never an error.
    expect(listing.missing).toBe(!onDisk('dungeons'));
    if (listing.missing) expect(listing).toMatchObject({ directories: [], files: [] });
  });
});

describe('Docker runtime asset root', () => {
  const compose = fs.readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');

  it('mounts the whole assets directory at ASSETS_DIR — no per-folder copy to forget', () => {
    expect(compose).toMatch(/ASSETS_DIR: \/app\/assets\b/);
    // One bind of the entire tree: a new top-level folder (dungeons/) needs no compose or image change.
    expect(compose).toMatch(/- \.\/assets:\/app\/assets:ro/);
    // The image itself ships no artwork: nothing is selectively COPY'd in, so nothing can be left out.
    expect(dockerfile).not.toMatch(/^\s*COPY\s+.*assets/m);
  });

  it('keeps managed uploads and the scene cache out of the shipped tree', () => {
    const managed = /MANAGED_ASSETS_DIR: (\S+)/.exec(compose)?.[1];
    const cache = /ART_CACHE_DIR: (\S+)/.exec(compose)?.[1];
    expect(managed).toBe('/data/waifumon-assets');
    expect(cache).toBe('/data/waifumon-art-cache');
    for (const dir of [managed!, cache!]) expect(dir.startsWith('/app/assets')).toBe(false);
  });
});
