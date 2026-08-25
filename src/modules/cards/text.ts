/**
 * Text helpers for card composition — escaping, truncation, wrapping, fitting.
 *
 * Two invariants drive everything here:
 *
 * 1. **The renderer never trusts its input.** Phase 1 does not touch the Zod
 *    content schema, so an authored string may be arbitrarily long or contain
 *    XML metacharacters. Every helper is total: it clamps rather than throws.
 * 2. **Width is estimated, not measured.** Pulling in a font-metrics library to
 *    shape text we are about to hand to resvg anyway is not worth the
 *    dependency at this scale, so {@link estimateTextWidth} uses a small
 *    per-character advance table calibrated for Inter. It is intentionally
 *    slightly pessimistic — over-estimating shrinks or wraps text a touch
 *    early, which looks fine; under-estimating overflows the panel, which does
 *    not.
 */

/** Hard caps from the V2 plan. Enforced here so long input degrades, not breaks. */
export const TEXT_LIMITS = {
  subtitle: 48,
  artist: 48,
  abilityName: 32,
  abilityText: 160,
  flavorQuote: 120,
  cardNumber: 24,
  characterName: 40,
} as const;

export const ELLIPSIS = '…';

/**
 * Escapes the five XML metacharacters. Applied at serialization time to every
 * user-authored string; the XML builder is configured to *not* re-encode
 * entities so this is the single place escaping happens.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Collapses whitespace and trims. Card text is single-line by construction, so
 * a newline in authored content must not become a gap in the middle of a label.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Truncates to `maxChars`, appending an ellipsis that counts toward the budget.
 * Returns the input unchanged when it already fits.
 */
export function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  if (maxChars === 1) return ELLIPSIS;
  return `${value.slice(0, maxChars - 1).trimEnd()}${ELLIPSIS}`;
}

/**
 * Normalizes, then truncates. The composer's default path for any optional
 * authored string; returns `null` for content that is absent or blank so the
 * caller can drop the element rather than render an empty box.
 */
export function cleanOptional(
  value: string | null | undefined,
  maxChars: number,
): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeWhitespace(value);
  if (normalized.length === 0) return null;
  return truncate(normalized, maxChars);
}

/**
 * Relative advance widths (in em) per character class, calibrated against
 * Inter. Anything not listed uses {@link DEFAULT_ADVANCE}.
 */
const DEFAULT_ADVANCE = 0.56;
const NARROW_CHARS = "iljtfrI1.,;:'`|!()[]{}-";
const NARROW_ADVANCE = 0.3;
const WIDE_CHARS = 'MW@%mw';
const WIDE_ADVANCE = 0.87;
const SPACE_ADVANCE = 0.26;
/** Bold/extrabold faces sit wider than regular at the same point size. */
const BOLD_MULTIPLIER = 1.06;

/**
 * Approximate rendered width, in user units, of `text` at `fontSize`.
 * CJK/full-width codepoints are billed at a full em since Inter would fall
 * back to a wide face for them.
 */
export function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  let em = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === ' ') em += SPACE_ADVANCE;
    else if (code > 0x2e7f) em += 1;
    else if (NARROW_CHARS.includes(char)) em += NARROW_ADVANCE;
    else if (WIDE_CHARS.includes(char)) em += WIDE_ADVANCE;
    else em += DEFAULT_ADVANCE;
  }
  return em * fontSize * (bold ? BOLD_MULTIPLIER : 1);
}

export interface FittedText {
  text: string;
  fontSize: number;
  /** True when the text still had to be truncated at the smallest tier. */
  truncated: boolean;
}

/**
 * Picks the largest font size from `tiers` (descending) at which `text` fits
 * `maxWidth`. If it does not fit even at the smallest tier, truncates
 * character-by-character at that tier until it does.
 */
export function fitText(
  text: string,
  maxWidth: number,
  tiers: readonly number[],
  bold = false,
): FittedText {
  const ordered = [...tiers].sort((a, b) => b - a);
  const smallest = ordered[ordered.length - 1] ?? 1;

  for (const fontSize of ordered) {
    if (estimateTextWidth(text, fontSize, bold) <= maxWidth) {
      return { text, fontSize, truncated: false };
    }
  }

  let candidate = text;
  while (candidate.length > 1 && estimateTextWidth(candidate + ELLIPSIS, smallest, bold) > maxWidth) {
    candidate = candidate.slice(0, -1).trimEnd();
  }
  return { text: `${candidate}${ELLIPSIS}`, fontSize: smallest, truncated: true };
}

/**
 * Greedy word wrap into at most two lines, both bounded by `maxWidth`. Text
 * that does not fit is truncated with an ellipsis on the second line — the
 * template only has two `text` elements per wrapped field, so a third line has
 * nowhere to go.
 *
 * A single word longer than a line is hard-split rather than allowed to
 * overflow the panel.
 */
export function wrapToTwoLines(
  text: string,
  maxWidth: number,
  fontSize: number,
  bold = false,
): [string, string] {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) return ['', ''];
  if (estimateTextWidth(normalized, fontSize, bold) <= maxWidth) return [normalized, ''];

  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  const pushCurrent = (): void => {
    if (current.length > 0) lines.push(current);
    current = '';
  };

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (estimateTextWidth(candidate, fontSize, bold) <= maxWidth) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (estimateTextWidth(word, fontSize, bold) <= maxWidth) {
      current = word;
      continue;
    }
    // Word alone overflows a line: hard-split it.
    let remainder = word;
    while (remainder.length > 0 && estimateTextWidth(remainder, fontSize, bold) > maxWidth) {
      let take = remainder.length;
      while (take > 1 && estimateTextWidth(remainder.slice(0, take), fontSize, bold) > maxWidth) {
        take -= 1;
      }
      lines.push(remainder.slice(0, take));
      remainder = remainder.slice(take);
    }
    current = remainder;
  }
  pushCurrent();

  const first = lines[0] ?? '';
  const rest = lines.slice(1);
  if (rest.length === 0) return [first, ''];

  let second = rest.join(' ');
  if (estimateTextWidth(second, fontSize, bold) <= maxWidth) return [first, second];

  while (second.length > 1 && estimateTextWidth(second + ELLIPSIS, fontSize, bold) > maxWidth) {
    second = second.slice(0, -1).trimEnd();
  }
  return [first, `${second}${ELLIPSIS}`];
}
