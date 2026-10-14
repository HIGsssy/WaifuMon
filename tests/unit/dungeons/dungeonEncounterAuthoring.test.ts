import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ItemRow, SpeciesRow } from "../../../src/db/schema";
import { readContentFiles } from "../../../src/modules/content/loader";
import { describeCaptureChance } from "../../../src/modules/capture/captureMath";
import { DungeonDefinitionSchema } from "../../../src/modules/dungeons/content/dungeonDefinition";
import {
  createEncounterAuthoringFacts,
  authoringCaptureRng,
} from "../../../src/modules/dungeons/dungeonEncounterAuthoring";
import {
  buildSpeciesManifest,
  compareSpeciesManifest,
} from "../../../src/modules/dungeons/dungeonSpeciesManifest";
import { createDungeonSandbox } from "../../../src/modules/dungeons/engine/sandbox";
import { dungeonRngSource } from "../../../src/modules/dungeons/engine/seeds";
const content = readContentFiles(path.resolve("content"));
const row = {
  slug: "test",
  name: "Test WaifuMon",
  enabled: true,
  rarity: "N",
  tags: [],
  baseCaptureRate: null,
} as unknown as SpeciesRow;
const item = {
  slug: "basic_charm",
  name: "Basic Charm",
  enabled: true,
  category: "capture",
  captureRarities: null,
  captureModifier: 1,
  captureBonus: 0,
  isGuaranteedCapture: false,
} as unknown as ItemRow;
function definition(mode: "wild" | "direct" = "wild") {
  return DungeonDefinitionSchema.parse({
    key: "authoring",
    name: "Authoring",
    availableRegions: ["waifu-valley"],
    entranceRoomId: "start",
    rooms: [
      {
        id: "start",
        actions: [
          {
            id: "wild",
            type: mode === "wild" ? "wild_encounter" : "rescue",
            ...(mode === "direct"
              ? { mode: "direct" }
              : { capture: { maxAttempts: 2 } }),
            source: { kind: "species", species: "test" },
            intro: "",
          },
          { id: "later", type: "rest", healBasisPoints: 0 },
        ],
      },
    ],
    connections: [],
  });
}
function authoring(scenario = {}, mode: "wild" | "direct" = "wild") {
  const d = definition(mode);
  const facts = createEncounterAuthoringFacts({
    definition: d,
    catalogue: {
      species: [row],
      items: [item],
      speciesAccess: {
        test: [{ dungeon: "authoring", perPlayerLimit: 1, directRescue: true }],
      },
    },
    content,
    inventory: { basic_charm: 2 },
    scenario,
  });
  const sandbox = createDungeonSandbox({
    definition: d,
    dependencies: { enemies: {}, rewardTables: {} },
    fighter: {
      waifuId: 0,
      name: "Simulated Buddy",
      attack: 60,
      defense: 30,
      maxHp: 400,
    },
    seed: 123,
    encounterFactsFor: facts.factsFor,
    rng: authoringCaptureRng(
      123,
      "captureOutcome" in scenario
        ? (scenario.captureOutcome as "success" | "failure")
        : "normal",
    ),
  });
  return { sandbox, facts };
}
describe("read-only encounter authoring adapters", () => {
  it("normal RNG matches production streams and forced outcomes touch only attempt rolls", () => {
    for (const mode of ["normal", "success", "failure"] as const) {
      const rng = authoringCaptureRng(123, mode);
      for (const parts of [
        ["encounter", "room", "act", "pool"],
        ["encounter", "room", "act", "sp"],
        ["combat", "room", "act"],
      ] as const)
        expect(rng.stream(...parts).next()).toBe(
          dungeonRngSource(123)
            .stream(...parts)
            .next(),
        );
    }
    expect(
      authoringCaptureRng(123, "success")
        .stream("encounter", "room", "act", "attempt", 1)
        .next(),
    ).toBe(0);
    expect(
      authoringCaptureRng(123, "failure")
        .stream("encounter", "room", "act", "attempt", 1)
        .next(),
    ).toBeGreaterThan(0.99);
  });
  it("quotes the existing formula using simulated inventory and neutral Buddy modifiers", () => {
    const { sandbox, facts } = authoring();
    expect(sandbox.view.action?.encounter?.items[0]?.chance).toBe(
      describeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: "N",
        captureModifier: 1,
        itemCaptureBonus: 0,
        config: content.tables.capture,
      }).finalChance,
    );
    expect(facts.diagnostics[0]?.items[0]?.breakdown).toMatchObject({
      affinityModifier: 0,
      playerCaptureModifier: 0,
      buddyGlobalModifier: 0,
      buddyConditionalModifier: 0,
    });
  });
  it("simulates failure spends and XP while leaving inventory input and species rows unchanged", async () => {
    const { sandbox, facts } = authoring({ captureOutcome: "failure" });
    await sandbox.input({ type: "select_item", item: "basic_charm" });
    await sandbox.input({ type: "capture" });
    expect(sandbox.view.action?.encounter?.items[0]?.owned).toBe(1);
    expect(facts.grants(sandbox.effects)).toEqual([
      {
        species: "test",
        copies: 0,
        xp: content.tables.progression.xp.captureFailed,
        item: "basic_charm",
        success: false,
      },
    ]);
    expect(row.enabled).toBe(true);
  });
  it("direct rescue simulates ownership and XP and rechecks the cross-run limit", async () => {
    const { sandbox, facts } = authoring({}, "direct");
    await sandbox.input({ type: "rescue" });
    expect(facts.grants(sandbox.effects)[0]).toMatchObject({
      species: "test",
      copies: 1,
      item: null,
    });
    expect(
      facts.factsFor(sandbox.state, sandbox.effects).species.test,
    ).toMatchObject({ available: false, reason: "player_limit" });
  });
  it("simulated ownership removes only new-dex XP and never changes policy limits", async () => {
    const first = authoring({ captureOutcome: "success" });
    const duplicate = authoring({
      captureOutcome: "success",
      ownedSpecies: ["test"],
    });
    for (const a of [first, duplicate]) {
      await a.sandbox.input({ type: "select_item", item: "basic_charm" });
      await a.sandbox.input({ type: "capture" });
    }
    expect(
      first.facts.grants(first.sandbox.effects)[0]!.xp -
        duplicate.facts.grants(duplicate.sandbox.effects)[0]!.xp,
    ).toBe(content.tables.progression.xp.newDexEntry);
  });
  it("records independent publication evidence and reports rarity, availability, exclusivity and limit drift", () => {
    const d = definition();
    const access = [
      { dungeon: "authoring", perPlayerLimit: 1, directRescue: true },
    ];
    const manifest = buildSpeciesManifest(d, [row], () => access)!;
    access[0]!.perPlayerLimit = 2;
    expect(manifest.entries[0]!.access[0]!.perPlayerLimit).toBe(1);
    const drift = compareSpeciesManifest(
      d,
      manifest,
      [{ ...row, rarity: "UR", enabled: false, tags: ["dungeon_exclusive"] }],
      () => access,
    )[0]!;
    expect(drift.changes).toHaveLength(4);
    expect(drift.liveRestriction).toBe("disabled");
    expect(
      compareSpeciesManifest(d, manifest, [], () => access)[0]!.changes,
    ).toEqual(["Species is missing"]);
  });
  it("unknown legacy evidence is never reported as a historical comparison and unused pools are not dependencies", () => {
    const d = definition();
    d.speciesPools = [
      {
        id: "unused",
        name: "Unused",
        entries: [
          { id: "extra", species: "other", weight: 1, oncePerRun: true },
        ],
      },
    ];
    expect(
      buildSpeciesManifest(d, [row], undefined)!.entries.map((e) => e.slug),
    ).toEqual(["test"]);
    expect(
      compareSpeciesManifest(d, null, [row], undefined)[0]!.changes,
    ).toEqual([]);
    d.rooms[0]!.actions = [];
    expect(buildSpeciesManifest(d, [row], undefined)).toBeNull();
  });
});
