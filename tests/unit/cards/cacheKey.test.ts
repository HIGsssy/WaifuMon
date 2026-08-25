/**
 * The master render key. Two properties matter and pull in opposite
 * directions, so both are tested exhaustively:
 *
 * - every property that changes the master's pixels changes the key, and
 * - nothing about *how the bytes were asked for* changes it — notably the
 *   requested display width, which is a resize of the same card.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMasterKeyMaterial,
  canonicalJson,
  computeMasterRenderKey,
  effectiveCardMeta,
  effectiveLevel,
  type MasterKeyMaterial,
} from '../../../src/modules/cards/cache/cacheKey';
import { CARD_RENDERER_VERSION } from '../../../src/modules/cards';
import type { CardRenderInput } from '../../../src/modules/cards';

const ARTWORK_HASH = 'a'.repeat(64);
const KIT_VERSION = '1';

const baseInput: CardRenderInput = {
  species: {
    slug: 'alley_catgirl',
    name: 'Alley Catgirl',
    rarity: 'SSR',
    race: 'demi-human',
    affinity: 'dominant',
    card: {
      subtitle: 'Curious Companion',
      artist: 'Artist Name',
      ability: { name: 'Nine Lives', text: 'Ignores the first failed capture attempt.' },
      flavorQuote: 'She was here before the city was.',
      cardNumber: '012/100',
    },
  },
  variant: { appearanceId: 'standard', artworkAbsolutePath: 'D:/art/alley_catgirl/standard.png' },
  progress: { level: 12 },
};

function keyFor(
  input: CardRenderInput,
  artworkHash = ARTWORK_HASH,
  kitVersion = KIT_VERSION,
): string {
  return computeMasterRenderKey(buildMasterKeyMaterial(input, artworkHash, kitVersion));
}

const BASE_KEY = keyFor(baseInput);

describe('canonicalJson', () => {
  it('is stable across key insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('treats absent, null, and empty-string fields as the same thing', () => {
    expect(canonicalJson({ subtitle: '' })).toBe(canonicalJson({}));
    expect(canonicalJson({ subtitle: null })).toBe(canonicalJson({}));
    expect(canonicalJson({ subtitle: undefined })).toBe(canonicalJson({}));
  });

  it('preserves array order', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('effectiveLevel', () => {
  it('defaults to 1 and clamps nonsense', () => {
    expect(effectiveLevel({ ...baseInput, progress: undefined })).toBe(1);
    expect(effectiveLevel({ ...baseInput, progress: { level: 0 } })).toBe(1);
    expect(effectiveLevel({ ...baseInput, progress: { level: -5 } })).toBe(1);
    expect(effectiveLevel({ ...baseInput, progress: { level: Number.NaN } })).toBe(1);
    expect(effectiveLevel({ ...baseInput, progress: { level: 12.9 } })).toBe(12);
  });
});

describe('effectiveCardMeta', () => {
  it('layers per-render overrides on top of the species block', () => {
    const merged = effectiveCardMeta({ ...baseInput, overrides: { subtitle: 'Overridden' } });
    expect(merged.subtitle).toBe('Overridden');
    expect(merged.artist).toBe('Artist Name');
  });
});

describe('computeMasterRenderKey', () => {
  it('is deterministic and filename-safe', () => {
    expect(keyFor(baseInput)).toBe(BASE_KEY);
    expect(BASE_KEY).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across property insertion order in the input', () => {
    const reordered: CardRenderInput = {
      progress: baseInput.progress,
      variant: baseInput.variant,
      species: {
        affinity: baseInput.species.affinity,
        race: baseInput.species.race,
        rarity: baseInput.species.rarity,
        name: baseInput.species.name,
        slug: baseInput.species.slug,
        card: {
          cardNumber: baseInput.species.card?.cardNumber,
          flavorQuote: baseInput.species.card?.flavorQuote,
          ability: baseInput.species.card?.ability,
          artist: baseInput.species.card?.artist,
          subtitle: baseInput.species.card?.subtitle,
        },
      },
    };
    expect(keyFor(reordered)).toBe(BASE_KEY);
  });

  describe('changes when a pixel-affecting property changes', () => {
    const mutations: [string, CardRenderInput][] = [
      ['slug', mutate({ species: { slug: 'other_slug' } })],
      ['name', mutate({ species: { name: 'Alley Cat' } })],
      ['rarity', mutate({ species: { rarity: 'EX' } })],
      ['race', mutate({ species: { race: 'android' } })],
      ['affinity', mutate({ species: { affinity: 'primal' } })],
      ['description', mutate({ species: { description: 'A different flavour line.' } })],
      ['artist', mutateCard({ artist: 'Someone Else' })],
      ['level', { ...baseInput, progress: { level: 13 } }],
      ['appearance id', mutate({ variant: { appearanceId: 'level_20' } })],
      ['overrides of a drawn field', { ...baseInput, overrides: { artist: 'Overridden' } }],
      ['ownership badge', { ...baseInput, context: { owned: true } }],
    ];

    for (const [label, input] of mutations) {
      it(label, () => {
        expect(keyFor(input), label).not.toBe(BASE_KEY);
      });
    }

    it('artwork content hash', () => {
      expect(keyFor(baseInput, 'b'.repeat(64))).not.toBe(BASE_KEY);
    });

    it('kit VERSION', () => {
      expect(keyFor(baseInput, ARTWORK_HASH, '2')).not.toBe(BASE_KEY);
    });

    it('renderer VERSION', () => {
      const material = buildMasterKeyMaterial(baseInput, ARTWORK_HASH, KIT_VERSION);
      expect(material.rendererVersion).toBe(CARD_RENDERER_VERSION);
      const bumped: MasterKeyMaterial = { ...material, rendererVersion: 'next' };
      expect(computeMasterRenderKey(bumped)).not.toBe(BASE_KEY);
    });
  });

  /**
   * The production card face has four text rows — name, two description lines,
   * and a credit row carrying the artist and the wordmark — so `subtitle`,
   * `ability`, `flavorQuote` and `cardNumber` have nowhere to appear. They remain part of the authored content contract, but they
   * cannot change a pixel, and keying on them would fork the cache every time
   * an author edited a line nobody sees. If a later frame draws them again,
   * they go back into the key and `CARD_RENDERER_VERSION` gets bumped.
   */
  describe('does not change for metadata the card face does not draw', () => {
    const unrendered: [string, CardRenderInput][] = [
      ['subtitle', mutateCard({ subtitle: 'Different' })],
      ['card number', mutateCard({ cardNumber: '013/100' })],
      ['ability name', mutateCard({ ability: { name: 'Eight Lives', text: 'Ignores the first failed capture attempt.' } })],
      ['ability text', mutateCard({ ability: { name: 'Nine Lives', text: 'Different text.' } })],
      ['flavor quote', mutateCard({ flavorQuote: 'Another quote.' })],
    ];

    for (const [label, input] of unrendered) {
      it(label, () => {
        expect(keyFor(input), label).toBe(BASE_KEY);
      });
    }
  });

  describe('does not change for things that are not the card', () => {
    it('an unowned render, stated explicitly or left off', () => {
      expect(keyFor({ ...baseInput, context: { owned: false } })).toBe(BASE_KEY);
      expect(keyFor({ ...baseInput, context: {} })).toBe(BASE_KEY);
    });

    it('absolute artwork path, when the bytes are the same', () => {
      const moved = mutate({
        variant: { artworkAbsolutePath: '/var/lib/waifumon/somewhere/else.png' },
      });
      expect(keyFor(moved)).toBe(BASE_KEY);
    });

    it('requested output width', () => {
      for (const width of [256, 512, 1024]) {
        expect(keyFor({ ...baseInput, output: { width } }), `width ${width}`).toBe(BASE_KEY);
      }
    });

    it('owned copy id (reserved, not rendered in v1)', () => {
      expect(keyFor({ ...baseInput, progress: { level: 12, ownedCopyId: 4242 } })).toBe(BASE_KEY);
    });

    it('an explicitly blank optional versus an absent one', () => {
      const blank = mutateCard({ subtitle: '' });
      const absent: CardRenderInput = {
        ...baseInput,
        species: {
          ...baseInput.species,
          card: { ...baseInput.species.card, subtitle: undefined },
        },
      };
      expect(keyFor(blank)).toBe(keyFor(absent));
    });
  });
});

function mutate(patch: {
  species?: Partial<CardRenderInput['species']>;
  variant?: Partial<CardRenderInput['variant']>;
}): CardRenderInput {
  return {
    ...baseInput,
    species: { ...baseInput.species, ...(patch.species ?? {}) },
    variant: { ...baseInput.variant, ...(patch.variant ?? {}) },
  };
}

function mutateCard(patch: Partial<NonNullable<CardRenderInput['species']['card']>>): CardRenderInput {
  return {
    ...baseInput,
    species: { ...baseInput.species, card: { ...baseInput.species.card, ...patch } },
  };
}
