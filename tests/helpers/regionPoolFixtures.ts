/**
 * Region Pool test helpers (RP2A).
 *
 * - {@link legacySeederPoolRows} is a **frozen copy** of the pool block the
 *   content seeder ran before migration 0069 (`seeder.ts` at Delve 90456c4).
 *   Parity tests compare the new projection with it, so it must not be
 *   "improved" or routed through the new resolver.
 * - {@link canonicalProjection} is the parity query: `(region, slug, weight)`
 *   in an explicit order, because the hunt's own reads have none.
 * - {@link projectRegionPoolsFromContent} rebuilds only the projection from a
 *   test's own content set, leaving the authoritative tables alone. For tests
 *   that deliberately change their catalogue; the next `applyContent` puts the
 *   published pools back.
 * - {@link publishRegionPoolRevisionForTest} stands in for the RP2B publish
 *   path, which does not exist yet: it writes a new immutable revision and
 *   moves the pointer, and does not project.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import {
  regionEncounterPools,
  regionPoolRevisionEntries,
  regionPoolRevisions,
  regionPools,
  species,
} from '../../src/db/schema';
import type { LoadedContent } from '../../src/modules/content/schemas';
import type { Region } from '../../src/modules/locations/regions';
import { regionPoolHash, resolveShippedRegionPool } from '../../src/modules/regionPools/regionPoolStore';

export interface PoolRow {
  regionId: string;
  slug: string;
  weight: number;
}

const byKey = (a: PoolRow, b: PoolRow) =>
  a.regionId === b.regionId ? (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) : a.regionId < b.regionId ? -1 : 1;

/** What the pre-0069 seeder wrote, as canonical rows. Frozen; see the module comment. */
export async function legacySeederPoolRows(db: Db, content: LoadedContent): Promise<PoolRow[]> {
  const speciesIdBySlug = new Map(
    (await db.select({ id: species.id, slug: species.slug }).from(species)).map((r) => [r.slug, r.id]),
  );
  const rows: PoolRow[] = [];
  for (const region of content.regions) {
    if (!region.enabled) continue;
    for (const entry of region.encounterPool) {
      const speciesId = speciesIdBySlug.get(entry.species);
      if (speciesId === undefined) continue;
      const fallback = content.species.find((s) => s.slug === entry.species);
      const weight = entry.weight ?? Math.max(1, fallback?.perSpeciesWeight ?? 1);
      rows.push({ regionId: region.id, slug: entry.species, weight });
    }
  }
  return rows.sort(byKey);
}

/** The pre-0069 seeder's write, frozen: delete everything, insert per enabled region in file order. */
export async function writeLegacySeederPools(db: Db, content: LoadedContent): Promise<void> {
  await db.transaction(async (tx) => {
    const speciesIdBySlug = new Map(
      (await tx.select({ id: species.id, slug: species.slug }).from(species)).map((r) => [r.slug, r.id]),
    );
    await tx.delete(regionEncounterPools);
    for (const region of content.regions) {
      if (!region.enabled) continue;
      const poolRows = region.encounterPool.flatMap((entry) => {
        const speciesId = speciesIdBySlug.get(entry.species);
        if (speciesId === undefined) return [];
        const fallback = content.species.find((s) => s.slug === entry.species);
        const weight = entry.weight ?? Math.max(1, fallback?.perSpeciesWeight ?? 1);
        return [{ regionId: region.id, speciesId, weight }];
      });
      if (poolRows.length > 0) await tx.insert(regionEncounterPools).values(poolRows);
    }
  });
}

/**
 * The parity query, sorted explicitly. Its SQL twin for real databases is
 * `docs/region-pools/rp2a-parity.sql`.
 */
export async function canonicalProjection(db: Db): Promise<PoolRow[]> {
  const result = await db.execute<{ region_id: string; slug: string; weight: number }>(sql`
    select p.region_id, s.slug, p.weight
    from region_encounter_pools p
    join species s on s.id = p.species_id
    order by p.region_id, s.slug`);
  return result.rows.map((r) => ({ regionId: r.region_id, slug: r.slug, weight: Number(r.weight) }));
}

/** Replace the projection with the test's own content, legacy semantics. Authoritative tables untouched. */
export async function projectRegionPoolsFromContent(db: Db, content: LoadedContent): Promise<void> {
  await db.transaction(async (tx) => {
    const idBySlug = new Map(
      (await tx.select({ id: species.id, slug: species.slug }).from(species)).map((r) => [r.slug, r.id]),
    );
    await tx.delete(regionEncounterPools);
    for (const region of content.regions) {
      if (!region.enabled) continue;
      const { entries } = resolveShippedRegionPool(region, content.species, idBySlug);
      if (entries.length === 0) continue;
      await tx
        .insert(regionEncounterPools)
        .values(entries.map((e) => ({ regionId: region.id, speciesId: e.speciesId, weight: e.weight })));
    }
  });
}

/** Publish `entries` as the region's next revision (RP2B stand-in). Returns the revision id. */
export async function publishRegionPoolRevisionForTest(
  db: Db,
  regionId: Region,
  entries: ReadonlyArray<{ species: string; weight: number }>,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [pool] = await tx.select().from(regionPools).where(eq(regionPools.regionId, regionId)).for('update');
    if (!pool) throw new Error(`no region pool for ${regionId}`);
    const [latest] = await tx
      .select({ number: regionPoolRevisions.number })
      .from(regionPoolRevisions)
      .where(eq(regionPoolRevisions.regionId, regionId))
      .orderBy(desc(regionPoolRevisions.number))
      .limit(1);
    const rows = await tx.select().from(species);
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    const hash = regionPoolHash(entries);
    const draftRevision = pool.draftRevision + 1;
    await tx
      .update(regionPools)
      .set({ draftEntries: [...entries], draftHash: hash, draftRevision, updatedBy: 'test:editor' })
      .where(eq(regionPools.regionId, regionId));
    const [revision] = await tx
      .insert(regionPoolRevisions)
      .values({
        regionId,
        number: (latest?.number ?? 0) + 1,
        contentHash: hash,
        source: 'editor',
        draftRevision,
        speciesManifest: entries.map((e) => {
          const row = bySlug.get(e.species)!;
          return { species: row.slug, rarity: row.rarity, enabled: row.enabled, tags: row.tags };
        }),
        publishedBy: 'test:editor',
      })
      .returning({ id: regionPoolRevisions.id });
    await tx.insert(regionPoolRevisionEntries).values(
      entries.map((e, position) => ({
        revisionId: revision!.id,
        speciesId: bySlug.get(e.species)!.id,
        weight: e.weight,
        position,
      })),
    );
    await tx
      .update(regionPools)
      .set({ publishedRevisionId: revision!.id })
      .where(eq(regionPools.regionId, regionId));
    return revision!.id;
  });
}
