/**
 * The shipped-content race invariant.
 *
 * Runtime and CI deliberately disagree about what an unmappable archetype
 * means, and that asymmetry is the whole design:
 *
 *   - **Runtime** warns and renders a `human` frame. Content that somehow
 *     reached production must still produce a card.
 *   - **CI — this file** fails the build. Authored content should never *rely*
 *     on that fallback; it exists for content that escaped review, not as a
 *     substitute for writing `race`.
 *
 * The invariant reads real files rather than a hardcoded archetype list, so
 * authoring `"archetype": "barista"` without a `race` fails here the moment it
 * lands, not the first time someone looks at the card.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findUnresolvableRaces,
  listSpeciesFiles,
  unresolvableRaceMessage,
} from '../../src/modules/content/loader';
import { SpeciesFileSchema, type SpeciesContent } from '../../src/modules/content/schemas';
import { archetypeToRace, isRaceCode, resolveRace } from '../../src/modules/cards';

const SPECIES_DIR = path.resolve(__dirname, '../../content/species');

const shippedSpecies: SpeciesContent[] = listSpeciesFiles(SPECIES_DIR).flatMap((file) =>
  SpeciesFileSchema.parse(JSON.parse(fs.readFileSync(path.join(SPECIES_DIR, file), 'utf8'))),
);

/** Minimal species carrying only what the invariant looks at. */
function species(overrides: Partial<SpeciesContent>): SpeciesContent {
  return {
    slug: 'test_species',
    name: 'Test Species',
    rarity: 'N',
    archetype: 'demon',
    baseCaptureRate: null,
    description: '',
    tags: [],
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: 'waifumon/test_species/standard.png',
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    ...overrides,
  };
}

describe('shipped content satisfies the race invariant', () => {
  it('loads species to check', () => {
    expect(shippedSpecies.length).toBeGreaterThan(0);
  });

  it('has no species relying on the human fallback', () => {
    const offenders = findUnresolvableRaces(shippedSpecies);
    // Reported as messages so a failure names the file to fix, not a count.
    expect(offenders.map(unresolvableRaceMessage)).toEqual([]);
  });

  it('resolves every species to a valid race code', () => {
    for (const entry of shippedSpecies) {
      const race = resolveRace(entry);
      expect(isRaceCode(race), `${entry.slug} → ${race}`).toBe(true);
    }
  });

  it('only uses explicit races from the closed set', () => {
    for (const entry of shippedSpecies) {
      if (entry.race === undefined) continue;
      expect(isRaceCode(entry.race), `${entry.slug} → ${entry.race}`).toBe(true);
    }
  });
});

describe('findUnresolvableRaces', () => {
  it('passes a mapped legacy archetype with no explicit race', () => {
    expect(findUnresolvableRaces([species({ archetype: 'demon' })])).toEqual([]);
  });

  it('passes an explicit race alongside an arbitrary narrative archetype', () => {
    for (const archetype of ['paladin', 'librarian', 'idol', 'assassin', 'barista', 'guardian']) {
      expect(
        findUnresolvableRaces([species({ archetype, race: 'valkyrie' })]),
        archetype,
      ).toEqual([]);
    }
  });

  it('fails an unmapped archetype with no explicit race', () => {
    expect(findUnresolvableRaces([species({ slug: 'coffee_girl', archetype: 'barista' })])).toEqual([
      { slug: 'coffee_girl', archetype: 'barista' },
    ]);
  });

  it('fails the documented paladin case that has no race', () => {
    expect(archetypeToRace('paladin')).toBeNull();
    expect(findUnresolvableRaces([species({ archetype: 'paladin' })])).toHaveLength(1);
  });

  it('reports every offender, deduped by slug', () => {
    const offender = species({ slug: 'coffee_girl', archetype: 'barista' });
    const other = species({ slug: 'book_girl', archetype: 'librarian' });
    const found = findUnresolvableRaces([offender, offender, other]);

    expect(found.map((o) => o.slug)).toEqual(['coffee_girl', 'book_girl']);
  });

  it('names the species and the fix in its message', () => {
    const message = unresolvableRaceMessage({ slug: 'coffee_girl', archetype: 'barista' });
    expect(message).toContain('coffee_girl');
    expect(message).toContain('barista');
    expect(message).toContain('race');
  });
});

describe('runtime stays defensive even where CI is strict', () => {
  it('still resolves an unmappable archetype to human rather than throwing', () => {
    expect(resolveRace({ slug: 'coffee_girl', archetype: 'barista' })).toBe('human');
  });
});
