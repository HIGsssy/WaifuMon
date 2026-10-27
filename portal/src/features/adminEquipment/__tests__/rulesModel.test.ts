import { describe, expect, it } from 'vitest';
import { formOfRules, inputOfRules, parsePercent, probabilityTotal, percent } from '../rulesModel';
import { rulesFixture } from './rulesFixtures';

describe('lossless rule authoring', () => {
  it('round-trips every probability basis point without floating-point rounding', () => {
    for (let bp = 0; bp <= 10000; bp++) expect(parsePercent(percent(bp))).toBe(bp);
  });
  it('round-trips the complete configuration, including legacy content and family order', () => {
    const rules = rulesFixture();
    rules.rarities.UR = structuredClone(rules.rarities.SSR!);
    rules.rarities.LR = {
      ...structuredClone(rules.rarities.SSR!),
      primarySp: { chanceBp: 1234, min: 5, max: 15, step: 5 },
    };
    expect(inputOfRules(formOfRules(rules), rules)).toEqual({ rules, issues: [] });
  });
  it('refuses excessive precision, negative numbers, exponent notation and blanks without rewriting values', () => {
    for (const value of ['0.001', '-1', '1e2', '', '1.2345'])
      expect(parsePercent(value)).toBeNull();
    const rules = rulesFixture();
    const form = formOfRules(rules);
    form.rarities.SSR!.weights[1] = '70.001';
    expect(inputOfRules(form, rules).rules).toBeNull();
    expect(form.rarities.SSR!.weights[1]).toBe('70.001');
  });
  it('requires exactly 100% and does not normalize', () => {
    expect(probabilityTotal(['0', '69.99', '30', '0'])).toBe(9999);
    const rules = rulesFixture();
    const form = formOfRules(rules);
    form.rarities.SSR!.weights[1] = '69.99';
    expect(inputOfRules(form, rules).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'rarities.SSR.bonusCountWeightsBp' }),
      ]),
    );
    expect(form.rarities.SSR!.weights[1]).toBe('69.99');
  });
});
