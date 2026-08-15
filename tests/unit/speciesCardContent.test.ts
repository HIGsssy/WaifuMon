/**
 * Phase 2 content model — optional `race`, optional `card`, and the bridge
 * that turns authored content into renderer input.
 *
 * The load-bearing property throughout is **backward compatibility**: every
 * species file that existed before these fields must still validate and still
 * render, without anyone editing it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SpeciesCardMetaSchema,
  SpeciesContentSchema,
  SpeciesFileSchema,
} from '../../src/modules/content/schemas';
import { checkSpeciesRaces, listSpeciesFiles } from '../../src/modules/content/loader';
import { toCardRenderInput } from '../../src/modules/content/speciesCardInput';
import { RACE_CODES } from '../../src/modules/cards';

const SPECIES_DIR = path.resolve(__dirname, '../../content/species');

/** A minimal species that predates both new fields — the migration baseline. */
function legacySpecies(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'test_species',
    name: 'Test Species',
    rarity: 'SR',
    archetype: 'demon',
    contentRating: 'suggestive',
    affinity: 'dominant',
    imagePath: 'waifumon/test_species/standard.png',
    ...overrides,
  };
}

function parse(overrides: Record<string, unknown> = {}): ReturnType<typeof SpeciesContentSchema.safeParse> {
  return SpeciesContentSchema.safeParse(legacySpecies(overrides));
}

function warnSpy(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('species schema — race', () => {
  it('validates a species with no race at all', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.race).toBeUndefined();
  });

  it('accepts every valid race code', () => {
    for (const race of RACE_CODES) {
      expect(parse({ race }).success, race).toBe(true);
    }
  });

  it('rejects a race outside the closed set', () => {
    for (const race of ['elf', 'Angel', 'ANGEL', 'demi_human', '', null, 42]) {
      expect(parse({ race }).success, String(race)).toBe(false);
    }
  });

  it('keeps archetype free-form and independent of race', () => {
    for (const archetype of ['paladin', 'librarian', 'idol', 'assassin', 'barista', 'guardian']) {
      const result = parse({ archetype, race: 'valkyrie' });
      expect(result.success, archetype).toBe(true);
      if (result.success) {
        expect(result.data.archetype).toBe(archetype);
        expect(result.data.race).toBe('valkyrie');
      }
    }
  });

  it('rejects an empty archetype, which is still required', () => {
    expect(parse({ archetype: '' }).success).toBe(false);
  });
});

describe('species schema — card metadata', () => {
  const fullCard = {
    subtitle: 'Fire-Escape Regular',
    artist: 'Someone Real',
    ability: { name: 'Trade Secrets', text: 'Knows which windows are unlatched.' },
    flavorQuote: 'Look up.',
    cardNumber: '012/100',
  };

  it('validates a species with no card block', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.card).toBeUndefined();
  });

  it('validates a fully populated card block', () => {
    const result = parse({ card: fullCard });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.card).toEqual(fullCard);
  });

  it('validates an empty card block and every single-field subset', () => {
    expect(parse({ card: {} }).success).toBe(true);
    for (const [key, value] of Object.entries(fullCard)) {
      expect(parse({ card: { [key]: value } }).success, key).toBe(true);
    }
  });

  it('rejects unknown keys so typos surface at authoring time', () => {
    expect(parse({ card: { flavourQuote: 'British spelling' } }).success).toBe(false);
    expect(parse({ card: { affinityDescription: 'not authored here' } }).success).toBe(false);
  });

  describe('ability is all-or-nothing', () => {
    it('accepts the complete pair', () => {
      expect(parse({ card: { ability: { name: 'A', text: 'B' } } }).success).toBe(true);
    });

    it('rejects a name with no text', () => {
      expect(parse({ card: { ability: { name: 'Trade Secrets' } } }).success).toBe(false);
    });

    it('rejects text with no name', () => {
      expect(parse({ card: { ability: { text: 'Does a thing.' } } }).success).toBe(false);
    });

    it('rejects an empty ability object', () => {
      expect(parse({ card: { ability: {} } }).success).toBe(false);
    });
  });

  describe('length limits', () => {
    const limits: [string, number][] = [
      ['subtitle', 48],
      ['artist', 48],
      ['flavorQuote', 120],
      ['cardNumber', 32],
    ];

    for (const [field, max] of limits) {
      it(`accepts ${field} at exactly ${max} and rejects ${max + 1}`, () => {
        expect(parse({ card: { [field]: 'x'.repeat(max) } }).success).toBe(true);
        expect(parse({ card: { [field]: 'x'.repeat(max + 1) } }).success).toBe(false);
      });
    }

    it('accepts ability name at 32 and rejects 33', () => {
      expect(parse({ card: { ability: { name: 'x'.repeat(32), text: 'ok' } } }).success).toBe(true);
      expect(parse({ card: { ability: { name: 'x'.repeat(33), text: 'ok' } } }).success).toBe(false);
    });

    it('accepts ability text at 160 and rejects 161', () => {
      expect(parse({ card: { ability: { name: 'ok', text: 'x'.repeat(160) } } }).success).toBe(true);
      expect(parse({ card: { ability: { name: 'ok', text: 'x'.repeat(161) } } }).success).toBe(false);
    });
  });

  describe('empty values', () => {
    it('rejects whitespace-only optional fields rather than letting them vanish at render time', () => {
      for (const blank of ['', '   ', '\n\t']) {
        expect(parse({ card: { subtitle: blank } }).success, JSON.stringify(blank)).toBe(false);
      }
    });

    it('rejects a blank ability half', () => {
      expect(parse({ card: { ability: { name: '  ', text: 'ok' } } }).success).toBe(false);
      expect(parse({ card: { ability: { name: 'ok', text: '  ' } } }).success).toBe(false);
    });

    it('trims surrounding whitespace on values it keeps', () => {
      const result = SpeciesCardMetaSchema.safeParse({ subtitle: '  Fire-Escape Regular  ' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.subtitle).toBe('Fire-Escape Regular');
    });
  });
});

describe('shipped content', () => {
  const files = listSpeciesFiles(SPECIES_DIR);

  it('has species files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} still validates under the extended schema`, () => {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(SPECIES_DIR, file), 'utf8'));
      const result = SpeciesFileSchema.safeParse(raw);
      expect(result.success ? [] : result.error.issues).toEqual([]);
    });
  }

  const allSpecies = files.flatMap((f) =>
    SpeciesFileSchema.parse(JSON.parse(fs.readFileSync(path.join(SPECIES_DIR, f), 'utf8'))),
  );

  it('does not require race — most of the corpus still omits it', () => {
    const withoutRace = allSpecies.filter((s) => !s.race);
    expect(withoutRace.length).toBeGreaterThan(0);
  });

  it('ships at least two seeded examples of the new format', () => {
    expect(allSpecies.filter((s) => s.race).length).toBeGreaterThanOrEqual(2);
    expect(allSpecies.filter((s) => s.card).length).toBeGreaterThanOrEqual(2);
  });

  it('seeds an example that omits the card block entirely', () => {
    expect(allSpecies.some((s) => s.race && !s.card)).toBe(true);
  });

  it('never authors an affinity description into species content', () => {
    for (const species of allSpecies) {
      const card = species.card as Record<string, unknown> | undefined;
      if (!card) continue;
      for (const forbidden of ['affinityDescription', 'affinityText', 'dominantDescription']) {
        expect(card[forbidden], `${species.slug}.${forbidden}`).toBeUndefined();
      }
    }
  });

  it('produces no race-fallback warnings for the current corpus', () => {
    const logger = warnSpy();
    checkSpeciesRaces(allSpecies, logger as never);
    expect(logger.warn.mock.calls.map((c) => c[1])).toEqual([]);
  });
});

describe('checkSpeciesRaces', () => {
  const base = SpeciesContentSchema.parse(legacySpecies());

  it('says nothing when race is explicit', () => {
    const logger = warnSpy();
    checkSpeciesRaces([{ ...base, race: 'angel', archetype: 'paladin' }], logger as never);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says nothing when the archetype maps — the fallback working is not news', () => {
    const logger = warnSpy();
    checkSpeciesRaces([{ ...base, archetype: 'demon' }], logger as never);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns with slug, archetype, and fallback when the archetype maps to nothing', () => {
    const logger = warnSpy();
    checkSpeciesRaces([{ ...base, slug: 'mystery_girl', archetype: 'librarian' }], logger as never);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      tag: 'card-renderer/race-fallback',
      slug: 'mystery_girl',
      archetype: 'librarian',
      fallbackRace: 'human',
    });
  });

  it('warns once per species, not once per pass over the same slug', () => {
    const offender = { ...base, slug: 'mystery_girl', archetype: 'librarian' };
    const logger = warnSpy();
    checkSpeciesRaces([offender, offender], logger as never);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('never mutates the species it inspects', () => {
    const offender = { ...base, archetype: 'librarian' };
    const before = JSON.stringify(offender);
    checkSpeciesRaces([offender], warnSpy() as never);
    expect(JSON.stringify(offender)).toBe(before);
    expect(offender.race).toBeUndefined();
  });
});

describe('toCardRenderInput', () => {
  const base = SpeciesContentSchema.parse(legacySpecies());

  /** Stands in for a `ResolvedAppearanceAsset` from the shared resolver. */
  function art(variant = 'standard', absolutePath = `D:/art/test_species/${variant}.png`) {
    return { absolutePath, assetId: { kind: 'waifumon', slug: 'test_species', variant } };
  }

  it('prefers explicit race over the archetype', () => {
    const input = toCardRenderInput(
      { ...base, archetype: 'paladin', race: 'valkyrie' },
      { artwork: art() },
    );
    expect(input.species.race).toBe('valkyrie');
  });

  it('falls back to the archetype-derived race', () => {
    const input = toCardRenderInput({ ...base, archetype: 'spirit' }, { artwork: art() });
    expect(input.species.race).toBe('spirit');
  });

  it('falls back to human and warns for an unmappable archetype', () => {
    const logger = warnSpy();
    const input = toCardRenderInput(
      { ...base, archetype: 'librarian' },
      { artwork: art(), logger: logger as never },
    );
    expect(input.species.race).toBe('human');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('carries the card block through untouched', () => {
    const card = { subtitle: 'Fire-Escape Regular' };
    const input = toCardRenderInput({ ...base, card }, { artwork: art() });
    expect(input.species.card).toEqual(card);
  });

  it('omits the card block when the species has none', () => {
    const input = toCardRenderInput(base, { artwork: art() });
    expect(input.species.card).toBeUndefined();
  });

  it('defaults level to 1', () => {
    const input = toCardRenderInput(base, { artwork: art() });
    expect(input.variant.appearanceId).toBe('standard');
    expect(input.progress?.level).toBe(1);
  });

  it('passes through level, width, and overrides', () => {
    const input = toCardRenderInput(base, {
      artwork: art('level_20'),
      level: 20,
      width: 512,
      overrides: { subtitle: 'Event Skin' },
    });
    expect(input.variant).toEqual({
      appearanceId: 'level_20',
      artworkAbsolutePath: 'D:/art/test_species/level_20.png',
    });
    expect(input.progress?.level).toBe(20);
    expect(input.output?.width).toBe(512);
    expect(input.overrides).toEqual({ subtitle: 'Event Skin' });
  });

  it('takes the appearance id from the artwork that resolved, not the one requested', () => {
    // What the shared resolver returns when `level_20` fell back to `standard`:
    // the standard file, carrying the standard identity.
    const fellBack = art('standard', 'D:/art/test_species/standard.png');
    const input = toCardRenderInput(base, { artwork: fellBack });

    expect(input.variant.appearanceId).toBe('standard');
    expect(input.variant.artworkAbsolutePath).toBe('D:/art/test_species/standard.png');
  });

  it('never leaks archetype into renderer input', () => {
    const input = toCardRenderInput(
      { ...base, archetype: 'paladin', race: 'angel' },
      { artwork: art() },
    );
    expect(JSON.stringify(input)).not.toContain('paladin');
    expect(JSON.stringify(input)).not.toContain('archetype');
  });
});
