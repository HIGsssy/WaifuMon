/**
 * Equipment content handling against a real database: authoring operations
 * on definitions, the insert-missing startup seed, and package import/export.
 *
 * The shipped seed catalogue is empty in Phase 1, so the seed machinery is
 * exercised here with injected catalogues.
 */
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  equipmentDefinitions,
  equipmentImportLog,
  playerEquipment,
} from '../../src/db/schema';
import { parseEquipmentDefinition } from '../../src/modules/equipment/definitionSchema';
import { EQUIPMENT_PACKAGE_FORMAT } from '../../src/modules/equipment/equipmentPackage';
import { EquipmentImportRejectedError } from '../../src/modules/equipment/equipmentImportService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import {
  EquipmentDefinitionNotFoundError,
  EquipmentDefinitionReferencedError,
  EquipmentImportConflictError,
  EquipmentKeyTakenError,
  EquipmentSlotLockedError,
  EquipmentValidationError,
} from '../../src/shared/errors';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { CONTENT_DIR } from '../helpers/fixtures';
import {
  buildEquipmentServices,
  createPlayer,
  grant,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';

let t: TestDb;
let svc: EquipmentServices;

beforeAll(async () => {
  t = await createTestDb();
  svc = buildEquipmentServices(t.db);
});

afterAll(async () => {
  await t?.cleanup();
});

/** Each test starts from an empty catalogue (instances first — they reference it). */
beforeEach(async () => {
  await t.pool.query('delete from equipment_events');
  await t.pool.query('delete from player_loadout_slots');
  await t.pool.query('delete from player_equipment');
  await t.pool.query('delete from equipment_definitions');
  await t.pool.query('delete from equipment_import_log');
});

const ring = { key: 'spiked_ring', name: 'Spiked Ring', slot: 'attack', rarity: 'R', attackBp: 7_200 };
const belt = { key: 'guard_belt', name: 'Guard Belt', slot: 'defense', rarity: 'N', defenseBp: 4_000 };
const corset = { key: 'tactical_corset', name: 'Tactical Corset', slot: 'health', rarity: 'SR', healthBp: 31_000 };

const pkg = (definitions: unknown[], over: Record<string, unknown> = {}) => ({
  format: EQUIPMENT_PACKAGE_FORMAT,
  version: 1,
  definitions,
  ...over,
});

async function definitionCount(): Promise<number> {
  const [row] = await t.db.select({ n: count() }).from(equipmentDefinitions);
  return row!.n;
}

/** Resolve once some other backend in this database is blocked on a lock. */
async function waitForLockWaiter(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await t.pool.query(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the import never blocked on the competing insert');
}

async function logCount(): Promise<number> {
  const [row] = await t.db.select({ n: count() }).from(equipmentImportLog);
  return row!.n;
}

describe('equipmentDefinitionService', () => {
  it('creates, reads and lists with owned counts', async () => {
    const created = await svc.definitions.create(ring, { actorDiscordId: 'author' });
    expect(created).toMatchObject({ key: 'spiked_ring', attackBp: 7_200, updatedBy: 'author', enabled: true });
    await svc.definitions.create(belt);
    const player = await createPlayer(t.db);
    await grant(t.db, svc, player, 'spiked_ring');
    const removed = await grant(t.db, svc, player, 'spiked_ring');
    await t.db.transaction((tx) =>
      svc.equipment.adminRemove(tx, { playerId: player, equipmentId: removed, reason: 'x', actorDiscordId: 'a' }),
    );

    const all = await svc.definitions.listDefinitions();
    expect(all.map((d) => [d.definition.key, d.ownedCount])).toEqual([
      ['spiked_ring', 1],
      ['guard_belt', 0],
    ]);
    expect((await svc.definitions.listDefinitions({ slot: 'defense' })).map((d) => d.definition.key)).toEqual(['guard_belt']);
    expect((await svc.definitions.listDefinitions({ q: 'SPIKED' })).map((d) => d.definition.key)).toEqual(['spiked_ring']);
    expect(await svc.definitions.getByKey('nope')).toBeNull();
  });

  it('refuses invalid content and duplicate keys', async () => {
    await expect(svc.definitions.create({ ...ring, attackBp: 0 })).rejects.toBeInstanceOf(EquipmentValidationError);
    await svc.definitions.create(ring);
    await expect(svc.definitions.create(ring)).rejects.toBeInstanceOf(EquipmentKeyTakenError);
  });

  it('updates in place, but never renames a key', async () => {
    await svc.definitions.create(ring);
    const updated = await svc.definitions.update('spiked_ring', { ...ring, attackBp: 7_500 }, { actorDiscordId: 'ed' });
    expect(updated).toMatchObject({ attackBp: 7_500, updatedBy: 'ed' });
    await expect(svc.definitions.update('spiked_ring', { ...ring, key: 'renamed' })).rejects.toBeInstanceOf(
      EquipmentValidationError,
    );
    await expect(svc.definitions.update('missing', { ...ring, key: 'missing' })).rejects.toBeInstanceOf(
      EquipmentDefinitionNotFoundError,
    );
  });

  it('allows a slot change only while nobody owns the definition', async () => {
    await svc.definitions.create(ring);
    const moved = { ...ring, slot: 'defense', attackBp: 0, defenseBp: 5_000 };
    await svc.definitions.update('spiked_ring', moved);
    await svc.definitions.update('spiked_ring', ring);
    await grant(t.db, svc, await createPlayer(t.db), 'spiked_ring');
    await expect(svc.definitions.update('spiked_ring', moved)).rejects.toBeInstanceOf(EquipmentSlotLockedError);
    // Other edits to an owned definition are fine.
    await expect(svc.definitions.update('spiked_ring', { ...ring, name: 'Spikier Ring' })).resolves.toMatchObject({
      name: 'Spikier Ring',
    });
  });

  it('enables and disables', async () => {
    await svc.definitions.create(ring);
    expect((await svc.definitions.setEnabled('spiked_ring', false)).enabled).toBe(false);
    await expect(svc.definitions.setEnabled('missing', false)).rejects.toBeInstanceOf(EquipmentDefinitionNotFoundError);
  });

  it('deletes only an unreferenced definition — removed instances still count', async () => {
    await svc.definitions.create(ring);
    await svc.definitions.create(belt);
    await svc.definitions.delete('guard_belt');
    expect(await svc.definitions.getByKey('guard_belt')).toBeNull();

    const player = await createPlayer(t.db);
    const id = await grant(t.db, svc, player, 'spiked_ring');
    await t.db.transaction((tx) =>
      svc.equipment.adminRemove(tx, { playerId: player, equipmentId: id, reason: 'x', actorDiscordId: 'a' }),
    );
    expect(await svc.definitions.referenceBlockers('spiked_ring')).toEqual({ instanceCount: 1 });
    const err = await svc.definitions.delete('spiked_ring').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EquipmentDefinitionReferencedError);
    expect((err as EquipmentDefinitionReferencedError).instanceCount).toBe(1);
    expect(await svc.definitions.getByKey('spiked_ring')).not.toBeNull();
  });
});

describe('seedEquipmentDefinitions', () => {
  const catalogue = [ring, belt].map((d) => parseEquipmentDefinition(d));

  it('inserts missing keys and never touches existing ones', async () => {
    expect(await seedEquipmentDefinitions(t.db, { catalogue })).toEqual({
      created: ['spiked_ring', 'guard_belt'],
      updated: [],
      skipped: [],
    });
    // An admin edits the live definition…
    await svc.definitions.update('spiked_ring', { ...ring, name: 'Admin Renamed', attackBp: 7_900 }, { actorDiscordId: 'admin' });
    const [before] = await t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, 'spiked_ring'));

    // …and a restart re-seeds.
    const again = await seedEquipmentDefinitions(t.db, { catalogue: [...catalogue, parseEquipmentDefinition(corset)] });
    expect(again).toEqual({ created: ['tactical_corset'], updated: [], skipped: ['spiked_ring', 'guard_belt'] });
    const [after] = await t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, 'spiked_ring'));
    expect(after).toEqual(before);
    expect(after).toMatchObject({ name: 'Admin Renamed', attackBp: 7_900, updatedBy: 'admin' });
  });

  it('reset mode overwrites (tests only), but still refuses a slot change on owned gear', async () => {
    await seedEquipmentDefinitions(t.db, { catalogue });
    await svc.definitions.update('spiked_ring', { ...ring, name: 'Edited' });
    expect(await seedEquipmentDefinitions(t.db, { mode: 'reset', catalogue })).toEqual({
      created: [],
      updated: ['spiked_ring', 'guard_belt'],
      skipped: [],
    });
    expect((await svc.definitions.getByKey('spiked_ring'))!.name).toBe('Spiked Ring');

    await grant(t.db, svc, await createPlayer(t.db), 'spiked_ring');
    const moved = parseEquipmentDefinition({ ...ring, slot: 'defense', attackBp: 0, defenseBp: 5_000 });
    await expect(seedEquipmentDefinitions(t.db, { mode: 'reset', catalogue: [moved] })).rejects.toBeInstanceOf(
      EquipmentSlotLockedError,
    );
  });

  it('seeds the shipped (empty) catalogue as a no-op', async () => {
    const shipped = loadEquipmentSeedCatalogue(CONTENT_DIR);
    expect(await seedEquipmentDefinitions(t.db, { catalogue: shipped })).toEqual({ created: [], updated: [], skipped: [] });
    expect(await definitionCount()).toBe(0);
  });
});

describe('package import and export', () => {
  it('previews without writing', async () => {
    const plan = await svc.promotion.previewImport(pkg([ring, belt]));
    expect(plan.counts).toEqual({ create: 2, update: 0, unchanged: 0 });
    expect(await definitionCount()).toBe(0);
    expect(await logCount()).toBe(0);
  });

  it('applies creates and updates in one go, logging exactly what landed', async () => {
    await svc.definitions.create(ring);
    await svc.definitions.create({ ...belt, name: 'Old Belt' });
    const { plan, logId } = await svc.promotion.applyImport(pkg([ring, belt, corset], { label: 'staging 2026-09-30' }), {
      actorDiscordId: 'op',
      sourceFilename: 'gear.json',
    });
    expect(plan.counts).toEqual({ create: 1, update: 1, unchanged: 1 });
    expect((await svc.definitions.getByKey('guard_belt'))!).toMatchObject({ name: 'Guard Belt', updatedBy: 'op' });
    expect(await svc.definitions.getByKey('tactical_corset')).not.toBeNull();
    const [log] = await t.db.select().from(equipmentImportLog).where(eq(equipmentImportLog.id, logId));
    expect(log).toMatchObject({
      actorDiscordUserId: 'op',
      packageFormat: EQUIPMENT_PACKAGE_FORMAT,
      packageVersion: 1,
      packageLabel: 'staging 2026-09-30',
      sourceFilename: 'gear.json',
      createdCount: 1,
      updatedCount: 1,
      unchangedCount: 1,
      definitionKeys: ['guard_belt', 'tactical_corset'],
    });
  });

  it('leaves unchanged definitions untouched on re-import', async () => {
    await svc.promotion.applyImport(pkg([ring]));
    const [before] = await t.db.select().from(equipmentDefinitions);
    const { plan } = await svc.promotion.applyImport(pkg([ring]));
    expect(plan.counts).toEqual({ create: 0, update: 0, unchanged: 1 });
    const [after] = await t.db.select().from(equipmentDefinitions);
    expect(after).toEqual(before);
  });

  it('refuses the whole package when any entry cannot apply — nothing lands, nothing is logged', async () => {
    await svc.definitions.create(ring);
    await grant(t.db, svc, await createPlayer(t.db), 'spiked_ring');
    const moved = { ...ring, slot: 'defense', attackBp: 0, defenseBp: 5_000 };
    const err = await svc.promotion.applyImport(pkg([corset, moved])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EquipmentImportRejectedError);
    expect((err as EquipmentImportRejectedError).issues[0]!.path).toBe('definitions[1].slot');
    expect(await svc.definitions.getByKey('tactical_corset')).toBeNull();
    expect((await svc.definitions.getByKey('spiked_ring'))!.slot).toBe('attack');
    expect(await logCount()).toBe(0);
  });

  it('refuses a malformed package before touching the database', async () => {
    await expect(svc.promotion.applyImport(pkg([{ ...ring, id: 3 }]))).rejects.toBeInstanceOf(EquipmentValidationError);
    await expect(svc.promotion.applyImport(pkg([ring], { version: 2 }))).rejects.toBeInstanceOf(EquipmentValidationError);
    expect(await definitionCount()).toBe(0);
    expect(await logCount()).toBe(0);
  });

  it('never deletes a definition the package omits', async () => {
    await svc.definitions.create(ring);
    await svc.definitions.create(belt);
    await svc.promotion.applyImport(pkg([ring]));
    expect(await definitionCount()).toBe(2);
  });

  it('round-trips: exporting then importing into the same server changes nothing', async () => {
    await svc.definitions.create({ ...ring, tags: ['ring', 'spiky'], regionId: 'base-80085', artworkPath: 'equipment/ring.webp' });
    await svc.definitions.create({ ...belt, shopRegions: ['waifu-valley'], buyPrice: 300 });
    const exported = await svc.promotion.exportPackage({ label: 'round trip' });
    expect(JSON.stringify(exported)).not.toMatch(/"id"/);
    const { plan } = await svc.promotion.applyImport(JSON.parse(JSON.stringify(exported)));
    expect(plan.counts).toEqual({ create: 0, update: 0, unchanged: 2 });
    expect((await svc.promotion.exportPackage({ keys: ['guard_belt'] })).definitions.map((d) => d.key)).toEqual([
      'guard_belt',
    ]);
  });

  it('turns losing a race on a new key into a clean conflict, applying nothing', async () => {
    // Another writer holds an uncommitted insert of `tactical_corset`, so the
    // import's own insert of that key must wait on the unique index — and
    // fail once the other writer commits.
    const other = await t.pool.connect();
    try {
      await other.query('begin');
      await other.query(
        `insert into equipment_definitions (key, name, slot, rarity, health_bp) values ('tactical_corset', 'Theirs', 'health', 'N', 20000)`,
      );
      const importing = svc.promotion.applyImport(pkg([ring, corset])).catch((e: unknown) => e);
      await waitForLockWaiter();
      await other.query('commit');

      const err = await importing;
      expect(err).toBeInstanceOf(EquipmentImportConflictError);
      expect((err as EquipmentImportConflictError).key).toBe('tactical_corset');
      expect((err as EquipmentImportConflictError).code).toBe('EQUIPMENT_IMPORT_CONFLICT');
    } finally {
      other.release();
    }
    // Atomic: the ring this package created first rolled back with it, the
    // other writer's corset is untouched, and no log row claims otherwise.
    expect(await svc.definitions.getByKey('spiked_ring')).toBeNull();
    expect((await svc.definitions.getByKey('tactical_corset'))!.name).toBe('Theirs');
    expect(await logCount()).toBe(0);

    // "Refresh and retry" then succeeds against the server as it now is.
    const retried = await svc.promotion.applyImport(pkg([ring, { ...corset, name: 'Theirs', rarity: 'N', healthBp: 20_000 }]));
    expect(retried.plan.counts).toEqual({ create: 1, update: 0, unchanged: 1 });
  });

  it('lets exactly the winners of parallel identical imports land, and refuses the rest cleanly', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => svc.promotion.applyImport(pkg([ring, belt, corset]))),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThan(0);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(EquipmentImportConflictError);
    const keys = (await t.db.select({ key: equipmentDefinitions.key }).from(equipmentDefinitions)).map((r) => r.key);
    expect(keys.sort()).toEqual(['guard_belt', 'spiked_ring', 'tactical_corset']);
    expect(await logCount()).toBe(fulfilled.length);
  });

  it('imports into an empty server exactly what was exported', async () => {
    await svc.definitions.create(corset);
    const exported = JSON.parse(JSON.stringify(await svc.promotion.exportPackage()));
    await t.pool.query('delete from equipment_definitions');
    await svc.promotion.applyImport(exported);
    const [row] = await t.db.select().from(equipmentDefinitions);
    expect(row).toMatchObject({ key: 'tactical_corset', healthBp: 31_000, rarity: 'SR' });
    const [instances] = await t.db.select({ n: count() }).from(playerEquipment);
    expect(instances!.n).toBe(0);
  });
});
