import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../../db/client";
import {
  dungeonDefinitions,
  dungeonRevisions,
  dungeonSpeciesPools,
  dungeonSpeciesPoolEvents,
  species,
} from "../../../db/schema";
import {
  AppError,
  DungeonDraftStaleError,
  DungeonInvalidError,
  uniqueViolationConstraint,
} from "../../../shared/errors";
import {
  DungeonDefinitionSchema,
  type DungeonDefinition,
} from "../content/dungeonDefinition";
import { canonicalJson } from "../../rewardTables/rewardTableCore";
import {
  SharedPoolDefinitionSchema,
  SharedPoolPackageSchema,
  resolveSharedPools,
  sharedPoolKeys,
  type FrozenSharedPools,
  type SharedPoolDefinition,
} from "./sharedPoolDefinition";

export function poolInvalid(message: string, path = "speciesPools"): never {
  throw new DungeonInvalidError([
    { code: "schema", severity: "error", path, message },
  ]);
}
export async function loadSharedPoolCatalogue(tx: DbOrTx) {
  return new Map(
    (await tx.select().from(dungeonSpeciesPools)).map((row) => [
      row.poolKey,
      SharedPoolDefinitionSchema.parse(row.definition),
    ]),
  );
}
export async function freezeSharedPools(
  tx: DbOrTx,
  definition: DungeonDefinition,
): Promise<FrozenSharedPools> {
  const keys = sharedPoolKeys(definition);
  if (!keys.length) return {};
  const rows = await tx
    .select()
    .from(dungeonSpeciesPools)
    .where(inArray(dungeonSpeciesPools.poolKey, keys))
    .orderBy(asc(dungeonSpeciesPools.poolKey))
    .for("share");
  return Object.fromEntries(
    keys.map((key) => {
      const row = rows.find((r) => r.poolKey === key);
      if (!row)
        return poolInvalid(
          `Shared WaifuMon pool "${key}" is missing.`,
          `speciesPools.${key}`,
        );
      const body = SharedPoolDefinitionSchema.safeParse(row.definition);
      if (!body.success || !body.data.enabled)
        return poolInvalid(
          `Shared WaifuMon pool "${key}" is disabled or invalid.`,
          `speciesPools.${key}`,
        );
      return [key, { revision: row.revision, definition: body.data }];
    }),
  );
}
/** Reloads must never read the mutable catalogue, even when the saved snapshot is missing. */
export function withFrozenSharedPools(
  definition: DungeonDefinition,
  frozen: FrozenSharedPools | undefined,
): DungeonDefinition {
  const catalogue = new Map<string, SharedPoolDefinition>();
  for (const key of sharedPoolKeys(definition)) {
    const parsed = SharedPoolDefinitionSchema.safeParse(
      frozen?.[key]?.definition,
    );
    if (!parsed.success || !parsed.data.enabled || parsed.data.key !== key)
      poolInvalid(`Run snapshot is missing shared WaifuMon pool "${key}".`);
    catalogue.set(key, parsed.data);
  }
  return resolveSharedPools(definition, catalogue);
}

export function createSharedDungeonPoolService(db: Db) {
  async function get(key: string, tx: DbOrTx = db, lock = false) {
    const query = tx
      .select()
      .from(dungeonSpeciesPools)
      .where(eq(dungeonSpeciesPools.poolKey, key));
    const [row] = await (lock ? query.for("update") : query);
    if (!row)
      throw new AppError(
        "NOT_FOUND",
        `Shared pool ${key} missing`,
        `Shared WaifuMon pool "${key}" was not found.`,
      );
    return {
      definition: SharedPoolDefinitionSchema.parse(row.definition),
      revision: row.revision,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }
  async function validate(tx: DbOrTx, raw: unknown) {
    const parsed = SharedPoolDefinitionSchema.safeParse(raw);
    if (!parsed.success)
      poolInvalid(
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(" "),
      );
    const definition = parsed.data;
    const slugs = definition.entries.flatMap((e) =>
      "species" in e ? [e.species] : [],
    );
    const found = await tx
      .select({ slug: species.slug, enabled: species.enabled })
      .from(species)
      .where(inArray(species.slug, slugs))
      .for("share");
    for (const slug of slugs) {
      const row = found.find((s) => s.slug === slug);
      if (!row) poolInvalid(`Species "${slug}" is missing.`);
      if (definition.enabled && !row.enabled)
        poolInvalid(
          `Species "${slug}" is disabled; repair the pool before enabling it.`,
        );
    }
    return definition;
  }
  async function write(
    tx: DbOrTx,
    definition: SharedPoolDefinition,
    expectedRevision: number | null,
    actor: string | null,
    action: string,
  ) {
    const current =
      expectedRevision === null ? null : await get(definition.key, tx, true);
    if (current && current.revision !== expectedRevision)
      throw new DungeonDraftStaleError(
        definition.key,
        expectedRevision!,
        current.revision,
        current.updatedBy,
        current.updatedAt,
      );
    // Identical retries are no-ops, but stale writes are still refused.
    if (
      current &&
      canonicalJson(current.definition) === canonicalJson(definition)
    )
      return current;
    const revision = (current?.revision ?? 0) + 1;
    if (current)
      await tx
        .update(dungeonSpeciesPools)
        .set({ definition, revision, updatedBy: actor, updatedAt: new Date() })
        .where(eq(dungeonSpeciesPools.poolKey, definition.key));
    else
      await tx
        .insert(dungeonSpeciesPools)
        .values({ poolKey: definition.key, definition, updatedBy: actor });
    await tx
      .insert(dungeonSpeciesPoolEvents)
      .values({ poolKey: definition.key, definition, revision, actor, action });
    return get(definition.key, tx);
  }
  async function protect<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (uniqueViolationConstraint(err))
        throw new AppError(
          "DUNGEON_KEY_TAKEN",
          "Shared pool key conflict",
          "A shared WaifuMon pool with this key already exists. Reload before retrying.",
        );
      throw err;
    }
  }
  return {
    get,
    async list(search = "") {
      const needle = search.toLowerCase();
      return (
        await db
          .select()
          .from(dungeonSpeciesPools)
          .orderBy(asc(dungeonSpeciesPools.poolKey))
      )
        .map((row) => ({
          definition: SharedPoolDefinitionSchema.parse(row.definition),
          revision: row.revision,
        }))
        .filter((p) =>
          `${p.definition.key} ${p.definition.name} ${p.definition.description}`
            .toLowerCase()
            .includes(needle),
        );
    },
    create(raw: unknown, actor: string | null) {
      return protect(() =>
        db.transaction(async (tx) =>
          write(tx, await validate(tx, raw), null, actor, "created"),
        ),
      );
    },
    update(
      key: string,
      raw: unknown,
      expectedRevision: number,
      actor: string | null,
    ) {
      return db.transaction(async (tx) => {
        const definition = await validate(tx, raw);
        if (definition.key !== key)
          poolInvalid(
            "Pool keys cannot be changed. Duplicate the pool instead.",
          );
        return write(tx, definition, expectedRevision, actor, "updated");
      });
    },
    setEnabled(
      key: string,
      enabled: boolean,
      expectedRevision: number,
      actor: string | null,
    ) {
      return db.transaction(async (tx) => {
        const current = await get(key, tx, true);
        const definition = await validate(tx, {
          ...current.definition,
          enabled,
        });
        return write(
          tx,
          definition,
          expectedRevision,
          actor,
          enabled ? "enabled" : "disabled",
        );
      });
    },
    duplicate(
      key: string,
      newKey: string,
      expectedRevision: number,
      actor: string | null,
    ) {
      return protect(() =>
        db.transaction(async (tx) => {
          const current = await get(key, tx, true);
          if (current.revision !== expectedRevision)
            throw new DungeonDraftStaleError(
              key,
              expectedRevision,
              current.revision,
              current.updatedBy,
              current.updatedAt,
            );
          return write(
            tx,
            await validate(tx, {
              ...current.definition,
              key: newKey,
              name: `${current.definition.name.slice(0, 73)} (copy)`,
              enabled: false,
            }),
            null,
            actor,
            "duplicated",
          );
        }),
      );
    },
    async references(key: string) {
      await get(key);
      const rows = await db
        .select({
          key: dungeonDefinitions.dungeonKey,
          draft: dungeonDefinitions.draft,
          published: dungeonRevisions.content,
        })
        .from(dungeonDefinitions)
        .leftJoin(
          dungeonRevisions,
          eq(dungeonRevisions.id, dungeonDefinitions.publishedRevisionId),
        )
        .orderBy(asc(dungeonDefinitions.dungeonKey));
      return rows.flatMap((row) =>
        (["draft", "published"] as const).flatMap((source) => {
          const parsed = DungeonDefinitionSchema.safeParse(row[source]);
          if (!parsed.success) return [];
          return (parsed.data.speciesPools ?? [])
            .filter((p) => p.sharedPoolKey === key)
            .map((p) => ({
              dungeonKey: row.key,
              name: parsed.data.name,
              source,
              poolId: p.id,
            }));
        }),
      );
    },
    async history(key: string) {
      await get(key);
      return db
        .select()
        .from(dungeonSpeciesPoolEvents)
        .where(eq(dungeonSpeciesPoolEvents.poolKey, key))
        .orderBy(asc(dungeonSpeciesPoolEvents.id));
    },
    async export(keys?: string[]) {
      const rows = await db
        .select()
        .from(dungeonSpeciesPools)
        .orderBy(asc(dungeonSpeciesPools.poolKey));
      if (keys?.some((key) => !rows.some((r) => r.poolKey === key)))
        poolInvalid("An export key is missing. Reload the catalogue.");
      const pkg = {
        format: "waifumon-dungeon-species-pools" as const,
        schemaVersion: 1 as const,
        pools: rows
          .filter((r) => !keys || keys.includes(r.poolKey))
          .map((r) => SharedPoolDefinitionSchema.parse(r.definition)),
      };
      // Leave room for expectedRevisions and the HTTP wrapper within the 2 MiB route.
      if (
        pkg.pools.length > 200 ||
        Buffer.byteLength(JSON.stringify(pkg)) > 1_900_000
      )
        poolInvalid(
          "This export exceeds the import limits. Export pools individually or in smaller selections.",
        );
      return pkg;
    },
    /** Atomic additive import. Explicit revisions authorize overwrites; activation stays local. */
    import(
      raw: unknown,
      expectedRevisions: Record<string, number | null>,
      actor: string | null,
    ) {
      return protect(() =>
        db.transaction(async (tx) => {
          const parsed = SharedPoolPackageSchema.safeParse(raw);
          if (!parsed.success)
            poolInvalid(
              parsed.error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join(" "),
            );
          // Serializes create/retry imports, including keys which do not exist yet.
          await tx.execute(sql`select pg_advisory_xact_lock(74740001)`);
          const result = [];
          for (const incoming of [...parsed.data.pools].sort((a, b) =>
            a.key.localeCompare(b.key),
          )) {
            const [row] = await tx
              .select()
              .from(dungeonSpeciesPools)
              .where(eq(dungeonSpeciesPools.poolKey, incoming.key))
              .for("update");
            const current = row
              ? SharedPoolDefinitionSchema.parse(row.definition)
              : null;
            const definition = await validate(tx, {
              ...incoming,
              enabled: current?.enabled ?? false,
            });
            // Safe exact retries do not write or bump the destination revision.
            if (
              current &&
              canonicalJson(current) === canonicalJson(definition)
            ) {
              result.push(await get(incoming.key, tx));
              continue;
            }
            if (
              !(incoming.key in expectedRevisions) ||
              expectedRevisions[incoming.key] !== (row?.revision ?? null)
            )
              poolInvalid(
                `Import conflict for "${incoming.key}". Review the current destination revision and supply it explicitly.`,
                `pools.${incoming.key}`,
              );
            result.push(
              await write(
                tx,
                definition,
                row?.revision ?? null,
                actor,
                "imported",
              ),
            );
          }
          return result;
        }),
      );
    },
    /**
     * One pool from a complete dungeon bundle (CP-4B), in the bundle's
     * transaction, with the same rules as {@link import}: a new key is created
     * disabled; an existing one keeps its enabled state and is replaced only at
     * the revision the editor reviewed; an identical body writes nothing.
     */
    async applyImported(
      tx: DbOrTx,
      incoming: SharedPoolDefinition,
      expectedRevision: number | null,
      actor: string | null,
    ) {
      await tx.execute(sql`select pg_advisory_xact_lock(74740001)`);
      const [row] = await tx
        .select()
        .from(dungeonSpeciesPools)
        .where(eq(dungeonSpeciesPools.poolKey, incoming.key))
        .for("update");
      const current = row ? SharedPoolDefinitionSchema.parse(row.definition) : null;
      const definition = await validate(tx, { ...incoming, enabled: current?.enabled ?? false });
      if (current && canonicalJson(current) === canonicalJson(definition))
        return { ...(await get(incoming.key, tx)), written: false };
      if ((row?.revision ?? null) !== expectedRevision)
        poolInvalid(
          `Shared WaifuMon pool "${incoming.key}" changed after review. Review the bundle again.`,
          `sharedPools.${incoming.key}`,
        );
      return { ...(await write(tx, definition, row?.revision ?? null, actor, "imported")), written: true };
    },
    // There is deliberately no delete operation: stable referenced identities are retained.
  };
}
export type SharedDungeonPoolService = ReturnType<
  typeof createSharedDungeonPoolService
>;
