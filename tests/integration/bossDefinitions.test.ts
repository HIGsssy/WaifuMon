/**
 * Boss definitions against a real database: how the shipped bosses arrive and
 * are then left alone, authoring and its lifecycle, and — the part that
 * matters to players — what the spawner does with a definition's status,
 * regions and availability schedule.
 *
 * The encounter service is wired the way production wires it: definitions
 * from `boss_definitions`, reward tables from `reward_tables`.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bossDefinitionEvents,
  bossDefinitions,
  bossEncounters,
  bossParticipations,
  guildBossState,
  guilds,
  playerWaifus,
  players,
  rewardTables,
  species,
} from '../../src/db/schema';
import {
  BOSS_DEFINITION_FILE_FORMAT,
  BossDefinitionSchema,
  bootstrapBossDefinitions,
  bossDefinitionFromContent,
  createDatabaseBossDefinitionSource,
} from '../../src/modules/bosses/bossDefinitions';
import {
  createBossDefinitionService,
  type BossDefinitionService,
} from '../../src/modules/bosses/bossDefinitionService';
import { parseBossRewardSnapshot } from '../../src/modules/bosses/bossRewards';
import { ALWAYS_AVAILABLE, type BossScheduleInput } from '../../src/modules/bosses/bossSchedule';
import { createBossScheduler, type BossAnnouncer } from '../../src/modules/bosses/bossScheduler';
import type { BossContent } from '../../src/modules/content/schemas';
import {
  databaseRewardTableSource,
  listBossRewardTableOptions,
  loadShippedRewardTables,
  seedRewardTables,
} from '../../src/modules/rewardTables/rewardTableStore';
import {
  BossDefinitionInUseError,
  BossDefinitionInvalidError,
  BossDefinitionKeyTakenError,
  BossDefinitionStaleError,
  BossSpawnRefusedError,
} from '../../src/shared/errors';
import { seededRng } from '../../src/shared/random';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let definitions: BossDefinitionService;
let guildDbId: number;
let playerId: number;
let shipped: BossContent[];

const TABLE = 'standard-scouting-v1';
const CHANNEL = 'c-boss-defs';
const MINUTE = 60_000;
const ADMIN = 'admin-1';

/** A complete, activatable boss. */
const input = (over: Record<string, unknown> = {}) => ({
  name: 'Made Here',
  affinity: 'primal',
  regions: ['waifu-valley'],
  status: 'active',
  artwork: null,
  rewardTable: TABLE,
  scoutingText: 'It arrives.',
  repelledText: 'It leaves, beaten.',
  unchallengedText: 'It leaves, bored.',
  description: 'A test boss.',
  ...over,
});

const row = async (key: string) =>
  (await t.db.select().from(bossDefinitions).where(eq(bossDefinitions.bossKey, key)))[0];
const eventsFor = async (key: string) =>
  (await definitions.events({ bossKey: key })).map((e) => e.action).reverse();

/** Save a change to a boss through the service, at its current revision. */
async function edit(key: string, change: Record<string, unknown>) {
  const { id: _id, ...current } = BossDefinitionSchema.parse(
    (({ id, name, affinity, regions, status, artwork, rewardTable, scoutingText, repelledText, unchallengedText, description, schedule }) => ({
      id,
      name,
      affinity,
      regions,
      status,
      artwork,
      rewardTable,
      scoutingText,
      repelledText,
      unchallengedText,
      description,
      schedule,
    }))((await definitions.get(key))!),
  );
  const revision = (await definitions.get(key))!.revision;
  return definitions.update(key, { boss: { ...current, ...change }, expectedRevision: revision }, ADMIN);
}

/** Make exactly these bosses Active; everything else Disabled. Returns nothing. */
async function onlyActive(...keys: string[]) {
  await t.db.update(bossDefinitions).set({ status: 'disabled' });
  for (const key of keys) await t.db.update(bossDefinitions).set({ status: 'active' }).where(eq(bossDefinitions.bossKey, key));
}

async function setSchedule(key: string, schedule: BossScheduleInput) {
  await edit(key, { schedule });
}

async function giveBuddy(): Promise<void> {
  const [sp] = await t.db.select({ id: species.id }).from(species).limit(1);
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: sp!.id, level: 5, xp: 0, baseSp: 120 });
  await t.db.update(players).set({ buddyWaifuId: waifu.id }).where(eq(players.id, playerId));
}

function fakeAnnouncer(): BossAnnouncer {
  let next = 1;
  return {
    verifyChannel: async () => ({ missing: [] }),
    postAnnouncement: async () => `m-${next++}`,
    refreshAnnouncement: async () => {},
    publishResults: async () => {},
  };
}
const scheduler = (now: () => Date) =>
  createBossScheduler({ db: t.db, encounters: app.bosses, announcer: fakeAnnouncer(), logger: t.logger, now });

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, {
    bossRng: seededRng(7),
    rewardTables: databaseRewardTableSource,
    bossDefinitions: createDatabaseBossDefinitionSource(),
  });
  await seedRewardTables(t.db, loadShippedRewardTables(CONTENT_DIR));
  ({ guildDbId, playerId } = await provisionPlayer(app, 'g-boss-defs', 'u-boss-defs'));
  shipped = app.content.bosses;
  definitions = createBossDefinitionService({
    db: t.db,
    getShippedIds: () => shipped.map((b) => b.id),
    getEnabledRegions: () => app.content.tables.bossEncounters.regions,
    listRewardTables: listBossRewardTableOptions,
  });
});

afterAll(async () => {
  await t.cleanup();
});

/** Every test starts from the shipped bosses exactly as a first startup leaves them. */
beforeEach(async () => {
  await t.db.delete(bossParticipations);
  await t.db.delete(bossEncounters);
  await t.db.delete(guildBossState);
  await t.db.delete(bossDefinitionEvents);
  await t.db.delete(bossDefinitions);
  await t.db.update(players).set({ buddyWaifuId: null });
  await t.db.delete(playerWaifus);
  await t.db.update(guilds).set({ bossChannelId: CHANNEL }).where(eq(guilds.id, guildDbId));
  await bootstrapBossDefinitions(t.db, shipped);
});

describe('migrating the shipped bosses', () => {
  it('imports every boss from bosses.json with every field intact', async () => {
    const listed = await definitions.list();
    expect(listed.map((b) => b.id)).toEqual(shipped.map((b) => b.id));
    for (const boss of shipped) {
      expect(listed.find((b) => b.id === boss.id), boss.id).toMatchObject({
        id: boss.id,
        name: boss.name,
        affinity: boss.affinity,
        // The file's single region becomes a one-element list.
        regions: [boss.region],
        // `enabled` becomes the lifecycle status.
        status: boss.enabled ? 'active' : 'disabled',
        artwork: boss.artwork,
        rewardTable: boss.rewardTable,
        scoutingText: boss.scoutingText,
        repelledText: boss.repelledText,
        unchallengedText: boss.unchallengedText,
        description: boss.description,
        // No shipped boss had a schedule, so none is restricted by one.
        schedule: ALWAYS_AVAILABLE,
        source: 'bootstrap',
        shipped: true,
        revision: 1,
      });
    }
  });

  it('gives the spawner the same pool the content file gave it', async () => {
    const fromContent = shipped.filter((b) => b.enabled && b.region === 'waifu-valley').map((b) => b.id);
    const diagnostics = await app.bosses.explainSpawn(guildDbId);
    expect(diagnostics.bosses.filter((b) => b.verdict === 'eligible').map((b) => b.definition.id)).toEqual(fromContent);
    expect(diagnostics.bosses.filter((b) => b.verdict === 'not_active').map((b) => b.definition.id)).toEqual(
      shipped.filter((b) => !b.enabled).map((b) => b.id),
    );
  });

  it('records where each definition came from', async () => {
    const [first] = shipped;
    expect(await eventsFor(first!.id)).toEqual(['bootstrap']);
  });
});

describe('bootstrap inserts what is missing and nothing else', () => {
  it('is idempotent', async () => {
    const again = await bootstrapBossDefinitions(t.db, shipped);
    expect(again).toEqual({ created: [], heldBack: [], existing: shipped.length, initial: false });
    expect((await definitions.list()).every((b) => b.revision === 1)).toBe(true);
  });

  it('the first bootstrap is the migration: all of it lands, in file order, with the file\'s statuses', async () => {
    await t.db.delete(bossDefinitionEvents);
    await t.db.delete(bossDefinitions);
    const result = await bootstrapBossDefinitions(t.db, shipped);
    expect(result).toEqual({ created: shipped.map((b) => b.id), heldBack: [], existing: 0, initial: true });
    const rows = await t.db.select().from(bossDefinitions);
    expect(rows.filter((r) => r.status === 'active').map((r) => r.bossKey).sort()).toEqual(
      shipped.filter((b) => b.enabled).map((b) => b.id).sort(),
    );
  });

  it('is all-or-nothing: a bootstrap that fails partway leaves no partial roster behind', async () => {
    await t.db.delete(bossDefinitionEvents);
    await t.db.delete(bossDefinitions);
    // The last boss violates the id CHECK, after every other insert has run.
    const poisoned = [...shipped, { ...shipped[0]!, id: 'Not-A-Valid-Key' }];
    await expect(bootstrapBossDefinitions(t.db, poisoned)).rejects.toThrow();
    expect(await t.db.select().from(bossDefinitions)).toEqual([]);
    // So the next start still sees an empty table and migrates the roster properly.
    expect((await bootstrapBossDefinitions(t.db, shipped)).initial).toBe(true);
  });

  it('two processes starting together insert the roster once, with the file\'s statuses', async () => {
    await t.db.delete(bossDefinitionEvents);
    await t.db.delete(bossDefinitions);
    const [a, b] = await Promise.all([bootstrapBossDefinitions(t.db, shipped), bootstrapBossDefinitions(t.db, shipped)]);
    expect([a.created.length, b.created.length].sort((x, y) => x - y)).toEqual([0, shipped.length]);
    expect(a.heldBack).toEqual([]);
    expect(b.heldBack).toEqual([]);
    expect((await definitions.list()).filter((d) => d.status === 'active')).toHaveLength(shipped.filter((s) => s.enabled).length);
  });

  it('a boss added to the file later is inserted Disabled — a deploy cannot put it into rotation', async () => {
    const added: BossContent = { ...shipped[0]!, id: 'late_arrival', name: 'Late Arrival', enabled: true };
    const result = await bootstrapBossDefinitions(t.db, [...shipped, added]);
    expect(result).toEqual({ created: ['late_arrival'], heldBack: ['late_arrival'], existing: shipped.length, initial: false });
    expect(await row('late_arrival')).toMatchObject({ status: 'disabled', source: 'bootstrap', position: shipped.length });
    expect((await definitions.events({ bossKey: 'late_arrival' }))[0]).toMatchObject({
      action: 'bootstrap',
      details: { status: 'disabled', heldBack: true, initial: false },
    });
    // It is not drawable until an admin activates it.
    await onlyActive();
    await t.db.update(bossDefinitions).set({ status: 'disabled' });
    expect(await app.bosses.spawnIfDue(guildDbId)).toBeNull();
    const activated = await definitions.setStatus('late_arrival', { status: 'active', expectedRevision: 1 }, ADMIN);
    expect(activated!.status).toBe('active');
    expect((await app.bosses.spawnIfDue(guildDbId))!.boss.id).toBe('late_arrival');
  });

  it('reports a shipped boss that never reached the database', async () => {
    expect(await definitions.bootstrapState()).toMatchObject({ definitions: shipped.length, missingShipped: [] });
    await t.db.delete(bossDefinitions).where(eq(bossDefinitions.bossKey, shipped[1]!.id));
    expect((await definitions.bootstrapState()).missingShipped).toEqual([shipped[1]!.id]);
  });

  it('never overwrites a definition an admin has edited, whatever the file says now', async () => {
    const target = shipped.find((b) => b.enabled)!;
    await edit(target.id, { name: 'Renamed In Portal', status: 'disabled', scoutingText: 'Edited prose.' });
    const before = await row(target.id);

    // The file changes the same boss — and still says it is enabled.
    const changedInGit = shipped.map((b) => (b.id === target.id ? { ...b, name: 'Renamed In Git', scoutingText: 'Git prose.' } : b));
    const result = await bootstrapBossDefinitions(t.db, changedInGit);

    expect(result.created).toEqual([]);
    expect(await row(target.id)).toEqual(before);
    expect((await row(target.id))!.name).toBe('Renamed In Portal');
    expect((await row(target.id))!.status).toBe('disabled');
  });

  it('does not bring back a definition created in the Portal, nor touch it', async () => {
    await definitions.create('portal_only', input(), ADMIN);
    const before = await row('portal_only');
    await bootstrapBossDefinitions(t.db, shipped);
    expect(await row('portal_only')).toEqual(before);
  });
});

describe('create, edit and the lifecycle', () => {
  it('creates a boss, lists it last, and records who made it', async () => {
    const created = await definitions.create('made_here', input({ status: 'draft' }), ADMIN);
    expect(created).toMatchObject({ id: 'made_here', status: 'draft', revision: 1, source: 'portal', shipped: false, updatedBy: ADMIN, encounterCount: 0 });
    expect((await definitions.list()).at(-1)!.id).toBe('made_here');
    expect(await eventsFor('made_here')).toEqual(['create']);
  });

  it('refuses an id that is taken, malformed or reserved', async () => {
    await expect(definitions.create(shipped[0]!.id, input(), ADMIN)).rejects.toBeInstanceOf(BossDefinitionKeyTakenError);
    await expect(definitions.create('Not A Slug', input(), ADMIN)).rejects.toBeInstanceOf(BossDefinitionInvalidError);
    await expect(definitions.create('activity', input(), ADMIN)).rejects.toBeInstanceOf(BossDefinitionInvalidError);
  });

  it('lets a draft be incomplete, and says what activation will need', async () => {
    const draft = await definitions.create(
      'half_written',
      { name: 'Half Written', affinity: 'switch', status: 'draft' },
      ADMIN,
    );
    expect(draft.status).toBe('draft');
    const warned = draft.issues.filter((i) => i.severity === 'warning').map((i) => i.path);
    expect(warned).toEqual(expect.arrayContaining(['description', 'scoutingText', 'repelledText', 'unchallengedText', 'regions', 'rewardTable']));
    expect(draft.issues.some((i) => i.severity === 'error')).toBe(false);
  });

  it('validates a boss before activation, and leaves it a draft when it fails', async () => {
    const draft = await definitions.create('half_written', { name: 'Half Written', affinity: 'switch', status: 'draft' }, ADMIN);
    const refused = await definitions
      .setStatus('half_written', { status: 'active', expectedRevision: draft.revision }, ADMIN)
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(BossDefinitionInvalidError);
    expect((refused as BossDefinitionInvalidError).issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['scoutingText', 'regions', 'rewardTable']),
    );
    expect((await row('half_written'))!.status).toBe('draft');
    expect((await row('half_written'))!.revision).toBe(1);

    // The same boss saved as Active directly is refused for the same reasons.
    await expect(definitions.create('also_half', { name: 'Also Half', affinity: 'switch', status: 'active' }, ADMIN)).rejects.toBeInstanceOf(
      BossDefinitionInvalidError,
    );
  });

  it('refuses to activate a boss whose reward table does not exist', async () => {
    await expect(definitions.create('bad_table', input({ rewardTable: 'no-such-table' }), ADMIN)).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: 'rewardTable', severity: 'error' })],
    });
  });

  it('refuses to activate a boss whose schedule can never open again', async () => {
    const past = { dateRange: { kind: 'fixed', start: '2020-10-25', end: '2020-10-31' } };
    await expect(definitions.create('long_gone', input({ schedule: past }), ADMIN)).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: 'schedule', severity: 'error' })],
    });
    // The same schedule is only a warning on a boss that is not active.
    const draft = await definitions.create('long_gone', input({ schedule: past, status: 'disabled' }), ADMIN);
    expect(draft.issues).toEqual([expect.objectContaining({ path: 'schedule', severity: 'warning' })]);
  });

  it('reports schedule problems at the field that has them', async () => {
    const refused = await definitions
      .create('bad_schedule', input({ schedule: { timezone: 'Nowhere/Land', weekly: [] } }), ADMIN)
      .catch((err: unknown) => err);
    expect((refused as BossDefinitionInvalidError).issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['schedule.timezone', 'schedule.weekly']),
    );
  });

  it('moves through Draft → Active → Disabled → Active, recording each change', async () => {
    const draft = await definitions.create('lifecycle', input({ status: 'draft' }), ADMIN);
    const active = await definitions.setStatus('lifecycle', { status: 'active', expectedRevision: draft.revision }, ADMIN);
    const disabled = await definitions.setStatus('lifecycle', { status: 'disabled', expectedRevision: active!.revision }, ADMIN);
    const again = await definitions.setStatus('lifecycle', { status: 'active', expectedRevision: disabled!.revision }, 'admin-2');
    expect([draft.status, active!.status, disabled!.status, again!.status]).toEqual(['draft', 'active', 'disabled', 'active']);
    expect(again).toMatchObject({ revision: 4, updatedBy: 'admin-2' });

    const trail = await definitions.events({ bossKey: 'lifecycle' });
    expect(trail.map((e) => e.action).reverse()).toEqual(['create', 'status', 'status', 'status']);
    expect(trail[0]).toMatchObject({ actor: 'admin-2', details: { from: 'disabled', to: 'active', revision: 4 } });
  });

  it('can always disable a boss, even one that no longer validates', async () => {
    const created = await definitions.create('breaks_later', input(), ADMIN);
    await t.db.update(bossDefinitions).set({ rewardTable: 'deleted-since' }).where(eq(bossDefinitions.bossKey, 'breaks_later'));
    const disabled = await definitions.setStatus('breaks_later', { status: 'disabled', expectedRevision: created.revision }, ADMIN);
    expect(disabled!.status).toBe('disabled');
  });

  it('saves an edit, bumps the revision, and records which fields changed', async () => {
    const target = shipped.find((b) => b.enabled)!.id;
    const saved = await edit(target, { name: 'New Name', description: 'New description.' });
    expect(saved).toMatchObject({ name: 'New Name', description: 'New description.', revision: 2, updatedBy: ADMIN });
    const [latest] = await definitions.events({ bossKey: target });
    expect(latest).toMatchObject({ action: 'update', details: { revision: 2, changed: ['name', 'description'] } });
  });

  it('returns null for a boss that does not exist', async () => {
    expect(await definitions.get('nobody')).toBeNull();
    expect(await definitions.update('nobody', { boss: input(), expectedRevision: 1 }, ADMIN)).toBeNull();
    expect(await definitions.setStatus('nobody', { status: 'disabled', expectedRevision: 1 }, ADMIN)).toBeNull();
    expect(await definitions.delete('nobody', { expectedRevision: 1 }, ADMIN)).toBe(false);
  });
});

describe('revision conflicts', () => {
  it('refuses a save, a status change and a delete that name a stale revision', async () => {
    const created = await definitions.create('contested', input({ status: 'draft' }), ADMIN);
    // Someone else saves first.
    await definitions.update('contested', { boss: input({ status: 'draft', name: 'Theirs' }), expectedRevision: created.revision }, 'admin-2');

    const stale = await definitions
      .update('contested', { boss: input({ status: 'draft', name: 'Mine' }), expectedRevision: created.revision }, ADMIN)
      .catch((err: unknown) => err);
    expect(stale).toBeInstanceOf(BossDefinitionStaleError);
    expect(stale).toMatchObject({ expectedRevision: 1, currentRevision: 2, updatedBy: 'admin-2' });

    await expect(
      definitions.setStatus('contested', { status: 'active', expectedRevision: created.revision }, ADMIN),
    ).rejects.toBeInstanceOf(BossDefinitionStaleError);
    await expect(definitions.delete('contested', { expectedRevision: created.revision }, ADMIN)).rejects.toBeInstanceOf(
      BossDefinitionStaleError,
    );

    // Nothing of the losing writes landed.
    expect(await row('contested')).toMatchObject({ name: 'Theirs', status: 'draft', revision: 2 });
  });
});

describe('duplicate and delete', () => {
  it('duplicates a boss as a draft, schedule included', async () => {
    const source = shipped.find((b) => b.enabled)!.id;
    await setSchedule(source, { timezone: 'America/Toronto', weekly: [{ day: 'sat', allDay: true }] });
    const copy = await definitions.duplicate(source, { id: 'the_copy' }, ADMIN);
    const original = (await definitions.get(source))!;
    expect(copy).toMatchObject({
      id: 'the_copy',
      name: `${original.name} (copy)`,
      status: 'draft',
      schedule: original.schedule,
      rewardTable: original.rewardTable,
      revision: 1,
      shipped: false,
    });
    expect(await eventsFor('the_copy')).toEqual(['duplicate']);
    await expect(definitions.duplicate(source, { id: 'the_copy' }, ADMIN)).rejects.toBeInstanceOf(BossDefinitionKeyTakenError);
    expect(await definitions.duplicate('nobody', { id: 'x' }, ADMIN)).toBeNull();
  });

  it('refuses to delete a boss that ships in Git — it would only come back', async () => {
    const refused = await definitions.delete(shipped[0]!.id, { expectedRevision: 1 }, ADMIN).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(BossDefinitionInUseError);
    expect(refused).toMatchObject({ shipped: true, encounterCount: 0 });
    expect(await row(shipped[0]!.id)).toBeDefined();
  });

  it('refuses to delete a boss with encounter history, and keeps that history', async () => {
    const created = await definitions.create('has_history', input(), ADMIN);
    await onlyActive('has_history');
    const spawn = await app.bosses.forceSpawn(guildDbId, 'has_history');
    await app.bosses.cancel(spawn.encounter.id, 'cancelled_admin');

    const refused = await definitions.delete('has_history', { expectedRevision: created.revision }, ADMIN).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(BossDefinitionInUseError);
    expect(refused).toMatchObject({ shipped: false, encounterCount: 1 });
    expect((await definitions.get('has_history'))!.encounterCount).toBe(1);

    // Disabling is the safe way to retire it, and the history is untouched.
    await definitions.setStatus('has_history', { status: 'disabled', expectedRevision: created.revision }, ADMIN);
    expect((await app.bosses.getEncounter(spawn.encounter.id))!.bossId).toBe('has_history');
  });

  it('deletes a boss that never spawned, and keeps the audit trail', async () => {
    const created = await definitions.create('mistake', input({ status: 'draft' }), ADMIN);
    expect(await definitions.delete('mistake', { expectedRevision: created.revision }, ADMIN)).toBe(true);
    expect(await row('mistake')).toBeUndefined();
    expect(await eventsFor('mistake')).toEqual(['create', 'delete']);
  });
});

describe('export and import', () => {
  it('round-trips: an export imported unchanged changes nothing', async () => {
    const target = shipped.find((b) => b.enabled)!.id;
    await setSchedule(target, {
      timezone: 'America/Toronto',
      weekly: [{ day: 'fri', windows: [{ start: '18:00', end: '23:59' }] }, { day: 'sat', allDay: true }],
      dateRange: { kind: 'yearly', start: '12-01', end: '12-31' },
    });
    const exported = await definitions.export();
    expect(exported.document.format).toBe(BOSS_DEFINITION_FILE_FORMAT);
    expect(exported.document.bosses).toHaveLength(shipped.length);
    // The schedule travels with the definition.
    expect(exported.document.bosses.find((b) => b.id === target)!.schedule.weekly).toHaveLength(2);

    // Through JSON, as a file would be.
    const document = JSON.parse(JSON.stringify(exported.document));
    const plan = await definitions.planImport(document);
    expect(plan.canApply).toBe(true);
    expect(plan.entries.every((e) => e.action === 'unchanged')).toBe(true);
    const before = await definitions.list();
    const result = await definitions.applyImport(document, { conflicts: 'overwrite' }, ADMIN);
    expect(result).toEqual({ created: [], overwritten: [], skipped: [], unchanged: shipped.map((b) => b.id) });
    expect((await definitions.list()).map((b) => [b.id, b.revision])).toEqual(before.map((b) => [b.id, b.revision]));
  });

  it('round-trips into an empty database, reproducing every definition', async () => {
    const target = shipped.find((b) => b.enabled)!.id;
    await setSchedule(target, { timezone: 'Europe/London', dateRange: { kind: 'fixed', start: '2099-10-25', end: '2099-10-31' } });
    const document = JSON.parse(JSON.stringify((await definitions.export()).document));

    await t.db.delete(bossDefinitions);
    const result = await definitions.applyImport(document, { conflicts: 'skip' }, ADMIN);
    expect(result.created).toEqual(shipped.map((b) => b.id));
    expect((await definitions.export()).document).toEqual(document);
    expect((await row(target))!.source).toBe('import');
  });

  it('plans before it writes: create, conflict (with the fields that differ), unchanged', async () => {
    const [a, b] = shipped;
    const document = {
      format: BOSS_DEFINITION_FILE_FORMAT,
      version: 1,
      bosses: [
        { ...bossDefinitionFromContent(a!), name: 'Imported Name', description: 'Imported description.' },
        bossDefinitionFromContent(b!),
        { id: 'brand_new', ...input() },
      ],
    };
    const plan = await definitions.planImport(document);
    expect(plan.canApply).toBe(true);
    expect(plan.entries.map((e) => [e.id, e.action, e.currentRevision])).toEqual([
      [a!.id, 'conflict', 1],
      [b!.id, 'unchanged', 1],
      ['brand_new', 'create', null],
    ]);
    expect(plan.entries[0]!.changedFields).toEqual(['name', 'description']);
    // Planning wrote nothing.
    expect(await row('brand_new')).toBeUndefined();
    expect((await row(a!.id))!.name).toBe(a!.name);
  });

  it('never overwrites an existing boss unless told to: "skip" only inserts', async () => {
    const [a] = shipped;
    const document = [{ ...bossDefinitionFromContent(a!), name: 'Imported Name' }, { id: 'brand_new', ...input() }];
    const result = await definitions.applyImport(document, { conflicts: 'skip' }, ADMIN);
    expect(result).toEqual({ created: ['brand_new'], overwritten: [], skipped: [a!.id], unchanged: [] });
    expect(await row(a!.id)).toMatchObject({ name: a!.name, revision: 1 });
    expect(await row('brand_new')).toMatchObject({ source: 'import', updatedBy: ADMIN });
    expect(await eventsFor('brand_new')).toEqual(['import']);
  });

  it('overwrites only at the revision the plan showed', async () => {
    const [a] = shipped;
    const document = [{ ...bossDefinitionFromContent(a!), name: 'Imported Name' }];
    const plan = await definitions.planImport(document);
    const expectedRevisions = { [a!.id]: plan.entries[0]!.currentRevision! };

    // Overwrite with no revisions named is not an explicit enough instruction.
    await expect(definitions.applyImport(document, { conflicts: 'overwrite' }, ADMIN)).rejects.toBeInstanceOf(BossDefinitionStaleError);

    // Someone edits the boss between the plan and the apply.
    await edit(a!.id, { description: 'Edited in between.' });
    await expect(definitions.applyImport(document, { conflicts: 'overwrite', expectedRevisions }, ADMIN)).rejects.toBeInstanceOf(
      BossDefinitionStaleError,
    );
    expect((await row(a!.id))!.name).toBe(a!.name);

    // Re-planned, it applies.
    const replanned = await definitions.planImport(document);
    const result = await definitions.applyImport(
      document,
      { conflicts: 'overwrite', expectedRevisions: { [a!.id]: replanned.entries[0]!.currentRevision! } },
      ADMIN,
    );
    expect(result.overwritten).toEqual([a!.id]);
    expect(await row(a!.id)).toMatchObject({ name: 'Imported Name', revision: 3 });
    expect((await definitions.events({ bossKey: a!.id }))[0]).toMatchObject({
      action: 'import',
      details: { result: 'overwritten', revision: 3 },
    });
  });

  it('refuses a package with an invalid boss, and writes none of it', async () => {
    const document = [{ id: 'fine_one', ...input() }, { id: 'broken_one', ...input({ rewardTable: 'no-such-table' }) }];
    const plan = await definitions.planImport(document);
    expect(plan.canApply).toBe(false);
    expect(plan.entries.map((e) => e.action)).toEqual(['create', 'invalid']);
    await expect(definitions.applyImport(document, { conflicts: 'skip' }, ADMIN)).rejects.toBeInstanceOf(BossDefinitionInvalidError);
    expect(await row('fine_one')).toBeUndefined();
  });

  it('refuses something that is not a boss package, and a duplicate id inside one', async () => {
    expect((await definitions.planImport({ hello: 'world' })).canApply).toBe(false);
    expect((await definitions.planImport({ format: BOSS_DEFINITION_FILE_FORMAT, version: 99, bosses: [] })).canApply).toBe(false);
    const twice = await definitions.planImport([{ id: 'twin', ...input() }, { id: 'twin', ...input() }]);
    expect(twice.canApply).toBe(false);
    expect(twice.issues[0]!.message).toContain('appears twice');
  });
});

describe('what the spawner draws', () => {
  it('draws only Active bosses', async () => {
    await onlyActive();
    expect(await app.bosses.spawnIfDue(guildDbId)).toBeNull();

    const [first] = shipped;
    await onlyActive(first!.id);
    const spawn = await app.bosses.spawnIfDue(guildDbId);
    expect(spawn!.boss.id).toBe(first!.id);
  });

  it('never draws a draft', async () => {
    await onlyActive();
    await definitions.create('still_a_draft', input({ status: 'draft' }), ADMIN);
    expect(await app.bosses.spawnIfDue(guildDbId)).toBeNull();
  });

  it('draws only bosses assigned to the guild region', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await t.db.update(bossDefinitions).set({ regions: [] }).where(eq(bossDefinitions.bossKey, first!.id));
    expect(await app.bosses.spawnIfDue(guildDbId)).toBeNull();
    expect((await app.bosses.explainSpawn(guildDbId)).bosses.find((b) => b.definition.id === first!.id)!.verdict).toBe('other_region');
  });

  it('draws a boss only inside its availability window', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await setSchedule(first!.id, {
      timezone: 'America/Toronto',
      weekly: [{ day: 'fri', windows: [{ start: '18:00', end: '23:59' }] }],
    });

    // Thursday Oct 8 2026, noon in Toronto.
    expect(await app.bosses.spawnIfDue(guildDbId, new Date('2026-10-08T16:00:00Z'))).toBeNull();
    // Friday 17:59:59 — one second early.
    expect(await app.bosses.spawnIfDue(guildDbId, new Date('2026-10-09T21:59:59Z'))).toBeNull();
    // Friday 18:00 exactly.
    const spawn = await app.bosses.spawnIfDue(guildDbId, new Date('2026-10-09T22:00:00Z'));
    expect(spawn!.boss.id).toBe(first!.id);
    expect(spawn!.encounter.forced).toBe(false);
  });

  it('keeps drawing the bosses that are in season while another is out of it', async () => {
    const [seasonal, regular] = shipped;
    await onlyActive(seasonal!.id, regular!.id);
    await setSchedule(seasonal!.id, { timezone: 'America/Toronto', dateRange: { kind: 'yearly', start: '10-25', end: '10-31' } });

    const june = new Date('2026-06-10T16:00:00Z');
    for (let i = 0; i < 4; i += 1) {
      const spawn = await app.bosses.spawnIfDue(guildDbId, june);
      expect(spawn!.boss.id).toBe(regular!.id);
      await app.bosses.cancel(spawn!.encounter.id, 'cancelled_admin', june);
      await t.db.update(guildBossState).set({ nextSpawnAt: null });
    }
    // In season, both rotate.
    const seen = new Set<string>();
    const halloween = new Date('2026-10-28T16:00:00Z');
    for (let i = 0; i < 2; i += 1) {
      const spawn = await app.bosses.spawnIfDue(guildDbId, halloween);
      seen.add(spawn!.boss.id);
      await app.bosses.cancel(spawn!.encounter.id, 'cancelled_admin', halloween);
      await t.db.update(guildBossState).set({ nextSpawnAt: null });
    }
    expect(seen).toEqual(new Set([seasonal!.id, regular!.id]));
  });

  it('explains every boss with exactly one verdict', async () => {
    const [scheduled, eligible, tableless] = shipped;
    await onlyActive(scheduled!.id, eligible!.id, tableless!.id);
    await setSchedule(scheduled!.id, { timezone: 'America/Toronto', weekly: [{ day: 'fri', allDay: true }] });
    await t.db.update(bossDefinitions).set({ rewardTable: 'gone' }).where(eq(bossDefinitions.bossKey, tableless!.id));

    const thursday = new Date('2026-10-08T16:00:00Z');
    const diagnostics = await app.bosses.explainSpawn(guildDbId, thursday);
    const verdict = (id: string) => diagnostics.bosses.find((b) => b.definition.id === id)!;
    expect(diagnostics.bosses).toHaveLength(shipped.length);
    expect(verdict(eligible!.id).verdict).toBe('eligible');
    expect(verdict(scheduled!.id)).toMatchObject({ verdict: 'outside_schedule', availability: { availableNow: false } });
    expect(verdict(scheduled!.id).availability.nextWindow!.start).toEqual(new Date('2026-10-09T04:00:00Z'));
    expect(verdict(tableless!.id)).toMatchObject({ verdict: 'reward_table_unavailable', detail: 'Reward table "gone" does not exist.' });
    expect(verdict(shipped[3]!.id).verdict).toBe('not_active');
    expect(diagnostics).toMatchObject({ enabled: true, channelConfigured: true, cooldownActive: false, active: null });
  });
});

describe('cooldowns and availability windows', () => {
  it('needs all three: Active, inside the window, and past the cooldown', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await setSchedule(first!.id, { timezone: 'America/Toronto', weekly: [{ day: 'fri', windows: [{ start: '18:00', end: '23:59' }] }] });
    await app.bosses.ensureState(guildDbId);

    const fridayEvening = new Date('2026-10-09T23:00:00Z'); // Fri 19:00
    const cooldownEnds = new Date('2026-10-09T23:30:00Z'); // Fri 19:30
    await t.db.update(guildBossState).set({ nextSpawnAt: cooldownEnds });

    // Active and inside the window — but the cooldown is still running.
    expect(await app.bosses.spawnIfDue(guildDbId, fridayEvening)).toBeNull();
    expect(await app.bosses.explainSpawn(guildDbId, fridayEvening)).toMatchObject({ cooldownActive: true });
    // Past the cooldown and still inside the window.
    expect((await app.bosses.spawnIfDue(guildDbId, cooldownEnds))!.boss.id).toBe(first!.id);
  });

  it('a window opening does not cut a running cooldown short', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await setSchedule(first!.id, { timezone: 'America/Toronto', weekly: [{ day: 'fri', windows: [{ start: '18:00', end: '23:59' }] }] });
    await app.bosses.ensureState(guildDbId);
    // The cooldown was set before the window opened and ends 20 minutes into it.
    const cooldownEnds = new Date('2026-10-09T22:20:00Z');
    await t.db.update(guildBossState).set({ nextSpawnAt: cooldownEnds });

    expect(await app.bosses.spawnIfDue(guildDbId, new Date('2026-10-09T22:00:00Z'))).toBeNull(); // window just opened
    expect(await app.bosses.spawnIfDue(guildDbId, new Date('2026-10-09T22:19:59Z'))).toBeNull();
    expect(await app.bosses.spawnIfDue(guildDbId, cooldownEnds)).not.toBeNull();
  });

  it('a closed window neither resets nor extends the cooldown — the boss spawns as soon as it opens', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await setSchedule(first!.id, { timezone: 'America/Toronto', weekly: [{ day: 'fri', windows: [{ start: '18:00', end: '23:59' }] }] });
    await app.bosses.ensureState(guildDbId);
    const cooldownEnded = new Date('2026-10-08T16:00:00Z'); // Thursday noon
    await t.db.update(guildBossState).set({ nextSpawnAt: cooldownEnded });

    // Due, but nothing is available: every pass until Friday draws nothing…
    for (const iso of ['2026-10-08T16:00:00Z', '2026-10-08T20:00:00Z', '2026-10-09T21:59:00Z']) {
      expect(await app.bosses.spawnIfDue(guildDbId, new Date(iso))).toBeNull();
    }
    // …and writes nothing: the cooldown is exactly what it was.
    const [state] = await t.db.select().from(guildBossState).where(eq(guildBossState.guildId, guildDbId));
    expect(state!.nextSpawnAt).toEqual(cooldownEnded);
    expect(state!.bagState).toBeNull();
    // The first pass inside the window spawns it.
    expect(await app.bosses.spawnIfDue(guildDbId, new Date('2026-10-09T22:00:00Z'))).not.toBeNull();
  });

  it('an encounter that is live when its window closes runs to its normal deadline', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await setSchedule(first!.id, { timezone: 'America/Toronto', weekly: [{ day: 'fri', windows: [{ start: '18:00', end: '18:10' }] }] });
    await giveBuddy();

    // Fri 18:05 — five minutes before the window closes.
    let clock = new Date('2026-10-09T22:05:00Z');
    const loop = scheduler(() => clock);
    await loop.tick();
    const live = (await app.bosses.getActive(guildDbId))!;
    expect(live.status).toBe('scouting');
    const deadline = live.deadlineAt!;
    expect(deadline.getTime() - clock.getTime()).toBe(app.content.tables.bossEncounters.scoutingMinutes * MINUTE);

    // Fri 18:20 — the window closed ten minutes ago. The encounter is untouched…
    clock = new Date('2026-10-09T22:20:00Z');
    await loop.tick();
    expect(await app.bosses.getActive(guildDbId)).toMatchObject({ id: live.id, status: 'scouting', deadlineAt: deadline });
    // …and still takes a commitment.
    await app.bosses.commit(live.id, guildDbId, playerId, { discordUserId: 'u-boss-defs', trainerName: 'Late' }, clock);

    // At its own deadline it resolves and pays, as any encounter does.
    clock = new Date(deadline.getTime() + 1000);
    await loop.tick();
    const finished = (await app.bosses.getEncounter(live.id))!;
    expect(finished).toMatchObject({ status: 'resolved', resolutionReason: 'repelled', participantCount: 1 });
    const [participation] = await t.db.select().from(bossParticipations).where(eq(bossParticipations.encounterId, live.id));
    expect(participation!.rewardStatus).toBe('applied');
    // Nothing new spawns: the window is closed, though the cooldown will run out.
    expect(await app.bosses.getActive(guildDbId)).toBeUndefined();
  });
});

describe('an active encounter does not follow edits to its definition', () => {
  it('keeps the name, affinity, artwork, prose and reward table it was spawned with', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await giveBuddy();
    const spawn = await app.bosses.spawnIfDue(guildDbId);
    const encounter = await app.bosses.beginScouting(spawn!.encounter.id, CHANNEL, 'm-1');
    const before = app.bosses.bossFor(encounter)!;
    const rewardBefore = parseBossRewardSnapshot(encounter.rewardSnapshot)!;
    expect(before).toMatchObject({ scoutingText: first!.scoutingText, repelledText: first!.repelledText });
    expect(encounter.bossSnapshot).toMatchObject({ definitionRevision: 1 });

    // An admin rewrites the boss completely, then disables it, mid-encounter.
    const edited = await edit(first!.id, {
      name: 'Completely Different',
      affinity: first!.affinity === 'switch' ? 'primal' : 'switch',
      artwork: 'bosses/somewhere_else.webp',
      scoutingText: 'New scouting.',
      repelledText: 'New repelled.',
      unchallengedText: 'New unchallenged.',
      description: 'New description.',
      schedule: { timezone: 'America/Toronto', dateRange: { kind: 'fixed', start: '2099-01-01', end: '2099-01-02' } },
    });
    await definitions.setStatus(first!.id, { status: 'disabled', expectedRevision: edited!.revision }, ADMIN);
    // A second read of the source, as the next scheduler pass would do.
    await app.bosses.explainSpawn(guildDbId);

    const live = (await app.bosses.getEncounter(encounter.id))!;
    expect(live).toMatchObject({
      status: 'scouting',
      bossName: first!.name,
      bossAffinity: first!.affinity,
      bossArtwork: first!.artwork,
      deadlineAt: encounter.deadlineAt,
    });
    expect(app.bosses.bossFor(live)).toEqual(before);
    expect(parseBossRewardSnapshot(live.rewardSnapshot)).toEqual(rewardBefore);

    // It still accepts a commitment and pays from its own snapshot.
    await app.bosses.commit(live.id, guildDbId, playerId, { discordUserId: 'u-boss-defs', trainerName: 'Loyal' });
    const result = await app.bosses.resolve(live.id, new Date(live.deadlineAt!.getTime() + 1000));
    expect(result).toMatchObject({ applied: true, reason: 'repelled' });
    expect(result!.participants[0]!.participation.xpAwarded).toBeGreaterThan(0);
    // The next encounter is the edited boss — and it is disabled, so there is none.
    await t.db.update(guildBossState).set({ nextSpawnAt: null });
    expect(await app.bosses.spawnIfDue(guildDbId)).toBeNull();
  });

  it('the next encounter after an edit uses the edited definition', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await edit(first!.id, { name: 'Second Edition', scoutingText: 'Second edition scouting.' });
    const spawn = await app.bosses.spawnIfDue(guildDbId);
    expect(spawn!.encounter).toMatchObject({ bossName: 'Second Edition', bossSnapshot: { definitionRevision: 2 } });
    expect(app.bosses.bossFor(spawn!.encounter)!.scoutingText).toBe('Second edition scouting.');
  });

  it('an encounter from before prose was snapshotted still reads the live definition', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    const spawn = await app.bosses.spawnIfDue(guildDbId);
    await t.db.update(bossEncounters).set({ bossSnapshot: null }).where(eq(bossEncounters.id, spawn!.encounter.id));
    const legacy = (await app.bosses.getEncounter(spawn!.encounter.id))!;
    expect(app.bosses.bossFor(legacy)).toMatchObject({ id: first!.id, scoutingText: first!.scoutingText });
  });
});

describe('reward compatibility', () => {
  it('snapshots the same reward table, version and pools as before, and pays from it', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await giveBuddy();
    const spawn = await app.bosses.spawnIfDue(guildDbId);
    const table = await databaseRewardTableSource.bossTable(t.db, TABLE);
    expect(spawn!.encounter).toMatchObject({ rewardTable: first!.rewardTable, rewardTableVersion: table!.version ?? table!.id });
    expect(parseBossRewardSnapshot(spawn!.encounter.rewardSnapshot)!.table).toEqual(table);

    const encounter = await app.bosses.beginScouting(spawn!.encounter.id, CHANNEL, 'm-1');
    await app.bosses.commit(encounter.id, guildDbId, playerId, { discordUserId: 'u-boss-defs', trainerName: 'Paid' });
    const result = await app.bosses.resolve(encounter.id, new Date(encounter.deadlineAt!.getTime() + 1000));
    const [paid] = result!.participants;
    // The shipped table's guaranteed XP and its one guaranteed item pick.
    expect(paid!.participation.xpAwarded).toBe(table!.buddyXp);
    expect(paid!.rewards.length).toBeGreaterThanOrEqual(1);
    expect(paid!.participation.rewardStatus).toBe('applied');
  });

  it('does not spawn a boss whose reward table is disabled, exactly as before', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await t.db.update(rewardTables).set({ enabled: false }).where(eq(rewardTables.tableId, TABLE));
    const [stored] = await t.db.select().from(rewardTables).where(eq(rewardTables.tableId, TABLE));
    await t.db
      .update(rewardTables)
      .set({ definition: { ...stored!.definition, enabled: false } })
      .where(eq(rewardTables.tableId, TABLE));
    try {
      expect(await app.bosses.spawnIfDue(guildDbId)).toBeNull();
      expect((await app.bosses.explainSpawn(guildDbId)).bosses.find((b) => b.definition.id === first!.id)).toMatchObject({
        verdict: 'reward_table_unavailable',
      });
    } finally {
      await t.db
        .update(rewardTables)
        .set({ enabled: true, definition: { ...stored!.definition, enabled: true } })
        .where(eq(rewardTables.tableId, TABLE));
    }
  });
});

describe('manual spawning', () => {
  const offSeason = new Date('2026-06-10T16:00:00Z');

  async function seasonalBoss() {
    const [first] = shipped;
    await onlyActive(first!.id);
    await setSchedule(first!.id, { timezone: 'America/Toronto', dateRange: { kind: 'yearly', start: '10-25', end: '10-31' } });
    return first!;
  }

  it('goes through the normal spawn path: a forced encounter with its reward and prose snapshots', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    const spawn = await app.bosses.forceSpawn(guildDbId, first!.id);
    expect(spawn).toMatchObject({ scheduleOverridden: false });
    expect(spawn.encounter).toMatchObject({ bossId: first!.id, status: 'scheduled', forced: true, rewardTable: first!.rewardTable });
    expect(parseBossRewardSnapshot(spawn.encounter.rewardSnapshot)).not.toBeNull();
    expect(spawn.encounter.bossSnapshot).toMatchObject({ scoutingText: first!.scoutingText });
    // The rotation and the cooldown are left alone.
    const [state] = await t.db.select().from(guildBossState).where(eq(guildBossState.guildId, guildDbId));
    expect(state).toMatchObject({ bagState: null, nextSpawnAt: null });
  });

  it('refuses a boss outside its schedule unless the override is deliberate', async () => {
    const boss = await seasonalBoss();
    const refused = await app.bosses.forceSpawn(guildDbId, boss.id, offSeason).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(BossSpawnRefusedError);
    expect(refused).toMatchObject({ reason: 'outside_schedule' });
    expect(await app.bosses.getActive(guildDbId)).toBeUndefined();

    const spawn = await app.bosses.forceSpawn(guildDbId, boss.id, offSeason, { ignoreSchedule: true });
    expect(spawn).toMatchObject({ scheduleOverridden: true });
    expect(spawn.encounter).toMatchObject({ bossId: boss.id, forced: true });
  });

  it('the override covers the schedule and nothing else', async () => {
    const boss = await seasonalBoss();
    await t.db.update(bossDefinitions).set({ status: 'disabled' }).where(eq(bossDefinitions.bossKey, boss.id));
    await expect(app.bosses.forceSpawn(guildDbId, boss.id, offSeason, { ignoreSchedule: true })).rejects.toThrow(/No enabled bosses/);

    await t.db.update(bossDefinitions).set({ status: 'active', rewardTable: 'gone' }).where(eq(bossDefinitions.bossKey, boss.id));
    await expect(app.bosses.forceSpawn(guildDbId, boss.id, offSeason, { ignoreSchedule: true })).rejects.toMatchObject({
      reason: 'reward_table_unavailable',
    });
  });

  it('respects the one-active-encounter rule', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await app.bosses.forceSpawn(guildDbId, first!.id);
    await expect(app.bosses.forceSpawn(guildDbId, first!.id)).rejects.toMatchObject({ code: 'BOSS_ENCOUNTER_NOT_OPEN' });
    expect(await app.bosses.listActive(guildDbId)).toHaveLength(1);
  });

  it('an unnamed manual spawn picks only among bosses that are available now', async () => {
    const [seasonal, regular] = shipped;
    await onlyActive(seasonal!.id, regular!.id);
    await setSchedule(seasonal!.id, { timezone: 'America/Toronto', dateRange: { kind: 'yearly', start: '10-25', end: '10-31' } });
    for (let i = 0; i < 5; i += 1) {
      const spawn = await app.bosses.forceSpawn(guildDbId, undefined, offSeason);
      expect(spawn.boss.id).toBe(regular!.id);
      await app.bosses.cancel(spawn.encounter.id, 'cancelled_admin', offSeason);
    }
  });
});

describe('manual termination', () => {
  it('pays whoever committed and leaves the encounter in history', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    await giveBuddy();
    const spawn = await app.bosses.forceSpawn(guildDbId, first!.id);
    const encounter = await app.bosses.beginScouting(spawn.encounter.id, CHANNEL, 'm-1');
    await app.bosses.commit(encounter.id, guildDbId, playerId, { discordUserId: 'u-boss-defs', trainerName: 'Early' });

    const result = await app.bosses.cancel(encounter.id, 'cancelled_admin');
    expect(result).toMatchObject({ applied: true, reason: 'cancelled_admin' });
    expect(result!.participants[0]!.participation.rewardStatus).toBe('applied');
    expect(await app.bosses.getActive(guildDbId)).toBeUndefined();
    expect(await app.bosses.listRecent(guildDbId)).toEqual([
      expect.objectContaining({ id: encounter.id, status: 'resolved', resolutionReason: 'cancelled_admin', participantCount: 1 }),
    ]);
    // Ending an encounter starts the ordinary cooldown.
    const [state] = await t.db.select().from(guildBossState).where(eq(guildBossState.guildId, guildDbId));
    expect(state!.nextSpawnAt!.getTime()).toBeGreaterThan(Date.now());
    // It cannot be ended twice.
    expect(await app.bosses.cancel(encounter.id, 'cancelled_admin')).toBeNull();
  });

  it('cancels an encounter nobody joined, paying nothing', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    const spawn = await app.bosses.forceSpawn(guildDbId, first!.id);
    const result = await app.bosses.cancel(spawn.encounter.id, 'cancelled_admin');
    expect(result!.encounter).toMatchObject({ status: 'cancelled', resolutionReason: 'cancelled_admin', participantCount: 0 });
    expect(result!.participants).toEqual([]);
  });
});

describe('announcing a manual spawn', () => {
  it('the next scheduler pass announces it and opens the window — whichever process created it', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    // Created with no scheduler involved, as the Portal API does.
    const spawn = await app.bosses.forceSpawn(guildDbId, first!.id);
    expect(spawn.encounter).toMatchObject({ status: 'scheduled', messageId: null });
    await scheduler(() => new Date()).tick();
    expect(await app.bosses.getEncounter(spawn.encounter.id)).toMatchObject({
      status: 'scouting',
      channelId: CHANNEL,
      messageId: 'm-1',
    });
  });

  it('does not announce an encounter that was ended after the pass listed it', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    const spawn = await app.bosses.forceSpawn(guildDbId, first!.id);
    let posted = 0;
    const loop = createBossScheduler({
      db: t.db,
      // An admin ends the encounter in the gap between the pass reading its
      // list and reaching this encounter.
      encounters: {
        ...app.bosses,
        findUnannounced: async () => {
          const listed = await app.bosses.findUnannounced();
          await app.bosses.cancel(spawn.encounter.id, 'cancelled_admin');
          return listed;
        },
      },
      announcer: { ...fakeAnnouncer(), postAnnouncement: async () => `m-${++posted}` },
      logger: t.logger,
    });
    await loop.tick();
    expect(posted).toBe(0);
    expect(await app.bosses.getEncounter(spawn.encounter.id)).toMatchObject({ status: 'cancelled', messageId: null });
  });
});

describe('the scheduler reports what it has observed', () => {
  it('records passes as they complete, and nothing before the first one', async () => {
    const [first] = shipped;
    await onlyActive(first!.id);
    const loop = scheduler(() => new Date());
    expect(loop.status()).toMatchObject({ running: false, passes: 0, lastPassStartedAt: null, lastPassCompletedAt: null, lastError: null });
    await loop.tick();
    const status = loop.status();
    expect(status).toMatchObject({ passes: 1, lastPassGuilds: 1, lastPassUsableGuilds: 1, lastError: null });
    expect(status.lastPassCompletedAt).toBeInstanceOf(Date);
    expect(status.lastPassDurationMs).toBeGreaterThanOrEqual(0);
  });
});
