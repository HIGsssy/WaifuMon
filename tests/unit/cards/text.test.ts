/**
 * Text helpers. Phase 1 deliberately does not tighten Zod content validation,
 * so every helper here has to stay total in the face of input no author should
 * ever have written.
 */
import { describe, expect, it } from 'vitest';
import {
  cleanOptional,
  ELLIPSIS,
  escapeXml,
  estimateTextWidth,
  fitText,
  normalizeWhitespace,
  TEXT_LIMITS,
  truncate,
  wrapToTwoLines,
} from '../../../src/modules/cards/text';

describe('escapeXml', () => {
  it('escapes all five XML metacharacters', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('escapes ampersands before the entities it introduces', () => {
    expect(escapeXml('Tom & Jerry <3')).toBe('Tom &amp; Jerry &lt;3');
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
  });

  it('neutralises an attempted tag injection', () => {
    const hostile = '</text><script>alert(1)</script><text>';
    const escaped = escapeXml(hostile);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
  });

  it('leaves ordinary text, accents, and emoji alone', () => {
    expect(escapeXml('Mika — 天使 ✦')).toBe('Mika — 天使 ✦');
  });
});

describe('normalizeWhitespace', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normalizeWhitespace('  a\n\tb   c  ')).toBe('a b c');
  });
});

describe('truncate', () => {
  it('leaves text that already fits untouched', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('exactly10!', 10)).toBe('exactly10!');
  });

  it('appends an ellipsis that counts toward the budget', () => {
    const out = truncate('abcdefghij', 5);
    expect(out).toBe(`abcd${ELLIPSIS}`);
    expect(out).toHaveLength(5);
  });

  it('trims trailing space before the ellipsis', () => {
    expect(truncate('hello world', 7)).toBe(`hello${ELLIPSIS}`);
  });

  it('degrades gracefully at absurd budgets', () => {
    expect(truncate('abc', 1)).toBe(ELLIPSIS);
    expect(truncate('abc', 0)).toBe('');
  });
});

describe('cleanOptional', () => {
  it('returns null for absent or blank values so the caller can drop the element', () => {
    expect(cleanOptional(undefined, 10)).toBeNull();
    expect(cleanOptional(null, 10)).toBeNull();
    expect(cleanOptional('', 10)).toBeNull();
    expect(cleanOptional('   \n ', 10)).toBeNull();
  });

  it('normalises then truncates', () => {
    expect(cleanOptional('  spaced   out  ', 20)).toBe('spaced out');
    expect(cleanOptional('x'.repeat(80), TEXT_LIMITS.subtitle)).toHaveLength(TEXT_LIMITS.subtitle);
  });
});

describe('estimateTextWidth', () => {
  it('scales linearly with font size', () => {
    const small = estimateTextWidth('Alley Catgirl', 20);
    const large = estimateTextWidth('Alley Catgirl', 40);
    expect(large / small).toBeCloseTo(2, 5);
  });

  it('bills narrow glyphs less than wide ones', () => {
    expect(estimateTextWidth('iiii', 20)).toBeLessThan(estimateTextWidth('MMMM', 20));
  });

  it('bills bold wider than regular', () => {
    expect(estimateTextWidth('Name', 20, true)).toBeGreaterThan(estimateTextWidth('Name', 20));
  });

  it('is empty for empty input', () => {
    expect(estimateTextWidth('', 40)).toBe(0);
  });
});

describe('fitText', () => {
  const tiers = [54, 44, 36] as const;

  it('keeps the largest tier for a short name', () => {
    const fitted = fitText('Mika', 560, tiers, true);
    expect(fitted).toMatchObject({ text: 'Mika', fontSize: 54, truncated: false });
  });

  it('steps down a tier rather than overflowing', () => {
    const fitted = fitText('Abyssal Shrine Oracle', 560, tiers, true);
    expect(fitted.fontSize).toBeLessThan(54);
    expect(fitted.truncated).toBe(false);
    expect(estimateTextWidth(fitted.text, fitted.fontSize, true)).toBeLessThanOrEqual(560);
  });

  it('truncates at the smallest tier when even that will not fit', () => {
    const fitted = fitText('W'.repeat(120), 560, tiers, true);
    expect(fitted).toMatchObject({ fontSize: 36, truncated: true });
    expect(fitted.text.endsWith(ELLIPSIS)).toBe(true);
    expect(estimateTextWidth(fitted.text, fitted.fontSize, true)).toBeLessThanOrEqual(560);
  });

  it('works with a single fixed size', () => {
    expect(fitText('Ability', 400, [27]).fontSize).toBe(27);
  });
});

describe('wrapToTwoLines', () => {
  const width = 496;
  const fontSize = 20;

  it('leaves short text on one line', () => {
    expect(wrapToTwoLines('Short line.', width, fontSize)).toEqual(['Short line.', '']);
  });

  it('is empty in both slots for empty input', () => {
    expect(wrapToTwoLines('   ', width, fontSize)).toEqual(['', '']);
  });

  it('breaks on word boundaries', () => {
    const [first, second] = wrapToTwoLines(
      'Takes the lead and sets the pace. Responds best to a partner who yields gracefully.',
      width,
      fontSize,
    );
    expect(second.length).toBeGreaterThan(0);
    expect(first.endsWith(' ')).toBe(false);
    expect(second.startsWith(' ')).toBe(false);
    expect(`${first} ${second}`.replace(ELLIPSIS, '')).toBeTruthy();
    for (const line of [first, second]) {
      expect(estimateTextWidth(line, fontSize)).toBeLessThanOrEqual(width);
    }
  });

  it('never emits a third line — overflow is truncated onto the second', () => {
    const [first, second] = wrapToTwoLines(
      'word '.repeat(120).trim(),
      width,
      fontSize,
    );
    expect(second.endsWith(ELLIPSIS)).toBe(true);
    for (const line of [first, second]) {
      expect(estimateTextWidth(line, fontSize)).toBeLessThanOrEqual(width);
    }
  });

  it('hard-splits a single word too long for one line', () => {
    const [first, second] = wrapToTwoLines('W'.repeat(200), width, fontSize);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    for (const line of [first, second]) {
      expect(estimateTextWidth(line, fontSize)).toBeLessThanOrEqual(width);
    }
  });

  it('collapses newlines rather than leaving a gap mid-label', () => {
    expect(wrapToTwoLines('a\n\nb', width, fontSize)).toEqual(['a b', '']);
  });
});
