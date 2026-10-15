/** V4 dependency evidence, never imported global definitions or runtime policy. */
import { z } from 'zod';
import {
  DungeonSpeciesAccessSchema,
  encounterSpecies,
  isEncounterAction,
  type DungeonDefinition,
} from '../content/dungeonDefinition';
import { validateDungeonDefinition } from '../validation/dungeonValidation';

export const PackageSpeciesEvidenceSchema = z
  .object({
    slug: z.string().trim().min(1).max(100),
    rarity: z.enum(['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX']),
    enabled: z.boolean(),
    regionExclusive: z.boolean(),
    dungeonExclusive: z.boolean(),
    dungeonAccess: z.array(DungeonSpeciesAccessSchema).max(2000),
  })
  .strict();
export const PackageRequiredSpeciesSchema = PackageSpeciesEvidenceSchema.extend({
  modes: z
    .array(z.enum(['capture', 'direct']))
    .min(1)
    .max(2),
});
export type PackageSpeciesEvidence = z.infer<typeof PackageSpeciesEvidenceSchema>;
export type PackageRequiredSpecies = z.infer<typeof PackageRequiredSpeciesSchema>;

/** Reuse the validator's potential room/sequence reachability; don't guess dynamic conditions. */
export function reachableEncounterActions(definition: DungeonDefinition) {
  const inaccessible = new Set(
    validateDungeonDefinition(definition)
      .issues.filter((i) => i.code === 'room_unreachable' || i.code === 'action_unreachable')
      .map((i) => i.path),
  );
  return definition.rooms.flatMap((room, r) =>
    inaccessible.has(`rooms[${r}]`)
      ? []
      : room.actions.flatMap((action, a) =>
          isEncounterAction(action) && !inaccessible.has(`rooms[${r}].actions[${a}]`) ? [action] : [],
        ),
  );
}
export function encounterDependencyRequirements(definition: DungeonDefinition) {
  const species = new Map<string, Set<'capture' | 'direct'>>();
  const captureItems = new Set<string>();
  for (const action of reachableEncounterActions(definition)) {
    const mode = action.type === 'rescue' && action.mode === 'direct' ? 'direct' : 'capture';
    for (const slug of encounterSpecies(definition, action)) {
      const modes = species.get(slug) ?? new Set();
      modes.add(mode);
      species.set(slug, modes);
    }
    if (mode === 'capture') for (const slug of action.capture?.allowedItems ?? []) captureItems.add(slug);
  }
  return {
    species: [...species]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([slug, modes]) => ({ slug, modes: [...modes].sort() })),
    captureItems: [...captureItems].sort(),
  };
}
export function packageRequiredSpecies(
  definition: DungeonDefinition,
  catalogue: ReadonlyMap<string, PackageSpeciesEvidence> | undefined,
): PackageRequiredSpecies[] {
  return encounterDependencyRequirements(definition).species.map(({ slug, modes }) => {
    const row = catalogue?.get(slug);
    if (!row) throw new Error(`Cannot export encounter species "${slug}": source catalogue evidence is missing.`);
    const evidence = PackageSpeciesEvidenceSchema.parse(row);
    if (evidence.slug !== slug) throw new Error(`Species catalogue evidence does not match "${slug}".`);
    return {
      ...evidence,
      dungeonAccess: [...evidence.dungeonAccess].sort((a, b) =>
        a.dungeon < b.dungeon ? -1 : a.dungeon > b.dungeon ? 1 : 0,
      ),
      modes,
    };
  });
}
