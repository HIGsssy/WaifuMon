/**
 * The one definition of a valid equipment definition.
 *
 * The startup seed, package import and (later) the Portal editor all validate
 * through {@link EquipmentDefinitionInputSchema}, so there is no second, laxer
 * rule that exists only for one entry point — the discipline
 * `encounterPackage.ts` follows for world encounters.
 *
 * Keyed by `key`, never by `id`. The schema is `.strict()`, so an authored
 * `id` (or any other unknown field) is refused rather than silently dropped.
 *
 * Invalid content fails loudly: every problem is reported with its path in an
 * {@link EquipmentValidationError}, and nothing is written.
 */
import { z } from 'zod';
import { PRICE_CURRENCIES, type EquipmentDefinitionRow } from '../../db/schema';
import { EquipmentValidationError, type EquipmentIssue } from '../../shared/errors';
import { relativeArtworkPath } from '../assets/artworkPath';
import { isRegion } from '../locations/regions';
import { multiplierRangeIssues } from './equipmentRoll';
import {
  EQUIPMENT_AUTHORING_RARITIES,
  EQUIPMENT_KEY_MAX_LENGTH,
  EQUIPMENT_KEY_PATTERN,
  EQUIPMENT_SLOTS,
  type EquipmentSlot,
} from './vocabulary';

/** Sign and range are checked by `multiplierRangeIssues`, with field paths. */
const basisPoints = z.number().int('must be a whole number of basis points');

const regionId = z.string().refine(isRegion, { message: 'unknown region' });

/**
 * Artwork paths are relative to `ASSETS_DIR` (by convention under
 * `equipment/`). The shared authored-artwork shape, so a path accepted here is
 * one the Discord resolver will serve; containment is enforced again whenever
 * the file is actually read.
 */
const artworkPath = relativeArtworkPath;

export const EquipmentDefinitionInputSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(EQUIPMENT_KEY_MAX_LENGTH)
      .regex(EQUIPMENT_KEY_PATTERN, 'key must be lowercase snake_case'),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(1000).default(''),
    slot: z.enum(EQUIPMENT_SLOTS),
    /** N–UR only in V1; LR and EX are withheld until the system matures. */
    rarity: z.enum(EQUIPMENT_AUTHORING_RARITIES),
    /**
     * The range a new instance's multiplier is rolled from — one of
     * `min, min+step, …, max` basis points, applied to this definition's own
     * slot's stat. Required: there is no sensible default multiplier. Owned
     * instances keep what they rolled when the range is retuned.
     */
    multiplierMinBp: basisPoints,
    multiplierMaxBp: basisPoints,
    multiplierStepBp: basisPoints,
    /**
     * Reserved for the data-driven effect system. V1 ships none, so an authored
     * effect is refused rather than stored inert.
     */
    secondaryEffects: z
      .array(z.unknown())
      .max(0, 'secondary effects are not supported in V1')
      .default([]),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    regionId: regionId.nullable().default(null),
    artworkPath: artworkPath.nullable().default(null),
    enabled: z.boolean().default(true),
    shopRegions: z.array(regionId).default([]),
    buyPrice: z.number().int().positive().nullable().default(null),
    priceCurrency: z.enum(PRICE_CURRENCIES).default('waifubux'),
  })
  .strict()
  .superRefine((def, ctx) => {
    // One range, for the definition's own slot: V1 gear converts SP into
    // exactly the stat its slot names, so there is no field in which to author
    // a multiplier for another slot (an old `attackBp` is an unknown field).
    // The rule is shared with the grant path, which refuses to roll from a
    // range this would reject.
    for (const issue of multiplierRangeIssues(def.slot, def)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
    }
    if (new Set(def.tags).size !== def.tags.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tags'], message: 'contains duplicates' });
    }
    if (new Set(def.shopRegions).size !== def.shopRegions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shopRegions'],
        message: 'contains duplicates',
      });
    }
    // A shelf with no price would be listed and unbuyable.
    if (def.shopRegions.length > 0 && def.buyPrice == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buyPrice'],
        message: 'is required when shopRegions is not empty',
      });
    }
  });

export type EquipmentDefinitionInput = z.infer<typeof EquipmentDefinitionInputSchema>;

function toIssues(error: z.ZodError, prefix: string): EquipmentIssue[] {
  return error.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].filter((p) => p !== '').join('.');
    // `.strict()` reports unknown keys as one issue with no path; name them.
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return {
        path: prefix,
        message: issue.keys.includes('id')
          ? 'definitions are identified by key; numeric ids are not allowed'
          : `unknown field(s): ${issue.keys.join(', ')}`,
      };
    }
    return { path, message: issue.message };
  });
}

/** Validate without throwing — for callers that collect issues across many entries. */
export function validateEquipmentDefinition(
  raw: unknown,
  pathPrefix = '',
): { ok: true; value: EquipmentDefinitionInput } | { ok: false; issues: EquipmentIssue[] } {
  const parsed = EquipmentDefinitionInputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: toIssues(parsed.error, pathPrefix) };
}

/** Validate one definition, throwing {@link EquipmentValidationError} on any problem. */
export function parseEquipmentDefinition(raw: unknown, pathPrefix = ''): EquipmentDefinitionInput {
  const result = validateEquipmentDefinition(raw, pathPrefix);
  if (!result.ok) throw new EquipmentValidationError(result.issues);
  return result.value;
}

/** The column values an input writes. `key` is included; `id` never is. */
export function definitionColumnValues(input: EquipmentDefinitionInput) {
  return {
    key: input.key,
    name: input.name,
    description: input.description,
    slot: input.slot,
    rarity: input.rarity,
    multiplierMinBp: input.multiplierMinBp,
    multiplierMaxBp: input.multiplierMaxBp,
    multiplierStepBp: input.multiplierStepBp,
    secondaryEffects: input.secondaryEffects as Record<string, unknown>[],
    tags: input.tags,
    regionId: input.regionId,
    artworkPath: input.artworkPath,
    enabled: input.enabled,
    shopRegions: input.shopRegions,
    buyPrice: input.buyPrice,
    priceCurrency: input.priceCurrency,
  };
}

/**
 * A stored row as authoring input — what an export writes and what the import
 * planner compares against. Fields the database admits but V1 authoring does
 * not (an LR rarity written by hand) pass through unchanged; re-validating the
 * result is what would surface them.
 */
export function definitionInputFromRow(row: EquipmentDefinitionRow): EquipmentDefinitionInput {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    slot: row.slot as EquipmentSlot,
    rarity: row.rarity as EquipmentDefinitionInput['rarity'],
    multiplierMinBp: row.multiplierMinBp,
    multiplierMaxBp: row.multiplierMaxBp,
    multiplierStepBp: row.multiplierStepBp,
    secondaryEffects: row.secondaryEffects,
    tags: row.tags,
    regionId: row.regionId as EquipmentDefinitionInput['regionId'],
    artworkPath: row.artworkPath,
    enabled: row.enabled,
    shopRegions: row.shopRegions as EquipmentDefinitionInput['shopRegions'],
    buyPrice: row.buyPrice,
    priceCurrency: row.priceCurrency as EquipmentDefinitionInput['priceCurrency'],
  };
}

/** Authored fields that differ between two inputs, in declaration order. */
export function changedDefinitionFields(
  before: EquipmentDefinitionInput,
  after: EquipmentDefinitionInput,
): (keyof EquipmentDefinitionInput)[] {
  const fields = Object.keys(EquipmentDefinitionInputSchema.innerType().shape) as (keyof EquipmentDefinitionInput)[];
  return fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}
