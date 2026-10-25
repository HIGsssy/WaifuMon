/** Read-only authoring facts. No player lookup, gameplay service or grant port. */
import type { SpeciesRow, ItemRow, Rarity } from "../../db/schema";
import type { LoadedContent } from "../content/schemas";
import { describeCaptureChance } from "../capture/captureMath";
import { isCaptureItemEligible } from "../capture/captureService";
import { dungeonSpeciesPolicy } from "./dungeonSpeciesPolicy";
import {
  dungeonSpeciesUnavailableReason,
  withDungeonSpeciesPolicy,
} from "./validation/dungeonEncounterValidation";
import type {
  DungeonDefinition,
  DungeonSpeciesAccess,
} from "./content/dungeonDefinition";
import type {
  DungeonEffect,
  DungeonEncounterFacts,
  DungeonRunState,
} from "./engine/types";
import { dungeonRngSource } from "./engine/seeds";

export interface EncounterAuthoringScenario {
  acquisitions?: Record<string, number> | undefined;
  disabledSpecies?: string[] | undefined;
  ownedSpecies?: string[] | undefined;
  captureOutcome?: "normal" | "success" | "failure" | undefined;
  flags?: string[] | undefined;
  completedRooms?: string[] | undefined;
}
export function authoringCaptureRng(
  seed: number,
  outcome: EncounterAuthoringScenario["captureOutcome"],
) {
  const source = dungeonRngSource(seed);
  return {
    ...source,
    stream: (...parts: (string | number)[]) => {
      if (
        parts[0] === "encounter" &&
        parts[3] === "attempt" &&
        outcome &&
        outcome !== "normal"
      ) {
        const roll = outcome === "success" ? 0 : 1 - Number.EPSILON;
        return { next: () => roll, intInclusive: (min: number) => min };
      }
      return source.stream(...parts);
    },
  };
}
export function createEncounterAuthoringFacts(input: {
  definition: DungeonDefinition;
  catalogue: {
    species: SpeciesRow[];
    items: ItemRow[];
    speciesAccess?: Record<string, readonly DungeonSpeciesAccess[]>;
  };
  content: LoadedContent;
  inventory: Record<string, number>;
  scenario?: EncounterAuthoringScenario;
}) {
  const scenario = input.scenario ?? {};
  const access = (slug: string) =>
    input.catalogue.speciesAccess
      ? input.catalogue.speciesAccess[slug]
      : input.content.species.find((s) => s.slug === slug)?.dungeonAccess;
  const diagnostics: Array<{
    species: string;
    name: string;
    available: boolean;
    reason: string | null;
    directReason: string | null;
    acquisitions: number;
    items: Array<{
      item: string;
      chance: number;
      owned: number;
      breakdown: Record<string, unknown>;
    }>;
  }> = [];
  function factsFor(
    state: DungeonRunState | null,
    effects: readonly DungeonEffect[],
  ): DungeonEncounterFacts {
    const acquisitions = { ...scenario.acquisitions };
    const inventory = { ...input.inventory };
    for (const effect of effects) {
      if (effect.type === "consume_items")
        for (const i of effect.items)
          inventory[i.item] = Math.max(
            0,
            (inventory[i.item] ?? 0) - i.quantity,
          );
      if (effect.type === "capture_attempt")
        inventory[effect.attempt.item] = Math.max(
          0,
          (inventory[effect.attempt.item] ?? 0) - 1,
        );
      if (
        effect.type === "rescue_grant" ||
        (effect.type === "capture_attempt" && effect.attempt.success)
      )
        acquisitions[effect.species] = (acquisitions[effect.species] ?? 0) + 1;
    }
    const facts: DungeonEncounterFacts = { species: {} };
    const speciesFacts: Record<
      string,
      DungeonEncounterFacts["species"][string]
    > = {};
    diagnostics.length = 0;
    for (const row of input.catalogue.species) {
      const policy = withDungeonSpeciesPolicy(
        dungeonSpeciesPolicy(
          {
            ...row,
            enabled: row.enabled && !scenario.disabledSpecies?.includes(row.slug),
          },
          access,
        ),
        input.definition.speciesPolicies,
        row.slug,
      );
      const count = acquisitions[row.slug] ?? 0;
      const reason = dungeonSpeciesUnavailableReason(
        policy,
        input.definition.key,
        false,
        count,
      );
      const direct = dungeonSpeciesUnavailableReason(
        policy,
        input.definition.key,
        true,
        count,
      );
      speciesFacts[row.slug] = {
        available: reason === null,
        ...(reason ? { reason } : {}),
        name: row.name,
        rarity: row.rarity,
        directRescue: {
          available: direct === null,
          ...(direct ? { reason: direct } : {}),
        },
      };
      diagnostics.push({
        species: row.slug,
        name: row.name,
        available: reason === null,
        reason,
        directReason: direct,
        acquisitions: count,
        items: [],
      });
    }
    facts.species = speciesFacts;
    const instance =
      state &&
      state.encounters?.[`${state.cursor.roomId}:${state.cursor.actionId}`];
    const selected =
      instance?.species &&
      input.catalogue.species.find((s) => s.slug === instance.species);
    const itemFacts: Record<
      string,
      NonNullable<DungeonEncounterFacts["items"]>[string]
    > = {};
    if (selected)
      for (const item of input.catalogue.items.filter(
        (i) => i.category === "capture",
      )) {
        const breakdown = describeCaptureChance({
          guaranteed: item.isGuaranteedCapture,
          rarity: selected.rarity as Rarity,
          baseCaptureRate: selected.baseCaptureRate,
          captureModifier: item.captureModifier,
          itemCaptureBonus: item.captureBonus ?? 0,
          config: input.content.tables.capture,
        });
        itemFacts[item.slug] = {
          owned: inventory[item.slug] ?? 0,
          eligible:
            item.enabled && isCaptureItemEligible(item, selected.rarity),
          permitted: true,
          guaranteed: item.isGuaranteedCapture,
          chance: breakdown.finalChance,
        };
        diagnostics
          .find((d) => d.species === selected.slug)!
          .items.push({
            item: item.slug,
            chance: breakdown.finalChance,
            owned: inventory[item.slug] ?? 0,
            breakdown: { ...breakdown },
          });
      }
    facts.items = itemFacts;
    return facts;
  }
  function grants(effects: readonly DungeonEffect[]) {
    const owned = new Set(scenario.ownedSpecies ?? []);
    return effects.flatMap((e) => {
      if (e.type !== "capture_attempt" && e.type !== "rescue_grant") return [];
      const success = e.type === "rescue_grant" || e.attempt.success;
      const row = input.catalogue.species.find((s) => s.slug === e.species);
      const xp = success
        ? (input.content.tables.progression.xp.captureSuccessByRarity[
            (row?.rarity ?? "N") as Rarity
          ] ?? 0) +
          (owned.has(e.species)
            ? 0
            : input.content.tables.progression.xp.newDexEntry)
        : input.content.tables.progression.xp.captureFailed;
      if (success) owned.add(e.species);
      return [
        {
          species: e.species,
          copies: success ? 1 : 0,
          xp,
          item: e.type === "capture_attempt" ? e.attempt.item : null,
          success,
        },
      ];
    });
  }
  return { factsFor, diagnostics, grants };
}
