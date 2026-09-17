/**
 * Validation for authored Result Presentation variants.
 *
 * One statement of what a storable variant is, shared by the service's write
 * path and (later) the admin API. The database CHECKs are the backstop; this
 * is where an author gets a readable message.
 *
 * Text rules are the World Encounter outcome-text rules
 * (`normalizeOutcomeText`: trim, CRLF → LF, internal line breaks kept, blank →
 * unset), so the two authoring surfaces never disagree about what "empty"
 * means. Path rules are the strict boss-content rules plus an image extension
 * allowlist (`relativeArtworkPath`).
 */
import { z } from 'zod';
import { relativeArtworkPath } from '../assets/artworkPath';
import { normalizeOutcomeText } from '../worldEncounters/outcomeText';
import {
  ARTWORK_MODES,
  RESULT_PRESENTATION_FLAVOR_MAX_LENGTH,
  RESULT_PRESENTATION_KEYS,
  defaultArtworkModeFor,
  isArtworkModeAllowed,
  type ArtworkMode,
  type ResultPresentationKey,
} from './keys';

/** Upper bound on a variant weight. Relative weights never need more. */
export const RESULT_PRESENTATION_MAX_WEIGHT = 1_000_000;

const FlavorTextSchema = z.preprocess(
  normalizeOutcomeText,
  z
    .string({ invalid_type_error: 'Flavor text must be a string.' })
    .max(
      RESULT_PRESENTATION_FLAVOR_MAX_LENGTH,
      `Flavor text must be at most ${RESULT_PRESENTATION_FLAVOR_MAX_LENGTH} characters.`,
    )
    .optional(),
);

/** Blank and null artwork paths mean "no artwork". */
const ArtworkPathSchema = z.preprocess(
  (value) => {
    if (value === null) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
  },
  relativeArtworkPath.optional(),
);

/** A variant exactly as it is stored and read. */
export interface ResultPresentationVariantInput {
  presentationKey: ResultPresentationKey;
  enabled: boolean;
  weight: number;
  flavorText: string | null;
  artworkPath: string | null;
  artworkMode: ArtworkMode;
}

export const ResultPresentationVariantInputSchema = z
  .object({
    presentationKey: z.enum(RESULT_PRESENTATION_KEYS, {
      errorMap: () => ({ message: 'Unknown presentation key.' }),
    }),
    enabled: z.boolean().default(true),
    weight: z
      .number()
      .int('Weight must be a whole number.')
      .positive('Weight must be greater than 0.')
      .max(RESULT_PRESENTATION_MAX_WEIGHT, `Weight must be at most ${RESULT_PRESENTATION_MAX_WEIGHT}.`)
      .default(1),
    flavorText: FlavorTextSchema,
    artworkPath: ArtworkPathSchema,
    /** Omitted → the key's default mode. */
    artworkMode: z.enum(ARTWORK_MODES).optional(),
  })
  .superRefine((value, issue) => {
    const mode = value.artworkMode ?? defaultArtworkModeFor(value.presentationKey);
    if (!isArtworkModeAllowed(value.presentationKey, mode)) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artworkMode'],
        message: `Artwork mode "${mode}" is not allowed for ${value.presentationKey}.`,
      });
    }
    if (mode === 'custom' && !value.artworkPath) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artworkPath'],
        message: 'Custom artwork needs an artwork path.',
      });
    }
    if (mode !== 'custom' && value.artworkPath) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artworkPath'],
        message: 'An artwork path is only used when the artwork mode is "custom".',
      });
    }
  })
  .transform(
    (value): ResultPresentationVariantInput => ({
      presentationKey: value.presentationKey,
      enabled: value.enabled,
      weight: value.weight,
      flavorText: value.flavorText ?? null,
      artworkPath: value.artworkPath ?? null,
      artworkMode: value.artworkMode ?? defaultArtworkModeFor(value.presentationKey),
    }),
  );

export class ResultPresentationValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Result presentation variant is invalid: ${issues.join(' ')}`);
    this.name = 'ResultPresentationValidationError';
    this.issues = issues;
  }
}

/** Parse or throw {@link ResultPresentationValidationError}. */
export function parseResultPresentationVariantInput(raw: unknown): ResultPresentationVariantInput {
  const parsed = ResultPresentationVariantInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ResultPresentationValidationError(
      parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)),
    );
  }
  return parsed.data;
}
