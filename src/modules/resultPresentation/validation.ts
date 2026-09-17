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

/** One validation problem, addressed to a form field when there is one. */
export interface ResultPresentationFieldIssue {
  /** Field name (`flavorText`, `artworkPath`, …), or '' for the whole variant. */
  path: string;
  message: string;
}

export class ResultPresentationValidationError extends Error {
  /** Human-readable lines, `field: message`. */
  readonly issues: string[];
  /** The same problems, structured for inline form errors. */
  readonly fieldIssues: ResultPresentationFieldIssue[];
  constructor(fieldIssues: ResultPresentationFieldIssue[]) {
    const issues = fieldIssues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
    super(`Result presentation variant is invalid: ${issues.join(' ')}`);
    this.name = 'ResultPresentationValidationError';
    this.issues = issues;
    this.fieldIssues = fieldIssues;
  }
}

function fail(error: z.ZodError): never {
  throw new ResultPresentationValidationError(
    error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

/** Parse or throw {@link ResultPresentationValidationError}. */
export function parseResultPresentationVariantInput(raw: unknown): ResultPresentationVariantInput {
  const parsed = ResultPresentationVariantInputSchema.safeParse(raw);
  if (!parsed.success) fail(parsed.error);
  return parsed.data;
}

/**
 * The fields an edit may change. The presentation key is deliberately absent:
 * a variant belongs to the result type it was created under, and editing it
 * changes how that result looks, never which result it describes.
 */
export const RESULT_PRESENTATION_EDITABLE_FIELDS = [
  'enabled',
  'weight',
  'flavorText',
  'artworkMode',
  'artworkPath',
] as const;

export type ResultPresentationVariantPatch = Partial<{
  enabled: unknown;
  weight: unknown;
  flavorText: unknown;
  artworkMode: unknown;
  artworkPath: unknown;
}>;

/**
 * Apply a partial edit to a stored variant and validate the **whole** result
 * with the canonical write schema — so an edit can never produce a variant a
 * create would have refused.
 *
 * Switching away from custom artwork without naming a path clears the stored
 * path, so "No artwork" does not trip over the image it replaces. Naming a
 * path while switching away is still an error.
 */
export function mergeResultPresentationVariantPatch(
  current: ResultPresentationVariantInput,
  patch: ResultPresentationVariantPatch & Record<string, unknown>,
): ResultPresentationVariantInput {
  const unknownFields = Object.keys(patch).filter(
    (k) => !(RESULT_PRESENTATION_EDITABLE_FIELDS as readonly string[]).includes(k),
  );
  if (unknownFields.length > 0) {
    throw new ResultPresentationValidationError(
      unknownFields.map((field) => ({
        path: field,
        message:
          field === 'presentationKey'
            ? 'A variant’s result type cannot be changed. Create a new variant under the other result type instead.'
            : 'This field cannot be edited.',
      })),
    );
  }
  const has = (field: string) => Object.prototype.hasOwnProperty.call(patch, field);
  const merged: Record<string, unknown> = {
    presentationKey: current.presentationKey,
    enabled: has('enabled') ? patch.enabled : current.enabled,
    weight: has('weight') ? patch.weight : current.weight,
    flavorText: has('flavorText') ? patch.flavorText : current.flavorText,
    artworkMode: has('artworkMode') ? patch.artworkMode : current.artworkMode,
    artworkPath: has('artworkPath') ? patch.artworkPath : current.artworkPath,
  };
  if (!has('artworkPath') && merged.artworkMode !== 'custom') merged.artworkPath = null;
  return parseResultPresentationVariantInput(merged);
}

/** Only the parts of a variant that change how it looks, for previews. */
export const ResultPresentationPreviewVariantSchema = z
  .object({
    presentationKey: z.unknown(),
    flavorText: z.unknown().optional(),
    artworkMode: z.unknown().optional(),
    artworkPath: z.unknown().optional(),
  })
  .strict();

/**
 * Validate an unsaved variant for preview with exactly the write rules.
 * Weight and enabled do not change the look, so the defaults stand in.
 */
export function parseResultPresentationPreviewVariant(raw: unknown): ResultPresentationVariantInput {
  const shape = ResultPresentationPreviewVariantSchema.safeParse(raw);
  if (!shape.success) fail(shape.error);
  return parseResultPresentationVariantInput(shape.data);
}
