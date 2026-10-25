/** Publication evidence only. It never changes the runtime's live policy. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SpeciesRow } from "../../db/schema";
import {
  dungeonEncounterSpeciesSlugs,
  dungeonSpeciesPolicy,
  type DungeonSpeciesAccessLookup,
} from "./dungeonSpeciesPolicy";
import {
  DungeonSpeciesAccessSchema,
  type DungeonDefinition,
  type DungeonSpeciesPolicyEntry,
} from "./content/dungeonDefinition";
import {
  dungeonSpeciesUnavailableReason,
  withDungeonSpeciesPolicy,
} from "./validation/dungeonEncounterValidation";

const entrySchema = z
  .object({
    slug: z.string(),
    rarity: z.string(),
    enabled: z.boolean(),
    tags: z.array(z.string()),
    access: z.array(DungeonSpeciesAccessSchema),
  })
  .strict();
export const speciesManifestSchema = z
  .object({
    version: z.literal(1),
    hash: z.string(),
    entries: z.array(entrySchema),
  })
  .strict();
export type SpeciesManifest = z.infer<typeof speciesManifestSchema>;
export interface SpeciesRevisionStatus {
  revision: number;
  revisionId: number;
  current: boolean;
  activeRuns: number;
  evidence: "recorded" | "unknown";
  differs: boolean | null;
  dependencies: Array<{
    slug: string;
    changes: string[];
    liveRestriction: string | null;
    directRestriction: string | null;
  }>;
}
export function buildSpeciesManifest(
  definition: DungeonDefinition,
  rows: SpeciesRow[],
  access: DungeonSpeciesAccessLookup | undefined,
): SpeciesManifest | null {
  const slugs = dungeonEncounterSpeciesSlugs(definition);
  if (!slugs.length) return null;
  const entries = slugs.flatMap((slug) => {
    const row = rows.find((s) => s.slug === slug);
    return row
      ? [
          {
            slug,
            rarity: row.rarity,
            enabled: row.enabled,
            tags: row.tags
              .filter(
                (t) => t === "region_exclusive" || t === "dungeon_exclusive",
              )
              .sort(),
            access: [...(access?.(slug) ?? [])]
              .filter((a) => a.dungeon === definition.key)
              .map((a) => ({ ...a })),
          },
        ]
      : [];
  });
  return {
    version: 1,
    hash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
  };
}
/** `owned` is the dungeon's own access entries a run would be judged by now: its currently published revision's. */
export function compareSpeciesManifest(
  definition: DungeonDefinition,
  manifest: SpeciesManifest | null,
  rows: SpeciesRow[],
  access: DungeonSpeciesAccessLookup | undefined,
  owned: readonly DungeonSpeciesPolicyEntry[] = definition.speciesPolicies ?? [],
) {
  const current = buildSpeciesManifest(definition, rows, access);
  return dungeonEncounterSpeciesSlugs(definition).map((slug) => {
    const row = rows.find((s) => s.slug === slug);
    const before = manifest?.entries.find((s) => s.slug === slug);
    const now = current?.entries.find((s) => s.slug === slug);
    const changes: string[] = [];
    if (!row) changes.push("Species is missing");
    if (before && now) {
      if (before.enabled !== now.enabled)
        changes.push("Enabled status changed");
      if (before.rarity !== now.rarity)
        changes.push(`Rarity changed: ${before.rarity} → ${now.rarity}`);
      if (JSON.stringify(before.tags) !== JSON.stringify(now.tags))
        changes.push("Exclusivity changed");
      if (JSON.stringify(before.access) !== JSON.stringify(now.access))
        changes.push("Dungeon authorization or acquisition limit changed");
    }
    if (manifest && !before && row)
      changes.push("Species has no publication evidence");
    const policy = withDungeonSpeciesPolicy(dungeonSpeciesPolicy(row, access), owned, slug);
    const direct = definition.rooms.some((r) =>
      r.actions.some(
        (a) =>
          a.type === "rescue" &&
          a.mode === "direct" &&
          (a.source.kind === "species"
            ? a.source.species === slug
            : definition.speciesPools
                ?.find(
                  (p) =>
                    p.id === (a.source.kind === "pool" ? a.source.poolId : ""),
                )
                ?.entries.some((e) => "species" in e && e.species === slug)),
      ),
    );
    return {
      slug,
      changes,
      liveRestriction: dungeonSpeciesUnavailableReason(
        policy,
        definition.key,
        false,
      ),
      directRestriction: direct
        ? dungeonSpeciesUnavailableReason(policy, definition.key, true)
        : null,
    };
  });
}
