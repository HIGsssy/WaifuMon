import { describe, it, expect } from "vitest";
import {
  SharedPoolDefinitionSchema,
  SharedPoolPackageSchema,
  resolveSharedPools,
} from "../../../src/modules/dungeons/sharedPools/sharedPoolDefinition";
import { DungeonDefinitionSchema } from "../../../src/modules/dungeons/content/dungeonDefinition";
import { analyseSpeciesPool } from "../../../src/modules/dungeons/engine/encounters";
import { singleRoomDungeon } from "../../helpers/dungeonFixtures";

const shared = SharedPoolDefinitionSchema.parse({
  key: "shared",
  name: "Shared",
  description: "Test",
  enabled: true,
  entries: [
    { id: "s", species: "neko_barista", weight: 3 },
    { id: "nothing", nothing: true, weight: 1, text: "Empty." },
  ],
});
const ref = {
  id: "p",
  name: "Reference",
  sharedPoolKey: shared.key,
  entries: [],
};
const definition = () =>
  singleRoomDungeon([], (d) => {
    d.speciesPools = [structuredClone(ref)];
  });
describe("shared pool format and existing weighted semantics", () => {
  it("keeps references portable and forbids a hidden embedded fallback", () => {
    const d = definition();
    expect(DungeonDefinitionSchema.parse(d).speciesPools).toEqual([ref]);
    expect(
      DungeonDefinitionSchema.safeParse({
        ...d,
        speciesPools: [{ ...ref, entries: shared.entries }],
      }).success,
    ).toBe(false);
    const resolved = resolveSharedPools(d, new Map([["shared", shared]]));
    expect(d.speciesPools).toEqual([ref]);
    expect(resolved.speciesPools![0]!.sharedPoolKey).toBeUndefined();
    expect(resolved.speciesPools![0]!.entries).toEqual(shared.entries);
    resolved.speciesPools![0]!.entries[0]!.weight = 99;
    expect(shared.entries[0]!.weight).toBe(3);
  });
  it("uses the existing integer weights, Nothing outcome and once-per-run exclusions", () => {
    const pool = resolveSharedPools(definition(), new Map([["shared", shared]]))
      .speciesPools![0]!;
    const facts = { flags: {}, playerFlags: {}, rooms: {} };
    expect(analyseSpeciesPool(pool, facts)).toMatchObject({
      totalWeight: 4,
      nothingProbability: 0.25,
      entries: [{ probability: 0.75 }, { probability: 0.25 }],
    });
    expect(
      analyseSpeciesPool(pool, facts, new Set(["neko_barista"])),
    ).toMatchObject({
      totalWeight: 1,
      nothingProbability: 1,
      entries: [
        { eligible: false, reason: "already_seen" },
        { probability: 1 },
      ],
    });
  });
  it("cannot substitute a disabled/missing dependency, and rejects duplicate keys, species, IDs, invalid weights and environment IDs", () => {
    expect(
      resolveSharedPools(definition(), new Map()).speciesPools![0]!.entries,
    ).toEqual([]);
    expect(
      resolveSharedPools(
        definition(),
        new Map([["shared", { ...shared, enabled: false }]]),
      ).speciesPools![0]!.entries,
    ).toEqual([]);
    for (const entries of [
      [],
      [shared.entries[1]],
      [shared.entries[0], shared.entries[0]],
      [{ ...shared.entries[0], weight: 0 }],
      [{ ...shared.entries[0], weight: 1.5 }],
    ])
      expect(
        SharedPoolDefinitionSchema.safeParse({ ...shared, entries }).success,
      ).toBe(false);
    expect(
      SharedPoolDefinitionSchema.safeParse({ ...shared, id: 42 }).success,
    ).toBe(false);
    expect(
      SharedPoolPackageSchema.safeParse({
        format: "waifumon-dungeon-species-pools",
        schemaVersion: 1,
        pools: [shared, shared],
      }).success,
    ).toBe(false);
  });
});
