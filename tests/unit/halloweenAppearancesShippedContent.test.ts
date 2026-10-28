/**
 * The Halloween 2026 alternate appearances, as shipped.
 *
 * Thirteen `owned` skins on existing species. Every one must survive the
 * loader's artwork pre-flight (so it references real artwork), sit beside an
 * untouched `standard` default, and be the only owned look added to her.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAppearance, resolveAppearances } from '../../src/modules/appearance/appearanceContent';
import { ASSETS_DIR, loadShippedContent } from '../helpers/fixtures';

const HALLOWEEN: ReadonlyArray<readonly [slug: string, appearanceId: string]> = [
  ['alley_catgirl', 'halloween_spider'],
  ['angelic_delinquent', 'nurse'],
  ['darkelf_royal', 'halloween'],
  ['cyber_lilith_prime', 'halloween_magical'],
  ['gym_oni', 'halloween'],
  ['neko_tatto_artist', 'halloween_zombie'],
  ['your_fav_girl', 'halloween_cosplay'],
  ['glacier_bear', 'halloween'],
  ['breacher', 'halloween_vampire_hunter'],
  ['supply_runner', 'flash'],
  ['pickaxe_goblin', 'halloween_dwarf'],
  ['warchief_daughter', 'halloween_nurse'],
  ['yuki_onna_bartender', 'subzero'],
];

describe('Halloween alternate appearances (shipped content)', () => {
  const content = loadShippedContent();
  const diagnostics = content.authoring?.artworkDiagnostics ?? [];

  it.each(HALLOWEEN)('%s/%s loads as an owned alternative to `standard`', (slug, id) => {
    const species = content.species.find((s) => s.slug === slug);
    expect(species?.enabled).toBe(true);
    const catalog = resolveAppearances(species!);
    const skin = catalog.find((a) => a.id === id);
    expect(skin?.unlock).toEqual({ type: 'owned' });
    expect(skin?.assetId).toEqual({ kind: 'waifumon', slug, variant: id });
    expect(defaultAppearance(species!).id).toBe('standard');
    // Exactly two owned looks: the base and this skin.
    expect(catalog.filter((a) => a.unlock.type === 'owned').map((a) => a.id).sort()).toEqual(
      ['standard', id].sort(),
    );
    for (const ext of ['png', 'webp']) {
      expect(fs.existsSync(path.join(ASSETS_DIR, 'waifumon', slug, `${id}.${ext}`))).toBe(true);
    }
    expect(diagnostics.filter((d) => d.slug === slug)).toEqual([]);
  });

  it('adds no other multi-owned species', () => {
    const multiOwned = content.species
      .filter((s) => (s.appearances ?? []).filter((a) => a.unlock.type === 'owned').length > 1)
      .map((s) => s.slug)
      .sort();
    expect(multiOwned).toEqual(HALLOWEEN.map(([slug]) => slug).sort());
  });

  it('keeps the shipped rarity and tags of the nonstandard `nurse` look', () => {
    const nurse = content.species
      .find((s) => s.slug === 'angelic_delinquent')!
      .appearances!.find((a) => a.id === 'nurse')!;
    expect(nurse.cosmeticRarity).toBe('rare');
    expect(nurse.tags).toEqual(['nurse', 'costume']);
  });
});
