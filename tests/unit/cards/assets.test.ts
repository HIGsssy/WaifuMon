/**
 * Kit completeness and taxonomy → file mapping.
 *
 * The load-bearing assertion is that no rarity ever borrows another rarity's
 * artwork. `EX` is the live case: it has a rarity icon but no frame, and the
 * correct behaviour is a loud missing-asset failure at render time — never an
 * `LR` frame with an `EX` roundel on it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AFFINITY_ICON_FILES,
  affinityIconFile,
  affinityLabel,
  CardAssetMissingError,
  DEFAULT_ASSET_ROOT,
  isRenderableRarity,
  RARITY_FRAME_FILES,
  RARITY_ICON_FILES,
  rarityFrameFile,
  rarityIconFile,
  RENDERABLE_RARITIES,
  UNSUPPORTED_RARITIES,
  RACE_CODES,
  CARD_MASTER_HEIGHT,
  CARD_MASTER_WIDTH,
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

describe('rarity frames', () => {
  it('maps all seven game rarities explicitly', () => {
    expect(Object.keys(RARITY_FRAME_FILES).sort()).toEqual([...RARITIES].sort());
  });

  it('never aliases two rarities to the same frame', () => {
    const files = Object.values(RARITY_FRAME_FILES);
    expect(new Set(files).size).toBe(files.length);
  });

  it('ships a frame for every renderable rarity', async () => {
    for (const rarity of RENDERABLE_RARITIES) {
      const file = loader.framePath(rarity);
      expect(await isNonEmptyFile(file), `${rarity} → ${file}`).toBe(true);
    }
  });

  it('treats EX as unsupported rather than aliasing it to another rarity', async () => {
    expect(UNSUPPORTED_RARITIES).toContain('EX');
    expect(isRenderableRarity('EX')).toBe(false);
    expect(RENDERABLE_RARITIES).not.toContain('EX');
    // The mapping still exists — EX is missing artwork, not missing from the game.
    expect(rarityFrameFile('EX')).toBe('ex.png');
    expect(await isNonEmptyFile(loader.framePath('EX'))).toBe(false);
  });

  it('fails loudly when asked for a frame it does not have', async () => {
    await expect(loader.frame('EX')).rejects.toBeInstanceOf(CardAssetMissingError);
    await expect(loader.frame('EX')).rejects.toMatchObject({ code: 'CARD_ASSET_MISSING' });
  });

  it('throws rather than guessing for an unmapped rarity', () => {
    expect(() => rarityFrameFile('MYTHIC' as never)).toThrow(/MYTHIC/);
  });
});

describe('rarity icons', () => {
  it('ships a roundel for every rarity, including the frameless one', async () => {
    for (const rarity of RARITIES) {
      const file = loader.rarityIconPath(rarity);
      expect(await isNonEmptyFile(file), `${rarity} → ${file}`).toBe(true);
    }
  });

  it('never aliases two rarities to the same icon', () => {
    const files = Object.values(RARITY_ICON_FILES);
    expect(new Set(files).size).toBe(files.length);
  });

  it('throws rather than guessing for an unmapped rarity', () => {
    expect(() => rarityIconFile('MYTHIC' as never)).toThrow(/MYTHIC/);
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

  it('labels affinities in upper case', () => {
    expect(affinityLabel('caregiver')).toBe('CAREGIVER');
  });

  it('throws rather than guessing for an unmapped affinity', () => {
    expect(() => affinityIconFile('bratty' as never)).toThrow(/bratty/);
  });
});

describe('ownership badge', () => {
  it('ships as a separate overlay asset, not baked into any frame', async () => {
    expect(await isNonEmptyFile(loader.ownedBadgePath())).toBe(true);
    expect(loader.ownedBadgePath()).toContain('badges');
  });
});

describe('frame geometry manifest', () => {
  it('was generated for the renderer’s current canvas', async () => {
    const geometry = await loader.geometry();
    expect(geometry.canvas).toEqual({
      width: CARD_MASTER_WIDTH,
      height: CARD_MASTER_HEIGHT,
    });
  });

  it('covers every renderable rarity and no frameless one', async () => {
    const geometry = await loader.geometry();
    expect(Object.keys(geometry.frames).sort()).toEqual([...RENDERABLE_RARITIES].sort());
  });

  it('keeps every element inside the canvas', async () => {
    const geometry = await loader.geometry();
    for (const rarity of RENDERABLE_RARITIES) {
      const g = await loader.frameGeometry(rarity);
      for (const [name, rect] of Object.entries({
        art: g.art,
        panel: g.panel,
        panelText: g.panelText,
        shield: g.shield,
        shieldText: g.shieldText,
      })) {
        expect(rect.x, `${rarity}.${name}.x`).toBeGreaterThanOrEqual(0);
        expect(rect.y, `${rarity}.${name}.y`).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w, `${rarity}.${name} right`).toBeLessThanOrEqual(CARD_MASTER_WIDTH);
        expect(rect.y + rect.h, `${rarity}.${name} bottom`).toBeLessThanOrEqual(CARD_MASTER_HEIGHT);
      }
      expect(geometry.frames[rarity]).toBeDefined();
    }
  });

  it('puts the text bands inside the holes they belong to', async () => {
    for (const rarity of RENDERABLE_RARITIES) {
      const g = await loader.frameGeometry(rarity);
      for (const [band, hole, name] of [
        [g.panelText, g.panel, 'panel'],
        [g.shieldText, g.shield, 'shield'],
      ] as const) {
        expect(band.x, `${rarity} ${name}`).toBeGreaterThanOrEqual(hole.x);
        expect(band.y, `${rarity} ${name}`).toBeGreaterThanOrEqual(hole.y);
        expect(band.x + band.w, `${rarity} ${name}`).toBeLessThanOrEqual(hole.x + hole.w);
        expect(band.y + band.h, `${rarity} ${name}`).toBeLessThanOrEqual(hole.y + hole.h);
      }
    }
  });

  it('orders the icon holders top to bottom: race, affinity, rarity', async () => {
    for (const rarity of RENDERABLE_RARITIES) {
      const { circles } = await loader.frameGeometry(rarity);
      expect(circles.race.cy, rarity).toBeLessThan(circles.affinity.cy);
      expect(circles.affinity.cy, rarity).toBeLessThan(circles.rarity.cy);
      // All three sit in the left-hand column of the card.
      for (const disc of [circles.race, circles.affinity, circles.rarity]) {
        expect(disc.cx, rarity).toBeLessThan(CARD_MASTER_WIDTH * 0.35);
        expect(disc.d, rarity).toBeGreaterThan(100);
      }
    }
  });

  it('never overlaps the artwork window with the information panel', async () => {
    for (const rarity of RENDERABLE_RARITIES) {
      const g = await loader.frameGeometry(rarity);
      expect(g.art.y + g.art.h, `${rarity}: art must end above the panel`).toBeLessThanOrEqual(
        g.panel.y,
      );
    }
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
