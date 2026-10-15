/**
 * RP2A: Region Pool database ownership and hunting parity.
 *
 * The database owns pool membership and weights; `region_encounter_pools` is
 * the hunt's projection of each released region's published revision. These
 * cases prove the ownership flip changed *who owns* the rows and nothing about
 * *which* rows the hunt reads.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  regionEncounterPools,
  regionPoolEvents,
  regionPoolRevisionEntries,
  regionPoolRevisions,
  regionPools,
  species,
} from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrate';
import { applyContent, createContentReloader } from '../../src/modules/content/reloadService';
import type { LoadedContent } from '../../src/modules/content/schemas';
import { seedContent } from '../../src/modules/content/seeder';
import { REGIONS, type Region } from '../../src/modules/locations/regions';
import { syncRegionPools } from '../../src/modules/regionPools/regionPoolStore';
import { createEncounterPromotionService } from '../../src/modules/worldEncounters/encounterImportService';
import { buildEncounterPackage } from '../../src/modules/worldEncounters/encounterPackage';
import type { Effect, LoadedEncounter } from '../../src/modules/worldEncounters/types';
import { seededRng } from '../../src/shared/random';
import { bootstrapApp, loadShippedContent, provisionPlayer } from '../helpers/fixtures';
import {
  canonicalProjection,
  legacySeederPoolRows,
  projectRegionPoolsFromContent,
  publishRegionPoolRevisionForTest,
  writeLegacySeederPools,
} from '../helpers/regionPoolFixtures';
import { createTestDb, silentLogger, type TestDb } from '../helpers/testDb';

const ROOT = path.resolve(__dirname, '..', '..');
const logger = silentLogger();
const shipped = loadShippedContent(logger);

/** Every row of every Region Pool table plus the projection, for "nothing changed" checks. */
async function fingerprint(db: TestDb['db']) {
  const [pools, revisions, entries, events, projection] = await Promise.all([
    db.select().from(regionPools).orderBy(asc(regionPools.regionId)),
    db.select().from(regionPoolRevisions).orderBy(asc(regionPoolRevisions.id)),
    db
      .select()
      .from(regionPoolRevisionEntries)
      .orderBy(asc(regionPoolRevisionEntries.revisionId), asc(regionPoolRevisionEntries.position)),
    db.select().from(regionPoolEvents).orderBy(asc(regionPoolEvents.id)),
    canonicalProjection(db),
  ]);
  return { pools, revisions, entries, events, projection };
}

async function eventsOf(db: TestDb['db'], action: string) {
  return db
    .select()
    .from(regionPoolEvents)
    .where(sql`${regionPoolEvents.action} = ${action}`)
    .orderBy(asc(regionPoolEvents.id));
}

function withRegion(content: LoadedContent, id: Region, patch: (r: LoadedContent['regions'][number]) => LoadedContent['regions'][number]): LoadedContent {
  return { ...content, regions: content.regions.map((r) => (r.id === id ? patch(r) : r)) };
}

async function projectedSlugs(db: TestDb['db'], regionId: Region): Promise<Map<string, number>> {
  const rows = await db
    .select({ slug: species.slug, weight: regionEncounterPools.weight })
    .from(regionEncounterPools)
    .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
    .where(eq(regionEncounterPools.regionId, regionId));
  return new Map(rows.map((r) => [r.slug, r.weight]));
}

// ── Clean database ─────────────────────────────────────────────────────────

describe('clean database bootstrap', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('bootstraps all six regions as revision 1 and projects them set-identically to the old seeder', async () => {
    const result = await applyContent(t.db, shipped, logger);
    expect(result.regionPools.bootstrapped.sort()).toEqual([...REGIONS].sort());
    expect(result.regionPools.reprojected.sort()).toEqual([...REGIONS].sort());

    const pools = await t.db.select().from(regionPools);
    expect(pools).toHaveLength(6);
    const revisions = await t.db.select().from(regionPoolRevisions);
    expect(revisions).toHaveLength(6);
    for (const r of revisions) {
      expect(r.number).toBe(1);
      expect(r.source).toBe('bootstrap');
      expect(pools.find((p) => p.regionId === r.regionId)?.publishedRevisionId).toBe(r.id);
    }

    // Parity: the projection against the frozen pre-0069 seeder, (region, slug, weight).
    const legacy = await legacySeederPoolRows(t.db, shipped);
    const projected = await canonicalProjection(t.db);
    expect(projected).toEqual(legacy);
    expect(projected).toHaveLength(280);

    // Each bootstrapped event carries the shipped baseline.
    const bootstrapped = await eventsOf(t.db, 'bootstrapped');
    expect(bootstrapped).toHaveLength(6);
    const valley = bootstrapped.find((e) => e.regionId === 'waifu-valley')!;
    const details = valley.details as {
      shipped: { hash: string; entries: unknown[]; skipped: string[] };
      previousProjection: { entries: number; identical: boolean };
    };
    expect(details.shipped.entries).toHaveLength(100);
    expect(details.shipped.skipped).toEqual([]);
    expect(details.shipped.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    // A fresh database had nothing projected before.
    expect(details.previousProjection.entries).toBe(0);
  });

  it('keeps authored order in revision entries and the draft', async () => {
    const twin = shipped.regions.find((r) => r.id === 'twin-peeks')!;
    const [pool] = await t.db.select().from(regionPools).where(eq(regionPools.regionId, 'twin-peeks'));
    expect(pool!.draftEntries.map((e) => e.species)).toEqual(twin.encounterPool.map((e) => e.species));
    expect(pool!.draftEntries.map((e) => e.weight)).toEqual(twin.encounterPool.map((e) => e.weight));
    const entries = await t.db
      .select({ slug: species.slug })
      .from(regionPoolRevisionEntries)
      .innerJoin(species, eq(regionPoolRevisionEntries.speciesId, species.id))
      .where(eq(regionPoolRevisionEntries.revisionId, pool!.publishedRevisionId!))
      .orderBy(asc(regionPoolRevisionEntries.position));
    expect(entries.map((e) => e.slug)).toEqual(twin.encounterPool.map((e) => e.species));
  });

  it('is idempotent: a repeated start writes nothing', async () => {
    const before = await fingerprint(t.db);
    const again = await applyContent(t.db, shipped, logger);
    expect(again.regionPools.bootstrapped).toEqual([]);
    expect(again.regionPools.reprojected).toEqual([]);
    expect(again.regionPools.shippedDrift).toEqual([]);
    await applyContent(t.db, shipped, logger);
    expect(await fingerprint(t.db)).toEqual(before);
  });

  it('reports full coverage for the shipped content', async () => {
    const result = await syncRegionPools(t.db, shipped, logger);
    expect(result.coverage.unpooledSpecies).toEqual([]);
    expect(result.coverage.emptyTiers).toEqual({});
  });

  it('seedContent alone no longer touches the pools or the projection', async () => {
    const before = await fingerprint(t.db);
    const emptied = { ...shipped, regions: shipped.regions.map((r) => ({ ...r, encounterPool: [] })) };
    await seedContent(t.db, emptied, logger);
    expect(await fingerprint(t.db)).toEqual(before);
  });
});

// ── Populated legacy database ──────────────────────────────────────────────

describe('migrating a populated pre-0069 database', () => {
  let t: TestDb;
  let folder: string;
  beforeAll(async () => {
    // A copy of drizzle/ whose journal stops at 0068.
    folder = mkdtempSync(path.join(os.tmpdir(), 'rp2a-drizzle-'));
    const src = path.join(ROOT, 'drizzle');
    for (const f of readdirSync(src)) {
      if (f.endsWith('.sql') && !f.startsWith('0069_')) copyFileSync(path.join(src, f), path.join(folder, f));
    }
    const journal = JSON.parse(readFileSync(path.join(src, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number }>;
    };
    journal.entries = journal.entries.filter((e) => e.idx < 69);
    const meta = path.join(folder, 'meta');
    mkdirSync(meta);
    writeFileSync(path.join(meta, '_journal.json'), JSON.stringify(journal));
    t = await createTestDb({ migrationsFolder: folder });
  });
  afterAll(async () => {
    await t.cleanup();
    rmSync(folder, { recursive: true, force: true });
  });

  it('0069 adds the tables without touching existing projection rows, then bootstraps with an identical projection', async () => {
    const tables = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_name = 'region_pools'`,
    );
    expect(tables.rows[0]!.n).toBe(0);

    // State as the previous release left it: species seeded, pools written by the old seeder.
    await seedContent(t.db, shipped, logger);
    await writeLegacySeederPools(t.db, shipped);
    const legacySnapshot = await canonicalProjection(t.db);
    const physicalBefore = await t.db.execute(sql`select ctid::text, region_id, species_id, weight from region_encounter_pools order by ctid`);
    expect(legacySnapshot).toHaveLength(280);

    await runMigrations(t.db, logger, path.join(ROOT, 'drizzle'));
    // Schema only: not one projection row was rewritten (same physical tuples).
    const physicalAfterMigration = await t.db.execute(sql`select ctid::text, region_id, species_id, weight from region_encounter_pools order by ctid`);
    expect(physicalAfterMigration.rows).toEqual(physicalBefore.rows);
    expect(await t.db.select().from(regionPools)).toEqual([]);

    const result = await applyContent(t.db, shipped, logger);
    expect(result.regionPools.bootstrapped).toHaveLength(6);
    // The projection already matched the bootstrapped revisions, so no region was rewritten.
    expect(result.regionPools.reprojected).toEqual([]);
    expect(await eventsOf(t.db, 'projection_rebuilt')).toEqual([]);
    const physicalAfterBootstrap = await t.db.execute(sql`select ctid::text, region_id, species_id, weight from region_encounter_pools order by ctid`);
    expect(physicalAfterBootstrap.rows).toEqual(physicalBefore.rows);
    expect(await canonicalProjection(t.db)).toEqual(legacySnapshot);

    for (const event of await eventsOf(t.db, 'bootstrapped')) {
      const d = event.details as { previousProjection: { identical: boolean; entries: number } };
      expect(d.previousProjection.identical).toBe(true);
      expect(d.previousProjection.entries).toBeGreaterThan(0);
    }
  });
});

// ── Ownership after bootstrap ──────────────────────────────────────────────

describe('published pools are authoritative', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await applyContent(t.db, shipped, logger);
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('ignores changed region JSON, reporting drift once per (revision, file)', async () => {
    const before = await canonicalProjection(t.db);
    const edited = withRegion(shipped, 'twin-peeks', (r) => ({
      ...r,
      encounterPool: r.encounterPool.map((e, i) => (i === 0 ? { ...e, weight: 999 } : e)),
    }));
    const first = await applyContent(t.db, edited, logger);
    expect(first.regionPools.shippedDrift).toEqual(['twin-peeks']);
    expect(first.regionPools.bootstrapped).toEqual([]);
    expect(await canonicalProjection(t.db)).toEqual(before);
    expect(await eventsOf(t.db, 'drift_detected')).toHaveLength(1);

    await applyContent(t.db, edited, logger);
    expect(await eventsOf(t.db, 'drift_detected')).toHaveLength(1);
    // Revision 1 is still the only revision for the region.
    const revisions = await t.db.select().from(regionPoolRevisions).where(eq(regionPoolRevisions.regionId, 'twin-peeks'));
    expect(revisions).toHaveLength(1);
  });

  it('projects a newly published revision at the next start, and keeps it across restarts and reloads', async () => {
    const twin = shipped.regions.find((r) => r.id === 'twin-peeks')!;
    const resolved = twin.encounterPool.map((e) => ({ species: e.species, weight: e.weight ?? 1 }));
    // An admin publish (RP2B stand-in): drop the first entry, reweight the second.
    const published = resolved.slice(1).map((e, i) => (i === 0 ? { ...e, weight: e.weight + 7 } : e));
    await publishRegionPoolRevisionForTest(t.db, 'twin-peeks', published);

    const restart = await applyContent(t.db, shipped, logger);
    expect(restart.regionPools.reprojected).toEqual(['twin-peeks']);
    const expected = new Map(published.map((e) => [e.species, e.weight]));
    expect(await projectedSlugs(t.db, 'twin-peeks')).toEqual(expected);
    const rebuilt = await eventsOf(t.db, 'projection_rebuilt');
    expect(rebuilt.at(-1)!.regionId).toBe('twin-peeks');

    // Repeated start: nothing rewritten.
    const again = await applyContent(t.db, shipped, logger);
    expect(again.regionPools.reprojected).toEqual([]);
    expect(await projectedSlugs(t.db, 'twin-peeks')).toEqual(expected);

    // Legacy Reload Content: the real reloader against the real content directory.
    const reload = createContentReloader({
      db: t.db,
      contentDir: path.join(ROOT, 'content'),
      assetsDir: path.join(ROOT, 'assets'),
      logger,
    });
    const reloaded = await reload();
    expect(reloaded.regionPools.bootstrapped).toEqual([]);
    expect(await projectedSlugs(t.db, 'twin-peeks')).toEqual(expected);

    // Shipped JSON now differs from the published pool: drift, never applied.
    expect(reloaded.regionPools.shippedDrift).toContain('twin-peeks');
  });

  it('restores a lost projection from the published revision, not from the region file', async () => {
    const expected = await projectedSlugs(t.db, 'twin-peeks');
    await t.db.delete(regionEncounterPools);
    await applyContent(t.db, shipped, logger);
    expect(await projectedSlugs(t.db, 'twin-peeks')).toEqual(expected);
  });

  it('the test-only content projection is overwritten by the next sync', async () => {
    const authoritative = await canonicalProjection(t.db);
    await projectRegionPoolsFromContent(t.db, shipped);
    expect(await canonicalProjection(t.db)).not.toEqual(authoritative);
    await syncRegionPools(t.db, shipped, logger);
    expect(await canonicalProjection(t.db)).toEqual(authoritative);
  });

  it('refuses to update or delete a published revision or its entries', async () => {
    const [rev] = await t.db.select().from(regionPoolRevisions).limit(1);
    await expect(
      t.db.update(regionPoolRevisions).set({ publishedBy: 'x' }).where(eq(regionPoolRevisions.id, rev!.id)),
    ).rejects.toThrow(/immutable/);
    await expect(t.db.delete(regionPoolRevisions).where(eq(regionPoolRevisions.id, rev!.id))).rejects.toThrow(
      /immutable/,
    );
    await expect(
      t.db
        .update(regionPoolRevisionEntries)
        .set({ weight: 2 })
        .where(eq(regionPoolRevisionEntries.revisionId, rev!.id)),
    ).rejects.toThrow(/immutable/);
    await expect(
      t.db.delete(regionPoolRevisionEntries).where(eq(regionPoolRevisionEntries.revisionId, rev!.id)),
    ).rejects.toThrow(/immutable/);
  });

  it('reports coverage from the projection: emptied tiers and newly unpooled species', async () => {
    // Publish a Thirstlands pool with no LR.
    const rows = await t.db
      .select({ slug: species.slug, rarity: species.rarity, weight: regionEncounterPools.weight })
      .from(regionEncounterPools)
      .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
      .where(eq(regionEncounterPools.regionId, 'thirstlands'));
    const lr = rows.filter((r) => r.rarity === 'LR').map((r) => r.slug);
    expect(lr.length).toBeGreaterThan(0);
    await publishRegionPoolRevisionForTest(
      t.db,
      'thirstlands',
      rows.filter((r) => r.rarity !== 'LR').map((r) => ({ species: r.slug, weight: r.weight })),
    );
    const result = await syncRegionPools(t.db, shipped, logger);
    expect(result.coverage.emptyTiers).toEqual({ thirstlands: ['LR'] });
    const elsewhere = await t.db
      .select({ slug: species.slug })
      .from(regionEncounterPools)
      .innerJoin(species, eq(regionEncounterPools.speciesId, species.id));
    const stillPooled = new Set(elsewhere.map((r) => r.slug));
    expect(result.coverage.unpooledSpecies).toEqual(lr.filter((s) => !stillPooled.has(s)).sort());
  });
});

// ── Released vs unreleased regions ─────────────────────────────────────────

describe('disabled regions', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('bootstraps a disabled region without projecting it, and projects it once released', async () => {
    const hidden = withRegion(shipped, 'base-80085', (r) => ({ ...r, enabled: false }));
    const result = await applyContent(t.db, hidden, logger);
    expect(result.regionPools.bootstrapped).toContain('base-80085');
    expect(result.regionPools.projectedEntries['base-80085']).toBe(0);
    expect((await projectedSlugs(t.db, 'base-80085')).size).toBe(0);
    const [pool] = await t.db.select().from(regionPools).where(eq(regionPools.regionId, 'base-80085'));
    expect(pool!.publishedRevisionId).not.toBeNull();
    // The other five match the old seeder exactly (which also skipped disabled regions).
    expect(await canonicalProjection(t.db)).toEqual(await legacySeederPoolRows(t.db, hidden));

    await applyContent(t.db, shipped, logger);
    expect((await projectedSlugs(t.db, 'base-80085')).size).toBe(30);
    expect(await canonicalProjection(t.db)).toEqual(await legacySeederPoolRows(t.db, shipped));

    // Switching it off again removes the stale projection rows.
    await applyContent(t.db, hidden, logger);
    expect((await projectedSlugs(t.db, 'base-80085')).size).toBe(0);
  });
});

// ── Species edge cases ─────────────────────────────────────────────────────

describe('missing and disabled species', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('keeps a disabled species in the pool (the hunt filters it), and skips a slug with no species row, as the seeder did', async () => {
    const victim = shipped.regions.find((r) => r.id === 'twin-peeks')!.encounterPool[0]!.species;
    let content: LoadedContent = {
      ...shipped,
      species: shipped.species.map((s) => (s.slug === victim ? { ...s, enabled: false } : s)),
    };
    content = withRegion(content, 'twin-peeks', (r) => ({
      ...r,
      encounterPool: [...r.encounterPool, { species: 'no_such_waifu', weight: 3 }],
    }));
    await applyContent(t.db, content, logger);
    expect(await canonicalProjection(t.db)).toEqual(await legacySeederPoolRows(t.db, content));
    expect((await projectedSlugs(t.db, 'twin-peeks')).has(victim)).toBe(true);
    const [event] = await t.db
      .select()
      .from(regionPoolEvents)
      .where(and(eq(regionPoolEvents.regionId, 'twin-peeks'), eq(regionPoolEvents.action, 'bootstrapped')));
    expect((event!.details as { shipped: { skipped: string[] } }).shipped.skipped).toEqual(['no_such_waifu']);
    const [rev] = await t.db.select().from(regionPoolRevisions).where(eq(regionPoolRevisions.regionId, 'twin-peeks'));
    const manifest = rev!.speciesManifest.find((m) => m.species === victim)!;
    expect(manifest.enabled).toBe(false);
  });
});

// ── Transactions and concurrency ───────────────────────────────────────────

describe('atomicity and concurrency', () => {
  it('rolls back bootstrap and every projection write when a later projection fails', async () => {
    const t = await createTestDb();
    try {
      await seedContent(t.db, shipped, logger);
      // Fail the insert for the last canonical region, after five have been written.
      await t.db.execute(sql`
        create function rp2a_fail() returns trigger as $$
        begin
          if new.region_id = 'assteroid-belt' then raise exception 'injected projection failure'; end if;
          return new;
        end $$ language plpgsql`);
      await t.db.execute(sql`create trigger rp2a_fail_trg before insert on region_encounter_pools for each row execute function rp2a_fail()`);
      await expect(syncRegionPools(t.db, shipped, logger)).rejects.toThrow(/injected projection failure/);
      expect(await t.db.select().from(regionPools)).toEqual([]);
      expect(await t.db.select().from(regionPoolRevisions)).toEqual([]);
      expect(await t.db.select().from(regionPoolEvents)).toEqual([]);
      expect(await canonicalProjection(t.db)).toEqual([]);

      await t.db.execute(sql`drop trigger rp2a_fail_trg on region_encounter_pools`);
      await syncRegionPools(t.db, shipped, logger);
      expect(await canonicalProjection(t.db)).toEqual(await legacySeederPoolRows(t.db, shipped));
    } finally {
      await t.cleanup();
    }
  });

  it('serialises concurrent bootstraps: one winner per region, no duplicates, no errors', async () => {
    const t = await createTestDb();
    try {
      await seedContent(t.db, shipped, logger);
      const results = await Promise.all([1, 2, 3, 4].map(() => syncRegionPools(t.db, shipped, logger)));
      const bootstrapped = results.flatMap((r) => r.bootstrapped).sort();
      expect(bootstrapped).toEqual([...REGIONS].sort());
      expect(await t.db.select().from(regionPools)).toHaveLength(6);
      expect(await t.db.select().from(regionPoolRevisions)).toHaveLength(6);
      expect(await eventsOf(t.db, 'bootstrapped')).toHaveLength(6);
      expect(await eventsOf(t.db, 'projection_rebuilt')).toHaveLength(6);
      expect(await canonicalProjection(t.db)).toEqual(await legacySeederPoolRows(t.db, shipped));
    } finally {
      await t.cleanup();
    }
  });
});

// ── World Encounter planner ────────────────────────────────────────────────

describe('World Encounter planner reads the projection', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await applyContent(t.db, shipped, logger);
  });
  afterAll(async () => {
    await t.cleanup();
  });

  function lrSelectorPackage() {
    const effect = {
      type: 'trigger_waifumon_encounter',
      selection: { mode: 'random', poolScope: 'region', rarities: ['LR'] },
    } as Effect;
    const encounter: LoadedEncounter = {
      id: 1,
      slug: 'rp2a_lr_trail',
      name: 'The Trail Ends',
      description: '',
      type: 'discovery',
      rarity: 'common',
      weight: 10,
      lifecycle: 'active',
      huntEligible: true,
      travelEligible: false,
      cooldownSeconds: 0,
      artworkPath: null,
      chainedEncounterSlug: null,
      choicesRequired: true,
      regions: ['base-80085'],
      routes: [],
      choices: [
        {
          id: 11,
          sortOrder: 0,
          label: 'Follow the tracks',
          emoji: null,
          requirements: {},
          check: { type: 'none' },
          successEffects: [effect],
          failureEffects: [],
        },
      ],
      metadata: {},
    };
    return buildEncounterPackage({ encounters: [encounter], vendors: [] });
  }

  it('warns about a region only once its published pool loses the selector candidates', async () => {
    const service = createEncounterPromotionService({ db: t.db, getContent: () => shipped });
    const codes = async () => (await service.preview(lrSelectorPackage())).issues.map((i) => i.code);
    expect(await codes()).not.toContain('selector_region_no_candidates');

    // The region file still lists an LR; the published pool does not.
    const current = await t.db
      .select({ slug: species.slug, rarity: species.rarity, weight: regionEncounterPools.weight })
      .from(regionEncounterPools)
      .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
      .where(eq(regionEncounterPools.regionId, 'base-80085'));
    await publishRegionPoolRevisionForTest(
      t.db,
      'base-80085',
      current.filter((r) => r.rarity !== 'LR').map((r) => ({ species: r.slug, weight: r.weight })),
    );
    await syncRegionPools(t.db, shipped, logger);
    expect(await codes()).toContain('selector_region_no_candidates');
  });
});

// ── Distribution parity through the real hunt draw ─────────────────────────

describe('hunting distribution parity', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  /** Wilson–Hilferty: chi-square statistic → approximate standard-normal z. */
  function chiSquareZ(stat: number, df: number): number {
    const k = 2 / (9 * df);
    return (Math.cbrt(stat / df) - (1 - k)) / Math.sqrt(k);
  }

  it.each([
    ['twin-peeks', 1],
    ['waifu-valley', 40],
  ] as const)('%s at level %i draws species at the analytic rarity-first odds', async (region, level) => {
    const app = await bootstrapApp(t, { huntRng: seededRng(0x5eed + level) });
    const { playerId } = await provisionPlayer(app, 'g-rp2a', `u-${region}`);

    // Analytic odds from the projection the hunt reads and the rarity table it captured.
    const rows = await t.db
      .select({ slug: species.slug, rarity: species.rarity, weight: regionEncounterPools.weight })
      .from(regionEncounterPools)
      .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
      .where(and(eq(regionEncounterPools.regionId, region), eq(species.enabled, true)));
    const table = shipped.tables.hunt.rarityTable.map((r) => ({ ...r }));
    const shift = shipped.tables.progression.rareEncounterShift;
    if (level >= shift.atLevel) {
      for (const r of table) {
        if (r.rarity === shift.fromRarity) r.weight = Math.max(0, r.weight - shift.weightUnits);
        if (r.rarity === shift.toRarity) r.weight += shift.weightUnits;
      }
    }
    const tableTotal = table.reduce((s, r) => s + r.weight, 0);
    const bucketTotal = new Map<string, number>();
    for (const r of rows) bucketTotal.set(r.rarity, (bucketTotal.get(r.rarity) ?? 0) + r.weight);
    const expected = new Map<string, number>();
    for (const r of rows) {
      const p = table.find((x) => x.rarity === r.rarity)!.weight / tableTotal;
      expected.set(r.slug, (p * r.weight) / bucketTotal.get(r.rarity)!);
    }
    expect([...expected.values()].reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9);

    const N = 12_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const picked = await app.hunt.pickSpeciesForSpawn(t.db, playerId, level, region);
      counts.set(picked!.slug, (counts.get(picked!.slug) ?? 0) + 1);
    }
    // Nothing outside the pool is ever drawn (every rarity is covered).
    for (const slug of counts.keys()) expect(expected.has(slug)).toBe(true);

    // Pearson chi-square, pooling species whose expected count is below 5.
    let stat = 0;
    let df = -1;
    let pooledObs = 0;
    let pooledExp = 0;
    for (const [slug, p] of expected) {
      const e = p * N;
      const o = counts.get(slug) ?? 0;
      if (e < 5) {
        pooledObs += o;
        pooledExp += e;
        continue;
      }
      stat += (o - e) ** 2 / e;
      df += 1;
    }
    if (pooledExp > 0) {
      stat += (pooledObs - pooledExp) ** 2 / pooledExp;
      df += 1;
    }
    expect(chiSquareZ(stat, df)).toBeLessThan(3.09); // p > 0.001
  }, 120_000);
});
