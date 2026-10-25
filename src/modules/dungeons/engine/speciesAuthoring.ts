/** Authoring only: runtime selection odds with live policy annotations, never a filtered draw. */
import type {
  DungeonDefinition,
  DungeonSpeciesAccess,
  DungeonSpeciesPolicyEntry,
  DungeonSpeciesPool,
} from "../content/dungeonDefinition";
import {
  dungeonSpeciesUnavailableReason,
  withDungeonSpeciesPolicy,
  type DungeonSpeciesPolicy,
} from "../validation/dungeonEncounterValidation";
import type { DungeonEncounterUnavailableReason } from "./types";
import { analyseSpeciesPool } from "./encounters";
import type { ConditionFacts } from "./conditions";

export interface SpeciesAuthoringScenario {
  flags: string[];
  completedRooms: string[];
  seenSpecies: string[];
  /** Simulated ledger counts, scoped to this dungeon across runs, never ownership counts. */
  acquisitions: Record<string, number>;
}
export interface DungeonAuthoringSpecies {
  slug: string;
  name: string;
  rarity: string;
  archetype: string;
  affinity: string;
  enabled: boolean;
  regionExclusive: boolean;
  dungeonExclusive: boolean;
  dungeonAccess: readonly DungeonSpeciesAccess[];
  /** Judged by species content alone; the dungeon's own Species access is applied per definition. */
  permitted: boolean;
  unavailableReason: DungeonEncounterUnavailableReason | null;
  /** Whether this dungeon's own Species access can admit her (enabled, not region-exclusive). */
  dungeonPolicyAllowed: boolean;
  /** null means no explicit capture limit (unlimited). */
  perPlayerLimit: number | "unlimited" | null;
  directRescue: {
    available: boolean;
    reason: DungeonEncounterUnavailableReason | null;
  };
}
function policyOf(
  species: DungeonAuthoringSpecies | undefined,
  owned: readonly DungeonSpeciesPolicyEntry[] | undefined,
): DungeonSpeciesPolicy | undefined {
  return withDungeonSpeciesPolicy(
    species && {
      enabled: species.enabled,
      restricted: species.regionExclusive || species.dungeonExclusive,
      ...(species.regionExclusive ? { regionExclusive: true } : {}),
      access: species.dungeonAccess,
    },
    owned,
    species?.slug ?? "",
  );
}
export function describeSpeciesAuthoring(
  definition: Pick<DungeonDefinition, "key" | "speciesPools" | "speciesPolicies">,
  catalogue: readonly DungeonAuthoringSpecies[],
  scenario: SpeciesAuthoringScenario = {
    flags: [],
    completedRooms: [],
    seenSpecies: [],
    acquisitions: {},
  },
) {
  const bySlug = new Map(catalogue.map((s) => [s.slug, s]));
  const facts: ConditionFacts = {
    flags: Object.fromEntries(scenario.flags.map((f) => [f, true])),
    playerFlags: {},
    rooms: Object.fromEntries(
      scenario.completedRooms.map((r) => [
        r,
        { visits: 1, completed: true, resumeAt: null, actions: {} },
      ]),
    ),
  };
  function annotate(
    analysis: ReturnType<typeof analyseSpeciesPool>,
    acquisitions: Record<string, number>,
  ) {
    const rarityDistribution: Record<string, number> = {};
    const obtainableRarityDistribution: Record<string, number> = {};
    let unavailableProbability = 0;
    const entries = analysis.entries.map((entry) => {
      const species =
        entry.species === null ? undefined : bySlug.get(entry.species);
      const unavailableReason =
        entry.species === null
          ? null
          : dungeonSpeciesUnavailableReason(
              policyOf(species, definition.speciesPolicies),
              definition.key,
              false,
              acquisitions[entry.species] ?? 0,
            );
      if (entry.species !== null && entry.eligible) {
        const rarity = species?.rarity ?? "Unknown";
        rarityDistribution[rarity] =
          (rarityDistribution[rarity] ?? 0) + entry.probability;
        if (unavailableReason) unavailableProbability += entry.probability;
        else
          obtainableRarityDistribution[rarity] =
            (obtainableRarityDistribution[rarity] ?? 0) + entry.probability;
      }
      return { ...entry, rarity: species?.rarity ?? null, unavailableReason };
    });
    return {
      ...analysis,
      entries,
      unavailableProbability,
      rarityDistribution,
      obtainableRarityDistribution,
    };
  }
  return {
    speciesPools: (definition.speciesPools ?? []).map((pool) => {
      const base: DungeonSpeciesPool = {
        ...pool,
        entries: pool.entries.map(({ when: _when, ...e }) => e),
      };
      return {
        poolId: pool.id,
        base: annotate(
          analyseSpeciesPool(base, { flags: {}, playerFlags: {}, rooms: {} }),
          {},
        ),
        scenario: annotate(
          analyseSpeciesPool(pool, facts, new Set(scenario.seenSpecies)),
          scenario.acquisitions,
        ),
      };
    }),
  };
}
