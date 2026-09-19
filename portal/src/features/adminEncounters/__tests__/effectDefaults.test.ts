/**
 * New-effect defaults, type switching, the item-effect save check, and the
 * server-issue translator — all pure.
 *
 * The defaults table below is the server's `EffectSchema` restated: every
 * required field that has a sensible default is *in* the effect. The failure
 * this guards is an input showing a fallback (`quantity ?? 1`) that the state
 * never held, so Save sent a `give_item` with no `quantity`.
 */
import { describe, expect, it } from 'vitest';

import { PortalApiError } from '@/api/client';

import { EFFECT_TYPES, itemEffectIssues, newEffect, switchEffectType } from '../effectDefaults';
import { saveIssuesOf } from '../encounterDraft';

const T = 'trigger_waifumon_encounter';

describe('newEffect', () => {
  it('carries every required field that has a default, for every effect type', () => {
    const expected: Record<string, Record<string, unknown>> = {
      waifubux_gain: { amount: 100 },
      waifubux_loss: { amount: 50 },
      waifubux_loss_percent: { percent: 0.1 },
      essence_gain: { amount: 25 },
      essence_loss: { amount: 25 },
      energy_gain: { amount: 1 },
      energy_loss: { amount: 1 },
      player_xp: { amount: 10 },
      buddy_xp: { amount: 10 },
      affection_gain: { amount: 5 },
      give_item: { quantity: 1 },
      consume_item: { quantity: 1 },
      trigger_encounter: {},
      [T]: {},
      temp_buff: { durationSeconds: 3600 },
      open_vendor: {},
    };
    expect([...EFFECT_TYPES].sort()).toEqual(Object.keys(expected).sort());
    for (const type of EFFECT_TYPES) {
      expect(newEffect(type), type).toEqual({ type, ...expected[type] });
    }
  });

  it('gives a new item effect quantity 1 in the effect itself', () => {
    expect(newEffect('give_item')).toEqual({ type: 'give_item', quantity: 1 });
    expect(newEffect('give_item').quantity).toBe(1);
    expect(newEffect('consume_item')).toEqual({ type: 'consume_item', quantity: 1 });
  });

  it('returns a fresh object each time, so effects never share state', () => {
    const a = newEffect('give_item');
    a.quantity = 7;
    expect(newEffect('give_item').quantity).toBe(1);
  });
});

describe('switchEffectType', () => {
  it('another effect → item grant: quantity initialized, amount not carried', () => {
    expect(switchEffectType({ type: 'waifubux_gain', amount: 100 }, 'give_item')).toEqual({
      type: 'give_item',
      quantity: 1,
    });
  });

  it('item grant → another effect: item fields dropped, new defaults set', () => {
    expect(
      switchEffectType({ type: 'give_item', slug: 'basic_charm', quantity: 3 }, 'waifubux_gain'),
    ).toEqual({ type: 'waifubux_gain', amount: 100 });
    expect(
      switchEffectType({ type: 'give_item', slug: 'basic_charm', quantity: 3 }, 'temp_buff'),
    ).toEqual({ type: 'temp_buff', durationSeconds: 3600 });
  });

  it('item grant → another effect → item grant ends with valid item defaults', () => {
    const start = { type: 'give_item', slug: 'basic_charm', quantity: 3 };
    const away = switchEffectType(start, 'essence_gain');
    const back = switchEffectType(away, 'give_item');
    expect(back).toEqual({ type: 'give_item', quantity: 1 });
    expect(JSON.stringify(back)).not.toContain('amount');
  });

  it('keeps the fields both types define', () => {
    expect(
      switchEffectType({ type: 'give_item', slug: 'basic_charm', quantity: 4 }, 'consume_item'),
    ).toEqual({ type: 'consume_item', slug: 'basic_charm', quantity: 4 });
    expect(switchEffectType({ type: 'waifubux_gain', amount: 300 }, 'essence_gain')).toEqual({
      type: 'essence_gain',
      amount: 300,
    });
  });

  it('keeps an explicit zero rather than treating it as missing', () => {
    expect(switchEffectType({ type: 'player_xp', amount: 0 }, 'buddy_xp')).toEqual({
      type: 'buddy_xp',
      amount: 0,
    });
  });

  it('a Waifumon sighting starts and ends clean (it is strict on the server)', () => {
    expect(switchEffectType({ type: 'give_item', slug: 'x', quantity: 2 }, T)).toEqual({ type: T });
    expect(
      switchEffectType(
        { type: T, selection: { mode: 'random', poolScope: 'region' } },
        'give_item',
      ),
    ).toEqual({ type: 'give_item', quantity: 1 });
  });

  it('fills the other displayed-but-absent defaults too', () => {
    expect(switchEffectType({ type: 'waifubux_gain', amount: 5 }, 'waifubux_loss_percent')).toEqual(
      { type: 'waifubux_loss_percent', percent: 0.1 },
    );
    expect(switchEffectType({ type: 'give_item', quantity: 1 }, 'player_xp')).toEqual({
      type: 'player_xp',
      amount: 10,
    });
  });
});

describe('itemEffectIssues', () => {
  it('passes a complete item effect, 1 through 99', () => {
    for (const quantity of [1, 2, 99]) {
      expect(itemEffectIssues({ type: 'give_item', slug: 'basic_charm', quantity })).toEqual([]);
      expect(itemEffectIssues({ type: 'consume_item', slug: 'basic_charm', quantity })).toEqual([]);
    }
  });

  it('flags a missing item', () => {
    expect(itemEffectIssues({ type: 'give_item', quantity: 1 })).toEqual(['pick an item.']);
    expect(itemEffectIssues({ type: 'give_item', slug: '', quantity: 1 })).toEqual([
      'pick an item.',
    ]);
  });

  it('flags a missing, zero, negative, fractional or too-large quantity', () => {
    const msg = 'quantity must be a whole number from 1 to 99.';
    for (const quantity of [undefined, 0, -1, 1.5, 100, Number.NaN, '3']) {
      expect(
        itemEffectIssues({ type: 'give_item', slug: 'basic_charm', quantity }),
        String(quantity),
      ).toEqual([msg]);
    }
  });

  it('ignores every other effect type', () => {
    expect(itemEffectIssues({ type: 'waifubux_gain', amount: 100 })).toEqual([]);
  });
});

describe('saveIssuesOf', () => {
  const error = (issues: unknown) =>
    new PortalApiError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'The request was not valid.',
      details: { issues },
    });

  it('labels the production failure the way the save blockers do', () => {
    expect(
      saveIssuesOf(
        error([{ path: '/input/choices/0/successEffects/2/quantity', message: 'Required' }]),
      ),
    ).toEqual(['Choice #1, success effect #3 — quantity: Required']);
  });

  it('labels failure effects, choice fields and top-level fields', () => {
    expect(
      saveIssuesOf(
        error([
          { path: '/input/choices/1/failureEffects/0/slug', message: 'Required' },
          { path: '/input/choices/2/failureEffects/4', message: 'Invalid discriminator value' },
          { path: '/input/choices/0/label', message: 'Required' },
          { path: '/input/name', message: 'Required' },
          { path: '', message: 'Bad body' },
        ]),
      ),
    ).toEqual([
      'Choice #2, failure effect #1 — slug: Required',
      'Choice #3, failure effect #5: Invalid discriminator value',
      'Choice #1 — label: Required',
      'name: Required',
      'Bad body',
    ]);
  });

  it('is empty for an error with no issues', () => {
    expect(saveIssuesOf(new Error('boom'))).toEqual([]);
    expect(saveIssuesOf(error(undefined))).toEqual([]);
    expect(saveIssuesOf(null)).toEqual([]);
  });
});
