/**
 * Selection-share display: `weight / sum(enabled weights)`, and nothing for
 * a disabled variant.
 */
import { describe, expect, it } from 'vitest';

import { excerpt, formatShare, selectionShare } from '../presentationMath';

const v = (id: number, weight: number, enabled = true) => ({ id, weight, enabled });

describe('selectionShare', () => {
  it('divides by the enabled weights only', () => {
    const all = [v(1, 10), v(2, 5), v(3, 5), v(4, 100, false)];
    expect(selectionShare(all[0]!, all)).toBe(0.5);
    expect(selectionShare(all[1]!, all)).toBe(0.25);
    expect(selectionShare(all[3]!, all)).toBeNull();
  });

  it('is 100% for a lone enabled variant', () => {
    const all = [v(1, 7), v(2, 3, false)];
    expect(formatShare(selectionShare(all[0]!, all)!)).toBe('100%');
  });
});

describe('formatShare', () => {
  it('rounds, keeping a decimal below 1%', () => {
    expect(formatShare(1 / 3)).toBe('~33%');
    expect(formatShare(0.004)).toBe('~0.4%');
  });
});

describe('excerpt', () => {
  it('keeps the first line and marks what was cut', () => {
    expect(excerpt('One line')).toBe('One line');
    expect(excerpt('First\n\nSecond')).toBe('First …');
    expect(excerpt('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
