/**
 * Authored outcome flavor text — the narrative line a player reads after a
 * choice resolves.
 *
 * Three optional fields live on a choice:
 *
 *   - `outcomeText` — the generic line, and the fallback for either branch;
 *   - `successText` — shown when a real check succeeded;
 *   - `failureText` — shown when a real check failed.
 *
 * **Presentation only.** Nothing here is read by the check resolver, the
 * effect executor, chaining, cooldowns or spawning. The runtime decides the
 * outcome first, and only then asks {@link resolveOutcomeText} what to say
 * about it.
 *
 * The precedence rules live here and nowhere else: Discord, the Portal
 * preview and the simulator all consume the *resolved* string rather than
 * re-deciding which authored field wins.
 */
import { z } from 'zod';

/**
 * Longest authored flavor line, in characters. A short paragraph: long enough
 * for two or three sentences, short enough that the Discord Result field
 * (1024 chars, shared with the choice label and outcome line) always fits.
 */
export const OUTCOME_TEXT_MAX_LENGTH = 500;

/**
 * Trim, fold CRLF to LF, and drop an empty result. Internal line breaks are
 * kept — an author may deliberately split a beat across two lines.
 * Non-strings pass through untouched so the schema below rejects them.
 */
export function normalizeOutcomeText(value: unknown): unknown {
  if (value === null) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.replace(/\r\n?/g, '\n').trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * One optional authored flavor field. Whitespace-only and `null` normalise to
 * omitted; any other non-string is an error.
 */
export const OutcomeTextSchema = z.preprocess(
  normalizeOutcomeText,
  z
    .string({ invalid_type_error: 'Flavor text must be a string.' })
    .max(OUTCOME_TEXT_MAX_LENGTH, `Flavor text must be at most ${OUTCOME_TEXT_MAX_LENGTH} characters.`)
    .optional(),
);

/** The authored flavor fields, as any choice shape carries them. */
export interface OutcomeTextFields {
  outcomeText?: string | null | undefined;
  successText?: string | null | undefined;
  failureText?: string | null | undefined;
}

/**
 * What happened, as far as flavor is concerned: either no check was taken, or
 * a check was rolled and succeeded or failed.
 */
export type OutcomeKind = 'auto' | 'success' | 'failure';

export function outcomeKindOf(checked: boolean, success: boolean): OutcomeKind {
  if (!checked) return 'auto';
  return success ? 'success' : 'failure';
}

/** A stored value that is present and non-blank, else null. */
function present(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The flavor line for an outcome, or null when nothing applies.
 *
 *   success → successText → outcomeText → null
 *   failure → failureText → outcomeText → null
 *   auto    → outcomeText → null
 *
 * A no-check choice never reads `successText`/`failureText`, even when they
 * are stored: they belong to a check the choice no longer has.
 */
export function resolveOutcomeText(choice: OutcomeTextFields, outcome: OutcomeKind): string | null {
  const fallback = present(choice.outcomeText);
  switch (outcome) {
    case 'success':
      return present(choice.successText) ?? fallback;
    case 'failure':
      return present(choice.failureText) ?? fallback;
    case 'auto':
      return fallback;
  }
}
