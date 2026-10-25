import { describe, expect, it } from "vitest";
import {
  describeSpeciesAuthoring,
  type DungeonAuthoringSpecies,
} from "../../../src/modules/dungeons/engine/speciesAuthoring";
import { analyseSpeciesPool } from "../../../src/modules/dungeons/engine/encounters";
import type { DungeonSpeciesPool } from "../../../src/modules/dungeons/content/dungeonDefinition";
import type { DungeonSpeciesPoolAnalysis } from "../../../portal/src/api/dungeonSpeciesTypes";
const species = (
  slug: string,
  override: Partial<DungeonAuthoringSpecies> = {},
): DungeonAuthoringSpecies => ({
  slug,
  name: slug,
  rarity: "N",
  archetype: "human",
  affinity: "switch",
  enabled: true,
  regionExclusive: false,
  dungeonExclusive: false,
  permitted: true,
  unavailableReason: null,
  dungeonPolicyAllowed: true,
  dungeonAccess: [],
  perPlayerLimit: null,
  directRescue: { available: false, reason: "direct_not_permitted" },
  ...override,
});
const pool: DungeonSpeciesPool = {
  id: "pool",
  name: "Pool",
  entries: [
    { id: "one", species: "one", weight: 3, oncePerRun: true },
    {
      id: "rare",
      species: "rare",
      weight: 2,
      oncePerRun: false,
      when: { type: "flag", flag: "open", scope: "run", equals: true },
    },
    { id: "none", nothing: true, weight: 1 },
  ],
};
const catalogue = [
  species("one", { dungeonAccess: [{ dungeon: "test", perPlayerLimit: 1 }] }),
  species("rare", { rarity: "UR" }),
];
describe("species pool authoring uses runtime analysis", () => {
  it("returns wire-compatible odds, Nothing and rarity mix, with base rules stripped", () => {
    const views: DungeonSpeciesPoolAnalysis[] = describeSpeciesAuthoring(
      { key: "test", speciesPools: [pool] },
      catalogue,
    ).speciesPools;
    expect(views[0]!.base.entries.map((e) => e.probability)).toEqual([
      0.5,
      1 / 3,
      1 / 6,
    ]);
    expect(views[0]!.scenario.entries.map((e) => e.probability)).toEqual([
      0.75, 0, 0.25,
    ]);
    expect(views[0]!.scenario.rarityDistribution).toEqual({ N: 0.75 });
    expect(views[0]!.scenario.nothingProbability).toBe(0.25);
  });
  it("applies run flags, completed rooms and seen species with the runtime function", () => {
    const p = {
      ...pool,
      entries: pool.entries.map((e) =>
        e.id === "none"
          ? { ...e, when: { type: "room_completed" as const, roomId: "vault" } }
          : e,
      ),
    };
    const scenario = {
      flags: ["open"],
      completedRooms: ["vault"],
      seenSpecies: ["one"],
      acquisitions: {},
    };
    const got = describeSpeciesAuthoring(
      { key: "test", speciesPools: [p] },
      catalogue,
      scenario,
    ).speciesPools[0]!.scenario;
    const runtime = analyseSpeciesPool(
      p,
      {
        flags: { open: true },
        playerFlags: {},
        rooms: {
          vault: { visits: 1, completed: true, resumeAt: null, actions: {} },
        },
      },
      new Set(["one"]),
    );
    expect(
      got.entries.map(({ rarity: _r, unavailableReason: _u, ...e }) => e),
    ).toEqual(runtime.entries);
    expect(got.nothingProbability).toBe(runtime.nothingProbability);
    expect(got.entries[0]).toMatchObject({
      eligible: false,
      reason: "already_seen",
    });
  });
  it("keeps limits, disabled, missing and restricted weights; annotates unavailable probability", () => {
    const p: DungeonSpeciesPool = {
      id: "p",
      name: "P",
      entries: ["one", "disabled", "missing", "restricted"].map(
        (species, i) => ({ id: `e${i}`, species, weight: 1, oncePerRun: true }),
      ),
    };
    const got = describeSpeciesAuthoring(
      { key: "test", speciesPools: [p] },
      [
        ...catalogue,
        species("disabled", { enabled: false }),
        species("restricted", { regionExclusive: true }),
      ],
      {
        flags: [],
        completedRooms: [],
        seenSpecies: [],
        acquisitions: { one: 1 },
      },
    ).speciesPools[0]!;
    expect(got.scenario.entries.map((e) => e.probability)).toEqual([
      0.25, 0.25, 0.25, 0.25,
    ]);
    expect(got.scenario.entries.map((e) => e.unavailableReason)).toEqual([
      "player_limit",
      "disabled",
      "missing",
      "not_permitted",
    ]);
    expect(got.scenario.unavailableProbability).toBe(1);
    expect(got.scenario.obtainableRarityDistribution).toEqual({});
    expect(got.base.entries[0]!.unavailableReason).toBeNull();
  });
  it("omitted and explicit unlimited limits remain available for arbitrarily large simulated counts", () => {
    const c = [
      species("one"),
      species("rare", {
        dungeonAccess: [{ dungeon: "test", perPlayerLimit: "unlimited" }],
      }),
    ];
    const got = describeSpeciesAuthoring(
      { key: "test", speciesPools: [pool] },
      c,
      {
        flags: ["open"],
        completedRooms: [],
        seenSpecies: [],
        acquisitions: { one: 1000, rare: 1000 },
      },
    );
    expect(got.speciesPools[0]!.scenario.unavailableProbability).toBe(0);
  });
  it("empty eligibility becomes Nothing with probability one; legacy definitions have no pools", () => {
    const p: DungeonSpeciesPool = {
      id: "p",
      name: "P",
      entries: [pool.entries[0]!],
    };
    expect(
      describeSpeciesAuthoring({ key: "test", speciesPools: [p] }, catalogue, {
        flags: [],
        completedRooms: [],
        seenSpecies: ["one"],
        acquisitions: {},
      }).speciesPools[0]!.scenario,
    ).toMatchObject({
      totalWeight: 0,
      nothingProbability: 1,
      entries: [{ probability: 0 }],
    });
    expect(describeSpeciesAuthoring({ key: "test" }, [])).toEqual({
      speciesPools: [],
    });
  });
});
