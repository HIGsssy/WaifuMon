/**
 * Region Pools: database ownership, bootstrap and the runtime projection.
 *
 * Since migration 0069 the database is authoritative for which species each
 * region's hunt can meet and at what region-local weight. Three pieces:
 *
 *   - **Bootstrap.** A canonical region with no `region_pools` row gets one,
 *     once, from its shipped region file: a draft, revision 1 (source
 *     `bootstrap`) and a `bootstrapped` audit event carrying the shipped
 *     baseline. A region that already has a row is never written here, so an
 *     admin-published revision survives restarts, reloads and edited JSON.
 *   - **Projection.** `region_encounter_pools` — the table the hunt, the
 *     scripted spawner and the species selectors read — is rebuilt per region
 *     from that region's published revision, in authored order, and only for
 *     regions whose file is `enabled`. A region whose rows already match is
 *     left alone, so a repeated start writes nothing.
 *   - **Coverage.** The startup warnings that used to read the region files now
 *     read the projection, which is what a hunt actually sees.
 *
 * All three run in one transaction under one advisory lock, after the content
 * seeder has upserted the species they reference. Nothing here touches the
 * hunt's selection rules; it decides only which rows the hunt reads.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  regionEncounterPools,
  regionPoolEvents,
  regionPoolRevisionEntries,
  regionPoolRevisions,
  regionPools,
  species,
  type RegionPoolDraftEntry,
  type RegionPoolEventAction,
  type RegionPoolManifestEntry,
} from '../../db/schema';
import type { Logger } from '../../shared/logger';
import type { LoadedContent, RegionContent } from '../content/schemas';
import { DUNGEON_EXCLUSIVE_TAG, isRegion, REGIONS, type Region } from '../locations/regions';

/** The actor recorded on everything the startup path writes. */
export const REGION_POOL_SYSTEM_ACTOR = 'system:bootstrap';

/** The most a single entry may weigh; the revision-entry CHECK enforces it too. */
export const REGION_POOL_MAX_WEIGHT = 1_000_000;

/** One resolved entry of a shipped pool, ready to become a revision entry. */
export interface ResolvedPoolEntry {
  species: string;
  speciesId: number;
  weight: number;
  position: number;
}

export interface ResolvedShippedPool {
  entries: ResolvedPoolEntry[];
  /** Slugs the file names that have no `species` row. Skipped, as the seeder always did. */
  skipped: string[];
  /** `sha256:` hash of the resolved `{ species, weight }` list, in order. */
  hash: string;
}

/**
 * A region file's `encounterPool`, resolved exactly as the content seeder
 * resolved it before 0069: a slug with no `species` row is skipped, and an
 * entry with no weight inherits `max(1, species.perSpeciesWeight)` from the
 * content set. Order is the file's order.
 *
 * Exported because the parity tests and the test projection helper must use
 * this very function rather than a copy of it.
 */
export function resolveShippedRegionPool(
  region: Pick<RegionContent, 'encounterPool'>,
  contentSpecies: LoadedContent['species'],
  speciesIdBySlug: ReadonlyMap<string, number>,
): ResolvedShippedPool {
  const bySlug = new Map(contentSpecies.map((s) => [s.slug, s]));
  const entries: ResolvedPoolEntry[] = [];
  const skipped: string[] = [];
  for (const entry of region.encounterPool) {
    const speciesId = speciesIdBySlug.get(entry.species);
    if (speciesId === undefined) {
      skipped.push(entry.species);
      continue;
    }
    const fallback = bySlug.get(entry.species);
    const weight = entry.weight ?? Math.max(1, fallback?.perSpeciesWeight ?? 1);
    entries.push({ species: entry.species, speciesId, weight, position: entries.length });
  }
  return { entries, skipped, hash: regionPoolHash(entries) };
}

/** `sha256:` over the ordered `{ species, weight }` list — order is part of the content. */
export function regionPoolHash(entries: ReadonlyArray<{ species: string; weight: number }>): string {
  const canonical = JSON.stringify(entries.map((e) => ({ species: e.species, weight: e.weight })));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Added / removed / reweighted between two `slug → weight` maps. */
export interface RegionPoolDiff {
  added: RegionPoolDraftEntry[];
  removed: RegionPoolDraftEntry[];
  reweighted: Array<{ species: string; from: number; to: number }>;
}

export function diffRegionPools(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): RegionPoolDiff {
  const diff: RegionPoolDiff = { added: [], removed: [], reweighted: [] };
  for (const [slug, weight] of after) {
    const was = before.get(slug);
    if (was === undefined) diff.added.push({ species: slug, weight });
    else if (was !== weight) diff.reweighted.push({ species: slug, from: was, to: weight });
  }
  for (const [slug, weight] of before) {
    if (!after.has(slug)) diff.removed.push({ species: slug, weight });
  }
  const bySlug = (a: { species: string }, b: { species: string }) => a.species.localeCompare(b.species);
  diff.added.sort(bySlug);
  diff.removed.sort(bySlug);
  diff.reweighted.sort(bySlug);
  return diff;
}

export function isEmptyDiff(diff: RegionPoolDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.reweighted.length === 0;
}

export interface RegionPoolCoverage {
  /** Enabled, huntable species in no projected pool. */
  unpooledSpecies: string[];
  /** Released region → hunted rarities with no eligible projected species. */
  emptyTiers: Record<string, string[]>;
}

export interface RegionPoolSyncResult {
  /** Regions bootstrapped by this call. */
  bootstrapped: Region[];
  /** Regions that already had a database pool and were left as they are. */
  existing: Region[];
  /** Regions whose projection rows this call rewrote. */
  reprojected: Region[];
  /** Regions whose shipped file differs from the published revision. */
  shippedDrift: Region[];
  /** Projection rows per region after the call. */
  projectedEntries: Partial<Record<Region, number>>;
  coverage: RegionPoolCoverage;
}

/** Serialises every Region Pool sync: two processes starting at once, or a reload racing a start. */
const REGION_POOL_LOCK = sql`select pg_advisory_xact_lock(hashtextextended('region_pools', 0))`;

async function recordEvent(
  tx: DbOrTx,
  regionId: string,
  action: RegionPoolEventAction,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.insert(regionPoolEvents).values({
    regionId,
    action,
    actor: REGION_POOL_SYSTEM_ACTOR,
    details,
  });
}

async function speciesFacts(tx: DbOrTx): Promise<{
  idBySlug: Map<string, number>;
  byId: Map<number, { slug: string; rarity: string; enabled: boolean; tags: string[] }>;
}> {
  const rows = await tx
    .select({
      id: species.id,
      slug: species.slug,
      rarity: species.rarity,
      enabled: species.enabled,
      tags: species.tags,
    })
    .from(species);
  return {
    idBySlug: new Map(rows.map((r) => [r.slug, r.id])),
    byId: new Map(rows.map((r) => [r.id, r])),
  };
}

/** The projection rows for one region, as `slug → weight`. */
async function projectionOf(tx: DbOrTx, regionId: Region): Promise<Map<string, number>> {
  const rows = await tx
    .select({ slug: species.slug, weight: regionEncounterPools.weight })
    .from(regionEncounterPools)
    .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
    .where(eq(regionEncounterPools.regionId, regionId));
  return new Map(rows.map((r) => [r.slug, r.weight]));
}

async function bootstrapRegion(
  tx: DbOrTx,
  region: RegionContent & { id: Region },
  shipped: ResolvedShippedPool,
  facts: Awaited<ReturnType<typeof speciesFacts>>,
  logger: Logger,
): Promise<void> {
  if (shipped.entries.some((e) => e.weight > REGION_POOL_MAX_WEIGHT)) {
    throw new Error(
      `Region "${region.id}" ships a pool weight above ${REGION_POOL_MAX_WEIGHT}; ` +
        'Region Pools cannot store it.',
    );
  }
  const before = await projectionOf(tx, region.id);
  const draftEntries: RegionPoolDraftEntry[] = shipped.entries.map((e) => ({
    species: e.species,
    weight: e.weight,
  }));
  await tx.insert(regionPools).values({
    regionId: region.id,
    draftEntries,
    draftRevision: 1,
    draftHash: shipped.hash,
    updatedBy: REGION_POOL_SYSTEM_ACTOR,
  });
  const manifest: RegionPoolManifestEntry[] = shipped.entries.map((e) => {
    const row = facts.byId.get(e.speciesId)!;
    return { species: row.slug, rarity: row.rarity, enabled: row.enabled, tags: row.tags };
  });
  const [revision] = await tx
    .insert(regionPoolRevisions)
    .values({
      regionId: region.id,
      number: 1,
      contentHash: shipped.hash,
      source: 'bootstrap',
      draftRevision: 1,
      speciesManifest: manifest,
      publishedBy: REGION_POOL_SYSTEM_ACTOR,
    })
    .returning({ id: regionPoolRevisions.id });
  if (shipped.entries.length > 0) {
    await tx.insert(regionPoolRevisionEntries).values(
      shipped.entries.map((e) => ({
        revisionId: revision!.id,
        speciesId: e.speciesId,
        weight: e.weight,
        position: e.position,
      })),
    );
  }
  await tx
    .update(regionPools)
    .set({ publishedRevisionId: revision!.id })
    .where(eq(regionPools.regionId, region.id));

  // The rows the previous release projected (from its own region file) against
  // what this release bootstraps. Empty when the region file did not change in
  // this release, which is how the parity of the ownership flip is evidenced.
  const after = new Map(shipped.entries.map((e) => [e.species, e.weight]));
  const diff = diffRegionPools(before, after);
  await recordEvent(tx, region.id, 'bootstrapped', {
    revisionId: revision!.id,
    revisionNumber: 1,
    regionEnabled: region.enabled,
    shipped: { hash: shipped.hash, entries: draftEntries, skipped: shipped.skipped },
    previousProjection: { entries: before.size, diff, identical: isEmptyDiff(diff) },
  });
  logger.info(
    {
      tag: 'region-pools/bootstrapped',
      regionId: region.id,
      entries: shipped.entries.length,
      skipped: shipped.skipped,
      previousProjectionIdentical: isEmptyDiff(diff),
    },
    'region pool bootstrapped from its shipped region file',
  );
}

async function reportShippedDrift(
  tx: DbOrTx,
  regionId: Region,
  publishedRevisionId: number | null,
  shipped: ResolvedShippedPool,
  logger: Logger,
): Promise<boolean> {
  if (publishedRevisionId === null) return false;
  const [published] = await tx
    .select({ contentHash: regionPoolRevisions.contentHash, number: regionPoolRevisions.number })
    .from(regionPoolRevisions)
    .where(eq(regionPoolRevisions.id, publishedRevisionId));
  if (!published || published.contentHash === shipped.hash) return false;

  logger.warn(
    {
      tag: 'region-pools/shipped-drift',
      regionId,
      publishedRevision: published.number,
      shippedHash: shipped.hash,
    },
    'the shipped region file differs from the published Region Pool; the published pool stays authoritative',
  );
  // One event per (published revision, shipped file) pair, not one per restart.
  const [seen] = await tx
    .select({ id: regionPoolEvents.id })
    .from(regionPoolEvents)
    .where(
      and(
        eq(regionPoolEvents.regionId, regionId),
        eq(regionPoolEvents.action, 'drift_detected'),
        sql`${regionPoolEvents.details}->>'kind' = 'shipped'`,
        sql`${regionPoolEvents.details}->>'shippedHash' = ${shipped.hash}`,
        sql`(${regionPoolEvents.details}->>'publishedRevisionId')::bigint = ${publishedRevisionId}`,
      ),
    )
    .limit(1);
  if (!seen) {
    await recordEvent(tx, regionId, 'drift_detected', {
      kind: 'shipped',
      publishedRevisionId,
      publishedHash: published.contentHash,
      shippedHash: shipped.hash,
    });
  }
  return true;
}

/**
 * Rebuilds one region's projection when it differs from what it should be.
 * Returns true when rows were rewritten.
 */
async function projectRegion(
  tx: DbOrTx,
  regionId: Region,
  publishedRevisionId: number | null,
): Promise<{ changed: boolean; entries: number }> {
  const desired = publishedRevisionId
    ? await tx
        .select({
          speciesId: regionPoolRevisionEntries.speciesId,
          slug: species.slug,
          weight: regionPoolRevisionEntries.weight,
        })
        .from(regionPoolRevisionEntries)
        .innerJoin(species, eq(regionPoolRevisionEntries.speciesId, species.id))
        .where(eq(regionPoolRevisionEntries.revisionId, publishedRevisionId))
        .orderBy(asc(regionPoolRevisionEntries.position))
    : [];
  const before = await projectionOf(tx, regionId);
  const after = new Map(desired.map((d) => [d.slug, d.weight]));
  const diff = diffRegionPools(before, after);
  if (isEmptyDiff(diff)) return { changed: false, entries: after.size };

  await tx.delete(regionEncounterPools).where(eq(regionEncounterPools.regionId, regionId));
  if (desired.length > 0) {
    // One multi-row insert in authored order, as the seeder wrote it.
    await tx
      .insert(regionEncounterPools)
      .values(desired.map((d) => ({ regionId, speciesId: d.speciesId, weight: d.weight })));
  }
  await recordEvent(tx, regionId, 'projection_rebuilt', {
    publishedRevisionId,
    before: before.size,
    after: after.size,
    diff,
  });
  return { changed: true, entries: after.size };
}

/**
 * The startup warnings, read from the projection the hunt draws from.
 *
 * Replaces the loader's file-based "unpooled species" warning. A species with
 * no projected pool row is reachable only through the hunt's global fallback,
 * which runs only when a rolled rarity has no pooled species in the player's
 * region *and* in Waifu Valley — so while every rarity is covered she is never
 * met. Dungeon-exclusive species are never pooled by design and are not listed.
 *
 * Warnings, never failures: a boot must not fail because a species landed
 * before her pool entry, or because content drift emptied a tier — the hunt's
 * runtime filters keep every draw safe in both cases.
 */
async function reportCoverage(
  tx: DbOrTx,
  content: LoadedContent,
  released: ReadonlySet<Region>,
  logger: Logger,
): Promise<RegionPoolCoverage> {
  const coverage: RegionPoolCoverage = { unpooledSpecies: [], emptyTiers: {} };
  const eligible = sql`${species.enabled} and not (${species.tags} @> ${JSON.stringify([DUNGEON_EXCLUSIVE_TAG])}::jsonb)`;

  const pooledRows = await tx
    .select({ regionId: regionEncounterPools.regionId, rarity: species.rarity })
    .from(regionEncounterPools)
    .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
    .where(eligible);
  if (pooledRows.length === 0) return coverage;

  const unpooled = await tx
    .select({ slug: species.slug })
    .from(species)
    .where(
      and(
        eligible,
        sql`not exists (select 1 from ${regionEncounterPools} where ${regionEncounterPools.speciesId} = ${species.id})`,
      ),
    );
  // Sorted here rather than in SQL, so the order does not depend on the collation.
  coverage.unpooledSpecies = unpooled.map((r) => r.slug).sort();
  if (coverage.unpooledSpecies.length > 0) {
    logger.warn(
      {
        tag: 'regions/unpooled-species',
        count: coverage.unpooledSpecies.length,
        slugs: coverage.unpooledSpecies,
      },
      `${coverage.unpooledSpecies.length} enabled species are in no released region's encounter ` +
        'pool. While every rarity is covered no hunt can draw them. Add them to a Region Pool. ' +
        `Affected: ${coverage.unpooledSpecies.join(', ')}`,
    );
  }

  const hunted = content.tables.hunt.rarityTable.filter((r) => r.weight > 0).map((r) => r.rarity);
  const covered = new Map<string, Set<string>>();
  for (const row of pooledRows) {
    const set = covered.get(row.regionId) ?? new Set<string>();
    set.add(row.rarity);
    covered.set(row.regionId, set);
  }
  for (const regionId of released) {
    const missing = hunted.filter((rarity) => !covered.get(regionId)?.has(rarity));
    if (missing.length === 0) continue;
    coverage.emptyTiers[regionId] = missing;
    logger.warn(
      { tag: 'region-pools/empty-tier', regionId, rarities: missing },
      `Region "${regionId}" has no huntable species at ${missing.join(', ')}: those rolls fall ` +
        'back to Waifu Valley at the same rarity, then to the global table.',
    );
  }
  return coverage;
}

/**
 * Bootstrap missing Region Pools from the content set, then project every
 * published pool into `region_encounter_pools`, in one transaction.
 *
 * Call after `seedContent`, which must already have upserted the species the
 * pools name. Safe to repeat: a second call with the same state writes nothing.
 */
export async function syncRegionPools(
  db: Db,
  content: LoadedContent,
  logger: Logger,
): Promise<RegionPoolSyncResult> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(REGION_POOL_LOCK);
    const facts = await speciesFacts(tx);
    const out: RegionPoolSyncResult = {
      bootstrapped: [],
      existing: [],
      reprojected: [],
      shippedDrift: [],
      projectedEntries: {},
      coverage: { unpooledSpecies: [], emptyTiers: {} },
    };

    const existingRows = await tx.select().from(regionPools);
    const existing = new Map(existingRows.map((r) => [r.regionId, r]));
    const regionContent = new Map<Region, RegionContent & { id: Region }>();
    for (const region of content.regions) {
      if (isRegion(region.id)) regionContent.set(region.id, region as RegionContent & { id: Region });
    }

    for (const region of regionContent.values()) {
      const shipped = resolveShippedRegionPool(region, content.species, facts.idBySlug);
      const row = existing.get(region.id);
      if (!row) {
        await bootstrapRegion(tx, region, shipped, facts, logger);
        out.bootstrapped.push(region.id);
        continue;
      }
      out.existing.push(region.id);
      if (await reportShippedDrift(tx, region.id, row.publishedRevisionId, shipped, logger)) {
        out.shippedDrift.push(region.id);
      }
    }

    const pointers = new Map(
      (await tx
        .select({ regionId: regionPools.regionId, published: regionPools.publishedRevisionId })
        .from(regionPools)).map((r) => [r.regionId, r.published]),
    );
    const released = new Set<Region>();
    for (const regionId of REGIONS) {
      // A disabled region is unreleased content: projecting it would let a
      // hunt reach a place the Locations screen refuses to show.
      const live = regionContent.get(regionId)?.enabled === true;
      if (live) released.add(regionId);
      const published = live ? (pointers.get(regionId) ?? null) : null;
      const projected = await projectRegion(tx, regionId, published);
      if (projected.changed) out.reprojected.push(regionId);
      out.projectedEntries[regionId] = projected.entries;
    }

    out.coverage = await reportCoverage(tx, content, released, logger);
    return out;
  });
  logger.info(
    {
      bootstrapped: result.bootstrapped,
      existing: result.existing.length,
      reprojected: result.reprojected,
      shippedDrift: result.shippedDrift,
      projectedEntries: result.projectedEntries,
    },
    'region pools synced',
  );
  return result;
}

/** Published revision rows for a region, newest first. Read-only; used by tests and RP2B. */
export async function listRegionPoolRevisions(tx: DbOrTx, regionId: Region) {
  return tx
    .select()
    .from(regionPoolRevisions)
    .where(eq(regionPoolRevisions.regionId, regionId))
    .orderBy(desc(regionPoolRevisions.number));
}

/**
 * Species slugs in each released region's **projected** pool — what a hunt or
 * a region-scoped selector can actually reach. Regions with no rows still
 * appear, empty, when listed in `releasedRegionIds`.
 */
export async function projectedRegionPoolSlugs(
  tx: DbOrTx,
  releasedRegionIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const pools = new Map<string, Set<string>>(releasedRegionIds.map((id) => [id, new Set<string>()]));
  if (releasedRegionIds.length === 0) return pools;
  const rows = await tx
    .select({ regionId: regionEncounterPools.regionId, slug: species.slug })
    .from(regionEncounterPools)
    .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
    .where(inArray(regionEncounterPools.regionId, [...releasedRegionIds]));
  for (const row of rows) pools.get(row.regionId)?.add(row.slug);
  return pools;
}
