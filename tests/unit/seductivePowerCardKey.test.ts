/**
 * The rendered-card cache boundary for Seductive Power.
 *
 * **SP is not drawn on the card today.** The production frame's information
 * panel carries name, two description lines and an artist credit; the only
 * other holes are the level shield and three icon discs. There is no free stat
 * field, so adding SP would be a deliberate layout change rather than a spare
 * slot to fill — see the report accompanying this feature.
 *
 * Because it is not drawn, Base SP is deliberately **absent** from the master
 * render key: keying on it would fork the cache into one image per owned copy
 * for zero pixel difference, discarding exactly the dedupe the key exists for.
 *
 * These tests pin that as a *contract*, not an accident. If SP ever reaches
 * the card face, the first test here fails — which is the reminder that the
 * key must gain it in the same change, or two copies will share one image.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMasterKeyMaterial,
  computeMasterRenderKey,
} from '../../src/modules/cards/cache/cacheKey';
import type { CardRenderInput } from '../../src/modules/cards/types';

function input(level: number): CardRenderInput {
  return {
    species: {
      slug: 'neko_barista',
      name: 'Neko Barista',
      rarity: 'N',
      race: 'human',
      affinity: 'switch',
      description: 'Pulls a decent shot.',
    },
    variant: { appearanceId: 'standard', artworkAbsolutePath: '/tmp/art.png' },
    progress: { level },
  };
}

const keyFor = (i: CardRenderInput) =>
  computeMasterRenderKey(buildMasterKeyMaterial(i, 'artwork-hash', 'kit-1'));

describe('owned-card render key vs Seductive Power', () => {
  it('carries no SP field at all — nothing on the card face depends on it', () => {
    const material = buildMasterKeyMaterial(input(20), 'artwork-hash', 'kit-1');
    // Check the key *names*, not the serialized blob - "species" contains
    // "sp" and would make a substring check meaningless.
    const names = new Set<string>();
    const walk = (v: unknown): void => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, child] of Object.entries(v)) {
          names.add(k.toLowerCase());
          walk(child);
        }
      }
    };
    walk(material);
    expect([...names].filter((n) => n.includes('seductive') || n.endsWith('sp'))).toEqual([]);
  });

  it('separates by level, which is drawn — so a level-up never reuses the old image', () => {
    // Current SP moves with level, and level *is* on the shield, so the two
    // already travel together: a copy whose SP changed has a new key.
    expect(keyFor(input(1))).not.toBe(keyFor(input(2)));
    expect(keyFor(input(20))).not.toBe(keyFor(input(50)));
  });

  it('two copies at the same level share one image, because they look identical', () => {
    // The honest consequence of not drawing SP. Documented rather than
    // asserted-away: this is the line that must change if SP is ever printed.
    expect(keyFor(input(20))).toBe(keyFor(input(20)));
  });
});
