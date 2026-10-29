import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  dungeonDefinitions,
  dungeonRevisions,
  dungeonRuns,
  dungeonSpeciesPoolEvents,
  dungeonSpeciesPools,
  regionEncounterPools,
  species,
} from "../../src/db/schema";
import {
  createSharedDungeonPoolService,
  withFrozenSharedPools,
} from "../../src/modules/dungeons/sharedPools/sharedPoolService";
import type { SharedPoolDefinition } from "../../src/modules/dungeons/sharedPools/sharedPoolDefinition";
import type { DungeonRunView } from "../../src/modules/dungeons/dungeonRunService";
import { singleRoomDungeon } from "../helpers/dungeonFixtures";
import { createDungeonWorld, type DungeonWorld } from "../helpers/dungeonWorld";
import { getItemBySlug } from "../helpers/fixtures";

let w: DungeonWorld, pools: ReturnType<typeof createSharedDungeonPoolService>;
const body = (key: string, slug = "neko_barista"): SharedPoolDefinition => ({
  key,
  name: key,
  description: "Shared test pool",
  enabled: true,
  entries: [{ id: "species", species: slug, weight: 3, oncePerRun: true }],
});
function dungeon(key: string, sharedPoolKey: string) {
  return singleRoomDungeon(
    [
      { id: "wait", type: "rest", optional: true, healBasisPoints: 100 },
      {
        id: "meet",
        type: "wild_encounter",
        source: { kind: "pool", poolId: "p" },
        intro: "Hello.",
        capture: {},
      } as never,
    ],
    (d) => {
      d.key = key;
      d.speciesPools = [
        { id: "p", name: "Shared", sharedPoolKey, entries: [] },
      ];
    },
  );
}
const offered = (run: DungeonRunView) => run.core.action?.encounter;
const meet = async (playerId: number, run: DungeonRunView) =>
  (await w.act(playerId, run, { type: "decline", expectedStep: run.step })).run;
beforeAll(async () => {
  w = await createDungeonWorld();
  pools = createSharedDungeonPoolService(w.t.db);
});
afterAll(async () => {
  await w?.cleanup();
});

describe("shared Dungeon WaifuMon pools", () => {
  it("CRUD validates species/weights, guards revisions, duplicates disabled and audits without deletion", async () => {
    const created = await pools.create(body("crud_pool"), "author");
    expect(created.revision).toBe(1);
    await expect(
      pools.create(body("crud_pool"), "author"),
    ).rejects.toMatchObject({ code: "DUNGEON_KEY_TAKEN" });
    await expect(
      pools.create(body("missing_species_pool", "no_such_species"), null),
    ).rejects.toMatchObject({ code: "DUNGEON_INVALID" });
    await expect(
      pools.update(
        "crud_pool",
        {
          ...created.definition,
          entries: [{ id: "bad", species: "neko_barista", weight: 0 }],
        },
        1,
        null,
      ),
    ).rejects.toMatchObject({ code: "DUNGEON_INVALID" });
    const updated = await pools.update(
      "crud_pool",
      { ...created.definition, name: "Updated" },
      1,
      "editor",
    );
    expect(updated.revision).toBe(2);
    await expect(
      pools.update("crud_pool", created.definition, 1, null),
    ).rejects.toMatchObject({
      code: "DUNGEON_DRAFT_STALE",
      currentRevision: 2,
    });
    const races = await Promise.allSettled(
      ["A", "B"].map((name) =>
        pools.update("crud_pool", { ...updated.definition, name }, 2, null),
      ),
    );
    expect(races.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await pools.duplicate("crud_pool", "crud_copy", 3, "copy")).definition
        .enabled,
    ).toBe(false);
    expect(
      (await pools.setEnabled("crud_pool", false, 3, "editor")).revision,
    ).toBe(4);
    expect(await pools.list("crud_pool")).toHaveLength(1);
    expect((await pools.history("crud_pool")).map((e) => e.action)).toEqual([
      "created",
      "updated",
      "updated",
      "disabled",
    ]);
  });

  it("two dungeons resolve the same current pool; active runs and revisions survive edits, disable and restart", async () => {
    await pools.create(body("lifecycle_pool"), "author");
    const a = dungeon("shared_a", "lifecycle_pool"),
      b = dungeon("shared_b", "lifecycle_pool");
    await w.publish(a);
    await w.publish(b);
    expect(
      (await pools.references("lifecycle_pool")).map(
        (r) => `${r.dungeonKey}:${r.source}`,
      ),
    ).toEqual([
      "shared_a:draft",
      "shared_a:published",
      "shared_b:draft",
      "shared_b:published",
    ]);
    const revisionsBefore = await w.t.db.select().from(dungeonRevisions);
    const definitionsBefore = await w.t.db.select().from(dungeonDefinitions);
    const p1 = await w.player(),
      p2 = await w.player();
    const old = await w.runs.start(p1.playerId, a.key);
    const [savedBefore] = await w.t.db
      .select()
      .from(dungeonRuns)
      .where(eq(dungeonRuns.id, old.id));
    await pools.update(
      "lifecycle_pool",
      body("lifecycle_pool", "gym_oni"),
      1,
      "editor",
    );
    expect(
      (
        await w.t.db
          .select()
          .from(dungeonRuns)
          .where(eq(dungeonRuns.id, old.id))
      )[0],
    ).toEqual(savedBefore);
    const newer = await w.runs.start(p2.playerId, b.key);
    const newOffer = await meet(p2.playerId, newer);
    expect(offered(newOffer)?.species).toBe("gym_oni");
    await pools.setEnabled("lifecycle_pool", false, 2, "editor");
    // Reload from the database through a fresh service after the edit and disable.
    const resumed = await w.restartedRuns().run(p1.playerId, old.id);
    const oldOffer = await meet(p1.playerId, resumed);
    expect(offered(oldOffer)?.species).toBe("neko_barista");
    expect(await w.t.db.select().from(dungeonRevisions)).toEqual(
      revisionsBefore,
    );
    expect(await w.t.db.select().from(dungeonDefinitions)).toEqual(
      definitionsBefore,
    );
    const p3 = await w.player();
    await expect(w.runs.start(p3.playerId, a.key)).rejects.toMatchObject({
      code: "DUNGEON_INVALID",
    });
    expect(
      (await w.content.validate(a)).issues.some((i) =>
        i.message.includes("disabled"),
      ),
    ).toBe(true);
    expect(() => withFrozenSharedPools(a, {})).toThrow(/snapshot/);
  });

  it("local pools still work; missing or incompatible shared dependencies fail without fallback", async () => {
    const local = dungeon("local_pool_dungeon", "absent");
    local.speciesPools = [
      {
        id: "p",
        name: "Local",
        entries: [
          { id: "local", species: "neko_barista", weight: 1, oncePerRun: true },
        ],
      },
    ];
    await w.publish(local);
    const player = await w.player();
    expect(
      offered(
        await meet(
          player.playerId,
          await w.runs.start(player.playerId, local.key),
        ),
      )?.species,
    ).toBe("neko_barista");
    const missing = dungeon("missing_pool_dungeon", "absent");
    expect((await w.content.validate(missing)).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "speciesPools[0].sharedPoolKey",
          severity: "error",
        }),
      ]),
    );
    const conditional = body("incompatible_pool");
    conditional.entries[0]!.when = {
      type: "room_completed",
      roomId: "missing_room",
    };
    await pools.create(conditional, null);
    expect(
      (
        await w.content.validate(
          dungeon("incompatible_dungeon", conditional.key),
        )
      ).issues.some((i) => i.code === "condition_unknown_room"),
    ).toBe(true);
  });

  it("pool membership never grants dungeon-exclusive acquisition and the existing per-dungeon limit remains live", async () => {
    const [sp] = await w.t.db
      .select()
      .from(species)
      .where(eq(species.slug, "gym_oni"));
    await w.t.db
      .update(species)
      .set({ tags: ["dungeon_exclusive"] })
      .where(eq(species.id, sp!.id));
    w.speciesAccess.set("gym_oni", []);
    await pools.create(body("exclusive_pool", "gym_oni"), null);
    const def = dungeon("exclusive_shared", "exclusive_pool");
    expect(
      (await w.content.validate(def)).issues.some(
        (i) => i.code === "species_not_permitted",
      ),
    ).toBe(true);
    def.speciesPolicies = [{ species: "gym_oni", perPlayerLimit: 1 }];
    await w.publish(def);
    const p = await w.player();
    const contract = await getItemBySlug(w.t.db, "mythic_contract");
    await w.app.inventory.addItem(w.t.db, p.playerId, contract.id, 2);
    let run = await meet(p.playerId, await w.runs.start(p.playerId, def.key));
    expect(offered(run)?.available).toBe(true);
    run = (
      await w.act(p.playerId, run, {
        type: "select_item",
        item: contract.slug,
        expectedStep: run.step,
      })
    ).run;
    run = (
      await w.act(p.playerId, run, { type: "capture", expectedStep: run.step })
    ).run;
    if (run.status === "active")
      await w.act(p.playerId, run, { type: "abandon", expectedStep: run.step });
    w.clock.now = new Date(w.clock.now.getTime() + 86400000);
    const again = await meet(
      p.playerId,
      await w.runs.start(p.playerId, def.key),
    );
    const [limited] = await w.t.db
      .select()
      .from(dungeonRuns)
      .where(eq(dungeonRuns.id, again.id));
    expect(Object.values(limited!.encounterStates)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unavailable",
          unavailableReason: "player_limit",
        }),
      ]),
    );
    const other = dungeon("exclusive_shared_other", "exclusive_pool");
    other.speciesPolicies = def.speciesPolicies;
    await w.publish(other);
    const p2 = await w.player();
    expect(
      offered(
        await meet(p2.playerId, await w.runs.start(p2.playerId, other.key)),
      )?.available,
    ).toBe(true);
  });

  it("portable JSON imports atomically by key, preserves unrelated pools, detects conflicts and retries safely without activation or hunting changes", async () => {
    const huntingBefore = await w.t.db.select().from(regionEncounterPools);
    const source = await pools.export(["exclusive_pool"]);
    expect(JSON.stringify(source)).not.toMatch(/updatedAt|revision|createdAt/);
    source.pools[0]!.key = "imported_shared";
    const imported = await pools.import(
      source,
      { imported_shared: null },
      "importer",
    );
    expect(imported[0]).toMatchObject({
      revision: 1,
      definition: { enabled: false },
    });
    const auditBefore = await w.t.db.select().from(dungeonSpeciesPoolEvents);
    expect(
      await pools.import(source, { imported_shared: null }, "importer"),
    ).toEqual(imported);
    expect(await w.t.db.select().from(dungeonSpeciesPoolEvents)).toEqual(
      auditBefore,
    );
    source.pools[0]!.name = "Different";
    await expect(
      pools.import(source, { imported_shared: null }, null),
    ).rejects.toThrow(/conflict/);
    await pools.import(source, { imported_shared: 1 }, null);
    const bad = structuredClone(source);
    bad.pools.push(
      body("atomic_new"),
      body("atomic_missing", "absent_species"),
    );
    await expect(
      pools.import(
        bad,
        { imported_shared: 2, atomic_new: null, atomic_missing: null },
        null,
      ),
    ).rejects.toThrow(/missing/);
    await expect(pools.get("atomic_new")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const concurrent = structuredClone(source);
    concurrent.pools[0]!.key = "concurrent_import";
    const retries = await Promise.all(
      [1, 2].map(() =>
        pools.import(concurrent, { concurrent_import: null }, "importer"),
      ),
    );
    expect(retries[0]).toEqual(retries[1]);
    expect(await pools.history("concurrent_import")).toHaveLength(1);
    expect(await pools.get("exclusive_pool")).toMatchObject({
      revision: 1,
      definition: { enabled: true },
    });
    expect(await w.t.db.select().from(regionEncounterPools)).toEqual(
      huntingBefore,
    );
  });

  it("dungeon package export/import retains references and refuses missing destination pools", async () => {
    await pools.create(body("package_shared"), null);
    const def = dungeon("package_shared_dungeon", "package_shared");
    await w.publish(def);
    const pkg = await w.content.exportPackage(def.key, "draft", "exporter");
    expect(pkg.dungeon.speciesPools).toEqual(def.speciesPools);
    const destination = await createDungeonWorld();
    try {
      const plan = await destination.content.planImport(pkg);
      expect(
        plan.issues.some(
          (i) => i.message.includes("package_shared") && i.severity === "error",
        ),
      ).toBe(true);
      await expect(
        destination.content.applyImport(
          {
            package: pkg,
            expectedPlanHash: plan.planHash!,
            requestId: randomUUID(),
            expectedRevision: null,
            decisions: {
              dungeon: "create",
              enemies: {},
              allowMissingDependencies: false,
            },
          },
          "import",
        ),
      ).rejects.toBeDefined();
      const destinationPools = createSharedDungeonPoolService(destination.t.db);
      const poolPackage = await pools.export(["package_shared"]);
      await destinationPools.import(
        poolPackage,
        { package_shared: null },
        "import",
      );
      await destinationPools.setEnabled("package_shared", true, 1, "reviewer");
      let ready = await destination.content.planImport(pkg);
      await destinationPools.create(body("unrelated_shared"), null);
      expect((await destination.content.planImport(pkg)).planHash).toBe(
        ready.planHash,
      );
      const current = await destinationPools.get("package_shared");
      await destinationPools.update(
        "package_shared",
        { ...current.definition, name: "Destination edit" },
        current.revision,
        "other",
      );
      await expect(
        destination.content.applyImport(
          {
            package: pkg,
            expectedPlanHash: ready.planHash!,
            requestId: randomUUID(),
            expectedRevision: null,
            decisions: {
              dungeon: "create",
              enemies: {},
              allowMissingDependencies: false,
            },
          },
          "import",
        ),
      ).rejects.toMatchObject({ code: "DUNGEON_IMPORT_STALE" });
      ready = await destination.content.planImport(pkg);
      expect(ready.publishable).toBe(true);
      await destination.content.applyImport(
        {
          package: pkg,
          expectedPlanHash: ready.planHash!,
          requestId: randomUUID(),
          expectedRevision: null,
          decisions: {
            dungeon: "create",
            enemies: {},
            allowMissingDependencies: false,
          },
        },
        "import",
      );
      const detail = await destination.content.get(def.key);
      expect(detail!.draft.speciesPools).toEqual(def.speciesPools);
      expect(detail!.enabled).toBe(false);
      expect(detail!.published).toBeNull();
      await destination.content.publish(
        def.key,
        { expectedRevision: detail!.draftRevision },
        "reviewer",
      );
      await destination.content.setEnabled(def.key, true, "reviewer");
      const player = await destination.player();
      let run = await destination.runs.start(player.playerId, def.key);
      run = (
        await destination.act(player.playerId, run, {
          type: "decline",
          expectedStep: run.step,
        })
      ).run;
      expect(offered(run)?.species).toBe("neko_barista");
    } finally {
      await destination.cleanup();
    }
  });
  it("refuses export-all beyond importer capacity instead of emitting unusable JSON", async () => {
    await w.t.db.insert(dungeonSpeciesPools).values(
      Array.from({ length: 201 }, (_, n) => {
        const definition = body(`export_bound_${n}`);
        return { poolKey: definition.key, definition };
      }),
    );
    await expect(pools.export()).rejects.toThrow(/exceeds the import limits/);
    expect((await pools.export(["export_bound_0"])).pools).toHaveLength(1);
  });
});
