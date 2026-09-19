/**
 * Throwaway content + assets trees for the Admin Gallery tests.
 *
 * The real `items.json` and `tables.json` are copied in so `loadContent` runs
 * its full pipeline — schema, cross-file validation, asset pre-flight — over a
 * handful of hand-written species, core and expansion alike. Artwork is a few
 * bytes per file: only existence and containment are ever examined.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_CONTENT = path.resolve(process.cwd(), 'content');

export interface GalleryTree {
  root: string;
  contentDir: string;
  assetsDir: string;
  /** Writes a file under the assets root, creating folders as needed. */
  art(relative: string, bytes?: string): void;
  cleanup(): void;
}

export interface GalleryPack {
  id: string;
  enabled: boolean;
  species: Record<string, unknown>[];
}

/** A species with a three-entry catalog: `standard` (owned), `level_10`, `level_20`. */
export function gallerySpecies(
  slug: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug,
    name: slug
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' '),
    rarity: 'R',
    archetype: 'human',
    race: 'human',
    tags: ['waifu_valley'],
    contentRating: 'mature',
    affinity: 'dominant',
    imagePath: `waifumon/${slug}/standard.png`,
    enabled: true,
    appearances: [
      { id: 'standard', name: 'Standard', sortOrder: 0, unlock: { type: 'owned' } },
      { id: 'level_20', name: 'Level 20', sortOrder: 20, unlock: { type: 'level', atLevel: 20 } },
      { id: 'level_10', name: 'Level 10', sortOrder: 10, unlock: { type: 'level', atLevel: 10 } },
    ],
    ...overrides,
  };
}

export function createGalleryTree(opts: {
  core: Record<string, unknown>[];
  packs?: GalleryPack[];
}): GalleryTree {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-gallery-'));
  const contentDir = path.join(root, 'content');
  const assetsDir = path.join(root, 'assets');
  fs.mkdirSync(path.join(contentDir, 'species'), { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const file of ['items.json', 'tables.json']) {
    fs.copyFileSync(path.join(REPO_CONTENT, file), path.join(contentDir, file));
  }
  fs.writeFileSync(path.join(contentDir, 'species', 'core.json'), JSON.stringify(opts.core));

  for (const pack of opts.packs ?? []) {
    const dir = path.join(contentDir, 'expansions', pack.id);
    fs.mkdirSync(path.join(dir, 'species'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'expansion.json'),
      JSON.stringify({ id: pack.id, name: `Pack ${pack.id}`, enabled: pack.enabled }),
    );
    fs.writeFileSync(path.join(dir, 'species', `${pack.id}.json`), JSON.stringify(pack.species));
  }

  return {
    root,
    contentDir,
    assetsDir,
    art(relative, bytes = 'art') {
      const target = path.join(assetsDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
