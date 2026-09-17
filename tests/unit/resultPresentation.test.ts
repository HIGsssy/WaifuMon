/**
 * Result Presentation — keys, authored-variant validation and the pure
 * resolver. No database, no Discord.
 *
 * The properties worth pinning:
 *   - the key list is closed, and the migration's CHECKs say the same thing
 *     the code does;
 *   - a variant is only storable when the runtime could honour it (known key,
 *     positive weight, legal artwork mode for the key, safe artwork path,
 *     normalised text);
 *   - selection honours weights, ignores anything unusable, falls back to the
 *     built-in lines, and draws only from the randomness it is handed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ARTWORK_MODES,
  RESULT_PRESENTATION_FLAVOR_MAX_LENGTH,
  RESULT_PRESENTATION_KEYS,
  defaultArtworkModeFor,
  isArtworkModeAllowed,
  isResultPresentationKey,
  keysAllowingArtworkMode,
  resultPresentationLabel,
} from '../../src/modules/resultPresentation/keys';
import {
  ResultPresentationValidationError,
  mergeResultPresentationVariantPatch,
  parseResultPresentationVariantInput,
} from '../../src/modules/resultPresentation/validation';
import {
  presentVariant,
  resolveResultPresentation,
  type ResultPresentationVariant,
} from '../../src/modules/resultPresentation/resolver';
import {
  buildResultPresentationPreview,
  PREVIEW_SAMPLE_NOTICE,
  type ResultPresentationPreviewDeps,
} from '../../src/modules/resultPresentation/preview';
import { seededRng, type Rng } from '../../src/shared/random';

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'drizzle', '0033_result_presentation_variants.sql'),
  'utf8',
);

/** A scripted Rng that records every draw. */
function recordingRng(nexts: number[]): Rng & { draws: number } {
  let i = 0;
  const rng = {
    draws: 0,
    next: () => {
      rng.draws++;
      if (i >= nexts.length) throw new Error('rng exhausted');
      return nexts[i++]!;
    },
    intInclusive: (min: number, max: number) => {
      rng.draws++;
      if (i >= nexts.length) throw new Error('rng exhausted');
      return Math.min(max, Math.floor(nexts[i++]! * (max - min + 1)) + min);
    },
  };
  return rng;
}

let nextId = 1;
function variant(overrides: Partial<ResultPresentationVariant> = {}): ResultPresentationVariant {
  return {
    id: nextId++,
    presentationKey: 'hunt.waifubux_find',
    enabled: true,
    weight: 1,
    flavorText: 'A coin glints in the grass.',
    artworkPath: null,
    artworkMode: 'none',
    ...overrides,
  };
}

describe('presentation keys', () => {
  it('is the closed Phase 1 list, each with a label', () => {
    expect(RESULT_PRESENTATION_KEYS).toEqual([
      'hunt.waifubux_find',
      'hunt.essence_find',
      'hunt.item_find',
      'hunt.rare_item_find',
      'hunt.nothing_found',
      'encounter.released',
    ]);
    expect(RESULT_PRESENTATION_KEYS.map(resultPresentationLabel)).toEqual([
      'WaifuBux Found',
      'Essence Found',
      'Item Found',
      'Rare Item Found',
      'Nothing Found',
      'Waifumon Released',
    ]);
  });

  it('recognises only known keys', () => {
    expect(isResultPresentationKey('hunt.item_find')).toBe(true);
    expect(isResultPresentationKey('hunt.anything')).toBe(false);
    expect(isResultPresentationKey(42)).toBe(false);
  });

  it('allows encountered artwork only for a release, and defaults a release to it', () => {
    expect(keysAllowingArtworkMode('encountered')).toEqual(['encounter.released']);
    for (const key of RESULT_PRESENTATION_KEYS) {
      expect(isArtworkModeAllowed(key, 'custom')).toBe(true);
      expect(isArtworkModeAllowed(key, 'none')).toBe(true);
    }
    expect(defaultArtworkModeFor('encounter.released')).toBe('encountered');
    expect(defaultArtworkModeFor('hunt.nothing_found')).toBe('none');
  });

  it('matches the migration CHECK constraints', () => {
    // The migration is hand-written, so pin that it lists exactly the code's
    // keys and modes, and the same encountered-artwork rule.
    const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');
    expect(MIGRATION).toContain(`"presentation_key" in (${list(RESULT_PRESENTATION_KEYS)})`);
    expect(MIGRATION).toContain(`"artwork_mode" in (${list(ARTWORK_MODES)})`);
    expect(MIGRATION).toContain(
      `"presentation_key" in (${list(keysAllowingArtworkMode('encountered'))})`,
    );
    expect(MIGRATION).toContain(`char_length("flavor_text") <= ${RESULT_PRESENTATION_FLAVOR_MAX_LENGTH}`);
  });
});

describe('variant validation', () => {
  const parse = parseResultPresentationVariantInput;
  const issuesOf = (raw: unknown): string[] => {
    try {
      parse(raw);
      return [];
    } catch (err) {
      expect(err).toBeInstanceOf(ResultPresentationValidationError);
      return (err as ResultPresentationValidationError).issues;
    }
  };

  it('accepts a minimal variant and fills in defaults', () => {
    expect(parse({ presentationKey: 'hunt.item_find' })).toEqual({
      presentationKey: 'hunt.item_find',
      enabled: true,
      weight: 1,
      flavorText: null,
      artworkPath: null,
      artworkMode: 'none',
    });
    expect(parse({ presentationKey: 'encounter.released' }).artworkMode).toBe('encountered');
  });

  it('rejects unknown keys', () => {
    expect(issuesOf({ presentationKey: 'hunt.jackpot' })).not.toEqual([]);
    expect(issuesOf({})).not.toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects weight %s', (weight) => {
    expect(issuesOf({ presentationKey: 'hunt.item_find', weight })).not.toEqual([]);
  });

  it('accepts a positive whole weight', () => {
    expect(parse({ presentationKey: 'hunt.item_find', weight: 7 }).weight).toBe(7);
  });

  it('normalises flavor text: trims, folds CRLF, keeps internal breaks', () => {
    const parsed = parse({
      presentationKey: 'hunt.nothing_found',
      flavorText: '  First beat.\r\n\r\nSecond beat.\r\n  ',
    });
    expect(parsed.flavorText).toBe('First beat.\n\nSecond beat.');
  });

  it.each(['', '   ', '\r\n\t', null, undefined])('treats blank flavor %j as unset', (flavorText) => {
    expect(parse({ presentationKey: 'hunt.item_find', flavorText }).flavorText).toBeNull();
  });

  it('caps flavor text at the documented length', () => {
    const max = 'x'.repeat(RESULT_PRESENTATION_FLAVOR_MAX_LENGTH);
    expect(parse({ presentationKey: 'hunt.item_find', flavorText: max }).flavorText).toBe(max);
    expect(issuesOf({ presentationKey: 'hunt.item_find', flavorText: `${max}x` })).not.toEqual([]);
    expect(issuesOf({ presentationKey: 'hunt.item_find', flavorText: 12 })).not.toEqual([]);
  });

  it.each([
    'encounters/coin.png',
    'encounters/coin.webp',
    'encounters/coin.JPG',
    'ui/nested/dir/coin.jpeg',
    'coin.gif',
  ])('accepts the safe artwork path %s', (artworkPath) => {
    expect(
      parse({ presentationKey: 'hunt.item_find', artworkMode: 'custom', artworkPath }).artworkPath,
    ).toBe(artworkPath);
  });

  it.each([
    ['absolute', '/etc/coin.png'],
    ['absolute (backslash)', '\\server\\coin.png'],
    ['drive letter', 'C:/assets/coin.png'],
    ['backslashes', 'encounters\\coin.png'],
    ['traversal', 'encounters/../../secret.png'],
    ['leading traversal', '../coin.png'],
    ['url', 'https://example.com/coin.png'],
    ['unsupported extension', 'encounters/coin.svg'],
    ['no extension', 'encounters/coin'],
    ['not an image', 'content/tables.json'],
    ['too long', `${'a/'.repeat(100)}coin.png`],
  ])('rejects an unsafe artwork path (%s)', (_label, artworkPath) => {
    expect(
      issuesOf({ presentationKey: 'hunt.item_find', artworkMode: 'custom', artworkPath }),
    ).not.toEqual([]);
  });

  it.each(RESULT_PRESENTATION_KEYS.filter((k) => k.startsWith('hunt.')))(
    'rejects encountered artwork for %s',
    (presentationKey) => {
      expect(issuesOf({ presentationKey, artworkMode: 'encountered' })).not.toEqual([]);
    },
  );

  it('accepts every artwork mode for a release', () => {
    expect(parse({ presentationKey: 'encounter.released', artworkMode: 'encountered' }).artworkMode).toBe(
      'encountered',
    );
    expect(parse({ presentationKey: 'encounter.released', artworkMode: 'none' }).artworkMode).toBe('none');
    expect(
      parse({
        presentationKey: 'encounter.released',
        artworkMode: 'custom',
        artworkPath: 'encounters/wave.webp',
      }).artworkMode,
    ).toBe('custom');
  });

  it('rejects an unknown artwork mode', () => {
    expect(issuesOf({ presentationKey: 'hunt.item_find', artworkMode: 'banner' })).not.toEqual([]);
  });

  it('requires a path for custom artwork, and only for custom artwork', () => {
    expect(issuesOf({ presentationKey: 'hunt.item_find', artworkMode: 'custom' })).not.toEqual([]);
    expect(
      issuesOf({ presentationKey: 'hunt.item_find', artworkMode: 'custom', artworkPath: '  ' }),
    ).not.toEqual([]);
    expect(
      issuesOf({ presentationKey: 'hunt.item_find', artworkMode: 'none', artworkPath: 'a/b.png' }),
    ).not.toEqual([]);
  });
});

describe('resolveResultPresentation', () => {
  it('uses the one enabled variant', () => {
    const only = variant({ artworkMode: 'custom', artworkPath: 'encounters/coin.webp' });
    const resolved = resolveResultPresentation({
      key: 'hunt.waifubux_find',
      variants: [only],
      rng: seededRng(1),
    });
    expect(resolved).toEqual({
      key: 'hunt.waifubux_find',
      variantId: only.id,
      flavorText: 'A coin glints in the grass.',
      flavorSource: 'authored',
      artworkMode: 'custom',
      artworkPath: 'encounters/coin.webp',
      usedFallback: false,
    });
  });

  it('honours weights', () => {
    const light = variant({ weight: 1, flavorText: 'light' });
    const heavy = variant({ weight: 3, flavorText: 'heavy' });
    const pick = (roll: number) =>
      resolveResultPresentation({
        key: 'hunt.waifubux_find',
        variants: [light, heavy],
        rng: recordingRng([roll]),
      }).variantId;
    // Total 4: [0, 0.25) → light, [0.25, 1) → heavy.
    expect(pick(0.0)).toBe(light.id);
    expect(pick(0.24)).toBe(light.id);
    expect(pick(0.25)).toBe(heavy.id);
    expect(pick(0.99)).toBe(heavy.id);

    const counts = new Map<number | null, number>();
    const rng = seededRng(7);
    for (let n = 0; n < 4000; n++) {
      const id = resolveResultPresentation({
        key: 'hunt.waifubux_find',
        variants: [light, heavy],
        rng,
      }).variantId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const share = (counts.get(heavy.id) ?? 0) / 4000;
    expect(share).toBeGreaterThan(0.7);
    expect(share).toBeLessThan(0.8);
  });

  it('ignores disabled, off-key and unusable variants', () => {
    const disabled = variant({ enabled: false, flavorText: 'disabled' });
    const offKey = variant({ presentationKey: 'hunt.essence_find', flavorText: 'essence' });
    const illegalMode = variant({ artworkMode: 'encountered', flavorText: 'illegal' });
    const customWithoutPath = variant({ artworkMode: 'custom', artworkPath: null });
    const zeroWeight = variant({ weight: 0 });
    const usable = variant({ flavorText: 'usable' });
    for (let n = 0; n < 50; n++) {
      const resolved = resolveResultPresentation({
        key: 'hunt.waifubux_find',
        variants: [disabled, offKey, illegalMode, customWithoutPath, zeroWeight, usable],
        rng: seededRng(n),
      });
      expect(resolved.variantId).toBe(usable.id);
    }
  });

  it('falls back to the built-in lines when nothing is enabled', () => {
    const rng = recordingRng([0.99]);
    const resolved = resolveResultPresentation({
      key: 'hunt.nothing_found',
      variants: [variant({ presentationKey: 'hunt.nothing_found', enabled: false })],
      fallbackFlavorLines: ['first', 'second'],
      rng,
    });
    expect(resolved).toEqual({
      key: 'hunt.nothing_found',
      variantId: null,
      flavorText: 'second',
      flavorSource: 'fallback',
      artworkMode: 'none',
      artworkPath: null,
      usedFallback: true,
    });
    expect(rng.draws).toBe(1);
  });

  it('falls back to a release showing her artwork', () => {
    const resolved = resolveResultPresentation({
      key: 'encounter.released',
      variants: [],
      fallbackFlavorLines: ['bye'],
      rng: seededRng(3),
    });
    expect(resolved.artworkMode).toBe('encountered');
    expect(resolved.flavorText).toBe('bye');
    expect(resolved.usedFallback).toBe(true);
  });

  it('has no text and draws nothing when there is neither a variant nor a fallback', () => {
    const rng = recordingRng([]);
    const resolved = resolveResultPresentation({ key: 'hunt.item_find', variants: [], rng });
    expect(resolved.flavorText).toBeNull();
    expect(resolved.flavorSource).toBe('none');
    expect(rng.draws).toBe(0);
  });

  it('gives an artwork-only variant a built-in line where the key has one', () => {
    const artOnly = variant({
      presentationKey: 'hunt.nothing_found',
      flavorText: null,
      artworkMode: 'custom',
      artworkPath: 'encounters/fog.webp',
    });
    const resolved = resolveResultPresentation({
      key: 'hunt.nothing_found',
      variants: [artOnly],
      fallbackFlavorLines: ['only line'],
      rng: recordingRng([0.5, 0.0]),
    });
    expect(resolved.variantId).toBe(artOnly.id);
    expect(resolved.flavorText).toBe('only line');
    expect(resolved.flavorSource).toBe('fallback');
    expect(resolved.artworkPath).toBe('encounters/fog.webp');
  });

  it('never exposes a path unless the mode is custom', () => {
    const odd = variant({ artworkMode: 'none', artworkPath: 'encounters/stray.png' });
    const resolved = resolveResultPresentation({
      key: 'hunt.waifubux_find',
      variants: [odd],
      rng: seededRng(1),
    });
    expect(resolved.artworkPath).toBeNull();
  });

  it('is deterministic for a given presentation rng', () => {
    const variants = [variant({ weight: 2 }), variant({ weight: 5 }), variant({ weight: 3 })];
    const run = (seed: number) => {
      const rng = seededRng(seed);
      return Array.from({ length: 20 }, () =>
        resolveResultPresentation({ key: 'hunt.waifubux_find', variants, rng }).variantId,
      );
    };
    expect(run(99)).toEqual(run(99));
  });

  it('draws only from the rng it is given', () => {
    const random = vi.spyOn(Math, 'random');
    resolveResultPresentation({
      key: 'hunt.waifubux_find',
      variants: [variant(), variant({ weight: 4 })],
      fallbackFlavorLines: ['x'],
      rng: seededRng(5),
    });
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});

describe('editing a variant (mergeResultPresentationVariantPatch)', () => {
  const stored = parseResultPresentationVariantInput({
    presentationKey: 'hunt.item_find',
    flavorText: 'Stored',
    weight: 4,
    artworkMode: 'custom',
    artworkPath: 'results/coin.png',
  });

  it('changes only the named fields', () => {
    expect(mergeResultPresentationVariantPatch(stored, { enabled: false })).toEqual({
      ...stored,
      enabled: false,
    });
    expect(mergeResultPresentationVariantPatch(stored, { flavorText: ' New\r\n' }).flavorText).toBe(
      'New',
    );
  });

  it('clears the path when leaving custom artwork, unless a path is named', () => {
    expect(mergeResultPresentationVariantPatch(stored, { artworkMode: 'none' })).toMatchObject({
      artworkMode: 'none',
      artworkPath: null,
    });
    expect(() =>
      mergeResultPresentationVariantPatch(stored, { artworkMode: 'none', artworkPath: 'a/b.png' }),
    ).toThrow(ResultPresentationValidationError);
  });

  it('refuses to change the result type, with a field issue', () => {
    try {
      mergeResultPresentationVariantPatch(stored, { presentationKey: 'hunt.rare_item_find' });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ResultPresentationValidationError);
      expect((err as ResultPresentationValidationError).fieldIssues[0]!.path).toBe('presentationKey');
    }
  });

  it('refuses unknown fields such as reward values', () => {
    expect(() => mergeResultPresentationVariantPatch(stored, { amount: 5 })).toThrow(
      ResultPresentationValidationError,
    );
  });

  it('validates the merged result with the create rules', () => {
    expect(() => mergeResultPresentationVariantPatch(stored, { weight: 0 })).toThrow();
    expect(() => mergeResultPresentationVariantPatch(stored, { artworkMode: 'encountered' })).toThrow();
    expect(() =>
      mergeResultPresentationVariantPatch(stored, { artworkPath: '../escape.png' }),
    ).toThrow();
  });
});

describe('presentVariant', () => {
  it('presents exactly the given variant and draws only for a missing line', () => {
    const rng = recordingRng([]);
    const authored = presentVariant(
      'hunt.nothing_found',
      { id: null, flavorText: 'Mine', artworkMode: 'none', artworkPath: null },
      ['pool'],
      rng,
    );
    expect(authored).toMatchObject({ variantId: null, flavorText: 'Mine', flavorSource: 'authored' });
    expect(rng.draws).toBe(0);
  });
});

describe('buildResultPresentationPreview (pure)', () => {
  const deps: ResultPresentationPreviewDeps = {
    items: [{ slug: 'basic_charm', name: 'Basic Charm', emoji: '🩷' }],
    huntFlavorPool: ['First pool line', 'Second pool line'],
    species: [
      { slug: 'alpha', name: 'Alpha', rarity: 'SR' },
      { slug: 'beta', name: 'Beta', rarity: 'N' },
    ],
    locateArtwork: (p) => (p.includes('missing') ? { status: 'missing' } : {
      status: 'available',
      absolutePath: `/abs/${p}`,
      extension: 'png',
      contentType: 'image/png',
    }),
    speciesArtworkAvailable: (slug) => slug === 'alpha',
  };

  it('never uses Math.random and is stable between calls', () => {
    const random = vi.spyOn(Math, 'random');
    const request = { variant: { presentationKey: 'hunt.nothing_found' } };
    const first = buildResultPresentationPreview(request, deps);
    expect(buildResultPresentationPreview(request, deps)).toEqual(first);
    expect(first.screen.description).toBe('First pool line');
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('uses the server fixtures, marked as sample data', () => {
    const preview = buildResultPresentationPreview(
      { variant: { presentationKey: 'hunt.item_find', flavorText: 'Words' } },
      deps,
    );
    expect(preview.screen.sections).toEqual([
      { kind: 'flavor', text: 'Words', sample: false },
      { kind: 'mechanical', text: '🩷 **Basic Charm** ×1', sample: true },
    ]);
    expect(preview.sampleNotice).toBe(PREVIEW_SAMPLE_NOTICE);
  });

  it('picks a preview Waifumon for releases only', () => {
    const release = buildResultPresentationPreview(
      { variant: { presentationKey: 'encounter.released' }, previewSpeciesSlug: 'beta' },
      deps,
    );
    expect(release.artwork).toEqual({
      mode: 'encountered',
      species: { slug: 'beta', name: 'Beta', rarity: 'N' },
      available: false,
    });
    expect(release.screen.title).toBe('👋 You let Beta go');
    const byDefault = buildResultPresentationPreview(
      { variant: { presentationKey: 'encounter.released' } },
      deps,
    );
    expect(byDefault.previewSpecies?.slug).toBe('alpha');
    expect(() =>
      buildResultPresentationPreview(
        { variant: { presentationKey: 'hunt.item_find' }, previewSpeciesSlug: 'alpha' },
        deps,
      ),
    ).toThrow(ResultPresentationValidationError);
  });

  it('reports missing custom artwork instead of failing', () => {
    const preview = buildResultPresentationPreview(
      {
        variant: {
          presentationKey: 'hunt.item_find',
          artworkMode: 'custom',
          artworkPath: 'results/missing.png',
        },
      },
      deps,
    );
    expect(preview.artwork).toEqual({ mode: 'custom', path: 'results/missing.png', status: 'missing' });
  });

  it('rejects weight, enabled and gameplay fields', () => {
    for (const extra of [{ weight: 2 }, { enabled: false }, { amount: 9 }, { species: 'x' }]) {
      expect(() =>
        buildResultPresentationPreview(
          { variant: { presentationKey: 'hunt.item_find', ...extra } },
          deps,
        ),
      ).toThrow(ResultPresentationValidationError);
    }
  });
});
