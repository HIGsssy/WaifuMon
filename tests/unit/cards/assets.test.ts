/**
 * Rarity, affinity, and kit-completeness. The load-bearing assertion here is
 * that `EX` has its own overlay: substituting another rarity's frame would ship
 * a card that lies about what it is, so the renderer must fail instead.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AFFINITY_DESCRIPTIONS,
  AFFINITY_ICON_FILES,
  affinityIconFile,
  affinityLabel,
  CardAssetMissingError,
  DEFAULT_ASSET_ROOT,
  RARITY_OVERLAY_FILES,
  rarityOverlayFile,
  RACE_CODES,
} from '../../../src/modules/cards';
import { AFFINITIES, RARITIES } from '../../../src/db/schema';
import { CardAssetLoader } from '../../../src/modules/cards/assets/loader';
import { validateCardAssets } from '../../../src/modules/cards/assets/validation';

const loader = new CardAssetLoader(DEFAULT_ASSET_ROOT);

async function isNonEmptyFile(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

describe('rarity overlays', () => {
  it('maps all seven game rarities explicitly', () => {
    expect(RARITY_OVERLAY_FILES).toEqual({
      N: 'normal.svg',
      R: 'rare.svg',
      SR: 'sr.svg',
      SSR: 'ssr.svg',
      UR: 'ur.svg',
      LR: 'lr.svg',
      EX: 'ex.svg',
    });
    expect(Object.keys(RARITY_OVERLAY_FILES).sort()).toEqual([...RARITIES].sort());
  });

  it('never aliases two rarities to the same overlay', () => {
    const files = Object.values(RARITY_OVERLAY_FILES);
    expect(new Set(files).size).toBe(files.length);
  });

  it('ships a file for every rarity', async () => {
    for (const rarity of RARITIES) {
      const file = loader.rarityOverlayPath(rarity);
      expect(await isNonEmptyFile(file), `${rarity} → ${file}`).toBe(true);
    }
  });

  it('gives EX its own artwork rather than a copy of UR', async () => {
    const [ex, ur] = await Promise.all([
      fs.readFile(loader.rarityOverlayPath('EX'), 'utf8'),
      fs.readFile(loader.rarityOverlayPath('UR'), 'utf8'),
    ]);
    expect(ex).not.toBe(ur);
    expect(ex).toContain('>EX<');
    expect(ur).toContain('>UR<');
  });

  it('throws rather than guessing for an unmapped rarity', () => {
    expect(() => rarityOverlayFile('MYTHIC' as never)).toThrow(/MYTHIC/);
  });
});

describe('race icons', () => {
  it('ships an icon for every race code', async () => {
    for (const race of RACE_CODES) {
      const file = loader.raceIconPath(race);
      expect(await isNonEmptyFile(file), `${race} → ${file}`).toBe(true);
    }
  });
});

describe('affinity icons', () => {
  it('maps all five affinities', () => {
    expect(Object.keys(AFFINITY_ICON_FILES).sort()).toEqual([...AFFINITIES].sort());
  });

  it('ships an icon for every affinity', async () => {
    for (const affinity of AFFINITIES) {
      const file = loader.affinityIconPath(affinity);
      expect(await isNonEmptyFile(file), `${affinity} → ${file}`).toBe(true);
    }
  });

  it('has a card blurb for every affinity', () => {
    for (const affinity of AFFINITIES) {
      expect(AFFINITY_DESCRIPTIONS[affinity].length).toBeGreaterThan(0);
    }
  });

  it('labels affinities in upper case', () => {
    expect(affinityLabel('caregiver')).toBe('CAREGIVER');
  });

  it('throws rather than guessing for an unmapped affinity', () => {
    expect(() => affinityIconFile('bratty' as never)).toThrow(/bratty/);
  });
});

describe('validateCardAssets', () => {
  it('passes on the shipped kit', async () => {
    await expect(validateCardAssets(loader)).resolves.toBeUndefined();
  });

  it('fails loudly, with the offending path, on an incomplete kit', async () => {
    const empty = new CardAssetLoader(path.join(DEFAULT_ASSET_ROOT, '..', 'no-such-kit'));
    await expect(validateCardAssets(empty)).rejects.toBeInstanceOf(CardAssetMissingError);
    await expect(validateCardAssets(empty)).rejects.toMatchObject({
      code: 'CARD_ASSET_MISSING',
    });
  });
});
