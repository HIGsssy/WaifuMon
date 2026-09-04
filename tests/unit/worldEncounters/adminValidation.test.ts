/**
 * Admin validation tests — the shape of an authored payload the panel
 * cannot save.
 *
 * These sit between the Zod schema (which validates *shape*) and the DB
 * write (which validates *references*). Everything asserted here is purely
 * synchronous: no DB, no fake IO — the validator takes a payload plus two
 * sets (known item slugs, known encounter slugs) and returns issues.
 */
import { describe, expect, it } from 'vitest';
import {
  AdminEncounterValidationError,
  parseEncounterInput,
} from '../../../src/modules/worldEncounters/adminService';

const ITEMS = new Set(['basic_charm', 'shiny_charm']);
const SLUGS = new Set(['wv_lost_cub', 'wv_wildflower_field']);

const OK_INPUT = {
  slug: 'wv_test',
  name: 'Test',
  description: 'A test encounter.',
  type: 'decision',
  rarity: 'common',
  weight: 10,
  lifecycle: 'active',
  huntEligible: true,
  travelEligible: false,
  cooldownSeconds: 60,
  regions: ['waifu-valley'],
  routes: [],
  choices: [
    {
      label: 'Do the thing',
      check: { type: 'none' },
      successEffects: [{ type: 'waifubux_gain', amount: 100 }],
    },
  ],
} as const;

describe('parseEncounterInput', () => {
  it('accepts a well-formed encounter', () => {
    const parsed = parseEncounterInput(OK_INPUT, ITEMS, SLUGS);
    expect(parsed.slug).toBe('wv_test');
    expect(parsed.choices).toHaveLength(1);
  });

  it('rejects an invalid slug', () => {
    expect(() => parseEncounterInput({ ...OK_INPUT, slug: 'WV Test!' }, ITEMS, SLUGS)).toThrow(
      AdminEncounterValidationError,
    );
  });

  it('rejects a choicesRequired encounter with no choices', () => {
    expect(() =>
      parseEncounterInput({ ...OK_INPUT, choices: [] }, ITEMS, SLUGS),
    ).toThrow(AdminEncounterValidationError);
  });

  it('rejects an encounter with neither source enabled', () => {
    expect(() =>
      parseEncounterInput(
        { ...OK_INPUT, huntEligible: false, travelEligible: false },
        ITEMS,
        SLUGS,
      ),
    ).toThrow(AdminEncounterValidationError);
  });

  it('rejects give_item / consume_item referencing an unknown slug', () => {
    const bad = {
      ...OK_INPUT,
      choices: [
        {
          label: 'Take the gift',
          check: { type: 'none' },
          successEffects: [{ type: 'give_item', slug: 'no_such_item', quantity: 1 }],
        },
      ],
    };
    expect(() => parseEncounterInput(bad, ITEMS, SLUGS)).toThrow(AdminEncounterValidationError);
  });

  it('accepts give_item referencing a known slug', () => {
    const good = {
      ...OK_INPUT,
      choices: [
        {
          label: 'Take a charm',
          check: { type: 'none' },
          successEffects: [{ type: 'give_item', slug: 'basic_charm', quantity: 1 }],
        },
      ],
    };
    expect(() => parseEncounterInput(good, ITEMS, SLUGS)).not.toThrow();
  });

  it('rejects a choice that triggers its own parent encounter (immediate loop)', () => {
    const bad = {
      ...OK_INPUT,
      choices: [
        {
          label: 'Loop forever',
          check: { type: 'none' },
          successEffects: [
            { type: 'trigger_encounter', encounterSlug: OK_INPUT.slug },
          ],
        },
      ],
    };
    expect(() => parseEncounterInput(bad, ITEMS, SLUGS)).toThrow(AdminEncounterValidationError);
  });

  it('rejects self-chain via chainedEncounterSlug', () => {
    const bad = { ...OK_INPUT, chainedEncounterSlug: OK_INPUT.slug };
    expect(() => parseEncounterInput(bad, ITEMS, SLUGS)).toThrow(AdminEncounterValidationError);
  });

  it('rejects a route whose endpoints match', () => {
    const bad = {
      ...OK_INPUT,
      travelEligible: true,
      routes: [{ fromRegion: 'waifu-valley', toRegion: 'waifu-valley' }],
    };
    expect(() => parseEncounterInput(bad, ITEMS, SLUGS)).toThrow(AdminEncounterValidationError);
  });

  it('rejects negative or zero weight', () => {
    expect(() => parseEncounterInput({ ...OK_INPUT, weight: 0 }, ITEMS, SLUGS)).toThrow(
      AdminEncounterValidationError,
    );
    expect(() => parseEncounterInput({ ...OK_INPUT, weight: -5 }, ITEMS, SLUGS)).toThrow(
      AdminEncounterValidationError,
    );
  });

  it('rejects a percent loss outside (0, 1]', () => {
    const bad = {
      ...OK_INPUT,
      choices: [
        {
          label: 'Test',
          check: { type: 'none' },
          successEffects: [{ type: 'waifubux_loss_percent', percent: 1.5 }],
        },
      ],
    };
    expect(() => parseEncounterInput(bad, ITEMS, SLUGS)).toThrow(AdminEncounterValidationError);
  });
});
