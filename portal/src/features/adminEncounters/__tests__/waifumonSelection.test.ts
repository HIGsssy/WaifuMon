/**
 * The pure authoring model for `trigger_waifumon_encounter`: every stored
 * generation opens as the right form, every form saves as exactly one
 * canonical shape, and summaries read like English.
 */
import { describe, expect, it } from 'vitest';

import {
  describeIssue,
  effectFromForm,
  formFromEffect,
  summarizeEffect,
  summarizeSelector,
  type SelectorForm,
} from '../waifumonSelection';

const T = 'trigger_waifumon_encounter';
const ORDER = {
  rarities: ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX'],
  races: ['angel', 'demon', 'demi-human', 'human', 'spirit', 'valkyrie', 'android'],
  affinities: ['dominant', 'submissive', 'caregiver', 'primal', 'switch'],
};
const random = (fields: Partial<Extract<SelectorForm, { mode: 'random' }>>): SelectorForm => ({
  mode: 'random',
  pool: 'region',
  rarities: [],
  races: [],
  affinities: [],
  ...fields,
});

describe('formFromEffect — every storage generation', () => {
  it('legacy specific opens as Specific', () => {
    expect(formFromEffect({ type: T, speciesSlug: 'lilith' })).toEqual({
      mode: 'specific',
      speciesSlug: 'lilith',
    });
  });

  it('legacy random opens as Random on the hunt draw', () => {
    expect(formFromEffect({ type: T })).toEqual(random({ pool: 'hunt_draw' }));
  });

  it('new specific and new random open as themselves', () => {
    expect(
      formFromEffect({ type: T, selection: { mode: 'specific', speciesSlug: 'x' } }),
    ).toEqual({ mode: 'specific', speciesSlug: 'x' });
    expect(
      formFromEffect({
        type: T,
        selection: { mode: 'random', poolScope: 'global', rarities: ['LR'], races: ['demon'] },
      }),
    ).toEqual(random({ pool: 'global', rarities: ['LR'], races: ['demon'] }));
  });

  it('a stale speciesSlug beside a selection (old editor bug) defers to the selection', () => {
    expect(
      formFromEffect({
        type: T,
        speciesSlug: 'stale',
        selection: { mode: 'random', poolScope: 'region' },
      }),
    ).toEqual(random({}));
  });
});

describe('effectFromForm — one canonical shape per mode', () => {
  it('specific carries only the species', () => {
    expect(effectFromForm({ mode: 'specific', speciesSlug: 'x' }, ORDER)).toEqual({
      type: T,
      selection: { mode: 'specific', speciesSlug: 'x' },
    });
  });

  it('random omits empty filters and never carries speciesSlug', () => {
    const effect = effectFromForm(random({}), ORDER);
    expect(effect).toEqual({ type: T, selection: { mode: 'random', poolScope: 'region' } });
    expect(JSON.stringify(effect)).not.toContain('speciesSlug');
    expect(JSON.stringify(effect)).not.toContain('[]');
  });

  it('serializes canonical lowercase values, de-duplicated, in reference order', () => {
    expect(
      effectFromForm(
        random({
          pool: 'global',
          rarities: ['LR', 'UR', 'LR'],
          races: ['spirit', 'demon'],
          affinities: ['primal'],
        }),
        ORDER,
      ),
    ).toEqual({
      type: T,
      selection: {
        mode: 'random',
        poolScope: 'global',
        rarities: ['UR', 'LR'],
        races: ['demon', 'spirit'],
        affinities: ['primal'],
      },
    });
  });

  it('the hunt draw is the bare legacy effect, filters dropped', () => {
    expect(effectFromForm(random({ pool: 'hunt_draw', rarities: ['LR'] }), ORDER)).toEqual({
      type: T,
    });
  });

  it('round-trips: effect → form → effect is stable for every canonical shape', () => {
    for (const effect of [
      { type: T },
      { type: T, selection: { mode: 'specific', speciesSlug: 'x' } },
      { type: T, selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] } },
      {
        type: T,
        selection: {
          mode: 'random',
          poolScope: 'global',
          rarities: ['UR', 'LR'],
          races: ['demon', 'spirit'],
          affinities: ['dominant', 'primal'],
        },
      },
    ]) {
      const saved = JSON.parse(JSON.stringify(effectFromForm(formFromEffect(effect), ORDER)));
      expect(saved).toEqual(effect);
    }
  });

  it('an edited legacy specific saves as the new specific shape', () => {
    expect(effectFromForm(formFromEffect({ type: T, speciesSlug: 'x' }), ORDER)).toEqual({
      type: T,
      selection: { mode: 'specific', speciesSlug: 'x' },
    });
  });
});

describe('summaries', () => {
  const names: Record<string, string> = { lilith: 'Lilith' };
  const nameOf = (slug: string) => names[slug];

  it.each([
    [{ mode: 'specific', speciesSlug: 'lilith' } as SelectorForm, 'Specific Waifumon: Lilith'],
    [random({}), 'Random Waifumon from current region'],
    [random({ rarities: ['LR'] }), 'Random LR Waifumon from current region'],
    [random({ rarities: ['UR', 'LR'] }), 'Random UR/LR Waifumon from current region'],
    [
      random({ pool: 'global', races: ['demon', 'spirit'] }),
      'Random Demon or Spirit Waifumon from global pool',
    ],
    [random({ rarities: ['LR'], races: ['demon'] }), 'Random LR Demon Waifumon from current region'],
    [
      random({ rarities: ['LR'], races: ['demon', 'spirit'], affinities: ['primal'] }),
      'Random LR Primal Demon or Spirit Waifumon from current region',
    ],
    [random({ races: ['demi-human'] }), 'Random Demi Human Waifumon from current region'],
  ])('%j → %s', (form, text) => {
    expect(summarizeSelector(form, nameOf)).toBe(text);
  });

  it('names an unchosen specific species plainly, and falls back to the slug', () => {
    expect(summarizeSelector({ mode: 'specific', speciesSlug: '' })).toBe(
      'Specific Waifumon: (none chosen)',
    );
    expect(summarizeEffect({ type: T, speciesSlug: 'unknown_one' }, nameOf)).toBe(
      'Specific Waifumon: unknown_one',
    );
  });

  it('describes the legacy hunt draw', () => {
    expect(summarizeEffect({ type: T })).toMatch(/hunt draw/);
  });
});

describe('describeIssue', () => {
  it('explains selector_no_candidates', () => {
    const d = describeIssue({ code: 'selector_no_candidates', message: 'raw server text' });
    expect(d.headline).toBe('This selector does not match any enabled Waifumon in any valid region.');
    expect(d.detail).toBe('raw server text');
  });

  it('explains selector_region_no_candidates with region names, not ids', () => {
    const d = describeIssue(
      { code: 'selector_region_no_candidates', message: 'raw', regions: ['twin-peeks', 'thirstlands'] },
      { 'twin-peeks': 'Twin Peeks' },
    );
    expect(d.headline).toContain('one or more regions where this encounter may run');
    expect(d.headline).toContain('Twin Peeks');
    expect(d.headline).toContain('Thirstlands');
    expect(d.headline).not.toContain('twin-peeks');
  });

  it('leaves other issues alone', () => {
    expect(describeIssue({ code: 'missing_item', message: 'unknown item' })).toEqual({
      headline: 'unknown item',
      detail: null,
    });
  });
});
