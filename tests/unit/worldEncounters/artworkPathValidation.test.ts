/**
 * World Encounter `artworkPath` uses the canonical authored-artwork rule
 * (`relativeArtworkPath`) — the same one Result Presentations use and the
 * renderer applies — instead of the old "no `..` anywhere" check.
 *
 * Adopting it must not strand shipped content, so this pins that every seed
 * encounter and every image shipped under `assets/encounters/` (as an author
 * would reference it) passes, alongside the forms it now refuses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncounterInputSchema } from '../../../src/modules/worldEncounters/types';
import { SEED_ENCOUNTERS } from '../../../src/modules/worldEncounters/seed';
import { locateArtworkFile } from '../../../src/modules/assets/artworkFile';

const ENCOUNTER_ART_DIR = path.resolve(__dirname, '..', '..', '..', 'assets', 'encounters');

/** A valid encounter with only `artworkPath` varied. */
function withArtwork(artworkPath: unknown) {
  const { artworkPath: _drop, ...base } = SEED_ENCOUNTERS[0]!;
  return artworkPath === undefined ? base : { ...base, artworkPath };
}

const parse = (artworkPath: unknown) => EncounterInputSchema.safeParse(withArtwork(artworkPath));

describe('shipped content still validates', () => {
  it('every seed encounter parses', () => {
    for (const seed of SEED_ENCOUNTERS) {
      expect(EncounterInputSchema.safeParse(seed).success, seed.slug).toBe(true);
    }
  });

  // A typo here would not fail anything at runtime — the presenter just logs
  // and renders text-only — so a fresh install would ship broken images.
  it('every seed encounter has artwork that resolves to a shipped asset', () => {
    const assetsDir = path.dirname(ENCOUNTER_ART_DIR);
    for (const seed of SEED_ENCOUNTERS) {
      expect(seed.artworkPath, seed.slug).toBe(`encounters/${seed.slug}.webp`);
      expect(locateArtworkFile(assetsDir, seed.artworkPath!).status, seed.slug).toBe('available');
    }
  });

  it('every shipped encounter image is a valid artworkPath', () => {
    const files = fs.existsSync(ENCOUNTER_ART_DIR) ? fs.readdirSync(ENCOUNTER_ART_DIR) : [];
    for (const file of files) {
      const result = parse(`encounters/${file}`);
      expect(result.success, file).toBe(true);
    }
  });
});

describe('accepted', () => {
  it.each(['encounters/wv_lost_cub.webp', 'encounters/a.png', 'encounters/b.JPG', 'x/y/z.jpeg', 'e.gif'])(
    '%s',
    (p) => {
      const result = parse(p);
      expect(result.success).toBe(true);
      expect(result.data?.artworkPath).toBe(p);
    },
  );

  it.each([
    ['null', null],
    ['absent', undefined],
    ['an empty string', ''],
  ])('%s means no artwork', (_label, value) => {
    const result = parse(value);
    expect(result.success).toBe(true);
    expect(result.data?.artworkPath).toBeNull();
  });
});

describe('refused', () => {
  it.each([
    ['../outside.png', 'traversal'],
    ['encounters/../../x.png', 'traversal mid-path'],
    ['/etc/passwd.png', 'absolute'],
    ['\\\\server\\share.png', 'backslash'],
    ['encounters\\a.png', 'backslash separator'],
    ['C:/art/a.png', 'drive letter'],
    ['https://example.com/a.png', 'URL'],
    ['encounters/a.svg', 'unsupported format'],
    ['encounters/a', 'no extension'],
    [`encounters/${'a'.repeat(200)}.png`, 'too long'],
    ['   ', 'whitespace'],
  ])('%s (%s)', (p) => {
    const result = parse(p);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes('artworkPath'))).toBe(true);
  });
});
