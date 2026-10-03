/**
 * The one-time region-availability compatibility step, against a real
 * database: migration 0053 marks zones stored before `availableRegions`
 * existed, and `backfillDungeonZoneRegions` gives each of them that one field
 * — the shipped zone's regions, or every enabled region — without touching
 * anything else, without weakening divergence protection, and never again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dungeonZones } from '../../src/db/schema';
import { CombatEnemyDefinitionSchema } from '../../src/modules/combat/enemyDefinitions';
import { DungeonEventDefinitionSchema } from '../../src/modules/dungeons/eventDefinitions';
import { createDungeonZoneService } from '../../src/modules/dungeons/dungeonZoneService';
import {
  backfillDungeonZoneRegions,
  reportDungeonRegionBackfill,
  seedDungeonZones,
  type DungeonRegionRef,
  type ShippedDungeonZone,
} from '../../src/modules/dungeons/dungeonZoneStore';
import { dungeonZoneHash, type DungeonZoneDefinition } from '../../src/modules/dungeons/zoneDefinition';
import { testZone } from '../helpers/dungeonFixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;

const REGIONS: DungeonRegionRef[] = [
  { id: 'waifu-valley', name: 'Waifu Valley', enabled: true },
  { id: 'flaccid-foothills', name: 'Flaccid Foothills', enabled: true },
  { id: 'thirstlands', name: 'Thirstlands', enabled: true },
  { id: 'unreleased-isle', name: 'Unreleased Isle', enabled: false },
];
const ENABLED = ['waifu-valley', 'flaccid-foothills', 'thirstlands'];

const shippedZone = (key: string, regions: string[]): ShippedDungeonZone => {
  const definition = testZone({ key, name: `Shipped ${key}`, availableRegions: regions });
  return { key, definition, hash: dungeonZoneHash(definition) };
};
const SHIPPED = [shippedZone('scrapheap', ['flaccid-foothills']), shippedZone('edited_zone', ['thirstlands'])];

/** Content the fixture zone's pools name, so a Portal save of it validates. */
const CONTENT = {
  combatEnemies: ['grunt', 'brute', 'sentinel', 'warden', 'overlord'].map((key) =>
    CombatEnemyDefinitionSchema.parse({ key, name: key, attack: 1, defense: 0, hp: 10, enabled: true }),
  ),
  dungeonEvents: ['shrine', 'trap'].map((key) => DungeonEventDefinitionSchema.parse({ key, name: key, enabled: true })),
  regions: REGIONS,
};

/** A document exactly as a build without the field stored it: no `availableRegions` key at all. */
function preField(zone: DungeonZoneDefinition): Record<string, unknown> {
  const { availableRegions: _dropped, ...rest } = zone;
  return rest;
}

/** The statement migration 0053 runs — taken from the file, so the test cannot drift from it. */
const MARK_PRE_FIELD_ROWS = fs
  .readFileSync(path.resolve(__dirname, '..', '..', 'drizzle', '0053_dungeon_region_compat.sql'), 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .find((s) => s.startsWith('UPDATE "dungeon_zones"'))!;

async function insertRow(
  key: string,
  definition: Record<string, unknown>,
  hashes: { contentHash: string; seedHash: string | null },
  updatedBy = 'admin-1',
): Promise<void> {
  await t.db.insert(dungeonZones).values({
    zoneKey: key,
    enabled: definition.enabled as boolean,
    definition,
    contentHash: hashes.contentHash,
    seedHash: hashes.seedHash,
    position: 0,
    revision: 3,
    updatedBy,
  });
}
const rowOf = async (key: string) => (await t.db.select().from(dungeonZones).where(eq(dungeonZones.zoneKey, key)))[0]!;
const markPreFieldRows = () => t.db.execute(sql.raw(MARK_PRE_FIELD_ROWS));
const backfill = () => backfillDungeonZoneRegions(t.db, SHIPPED, REGIONS);

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await t.db.delete(dungeonZones);
});

describe('migration 0053', () => {
  it('marks exactly the rows whose stored document has no availableRegions key', async () => {
    expect(MARK_PRE_FIELD_ROWS).toContain(`NOT ("definition" ? 'availableRegions')`);
    await insertRow('old_zone', preField(testZone({ key: 'old_zone' })), { contentHash: 'a', seedHash: null });
    await insertRow('new_zone', testZone({ key: 'new_zone' }), { contentHash: 'b', seedHash: null });
    await insertRow('nowhere_zone', testZone({ key: 'nowhere_zone', enabled: false, availableRegions: [] }), {
      contentHash: 'c',
      seedHash: null,
    });
    await markPreFieldRows();
    expect((await rowOf('old_zone')).regionCompat).toBe('pending');
    expect((await rowOf('new_zone')).regionCompat).toBeNull();
    // An explicit empty list is "nowhere", not "missing".
    expect((await rowOf('nowhere_zone')).regionCompat).toBeNull();
  });
});

describe('backfill', () => {
  it('an untouched shipped zone gets its shipped regions and still counts as shipped', async () => {
    const shipped = SHIPPED[0]!;
    await insertRow('scrapheap', preField(shipped.definition), { contentHash: 'old-hash', seedHash: 'old-hash' }, 'seed');
    await markPreFieldRows();

    const result = await backfill();
    expect(result.backfilled).toEqual([
      { key: 'scrapheap', source: 'shipped', regions: ['flaccid-foothills'], origin: 'shipped', revision: 4 },
    ]);
    const row = await rowOf('scrapheap');
    expect(row.definition.availableRegions).toEqual(['flaccid-foothills']);
    expect(row.regionCompat).toBe('shipped');
    // Untouched before, untouched after: the seed sees nothing to do and no divergence.
    expect(row.contentHash).toBe(row.seedHash);
    expect(row.contentHash).toBe(shipped.hash);
    const seed = await seedDungeonZones(t.db, [shipped]);
    expect(seed).toMatchObject({ updated: [], diverged: [], adopted: [], unchanged: 1 });
    expect((await rowOf('scrapheap')).revision).toBe(4);
  });

  it('a diverged zone keeps every edit, gains only the regions, and stays diverged', async () => {
    const shipped = SHIPPED[1]!;
    const edited = preField({
      ...shipped.definition,
      name: 'Renamed By An Admin',
      description: 'Edited in the Portal.',
      rewards: { ...shipped.definition.rewards, defeatCurrencyRetentionBasisPoints: 1234 },
    });
    await insertRow('edited_zone', edited, { contentHash: 'edited-hash', seedHash: 'seeded-hash' }, 'admin-7');
    await markPreFieldRows();
    const before = await rowOf('edited_zone');

    const result = await backfill();
    expect(result.backfilled).toEqual([
      { key: 'edited_zone', source: 'shipped', regions: ['thirstlands'], origin: 'edited', revision: 4 },
    ]);
    const row = await rowOf('edited_zone');
    // The stored document is the old one plus exactly one key.
    expect(row.definition).toEqual({ ...edited, availableRegions: ['thirstlands'] });
    expect(row.definition.name).toBe('Renamed By An Admin');
    // Still an admin edit: the seed hash did not move, the content hash is the document's real one.
    expect(row.seedHash).toBe('seeded-hash');
    expect(row.contentHash).toBe(dungeonZoneHash(row.definition));
    expect(row.contentHash).not.toBe(row.seedHash);
    // Who authored it and when is not rewritten by a compatibility step.
    expect(row.updatedBy).toBe('admin-7');
    expect(row.updatedAt).toEqual(before.updatedAt);

    // Divergence protection is unchanged: the seed reports it and overwrites nothing.
    const seed = await seedDungeonZones(t.db, [shipped]);
    expect(seed.updated).toEqual([]);
    expect(seed.diverged.map((d) => d.key)).toEqual(['edited_zone']);
    expect((await rowOf('edited_zone')).definition.name).toBe('Renamed By An Admin');
  });

  it('a Portal-only zone is opened in every enabled region, and flagged for review until saved', async () => {
    const custom = testZone({ key: 'portal_only', name: 'Made In The Portal' });
    await insertRow('portal_only', preField(custom), { contentHash: 'custom-hash', seedHash: null });
    await markPreFieldRows();

    const result = await backfill();
    expect(result.backfilled).toEqual([
      { key: 'portal_only', source: 'all_enabled_regions', regions: ENABLED, origin: 'custom', revision: 4 },
    ]);
    const row = await rowOf('portal_only');
    // No thematic guess, and never an unreleased region.
    expect(row.definition.availableRegions).toEqual(ENABLED);
    expect(row.seedHash).toBeNull();
    expect(row.regionCompat).toBe('all_enabled_regions');

    const zones = createDungeonZoneService({
      db: t.db,
      getContent: () => CONTENT,
      getShipped: () => SHIPPED,
    });
    const listed = (await zones.list()).find((z) => z.key === 'portal_only')!;
    expect(listed).toMatchObject({ origin: 'custom', availableRegions: ENABLED, regionBackfill: 'all_enabled_regions' });

    // An admin switching it off (any save) has now seen it: the flag clears.
    const saved = await zones.setEnabled('portal_only', { enabled: false, expectedRevision: 4 }, 'admin-2');
    expect(saved).toMatchObject({ regionBackfill: null, revision: 5, availableRegions: ENABLED });
  });

  it('a shipped zone whose shipped copy names no region falls back to every enabled region', async () => {
    const nowhere = shippedZone('scrapheap', []);
    await insertRow('scrapheap', preField(nowhere.definition), { contentHash: 'x', seedHash: 'y' });
    await markPreFieldRows();
    const result = await backfillDungeonZoneRegions(t.db, [nowhere], REGIONS);
    expect(result.backfilled[0]).toMatchObject({ source: 'all_enabled_regions', regions: ENABLED });
  });

  it('leaves a zone that already has regions untouched, even if it was marked', async () => {
    const zone = testZone({ key: 'has_regions', availableRegions: ['thirstlands'] });
    await insertRow('has_regions', zone, { contentHash: 'h', seedHash: null });
    await markPreFieldRows();
    expect((await backfill()).backfilled).toEqual([]);

    // Marked by hand: the mark is cleared and nothing else moves.
    await t.db.update(dungeonZones).set({ regionCompat: 'pending' }).where(eq(dungeonZones.zoneKey, 'has_regions'));
    const result = await backfill();
    expect(result).toEqual({ backfilled: [], alreadyPresent: ['has_regions'], failed: [] });
    const row = await rowOf('has_regions');
    expect(row).toMatchObject({ regionCompat: null, revision: 3, contentHash: 'h' });
    expect(row.definition.availableRegions).toEqual(['thirstlands']);
  });

  it('is one-time: a second run does nothing, and an explicitly empty list is never refilled', async () => {
    await insertRow('portal_only', preField(testZone({ key: 'portal_only' })), { contentHash: 'c', seedHash: null });
    await markPreFieldRows();
    expect((await backfill()).backfilled).toHaveLength(1);

    // An admin now deliberately closes the zone everywhere.
    const zones = createDungeonZoneService({
      db: t.db,
      getContent: () => CONTENT,
      getShipped: () => [],
    });
    const current = (await zones.get('portal_only'))!;
    await zones.update(
      'portal_only',
      { zone: { ...current.zone, enabled: false, availableRegions: [] }, expectedRevision: current.revision },
      'admin-3',
    );
    // A zone created after the migration with no regions at all.
    await insertRow('later_zone', testZone({ key: 'later_zone', enabled: false, availableRegions: [] }), {
      contentHash: 'l',
      seedHash: null,
    });

    for (let i = 0; i < 2; i++) {
      expect(await backfill()).toEqual({ backfilled: [], alreadyPresent: [], failed: [] });
    }
    expect((await rowOf('portal_only')).definition.availableRegions).toEqual([]);
    expect((await rowOf('later_zone')).definition.availableRegions).toEqual([]);
    expect((await rowOf('later_zone')).regionCompat).toBeNull();
    // And an enabled zone with no region is still refused: validation stays strict.
    const issues = await zones.validate({ ...current.zone, enabled: true, availableRegions: [] });
    expect(issues).toContainEqual(expect.objectContaining({ path: 'availableRegions', severity: 'error' }));
  });

  it('reports a marked row it cannot parse and leaves it marked', async () => {
    await insertRow('broken', { key: 'broken', enabled: true, nonsense: true }, { contentHash: 'b', seedHash: null });
    await markPreFieldRows();
    const result = await backfill();
    expect(result.backfilled).toEqual([]);
    expect(result.failed).toEqual([{ key: 'broken', error: expect.any(String) }]);
    expect((await rowOf('broken')).regionCompat).toBe('pending');
  });
});

describe('startup logging', () => {
  it('says what was backfilled, with what, and asks for review where it guessed nothing', () => {
    const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
    const log = (level: string) => (fields: Record<string, unknown>, message: string) => lines.push({ level, fields, message });
    reportDungeonRegionBackfill(
      { info: log('info'), warn: log('warn'), error: log('error') },
      {
        backfilled: [
          { key: 'scrapheap', source: 'shipped', regions: ['flaccid-foothills'], origin: 'edited', revision: 4 },
          { key: 'portal_only', source: 'all_enabled_regions', regions: ENABLED, origin: 'custom', revision: 2 },
        ],
        alreadyPresent: [],
        failed: [{ key: 'broken', error: 'generation: Required' }],
      },
    );
    expect(lines.map((l) => [l.level, l.fields.tag, l.fields.key])).toEqual([
      ['info', 'dungeon-zones/region-backfill', 'scrapheap'],
      ['warn', 'dungeon-zones/region-backfill', 'portal_only'],
      ['error', 'dungeon-zones/region-backfill-failed', 'broken'],
    ]);
    expect(lines[0]!.message).toContain('flaccid-foothills');
    expect(lines[0]!.fields).toMatchObject({ source: 'shipped', origin: 'edited', regions: ['flaccid-foothills'] });
    expect(lines[1]!.message).toMatch(/every enabled region .*Review its regions in Portal Admin/);

    // Nothing to do is silent.
    lines.length = 0;
    reportDungeonRegionBackfill({ info: log('info'), warn: log('warn'), error: log('error') }, { backfilled: [], alreadyPresent: [], failed: [] });
    expect(lines).toEqual([]);
  });
});
