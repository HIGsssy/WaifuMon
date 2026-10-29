/** Pure shared-pool format and resolution; membership grants no acquisition rights. */
import { z } from "zod";
import { DungeonKeySchema } from "../content/dungeonIdentifiers";
import {
  DungeonSpeciesPoolEntrySchema,
  type DungeonSpeciesPool,
} from "../content/dungeonEncounters";
import type { DungeonDefinition } from "../content/dungeonDefinition";

export const SharedPoolDefinitionSchema = z
  .object({
    key: DungeonKeySchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().max(600).default(""),
    enabled: z.boolean(),
    entries: z.array(DungeonSpeciesPoolEntrySchema).min(1).max(50),
  })
  .strict()
  .superRefine((pool, ctx) => {
    const ids = new Set<string>(),
      slugs = new Set<string>();
    pool.entries.forEach((e, i) => {
      if (ids.has(e.id))
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "id"],
          message: "Duplicate entry ID.",
        });
      ids.add(e.id);
      if ("species" in e) {
        if (slugs.has(e.species))
          ctx.addIssue({
            code: "custom",
            path: ["entries", i, "species"],
            message: "Duplicate species.",
          });
        slugs.add(e.species);
      }
    });
    if (!slugs.size)
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "At least one species is required.",
      });
  });
export type SharedPoolDefinition = z.infer<typeof SharedPoolDefinitionSchema>;
export const SharedPoolPackageSchema = z
  .object({
    format: z.literal("waifumon-dungeon-species-pools"),
    schemaVersion: z.literal(1),
    pools: z.array(SharedPoolDefinitionSchema).max(200),
  })
  .strict()
  .superRefine((pkg, ctx) => {
    if (new Set(pkg.pools.map((p) => p.key)).size !== pkg.pools.length)
      ctx.addIssue({
        code: "custom",
        path: ["pools"],
        message: "Duplicate pool keys.",
      });
  });
export type SharedPoolCatalogue = ReadonlyMap<string, SharedPoolDefinition>;
export type FrozenSharedPools = Record<
  string,
  { revision: number; definition: SharedPoolDefinition }
>;
export function sharedPoolKeys(
  definition: Pick<DungeonDefinition, "speciesPools">,
): string[] {
  return [
    ...new Set(
      definition.speciesPools?.flatMap((p) =>
        p.sharedPoolKey ? [p.sharedPoolKey] : [],
      ) ?? [],
    ),
  ].sort();
}
/** Pure, copies bodies; absent/disabled dependencies stay empty and are reported by validation. */
export function resolveSharedPools(
  definition: DungeonDefinition,
  catalogue: SharedPoolCatalogue,
): DungeonDefinition {
  if (!sharedPoolKeys(definition).length) return definition;
  return {
    ...definition,
    speciesPools: definition.speciesPools?.map((pool) => {
      if (!pool.sharedPoolKey) return pool;
      const shared = catalogue.get(pool.sharedPoolKey);
      const { sharedPoolKey: _key, ...local } = pool;
      return {
        ...local,
        entries: shared?.enabled ? structuredClone(shared.entries) : [],
      } satisfies DungeonSpeciesPool;
    }),
  };
}
