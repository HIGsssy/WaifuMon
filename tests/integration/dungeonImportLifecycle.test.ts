/**
 * CP-4A: importing into an existing dungeon changes only its draft, against real PostgreSQL.
 *
 * The published revision, the enabled flag, active runs, their frozen
 * dependencies and the published species policy all stay as they were until
 * an administrator publishes the imported draft, which revalidates it here.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonRuns, dungeonSpeciesAcquisitions, species } from '../../src/db/schema';
import type { DungeonDefinition, DungeonSpeciesPolicyEntry } from '../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonLootTableBodySchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { resolveDungeonRewardDependencies } from '../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import { dungeonEncounterSpeciesSlugs, publishedDungeonSpeciesPolicies } from '../../src/modules/dungeons/dungeonSpeciesPolicy';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonRunService';
import { buildDungeonPackage, type DungeonPackage } from '../../src/modules/dungeons/package/dungeonPackage';
import { createSharedDungeonPoolService } from '../../src/modules/dungeons/sharedPools/sharedPoolService';
import type { DungeonImportApplyInput } from '../../src/modules/dungeons/package/dungeonImportService';
import { DungeonUnavailableError } from '../../src/shared/errors';
import { COMMON, CONTRACT, FINITE, RARE, installExclusiveSpecies, namedEncounter } from '../helpers/dungeonCaptureFixtures';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { getItemBySlug } from '../helpers/fixtures';

const EXCLUSIVE = 'gym_oni'; // made dungeon-exclusive with empty dungeonAccess for this file
const ABSENT = 'cp4a_absent_species';

let w: DungeonWorld;
let seq = 0;
const fresh = (prefix: string) => `cp4a_${prefix}_${++seq}`;

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.t.db.update(species).set({ affinity: 'switch' });
  await w.t.db.update(species).set({ tags: ['dungeon_exclusive'] }).where(eq(species.slug, EXCLUSIVE));
  w.speciesAccess.set(EXCLUSIVE, []);
  await installExclusiveSpecies(w);
  w.speciesAccess.set(FINITE, []);
});
afterAll(async () => {
  await w?.cleanup();
});

const coins = DungeonLootTableBodySchema.parse({
  guaranteed: [{ id: 'cash', grant: { type: 'currency', currency: 'waifubux', amount: { min: 5, max: 5 } } }],
  chances: [],
  pools: [],
});

/** A package of `definition` as another environment would export it; species evidence is read from here. */
async function packageOf(definition: DungeonDefinition, lootTable?: string): Promise<DungeonPackage> {
  const slugs = dungeonEncounterSpeciesSlugs(definition);
  const rows = slugs.length ? await w.t.db.select().from(species) : [];
  const evidence = new Map(slugs.map((slug) => {
    const row = rows.find((r) => r.slug === slug);
    return [slug, {
      slug, rarity: (row?.rarity ?? 'N') as 'N', enabled: row?.enabled ?? true,
      regionExclusive: row?.tags.includes('region_exclusive') ?? false,
      dungeonExclusive: row?.tags.includes('dungeon_exclusive') ?? false,
      dungeonAccess: [...(w.speciesAccess.get(slug) ?? [])],
    }];
  }));
  const rewardSnapshot = lootTable
    ? resolveDungeonRewardDependencies(definition, { lootTables: new Map([[lootTable, { name: 'Coins', body: coins, revision: 1, archivedAt: null }]]) }).snapshot ?? undefined
    : undefined;
  return buildDungeonPackage({
    definition, rewardSnapshot, species: evidence,
    source: { environment: 'staging', origin: 'draft', draftRevision: 1, publishedRevision: null },
  });
}
async function request(p: DungeonPackage, allowMissingDependencies = false): Promise<DungeonImportApplyInput> {
  const plan = await w.content.planImport(p);
  expect(plan.validPackage, JSON.stringify(plan.issues)).toBe(true);
  return {
    package: p, requestId: randomUUID(), expectedPlanHash: plan.planHash!, expectedRevision: plan.target!.expectedRevision,
    decisions: {
      dungeon: plan.target!.status === 'new' ? 'create' : plan.target!.status === 'identical' ? 'unchanged' : 'replace',
      enemies: {}, lootTables: {}, allowMissingDependencies,
    },
  };
}
async function state() {
  const result: Record<string, unknown> = {};
  for (const name of ['dungeon_definitions', 'dungeon_revisions', 'dungeon_runs', 'dungeon_content_events', 'dungeon_import_history', 'dungeon_loot_tables', 'dungeon_species_acquisitions', 'dungeon_species_pools', 'dungeon_species_pool_events'])
    result[name] = (await w.t.pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]') AS rows FROM "${name}" t`)).rows[0].rows;
  return result;
}
const runRow = async (id: number) => (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, id)))[0]!;
const renamed = (d: DungeonDefinition, name: string): DungeonDefinition => ({ ...d, name });
const nextDay = () => { w.clock.now = new Date(w.clock.now.getTime() + 86_400_000); };
const give = async (playerId: number, slug: string, quantity: number) =>
  w.app.inventory.addItem(w.t.db, playerId, (await getItemBySlug(w.t.db, slug)).id, quantity);
const ledger = (key: string) => w.t.db.select().from(dungeonSpeciesAcquisitions).where(eq(dungeonSpeciesAcquisitions.dungeonKey, key)).orderBy(asc(dungeonSpeciesAcquisitions.id));
async function capture(playerId: number, run: DungeonRunView) {
  const selected = (await w.act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
  return w.act(playerId, selected, { type: 'capture' });
}
const end = async (playerId: number, run: DungeonRunView) => {
  if (run.status === 'active') await w.act(playerId, run, { type: 'abandon' });
};

describe('A. updating a live dungeon', () => {
  it('keeps revision 1 live for existing and new runs until the imported draft is explicitly published', async () => {
    const key = fresh('live');
    const v1 = renamed(namedEncounter(key, COMMON), 'Live v1');
    const { revision: r1 } = await w.publish(v1);
    expect(await w.content.get(key)).toMatchObject({ enabled: true, open: true });
    const first = await w.player();
    const early = await w.runs.start(first.playerId, key);
    const earlyRow = await runRow(early.id);
    expect(earlyRow.revisionId).toBe(r1.revisionId);

    const v2 = renamed(namedEncounter(key, RARE), 'Live v2');
    const plan = await w.content.planImport(await packageOf(v2));
    expect(plan.target).toMatchObject({ status: 'different', enabled: true, publishedRevision: r1.number });
    expect(plan.target!.changedFields).not.toContain('publication');
    expect(plan.target!.changedFields).not.toContain('enabled');
    const imported = await w.content.applyImport(await request(await packageOf(v2)), 'importer');
    expect(imported).toMatchObject({ result: 'replaced', draftRevision: 2, enabled: true, publishedRevision: r1.number, publishable: true });

    // Administrators see the new draft; players still get revision 1.
    expect(await w.content.get(key)).toMatchObject({ enabled: true, open: true, draft: v2, published: { revisionId: r1.revisionId }, draftDiffers: true });
    expect((await w.content.openDungeons()).find((d) => d.row.dungeonKey === key)!.definition).toEqual(v1);
    expect(await runRow(early.id)).toEqual(earlyRow);
    expect((await w.restartedRuns().run(first.playerId, early.id)).core.action?.encounter).toMatchObject({ species: COMMON });
    const second = await w.player();
    const during = await w.runs.start(second.playerId, key);
    expect((await runRow(during.id)).revisionId).toBe(r1.revisionId);
    expect(during.core.action?.encounter).toMatchObject({ species: COMMON });
    const duringRow = await runRow(during.id);

    // Publication is a separate, revalidated action that needs the imported draft's revision.
    await expect(w.content.publish(key, { expectedRevision: 1 }, 'publisher')).rejects.toMatchObject({ code: 'DUNGEON_DRAFT_STALE' });
    const { revision: r2 } = await w.content.publish(key, { expectedRevision: imported.draftRevision }, 'publisher');
    expect(r2.number).toBe(r1.number + 1);
    const third = await w.player();
    const after = await w.runs.start(third.playerId, key);
    expect((await runRow(after.id)).revisionId).toBe(r2.revisionId);
    expect(after.core.action?.encounter).toMatchObject({ species: RARE });
    expect(await runRow(early.id)).toEqual(earlyRow);
    expect(await runRow(during.id)).toEqual(duringRow);
    expect((await w.restartedRuns().run(second.playerId, during.id)).core.action?.encounter).toMatchObject({ species: COMMON });
  });
});

describe('B. dungeon-exclusive WaifuMon', () => {
  const entry = (s: string, perPlayerLimit: number | 'unlimited', directRescue?: boolean): DungeonSpeciesPolicyEntry =>
    ({ species: s, perPlayerLimit, ...(directRescue === undefined ? {} : { directRescue }) });
  it('keeps the published acquisition terms, limits and ledger; draft-only terms grant nothing until published', async () => {
    const key = fresh('exclusive');
    const v1 = { ...namedEncounter(key, EXCLUSIVE), speciesPolicies: [entry(EXCLUSIVE, 1)] };
    await w.publish(v1);
    // One acquisition already on the ledger before the import.
    const earlier = await w.player();
    await give(earlier.playerId, CONTRACT, 1);
    nextDay();
    const earlierRun = await w.runs.start(earlier.playerId, key);
    expect((await capture(earlier.playerId, earlierRun)).encounterReceipts?.[0]).toMatchObject({ acquired: { speciesSlug: EXCLUSIVE } });
    const player = await w.player();
    await give(player.playerId, CONTRACT, 2);
    const run = await w.runs.start(player.playerId, key);
    expect(run.core.action?.encounter).toMatchObject({ species: EXCLUSIVE, available: true });

    // The draft loosens her limit, allows Direct Rescue and adds a second exclusive species.
    const v2 = namedEncounter(key, EXCLUSIVE);
    v2.rooms[0]!.actions.push({ ...v2.rooms[0]!.actions[0]!, id: 'meet_draft', source: { kind: 'species', species: FINITE } } as never);
    v2.speciesPolicies = [entry(EXCLUSIVE, 5, true), entry(FINITE, 'unlimited')];
    const p = await packageOf(v2);
    const plan = await w.content.planImport(p);
    expect(plan.publishable, JSON.stringify(plan.issues)).toBe(true);
    const ledgerBefore = await ledger(key);
    await w.content.applyImport(await request(p), 'importer');
    expect(await ledger(key)).toEqual(ledgerBefore);
    expect((await w.content.get(key))!.draft.speciesPolicies).toEqual(v2.speciesPolicies);
    // Runtime authority is still revision 1, exactly: no FINITE, no Direct Rescue, limit 1.
    expect(await publishedDungeonSpeciesPolicies(w.t.db, key)).toEqual([entry(EXCLUSIVE, 1)]);

    // The run started before the import can still acquire her under those terms...
    const result = await capture(player.playerId, run);
    expect(result.encounterReceipts?.[0]).toMatchObject({ acquired: { speciesSlug: EXCLUSIVE } });
    await end(player.playerId, result.run);
    expect(await ledger(key)).toHaveLength(ledgerBefore.length + 1);
    // ...and the published limit of 1, not the draft's 5, is what stops the next run.
    nextDay();
    const again = await w.runs.start(player.playerId, key);
    const [row] = await w.t.db.select().from(dungeonRuns).where(and(eq(dungeonRuns.id, again.id)));
    expect((row!.encounterStates as Record<string, { status: string; unavailableReason?: string }>)['hall:meet']).toMatchObject({ status: 'unavailable', unavailableReason: 'player_limit' });
    // A run on revision 1 never presents the draft-only species.
    expect(Object.keys(row!.encounterStates as Record<string, unknown>)).not.toContain('hall:meet_draft');
    await end(player.playerId, again);

    // Only an explicit publish makes the draft's terms live.
    await w.content.publish(key, { expectedRevision: 2 }, 'publisher');
    expect(await publishedDungeonSpeciesPolicies(w.t.db, key)).toEqual(v2.speciesPolicies);
  });
});

describe('C/D. disabled and unpublished targets', () => {
  it('C: a disabled, published dungeon stays disabled and closed to new runs, keeping its revision', async () => {
    const key = fresh('disabled');
    const v1 = namedEncounter(key, COMMON);
    const { revision } = await w.publish(v1);
    await w.content.setEnabled(key, false, 'operator');
    const result = await w.content.applyImport(await request(await packageOf(renamed(v1, 'Disabled update'))), 'importer');
    expect(result).toMatchObject({ result: 'replaced', enabled: false, publishedRevision: revision.number });
    expect(await w.content.get(key)).toMatchObject({ enabled: false, open: false, published: { revisionId: revision.revisionId }, draft: { name: 'Disabled update' } });
    expect((await w.content.openDungeons()).some((d) => d.row.dungeonKey === key)).toBe(false);
    const { playerId } = await w.player();
    await expect(w.runs.start(playerId, key)).rejects.toBeInstanceOf(DungeonUnavailableError);
  });
  it('D: an unpublished dungeon receives the draft and stays unpublished', async () => {
    const key = fresh('unpublished');
    const v1 = namedEncounter(key, COMMON);
    await w.content.create({ definition: v1 }, 'author');
    const plan = await w.content.planImport(await packageOf(renamed(v1, 'Unpublished update')));
    expect(plan.target).toMatchObject({ status: 'different', enabled: true, publishedRevision: null });
    const result = await w.content.applyImport(await request(await packageOf(renamed(v1, 'Unpublished update'))), 'importer');
    expect(result).toMatchObject({ result: 'replaced', enabled: true, publishedRevision: null });
    expect(await w.content.get(key)).toMatchObject({ published: null, open: false, draft: { name: 'Unpublished update' } });
    expect(await w.content.revisions(key)).toEqual([]);
  });
});

describe('E/G. incomplete drafts, rollback and stale reviews', () => {
  async function liveWithMissingUpdate() {
    const key = fresh('repair');
    const loot = fresh('loot');
    const v1 = namedEncounter(key, COMMON);
    const { revision } = await w.publish(v1);
    // A complete-looking update that needs a new loot table and a species this environment lacks.
    const v2 = singleRoomDungeon([
      { id: 'meet', type: 'wild_encounter', source: { kind: 'species', species: ABSENT }, intro: 'Unknown.', capture: {} },
      { id: 'chest', type: 'reward', rewards: { guaranteed: [], chances: [], tables: [{ id: 'draw', table: loot, draws: 1 }] } },
    ], (d) => { d.key = key; d.rooms[0]!.extraction = true; });
    return { key, loot, v1, v2, revision, pkg: await packageOf(v2, loot) };
  }
  it('E/G: a refused apply rolls back completely; an approved repair draft cannot touch the live dungeon or be published', async () => {
    const { key, loot, v1, v2, revision, pkg } = await liveWithMissingUpdate();
    expect(pkg.schemaVersion).toBe(4);
    const plan = await w.content.planImport(pkg);
    expect(plan.lootTables).toMatchObject([{ key: loot, decision: { action: 'create' } }]);
    expect(plan.encounterDependencies!.requiredSpecies).toMatchObject([{ slug: ABSENT, status: 'missing' }]);
    const before = await state();
    // Missing dependencies stay enforced: the loot table it would have created is rolled back too.
    await expect(w.content.applyImport(await request(pkg), 'importer')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
    expect(await state()).toEqual(before);

    const repair = await w.content.applyImport(await request(pkg, true), 'importer');
    expect(repair).toMatchObject({ result: 'replaced', publishable: false, enabled: true, publishedRevision: revision.number, createdLootTables: [loot] });
    expect(await w.content.get(key)).toMatchObject({ enabled: true, open: true, published: { revisionId: revision.revisionId }, draft: v2 });
    const { playerId } = await w.player();
    const run = await w.runs.start(playerId, key);
    expect((await runRow(run.id)).revisionId).toBe(revision.revisionId);
    expect(run.core.action?.encounter).toMatchObject({ species: COMMON });
    const beforePublish = await state();
    await expect(w.content.publish(key, { expectedRevision: repair.draftRevision }, 'publisher')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
    expect(await state()).toEqual(beforePublish);
    expect((await w.content.openDungeons()).find((d) => d.row.dungeonKey === key)!.definition).toEqual(v1);
  });
  it('G: a publish, rollback, enable/disable or draft edit after review makes the plan stale; exact retries replay', async () => {
    const key = fresh('stale');
    const v1 = namedEncounter(key, COMMON);
    await w.publish(v1);
    await w.content.saveDraft(key, { definition: renamed(v1, 'Second'), expectedRevision: 1 }, 'author');
    await w.content.publish(key, { expectedRevision: 2 }, 'publisher');
    const p = await packageOf(renamed(v1, 'Imported'));

    // Rollback moves only the published pointer; the draft revision is unchanged.
    let reviewed = await request(p);
    await w.content.rollback(key, { revision: 1 }, 'operator');
    let before = await state();
    await expect(w.content.applyImport(reviewed, 'importer')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
    expect(await state()).toEqual(before);

    // A fresh publish (here of a rollback target) likewise.
    reviewed = await request(p);
    await w.content.rollback(key, { revision: 2 }, 'operator');
    await expect(w.content.applyImport(reviewed, 'importer')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });

    for (const enabled of [false, true]) {
      reviewed = await request(p);
      await w.content.setEnabled(key, enabled, 'operator');
      before = await state();
      await expect(w.content.applyImport(reviewed, 'importer')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
      expect(await state()).toEqual(before);
    }

    reviewed = await request(p);
    await w.content.saveDraft(key, { definition: renamed(v1, 'Concurrent edit'), expectedRevision: 2 }, 'author');
    await expect(w.content.applyImport(reviewed, 'importer')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
    expect((await w.content.get(key))!.draft.name).toBe('Concurrent edit');

    reviewed = await request(p);
    const applied = await w.content.applyImport(reviewed, 'importer');
    expect(applied).toMatchObject({ result: 'replaced', replayed: false, enabled: true, publishedRevision: 2 });
    before = await state();
    expect(await w.content.applyImport(reviewed, 'importer')).toEqual({ ...applied, replayed: true });
    expect(await state()).toEqual(before);
    // The import audit records the preserved state.
    const history = await w.content.history(key);
    expect(history.find((e) => e.action === 'imported')!.details).toMatchObject({ result: 'replaced', enabled: true, publishedRevision: 2 });
  });
});

describe('F. supported package versions', () => {
  const loot = () => createDungeonLootTableService({ db: w.t.db });
  const fixtures: Record<1 | 2 | 3 | 4, (key: string, table: string) => DungeonDefinition> = {
    1: (key) => singleRoomDungeon([], (d) => { d.key = key; d.rooms[0]!.extraction = true; }),
    2: (key, table) => singleRoomDungeon([{ id: 'chest', type: 'reward', rewards: { guaranteed: [], chances: [], tables: [{ id: 'draw', table, draws: 1 }] } }], (d) => { d.key = key; }),
    3: (key) => singleRoomDungeon([{ id: 'story', type: 'event', source: { kind: 'event', eventId: 'gate' } }], (d) => {
      d.key = key; d.flags = [];
      d.events = [{ id: 'gate', title: 'A gate', text: 'It creaks.', choices: [{ id: 'push', label: 'Push', outcome: { text: 'Open.' } }, { id: 'leave', label: 'Leave', outcome: { text: 'Later.' } }] }];
    }),
    4: (key) => namedEncounter(key, COMMON),
  };
  it.each([1, 2, 3, 4] as const)('v%i: new imports are disabled/unpublished; replacements keep the live revision and lose no content', async (version) => {
    const key = fresh(`v${version}`);
    const table = fresh('table');
    if (version === 2) await loot().create({ key: table, name: 'Coins', body: coins }, 'author');
    const original = fixtures[version](key, table);

    const fresher = fresh(`v${version}_new`);
    const created = await w.content.applyImport(await request(await packageOf({ ...fixtures[version](fresher, table) }, version === 2 ? table : undefined)), 'importer');
    expect(created).toMatchObject({ result: 'created', enabled: false, publishedRevision: null });
    expect(await w.content.get(fresher)).toMatchObject({ enabled: false, published: null });

    const { revision } = await w.publish(original);
    const changed = renamed(original, `${original.name} (imported)`);
    const p = await packageOf(changed, version === 2 ? table : undefined);
    expect(p.schemaVersion).toBe(version);
    const result = await w.content.applyImport(await request(p), 'importer');
    expect(result).toMatchObject({ result: 'replaced', enabled: true, publishedRevision: revision.number });
    const detail = (await w.content.get(key))!;
    expect(detail).toMatchObject({ enabled: true, open: true, published: { revisionId: revision.revisionId }, draftHash: p.contentHash });
    expect(detail.draft).toEqual(changed);
    expect((await w.content.revision(key, revision.number))!.content).toEqual(original);
  });
});

describe('shared Dungeon WaifuMon Pools', () => {
  const sharing = (key: string, sharedPoolKey: string) => singleRoomDungeon([
    { id: 'meet', type: 'wild_encounter', source: { kind: 'pool', poolId: 'p' }, intro: 'Hello.', capture: {} } as never,
  ], (d) => { d.key = key; d.rooms[0]!.extraction = true; d.speciesPools = [{ id: 'p', name: 'Shared', sharedPoolKey, entries: [] }]; });
  it('an import neither mutates the referenced pool nor any frozen run copy; missing pools are still reported', async () => {
    const poolKey = fresh('pool');
    await createSharedDungeonPoolService(w.t.db).create({ key: poolKey, name: 'Shared', description: 'CP-4A', enabled: true,
      entries: [{ id: 'species', species: COMMON, weight: 1, oncePerRun: true }] }, 'author');
    const key = fresh('shared');
    const { revision } = await w.publish(sharing(key, poolKey));
    const { playerId } = await w.player();
    const run = await w.runs.start(playerId, key);
    const runBefore = await runRow(run.id);
    const poolsBefore = { pools: (await state()).dungeon_species_pools, events: (await state()).dungeon_species_pool_events };

    await w.content.applyImport(await request(await packageOf(renamed(sharing(key, poolKey), 'Shared update'))), 'importer');
    expect({ pools: (await state()).dungeon_species_pools, events: (await state()).dungeon_species_pool_events }).toEqual(poolsBefore);
    expect(await runRow(run.id)).toEqual(runBefore);
    const other = await w.player();
    const later = await w.runs.start(other.playerId, key);
    expect((await runRow(later.id)).revisionId).toBe(revision.revisionId);

    const missing = await w.content.planImport(await packageOf(sharing(key, fresh('absent_pool'))));
    expect(missing.publishable).toBe(false);
    expect(missing.issues.some((i) => i.severity === 'error' && i.path.includes('sharedPoolKey')), JSON.stringify(missing.issues)).toBe(true);
  });
});
