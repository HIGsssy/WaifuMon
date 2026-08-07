/**
 * The authoring pipeline, end to end: **artwork on disk → content JSON → the
 * appearance data the API serves**.
 *
 * Each link in that chain has its own tests. This one exists because the links
 * are what break: the sync tool can be correct, `resolveAppearances` can be
 * correct, and the pipeline can still be useless if the id the tool writes is
 * not the id the resolver turns into an `assetId`. So this walks the actual
 * author workflow — drop a PNG, run the real synchroniser, read the result
 * through the real content resolver — and asserts the identity survives.
 *
 * Everything here calls the shipped modules. `resolveAppearances` is literally
 * what `appearanceService.catalogFor` delegates to, and `appearanceForVariant`
 * is what decides which look an owned copy renders, so there is no parallel
 * implementation being tested in place of the real one.
 *
 * The Portal half of the chain — assetId → URL → rendition → gallery — is
 * covered in `portal/src/images/__tests__/appearancePipeline.test.tsx`, which
 * cannot live here: the Portal is a separate package and its own architecture
 * test forbids importing this repo's `src/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAppearanceSync } from '../../src/tools/appearanceSync';
import {
  appearanceForVariant,
  resolveAppearances,
} from '../../src/modules/appearance/appearanceContent';
import { SpeciesFileSchema, type SpeciesContent } from '../../src/modules/content/schemas';

const SLUG = 'test_species';

let root: string;
let contentDir: string;
let assetsDir: string;

function speciesRecord(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: SLUG,
    name: 'Test Species',
    rarity: 'N',
    archetype: 'demi-human',
    baseCaptureRate: null,
    description: '',
    tags: [],
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: `waifumon/${SLUG}/standard.png`,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    ...extra,
  };
}

/** Writes `assets/waifumon/<slug>/<id>.png` — "the artist finished a card". */
function addArtwork(...appearanceIds: string[]): void {
  const dir = path.join(assetsDir, 'waifumon', SLUG);
  fs.mkdirSync(dir, { recursive: true });
  for (const id of appearanceIds) fs.writeFileSync(path.join(dir, `${id}.png`), 'png');
}

function readSpecies(file = 'pack.json'): SpeciesContent {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(contentDir, 'species', file), 'utf8'));
  // Parsed through the real schema, so the test reads exactly what the loader
  // would hand the API — defaults applied, nothing hand-shaped.
  const parsed = SpeciesFileSchema.parse(raw);
  const found = parsed.find((s) => s.slug === SLUG);
  if (!found) throw new Error(`${SLUG} missing from ${file}`);
  return found;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-pipeline-'));
  contentDir = path.join(root, 'content');
  assetsDir = path.join(root, 'assets');
  fs.mkdirSync(path.join(contentDir, 'species'), { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.copyFileSync(path.resolve('content/items.json'), path.join(contentDir, 'items.json'));
  fs.copyFileSync(path.resolve('content/tables.json'), path.join(contentDir, 'tables.json'));

  // The starting point every species in the game is at today: default art, and
  // no explicit appearances array at all.
  fs.writeFileSync(
    path.join(contentDir, 'species', 'pack.json'),
    `${JSON.stringify([speciesRecord()], null, 2)}\n`,
    'utf8',
  );
  addArtwork('standard');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('artwork → content → API appearance data', () => {
  it('does nothing until there is something to do', () => {
    const plan = runAppearanceSync({ contentDir, assetsDir });

    expect(plan.totals.appearances).toBe(0);
    expect(readSpecies().appearances).toBeUndefined();
    // …and the species still has a renderable look, because the resolver
    // synthesises one. The optimisation is optional; correctness is not.
    expect(resolveAppearances(readSpecies()).map((a) => a.id)).toEqual(['standard']);
  });

  it('turns a dropped PNG into a gallery entry the API can serve', () => {
    addArtwork('level_10');

    runAppearanceSync({ contentDir, assetsDir });

    // 1. The content file gained both entries — the milestone and the explicit
    //    default the schema requires alongside it.
    expect(readSpecies().appearances?.map((a) => a.id)).toEqual(['standard', 'level_10']);

    // 2. The same resolver `appearanceService.catalogFor` uses turns that into
    //    the catalog the API publishes.
    const catalog = resolveAppearances(readSpecies());
    expect(catalog.map((a) => a.id)).toEqual(['standard', 'level_10']);
    expect(catalog.map((a) => a.name)).toEqual(['Standard', 'Level 10']);

    // 3. Ordering is by `sortOrder`, which is what the Portal grid renders in.
    expect(catalog.map((a) => a.sortOrder)).toEqual([0, 10]);

    // 4. The asset identity — the only thing the Portal needs to find artwork.
    expect(catalog[1]?.assetId).toEqual({ kind: 'waifumon', slug: SLUG, variant: 'level_10' });

    // 5. The unlock rule travels with it, so no client recomputes a level gate.
    expect(catalog[1]?.unlock).toEqual({ type: 'level', atLevel: 10 });
    expect(catalog[1]?.unlockLabel).toBe('Reach Level 10');
  });

  it('keeps the asset identity aligned with the file the artist saved', () => {
    // The whole pipeline rests on this one equality: the filename the artist
    // chose is the appearance id, which is the `assetId.variant` the Portal
    // resolves back to a file. If these ever drift, artwork silently vanishes.
    addArtwork('level_10', 'level_30');
    runAppearanceSync({ contentDir, assetsDir });

    for (const appearance of resolveAppearances(readSpecies())) {
      const file = path.join(assetsDir, 'waifumon', SLUG, `${appearance.assetId.variant}.png`);
      expect(fs.existsSync(file), `${appearance.id} → ${file}`).toBe(true);
    }
  });

  it('adds only the milestones whose artwork exists', () => {
    addArtwork('level_10', 'level_20');
    runAppearanceSync({ contentDir, assetsDir });

    const ids = resolveAppearances(readSpecies()).map((a) => a.id);
    expect(ids).toEqual(['standard', 'level_10', 'level_20']);
  });
});

describe('the owned copy’s selected appearance', () => {
  it('is not reset or replaced when new appearances are authored', () => {
    // A player wearing the default must keep wearing it. Content gaining an
    // entry is not an event that touches any copy's stored `variant`.
    addArtwork('level_10', 'level_20');
    runAppearanceSync({ contentDir, assetsDir });

    const species = readSpecies();
    expect(appearanceForVariant(species, 'standard').id).toBe('standard');
  });

  it('does not auto-select a newly available appearance', () => {
    addArtwork('level_10');
    runAppearanceSync({ contentDir, assetsDir });

    const species = readSpecies();
    // Null variant means "never chosen" — that resolves to the default, not to
    // the newest or highest-level look.
    expect(appearanceForVariant(species, null).id).toBe('standard');
    expect(appearanceForVariant(species, undefined).id).toBe('standard');
  });

  it('falls back to standard when a stored variant no longer exists', () => {
    addArtwork('level_10');
    runAppearanceSync({ contentDir, assetsDir });

    // An author can delete artwork; a copy pointing at the gap must still
    // render something rather than break.
    expect(appearanceForVariant(readSpecies(), 'level_40').id).toBe('standard');
  });

  it('keeps rendering a level appearance a copy is actually wearing', () => {
    addArtwork('level_10');
    runAppearanceSync({ contentDir, assetsDir });

    const worn = appearanceForVariant(readSpecies(), 'level_10');
    expect(worn.id).toBe('level_10');
    expect(worn.assetId.variant).toBe('level_10');
  });
});

describe('appearance ids beyond the level milestones', () => {
  it('serves a hand-authored future appearance with no code change', () => {
    // `appearances:sync` owns the canonical level milestones. Everything
    // downstream — the resolver, the asset identity, and the Portal that reads
    // it — must be generic, or every seasonal drop becomes a code change.
    fs.writeFileSync(
      path.join(contentDir, 'species', 'pack.json'),
      `${JSON.stringify(
        [
          speciesRecord({
            appearances: [
              { id: 'standard', name: 'Standard', sortOrder: 0, unlock: { type: 'owned' } },
              {
                id: 'winter_2026',
                name: 'Winter 2026',
                cosmeticRarity: 'seasonal',
                sortOrder: 5,
                unlock: { type: 'level', atLevel: 1 },
              },
            ],
          }),
        ],
        null,
        2,
      )}\n`,
      'utf8',
    );
    addArtwork('winter_2026');

    const catalog = resolveAppearances(readSpecies());

    expect(catalog.map((a) => a.id)).toEqual(['standard', 'winter_2026']);
    expect(catalog[1]?.assetId).toEqual({ kind: 'waifumon', slug: SLUG, variant: 'winter_2026' });
    expect(catalog[1]?.cosmeticRarity).toBe('seasonal');
  });

  it('leaves a hand-authored appearance alone when the sync tool runs', () => {
    fs.writeFileSync(
      path.join(contentDir, 'species', 'pack.json'),
      `${JSON.stringify(
        [
          speciesRecord({
            appearances: [
              { id: 'standard', name: 'Standard', sortOrder: 0, unlock: { type: 'owned' } },
              {
                id: 'winter_2026',
                name: 'Winter 2026',
                sortOrder: 5,
                unlock: { type: 'level', atLevel: 1 },
              },
            ],
          }),
        ],
        null,
        2,
      )}\n`,
      'utf8',
    );
    addArtwork('winter_2026', 'level_10');

    runAppearanceSync({ contentDir, assetsDir });

    const ids = resolveAppearances(readSpecies()).map((a) => a.id);
    // `winter_2026` keeps its authored position by sortOrder; level_10 joins it.
    expect(ids).toEqual(['standard', 'winter_2026', 'level_10']);
  });
});
