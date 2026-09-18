/**
 * The artwork picker's listing layer (`modules/assets/artworkBrowser.ts`).
 *
 * A throwaway assets tree with a `results/` root, an unrelated sibling
 * (`waifumon/`) the root policy must hide, hidden caches, non-image files and
 * symlinks both inside and outside the root. The tree is built per run in the
 * OS temp dir so real symlinks can be made.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ArtworkBrowseError,
  browseArtworkDirectory,
  normalizeBrowsePath,
  searchArtwork,
} from '../../src/modules/assets/artworkBrowser';
import { SUPPORTED_ARTWORK_EXTENSIONS } from '../../src/modules/assets/artworkPath';

const ROOTS = ['results'] as const;

let tmp: string;
let assets: string;
let outside: string;

function write(rel: string, base = assets) {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x');
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-art-browser-'));
  assets = path.join(tmp, 'assets');
  outside = path.join(tmp, 'secret');
  fs.mkdirSync(assets);

  // Natural order check: 2 before 10; a directory named like a file.
  write('results/purse-10.webp');
  write('results/purse-2.webp');
  write('results/Apple.PNG');
  for (const ext of SUPPORTED_ARTWORK_EXTENSIONS) write(`results/formats/sample.${ext}`);
  write('results/formats/notes.txt');
  write('results/formats/source.psd');
  write('results/formats/.env');
  write('results/formats/.hidden.webp');
  write('results/.thumbnails/cached.webp');
  write('results/hunt/waifubux/suspicious-purse-03.webp');
  write('results/hunt/waifubux/purse-01.webp');
  write('results/hunt/essence/purse-01.webp');
  write('results/hunt/forest-glade.webp');
  fs.mkdirSync(path.join(assets, 'results', 'zeta.webp')); // a folder, not a file
  write('results/zeta.webp/inner.gif');

  // Outside the root but inside the assets dir.
  write('waifumon/alpha/standard.webp');
  write('.env');

  // Outside the assets dir altogether.
  write('passwords.png', outside);
  write('deep/leak.webp', outside);

  // Symlinks: out of assets, out of the root (into assets), and within the root.
  fs.symlinkSync(outside, path.join(assets, 'results', 'escape-dir'));
  fs.symlinkSync(path.join(outside, 'passwords.png'), path.join(assets, 'results', 'escape.png'));
  fs.symlinkSync(path.join(assets, 'waifumon'), path.join(assets, 'results', 'species-link'));
  fs.symlinkSync(path.join(assets, 'results', 'hunt'), path.join(assets, 'results', 'hunt-alias'));
  fs.symlinkSync(
    path.join(assets, 'results', 'purse-2.webp'),
    path.join(assets, 'results', 'hunt', 'linked-purse.webp'),
  );
  // A loop, which search must not follow forever.
  fs.symlinkSync(path.join(assets, 'results', 'hunt'), path.join(assets, 'results', 'hunt', 'loop'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const browse = (p?: string, roots: readonly string[] = ROOTS) => browseArtworkDirectory(assets, roots, p);

async function refusal(work: Promise<unknown>): Promise<ArtworkBrowseError> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ArtworkBrowseError);
  return err as ArtworkBrowseError;
}

describe('browsing', () => {
  it('opens the single root at the top level', async () => {
    const top = await browse();
    expect(top.path).toBe('results');
    expect(top.parent).toBeNull();
    expect(top.breadcrumbs).toEqual([{ name: 'results', path: 'results' }]);
    expect(await browse('')).toEqual(top);
    expect(await browse('results/')).toEqual(top);
  });

  it('lists directories first, then files, in stable natural order', async () => {
    const top = await browse('results');
    expect(top.directories.map((d) => d.name)).toEqual(['formats', 'hunt', 'hunt-alias', 'zeta.webp']);
    expect(top.files.map((f) => f.name)).toEqual(['Apple.PNG', 'purse-2.webp', 'purse-10.webp']);
    expect(top.files[1]).toEqual({
      name: 'purse-2.webp',
      path: 'results/purse-2.webp',
      folder: 'results',
      extension: 'webp',
    });
    expect(top.files[0]!.extension).toBe('png');
  });

  it('navigates into a child and reports parent and breadcrumbs', async () => {
    const dir = await browse('results/hunt/waifubux');
    expect(dir.path).toBe('results/hunt/waifubux');
    expect(dir.parent).toBe('results/hunt');
    expect(dir.breadcrumbs).toEqual([
      { name: 'results', path: 'results' },
      { name: 'hunt', path: 'results/hunt' },
      { name: 'waifubux', path: 'results/hunt/waifubux' },
    ]);
    expect(dir.files.map((f) => f.path)).toEqual([
      'results/hunt/waifubux/purse-01.webp',
      'results/hunt/waifubux/suspicious-purse-03.webp',
    ]);
    expect((await browse('results/hunt')).parent).toBe('results');
  });

  it('returns every supported format and omits everything else', async () => {
    const dir = await browse('results/formats');
    expect(dir.files.map((f) => f.extension).sort()).toEqual([...SUPPORTED_ARTWORK_EXTENSIONS].sort());
    const names = dir.files.map((f) => f.name);
    expect(names).not.toContain('notes.txt');
    expect(names).not.toContain('source.psd');
    expect(names).not.toContain('.env');
    expect(names).not.toContain('.hidden.webp');
  });

  it('omits hidden folders such as caches', async () => {
    const top = await browse('results');
    expect(top.directories.map((d) => d.name)).not.toContain('.thumbnails');
    expect((await refusal(browse('results/.thumbnails'))).kind).toBe('invalid');
  });

  it('never returns an absolute path or the assets directory', async () => {
    const payloads = JSON.stringify([
      await browse('results'),
      await browse('results/hunt'),
      await browse('results/hunt-alias'),
      await searchArtwork(assets, ROOTS, 'purse'),
    ]);
    expect(payloads).not.toContain(tmp);
    expect(payloads).not.toContain(assets);
    expect(payloads).not.toMatch(/"path":"\//);
  });

  it('404s a folder that does not exist', async () => {
    expect((await refusal(browse('results/gone'))).kind).toBe('not_found');
  });

  it('404s a file addressed as a folder', async () => {
    expect((await refusal(browse('results/purse-2.webp'))).kind).toBe('not_found');
  });

  it('404s a root that is missing on disk', async () => {
    expect((await refusal(browse('', ['nothing-here']))).kind).toBe('not_found');
  });

  it('with several roots, the top level lists the roots that exist and no files', async () => {
    const top = await browse('', ['waifumon', 'results', 'absent']);
    expect(top).toEqual({
      path: '',
      parent: null,
      breadcrumbs: [],
      directories: [
        { name: 'results', path: 'results' },
        { name: 'waifumon', path: 'waifumon' },
      ],
      files: [],
    });
    expect((await browse('results', ['waifumon', 'results'])).parent).toBe('');
  });
});

describe('root policy', () => {
  it.each(['waifumon', 'waifumon/alpha', 'resultsX', 'ui'])(
    'refuses %s, which is outside the roots',
    async (p) => {
      expect((await refusal(browse(p))).kind).toBe('invalid');
    },
  );
});

describe('path safety', () => {
  it.each([
    '../',
    '..',
    'results/..',
    'results/../waifumon',
    'results/hunt/../../waifumon',
    './results',
    'results/./hunt',
    'results//hunt',
    '/results',
    '/etc',
    '\\results',
    'results\\hunt',
    'C:/results',
    'file:///etc',
    'results/\u0000',
    `results/${'a'.repeat(250)}`,
  ])('refuses %j without touching the filesystem', async (p) => {
    expect((await refusal(browse(p))).kind).toBe('invalid');
    expect(() => normalizeBrowsePath(p)).toThrow(ArtworkBrowseError);
  });

  it('treats an already-decoded %2e segment as a literal name, not traversal', async () => {
    // Fastify decodes the query string once; a double-encoded `..` arrives as
    // the literal text `%2e%2e`, which is simply a folder that is not there.
    expect((await refusal(browse('results/%2e%2e'))).kind).toBe('not_found');
  });
});

describe('symlinks', () => {
  it('does not list a link that leaves the assets directory', async () => {
    const top = await browse('results');
    const all = [...top.directories, ...top.files].map((e) => e.name);
    expect(all).not.toContain('escape-dir');
    expect(all).not.toContain('escape.png');
  });

  it('does not list a link into the assets directory but outside the root', async () => {
    const top = await browse('results');
    expect(top.directories.map((d) => d.name)).not.toContain('species-link');
  });

  it('refuses to browse through an escaping folder link', async () => {
    expect((await refusal(browse('results/escape-dir'))).kind).toBe('not_found');
    expect((await refusal(browse('results/species-link'))).kind).toBe('not_found');
    expect((await refusal(browse('results/escape-dir/deep'))).kind).toBe('not_found');
  });

  it('follows a link to a valid location inside the root, under the link’s own path', async () => {
    const alias = await browse('results/hunt-alias');
    expect(alias.path).toBe('results/hunt-alias');
    expect(alias.directories.map((d) => d.path)).toContain('results/hunt-alias/waifubux');
    expect(alias.files.map((f) => f.path)).toContain('results/hunt-alias/forest-glade.webp');
    const hunt = await browse('results/hunt');
    expect(hunt.files.map((f) => f.path)).toContain('results/hunt/linked-purse.webp');
  });

  it('refuses a root that is itself a link out of the assets directory', async () => {
    fs.symlinkSync(outside, path.join(assets, 'linked-root'));
    try {
      expect((await refusal(browse('', ['linked-root']))).kind).toBe('not_found');
      expect((await searchArtwork(assets, ['linked-root'], 'leak')).results).toEqual([]);
    } finally {
      fs.unlinkSync(path.join(assets, 'linked-root'));
    }
  });
});

describe('search', () => {
  it('finds by file name, case-insensitively', async () => {
    const res = await searchArtwork(assets, ROOTS, 'SUSPICIOUS');
    expect(res.results.map((r) => r.path)).toEqual(['results/hunt/waifubux/suspicious-purse-03.webp']);
    expect(res.truncated).toBe(false);
  });

  it('finds by folder name, with the folder as context for duplicates', async () => {
    const res = await searchArtwork(assets, ROOTS, 'purse-01');
    const found = res.results.filter((r) => !r.path.includes('alias') && !r.path.includes('/loop'));
    expect(found.map((r) => [r.name, r.folder])).toEqual([
      ['purse-01.webp', 'results/hunt/essence'],
      ['purse-01.webp', 'results/hunt/waifubux'],
    ]);
    const byFolder = await searchArtwork(assets, ROOTS, 'waifubux');
    expect(byFolder.results.map((r) => r.path)).toContain('results/hunt/waifubux/purse-01.webp');
  });

  it('requires every term to match', async () => {
    const res = await searchArtwork(assets, ROOTS, 'essence purse');
    expect(res.results.map((r) => r.path)).toEqual(['results/hunt/essence/purse-01.webp']);
  });

  it('answers no results as an empty list', async () => {
    expect(await searchArtwork(assets, ROOTS, 'thirstlands')).toEqual({
      query: 'thirstlands',
      results: [],
      truncated: false,
      limit: 100,
    });
  });

  it('caps the results and says more exist', async () => {
    const res = await searchArtwork(assets, ROOTS, 'purse', 2);
    expect(res.results).toHaveLength(2);
    expect(res.truncated).toBe(true);
    expect(res.limit).toBe(2);
  });

  it('omits unsupported, hidden and out-of-root files', async () => {
    const paths = (await searchArtwork(assets, ROOTS, 'e')).results.map((r) => r.path);
    expect(paths.some((p) => p.endsWith('.txt') || p.endsWith('.psd'))).toBe(false);
    expect(paths.some((p) => p.includes('/.'))).toBe(false);
    expect(paths.some((p) => p.includes('escape') || p.includes('species-link'))).toBe(false);
    expect((await searchArtwork(assets, ROOTS, 'leak')).results).toEqual([]);
    expect((await searchArtwork(assets, ROOTS, 'passwords')).results).toEqual([]);
    expect((await searchArtwork(assets, ROOTS, 'standard')).results).toEqual([]);
  });

  it('terminates on a symlink loop and visits each real folder once', async () => {
    const res = await searchArtwork(assets, ROOTS, 'forest');
    // hunt/ is reachable as hunt, hunt-alias and hunt/loop — but walked once.
    expect(res.results).toHaveLength(1);
  });

  it.each(['', '   ', 'x'.repeat(101)])('refuses the query %j', async (q) => {
    expect((await refusal(searchArtwork(assets, ROOTS, q))).kind).toBe('invalid');
  });
});
