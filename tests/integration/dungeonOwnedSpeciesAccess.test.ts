/**
 * Dungeon-owned Species access, against real PostgreSQL.
 *
 * A `dungeon_exclusive` species with no `dungeonAccess` in her content is
 * admitted to a dungeon by that dungeon's own `speciesPolicies`, published with
 * its revision. These cases pin who decides (the published revision, never a
 * draft or another dungeon), how it combines with legacy species content (the
 * stricter terms win), and that the per-player/species/dungeon ledger is the
 * single limit across pools, specific encounters, revisions, rollbacks and
 * runs already in progress.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonRuns, dungeonSpeciesAcquisitions, playerInventory, playerWaifus, species, type SpeciesRow } from '../../src/db/schema';
import type { DungeonDefinition, DungeonSpeciesPolicyEntry } from '../../src/modules/dungeons/content/dungeonDefinition';
import type { DungeonActionResult, DungeonRunView } from '../../src/modules/dungeons/dungeonRunService';
import type { DungeonInput } from '../../src/modules/dungeons/engine/types';
import { DungeonPackageV4Schema } from '../../src/modules/dungeons/package/dungeonPackage';
import { DungeonInvalidError } from '../../src/shared/errors';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { getItemBySlug } from '../helpers/fixtures';

const EXCLUSIVE = 'gym_oni'; // N, made dungeon-exclusive with empty dungeonAccess for this file
const COMMON = 'neko_barista'; // N, ordinary
const CONTRACT = 'mythic_contract'; // guaranteed capture
const ROOM = 'hall';
const ACTION = 'meet';

let w: DungeonWorld;
let exclusive: SpeciesRow;
let keySeq = 0;

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.t.db.update(species).set({ affinity: 'switch' });
  exclusive = await speciesRow(EXCLUSIVE);
  await w.t.db.update(species).set({ tags: ['dungeon_exclusive'] }).where(eq(species.id, exclusive.id));
  w.speciesAccess.set(EXCLUSIVE, []);
});
afterAll(async () => {
  await w.cleanup();
});

type Input = DungeonInput extends infer I ? (I extends unknown ? Omit<I, 'expectedStep'> : never) : never;
const act = (playerId: number, run: DungeonRunView, input: Input): Promise<DungeonActionResult> =>
  w.act(playerId, run, input as DungeonInput);

async function speciesRow(slug: string): Promise<SpeciesRow> {
  const [row] = await w.t.db.select().from(species).where(eq(species.slug, slug));
  if (!row) throw new Error(`missing seeded species ${slug}`);
  return row;
}
async function give(playerId: number, slug: string, quantity: number): Promise<void> {
  await w.app.inventory.addItem(w.t.db, playerId, (await getItemBySlug(w.t.db, slug)).id, quantity);
}
async function held(playerId: number, slug: string): Promise<number> {
  const item = await getItemBySlug(w.t.db, slug);
  const [row] = await w.t.db
    .select({ quantity: playerInventory.quantity })
    .from(playerInventory)
    .where(and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, item.id)));
  return row?.quantity ?? 0;
}
const ledger = (playerId: number) =>
  w.t.db.select().from(dungeonSpeciesAcquisitions).where(eq(dungeonSpeciesAcquisitions.playerId, playerId)).orderBy(asc(dungeonSpeciesAcquisitions.id));
/** Copies still owned: a release is soft and keeps the row. */
const copiesOf = async (playerId: number, speciesId: number) =>
  (await w.t.db.select().from(playerWaifus).where(eq(playerWaifus.playerId, playerId))).filter((c) => c.speciesId === speciesId && !c.releasedAt);
const instance = async (runId: number) => {
  const [row] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId));
  return (row!.encounterStates as Record<string, { status: string; unavailableReason?: string }>)[`${ROOM}:${ACTION}`]!;
};
const nextDay = () => {
  w.clock.now = new Date(w.clock.now.getTime() + 86_400_000);
};

const fromPool = { type: 'wild_encounter', source: { kind: 'pool', poolId: 'p' }, intro: 'Someone stirs.', capture: {} };
const named = (slug: string) => ({ type: 'wild_encounter', source: { kind: 'species', species: slug }, intro: 'She appears.', capture: {} });
const captureRescue = (slug: string) => ({ type: 'rescue', mode: 'capture', source: { kind: 'species', species: slug }, intro: 'A cell.', capture: {} });
const directRescue = (slug: string) => ({
  type: 'rescue', mode: 'direct', source: { kind: 'species', species: slug }, intro: 'Free her.', when: { type: 'flag', flag: 'lever' },
});
const pool = (slugs: string[]) => [{ id: 'p', name: 'Pool', entries: slugs.map((s, i) => ({ id: `e${i}`, weight: 1, species: s, oncePerRun: true })) }];
const policy = (perPlayerLimit: number | 'unlimited', directRescue?: boolean): DungeonSpeciesPolicyEntry => ({
  species: EXCLUSIVE, perPlayerLimit, ...(directRescue !== undefined ? { directRescue } : {}),
});

/** A one-room dungeon holding `action`, under a fresh key unless one is given. */
function dungeon(
  action: Record<string, unknown>,
  extra: { speciesPools?: unknown; speciesPolicies?: DungeonSpeciesPolicyEntry[]; key?: string } = {},
): DungeonDefinition {
  const key = extra.key ?? `own_${++keySeq}`;
  return singleRoomDungeon([{ id: ACTION, ...action } as never], (input) => {
    input.key = key;
    if (extra.speciesPools) (input as Record<string, unknown>).speciesPools = extra.speciesPools;
    if (extra.speciesPolicies) input.speciesPolicies = extra.speciesPolicies;
  });
}
async function issuesOf(definition: DungeonDefinition, severity: 'error' | 'warning' = 'error'): Promise<string[]> {
  return (await w.content.validate(definition)).issues.filter((i) => i.severity === severity).map((i) => i.code);
}
/** Start a run; capture the offered encounter with a contract when there is one. */
async function tryCapture(playerId: number, key: string): Promise<{ run: DungeonRunView; captured: boolean }> {
  nextDay();
  let run = await w.runs.start(playerId, key);
  if (!run.core.action?.encounter?.available) return { run, captured: false };
  run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
  const result = await act(playerId, run, { type: 'capture' });
  return { run: result.run, captured: result.encounterReceipts?.[0]?.type === 'capture_attempt' && !!result.encounterReceipts[0].acquired };
}
const end = async (playerId: number, run: DungeonRunView) => {
  if (run.status === 'active') await act(playerId, run, { type: 'abandon' });
};

describe('species catalogue', () => {
  it('an enabled dungeon-exclusive species with empty dungeonAccess is a selectable candidate for any dungeon', async () => {
    const [entry] = (await w.content.speciesCatalogue(`own_${keySeq + 1}`)).filter((s) => s.slug === EXCLUSIVE);
    // Species content alone does not admit her; the dungeon's own Species access can.
    expect(entry).toMatchObject({ enabled: true, dungeonExclusive: true, dungeonAccess: [], permitted: false, dungeonPolicyAllowed: true });
    const [ordinary] = (await w.content.speciesCatalogue('anything')).filter((s) => s.slug === COMMON);
    expect(ordinary).toMatchObject({ permitted: true, dungeonPolicyAllowed: true });
  });
});

describe('publication', () => {
  it('admits her through the dungeon’s own Species access, and refuses her without it', async () => {
    expect(await issuesOf(dungeon(fromPool, { speciesPools: pool([EXCLUSIVE]) }))).toEqual(['species_not_permitted']);
    expect(await issuesOf(dungeon(named(EXCLUSIVE)))).toEqual(['species_not_permitted']);
    expect(await issuesOf(dungeon(captureRescue(EXCLUSIVE)))).toEqual(['species_not_permitted']);
    expect(await issuesOf(dungeon(fromPool, { speciesPools: pool([EXCLUSIVE]), speciesPolicies: [policy(1)] }))).toEqual([]);
    expect(await issuesOf(dungeon(named(EXCLUSIVE), { speciesPolicies: [policy('unlimited')] }))).toEqual([]);
    expect(await issuesOf(dungeon(captureRescue(EXCLUSIVE), { speciesPolicies: [policy(2)] }))).toEqual([]);
  });

  it('Direct Rescue needs explicit permission and a finite limit', async () => {
    expect(await issuesOf(dungeon(directRescue(EXCLUSIVE), { speciesPolicies: [policy(1)] }))).toEqual(['rescue_direct_not_permitted']);
    expect(await issuesOf(dungeon(directRescue(EXCLUSIVE), { speciesPolicies: [policy('unlimited', true)] }))).toEqual([
      'rescue_direct_limit_missing', // the encounter
      'rescue_direct_limit_missing', // the access entry itself
    ]);
    expect(await issuesOf(dungeon(directRescue(EXCLUSIVE), { speciesPolicies: [policy(1, true)] }))).toEqual([]);
  });

  it('checks the entries themselves: duplicates, unknown species, region exclusivity, unused', async () => {
    expect(await issuesOf(dungeon(named(EXCLUSIVE), { speciesPolicies: [policy(1), policy(2)] }))).toEqual(['species_policy_duplicate']);
    expect(await issuesOf(dungeon(named(COMMON), { speciesPolicies: [{ species: 'no_such_species', perPlayerLimit: 1 }] }))).toEqual(['species_missing']);
    expect(await issuesOf(dungeon(named(COMMON), { speciesPolicies: [policy(1)] }), 'warning')).toContain('species_policy_unused');
    const regional = await speciesRow(COMMON);
    await w.t.db.update(species).set({ tags: ['region_exclusive'] }).where(eq(species.id, regional.id));
    try {
      expect(await issuesOf(dungeon(named(COMMON), { speciesPolicies: [{ species: COMMON, perPlayerLimit: 1 }] }))).toEqual([
        'species_not_permitted',
        'species_policy_region_exclusive',
      ]);
    } finally {
      await w.t.db.update(species).set({ tags: regional.tags }).where(eq(species.id, regional.id));
    }
  });
});

describe('runtime', () => {
  it('captures from a newly configured published pool, then enforces the per-player limit across runs', async () => {
    const d = dungeon(fromPool, { speciesPools: pool([EXCLUSIVE]), speciesPolicies: [policy(1)] });
    await w.publish(d);
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 3);
    const first = await tryCapture(playerId, d.key);
    expect(first.captured).toBe(true);
    expect(await ledger(playerId)).toEqual([expect.objectContaining({ dungeonKey: d.key, speciesId: exclusive.id, mode: 'capture' })]);
    await end(playerId, first.run);
    const second = await tryCapture(playerId, d.key);
    expect(second.captured).toBe(false);
    expect(await instance(second.run.id)).toMatchObject({ status: 'unavailable', unavailableReason: 'player_limit' });
    expect(await held(playerId, CONTRACT)).toBe(2);
    await end(playerId, second.run);
  });

  it('captures through a specific-species Wild Encounter and a capture-mode Rescue', async () => {
    for (const action of [named(EXCLUSIVE), captureRescue(EXCLUSIVE)]) {
      const d = dungeon(action, { speciesPolicies: [policy('unlimited')] });
      await w.publish(d);
      const { playerId } = await w.player();
      await give(playerId, CONTRACT, 2);
      for (let n = 0; n < 2; n += 1) {
        const { run, captured } = await tryCapture(playerId, d.key);
        expect(captured).toBe(true);
        await end(playerId, run);
      }
      expect(await copiesOf(playerId, exclusive.id)).toHaveLength(2);
    }
  });

  it('grants a permitted Direct Rescue up to its finite limit', async () => {
    const d = dungeon({ ...directRescue(EXCLUSIVE), when: undefined, results: { unavailable: { text: 'Empty.' } } }, { speciesPolicies: [policy(1, true)] });
    await w.publish(d);
    const { playerId } = await w.player();
    nextDay();
    const run = await w.runs.start(playerId, d.key);
    expect(run.core.action?.encounter).toMatchObject({ mode: 'direct', available: true });
    const result = await act(playerId, run, { type: 'rescue' });
    expect(result.encounterReceipts).toEqual([expect.objectContaining({ type: 'rescue_grant' })]);
    await end(playerId, result.run);
    nextDay();
    const again = await w.runs.start(playerId, d.key);
    expect(await instance(again.id)).toMatchObject({ status: 'unavailable', unavailableReason: 'player_limit' });
    expect(await ledger(playerId)).toEqual([expect.objectContaining({ mode: 'rescue_direct' })]);
  });

  it('keeps independent limits per dungeon', async () => {
    const a = dungeon(named(EXCLUSIVE), { speciesPolicies: [policy(1)] });
    const b = dungeon(fromPool, { speciesPools: pool([EXCLUSIVE]), speciesPolicies: [policy(2)] });
    await w.publish(a);
    await w.publish(b);
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 5);
    const results: boolean[] = [];
    for (const key of [a.key, a.key, b.key, b.key, b.key]) {
      const { run, captured } = await tryCapture(playerId, key);
      results.push(captured);
      await end(playerId, run);
    }
    expect(results).toEqual([true, false, true, true, false]);
    expect((await ledger(playerId)).map((r) => r.dungeonKey)).toEqual([a.key, b.key, b.key]);
  });

  it('one limit per dungeon across pools, specific encounters, revisions and release', async () => {
    const d = dungeon(fromPool, { speciesPools: pool([EXCLUSIVE]), speciesPolicies: [policy(2)] });
    await w.publish(d);
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 3);
    const first = await tryCapture(playerId, d.key);
    expect(first.captured).toBe(true);
    await end(playerId, first.run);
    // The same species, now met directly in the next revision: still one count.
    await w.republish(dungeon(named(EXCLUSIVE), { key: d.key, speciesPolicies: [policy(2)] }));
    const second = await tryCapture(playerId, d.key);
    expect(second.captured).toBe(true);
    await end(playerId, second.run);
    // Letting her go does not hand the acquisitions back.
    for (const copy of await copiesOf(playerId, exclusive.id)) await w.app.collection.releaseWaifu(playerId, copy.id);
    expect(await copiesOf(playerId, exclusive.id)).toHaveLength(0);
    const third = await tryCapture(playerId, d.key);
    expect(third.captured).toBe(false);
    expect(await instance(third.run.id)).toMatchObject({ status: 'unavailable', unavailableReason: 'player_limit' });
    expect(await ledger(playerId)).toHaveLength(2);
  });

  it('a draft grants and withdraws nothing until it is published', async () => {
    const d = dungeon(named(EXCLUSIVE), { speciesPolicies: [policy(1)] });
    await w.publish(d);
    const current = (await w.content.get(d.key))!;
    await w.content.saveDraft(d.key, { definition: dungeon(named(EXCLUSIVE), { key: d.key, speciesPolicies: [policy(5)] }), expectedRevision: current.draftRevision }, 'test');
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 2);
    const first = await tryCapture(playerId, d.key);
    expect(first.captured).toBe(true);
    await end(playerId, first.run);
    const second = await tryCapture(playerId, d.key);
    expect(second.captured).toBe(false);
    await end(playerId, second.run);
  });

  it('rollback restores the earlier terms without resetting history', async () => {
    const d = dungeon(named(EXCLUSIVE), { speciesPolicies: [policy(1)] });
    await w.publish(d);
    await w.republish(dungeon(named(EXCLUSIVE), { key: d.key, speciesPolicies: [policy(3)] }));
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 3);
    for (let n = 0; n < 2; n += 1) {
      const { run, captured } = await tryCapture(playerId, d.key);
      expect(captured).toBe(true);
      await end(playerId, run);
    }
    await w.content.rollback(d.key, { revision: 1 }, 'test');
    // Two already recorded against a restored limit of one: nothing more, nothing erased.
    const after = await tryCapture(playerId, d.key);
    expect(after.captured).toBe(false);
    expect(await ledger(playerId)).toHaveLength(2);
    await end(playerId, after.run);
  });

  it('runs in progress follow the currently published terms', async () => {
    const d = dungeon(named(EXCLUSIVE), { speciesPolicies: [policy('unlimited')] });
    await w.publish(d);
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 3);
    const first = await tryCapture(playerId, d.key);
    expect(first.captured).toBe(true);
    await end(playerId, first.run);

    // Offered under "unlimited", then the dungeon tightens to one.
    nextDay();
    let run = await w.runs.start(playerId, d.key);
    expect(run.core.action?.encounter?.available).toBe(true);
    run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
    await w.republish(dungeon(named(EXCLUSIVE), { key: d.key, speciesPolicies: [policy(1)] }));
    const tightened = await act(playerId, run, { type: 'capture' });
    expect(tightened.encounterReceipts).toBeUndefined();
    expect(await instance(run.id)).toMatchObject({ status: 'unavailable', unavailableReason: 'player_limit' });
    expect(await held(playerId, CONTRACT)).toBe(2);
    await end(playerId, tightened.run);

    // Withdrawn entirely: the next revision no longer offers her, and a run
    // still pinned to an older one finds her not permitted.
    const { playerId: other } = await w.player();
    await give(other, CONTRACT, 1);
    nextDay();
    let pinned = await w.runs.start(other, d.key);
    pinned = (await act(other, pinned, { type: 'select_item', item: CONTRACT })).run;
    await w.republish(dungeon(named(COMMON), { key: d.key }));
    const withdrawn = await act(other, pinned, { type: 'capture' });
    expect(withdrawn.encounterReceipts).toBeUndefined();
    expect(await instance(pinned.id)).toMatchObject({ status: 'unavailable', unavailableReason: 'not_permitted' });
    expect(await held(other, CONTRACT)).toBe(1);
  });
});

describe('legacy species-content access', () => {
  it('still admits her alone, and combines with a dungeon entry on the stricter terms', async () => {
    const legacyOnly = dungeon(named(EXCLUSIVE));
    w.speciesAccess.set(EXCLUSIVE, [{ dungeon: legacyOnly.key, perPlayerLimit: 1 }]);
    try {
      expect(await issuesOf(legacyOnly)).toEqual([]);
    } finally {
      w.speciesAccess.set(EXCLUSIVE, []);
    }

    const both = dungeon(named(EXCLUSIVE), { speciesPolicies: [policy('unlimited')] });
    w.speciesAccess.set(EXCLUSIVE, [{ dungeon: both.key, perPlayerLimit: 1 }]);
    try {
      expect(await issuesOf(both, 'warning')).toContain('species_policy_content_overlap');
      // Content's direct-rescue refusal is not loosened by the dungeon's permission.
      expect(await issuesOf(dungeon(directRescue(EXCLUSIVE), { key: both.key, speciesPolicies: [policy(1, true)] }))).toEqual(['rescue_direct_not_permitted']);
      await w.publish(both);
      const { playerId } = await w.player();
      await give(playerId, CONTRACT, 2);
      const first = await tryCapture(playerId, both.key);
      expect(first.captured).toBe(true);
      await end(playerId, first.run);
      // Content's limit of one wins over the dungeon's "unlimited".
      const second = await tryCapture(playerId, both.key);
      expect(second.captured).toBe(false);
      await end(playerId, second.run);
    } finally {
      w.speciesAccess.set(EXCLUSIVE, []);
    }
  });

  it('leaves ordinary species in dungeons without Species access exactly as before', async () => {
    const d = dungeon(fromPool, { speciesPools: pool([COMMON]) });
    expect(await issuesOf(d)).toEqual([]);
    await w.publish(d);
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 2);
    for (let n = 0; n < 2; n += 1) {
      const { run, captured } = await tryCapture(playerId, d.key);
      expect(captured).toBe(true);
      await end(playerId, run);
    }
  });
});

describe('packages', () => {
  it('exports the dungeon’s Species access with its definition; the destination judges and enforces it', async () => {
    const source = await createDungeonWorld();
    try {
      const [row] = await source.t.db.select().from(species).where(eq(species.slug, EXCLUSIVE));
      await source.t.db.update(species).set({ tags: ['dungeon_exclusive'] }).where(eq(species.id, row!.id));
      const d = dungeon(fromPool, { speciesPools: pool([EXCLUSIVE]), speciesPolicies: [policy(1)] });
      await source.publish(d);
      const p = DungeonPackageV4Schema.parse(await source.content.exportPackage(d.key, 'published', 'exporter'));
      expect(p.dungeon.speciesPolicies).toEqual([policy(1)]);
      expect(p.dependencies.requiredSpecies).toEqual([expect.objectContaining({ slug: EXCLUSIVE, dungeonExclusive: true, dungeonAccess: [] })]);

      const plan = await w.content.planImport(p);
      expect(plan.encounterDependencies!.requiredSpecies).toEqual([
        expect.objectContaining({ slug: EXCLUSIVE, status: 'available', perPlayerLimit: 1, directRescue: false }),
      ]);
      await w.content.applyImport({
        package: p, requestId: randomUUID(), expectedPlanHash: plan.planHash!, expectedRevision: plan.target!.expectedRevision,
        decisions: { dungeon: 'create', enemies: {}, lootTables: {}, allowMissingDependencies: false },
      }, 'admin');
      expect((await w.content.get(d.key))!.draft).toMatchObject({ speciesPolicies: [policy(1)] });
      await w.content.publish(d.key, { expectedRevision: 1 }, 'admin');
      await w.content.setEnabled(d.key, true, 'admin');
      const { playerId } = await w.player();
      await give(playerId, CONTRACT, 2);
      const first = await tryCapture(playerId, d.key);
      expect(first.captured).toBe(true);
      await end(playerId, first.run);
      expect((await tryCapture(playerId, d.key)).captured).toBe(false);
    } finally {
      await source.cleanup();
    }
  });
});

describe('ordinary spawning', () => {
  it('a dungeon offering her does not put her into hunts', async () => {
    await w.publish(dungeon(named(EXCLUSIVE), { speciesPolicies: [policy('unlimited')] }));
    const { playerId } = await w.player();
    for (let i = 0; i < 200; i += 1) {
      const picked = await w.app.hunt.pickSpeciesForSpawn(w.t.db, playerId, 1, 'waifu-valley');
      expect(picked?.slug).not.toBe(EXCLUSIVE);
    }
  });
});

it('DungeonInvalidError is what publish throws for a dungeon without her access', async () => {
  await expect(w.publish(dungeon(named(EXCLUSIVE)))).rejects.toBeInstanceOf(DungeonInvalidError);
});
