/** Dungeon-only encounter content. Optional additions never materialise on legacy definitions. */
import { z } from 'zod';
import { SpritePlacementSchema } from '../../artworkAssets/scenePlacement';
import { DungeonKeySchema, DungeonIdSchema as id } from './dungeonIdentifiers';
import {
  DungeonConditionSchema,
  referenceKey,
  shortText,
} from './dungeonPrimitives';
import type { DungeonAction, DungeonDefinition } from './dungeonDefinition';

export const DUNGEON_ENCOUNTER_LIMITS = {
  pools: 30,
  entries: 50,
  encounters: 40,
  directRescues: 3,
  speciesPolicies: 200,
  attempts: 3,
  flags: 4,
} as const;
export const DUNGEON_ENCOUNTER_OUTCOMES = [
  'captured',
  'rescued',
  'escaped',
  'left',
  'nothing',
  'unavailable',
] as const;
export type DungeonEncounterOutcome =
  (typeof DUNGEON_ENCOUNTER_OUTCOMES)[number];
export const DungeonAcquisitionLimitSchema = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.literal('unlimited'),
]);
/** One `dungeonAccess` entry of species content; no implicit finite limit. */
export const DungeonSpeciesAccessSchema = z
  .object({
    dungeon: referenceKey,
    perPlayerLimit: DungeonAcquisitionLimitSchema.optional(),
    directRescue: z.boolean().optional(),
  })
  .strict();
export type DungeonSpeciesAccess = z.infer<typeof DungeonSpeciesAccessSchema>;
/**
 * The dungeon's own terms for one species, authored in the Dungeon Editor and
 * published with the revision. It authorizes a `dungeon_exclusive` species here
 * without species content naming the dungeon; the limit is always explicit.
 * A direct rescue's finite limit is a validation rule, so a draft can hold it.
 */
export const DungeonSpeciesPolicyEntrySchema = z
  .object({
    species: referenceKey,
    perPlayerLimit: DungeonAcquisitionLimitSchema,
    directRescue: z.boolean().optional(),
  })
  .strict();
export type DungeonSpeciesPolicyEntry = z.infer<typeof DungeonSpeciesPolicyEntrySchema>;
export const DungeonSpeciesPoolEntrySchema = z.union([
  z
    .object({
      id,
      weight: z.number().int().min(1).max(1_000_000),
      species: referenceKey,
      when: DungeonConditionSchema.optional(),
      oncePerRun: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      id,
      weight: z.number().int().min(1).max(1_000_000),
      nothing: z.literal(true),
      when: DungeonConditionSchema.optional(),
      text: shortText(200).optional(),
    })
    .strict(),
]);
export const DungeonSpeciesPoolSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(80),
    sharedPoolKey: DungeonKeySchema.optional(),
    entries: z
      .array(DungeonSpeciesPoolEntrySchema)
      .min(0)
      .max(DUNGEON_ENCOUNTER_LIMITS.entries),
  })
  .strict()
  .superRefine((pool, ctx) => {
    if (pool.sharedPoolKey ? pool.entries.length !== 0 : pool.entries.length === 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries'], message: pool.sharedPoolKey ? 'Shared references must have empty entries; embedded fallback is forbidden.' : 'A local pool needs at least one entry.' });
  });
export type DungeonSpeciesPool = z.infer<typeof DungeonSpeciesPoolSchema>;
export const DungeonSpeciesSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('species'), species: referenceKey }).strict(),
  z.object({ kind: z.literal('pool'), poolId: id }).strict(),
]);
export const DungeonCaptureRulesSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(3).default(3),
    allowedItems: z.array(referenceKey).min(1).max(100).optional(),
    allowGuaranteedItems: z.boolean().default(true),
  })
  .strict();
export const DungeonEncounterResultSchema = z
  .object({
    text: shortText(400).optional(),
    flags: z
      .array(z.object({ flag: id, value: z.boolean() }).strict())
      .max(DUNGEON_ENCOUNTER_LIMITS.flags)
      .optional(),
  })
  .strict();
export const dungeonEncounterFields = {
  source: DungeonSpeciesSourceSchema,
  intro: shortText(600),
  placement: SpritePlacementSchema.optional(),
  mirror: z.boolean().optional(),
  results: z
    .record(z.enum(DUNGEON_ENCOUNTER_OUTCOMES), DungeonEncounterResultSchema)
    .optional(),
};
export type EncounterAction = Extract<
  DungeonAction,
  { type: 'wild_encounter' | 'rescue' }
>;
export function isEncounterAction(
  action: Pick<DungeonAction, 'type'>,
): action is EncounterAction {
  return action.type === 'wild_encounter' || action.type === 'rescue';
}
export function hasDungeonEncounters(
  definition: Pick<DungeonDefinition, 'rooms' | 'speciesPools'>,
): boolean {
  return (
    definition.speciesPools !== undefined ||
    definition.rooms.some((r) => r.actions.some(isEncounterAction))
  );
}
export function encounterSpecies(
  definition: DungeonDefinition,
  action: EncounterAction,
): string[] {
  if (action.source.kind === 'species') return [action.source.species];
  return (
    definition.speciesPools
      ?.find(
        (p) =>
          p.id === (action.source.kind === 'pool' ? action.source.poolId : ''),
      )
      ?.entries.flatMap((e) => ('species' in e ? [e.species] : [])) ?? []
  );
}
